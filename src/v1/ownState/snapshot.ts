/**
 * Owner-auth own-state snapshot.
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
 * Wire body:
 *
 *   {
 *     cursor: <base64url composite>,
 *     commitments: OwnerCommitment[],
 *     positions: OwnerPosition[],
 *     truncated: boolean,
 *     positionsTruncated: boolean
 *   }
 *
 * Two distinct truncation discriminants — they are NOT interchangeable:
 *
 *   - `truncated` (commitments-only): commitment pagination remains.
 *     The SDK pages `/v1/own-state/snapshot?cursor=` until `truncated:
 *     false`, THEN connects the stream with the final `k='live'`
 *     cursor. The SDK MUST NOT emit `ready` for trading until paging
 *     completes.
 *
 *   - `positionsTruncated`: position visibility is incomplete because
 *     `fetchCategorizedPositions` hit its 200-row cap. The SDK does
 *     NOT keep paging the snapshot for this — `cursor.p` is preserved
 *     (or sentinel on cold start) but the snapshot does not have a
 *     mechanism to drain unseen positions. Consumers enter degraded /
 *     quote-hold mode; the stream cold-start emits `event: degraded`
 *     before `ready` so the SDK / MM treats the wallet's position view
 *     as partial-visibility. The `/v1/positions/:address`
 *     fallback covers full history for operator tooling.
 *
 * ── Passive-expiry contract ────────────────────────────────────────────
 *
 * "Recently-terminal-since-cursor" recovery emits rows whose terminal
 * transition the INDEXER WROTE TO THE DB (status → filled/cancelled,
 * `nonce_invalidated=true`, `book_visible=false`). It does NOT emit
 * passive time-based expiry, because the indexer does not advance
 * `row_updated_at` when only time passes. A commitment whose only
 * terminal transition is `expiry <= now` will appear in NEITHER half of
 * the recovery response: the active query excludes it (`expiry > now`
 * fails) and the terminal query's keyset filter excludes it
 * (`row_updated_at < recovery anchor`).
 *
 * This matches the existing `/v1/commitments?since=` behavior and the
 * server-derived effective-status pattern used everywhere else: server
 * stores raw values, and effective lifecycle (`expired`/`cancelled`/etc.)
 * is computed at read time using `nowMs` in `deriveEffectiveStatus`.
 *
 * SDK reducer obligation: for any locally-held commitment whose stored
 * `expiry` has lapsed, transition it to terminal in local state. This
 * is the same effective-status computation the SDK already does on the
 * commitments it RECEIVES from the snapshot or the stream — applied to
 * its own locally-held rows on a tick or on reconnect. The active set
 * the snapshot returns is authoritative of CURRENTLY-MATCHABLE rows;
 * anything the SDK is holding locally as "active" but that isn't in the
 * returned active set OR has lapsed expiry MUST be pruned.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../../lib/env.js';
import { logger, formatError } from '../../lib/logger.js';
import { getSupabase } from '../../lib/supabase.js';
import {
  COMMITMENT_RECOVERY_COLUMNS,
  type CommitmentRecoveryRow,
} from '../commitments.js';
import {
  fetchCommitmentEnrichment,
  toOwnerCommitmentBody,
  type OwnerCommitmentBody,
} from './enrich.js';
import {
  fetchCategorizedPositions,
  type ClaimablePosition,
  type DerivedPositionStatus,
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
import { maxIsoTimestamptz } from './timestamps.js';
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
  commitments: OwnerCommitmentBody[];
  positions: OwnerPosition[];
  /**
   * COMMITMENTS-ONLY truncation discriminant. True when the active or
   * terminal commitments query saturated `ownStateSnapshotMaxCommitments`
   * and more pages remain. The SDK pages `?cursor=` until `truncated:
   * false`, then opens the stream with the final `k='live'` cursor.
   * `truncated` does NOT include positions truncation — see
   * `positionsTruncated` below for that.
   */
  truncated: boolean;
  /**
   * Positions truncation discriminant. True when
   * `fetchCategorizedPositions` hit its 200-row cap. The SDK does NOT
   * page the snapshot for this — there's no analog to commitments'
   * `?cursor=` paging on the actionable-positions filter. Instead the
   * stream cold-start treats `positionsTruncated: true` as a degraded
   * state: emits `event: degraded` then `ready`, and the SDK / MM
   * enters quote-hold. The `cursor.p` watermark is
   * preserved (or sentinel on cold start) so resume catch-up still
   * uses it for the terminal-since-cursor filter; the
   * `/v1/positions/:address` REST endpoint covers operator-side full
   * history.
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
// Helper — pure(ish) load, no express coupling
//
// Factored out from `ownStateSnapshotHandler` so the SSE stream handler can
// reuse the same query + cursor logic for its inline `event: snapshot` frame.
// Returns a tagged result instead of writing to the response.
// ─────────────────────────────────────────────────────────────────────────

export type LoadOwnStateSnapshotResult =
  | {
      ok: true;
      body: OwnStateSnapshotBody;
      /**
       * Derived (key, status, sourceUpdatedAt) for every actionable
       * position the snapshot saw — computed from the SAME categorization
       * join that built `body.positions`. The stream handler hands
       * this to `OwnStateHub.seedStatusCache` BEFORE starting the live
       * timer so the seed and the wire body are guaranteed consistent
       * (eliminating the cold-start race a separate post-snapshot
       * derivation would have introduced).
       */
      seedRows: DerivedPositionStatus[];
    }
  | { ok: false; status: number; error: ApiError };

