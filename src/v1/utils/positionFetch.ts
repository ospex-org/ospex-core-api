/**
 * Categorized position fetcher for /v1/positions/:address/{status,claim-params}.
 *
 * Pure Supabase. The legacy version of this helper queried Firestore
 * through a clean-looking interface — that pattern is intentionally not
 * portable here (no Firebase deps in the package).
 *
 * Deviations vs that legacy helper:
 *   - No `withdrawable` bucket. Positions are always fully matched
 *     at fill time; there is no `unmatched_amount` column on the
 *     `positions` table and no `adjustUnmatchedPair` contract method.
 *     The analog of "withdraw your unfilled stake" is "cancel your
 *     open commitment" via `MatchingModule.cancelCommitment(...)`,
 *     which is commitment-domain and constructed client-side from
 *     `GET /v1/commitments?maker=…`.
 *   - `oddsPairId` is gone — positions are uniquely keyed by
 *     `(speculationId, user, positionType)`.
 *   - Implied odds are derived from `risk_amount` + `profit_amount`
 *     (the position carries `profit_amount` directly; no need to
 *     reconstruct from upper/lower odds at query time).
 *
 * Categorization:
 *   - active        — speculation_status = 'open',   claimed = false,
 *                     and no payout bucket claimed the row. Usually
 *                     contest_status is 'unverified' or 'verified' and
 *                     there is genuinely nothing to do yet, but it is
 *                     NOT "nothing to do": a 'scored' contest whose
 *                     prediction inputs are missing, and every 'voided'
 *                     contest, are settlementCandidates AND active.
 *                     Read settlementCandidates for the work, not the
 *                     absence of a row here.
 *   - pendingSettle — speculation_status = 'open',   claimed = false,
 *                     contest_status = 'scored'. The contest is final
 *                     but `settleSpeculation` hasn't been called yet.
 *                     The SDK can resolve these by calling
 *                     `settleSpeculation` followed by `claimPosition`.
 *                     Predicted result + payout are computed from the
 *                     contest scores by replaying the scorer logic.
 *                     Lost positions are filtered out of this payout
 *                     bucket (`claimPosition` reverts with NoPayout).
 *   - settlementCandidates — ALL positive-risk unclaimed positions on
 *                     'scored' OR 'voided' contests with open
 *                     speculations, including predicted losers and rows
 *                     with missing prediction inputs. Settlement can
 *                     release counterparty funds even when the
 *                     controlled position itself lost, and a voided
 *                     contest refunds both sides. Not a payout bucket:
 *                     an open void's refund AMOUNT is not served here
 *                     or in pendingSettle — see the bound in
 *                     `docs/positions-complete-enumeration.md`.
 *   - claimable     — speculation_status = 'closed', claimed = false,
 *                     estimated payout > 0 (won, push, or void; lost
 *                     positions have payout = 0 and are filtered out
 *                     because `claimPosition` reverts with NoPayout)
 *   - settledLost   — speculation_status = 'closed', claimed = false,
 *                     authoritative win_side is the opposing side.
 *                     Terminal identity only, NOT exposure or a payout.
 *                     Open predicted losers remain settlementCandidates.
 *
 * Default: one capped 200-row query, preserving the own-state snapshot
 * budget and raw hitCap signal. Public status/claim-params explicitly
 * opt into a complete scan using <=199-row immutable-id keyset pages.
 * Complete scans fail closed; no partial buckets escape on any read error.
 */

import { getSupabase } from '../../lib/supabase.js';
import { wei6ToUSDC } from '../../lib/sanitize.js';
import { didWin, predictWinSide } from '../../lib/speculation.js';
import type { MarketType, WinSide } from '../../lib/speculation.js';
import { loadConfig } from '../../lib/env.js';
import {
  derivePositionStatus,
  type PositionStatus,
} from '../ownState/positionStatus.js';
import { maxIsoTimestamptz } from '../ownState/timestamps.js';

const POSITION_QUERY_LIMIT = 200;
const COMPLETE_PAGE_SIZE = 199;

