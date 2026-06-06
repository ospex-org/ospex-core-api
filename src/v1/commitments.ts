/**
 * /v1/commitments — write + read for the EIP-712 commitment relay.
 *
 *   POST   /v1/commitments        — accept a signed OspexCommitment and persist it.
 *                                   Idempotent on commitment_hash; if an indexer-only
 *                                   row exists, enrich it. Returns the canonical
 *                                   commitment body.
 *
 *   GET    /v1/commitments        — list commitments with filters (maker,
 *                                   contestId, scorer, speculationId, status)
 *                                   and pagination (limit, offset). Sorted by
 *                                   `created_at DESC, commitment_hash ASC` —
 *                                   newest first; tie-break on hash so
 *                                   offset-based pagination is deterministic
 *                                   across ties (rows backfilled by indexer
 *                                   migration 039 share a timestamp).
 *
 *   GET    /v1/commitments/:hash  — single commitment lookup by EIP-712 hash.
 *                                   Returns the same canonical body shape as
 *                                   the list endpoint, or 404. Lets clients
 *                                   that hold a hash (e.g. SDK match flow)
 *                                   fetch the full struct + signature without
 *                                   scanning the list.
 *
 *   DELETE /v1/commitments/:hash  — off-chain cancel via signed CancelCommitment
 *                                   action. Sets `book_visible=false` (leaving the
 *                                   canonical on-chain `status` untouched) so the
 *                                   row stops surfacing in the open book. Authoritative
 *                                   cancel is still on-chain (cancelCommitment /
 *                                   raiseMinNonce); see docs/CANCEL_FLOW.md.
 */

import type { Request, Response } from 'express';
import { isAddress } from 'ethers';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { deriveSpeculationKey } from '../lib/eip712.js';
import { scorerToType, type MarketType } from '../lib/speculation.js';
import { deriveEffectiveStatus } from '../lib/commitmentStatus.js';
import type { CursorableRow } from '../lib/cursor.js';
import { nextCursor, parseRecovery, recoveryKeysetExpr } from '../lib/recovery.js';
import type { AuthenticatedRequest } from '../middleware/eip712Auth.js';
import type { ApiError } from '../middleware/errorHandler.js';

// ────────────────────────────────────────────────────────────────────────
// Canonical commitment body
//
// Same shape used by POST and GET responses so consumers don't have to
// branch on which endpoint produced a row. snake_case columns from
// Supabase are normalized to camelCase here.
// ────────────────────────────────────────────────────────────────────────

export interface CommitmentBody {
  commitmentHash: string;
  maker: string;
  contestId: string | null;
  scorer: string | null;
  lineTicks: number | null;
  positionType: 0 | 1 | null;     // 0 = upper (away/over), 1 = lower (home/under)
  oddsTick: number | null;
  marketType: MarketType | null;
  riskAmount: string;             // uint256 as string
  filledRiskAmount: string;
  remainingRiskAmount: string;    // computed: max(0, risk - filled)
  nonce: string;
  expiry: string | null;
  speculationKey: string | null;
  signature: string | null;
  status: string;                 // EFFECTIVE status — folds in time-expiry + nonce invalidation
  storedStatus: string;           // raw indexer/relay status (open|partially_filled|filled|cancelled)
  source: string;
  network: string;
  nonceInvalidated: boolean;
  bookVisible: boolean;           // off-chain orderbook visibility; false = hidden via off-chain DELETE
  createdAt: string;              // ISO 8601 — filled by DB default `now()`
  /**
   * Advisory maker-funding fillability (Layer D). Present ONLY when the request
   * passed `?includeFillability=true`. Derived from the indexer's ~30s
   * `maker_funding` snapshot — advisory + point-in-time, NEVER folded into `status`.
   */
  fillability?: CommitmentFillability;
}

export const COMMITMENT_COLUMNS =
  'commitment_hash, maker, contest_id, scorer, line_ticks, position_type, ' +
  'odds_tick, market_type, risk_amount, filled_risk_amount, nonce, expiry, ' +
  'speculation_key, signature, status, source, network, nonce_invalidated, ' +
  'book_visible, created_at';

export interface CommitmentRow {
  commitment_hash: string;
  maker: string;
  contest_id: string | number | null;
  scorer: string | null;
  line_ticks: number | null;
  position_type: 'upper' | 'lower' | null;
  odds_tick: number | null;
  market_type: MarketType | null;
  risk_amount: string | number | null;
  filled_risk_amount: string | number | null;
  nonce: string | number | null;
  expiry: string | null;
  speculation_key: string | null;
  signature: string | null;
  status: string;
  source: string;
  network: string;
  nonce_invalidated: boolean | null;
  book_visible: boolean | null;
  created_at: string;
}

const POSITION_TYPE_TO_INT: Record<'upper' | 'lower', 0 | 1> = { upper: 0, lower: 1 };

// Recovery reads also need the cursor columns. `row_updated_at` is
// trigger-maintained on every UPDATE, so a stored open→filled/cancelled
// transition advances it and surfaces in the recovery stream.
export const COMMITMENT_RECOVERY_COLUMNS = `${COMMITMENT_COLUMNS}, id, row_updated_at`;
export type CommitmentRecoveryRow = CommitmentRow & CursorableRow;

/**
 * Map a raw `commitments` row to the canonical body. `nowMs` is the request's
 * single captured timestamp (epoch ms) — required (not defaulted) so callers
 * can't accidentally call Date.now() per row; it drives effective-status
 * derivation and must match the expiry boundary used by the surrounding query.
 */
