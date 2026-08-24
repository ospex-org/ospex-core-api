/**
 * The executed record's I/O: benchmark fills → chain outcome → per-arm summary.
 *
 * Separate from `executed.ts`, which is the pure derivation, for the same
 * reason `standingsProject.ts` is separate from `standings.ts`.
 *
 * ## Scope is the FILL ROWS, never the wallet
 *
 * A benchmark taker wallet also holds positions that have nothing to do with a
 * benchmark pick. Measured against production 2026-08-24: the four taker
 * wallets hold 102 / 98 / 96 / 92 polygon positions but only 76 / 72 / 70 / 66
 * on speculations belonging to benchmark games — scoping by wallet over-counts
 * by 37% and would credit an arm with a trade it never made. So the scope is
 * `benchmark_execution_fills`, which names the decision the fill answers.
 *
 * ## Today this reads zero rows, and that is the honest state
 *
 * `benchmark_execution_fills` is empty until Hermes's `publish_serving.py`
 * (work-order Part 3) runs. The three downstream reads are skipped entirely
 * when there are no fills, so the empty case costs one query rather than four,
 * and every arm's `executed` block serves nulls rather than zeroes — `0` would
 * assert a measured break-even.
 */

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { BENCHMARK, POSTGREST_PAGE, chunkIds } from './source.js';
import {
  summarizeExecuted,
  type ExecutedContest,
  type ExecutedFill,
  type ExecutedSummary,
} from './executed.js';
import type { MarketType, WinSide } from '../../lib/speculation.js';

interface FillRow {
  cohort_id: string;
  participant_id: string;
  game_id: string;
  market: string;
  contest_id: number | string;
  speculation_id: number | string;
  taker_address: string;
  tx_hash: string;
  block_number: number | string;
  filled_at: string;
  stake_usdc: number;
  would_abstain: boolean;
}

interface SpecRow {
  speculation_id: number | string;
  contest_id: number | string | null;
  market_type: MarketType | null;
  line_ticks: number | null;
  speculation_status: 'open' | 'closed';
  win_side: WinSide;
}

interface ContestRow {
  contest_id: number | string;
  contest_status: 'unverified' | 'verified' | 'scored' | 'voided';
  away_score: number | null;
  home_score: number | null;
}

interface PositionRow {
  speculation_id: number | string;
  user_address: string;
  position_type: 'upper' | 'lower';
  risk_amount: string | number | null;
  profit_amount: string | number | null;
  claimed: boolean;
  claimed_amount: string | number | null;
}

/** One fill, joined and ready to render. */
export interface BenchmarkFill {
  cohortId: string;
  participantId: string;
  gameId: string;
  market: string;
  contestId: string;
  speculationId: string;
  takerAddress: string;
  txHash: string;
  blockNumber: string;
  filledAt: string;
  stakeUsdc: number;
  wouldAbstain: boolean;
}

export interface ExecutedCollection {
  fills: BenchmarkFill[];
  byParticipant: Map<string, ExecutedSummary>;
}

const KEY = (specId: string, address: string): string => `${specId} ${address.toLowerCase()}`;

function toBig(v: string | number | null): bigint {
  if (v === null) return 0n;
  try {
    return BigInt(typeof v === 'number' ? Math.trunc(v) : v);
  } catch {
    return 0n;
  }
}

/**
 * Read the fills for a set of cohorts and roll them up per participant.
 *
 * Offset paging rather than keyset: `benchmark_execution_fills` has no
 * surrogate key (its natural key is five columns, deliberately — migration 079
 * wanted no sequence to revoke), and it is bounded to at most one row per
 * executed pick, so a cohort-day tops out around 8 per game.
 */