/**
 * The resource budget on a COMPLETE traversal. Applies to `complete` only; the
 * default capped path is a single read and is untouched.
 *
 * ## Why this is allowed to refuse, when a linter is not
 *
 * `.claude/rules/advisory-tooling.md` keeps the blocking list short and
 * deliberate. This belongs on it: it is a fail-closed resource gate on a
 * money-adjacent read, and the thing it refuses to do is return a number
 * nobody bounded. It is not convenience tooling and it cannot fail while the
 * system is fine — it fires only when a traversal genuinely exceeded a stated
 * bound.
 *
 * ## The unit, which decides the off-by-one
 *
 * `COMPLETE_MAX_PAGES` counts DATABASE READS of the positions scan, the same
 * thing `enumeration.pages` reports — terminal short read included. The loop
 * stops on a short page, so a population that is an exact multiple of
 * `COMPLETE_PAGE_SIZE` costs one extra read to discover it has ended. The
 * largest population that completes is therefore
 * `COMPLETE_MAX_PAGES * COMPLETE_PAGE_SIZE - 1` = 12,735 rows; 12,736 needs a
 * 65th read and is refused. Stated because "at the limit" and "one over" are
 * otherwise indistinguishable from an off-by-one.
 *
 * Rows need no separate budget: an oversized page is already refused below, so
 * reads x page size bounds rows exactly. A third constant would only drift.
 *
 * ## Which of the two is the real guard
 *
 * The DEADLINE is. It covers the whole traversal — the scan and both joins —
 * because that is what a request spends, and it is half of Heroku's 30s router
 * timeout so the categorisation and the response still fit in the other half.
 * `COMPLETE_MAX_PAGES` is the backstop for a loop that is pathological but
 * FAST, where elapsed time would never notice. So the page budget is set
 * generously on purpose: 12,735 rows is roughly 28x the largest population this
 * repo has ever exercised, and a wallet legitimately past it should get the
 * bound raised deliberately rather than be refused by a number nobody chose.
 */
const COMPLETE_MAX_PAGES = 64;
const COMPLETE_DEADLINE_MS = 15_000;

/** Which bound a complete traversal ran into. */
export type EnumerationLimit = 'pages' | 'deadline';

/**
 * A complete traversal refused to continue.
 *
 * Typed, and distinct per bound, because the two call for different operator
 * actions: `pages` means a population outgrew a constant and somebody decides
 * whether to raise it; `deadline` means reads got slower and somebody looks at
 * why. Flattening both into a bare `INTERNAL_ERROR` — which is what the
 * handlers did with every throw on this path — makes them the same page in the
 * logs as a dropped connection.
 *
 * Neither is transient. Retrying the same wallet reproduces it.
 */
export class PositionEnumerationLimitError extends Error {
  constructor(readonly limit: EnumerationLimit, message: string) {
    super(message);
    this.name = 'PositionEnumerationLimitError';
  }
}

/** The bound a thrown value ran into, or null when it is any other failure. */
export function enumerationLimitOf(err: unknown): EnumerationLimit | null {
  return err instanceof PositionEnumerationLimitError ? err.limit : null;
}

const POSITION_TYPE_TO_INT: Record<'upper' | 'lower', 0 | 1> = { upper: 0, lower: 1 };
const POSITION_TYPE_FROM_INT: Record<0 | 1, 'upper' | 'lower'> = { 0: 'upper', 1: 'lower' };

export interface PositionBase {
  positionId: string;            // `${speculationId}_${user}_${positionType}` — position identity
  speculationId: string;
  positionType: 0 | 1;            // 0 = upper (away/over), 1 = lower (home/under)
  team: string;                   // your side: away if upper, home if lower
  opponent: string;
  market: MarketType;
  oddsDecimal: number | null;     // implied: 1 + (profit_amount / risk_amount)
  riskAmountUSDC: number;
  profitAmountUSDC: number;
  // ── Owner-state enrichment ────────────────────────────────────────────
  contestId: string;             // parent contest (numeric id as string)
  sport: string;                 // contests.sport_slug ?? '' — matches the API's sport mapping
  awayTeam: string;              // ABSOLUTE away team (distinct from the maker-relative `team`)
  homeTeam: string;              // ABSOLUTE home team
  riskAmountWei6: string;        // authoritative wei6 (your stake); `riskAmountUSDC` stays for back-compat
  counterpartyRiskWei6: string;  // authoritative wei6 (counterparty stake = your profit in zero-vig)
  updatedAtUnixSec: number;      // max(position, speculation, contest) row_updated_at, as unix seconds
}