export function rowToBody(row: CommitmentRow, nowMs: number): CommitmentBody {
  const risk = row.risk_amount != null ? BigInt(String(row.risk_amount)) : 0n;
  const filled = row.filled_risk_amount != null ? BigInt(String(row.filled_risk_amount)) : 0n;
  const remaining = risk > filled ? risk - filled : 0n;
  const storedStatus = row.status;
  const bookVisible = row.book_visible !== false; // null/undefined (legacy) treated as visible
  const status = deriveEffectiveStatus({
    storedStatus,
    expiry: row.expiry,
    nonceInvalidated: Boolean(row.nonce_invalidated),
    bookVisible,
    nowMs,
  });
  return {
    commitmentHash: row.commitment_hash,
    maker: row.maker,
    contestId: row.contest_id != null ? String(row.contest_id) : null,
    scorer: row.scorer,
    lineTicks: row.line_ticks,
    positionType: row.position_type ? POSITION_TYPE_TO_INT[row.position_type] : null,
    oddsTick: row.odds_tick,
    marketType: row.market_type,
    riskAmount: risk.toString(),
    filledRiskAmount: filled.toString(),
    remainingRiskAmount: remaining.toString(),
    nonce: row.nonce != null ? String(row.nonce) : '0',
    expiry: row.expiry,
    speculationKey: row.speculation_key,
    signature: row.signature,
    status,
    storedStatus,
    source: row.source,
    network: row.network,
    nonceInvalidated: Boolean(row.nonce_invalidated),
    bookVisible,
    createdAt: row.created_at,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Public hidden-row redaction (M2 of the own-state SSE migration stack)
//
// Hidden rows (`book_visible=false`) are off-book via off-chain DELETE but
// their on-chain signature stays valid until expiry/nonce-floor/onchain-cancel.
// Anonymous public surfaces MUST NOT serve the signed payload (anything in
// `MatchingModule.matchCommitment`'s struct, plus the signature itself); makers
// recover hidden bodies via the owner-auth own-state stream landing in M4.
//
// The redaction is enforced by RUNTIME PROJECTION through an exported
// ALLOW-LIST, not a hand-written literal. `rowToHiddenAllowlistBody` builds the
// FULL body (which carries the signature + the entire matchable struct) and then
// PROJECTS it through `PUBLIC_HIDDEN_ALLOWLIST`, dropping every field not on the
// list. The allow-list is the single source of truth: the wire type is DERIVED
// from it (`CommitmentHiddenBody = Pick<…, allow-list>`), so a field cannot reach
// the wire unless it is on the list — regardless of any upstream body change. An
// additive column upstream is dropped at runtime by the projection, not merely
// flagged by a type wall (which a deliberate type+literal edit could defeat).
// See `tests/commitments-redaction.test.ts`.
//
// The two discriminants `redacted` + `payloadAvailable` give SDK consumers a
// structural signal so the type system can narrow on them instead of probing
// optional fields.
//
// Deviations from `implementation-plan.md` §M2's proposed constant — flagged
// in the PR description:
//   - `bookVisible` (camelCase) not `book_visible`: matches the wire shape used
//     across `CommitmentBody`; the wire is camelCase even where the column is
//     snake_case.
//   - `speculationKey` / `speculationId` are BOTH excluded. The wire field is
//     `speculationKey` (a keccak of contestId+scorer+lineTicks); leaking it
//     plus the in-allow-list `contestId` brute-forces (scorer, lineTicks) over
//     the tiny tuple space (~3 scorers × small line range), both of which are
//     in the locked deny-list (audit §6.2). Adding `speculationId` instead
//     would require a per-page join; if observers need linkage to hidden rows
//     pre-fill, that goes in a follow-up.
// ────────────────────────────────────────────────────────────────────────

/**
 * Pick a fixed set of keys off an object at runtime. Used to project a full
 * commitment body down to the public hidden-row allow-list — the projection,
 * not a type wall, is what guarantees an off-list field can't reach the wire.
 */
function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  // `k in obj` guard: copy only keys actually present, so an allow-list entry for
  // an OPTIONAL field that happens to be absent on a given object is omitted
  // rather than materialized as `key: undefined`. Every current allow-list key is
  // always-present on the candidate, so this is purely defensive — it keeps the
  // projected key set the present∩allow-list subset if the allow-list ever grows
  // an optional field.
  for (const k of keys) {
    if (k in obj) out[k] = obj[k];
  }
  return out;
}

/**
 * The full candidate body a hidden row is projected FROM: every public
 * `CommitmentBody` field (including the signature + matchable struct) plus the
 * three redaction markers. `PUBLIC_HIDDEN_ALLOWLIST` selects the subset that is
 * safe to publish; everything else here is dropped by the projection. Adding a
 * field to `CommitmentBody` widens this candidate but NOT the public hidden body
 * unless the field is also added to the allow-list.
 */
type CommitmentHiddenCandidate = CommitmentBody & {
  bookVisible: false;
  redacted: true;
  payloadAvailable: false;
};

/**
 * Exact wire allow-list for public hidden-row bodies — the SINGLE source of
 * truth. `CommitmentHiddenBody` is derived from it and `rowToHiddenAllowlistBody`
 * projects through it at runtime, so the type, the runtime body, and this list
 * can never diverge. `satisfies keyof CommitmentHiddenCandidate` makes a
 * typo'd/removed key a compile error. An allow-list (not deny-list) so an
 * upstream field addition can't accidentally leak — it's dropped by the
 * projection unless explicitly added here.
 */
export const PUBLIC_HIDDEN_ALLOWLIST = [
  'commitmentHash',
  'maker',
  'contestId',
  'positionType',
  'status',
  'storedStatus',
  'filledRiskAmount',
  'expiry',
  'bookVisible',
  'nonceInvalidated',
  'redacted',
  'payloadAvailable',
] as const satisfies readonly (keyof CommitmentHiddenCandidate)[];

/**
 * Public hidden-row wire body — DERIVED from `PUBLIC_HIDDEN_ALLOWLIST` so the
 * type and the runtime projection can never diverge. Changing the allow-list
 * changes this type in lockstep.
 */
export type CommitmentHiddenBody = Pick<
  CommitmentHiddenCandidate,
  (typeof PUBLIC_HIDDEN_ALLOWLIST)[number]
>;

/**
 * Build the redacted public body for a hidden (`book_visible=false`) row by
 * PROJECTING the full body through `PUBLIC_HIDDEN_ALLOWLIST`. Starting from the
 * full body (signature + matchable struct included) and dropping everything not
 * on the allow-list makes the allow-list load-bearing at runtime: a field cannot
 * reach the wire unless it is on the list, no matter what `rowToBody` later adds.
 *
 * Throws if called on a visible row — callers route via
 * `commitmentRowToPublicBody`, which makes the visibility choice; a misrouted
 * visible row reaching this mapper is a programming bug, not a security gap.
 */
export function rowToHiddenAllowlistBody(row: CommitmentRow, nowMs: number): CommitmentHiddenBody {
  if (row.book_visible !== false) {
    throw new Error(
      `rowToHiddenAllowlistBody invoked on a non-hidden row (commitment_hash=${row.commitment_hash})`,
    );
  }
  // `rowToBody` already derives `status` with bookVisible=false (the row is
  // hidden) and normalizes filled/risk, so the projected subset is identical to
  // the prior hand-written literal — but now guaranteed by the allow-list rather
  // than by hand. The redaction markers are added, then everything not on the
  // allow-list (signature, nonce, oddsTick, riskAmount, lineTicks, scorer,
  // speculationKey, marketType, …) is dropped by `pick`.
  const candidate: CommitmentHiddenCandidate = {
    ...rowToBody(row, nowMs),
    bookVisible: false,
    redacted: true,
    payloadAvailable: false,
  };
  return pick(candidate, PUBLIC_HIDDEN_ALLOWLIST);
}

/**
 * Single public-body router for every anonymous read surface. Visible rows
 * get the full `CommitmentBody`; hidden rows get the allow-list projection.
 * `REDACT_HIDDEN_PUBLIC=false` reverts to the legacy "full body for all rows"
 * behavior — a short-lived deploy-window rollback only (see Config docstring).
 *
 * Safe-by-default on `redactHiddenPublic`: only an EXPLICIT `false` disables
 * redaction. Missing flag (undefined — e.g. a partial loadConfig mock) is
 * treated as enabled, so a test fixture can't accidentally widen the public
 * surface by omitting one config field.
 */
export function commitmentRowToPublicBody(
  row: CommitmentRow,
  nowMs: number,
): CommitmentBody | CommitmentHiddenBody {
  const { redactHiddenPublic } = loadConfig();
  if (redactHiddenPublic !== false && row.book_visible === false) {
    return rowToHiddenAllowlistBody(row, nowMs);
  }
  return rowToBody(row, nowMs);
}

// ────────────────────────────────────────────────────────────────────────
// Advisory maker-funding fillability (Layer D)
//
// Opt-in via `?includeFillability=true`. Each row gets a `fillability` object
// derived from the indexer's ~30s `maker_funding` snapshot (USDC balance +
// PositionModule allowance + the maker's visible committed book risk, per
// migration 051). Advisory + point-in-time — NEVER folded into `status`.
// ────────────────────────────────────────────────────────────────────────

export type MakerFundingStatus = 'fully_backed' | 'overcommitted' | 'unknown' | 'stale';

export interface CommitmentFillability {
  /** Always true — a point-in-time advisory, never a guarantee. */
  advisory: true;
  /** Headline. `unknown` = no snapshot for this maker; `stale` = snapshot too old to trust. */
  makerFundingStatus: MakerFundingStatus;
  /** backing ≥ THIS order's remaining maker risk. `null` when unknown/stale — a
   *  "now" assertion can't be made from a missing or stale snapshot. */
  orderIndividuallyBackedNow: boolean | null;
  /** backing ≥ the maker's whole VISIBLE committed book risk. `null` when unknown/stale. */
  makerBookBackedNow: boolean | null;
  /** min(USDC balance, USDC→PositionModule allowance), wei6 string. `null` when unknown. */
  makerBackingWei6: string | null;
  /** Σ remaining maker risk over the maker's visible matchable book, wei6 string. `null` when unknown. */
  makerVisibleCommittedWei6: string | null;
  /** backing / visibleCommitted, in basis points. `null` when unknown. */
  makerCoverageRatioBps: number | null;
  /** Chain block the balance/allowance were read at. `null` when unknown. */
  checkedAtBlock: string | null;
  /** True only when a snapshot exists but its age exceeds the freshness
   *  threshold (paired with `makerFundingStatus: 'stale'`). A missing snapshot
   *  is `makerFundingStatus: 'unknown'` with `stale: false` — use
   *  `makerFundingStatus` as the discriminator, not `stale`. */
  stale: boolean;
}

/** A maker_funding snapshot, normalized for the in-memory join. */
interface MakerFundingSnapshot {
  backingWei6: bigint;
  visibleCommittedWei6: bigint;
  checkedAtBlock: string;
  updatedAtMs: number;
}

/** Raw maker_funding row as PostgREST returns it. */
interface MakerFundingRowDb {
  maker_address: string;
  backing_wei6: string | number;
  visible_committed_wei6: string | number;
  checked_at_block: string | number;
  updated_at: string;
}

/**
 * Snapshot age past which a maker_funding row is flagged `stale`. The worker
 * snapshots every ~30s, so 120s ≈ 4 missed snapshots before we stop trusting
 * the backed/overcommitted verdict.
 */
export const FILLABILITY_STALE_MS = 120_000;

/**
 * Derive the advisory fillability for one commitment from its maker's snapshot.
 * Pure. Rules:
 *   - no snapshot     → `unknown` (never asserted backed or not-backed)
 *   - snapshot stale  → `stale`   (numbers kept as last-known; "...Now" booleans null)
 *   - fresh           → `fully_backed` | `overcommitted` + the "...Now" booleans
 * The numeric fields (backing / committed / coverage / block) are last-known
 * facts as-of `checkedAtBlock`, present whenever a snapshot exists; the "...Now"
 * booleans assert CURRENT backed-ness and are computed only from a fresh
 * snapshot, so a consumer can't act on stale data as if it were current.
 */
export function computeFillability(args: {
  remainingRiskWei6: bigint;
  funding: MakerFundingSnapshot | undefined;
  nowMs: number;
  staleThresholdMs: number;
}): CommitmentFillability {
  const { remainingRiskWei6, funding, nowMs, staleThresholdMs } = args;
  if (!funding) {
    return {
      advisory: true,
      makerFundingStatus: 'unknown',
      orderIndividuallyBackedNow: null,
      makerBookBackedNow: null,
      makerBackingWei6: null,
      makerVisibleCommittedWei6: null,
      makerCoverageRatioBps: null,
      checkedAtBlock: null,
      stale: false,
    };
  }
  const ageMs = nowMs - funding.updatedAtMs;
  const stale = !Number.isFinite(ageMs) || ageMs > staleThresholdMs;
  const coverageBps =
    funding.visibleCommittedWei6 > 0n
      ? Number((funding.backingWei6 * 10_000n) / funding.visibleCommittedWei6)
      : null;
  const makerBackingWei6 = funding.backingWei6.toString();
  const makerVisibleCommittedWei6 = funding.visibleCommittedWei6.toString();
  if (stale) {
    return {
      advisory: true,
      makerFundingStatus: 'stale',
      orderIndividuallyBackedNow: null,
      makerBookBackedNow: null,
      makerBackingWei6,
      makerVisibleCommittedWei6,
      makerCoverageRatioBps: coverageBps,
      checkedAtBlock: funding.checkedAtBlock,
      stale: true,
    };
  }
  const orderIndividuallyBackedNow = funding.backingWei6 >= remainingRiskWei6;
  const makerBookBackedNow = funding.backingWei6 >= funding.visibleCommittedWei6;
  return {
    advisory: true,
    makerFundingStatus: makerBookBackedNow ? 'fully_backed' : 'overcommitted',
    orderIndividuallyBackedNow,
    makerBookBackedNow,
    makerBackingWei6,
    makerVisibleCommittedWei6,
    makerCoverageRatioBps: coverageBps,
    checkedAtBlock: funding.checkedAtBlock,
    stale: false,
  };
}

/**
 * Fetch maker_funding snapshots for a page's makers, keyed (lowercased) by
 * maker_address. A query failure logs and returns an EMPTY map → fillability
 * degrades to `unknown` for every row rather than failing the list (advisory).
 */
async function fetchMakerFunding(
  sb: ReturnType<typeof getSupabase>,
  network: string,
  makers: string[],
): Promise<Map<string, MakerFundingSnapshot>> {
  const map = new Map<string, MakerFundingSnapshot>();
  const unique = [...new Set(makers.map((m) => m.toLowerCase()))];
  if (unique.length === 0) return map;
  const { data, error } = await sb
    .from('maker_funding')
    .select('maker_address, backing_wei6, visible_committed_wei6, checked_at_block, updated_at')
    .eq('network', network)
    .in('maker_address', unique);
  if (error) {
    logger.error(
      { err: error.message },
      'commitments: maker_funding lookup failed — fillability degraded to unknown',
    );
    return map;
  }
  for (const r of (data ?? []) as MakerFundingRowDb[]) {
    map.set(r.maker_address.toLowerCase(), {
      backingWei6: BigInt(String(r.backing_wei6)),
      visibleCommittedWei6: BigInt(String(r.visible_committed_wei6)),
      checkedAtBlock: String(r.checked_at_block),
      updatedAtMs: Date.parse(r.updated_at),
    });
  }
  return map;
}

// ────────────────────────────────────────────────────────────────────────
// Shared open-book helper
//
// Bakes in the same default filter set as `GET /v1/commitments` (status
// open|partially_filled, nonce_invalidated=false, expiry in the future)
// so consumers like `GET /v1/contests/:contestId` show the same orderbook
// as the canonical commitment-list endpoint.
// ────────────────────────────────────────────────────────────────────────

// Exported so peer endpoints (e.g. /v1/speculations/:id orderbook) cap
// their open-book selects at the same row count. PostgREST's per-request
// row ceiling is 1000; an unbounded `.select()` would silently truncate.
export const OPEN_BOOK_MAX_ROWS = 1000;

export async function fetchOpenCommitmentsByContestId(
  contestId: string,
  nowMs: number = Date.now(),
): Promise<{ commitments: Array<CommitmentBody | CommitmentHiddenBody> | null; error: string | null }> {
  const config = loadConfig();
  const sb = getSupabase();
  // Open-book filter == "effective status ∈ {open, partially_filled}": live
  // status, not nonce-invalidated, not past expiry. Same boundary `nowMs` is
  // reused for the body mapper so the filter and the labels agree.
  const { data, error } = await sb
    .from('commitments')
    .select(COMMITMENT_COLUMNS)
    .eq('network', config.network)
    .eq('contest_id', contestId)
    .in('status', ['open', 'partially_filled'])
    .eq('book_visible', true)
    .eq('nonce_invalidated', false)
    .gt('expiry', new Date(nowMs).toISOString())
    .limit(OPEN_BOOK_MAX_ROWS);
  if (error) return { commitments: null, error: error.message };
  // Route every row through the redaction router (defense-in-depth on top of the
  // `book_visible=true` filter above): a hidden row that ever slips past the
  // filter emerges REDACTED, never as the full signed payload. The single filter
  // clause is no longer the sole guard. (Consumers handle the union — a redacted
  // row has no `speculationKey` to group on; see the contest detail handler.)
  return {
    commitments: (data ?? []).map((r) => commitmentRowToPublicBody(r as unknown as CommitmentRow, nowMs)),
    error: null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// POST /v1/commitments
// ────────────────────────────────────────────────────────────────────────

const POSITION_TYPE_LABEL: Record<number, 'upper' | 'lower'> = { 0: 'upper', 1: 'lower' };

export async function postCommitmentHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const config = loadConfig();
  const nowMs = Date.now();
  if (!config.scorers) {
    logger.error('postCommitmentHandler invoked but SCORER_*_ADDRESS env vars are not configured');
    res.status(500).json({
      error: 'Server not configured: missing scorer addresses.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }
  const scorers = config.scorers;

  const message = req.actionMessage;
  const commitmentHash = req.actionHash;

  const maker = String(message['maker']).toLowerCase();
  const scorer = String(message['scorer']).toLowerCase();
  const contestId = message['contestId'] as bigint;
  const lineTicks = message['lineTicks'] as number;
  const positionType = message['positionType'] as 0 | 1;
  const oddsTick = message['oddsTick'] as number;
  const riskAmount = message['riskAmount'] as bigint;
  const nonce = message['nonce'] as bigint;
  const expiry = message['expiry'] as bigint;

  const marketType: MarketType | null = scorerToType(scorer, scorers);
  if (!marketType) {
    res.status(400).json({
      error: `Unknown scorer address: ${scorer}. Must be a registered moneyline, spread, or total scorer.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const speculationKey = deriveSpeculationKey(contestId, scorer, lineTicks);
  const expiryISO = new Date(Number(expiry) * 1000).toISOString();
  const sb = getSupabase();
  const signature = (req.body as { signature: string }).signature;

  // Idempotency / enrichment lookup. Gate enrichment on `!signature` only
  // (provenance preserved — see review feedback comments in PR #2).
  const existing = await sb
    .from('commitments')
    .select(COMMITMENT_COLUMNS)
    .eq('network', config.network)
    .eq('commitment_hash', commitmentHash)
    .maybeSingle();

  if (existing.error) {
    logger.error({ err: existing.error.message }, 'commitments: idempotency lookup failed');
    res.status(500).json({ error: 'Failed to check for existing commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (existing.data) {
    const existingRow = existing.data as unknown as CommitmentRow;
    if (!existingRow.signature) {
      const enriched = await sb
        .from('commitments')
        .update({
          signature,
          risk_amount: riskAmount.toString(),
          nonce: nonce.toString(),
          expiry: expiryISO,
          speculation_key: speculationKey,
        })
        .eq('network', config.network)
        .eq('commitment_hash', commitmentHash)
        .select(COMMITMENT_COLUMNS)
        .single();
      if (enriched.error) {
        logger.error({ err: enriched.error.message }, 'commitments: enrichment update failed');
        res.status(500).json({ error: 'Failed to enrich existing commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
        return;
      }
      logger.info(
        { commitmentHash, priorSource: existingRow.source },
        'commitments: enriched signature-less row',
      );
      res.status(200).json(rowToBody(enriched.data as unknown as CommitmentRow, nowMs));
      return;
    }
    res.status(200).json(rowToBody(existingRow, nowMs));
    return;
  }

  // Nonce-floor pre-check. The contract rejects matchCommitment with
  // NonceTooLow if nonce < s_minNonces[maker][specKey]. Without this
  // pre-check the API would accept commitments no taker can fill.
  const floor = await sb
    .from('maker_nonce_floors')
    .select('min_nonce')
    .eq('network', config.network)
    .eq('maker', maker)
    .eq('speculation_key', speculationKey)
    .maybeSingle();

  if (floor.error) {
    logger.error({ err: floor.error.message }, 'commitments: nonce floor lookup failed');
    res.status(500).json({ error: 'Failed to check nonce floor.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (floor.data) {
    const minNonce = BigInt(String(floor.data.min_nonce));
    if (nonce < minNonce) {
      res.status(400).json({
        error: `Commitment nonce (${nonce.toString()}) is below the maker's current nonce floor (${minNonce.toString()}). Read maker_nonce_floors before signing.`,
        code: 'NONCE_TOO_LOW',
      } satisfies ApiError);
      return;
    }
  }

  const insert = await sb
    .from('commitments')
    .insert({
      network: config.network,
      commitment_hash: commitmentHash,
      maker,
      contest_id: contestId.toString(),
      scorer,
      line_ticks: lineTicks,
      position_type: POSITION_TYPE_LABEL[positionType],
      odds_tick: oddsTick,
      market_type: marketType,
      risk_amount: riskAmount.toString(),
      filled_risk_amount: '0',
      nonce: nonce.toString(),
      expiry: expiryISO,
      speculation_key: speculationKey,
      signature,
      status: 'open',
      source: 'agent',
    })
    .select(COMMITMENT_COLUMNS)
    .single();

  if (insert.error) {
    if (insert.error.code === '23505') {
      const reread = await sb
        .from('commitments')
        .select(COMMITMENT_COLUMNS)
        .eq('network', config.network)
        .eq('commitment_hash', commitmentHash)
        .maybeSingle();
      if (!reread.error && reread.data) {
        res.status(200).json(rowToBody(reread.data as unknown as CommitmentRow, nowMs));
        return;
      }
    }
    logger.error({ err: insert.error.message, code: insert.error.code }, 'commitments: insert failed');
    res.status(500).json({ error: 'Failed to store commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  res.status(201).json(rowToBody(insert.data as unknown as CommitmentRow, nowMs));
}

// ────────────────────────────────────────────────────────────────────────
// GET /v1/commitments
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
// Stored `status` values the `status=` filter accepts (the raw values the indexer
// / relay write). `expired` is intentionally NOT here: no writer stores it, so a
// `status=expired` filter would always be empty — effective `expired` is read off
// the response `status` field instead. See lib/commitmentStatus.ts.
const VALID_STATUSES = new Set(['open', 'partially_filled', 'filled', 'cancelled']);

function parseBoolQuery(value: unknown): boolean | null {
  if (value === undefined) return false;
  const s = String(value).toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null;
}

interface ListResponse {
  // The list applies `book_visible=true` upstream, so in practice every row
  // is a `CommitmentBody`. The union accepts `CommitmentHiddenBody` for
  // defense-in-depth: a hidden row that reaches the mapper (filter bypass)
  // still gets redacted before reply.
  commitments: Array<CommitmentBody | CommitmentHiddenBody>;
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}

// ────────────────────────────────────────────────────────────────────────
// GET /v1/commitments?since=<cursor>   (recovery mode)
//
// Cursor-ordered (row_updated_at, id) catch-up for the commitments stream.
// Unlike the open-book list, recovery INCLUDES terminal rows (filled /
// cancelled / effective-expired) so a disconnected client converges its
// local state — recovery must never hide a lifecycle transition. Filters
// are identity/scope only (maker, contestId, scorer, speculationId); the
// open-book status/expiry/nonce defaults are intentionally not applied.
// This is state-delta convergence, not a full event log: a row that
// changed several times while the client was away may surface only at its
// latest state (the append-only event stream is /v1/fills).
// ────────────────────────────────────────────────────────────────────────
async function getCommitmentsRecovery(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();
  const nowMs = Date.now();

  const recovery = parseRecovery(req, 'commitments');
  if ('errorBody' in recovery) {
    res.status(400).json(recovery.errorBody);
    return;
  }

  let maker: string | undefined;
  if (req.query.maker !== undefined) {
    const lowered = String(req.query.maker).trim().toLowerCase();
    if (!isAddress(lowered)) {
      res.status(400).json({ error: 'maker must be a valid Ethereum address.', code: 'INVALID_PARAM' } satisfies ApiError);
      return;
    }
    maker = lowered;
  }

  let scorer: string | undefined;
  if (req.query.scorer !== undefined) {
    const lowered = String(req.query.scorer).trim().toLowerCase();
    if (!isAddress(lowered)) {
      res.status(400).json({ error: 'scorer must be a valid Ethereum address.', code: 'INVALID_PARAM' } satisfies ApiError);
      return;
    }
    scorer = lowered;
  }

  let contestId: string | undefined;
  if (req.query.contestId !== undefined) {
    try {
      const v = BigInt(String(req.query.contestId));
      if (v < 0n) throw new Error();
      contestId = v.toString();
    } catch {
      res.status(400).json({ error: 'contestId must be a non-negative integer.', code: 'INVALID_PARAM' } satisfies ApiError);
      return;
    }
  }

  // speculationId → speculation_key (the indexed column commitments carry).
  let speculationKey: string | undefined;
  if (req.query.speculationId !== undefined) {
    let speculationId: string;
    try {
      const v = BigInt(String(req.query.speculationId));
      if (v < 0n) throw new Error();
      speculationId = v.toString();
    } catch {
      res.status(400).json({ error: 'speculationId must be a non-negative integer.', code: 'INVALID_PARAM' } satisfies ApiError);
      return;
    }
    const specRes = await sb
      .from('speculations')
      .select('contest_id, speculation_scorer, line_ticks')
      .eq('network', config.network)
      .eq('speculation_id', speculationId)
      .maybeSingle();
    if (specRes.error) {
      logger.error({ err: specRes.error.message }, 'commitments: recovery speculation lookup failed');
      res.status(500).json({ error: 'Failed to resolve speculationId.', code: 'INTERNAL_ERROR' } satisfies ApiError);
      return;
    }
    const sRow = specRes.data as
      | { contest_id: string | number; speculation_scorer: string | null; line_ticks: number | null }
      | null;
    if (!sRow || !sRow.speculation_scorer || sRow.line_ticks == null) {
      res.status(404).json({ error: `Speculation ${speculationId} not found or not yet enriched.`, code: 'NOT_FOUND' } satisfies ApiError);
      return;
    }
    speculationKey = deriveSpeculationKey(
      BigInt(String(sRow.contest_id)),
      String(sRow.speculation_scorer).toLowerCase(),
      sRow.line_ticks,
    );
  }

  let q = sb.from('commitments').select(COMMITMENT_RECOVERY_COLUMNS).eq('network', config.network);
  if (maker !== undefined) q = q.eq('maker', maker);
  if (scorer !== undefined) q = q.eq('scorer', scorer);
  if (contestId !== undefined) q = q.eq('contest_id', contestId);
  if (speculationKey !== undefined) q = q.eq('speculation_key', speculationKey);
  if (recovery.cursor) q = q.or(recoveryKeysetExpr(recovery.cursor));
  q = q.order('row_updated_at', { ascending: true }).order('id', { ascending: true }).limit(recovery.limit);

  const { data, error } = await q;
  if (error) {
    logger.error({ err: error.message }, 'commitments: recovery query failed');
    res.status(500).json({ error: 'Failed to fetch commitment changes.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const rows = (data ?? []) as unknown as CommitmentRecoveryRow[];
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
  // Recovery surfaces lifecycle transitions for tracked rows, including the
  // book_visible=true→false transition. Hidden rows are emitted with the
  // public allow-list projection (no filter) so a reconnecting client still
  // converges its state to "row is now off-book" rather than silently losing
  // the row. (This deliberately deviates from `implementation-plan.md` §M2's
  // "also add `book_visible=true` filter" recommendation — see PR description
  // for the convergence-vs-defense trade-off the deviation resolves.)
  res.status(200).json({
    commitments: rows.map((r) => commitmentRowToPublicBody(r as unknown as CommitmentRow, nowMs)),
    nextCursor: nextCursor('commitments', last, recovery.sinceRaw),
    hasMore: rows.length === recovery.limit,
  });
}

export async function getCommitmentsHandler(req: Request, res: Response): Promise<void> {
  // `?includeHidden` is removed (M2). Reject ANY presence — any value, every
  // sub-route — BEFORE the `?since=` recovery branch dispatches, so the
  // contract "param removed everywhere, 400 before any DB call" holds whether
  // the caller is hitting the list path or recovery. Makers retrieve hidden
  // bodies via the owner-auth own-state surface (M4).
  if (req.query.includeHidden !== undefined) {
    res.status(400).json({
      error:
        'includeHidden has been removed from public commitment endpoints. ' +
        'Use the owner-auth own-state surface for maker-owned hidden commitments.',
      code: 'INCLUDE_HIDDEN_REMOVED',
    } satisfies ApiError);
    return;
  }

  // `?since=<cursor>` switches to cursor recovery mode (ordered by
  // row_updated_at, includes terminal lifecycle rows). Absent → the
  // open-book list below, unchanged.
  if (req.query.since !== undefined) {
    await getCommitmentsRecovery(req, res);
    return;
  }

  const config = loadConfig();
  const sb = getSupabase();

  // ── Parse + validate query params ─────────────────────────────────────
  const limitRaw = req.query.limit ? Number(req.query.limit) : DEFAULT_LIMIT;
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
    res.status(400).json({
      error: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const offsetRaw = req.query.offset ? Number(req.query.offset) : 0;
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
    res.status(400).json({
      error: 'offset must be a non-negative integer.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  // Status: comma-separated list, filtered against the STORED `status` column.
  // Default `open,partially_filled` (both still fillable — `partially_filled`
  // rows have `remaining_risk_amount > 0`). NOTE: this filters the raw indexed
  // value, while the response `status` is EFFECTIVE (folds expiry + nonce
  // invalidation — see `storedStatus` for the raw value). Filtering the stored
  // column keeps pagination + count DB-exact; effective `expired`/`cancelled`
  // rows that derive from a stored open/partially_filled row are surfaced by the
  // response `status` (e.g. with includeExpired=true), not by `status=expired`.
  let statuses: string[];
  if (req.query.status !== undefined) {
    const raw = String(req.query.status).toLowerCase();
    statuses = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (statuses.length === 0) {
      res.status(400).json({
        error: 'status must be a non-empty comma-separated list.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    for (const s of statuses) {
      if (!VALID_STATUSES.has(s)) {
        res.status(400).json({
          error: `Invalid status "${s}". Must be one of: ${[...VALID_STATUSES].join(', ')}.`,
          code: 'INVALID_PARAM',
        } satisfies ApiError);
        return;
      }
    }
  } else {
    statuses = ['open', 'partially_filled'];
  }

  // Boolean opt-outs for the default "matchable open book" filters.
  // Defaults exclude nonce-invalidated rows (the contract will reject
  // matchCommitment) and expired rows. Power users can opt back in.
  const includeInvalidated = parseBoolQuery(req.query.includeInvalidated);
  if (req.query.includeInvalidated !== undefined && includeInvalidated === null) {
    res.status(400).json({
      error: 'includeInvalidated must be true|false|1|0.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const includeExpired = parseBoolQuery(req.query.includeExpired);
  if (req.query.includeExpired !== undefined && includeExpired === null) {
    res.status(400).json({
      error: 'includeExpired must be true|false|1|0.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  // (`?includeHidden` is rejected at the top of `getCommitmentsHandler`
  // above — placing the check here would let
  // `?since=<cursor>&includeHidden=*` bypass the rejection.)
  // Opt-in advisory fillability (Layer D). When true, each row carries a
  // `fillability` object from the maker_funding snapshot. Default off — the
  // response is byte-identical without it (one extra query only when asked).
  const includeFillability = parseBoolQuery(req.query.includeFillability);
  if (req.query.includeFillability !== undefined && includeFillability === null) {
    res.status(400).json({
      error: 'includeFillability must be true|false|1|0.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  // Lowercase first so mixed-case input passes (see positions.ts comment).
  let maker: string | undefined;
  if (req.query.maker !== undefined) {
    const lowered = String(req.query.maker).trim().toLowerCase();
    if (!isAddress(lowered)) {
      res.status(400).json({
        error: 'maker must be a valid Ethereum address.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    maker = lowered;
  }

  let scorer: string | undefined;
  if (req.query.scorer !== undefined) {
    const lowered = String(req.query.scorer).trim().toLowerCase();
    if (!isAddress(lowered)) {
      res.status(400).json({
        error: 'scorer must be a valid Ethereum address.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    scorer = lowered;
  }

  let contestId: string | undefined;
  if (req.query.contestId !== undefined) {
    try {
      const v = BigInt(String(req.query.contestId));
      if (v < 0n) throw new Error();
      contestId = v.toString();
    } catch {
      res.status(400).json({
        error: 'contestId must be a non-negative integer.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
  }

  // Speculation filter: validate the id, look up the speculation row to
  // derive its `speculation_key`, and filter commitments on that column.
  // Faster than a (contestId, scorer, lineTicks) tuple match because
  // `speculation_key` is an indexed column on commitments.
  let speculationKey: string | undefined;
  if (req.query.speculationId !== undefined) {
    let speculationId: string;
    try {
      const v = BigInt(String(req.query.speculationId));
      if (v < 0n) throw new Error();
      speculationId = v.toString();
    } catch {
      res.status(400).json({
        error: 'speculationId must be a non-negative integer.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    const specRes = await sb
      .from('speculations')
      .select('contest_id, speculation_scorer, line_ticks')
      .eq('network', config.network)
      .eq('speculation_id', speculationId)
      .maybeSingle();
    if (specRes.error) {
      logger.error({ err: specRes.error.message }, 'commitments: speculation lookup failed');
      res.status(500).json({ error: 'Failed to resolve speculationId.', code: 'INTERNAL_ERROR' } satisfies ApiError);
      return;
    }
    if (!specRes.data) {
      res.status(404).json({
        error: `Speculation ${speculationId} not found.`,
        code: 'NOT_FOUND',
      } satisfies ApiError);
      return;
    }
    const sRow = specRes.data as { contest_id: string | number; speculation_scorer: string | null; line_ticks: number | null };
    if (!sRow.speculation_scorer || sRow.line_ticks == null) {
      // Indexer-only stub before the speculation is fully enriched —
      // can't derive a key. Treat as not-found for filter purposes.
      res.status(404).json({
        error: `Speculation ${speculationId} is not yet enriched (missing scorer / lineTicks).`,
        code: 'NOT_FOUND',
      } satisfies ApiError);
      return;
    }
    speculationKey = deriveSpeculationKey(
      BigInt(String(sRow.contest_id)),
      String(sRow.speculation_scorer).toLowerCase(),
      sRow.line_ticks,
    );
  }

  // ── Query + map ─────────────────────────────────────────────────────────
  // `status`, `includeInvalidated`, and `includeExpired` filter on the STORED
  // status column + the nonce/expiry columns. Keeping the filter DB-backed means
  // pagination + count stay exact at any scale (no in-memory post-filter cap).
  // The response `status` is EFFECTIVE (rowToBody folds expiry + nonce
  // invalidation; `storedStatus` carries the raw value). `nowMs` is captured once
  // and reused for BOTH the expiry boundary and derivation, so on the rows this
  // returns the filter and the labels agree. (Effective `expired`/`cancelled`
  // that derive from a stored open/partially_filled row are surfaced by reading
  // the response `status` — e.g. with includeExpired=true / get-by-hash — not by
  // a `status=expired` filter, which matches the stored column. See README.)
  const nowMs = Date.now();

  let q = sb
    .from('commitments')
    .select(COMMITMENT_COLUMNS, { count: 'exact' })
    .eq('network', config.network)
    .in('status', statuses);

  if (maker !== undefined) q = q.eq('maker', maker);
  if (scorer !== undefined) q = q.eq('scorer', scorer);
  if (contestId !== undefined) q = q.eq('contest_id', contestId);
  if (speculationKey !== undefined) q = q.eq('speculation_key', speculationKey);
  // Hidden rows are always excluded from the public list (see `includeHidden`
  // removal above). The mapper below double-projects through
  // `commitmentRowToPublicBody` as defense-in-depth so any bug that lets a
  // hidden row past the filter still produces a redacted body.
  q = q.eq('book_visible', true);
  if (!includeInvalidated) q = q.eq('nonce_invalidated', false);
  if (!includeExpired) {
    // Postgres `>` is false (not null) for NULL operands, so this also excludes
    // NULL-expiry rows — correct, since their effective status is `expired`.
    q = q.gt('expiry', new Date(nowMs).toISOString());
  }

  q = q
    .order('created_at', { ascending: false })
    .order('commitment_hash', { ascending: true })
    .range(offsetRaw, offsetRaw + limitRaw - 1);

  const { data, count, error } = await q;
  if (error) {
    logger.error({ err: error.message }, 'commitments: list query failed');
    res.status(500).json({ error: 'Failed to list commitments.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const total = count ?? 0;
  const rows = (data ?? []) as unknown as CommitmentRow[];

  // Advisory fillability: one extra indexed maker_funding query keyed by the
  // page's makers, joined in memory. Failure degrades to `unknown` (the list
  // still returns) — an advisory add-on must never break the core read.
  let fundingByMaker = new Map<string, MakerFundingSnapshot>();
  if (includeFillability && rows.length > 0) {
    fundingByMaker = await fetchMakerFunding(sb, config.network, rows.map((r) => r.maker));
  }

  const body: ListResponse = {
    commitments: rows.map((r) => {
      const cb = commitmentRowToPublicBody(r, nowMs);
      // The upstream filter guarantees `cb` is a full `CommitmentBody`. The
      // narrow handles the impossible-but-defended hidden case: log + emit
      // the redacted projection rather than skipping the row outright (the
      // caller still gets a discriminant entry to reconcile against).
      if ('redacted' in cb) {
        logger.warn(
          { commitmentHash: cb.commitmentHash },
          'commitments: hidden row reached the public list — defensive redaction applied',
        );
        return cb;
      }
      if (includeFillability) {
        cb.fillability = computeFillability({
          remainingRiskWei6: BigInt(cb.remainingRiskAmount),
          funding: fundingByMaker.get(cb.maker.toLowerCase()),
          nowMs,
          staleThresholdMs: FILLABILITY_STALE_MS,
        });
      }
      return cb;
    }),
    pagination: {
      limit: limitRaw,
      offset: offsetRaw,
      total,
      hasMore: offsetRaw + rows.length < total,
    },
  };
  res.status(200).json(body);
}

// ────────────────────────────────────────────────────────────────────────
// GET /v1/commitments/:hash
// ────────────────────────────────────────────────────────────────────────

const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

/**
 * Single-row lookup by EIP-712 commitment hash. Returns the canonical
 * body shape so consumers don't have to branch on which endpoint
 * produced the row. 404 when no row exists for the (network, hash)
 * pair — including when only an indexer-projected cancel/match exists
 * (those rows DO have a hash). Lowercased before query because the
 * `commitments` table stores the hash lowercased.
 */
export async function getCommitmentByHashHandler(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();
  const nowMs = Date.now();

  const raw = String(req.params['hash'] ?? '').trim();
  if (!HASH_PATTERN.test(raw)) {
    res.status(400).json({
      error: 'Path :hash must be a 0x-prefixed 32-byte hex string.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const hash = raw.toLowerCase();

  const { data, error } = await sb
    .from('commitments')
    .select(COMMITMENT_COLUMNS)
    .eq('network', config.network)
    .eq('commitment_hash', hash)
    .maybeSingle();

  if (error) {
    logger.error({ err: error.message }, 'commitments: get-by-hash query failed');
    res.status(500).json({ error: 'Failed to fetch commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (!data) {
    res.status(404).json({
      error: `Commitment ${hash} not found.`,
      code: 'NOT_FOUND',
    } satisfies ApiError);
    return;
  }

  res.status(200).json(commitmentRowToPublicBody(data as unknown as CommitmentRow, nowMs));
}

// ────────────────────────────────────────────────────────────────────────
// DELETE /v1/commitments/:hash
// ────────────────────────────────────────────────────────────────────────

/**
 * Off-chain cancel = remove from the public order book. The maker signs a
 * CancelCommitment action; we set `book_visible=false` and leave the canonical
 * on-chain `status` untouched. The commitment stays matchable on-chain until it
 * expires, is nonce-invalidated, or is cancelled on-chain (COMMITMENT_CANCELLED);
 * a later on-chain match is applied normally by the indexer's fill_commitment.
 * See migration 049 / docs/CANCEL_FLOW.md.
 *
 * The response surfaces effective `status='cancelled'` for a hidden live row
 * (backward compatible), with `storedStatus='open'` and `bookVisible=false`.
 *
 * Race notes (see docs/CANCEL_FLOW.md):
 *   - Off-chain DELETE while a taker has an in-flight matchCommitment tx: the CAS
 *     guard (status='open' AND book_visible=true) loses if the match projects
 *     first, so a still-VISIBLE matched row returns 409 (use on-chain cancel).
 *   - DELETE succeeds, the commitment then matches on-chain, then a retry DELETE:
 *     the row is already hidden (book_visible=false), so the retry is idempotent
 *     200 — even though storedStatus is now partially_filled/filled (surfaced in
 *     the body). "Already hidden" wins over "matched"; 409 is reserved for hiding
 *     a still-visible matched commitment.
 *   - On-chain cancel then off-chain DELETE: handler sees `status='cancelled'`
 *     and returns 200 idempotent.
 *   - Duplicate DELETE: already hidden → 200 idempotent.
 */
export async function deleteCommitmentHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();
  const nowMs = Date.now();

  // ── Validate the URL :hash matches the signed action ─────────────────
  const urlHash = String(req.params['hash'] ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(urlHash)) {
    res.status(400).json({
      error: 'Path :hash must be a 0x-prefixed 32-byte hex string.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const signedHash = String(req.actionMessage['commitmentHash']).toLowerCase();
  if (signedHash !== urlHash) {
    res.status(400).json({
      error: 'Signed commitmentHash does not match the URL :hash. Re-sign with the correct hash.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  // ── Lookup ────────────────────────────────────────────────────────────
  const lookup = await sb
    .from('commitments')
    .select(COMMITMENT_COLUMNS)
    .eq('network', config.network)
    .eq('commitment_hash', urlHash)
    .maybeSingle();

  if (lookup.error) {
    logger.error({ err: lookup.error.message }, 'commitments: cancel lookup failed');
    res.status(500).json({ error: 'Failed to look up commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (!lookup.data) {
    res.status(404).json({
      error: 'Commitment not found.',
      code: 'NOT_FOUND',
    } satisfies ApiError);
    return;
  }
  const row = lookup.data as unknown as CommitmentRow;

  // ── Authorization: signer must equal the row's maker ─────────────────
  // The middleware already verified the signature; the recovered address
  // is the only authoritative claim of identity. Since CancelCommitment
  // doesn't carry maker in the typed data, we compare here.
  if (req.authenticatedWallet.toLowerCase() !== row.maker.toLowerCase()) {
    logger.warn(
      { recovered: req.authenticatedWallet, rowMaker: row.maker, commitmentHash: urlHash },
      'commitments: cancel signer does not match commitment maker',
    );
    res.status(403).json({
      error: 'Signature does not match the commitment maker.',
      code: 'FORBIDDEN',
    } satisfies ApiError);
    return;
  }

  // ── Status branching ──────────────────────────────────────────────────
  // Off-chain cancel = "hide from the public book" (book_visible=false). It must
  // NOT touch the canonical on-chain `status`: a hidden row stays `open`, so a
  // later on-chain match is applied normally by the indexer's fill_commitment.
  // See migration 049 / docs/CANCEL_FLOW.md.
  //
  // Already hidden from the book (off-chain DELETE applied), or authoritatively
  // cancelled on-chain (COMMITMENT_CANCELLED) → idempotent 200, regardless of
  // whether the row has since matched. DELETE means "hide from book"; if it's
  // already hidden the request is satisfied. A hidden-then-matched row (the race
  // this split fixes: book_visible=false, status partially_filled/filled) returns
  // 200 too — the body still carries storedStatus + bookVisible + fill accounting,
  // so the real fill state is visible to the caller.
  if (row.book_visible === false || row.status === 'cancelled') {
    res.status(200).json(rowToBody(row, nowMs));
    return;
  }
  // Visible + matched (filled or partially_filled) → on-chain only. A matched
  // remainder that is STILL on the public book can't be retracted off-chain.
  if (row.status === 'filled' || row.status === 'partially_filled') {
    res.status(409).json({
      error: `Commitment is ${row.status}; off-chain cancel is not allowed once a match exists. Use MatchingModule.cancelCommitment(c) on chain.`,
      code: 'COMMITMENT_MATCHED',
    } satisfies ApiError);
    return;
  }
  // Anything other than `open` at this point is an unexpected state.
  if (row.status !== 'open') {
    logger.warn(
      { commitmentHash: urlHash, status: row.status },
      'commitments: cancel hit an unexpected status',
    );
    res.status(409).json({
      error: `Commitment is in an unexpected state (${row.status}) and cannot be cancelled.`,
      code: 'INVALID_STATE',
    } satisfies ApiError);
    return;
  }

  // ── Hide from book ────────────────────────────────────────────────────
  // Set book_visible=false; leave `status` untouched (canonical chain lifecycle).
  // CAS-guarded on (status='open' AND book_visible=true) so we don't race a
  // concurrent on-chain match projected by the indexer, or a duplicate DELETE.
  const update = await sb
    .from('commitments')
    .update({ book_visible: false })
    .eq('network', config.network)
    .eq('commitment_hash', urlHash)
    .eq('status', 'open')
    .eq('book_visible', true)
    .select(COMMITMENT_COLUMNS)
    .maybeSingle();

  if (update.error) {
    logger.error({ err: update.error.message }, 'commitments: cancel update failed');
    res.status(500).json({ error: 'Failed to cancel commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (!update.data) {
    // CAS lost — between lookup and update the row stopped being open+visible.
    // Re-read and respond based on the new state.
    const reread = await sb
      .from('commitments')
      .select(COMMITMENT_COLUMNS)
      .eq('network', config.network)
      .eq('commitment_hash', urlHash)
      .maybeSingle();
    if (reread.error || !reread.data) {
      res.status(500).json({ error: 'Failed to cancel commitment.', code: 'INTERNAL_ERROR' } satisfies ApiError);
      return;
    }
    const fresh = reread.data as unknown as CommitmentRow;
    // Concurrently hidden (book_visible=false, even if it also matched in the race),
    // or authoritatively cancelled on-chain → idempotent 200.
    if (fresh.book_visible === false || fresh.status === 'cancelled') {
      res.status(200).json(rowToBody(fresh, nowMs));
      return;
    }
    // Otherwise it matched while still visible → on-chain only.
    res.status(409).json({
      error: `Commitment status changed to ${fresh.status} during cancel; off-chain cancel is no longer applicable.`,
      code: 'COMMITMENT_MATCHED',
    } satisfies ApiError);
    return;
  }

  logger.info({ commitmentHash: urlHash, maker: row.maker }, 'commitments: off-chain book-hide applied');
  res.status(200).json(rowToBody(update.data as unknown as CommitmentRow, nowMs));
}
