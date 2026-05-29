/**
 * Owner-auth own-state snapshot — M4a (spec §6.1).
 *
 *   GET /v1/own-state/snapshot?cursor=<opt>
 *   Authorization: Bearer <stream-token>
 *
 * Returns the maker's full wallet-scoped view: active commitments + active
 * positions (+ recently-terminal-since-cursor when a cursor is supplied for
 * state-loss recovery). The composite cursor in the response is what the SDK
 * passes to `/v1/stream/own-state` as `Last-Event-ID` — or re-presents to
 * this same endpoint when paging through a truncated cold start.
 *
 * Auth: `verifyStreamToken` middleware fronts the route and attaches
 * `req.streamAuth.address` (lowercased). The handler has no `?address` param
 * — the only address it serves is the bearer-token-bound one, so a wallet
 * cannot impersonate another wallet by tweaking the URL.
 *
 * Wire body per spec §6.1:
 *
 *   {
 *     cursor: <base64url composite>,
 *     commitments: OwnerCommitment[],
 *     positions: OwnerPosition[],
 *     truncated: boolean
 *   }
 *
 * Truncation is the maker's signal to keep paging via `?cursor=` until
 * `truncated: false`; the SDK MUST NOT emit `ready` until then (§6.2).
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../../lib/env.js';
import { logger, formatError } from '../../lib/logger.js';
import { getSupabase } from '../../lib/supabase.js';
import {
  rowToBody as commitmentRowToBody,
  COMMITMENT_RECOVERY_COLUMNS,
  type CommitmentBody,
  type CommitmentRecoveryRow,
  type CommitmentRow,
} from '../commitments.js';
import {
  fetchCategorizedPositions,
  type ClaimablePosition,
  type PendingSettlePosition,
  type PositionBase,
} from '../utils/positionFetch.js';
import { wei6ToUSDC } from '../../lib/sanitize.js';
import type { StreamAuthRequest } from '../../middleware/verifyStreamToken.js';
import {
  OwnStateCursorError,
  OWN_STATE_CURSOR_VERSION,
  SENTINEL_WATERMARK,
  decodeOwnStateCursor,
  encodeOwnStateCursor,
  floorWatermarkByOverlap,
  watermarkKeysetOr,
  watermarkLiveKeysetOr,
  type OwnStateCursor,
  type OwnStateCursorKind,
  type ResourceWatermark,
} from './cursor.js';
import type { ApiError } from '../../middleware/errorHandler.js';

// ── Position wire shape — discriminated union by `status` ────────────────

interface OwnerClaimedPosition extends PositionBase {
  status: 'claimed';
  claimedAt: string | null;
}

export type OwnerPosition =
  | (PositionBase & { status: 'active' })
  | (PendingSettlePosition & { status: 'pendingSettle' })
  | (ClaimablePosition & { status: 'claimable' })
  | OwnerClaimedPosition;

interface OwnStateSnapshotBody {
  cursor: string;
  commitments: CommitmentBody[];
  positions: OwnerPosition[];
  /**
   * True when ANY resource (commitments or positions) was capped and more
   * pages exist. The SDK MUST NOT emit `ready` for trading until this is
   * `false` (spec §6.2).
   */
  truncated: boolean;
  /**
   * True when the position categorization helper hit its 200-row cap, so
   * `positions[]` may be missing rows. M4a accepts this as a fail-closed
   * contract: the cursor's `p` watermark is preserved (or sentinel on cold
   * start) so the M4b stream replays every position transition since the
   * preserved tail, eventually filling in any rows the snapshot dropped.
   * SDK consumers paginating > 200 unclaimed positions should also fall
   * back to `/v1/positions/:address` for full history during the M4a
   * window.
   */
  positionsTruncated: boolean;
}

// Columns for the claimed-since-cursor fast path. Trims the recovery-row
// projection to what `mapClaimedRow` actually reads.
const POSITION_CLAIMED_COLUMNS =
  'speculation_id, position_type, risk_amount, profit_amount, ' +
  'claimed, claimed_at, position_created_at, id, row_updated_at';

interface ClaimedPositionRow {
  speculation_id: string | number;
  position_type: 'upper' | 'lower' | null;
  risk_amount: string | number | null;
  profit_amount: string | number | null;
  claimed: boolean | null;
  claimed_at: string | null;
  position_created_at: string | null;
  id: string | number;
  row_updated_at: string;
}