export interface ClaimablePosition extends PositionBase {
  result: 'won' | 'push' | 'void';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
}

/** Terminal loss. Risk/profit fields are historical, never payable or active exposure. */
export interface SettledLostPosition extends PositionBase {
  result: 'lost';
}

/**
 * A position whose parent contest has been scored on-chain but whose
 * speculation hasn't been settled yet. The on-chain finalization path
 * is `SpeculationModule.settleSpeculation(speculationId)` (permissionless,
 * any EOA) followed by `PositionModule.claimPosition(...)`. The `result`
 * is computed off-chain from `contests.{away_score, home_score}` plus
 * `speculations.line_ticks` by replaying the scorer logic — once
 * `settleSpeculation` runs, the on-chain `winSide` will match.
 */
export interface PendingSettlePosition extends PositionBase {
  /** Predicted result once `settleSpeculation` is called. */
  result: 'won' | 'push' | 'void';
  /** Predicted on-chain winSide once settled. */
  predictedWinSide: 'away' | 'home' | 'over' | 'under' | 'push';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
}

/**
 * One row's worth of derived state for the own-state stream's
 * positionStatus seeding. Computed from the SAME join the categorization
 * uses, so the snapshot's wire body and the hub-cache seed cannot disagree
 * about position state — that disagreement was the cold-start race
 * blocker.
 *
 * `key` = `${speculationId}_${positionType}` matches the hub's
 * `statusCache` keying convention. `sourceUpdatedAt` = the max of
 * (position, speculation, contest) row_updated_at, so cursor.p minted
 * from this matches the wire semantic the stream advances by.
 */
export interface DerivedPositionStatus {
  key: string;
  status: PositionStatus;
  sourceUpdatedAt: string;
  /**
   * Advisory categorical result (won/lost/push/void). The own-state stream's
   * dedup contract treats this as a payload field — a same-status event
   * with a different `result` still emits, so a contest score correction
   * that flips `pendingSettle` from `won` to `push` surfaces even though
   * the status itself is unchanged.
   */
  result: 'won' | 'lost' | 'push' | 'void' | undefined;
  /**
   * wei6 claimable amount when the position has a non-zero payout
   * (pendingSettle won/push, claimable, void). Same payload-dedup
   * rationale as `result` — a score correction that changes the
   * predicted payout must re-emit even at the same status.
   */
  claimableAmount: string | undefined;
}

export interface PositionFetchResult {
  active: PositionBase[];
  pendingSettle: PendingSettlePosition[];
  claimable: ClaimablePosition[];
  /** Settlement work, NOT a payout bucket. Deduplicate speculationId before settling. */
  settlementCandidates: PositionBase[];
  /** Closed losing positions only; no settlement/claim work or money totals. */
  settledLost: SettledLostPosition[];
  /** Present only for explicitly requested complete enumeration. */
  enumeration?: PositionEnumeration;
  /**
   * `true` when the raw `positions` DB query returned exactly
   * `POSITION_QUERY_LIMIT` rows — the categorization happens AFTER that
   * cap, so checking `active.length + pendingSettle.length +
   * claimable.length` is unsafe (it under-detects truncation when the
   * helper filters out lost rows below the cap). Callers that need to
   * know whether more positions exist beyond what was categorized MUST
   * read this field.
   */
  hitCap: boolean;
  /**
   * Derived positionStatus + sourceUpdatedAt for EVERY position the
   * helper saw (including predicted-losers and zero-payout rows the
   * buckets drop). Consumers seeding the own-state hub cache use this to
   * eliminate the cold-start race between the snapshot's wire body and
   * a separately-derived seed pass. `loadOwnStateSnapshot` also takes
   * `max(sourceUpdatedAt)` over this list as the response cursor's `p`
   * watermark so the snapshot and stream share one cursor domain.
   */
  derivedStatuses: DerivedPositionStatus[];
}

