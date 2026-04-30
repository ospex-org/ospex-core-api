/**
 * Categorized position fetcher for /v1/positions/:address/{status,claim-params}.
 *
 * Pure Supabase. The agent-server's R3 version of this helper queried
 * Firestore through a clean-looking interface — that pattern is
 * intentionally not portable here (no Firebase deps in the package).
 *
 * R4 deviations vs the agent-server's helper:
 *   - No `withdrawable` bucket. R4 positions are always fully matched
 *     at fill time; there is no `unmatched_amount` column on the
 *     `positions` table and no `adjustUnmatchedPair` contract method.
 *     The R4 analog of "withdraw your unfilled stake" is "cancel your
 *     open commitment" via `MatchingModule.cancelCommitment(...)`,
 *     which is commitment-domain and constructed client-side from
 *     `GET /v1/commitments?maker=…`.
 *   - `oddsPairId` is gone — R4 positions are uniquely keyed by
 *     `(speculationId, user, positionType)`.
 *   - Implied odds are derived from `risk_amount` + `profit_amount`
 *     (the position carries `profit_amount` directly; no need to
 *     reconstruct from upper/lower odds at query time).
 *
 * Categorization:
 *   - active     — speculation_status = 'open',   claimed = false
 *   - claimable  — speculation_status = 'closed', claimed = false,
 *                  estimated payout > 0 (won, push, or void; lost
 *                  positions have payout = 0 and are filtered out
 *                  because `claimPosition` reverts with NoPayout)
 *
 * Hard-coded query cap of 200 unclaimed positions per address. The
 * agent-server used the same cap; preserving the behavior keeps a
 * runaway wallet (or a maker-bot bug) from causing a multi-second
 * Supabase query.
 */

import { getSupabase } from '../../lib/supabase.js';
import { wei6ToUSDC } from '../../lib/sanitize.js';
import type { MarketType } from '../../lib/speculation.js';
import { loadConfig } from '../../lib/env.js';

const POSITION_QUERY_LIMIT = 200;

const POSITION_TYPE_TO_INT: Record<'upper' | 'lower', 0 | 1> = { upper: 0, lower: 1 };
const POSITION_TYPE_FROM_INT: Record<0 | 1, 'upper' | 'lower'> = { 0: 'upper', 1: 'lower' };

export interface PositionBase {
  positionId: string;            // `${speculationId}_${user}_${positionType}` — R4 identity
  speculationId: string;
  positionType: 0 | 1;            // 0 = upper (away/over), 1 = lower (home/under)
  team: string;                   // your side: away if upper, home if lower
  opponent: string;
  market: MarketType;
  oddsDecimal: number | null;     // implied: 1 + (profit_amount / risk_amount)
  riskAmountUSDC: number;
  profitAmountUSDC: number;
}

export interface ClaimablePosition extends PositionBase {
  result: 'won' | 'push' | 'void';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
}

export interface PositionFetchResult {
  active: PositionBase[];
  claimable: ClaimablePosition[];
}

interface PositionRow {
  speculation_id: number;
  user_address: string;
  position_type: 'upper' | 'lower';
  risk_amount: string | number;
  profit_amount: string | number | null;
  claimed: boolean;
  position_created_at: string | null;
}

interface SpeculationRow {
  speculation_id: number;
  contest_id: number | null;
  market_type: MarketType | null;
  speculation_status: 'open' | 'closed';
  win_side: 'tbd' | 'away' | 'home' | 'over' | 'under' | 'push' | 'void';
}

interface ContestRow {
  contest_id: number;
  away_team: string | null;
  home_team: string | null;
}

function impliedOddsDecimal(risk: bigint, profit: bigint | null): number | null {
  if (profit == null || risk === 0n) return null;
  // decimal odds = 1 + profit/risk. Convert via Number — fine for USDC-scale values
  // (uint256 here is bounded by USDC supply, well under 2^53).
  return 1 + Number(profit) / Number(risk);
}

/**
 * Did this position win? Maps win_side string to position_type.
 *   upper (0) wins on win_side ∈ {away, over}
 *   lower (1) wins on win_side ∈ {home, under}
 */
function didWin(positionType: 0 | 1, winSide: SpeculationRow['win_side']): boolean {
  if (positionType === 0) return winSide === 'away' || winSide === 'over';
  return winSide === 'home' || winSide === 'under';
}