export async function collectExecuted(
  sb: SupabaseClient,
  network: string,
  cohortIds: readonly string[],
): Promise<ExecutedCollection | { error: PostgrestError; context: string }> {
  const fillRows: FillRow[] = [];
  for (const chunk of chunkIds(cohortIds, 50)) {
    for (let offset = 0; ; offset += POSTGREST_PAGE) {
       
      const res = await sb
        .from(BENCHMARK.executionFills)
        .select(
          'cohort_id, participant_id, game_id, market, contest_id, speculation_id, ' +
            'taker_address, tx_hash, block_number, filled_at, stake_usdc, would_abstain',
        )
        .eq('network', network)
        .in('cohort_id', chunk)
        .order('cohort_id', { ascending: true })
        .order('participant_id', { ascending: true })
        .order('game_id', { ascending: true })
        .order('market', { ascending: true })
        .range(offset, offset + POSTGREST_PAGE - 1);
      if (res.error) return { error: res.error, context: BENCHMARK.executionFills };
      const batch = (res.data ?? []) as unknown as FillRow[];
      fillRows.push(...batch);
      if (batch.length < POSTGREST_PAGE) break;
    }
  }

  const fills: BenchmarkFill[] = fillRows.map((f) => ({
    cohortId: f.cohort_id,
    participantId: f.participant_id,
    gameId: f.game_id,
    market: f.market,
    contestId: String(f.contest_id),
    speculationId: String(f.speculation_id),
    takerAddress: f.taker_address,
    txHash: f.tx_hash,
    blockNumber: String(f.block_number),
    filledAt: f.filled_at,
    stakeUsdc: Number(f.stake_usdc),
    wouldAbstain: f.would_abstain,
  }));

  if (fills.length === 0) return { fills, byParticipant: new Map() };

  const specIds = [...new Set(fills.map((f) => f.speculationId))];
  const specs = new Map<string, SpecRow>();
  for (const chunk of chunkIds(specIds, 100)) {
     
    const res = await sb
      .from('speculations')
      .select(
        'speculation_id, contest_id, market_type, line_ticks, speculation_status, win_side',
      )
      .eq('network', network)
      .in('speculation_id', chunk)
      .limit(POSTGREST_PAGE);
    if (res.error) return { error: res.error, context: 'speculations' };
    for (const row of (res.data ?? []) as unknown as SpecRow[]) {
      specs.set(String(row.speculation_id), row);
    }
  }

  const contestIds = [
    ...new Set(
      [...specs.values()]
        .map((s) => (s.contest_id === null ? null : String(s.contest_id)))
        .filter((v): v is string => v !== null),
    ),
  ];
  const contests = new Map<string, ContestRow>();
  for (const chunk of chunkIds(contestIds, 100)) {
     
    const res = await sb
      .from('contests')
      .select('contest_id, contest_status, away_score, home_score')
      .eq('network', network)
      .in('contest_id', chunk)
      .limit(POSTGREST_PAGE);
    if (res.error) return { error: res.error, context: 'contests' };
    for (const row of (res.data ?? []) as unknown as ContestRow[]) {
      contests.set(String(row.contest_id), row);
    }
  }

  const positions = new Map<string, PositionRow>();
  for (const chunk of chunkIds(specIds, 100)) {
     
    const res = await sb
      .from('positions')
      .select(
        'speculation_id, user_address, position_type, risk_amount, profit_amount, ' +
          'claimed, claimed_amount',
      )
      .eq('network', network)
      .in('speculation_id', chunk)
      .limit(POSTGREST_PAGE);
    if (res.error) return { error: res.error, context: 'positions' };
    for (const row of (res.data ?? []) as unknown as PositionRow[]) {
      positions.set(KEY(String(row.speculation_id), row.user_address), row);
    }
  }

  const byArm = new Map<string, ExecutedFill[]>();
  for (const fill of fills) {
    const spec = specs.get(fill.speculationId);
    const position = positions.get(KEY(fill.speculationId, fill.takerAddress));
    // A fill whose speculation or position the indexer has not caught up to is
    // SKIPPED, not counted as pending: counting it would put a stake into the
    // record that this service cannot verify happened, and the fill row alone
    // does not carry the position side. It reappears on the next read.
    if (spec === undefined || position === undefined || spec.market_type === null) continue;
    const contestRow = spec.contest_id === null ? undefined : contests.get(String(spec.contest_id));
    const contest: ExecutedContest | null =
      contestRow === undefined
        ? null
        : {
            contestStatus: contestRow.contest_status,
            awayScore: contestRow.away_score,
            homeScore: contestRow.home_score,
          };
    const entry: ExecutedFill = {
      position: {
        positionType: position.position_type === 'upper' ? 0 : 1,
        riskWei6: toBig(position.risk_amount),
        profitWei6: toBig(position.profit_amount),
        claimed: position.claimed,
        claimedAmountWei6: position.claimed_amount === null ? null : toBig(position.claimed_amount),
      },
      speculation: {
        speculationStatus: spec.speculation_status,
        winSide: spec.win_side,
        marketType: spec.market_type,
        lineTicks: spec.line_ticks,
      },
      contest,
    };
    const list = byArm.get(fill.participantId);
    if (list === undefined) byArm.set(fill.participantId, [entry]);
    else list.push(entry);
  }

  const byParticipant = new Map<string, ExecutedSummary>();
  for (const [participantId, entries] of byArm) {
    byParticipant.set(participantId, summarizeExecuted(entries));
  }

  return { fills, byParticipant };
}