export interface PositionEnumeration {
  complete: true;
  pageSize: 199;
  /** Successful raw-position reads, including a terminal empty read if needed. */
  pages: number;
  /** Raw positive-risk unclaimed rows, BEFORE categorization; never a bucket count. */
  positionCount: number;
}

interface PositionRow {
  /** Immutable bigint identity, selected only for complete enumeration. */
  id?: string | number;
  speculation_id: number;
  user_address: string;
  position_type: 'upper' | 'lower';
  risk_amount: string | number;
  profit_amount: string | number | null;
  claimed: boolean;
  position_created_at: string | null;
  row_updated_at: string;
}

interface SpeculationRow {
  speculation_id: number;
  contest_id: number | null;
  market_type: MarketType | null;
  line_ticks: number | null;
  speculation_status: 'open' | 'closed';
  win_side: WinSide;
  row_updated_at: string;
}

interface ContestRow {
  contest_id: number;
  away_team: string | null;
  home_team: string | null;
  sport_slug: string | null;
  contest_status: 'unverified' | 'verified' | 'scored' | 'voided';
  away_score: number | null;
  home_score: number | null;
  row_updated_at: string;
}

/**
 * The contest statuses that put settlement work in front of an OPEN speculation,
 * as far as this endpoint can assert it from the row alone.
 *
 * `contest_status` has exactly four values — guaranteed by the Postgres enum in
 * `ospex-indexer/schema/live.sql`, not by the unvalidated `ContestRow` cast above:
 *
 *   - `scored` — the scorer published a result, so `settleSpeculation` assigns the
 *     winning side and releases the counterparty's funds. IN this set.
 *   - `voided` — already voided, so `settleSpeculation` assigns `void` and BOTH
 *     positions become refundable for their own risk. IN this set.
 *   - `verified` — **settleable too, once the void cooldown has elapsed**, and NOT
 *     in this set. See the bound below; tracked as #79.
 *   - `unverified` — unreachable for an open speculation, because creating one
 *     requires a Verified contest. Kept as a defensive negative control only.
 *
 * ## The bound: `voided` is a CONSEQUENCE of settlement, not a precondition
 *
 * `SpeculationModule.settleSpeculation`'s post-scored branch fires on the clock
 * alone, and voids a still-`Verified` contest itself on the way through:
 *
 *     if (block.timestamp >= contestStartTime + i_voidCooldown) {
 *         if (contest.contestStatus == ContestStatus.Verified) {
 *             contestModule.voidContest(s.contestId);
 *         }
 *         ... winSide = Void
 *
 * `ContestStatus.Voided` has exactly one write site, reachable only from that
 * call — so a contest reads `voided` BECAUSE someone already settled the first
 * speculation on it while it was `verified`. This set therefore catches the
 * sibling speculations and not the first one, which is the settlement that starts
 * a stalled contest's refund.
 *
 * That gap is deliberate rather than overlooked, and it is #79 rather than a line
 * here, because `verified` + past-cooldown is a PREDICTION from a stored timestamp
 * plus the deployment's `voidCooldown` immutable — neither of which this endpoint
 * reads — where `scored` and `voided` are facts the indexer mirrors from events.
 * Advertising work on a wrong constant reverts `ContestNotFinalized`.
 *
 * Enumerated as a set rather than written as a negation on purpose: membership is
 * what makes a row actionable, so a status must be classified deliberately instead
 * of being admitted by default.
 */
const SETTLEABLE_OPEN_CONTEST_STATUSES: ReadonlySet<ContestRow['contest_status']> =
  new Set<ContestRow['contest_status']>(['scored', 'voided']);


function impliedOddsDecimal(risk: bigint, profit: bigint | null): number | null {
  if (profit == null || risk === 0n) return null;
  // decimal odds = 1 + profit/risk. Convert via Number — fine for USDC-scale values
  // (uint256 here is bounded by USDC supply, well under 2^53).
  return 1 + Number(profit) / Number(risk);
}

function positionIdentity(row: PositionRow): bigint {
  const id = row.id;
  if (
    (typeof id !== 'string' && typeof id !== 'number') ||
    (typeof id === 'number' && !Number.isSafeInteger(id)) ||
    !/^(0|[1-9]\d*)$/.test(String(id))
  ) {
    throw new Error('fetchCategorizedPositions positions: invalid or unsafe identity');
  }
  return BigInt(id);
}