const POSITION_TYPE_TO_INT: Record<'upper' | 'lower', 0 | 1> = { upper: 0, lower: 1 };

const CLAIMED_PAGE_CAP = 200;

// ─────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────

export async function ownStateSnapshotHandler(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();
  // verifyStreamToken middleware guarantees this exists; the cast is the
  // type-narrow with no runtime work.
  const address = (req as StreamAuthRequest).streamAuth.address;
  const maxCommitments = config.ownStateSnapshotMaxCommitments;

  // ── 1. Parse optional cursor ─────────────────────────────────────────
  let cursor: OwnStateCursor | null = null;
  if (req.query.cursor !== undefined) {
    const raw = req.query.cursor;
    if (typeof raw !== 'string' || raw.length === 0) {
      res.status(400).json({
        error: 'cursor must be a non-empty base64url string.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    try {
      cursor = decodeOwnStateCursor(raw);
    } catch (err) {
      if (err instanceof OwnStateCursorError) {
        res.status(400).json(err.apiError);
        return;
      }
      throw err;
    }
  }

  const nowMs = Date.now();
  const nowISO = new Date(nowMs).toISOString();

  // ── Cursor state machine (Hermes review-31 round 2 — explicit phases) ──
  //
  // Round-1's merge approach interleaved active and terminal rows by
  // (row_updated_at, id), which could starve a long-lived active row out
  // of page 1's slice and then permanently exclude it on page 2's strict
  // keyset. The two-phase model drains the entire active set BEFORE any
  // terminal row is delivered. Phase boundaries:
  //
  //   COLD_START (no cursor)            → phase 1, no recovery scope
  //   RECOVERY_INITIAL (k='live')       → phase 1, recovery anchor = floor(c)
  //   PAGE_ACTIVE  (k='page-active')    → phase 1 continuation, no recovery
  //   PAGE_RECOV_A (k='page-recovery-active') → phase 1 continuation, recovery
  //   PAGE_RECOV_T (k='page-recovery-terminal') → phase 2 only
  //
  // The cursor carries the recovery anchor (`cAnchor`) verbatim across every
  // recovery page so the phase-2 terminal query knows the original recovery
  // scope, no matter how far the progress `c` has advanced through phase 1.
  const isInitialRecovery = cursor?.k === 'live';
  const isPagingActivePhase =
    cursor?.k === 'page-active' || cursor?.k === 'page-recovery-active';
  const isPagingTerminalPhase = cursor?.k === 'page-recovery-terminal';
  const isRecovering =
    isInitialRecovery ||
    cursor?.k === 'page-recovery-active' ||
    cursor?.k === 'page-recovery-terminal';

  const recoveryAnchor: ResourceWatermark | null = isInitialRecovery
    ? floorWatermarkByOverlap(cursor!.c)
    : (cursor?.cAnchor ?? null);

  // ── Phase 1: Active commitments ─────────────────────────────────────
  // Active set = stored status open/partially_filled AND nonce not invalidated
  // AND not past expiry. `book_visible` is informational, NOT a filter — a
  // hidden-but-still-matchable row is in the active set per spec §6.1.
  //
  // Skipped entirely when input is phase-2 (page-recovery-terminal) — by then
  // the active set has fully drained on prior pages.
  let activeRows: CommitmentRecoveryRow[] = [];
  let phase1Saturated = false;
  if (!isPagingTerminalPhase) {
    let activeQuery = sb
      .from('commitments')
      .select(COMMITMENT_RECOVERY_COLUMNS)
      .eq('network', config.network)
      .eq('maker', address)
      .in('status', ['open', 'partially_filled'])
      .eq('nonce_invalidated', false)
      .gt('expiry', nowISO);
    if (isPagingActivePhase) {
      activeQuery = activeQuery.or(watermarkKeysetOr(cursor!.c));
    }
    activeQuery = activeQuery
      .order('row_updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(maxCommitments);

    const activeRes = await activeQuery;
    if (activeRes.error) {
      logger.error(
        { err: activeRes.error.message },
        'ownState/snapshot: active commitments query failed',
      );
      res.status(500).json({
        error: 'Failed to load own-state.',
        code: 'INTERNAL_ERROR',
      } satisfies ApiError);
      return;
    }
    activeRows = (activeRes.data ?? []) as unknown as CommitmentRecoveryRow[];
    phase1Saturated = activeRows.length >= maxCommitments;
  }

  // ── Phase 2: Terminals-since-recovery-anchor ────────────────────────
  // Runs on EITHER:
  //   (a) page-recovery-terminal input — phase 2 continuation, keyset advance
  //       is strict against the prior page's last terminal row;
  //   (b) recovering AND phase 1 just drained on this page — remaining budget
  //       is spent on terminals, keyset is strict against the recovery anchor
  //       (initial recovery already applied the overlap floor when computing
  //       `recoveryAnchor`, so the strict `>` here actually reads as
  //       "row > floor", which is exactly the overlap window's semantics).
  let terminalRows: CommitmentRecoveryRow[] = [];
  let phase2Saturated = false;
  let phase2Ran = false;
  if (isPagingTerminalPhase) {
    phase2Ran = true;
    const terminalRes = await sb
      .from('commitments')
      .select(COMMITMENT_RECOVERY_COLUMNS)
      .eq('network', config.network)
      .eq('maker', address)
      .or(`status.in.(filled,cancelled),nonce_invalidated.eq.true,expiry.lte.${nowISO}`)
      .or(watermarkKeysetOr(cursor!.c))
      .order('row_updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(maxCommitments);
    if (terminalRes.error) {
      logger.error(
        { err: terminalRes.error.message },
        'ownState/snapshot: terminal commitments query failed',
      );
      res.status(500).json({
        error: 'Failed to load own-state.',
        code: 'INTERNAL_ERROR',
      } satisfies ApiError);
      return;
    }
    terminalRows = (terminalRes.data ?? []) as unknown as CommitmentRecoveryRow[];
    phase2Saturated = terminalRows.length >= maxCommitments;
  } else if (isRecovering && !phase1Saturated && recoveryAnchor !== null) {
    phase2Ran = true;
    const terminalBudget = maxCommitments - activeRows.length;
    if (terminalBudget > 0) {
      const terminalRes = await sb
        .from('commitments')
        .select(COMMITMENT_RECOVERY_COLUMNS)
        .eq('network', config.network)
        .eq('maker', address)
        .or(`status.in.(filled,cancelled),nonce_invalidated.eq.true,expiry.lte.${nowISO}`)
        .or(watermarkKeysetOr(recoveryAnchor))
        .order('row_updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(terminalBudget);
      if (terminalRes.error) {
        logger.error(
          { err: terminalRes.error.message },
          'ownState/snapshot: terminal commitments query failed',
        );
        res.status(500).json({
          error: 'Failed to load own-state.',
          code: 'INTERNAL_ERROR',
        } satisfies ApiError);
        return;
      }
      terminalRows = (terminalRes.data ?? []) as unknown as CommitmentRecoveryRow[];
      phase2Saturated = terminalRows.length >= terminalBudget;
    }
  }

  // Wire ordering: active first (in (row, id) ASC from query), then terminal
  // (also (row, id) ASC). No merge — the two phases are temporally separated
  // and never interleave. SDK applies events idempotently per natural key,
  // so terminals arriving "after" active in wire order is correct.
  const commitments: CommitmentBody[] = [
    ...activeRows.map((r) => commitmentRowToBody(r as unknown as CommitmentRow, nowMs)),
    ...terminalRows.map((r) => commitmentRowToBody(r as unknown as CommitmentRow, nowMs)),
  ];
  const truncatedCommitments = phase1Saturated || phase2Saturated;

  // ── Positions (delivered on every page; never paginated within snapshot) ──
  // M4a fail-closed contract for positions: re-use the categorized fetcher.
  // The raw query inside the helper caps at 200; `hitCap` surfaces the
  // raw-cap signal (Hermes review-31 round 2 blocker #3 — counting
  // post-filtered categorized rows under-detected truncation when the
  // helper filtered "lost" positions below the cap).
  let active: PositionBase[];
  let pendingSettle: PendingSettlePosition[];
  let claimable: ClaimablePosition[];
  let positionsHitCap: boolean;
  try {
    const categorized = await fetchCategorizedPositions(address);
    active = categorized.active;
    pendingSettle = categorized.pendingSettle;
    claimable = categorized.claimable;
    positionsHitCap = categorized.hitCap;
  } catch (err) {
    logger.error({ err: formatError(err) }, 'ownState/snapshot: position categorization failed');
    res.status(500).json({
      error: 'Failed to load own-state.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }

  // Claimed-since-cursor: only when recovering. Keyset matches the
  // commitments terminal-query rule — `live` floors by overlap; any
  // recovery-paging continuation is strict (the floor was already applied
  // at recovery-initial time, and progress has advanced past it).
  let claimedRows: ClaimedPositionRow[] = [];
  if (isRecovering) {
    const claimedKeyset = isInitialRecovery
      ? watermarkLiveKeysetOr(cursor!.p)
      : watermarkKeysetOr(cursor!.p);
    const claimedRes = await sb
      .from('positions')
      .select(POSITION_CLAIMED_COLUMNS)
      .eq('network', config.network)
      .eq('user_address', address)
      .eq('claimed', true)
      .or(claimedKeyset)
      .order('row_updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(CLAIMED_PAGE_CAP);
    if (claimedRes.error) {
      logger.error(
        { err: claimedRes.error.message },
        'ownState/snapshot: claimed positions query failed',
      );
      res.status(500).json({
        error: 'Failed to load own-state.',
        code: 'INTERNAL_ERROR',
      } satisfies ApiError);
      return;
    }
    claimedRows = (claimedRes.data ?? []) as unknown as ClaimedPositionRow[];
  }

  // `positionsTruncated` derives from the helper's raw-cap signal (NOT the
  // post-filtered count) plus the claimed-since query hitting its own cap.
  const positionsTruncated = positionsHitCap || claimedRows.length >= CLAIMED_PAGE_CAP;

  const positions: OwnerPosition[] = [
    ...active.map((p): OwnerPosition => ({ status: 'active', ...p })),
    ...pendingSettle.map((p): OwnerPosition => ({ status: 'pendingSettle', ...p })),
    ...claimable.map((p): OwnerPosition => ({ status: 'claimable', ...p })),
    ...claimedRows.map((r) => mapClaimedRow(r, address)),
  ];

  // ── Response cursor (Hermes review-31 round 2 — two-phase state machine) ──
  //
  //   - c: phase 1 saturated → last activeRow's (row, id); phase 2 saturated
  //        (only) → last terminalRow's (row, id); neither → MAX in DB.
  //   - cAnchor: preserved verbatim across recovery pages; absent on cold
  //        start and on the final `live` cursor (recovery complete).
  //   - f: snapshot does NOT deliver fills, so `f` NEVER advances past any
  //        fill the SDK hasn't seen. Cold start: MAX in DB; input cursor:
  //        preserved verbatim.
  //   - p: positions truncated → preserve input.p (or sentinel on cold start)
  //        so the M4b stream replays every position transition since.
  //   - k: phase 1 saturated → `page-recovery-active` (recovering) or
  //        `page-active` (cold start); phase 2 saturated → `page-recovery-
  //        terminal`; else → `live`.
  //
  // The `truncated` body field is COMMITMENTS-ONLY (decoupled from
  // `positionsTruncated`, per Hermes review-31 round 2 blocker #4). The SDK's
  // "page until truncated: false" contract no longer loops on positions-only
  // truncation; positions truncation is informational and is converged by
  // the M4b stream + a /v1/positions fallback per README.
  let cWatermark: ResourceWatermark;
  let outputK: OwnStateCursorKind;
  let outputCAnchor: ResourceWatermark | undefined;
  if (phase1Saturated && activeRows.length > 0) {
    const last = activeRows[activeRows.length - 1]!;
    cWatermark = { s: last.row_updated_at, i: String(last.id) };
    outputK = isRecovering ? 'page-recovery-active' : 'page-active';
    outputCAnchor = isRecovering ? recoveryAnchor! : undefined;
  } else if (phase2Saturated && terminalRows.length > 0) {
    const last = terminalRows[terminalRows.length - 1]!;
    cWatermark = { s: last.row_updated_at, i: String(last.id) };
    outputK = 'page-recovery-terminal';
    outputCAnchor = recoveryAnchor!;
  } else {
    cWatermark = await maxWatermarkForCommitments(sb, config.network, address);
    outputK = 'live';
    outputCAnchor = undefined;
  }

  const fWatermark: ResourceWatermark = cursor
    ? cursor.f
    : await maxWatermarkForFills(sb, config.network, address);

  const pWatermark: ResourceWatermark = positionsTruncated
    ? (cursor?.p ?? SENTINEL_WATERMARK)
    : await maxWatermarkForPositions(sb, config.network, address);

  const responseCursor: OwnStateCursor =
    outputCAnchor !== undefined
      ? {
          t: 'own-state',
          v: OWN_STATE_CURSOR_VERSION,
          c: cWatermark,
          cAnchor: outputCAnchor,
          f: fWatermark,
          p: pWatermark,
          k: outputK,
        }
      : {
          t: 'own-state',
          v: OWN_STATE_CURSOR_VERSION,
          c: cWatermark,
          f: fWatermark,
          p: pWatermark,
          k: outputK,
        };

  const body: OwnStateSnapshotBody = {
    cursor: encodeOwnStateCursor(responseCursor),
    commitments,
    positions,
    truncated: truncatedCommitments,
    positionsTruncated,
  };
  res.status(200).json(body);
}

// ── helpers ──────────────────────────────────────────────────────────────

function sortRecoveryRows(a: CommitmentRecoveryRow, b: CommitmentRecoveryRow): number {
  const tCmp = a.row_updated_at.localeCompare(b.row_updated_at);
  if (tCmp !== 0) return tCmp;
  const ai = BigInt(String(a.id));
  const bi = BigInt(String(b.id));
  if (ai === bi) return 0;
  return ai < bi ? -1 : 1;
}

function mapClaimedRow(row: ClaimedPositionRow, address: string): OwnerClaimedPosition {
  const positionType = row.position_type ? POSITION_TYPE_TO_INT[row.position_type] : 0;
  const riskWei6 = row.risk_amount != null ? BigInt(String(row.risk_amount)) : 0n;
  const profitWei6 = row.profit_amount != null ? BigInt(String(row.profit_amount)) : 0n;
  const odds = riskWei6 === 0n ? null : 1 + Number(profitWei6) / Number(riskWei6);
  return {
    status: 'claimed',
    positionId: `${String(row.speculation_id)}_${address}_${positionType}`,
    speculationId: String(row.speculation_id),
    positionType: positionType as 0 | 1,
    // Team/opponent need a contest join; for `claimed` history we leave them
    // unknown rather than do a second batch query — the SDK already has the
    // contest context from prior `active`/`pendingSettle`/`claimable` rows.
    team: 'Unknown',
    opponent: 'Unknown',
    market: 'moneyline',
    oddsDecimal: odds,
    riskAmountUSDC: wei6ToUSDC(row.risk_amount),
    profitAmountUSDC: wei6ToUSDC(row.profit_amount),
    claimedAt: row.claimed_at,
  };
}

type SbClient = ReturnType<typeof getSupabase>;

async function maxWatermarkForCommitments(
  sb: SbClient,
  network: string,
  address: string,
): Promise<ResourceWatermark> {
  const res = await sb
    .from('commitments')
    .select('row_updated_at, id')
    .eq('network', network)
    .eq('maker', address)
    .order('row_updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error || !res.data) return SENTINEL_WATERMARK;
  return { s: String(res.data.row_updated_at), i: String(res.data.id) };
}

async function maxWatermarkForFills(
  sb: SbClient,
  network: string,
  address: string,
): Promise<ResourceWatermark> {
  // `position_fills` carries both maker_address and taker_address; either
  // counterparty's row counts for own-state. PostgREST `.or()` covers both.
  const res = await sb
    .from('position_fills')
    .select('row_updated_at, id')
    .eq('network', network)
    .or(`maker_address.eq.${address},taker_address.eq.${address}`)
    .order('row_updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error || !res.data) return SENTINEL_WATERMARK;
  return { s: String(res.data.row_updated_at), i: String(res.data.id) };
}

async function maxWatermarkForPositions(
  sb: SbClient,
  network: string,
  address: string,
): Promise<ResourceWatermark> {
  const res = await sb
    .from('positions')
    .select('row_updated_at, id')
    .eq('network', network)
    .eq('user_address', address)
    .order('row_updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error || !res.data) return SENTINEL_WATERMARK;
  return { s: String(res.data.row_updated_at), i: String(res.data.id) };
}