export async function loadOwnStateSnapshot(
  address: string,
  cursor: OwnStateCursor | null,
  nowMs: number,
): Promise<LoadOwnStateSnapshotResult> {
  const config = loadConfig();
  const sb = getSupabase();
  const maxCommitments = config.ownStateSnapshotMaxCommitments;
  const nowISO = new Date(nowMs).toISOString();

  // ── Cursor state machine (explicit two-phase recovery) ───────────────
  //
  // A merged stream interleaving active and terminal rows by
  // (row_updated_at, id) would starve a long-lived active row out of
  // page 1's slice and then permanently exclude it on page 2's strict
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
  // hidden-but-still-matchable row is in the active set.
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
      return {
        ok: false,
        status: 500,
        error: { error: 'Failed to load own-state.', code: 'INTERNAL_ERROR' },
      };
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
  if (isPagingTerminalPhase) {
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
      return {
        ok: false,
        status: 500,
        error: { error: 'Failed to load own-state.', code: 'INTERNAL_ERROR' },
      };
    }
    terminalRows = (terminalRes.data ?? []) as unknown as CommitmentRecoveryRow[];
    phase2Saturated = terminalRows.length >= maxCommitments;
  } else if (isRecovering && !phase1Saturated && recoveryAnchor !== null) {
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
        return {
          ok: false,
          status: 500,
          error: { error: 'Failed to load own-state.', code: 'INTERNAL_ERROR' },
        };
      }
      terminalRows = (terminalRes.data ?? []) as unknown as CommitmentRecoveryRow[];
      phase2Saturated = terminalRows.length >= terminalBudget;
    }
  }

  // Wire ordering: active first (in (row, id) ASC from query), then terminal
  // (also (row, id) ASC). No merge — the two phases are temporally separated
  // and never interleave. SDK applies events idempotently per natural key,
  // so terminals arriving "after" active in wire order is correct.
  const allCommitmentRows = [...activeRows, ...terminalRows];
  let commitmentEnrichment;
  try {
    commitmentEnrichment = await fetchCommitmentEnrichment(
      sb,
      config.network,
      allCommitmentRows,
    );
  } catch (err) {
    logger.error(
      { err: formatError(err) },
      'ownState/snapshot: commitment enrichment failed',
    );
    return {
      ok: false,
      status: 500,
      error: { error: 'Failed to load own-state.', code: 'INTERNAL_ERROR' },
    };
  }
  const commitments: OwnerCommitmentBody[] = allCommitmentRows.map((r) =>
    toOwnerCommitmentBody(r, nowMs, commitmentEnrichment),
  );
  const truncatedCommitments = phase1Saturated || phase2Saturated;

  // ── Positions (delivered on every page; never paginated within snapshot) ──
  // Re-use the categorized fetcher. The raw query inside the helper caps
  // at 200; `hitCap` surfaces the raw-cap signal because counting
  // post-filtered categorized rows under-detects truncation when the
  // helper filters lost positions below the cap.
  let active: PositionBase[];
  let pendingSettle: PendingSettlePosition[];
  let claimable: ClaimablePosition[];
  let positionsHitCap: boolean;
  let derivedStatuses: DerivedPositionStatus[];
  try {
    const categorized = await fetchCategorizedPositions(address);
    active = categorized.active;
    pendingSettle = categorized.pendingSettle;
    claimable = categorized.claimable;
    positionsHitCap = categorized.hitCap;
    derivedStatuses = categorized.derivedStatuses;
  } catch (err) {
    logger.error({ err: formatError(err) }, 'ownState/snapshot: position categorization failed');
    return {
      ok: false,
      status: 500,
      error: { error: 'Failed to load own-state.', code: 'INTERNAL_ERROR' },
    };
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
      return {
        ok: false,
        status: 500,
        error: { error: 'Failed to load own-state.', code: 'INTERNAL_ERROR' },
      };
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

  // ── Response cursor (two-phase state machine) ────────────────────────
  //
  //   - c: phase 1 saturated → last activeRow's (row, id); phase 2 saturated
  //        (only) → last terminalRow's (row, id); neither → MAX in DB.
  //   - cAnchor: preserved verbatim across recovery pages; absent on cold
  //        start and on the final `live` cursor (recovery complete).
  //   - f: snapshot does NOT deliver fills, so `f` NEVER advances past any
  //        fill the SDK hasn't seen. Cold start: MAX in DB; input cursor:
  //        preserved verbatim.
  //   - p: positions truncated → preserve input.p (or sentinel on cold start)
  //        so the live stream replays every position transition since.
  //   - k: phase 1 saturated → `page-recovery-active` (recovering) or
  //        `page-active` (cold start); phase 2 saturated → `page-recovery-
  //        terminal`; else → `live`.
  //
  // The `truncated` body field is COMMITMENTS-ONLY (decoupled from
  // `positionsTruncated`). The SDK's "page until truncated: false"
  // contract does not loop on positions-only truncation:
  // `positionsTruncated:true` means position visibility is PARTIAL —
  // the stream cold-start emits `event: degraded` before `ready` and
  // the SDK / market maker must quote-hold and treat owner-state
  // as partial. There is no paging/convergence mechanism that drains
  // positions beyond the actionable cap; full history is available
  // out-of-band via `/v1/positions/:address` for operator tooling.
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

  // cursor.p reflects the maximum DERIVED `sourceUpdatedAt` across the
  // snapshot's actionable positions — NOT raw `positions.row_updated_at`.
  // The own-state stream advances `p` with `sourceUpdatedAt = max(position,
  // speculation, contest)` and the resume catch-up filters via
  // `compareIsoTimestamptz` (microsecond-precise). Minting `p` here from
  // the same derived domain via `maxIsoTimestamptz` keeps snapshot and
  // stream cursors comparable end-to-end; `Date.parse`-based max would
  // truncate Postgres's microsecond precision and let same-ms parent
  // transitions freeze `p` even though a newer source actually advanced.
  // When `positionsTruncated`, we preserve the input cursor's `p` (or
  // sentinel on cold start) so the SDK / MM treats the wallet as
  // degraded per the documented contract; the stream also emits
  // `event: degraded` in this case.
  let pWatermark: ResourceWatermark;
  if (positionsTruncated) {
    pWatermark = cursor?.p ?? SENTINEL_WATERMARK;
  } else if (derivedStatuses.length > 0) {
    const bestS = maxIsoTimestamptz(
      ...derivedStatuses.map((d) => d.sourceUpdatedAt),
    );
    // i='0' is a permissive tie-breaker: the stream's catch-up filter
    // `(sourceUpdatedAt, id) > (p.s, p.i)` re-admits any position whose
    // source matches `p.s` and has id > 0 (i.e. every real DB row).
    // The SDK reducer dedupes the over-emission via the semantic
    // event key.
    pWatermark = { s: bestS, i: '0' };
  } else {
    // No actionable positions and no truncation — preserve input cursor's
    // p (resume) or sentinel (cold start) so the catch-up has nothing to
    // filter against. Catch-up's terminal-since-cursor query then catches
    // any recent terminal transitions.
    pWatermark = cursor?.p ?? SENTINEL_WATERMARK;
  }

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
  return { ok: true, body, seedRows: derivedStatuses };
}

