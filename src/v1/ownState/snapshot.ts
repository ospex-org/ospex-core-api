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

// Matches the cap inside `fetchCategorizedPositions` (200). When the helper
// returns this many categorized rows we infer it ran into the cap — a
// conservative proxy (the helper may filter "lost" positions out below the
// cap, but those rows still count against it). Hermes review-31 blocker #4.
const POSITIONS_CATEGORIZED_CAP = 200;

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

  // ── Cursor state machine (Hermes review-31 round 1) ─────────────────
  // The cursor's `k` field has three meanings as INPUT:
  //
  //   `live`           — initial state-loss recovery. The SDK is passing
  //                       the last cursor it had from the stream. Server
  //                       applies the {@link RECOVERY_OVERLAP_MS} floor to
  //                       terminal/claimed queries so a late-committed row
  //                       (Postgres `now()` is tx-start) is not skipped.
  //   `page-recovery`  — continuation of a recovery snapshot. Terminal
  //                       query still runs but with strict keyset advance.
  //   `page-active`    — continuation of a cold-start snapshot. No terminal
  //                       query (the SDK had no prior state to converge).
  //
  // No input cursor = cold start; no terminal query.
  const recovering = cursor?.k === 'live' || cursor?.k === 'page-recovery';
  const paging = cursor?.k === 'page-active' || cursor?.k === 'page-recovery';

  // ── 2. Active commitments ────────────────────────────────────────────
  // Active set = stored status open/partially_filled AND nonce not invalidated
  // AND not past expiry. `book_visible` is informational, NOT a filter — a
  // hidden-but-still-matchable row is in the active set per spec §6.1, because
  // the maker is still on the hook for it.
  //
  // Paging (`k='page-active'` or `'page-recovery'`): strict keyset advance
  // past the prior page's last delivered row. On initial recovery (`k='live'`)
  // the keyset advance is NOT applied — the SDK has no prior state, so the
  // full active set is delivered (subject to MAX).
  let activeQuery = sb
    .from('commitments')
    .select(COMMITMENT_RECOVERY_COLUMNS)
    .eq('network', config.network)
    .eq('maker', address)
    .in('status', ['open', 'partially_filled'])
    .eq('nonce_invalidated', false)
    .gt('expiry', nowISO);
  if (paging) {
    activeQuery = activeQuery.or(watermarkKeysetOr(cursor!.c));
  }
  activeQuery = activeQuery
    .order('row_updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(maxCommitments);

  const activeRes = await activeQuery;
  if (activeRes.error) {
    logger.error({ err: activeRes.error.message }, 'ownState/snapshot: active commitments query failed');
    res.status(500).json({
      error: 'Failed to load own-state.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }
  const activeRows = (activeRes.data ?? []) as unknown as CommitmentRecoveryRow[];

  // ── 3. Terminals-since-cursor (recovery only) ────────────────────────
  // Runs whenever recovering (k='live' OR k='page-recovery'). Keyset depends
  // on which: `live` floors by overlap to catch late-committed rows;
  // `page-recovery` is strict (the prior page already crossed the overlap).
  let terminalRows: CommitmentRecoveryRow[] = [];
  if (recovering && activeRows.length < maxCommitments) {
    const budget = maxCommitments - activeRows.length;
    const terminalKeyset =
      cursor!.k === 'live'
        ? watermarkLiveKeysetOr(cursor!.c)
        : watermarkKeysetOr(cursor!.c);
    const terminalRes = await sb
      .from('commitments')
      .select(COMMITMENT_RECOVERY_COLUMNS)
      .eq('network', config.network)
      .eq('maker', address)
      .or(`status.in.(filled,cancelled),nonce_invalidated.eq.true,expiry.lte.${nowISO}`)
      .or(terminalKeyset)
      .order('row_updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(budget);
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
  }

  // Active and terminal predicates are mutually exclusive, so merging cannot
  // duplicate rows. Sort by (row_updated_at, id) so the cursor advance is
  // monotonic across pages.
  const allRows = [...activeRows, ...terminalRows].sort(sortRecoveryRows);
  const truncated = allRows.length >= maxCommitments;
  const finalRows = allRows.slice(0, maxCommitments);
  const commitments = finalRows.map((r) => commitmentRowToBody(r as unknown as CommitmentRow, nowMs));

  // ── 4. Positions ─────────────────────────────────────────────────────
  // Active set re-uses the categorized fetcher that powers
  // /v1/positions/:address/status — same lifecycle classification, so the
  // SDK can compute matching keys the same way it does today.
  let active: PositionBase[];
  let pendingSettle: PendingSettlePosition[];
  let claimable: ClaimablePosition[];
  try {
    const categorized = await fetchCategorizedPositions(address);
    active = categorized.active;
    pendingSettle = categorized.pendingSettle;
    claimable = categorized.claimable;
  } catch (err) {
    logger.error({ err: formatError(err) }, 'ownState/snapshot: position categorization failed');
    res.status(500).json({
      error: 'Failed to load own-state.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }

  // Claimed-since-cursor: only when recovering. Keyset matches the
  // commitments terminal-query rule — `live` floors by overlap;
  // `page-recovery` is strict.
  let claimedRows: ClaimedPositionRow[] = [];
  if (recovering) {
    const claimedKeyset =
      cursor!.k === 'live'
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

  // Positions truncation flag (Hermes blocker #4). The categorized helper
  // caps the active set at 200; claimed-since-cursor caps at CLAIMED_PAGE_CAP.
  // When either is at the cap we treat the positions response as incomplete
  // and preserve the input `p` watermark below so the M4b stream replays
  // every position transition (or, on cold start, falls back to sentinel
  // — the stream replays from the beginning, slow but correct).
  const categorizedCount = active.length + pendingSettle.length + claimable.length;
  const positionsTruncated =
    categorizedCount >= POSITIONS_CATEGORIZED_CAP ||
    claimedRows.length >= CLAIMED_PAGE_CAP;

  const positions: OwnerPosition[] = [
    ...active.map((p): OwnerPosition => ({ status: 'active', ...p })),
    ...pendingSettle.map((p): OwnerPosition => ({ status: 'pendingSettle', ...p })),
    ...claimable.map((p): OwnerPosition => ({ status: 'claimable', ...p })),
    ...claimedRows.map((r) => mapClaimedRow(r, address)),
  ];

  // ── 5. Compute response cursor (Hermes review-31 round 1 — blockers 2,3,4) ──
  //
  //   - c: truncated → last delivered row's (row_updated_at, id) so the next
  //        page advances past it. Not truncated → MAX in DB.
  //   - f: snapshot does NOT deliver fills, so it must NOT advance `f` past
  //        any fill the SDK has not yet seen. Cold start: MAX in DB (no
  //        prior state to converge). Input cursor: preserve `cursor.f` so
  //        the M4b stream tail picks up exactly where the SDK left off.
  //   - p: positions truncated → preserve input.p (or sentinel on cold
  //        start) so the M4b stream replays every position transition
  //        since the preserved tail. Not truncated → MAX in DB.
  let cWatermark: ResourceWatermark;
  if (truncated && finalRows.length > 0) {
    const last = finalRows[finalRows.length - 1]!;
    cWatermark = { s: last.row_updated_at, i: String(last.id) };
  } else {
    cWatermark = await maxWatermarkForCommitments(sb, config.network, address);
  }

  const fWatermark: ResourceWatermark = cursor
    ? cursor.f
    : await maxWatermarkForFills(sb, config.network, address);

  const pWatermark: ResourceWatermark = positionsTruncated
    ? (cursor?.p ?? SENTINEL_WATERMARK)
    : await maxWatermarkForPositions(sb, config.network, address);

  // Output `k` is determined by commitments truncation + recovery context.
  // Positions truncation surfaces via `positionsTruncated` body field, not
  // the cursor's `k` — there is no positions-paging path in M4a (fail-closed
  // per Hermes review-31 blocker #4).
  let kOut: OwnStateCursorKind;
  if (truncated) {
    kOut = recovering ? 'page-recovery' : 'page-active';
  } else {
    kOut = 'live';
  }

  const responseCursor: OwnStateCursor = {
    t: 'own-state',
    v: OWN_STATE_CURSOR_VERSION,
    c: cWatermark,
    f: fWatermark,
    p: pWatermark,
    k: kOut,
  };

  const body: OwnStateSnapshotBody = {
    cursor: encodeOwnStateCursor(responseCursor),
    commitments,
    positions,
    truncated: truncated || positionsTruncated,
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