export async function fetchCategorizedPositions(
  address: string,
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
  // PositionModule.sol:367-370.)
  const posRes = await sb
    .from('positions')
    .select('speculation_id, user_address, position_type, risk_amount, profit_amount, claimed, position_created_at')
    .eq('network', config.network)
    .eq('user_address', lowerAddress)
    .eq('claimed', false)
    .gt('risk_amount', 0)
    .order('position_created_at', { ascending: false, nullsFirst: false })
    .limit(POSITION_QUERY_LIMIT);

  if (posRes.error) throw new Error(`fetchCategorizedPositions positions: ${posRes.error.message}`);
  const positions = (posRes.data ?? []) as unknown as PositionRow[];
  if (positions.length === 0) return { active: [], claimable: [] };

  // Step 2: batch-fetch related speculations.
  // `market_type` is read straight from the column (populated by the
  // indexer per migration 027) — no scorer-address lookup needed, so
  // this read path doesn't depend on SCORER_*_ADDRESS env config.
  const specIds = [...new Set(positions.map((p) => p.speculation_id))];
  const specById = new Map<number, SpeculationRow>();
  if (specIds.length > 0) {
    const specRes = await sb
      .from('speculations')
      .select('speculation_id, contest_id, market_type, speculation_status, win_side')
      .eq('network', config.network)
      .in('speculation_id', specIds);
    if (specRes.error) throw new Error(`fetchCategorizedPositions speculations: ${specRes.error.message}`);
    const specs = (specRes.data ?? []) as unknown as SpeculationRow[];
    for (const s of specs) specById.set(s.speculation_id, s);
  }

  // Step 3: batch-fetch contests for team-name lookup. Only run the
  // query if there are contest_ids to look up — Supabase / PostgREST
  // builds `contest_id=in.()` from an empty list, which is malformed.
  const contestIds = [
    ...new Set(
      [...specById.values()]
        .map((s) => s.contest_id)
        .filter((id): id is number => id != null),
    ),
  ];
  const contestById = new Map<number, ContestRow>();
  if (contestIds.length > 0) {
    const contestRes = await sb
      .from('contests')
      .select('contest_id, away_team, home_team')
      .eq('network', config.network)
      .in('contest_id', contestIds);
    if (contestRes.error) throw new Error(`fetchCategorizedPositions contests: ${contestRes.error.message}`);
    const contests = (contestRes.data ?? []) as unknown as ContestRow[];
    for (const c of contests) contestById.set(c.contest_id, c);
  }

  // Step 4: categorize.
  // Payout filter mirrors PositionModule.sol:367-370 exactly:
  // `claimPosition` reverts only when `riskAmount == 0 || payout == 0`.
  // We do the comparison in wei6 (bigint) so sub-cent payouts (which
  // ARE claimable on-chain) aren't filtered by USDC-float rounding.
  const active: PositionBase[] = [];
  const claimable: ClaimablePosition[] = [];

  for (const p of positions) {
    const spec = specById.get(p.speculation_id);
    if (!spec) continue; // shouldn't happen; skip orphans defensively

    const contest = spec.contest_id != null ? contestById.get(spec.contest_id) : undefined;
    const positionType = POSITION_TYPE_TO_INT[p.position_type];
    const market: MarketType = spec.market_type ?? 'moneyline';

    const team = contest
      ? (positionType === 0 ? contest.away_team : contest.home_team) ?? 'Unknown'
      : 'Unknown';
    const opponent = contest
      ? (positionType === 0 ? contest.home_team : contest.away_team) ?? 'Unknown'
      : 'Unknown';

    const riskWei6 = BigInt(String(p.risk_amount));
    const profitWei6 = p.profit_amount != null ? BigInt(String(p.profit_amount)) : 0n;

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
    };

    if (spec.speculation_status === 'closed') {
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
        // lost: contract reverts with NoPayout
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
    } else {
      active.push(base);
    }
  }

  return { active, claimable };
}

/** Convenience for callers needing the on-chain enum string back from the int. */
export function positionTypeIntToString(positionType: 0 | 1): 'upper' | 'lower' {
  return POSITION_TYPE_FROM_INT[positionType];
}