// ─────────────────────────────────────────────────────────────────────────
// Express adapter
//
// Wraps `loadOwnStateSnapshot` for the REST route. Owns input parsing
// (cursor validation, 400s) and translates the tagged result into a JSON
// response.
// ─────────────────────────────────────────────────────────────────────────

export async function ownStateSnapshotHandler(req: Request, res: Response): Promise<void> {
  const address = (req as StreamAuthRequest).streamAuth.address;

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

  const result = await loadOwnStateSnapshot(address, cursor, Date.now());
  if (!result.ok) {
    res.status(result.status).json(result.error);
    return;
  }
  res.status(200).json(result.body);
}

// ── helpers ──────────────────────────────────────────────────────────────

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
    // Enrichment — `claimed` rows are terminal + recovery-only (zero
    // remaining exposure). Contest context is intentionally minimal, mirroring
    // the existing `team`/`opponent: 'Unknown'` choice above: no second batch
    // join for a settled row. wei6 + freshness are cheap and populated.
    contestId: '',
    sport: '',
    awayTeam: '',
    homeTeam: '',
    riskAmountWei6: riskWei6.toString(),
    counterpartyRiskWei6: profitWei6.toString(),
    updatedAtUnixSec: (() => {
      const ms = Date.parse(row.row_updated_at);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
    })(),
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