export function fetchCategorizedPositions(
  address: string,
  options: { complete: true },
): Promise<PositionFetchResult & { enumeration: PositionEnumeration }>;
export function fetchCategorizedPositions(
  address: string,
  options?: { complete?: boolean },
): Promise<PositionFetchResult>;
export async function fetchCategorizedPositions(
  address: string,
  options: { complete?: boolean } = {},
): Promise<PositionFetchResult> {
  const config = loadConfig();
  const sb = getSupabase();
  const lowerAddress = address.toLowerCase();

  // Step 1: query unclaimed positions with non-zero stake.
  //
  // `risk_amount > 0` is critical: the secondary-market transfer
  // handler in the indexer subtracts transferred amounts and leaves
  // the sender's row at `risk_amount=0, claimed=false`. Without this
  // filter, those zero-risk rows would land in `active` (no skin in
  // the game) for any open speculation — a misleading "active"
  // position. Filtering at the DB layer also prevents historical
  // transferred-out rows from competing against real positions for
  // the 200-row cap when a maker uses the secondary market heavily.
  // (Closed-speculation zero-risk rows are already filtered later,
  // by the `riskWei6 === 0n || payoutWei6 === 0n` check that mirrors
  // the contract's `PositionModule__NoPayout` guard.)
  const positions: PositionRow[] = [];
  let pages = 0;
  let beforeId: bigint | undefined;
  // One deadline for the WHOLE complete traversal, read once. The scan and both
  // joins share it because a request spends the sum of all three, and bounding
  // them separately would let three in-budget phases add up to an out-of-budget
  // request.
  const deadlineAt = Date.now() + COMPLETE_DEADLINE_MS;
  const refuseIfLate = (phase: string): void => {
    if (options.complete && Date.now() > deadlineAt) {
      throw new PositionEnumerationLimitError(
        'deadline',
        `fetchCategorizedPositions ${phase}: exceeded the ${String(COMPLETE_DEADLINE_MS)}ms complete-traversal deadline`,
      );
    }
  };
  const columns = 'speculation_id, user_address, position_type, risk_amount, profit_amount, claimed, position_created_at, row_updated_at';
  do {
    // Checked BEFORE the read, so the budget bounds reads issued rather than
    // reads completed — a refusal costs nothing.
    if (options.complete && pages >= COMPLETE_MAX_PAGES) {
      throw new PositionEnumerationLimitError(
        'pages',
        `fetchCategorizedPositions positions: exceeded ${String(COMPLETE_MAX_PAGES)} pages without reaching a short page`,
      );
    }
    refuseIfLate('positions');
    let query = sb.from('positions')
      .select(options.complete ? `id, ${columns}` : columns)
      .eq('network', config.network)
      .eq('user_address', lowerAddress)
      .eq('claimed', false)
      .gt('risk_amount', 0);
    if (options.complete) {
      // Immutable id, not mutable row_updated_at or nullable/tied creation
      // timestamps. DESC avoids chasing new inserts at the head. Strict <
      // never skips the older tail when earlier rows become claimed; OFFSET
      // on this shrinking set would. This is a scan, not an atomic snapshot.
      if (beforeId !== undefined) query = query.lt('id', beforeId.toString());
      query = query.order('id', { ascending: false }).limit(COMPLETE_PAGE_SIZE);
    } else {
      query = query.order('position_created_at', { ascending: false, nullsFirst: false })
        .limit(POSITION_QUERY_LIMIT);
    }
    const posRes = await query;
    if (posRes.error) throw new Error(`fetchCategorizedPositions positions: ${posRes.error.message}`);
    if (options.complete && !Array.isArray(posRes.data)) {
      throw new Error('fetchCategorizedPositions positions: missing page data');
    }
    const page = (posRes.data ?? []) as unknown as PositionRow[];
    pages++;
    if (options.complete) {
      if (page.length > COMPLETE_PAGE_SIZE) {
        throw new Error('fetchCategorizedPositions positions: oversized page');
      }
      // Validate EVERY raw row (including short pages and predicted losers),
      // not just the last cursor. A repeated/overlapping/out-of-order page
      // must fail instead of looping forever or advertising completeness.
      for (const row of page) {
        const id = positionIdentity(row);
        if (beforeId !== undefined && id >= beforeId) {
          throw new Error('fetchCategorizedPositions positions: non-advancing keyset page');
        }
        beforeId = id;
      }
    }
    positions.push(...page);
    if (!options.complete || page.length < COMPLETE_PAGE_SIZE) break;
  } while (true);
  const enumeration: PositionEnumeration | undefined = options.complete
    ? { complete: true, pageSize: COMPLETE_PAGE_SIZE, pages, positionCount: positions.length }
    : undefined;
  // Raw-cap signal — `>=` (not `===`) tolerates a future Supabase quirk where
  // PostgREST returns 201 on a `limit(200)`; the predicate here is "did we
  // saturate the cap budget?".
  const hitCap = !options.complete && positions.length >= POSITION_QUERY_LIMIT;
  if (positions.length === 0) {
    return { active: [], pendingSettle: [], claimable: [], settlementCandidates: [], settledLost: [], hitCap, derivedStatuses: [],
      ...(enumeration ? { enumeration } : {}) };
  }

  // Step 2: batch-fetch related speculations.
  // `market_type` is read straight from the column (populated by the
  // indexer) — no scorer-address lookup needed, so this read path
  // doesn't depend on SCORER_*_ADDRESS env config.
  const specIds = [...new Set(positions.map((p) => p.speculation_id))];
  const specById = new Map<number, SpeculationRow>();
  for (let start = 0, size = options.complete ? COMPLETE_PAGE_SIZE : specIds.length; start < specIds.length; start += size) {
    refuseIfLate('speculations');
    let query = sb
      .from('speculations')
      .select('speculation_id, contest_id, market_type, line_ticks, speculation_status, win_side, row_updated_at')
      .eq('network', config.network)
      .in('speculation_id', specIds.slice(start, start + size));
    if (options.complete) query = query.limit(COMPLETE_PAGE_SIZE);
    const specRes = await query;
    if (specRes.error) throw new Error(`fetchCategorizedPositions speculations: ${specRes.error.message}`);
    const specs = (specRes.data ?? []) as unknown as SpeculationRow[];
    for (const s of specs) specById.set(s.speculation_id, s);
  }

  // Step 3: batch-fetch contests for team-name lookup AND contest_status
  // / scores. The pendingSettle bucket needs `contest_status='scored'`
  // plus `away_score`/`home_score` to predict the eventual winSide.
  // Run the query only if there are contest_ids — Supabase /
  // PostgREST builds `contest_id=in.()` from an empty list, which is
  // malformed.
  const contestIds = [
    ...new Set(
      [...specById.values()]
        .map((s) => s.contest_id)
        .filter((id): id is number => id != null),
    ),
  ];
  const contestById = new Map<number, ContestRow>();
  for (let start = 0, size = options.complete ? COMPLETE_PAGE_SIZE : contestIds.length; start < contestIds.length; start += size) {
    refuseIfLate('contests');
    let query = sb
      .from('contests')
      .select('contest_id, away_team, home_team, sport_slug, contest_status, away_score, home_score, row_updated_at')
      .eq('network', config.network)
      .in('contest_id', contestIds.slice(start, start + size));
    if (options.complete) query = query.limit(COMPLETE_PAGE_SIZE);
    const contestRes = await query;
    if (contestRes.error) throw new Error(`fetchCategorizedPositions contests: ${contestRes.error.message}`);
    const contests = (contestRes.data ?? []) as unknown as ContestRow[];
    for (const c of contests) contestById.set(c.contest_id, c);
  }

  // Step 4: categorize + derive in one pass.
  // Categorization (active/pendingSettle/claimable) mirrors the
  // contract's `PositionModule__NoPayout` payout guard.
  // Derivation (derivedStatuses) also runs `derivePositionStatus` from
  // the same join — this guarantees the snapshot's wire body and any
  // own-state hub-cache seed built from the same call can never disagree
  // about derived state, eliminating the cold-start race where a fresh
  // post-snapshot derivation might see a transition the snapshot did
  // not.
  const active: PositionBase[] = [];
  const pendingSettle: PendingSettlePosition[] = [];
  const claimable: ClaimablePosition[] = [];
  const settlementCandidates: PositionBase[] = [];
  const settledLost: SettledLostPosition[] = [];
  const derivedStatuses: DerivedPositionStatus[] = [];

  for (const p of positions) {
    const spec = specById.get(p.speculation_id);
    if (options.complete && !spec) {
      throw new Error(`fetchCategorizedPositions speculations: missing join for ${p.speculation_id}`);
    }
    if (!spec) continue; // shouldn't happen; skip orphans defensively

    const contest = spec.contest_id != null ? contestById.get(spec.contest_id) : undefined;
    if (options.complete && !contest) {
      throw new Error(`fetchCategorizedPositions contests: missing join for ${p.speculation_id}`);
    }
    const positionType = POSITION_TYPE_TO_INT[p.position_type];
    const market: MarketType = spec.market_type ?? 'moneyline';

    // Compute advisory own-state status from the same join, independently
    // of REST bucket membership. Its broader settledLost label also covers
    // open predicted losers and unclassified closed/tbd rows.
    const sourceUpdatedAt = maxIsoTimestamptz(
      p.row_updated_at,
      spec.row_updated_at,
      contest?.row_updated_at,
    );
    const derivedBody = derivePositionStatus(
      {
        speculationId: String(p.speculation_id),
        address: lowerAddress,
        positionType,
        riskAmount: typeof p.risk_amount === 'string' ? p.risk_amount : String(p.risk_amount),
        profitAmount:
          p.profit_amount == null
            ? null
            : typeof p.profit_amount === 'string'
              ? p.profit_amount
              : String(p.profit_amount),
        claimed: p.claimed,
      },
      {
        speculationStatus: spec.speculation_status,
        winSide: spec.win_side,
        marketType: spec.market_type ?? 'moneyline',
        lineTicks: spec.line_ticks,
      },
      contest
        ? {
            contestStatus: contest.contest_status,
            awayScore: contest.away_score,
            homeScore: contest.home_score,
          }
        : null,
      sourceUpdatedAt,
    );
    derivedStatuses.push({
      key: `${String(p.speculation_id)}_${positionType}`,
      status: derivedBody.status,
      sourceUpdatedAt,
      result: derivedBody.result,
      claimableAmount: derivedBody.claimableAmount,
    });

    const team = contest
      ? (positionType === 0 ? contest.away_team : contest.home_team) ?? 'Unknown'
      : 'Unknown';
    const opponent = contest
      ? (positionType === 0 ? contest.home_team : contest.away_team) ?? 'Unknown'
      : 'Unknown';

    const riskWei6 = BigInt(String(p.risk_amount));
    const profitWei6 = p.profit_amount != null ? BigInt(String(p.profit_amount)) : 0n;

    const updatedAtMs = Date.parse(sourceUpdatedAt);
    const base: PositionBase = {
      positionId: `${p.speculation_id}_${lowerAddress}_${positionType}`,
      speculationId: String(p.speculation_id),
      positionType,
      team,
      opponent,
      market,
      oddsDecimal: impliedOddsDecimal(riskWei6, profitWei6),
      riskAmountUSDC: wei6ToUSDC(p.risk_amount),
      profitAmountUSDC: wei6ToUSDC(p.profit_amount),
      contestId: spec.contest_id != null ? String(spec.contest_id) : '',
      sport: contest?.sport_slug ?? '',
      awayTeam: contest?.away_team ?? '',
      homeTeam: contest?.home_team ?? '',
      riskAmountWei6: riskWei6.toString(),
      counterpartyRiskWei6: profitWei6.toString(),
      updatedAtUnixSec: Number.isFinite(updatedAtMs) ? Math.floor(updatedAtMs / 1000) : 0,
    };

    if (spec.speculation_status === 'closed') {
      // Already settled on-chain. Read win_side directly.
      let result: ClaimablePosition['result'];
      let payoutWei6: bigint;
      if (didWin(positionType, spec.win_side)) {
        result = 'won';
        payoutWei6 = riskWei6 + profitWei6;
      } else if (spec.win_side === 'push') {
        result = 'push';
        payoutWei6 = riskWei6;
      } else if (spec.win_side === 'void') {
        result = 'void';
        payoutWei6 = riskWei6;
      } else if (spec.win_side === 'tbd') {
        // closed but win_side not yet set — shouldn't happen, treat as not claimable
        continue;
      } else {
        // Closed loss: contract reverts with NoPayout, but retain terminal
        // identity so raw enumeration can reconcile without inventing work.
        settledLost.push({ ...base, result: 'lost' });
        continue;
      }
      // Match contract: reject only riskAmount==0 || payout==0.
      if (riskWei6 === 0n || payoutWei6 === 0n) continue;
      claimable.push({
        ...base,
        result,
        estimatedPayoutUSDC: wei6ToUSDC(payoutWei6.toString()),
        estimatedPayoutWei6: payoutWei6.toString(),
      });
      continue;
    }

    // speculation_status === 'open'
    if (contest && SETTLEABLE_OPEN_CONTEST_STATUSES.has(contest.contest_status)
        && !p.claimed && riskWei6 > 0n) {
      // Independent of predicted winner OR availability of prediction
      // inputs. A losing controlled side can still finalize the market
      // for its winning counterparty. Do not add losers to payout buckets.
      //
      // A `voided` contest reaches here too, and it is the one case with no
      // winner to predict at all: settlement assigns `void` and refunds both
      // sides their own risk (PositionModule._calculatePayout returns
      // `riskAmount` for Push/Void before it looks at the side, so this is
      // market-type and side independent).
      //
      // The row also stays in `active` below, identical to a `scored` contest
      // whose prediction inputs are missing. That is required, not tidy: a row
      // in NO bucket breaks the MVE consumer's raw-count-equals-bucket-union
      // check and fails that wallet's whole lane, and it would disappear from
      // the own-state snapshot, which builds its positions array from these
      // buckets. Its REFUND is still not carried by a payout bucket — see
      // `docs/positions-complete-enumeration.md` for that bound and why
      // closing it needs a coordinated ospex-sdk release.
      settlementCandidates.push(base);
    }
    if (
      contest &&
      contest.contest_status === 'scored' &&
      contest.away_score != null &&
      contest.home_score != null
    ) {
      const predicted = predictWinSide(
        market,
        contest.away_score,
        contest.home_score,
        spec.line_ticks,
      );
      if (predicted == null) {
        // Inputs missing or inconsistent — fall through to active.
        active.push(base);
        continue;
      }
      let result: PendingSettlePosition['result'];
      let payoutWei6: bigint;
      if (predicted === 'push') {
        result = 'push';
        payoutWei6 = riskWei6;
      } else {
        const isWinner =
          (positionType === 0 && (predicted === 'away' || predicted === 'over')) ||
          (positionType === 1 && (predicted === 'home' || predicted === 'under'));
        if (isWinner) {
          result = 'won';
          payoutWei6 = riskWei6 + profitWei6;
        } else {
          // Predicted loser. Settling won't change that — once
          // `settleSpeculation` runs, `claimPosition` will revert
          // with NoPayout. Skip.
          continue;
        }
      }
      if (riskWei6 === 0n || payoutWei6 === 0n) continue;
      pendingSettle.push({
        ...base,
        result,
        predictedWinSide: predicted,
        estimatedPayoutUSDC: wei6ToUSDC(payoutWei6.toString()),
        estimatedPayoutWei6: payoutWei6.toString(),
      });
      continue;
    }

    // Open speculation with no payout bucket. Three different rows land here and
    // only the first is "nothing to do": a contest still awaiting an outcome; a
    // `scored` one whose prediction inputs are missing; and every `voided` one.
    // The latter two are also settlementCandidates above — `active` is the
    // residual bucket, not a statement that no work exists.
    active.push(base);
  }

  return { active, pendingSettle, claimable, settlementCandidates, settledLost, hitCap, derivedStatuses,
    ...(enumeration ? { enumeration } : {}) };
}

/** Convenience for callers needing the on-chain enum string back from the int. */
export function positionTypeIntToString(positionType: 0 | 1): 'upper' | 'lower' {
  return POSITION_TYPE_FROM_INT[positionType];
}
