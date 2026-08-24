/**
 * The executed record's I/O: benchmark fill receipts → the immutable on-chain
 * fill EVENT → chain outcome → per-arm summary.
 *
 * Separate from `executed.ts`, which is the pure derivation, for the same
 * reason `standingsProject.ts` is separate from `standings.ts`.
 *
 * ## The join is the EVENT, not the aggregate position
 *
 * The first cut reconstructed each fill from `positions`, keyed
 * `(speculation_id, taker_address)`. That was wrong in four ways, all of the
 * same shape — an immutable receipt reconstructed from a mutable aggregate —
 * and review caught it before any of them could reach a page:
 *
 *  - **`positions` is an AGGREGATE.** Its `risk_amount` is the wallet's total
 *    risk on that speculation, not this fill's. Two receipts against one
 *    position each read the full aggregate, so the stake double-counts.
 *  - **The key is not unique.** `positions` is unique on `(network,
 *    speculation_id, user_address, position_type)`; dropping the side means a
 *    wallet holding both sides resolves to whichever row arrived last, and the
 *    verdict flips with row order. Measured on production 2026-08-24: 54
 *    `(speculation, wallet)` pairs hold both sides — all of them MAKERS today,
 *    so it was latent rather than live, which is exactly the kind of "0 today"
 *    this repo's rules say not to build on.
 *  - **`speculation_id` is a per-deployment-round counter** (073 records the
 *    same hazard for `contest_id`, and the counter reset at R5). `speculations`
 *    carries no round column, so a `(network, speculation_id)` join cannot tell
 *    an R5 fill from an R6 speculation that reused the id.
 *  - The unfiltered `.limit(1000)` on a chunk of 100 speculations could
 *    silently drop the wallet's row: 178 speculations already carry 694
 *    position rows.
 *
 * Joining `position_fills` on `(network, tx_hash)` answers all four at once. A
 * transaction hash is globally unique and immutable, so it cannot be confused
 * across deployment rounds; the event row carries `taker_position_type` (the
 * side, stated rather than inferred), `taker_risk_amount` (THIS fill's stake)
 * and `maker_risk_amount` (this fill's profit if it wins). `positions` is not
 * read at all any more.
 *
 * Measured over the 462 live fills on benchmark speculations: one fill row per
 * `(speculation, taker)`, one row per `tx_hash`, `(tx_hash, log_index)` unique
 * 462/462, and the aggregate `risk_amount` equals the summed event risk
 * 462/462 — so the two agreed today and would have gone on agreeing until they
 * did not.
 *
 * ## Anything ambiguous is REFUSED, not guessed
 *
 * A receipt whose transaction carries fill events for another taker, another
 * speculation, or both position sides is counted in `unresolvedFills` and
 * contributes nothing. A record is a public claim about money; a fill this
 * service cannot identify exactly is one it must not price.
 *
 * ## Today this reads zero rows
 *
 * `benchmark_execution_fills` is empty until Hermes's `publish_serving.py`
 * (work-order Part 3) runs. The downstream reads are skipped entirely when
 * there are no receipts, so the empty case costs one query rather than four,
 * and every arm's `executed` block serves nulls rather than zeroes.
 */

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { BENCHMARK, POSTGREST_PAGE, chunkIds, readAllByKeyset } from './source.js';
import {
  summarizeExecuted,
  type ExecutedContest,
  type ExecutedFill,
  type ExecutedSummary,
} from './executed.js';
import type { MarketType, WinSide } from '../../lib/speculation.js';

interface ReceiptRow {
  cohort_id: string;
  participant_id: string;
  game_id: string;
  market: string;
  contest_id: number | string;
  speculation_id: number | string;
  commitment_hash: string;
  taker_address: string;
  tx_hash: string;
  block_number: number | string;
  filled_at: string;
  stake_usdc: number;
  would_abstain: boolean;
}

interface FillEventRow {
  id: number;
  speculation_id: number | string;
  contest_id: number | string | null;
  commitment_hash: string | null;
  taker_address: string;
  taker_position_type: 'upper' | 'lower';
  taker_risk_amount: string | number | null;
  maker_risk_amount: string | number | null;
  tx_hash: string;
  log_index: number;
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

/** One benchmark fill receipt, joined and ready to render on a pick card. */
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

/**
 * A read bound on the fill-event join. One receipt is one transaction and a
 * transaction carries a handful of events, so this sits far above any real
 * slate and exists so a runaway relation raises rather than walking forever.
 */
const EVENT_READ_CAP = 100_000;

const WEI6 = 1_000_000;

function toBig(v: string | number | null): bigint {
  if (v === null) return 0n;
  try {
    return BigInt(typeof v === 'number' ? Math.trunc(v) : v);
  } catch {
    return 0n;
  }
}

/** Hex is stored lowercase (079 CHECKs it); compare case-insensitively anyway. */
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Read the fill receipts for a set of cohorts and roll them up per participant.
 *
 * @param inScopeGames when supplied, only receipts on these games count — the
 *   sport scope, which the cohort filter alone does not apply.
 */
export async function collectExecuted(
  sb: SupabaseClient,
  network: string,
  cohortIds: readonly string[],
  inScopeGames?: ReadonlySet<string>,
): Promise<ExecutedCollection | { error: PostgrestError; context: string }> {
  const receiptRows: ReceiptRow[] = [];
  for (const chunk of chunkIds(cohortIds, 50)) {
    for (let offset = 0; ; offset += POSTGREST_PAGE) {

      const res = await sb
        .from(BENCHMARK.executionFills)
        .select(
          'cohort_id, participant_id, game_id, market, contest_id, speculation_id, ' +
            'commitment_hash, taker_address, tx_hash, block_number, filled_at, stake_usdc, ' +
            'would_abstain',
        )
        .eq('network', network)
        .in('cohort_id', chunk)
        .order('cohort_id', { ascending: true })
        .order('participant_id', { ascending: true })
        .order('game_id', { ascending: true })
        .order('market', { ascending: true })
        .range(offset, offset + POSTGREST_PAGE - 1);
      if (res.error) return { error: res.error, context: BENCHMARK.executionFills };
      const batch = (res.data ?? []) as unknown as ReceiptRow[];
      receiptRows.push(...batch);
      if (batch.length < POSTGREST_PAGE) break;
    }
  }

  const scoped =
    inScopeGames === undefined ? receiptRows : receiptRows.filter((r) => inScopeGames.has(r.game_id));

  const fills: BenchmarkFill[] = scoped.map((f) => ({
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

  // ── the immutable fill events, by transaction ────────────────────────────
  const txHashes = [...new Set(scoped.map((r) => r.tx_hash))];
  const eventsByTx = new Map<string, FillEventRow[]>();
  for (const chunk of chunkIds(txHashes, 50)) {

    const page = await readAllByKeyset<FillEventRow, number>(
      'position_fills',
      EVENT_READ_CAP,
      (r) => r.id,
      (after, limit) => {
        let q = sb
          .from('position_fills')
          .select(
            'id, speculation_id, contest_id, commitment_hash, taker_address, ' +
              'taker_position_type, taker_risk_amount, maker_risk_amount, tx_hash, log_index',
          )
          .eq('network', network)
          .in('tx_hash', chunk)
          .order('id', { ascending: true })
          .limit(limit);
        if (after !== null) q = q.gt('id', after);
        return q as unknown as PromiseLike<{
          data: FillEventRow[] | null;
          error: PostgrestError | null;
        }>;
      },
    );
    if (page.error) return { error: page.error, context: 'position_fills' };
    for (const row of page.rows) {
      const list = eventsByTx.get(row.tx_hash);
      if (list === undefined) eventsByTx.set(row.tx_hash, [row]);
      else list.push(row);
    }
  }

  // ── the outcome, keyed off the EVENT's speculation ───────────────────────
  const specIds = [
    ...new Set([...eventsByTx.values()].flat().map((e) => String(e.speculation_id))),
  ];
  const specs = new Map<string, SpecRow>();
  for (const chunk of chunkIds(specIds, 100)) {

    const res = await sb
      .from('speculations')
      .select('speculation_id, contest_id, market_type, line_ticks, speculation_status, win_side')
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

  // ── resolve each receipt to exactly one priced position, or refuse it ────
  const byArm = new Map<string, ExecutedFill[]>();
  const unresolvedByArm = new Map<string, number>();
  const refuse = (participantId: string): void => {
    unresolvedByArm.set(participantId, (unresolvedByArm.get(participantId) ?? 0) + 1);
  };

  for (const receipt of scoped) {
    const events = eventsByTx.get(receipt.tx_hash) ?? [];
    // Every guard below refuses rather than guesses. A receipt the indexer has
    // not caught up to simply reappears on the next read; one whose transaction
    // does not match it is a real disagreement an operator should see.
    if (events.length === 0) {
      refuse(receipt.participant_id);
      continue;
    }
    const mine = events.filter(
      (e) =>
        sameAddress(e.taker_address, receipt.taker_address) &&
        String(e.speculation_id) === String(receipt.speculation_id),
    );
    if (mine.length === 0 || mine.length !== events.length) {
      // Either nothing in the transaction is ours, or the transaction also
      // carries someone else's fill — in which case summing it would price
      // this arm's record with another wallet's stake.
      refuse(receipt.participant_id);
      continue;
    }
    const sides = new Set(mine.map((e) => e.taker_position_type));
    if (sides.size !== 1) {
      refuse(receipt.participant_id);
      continue;
    }
    const spec = specs.get(String(mine[0]?.speculation_id));
    if (spec === undefined || spec.market_type === null) {
      refuse(receipt.participant_id);
      continue;
    }

    const riskWei6 = mine.reduce((n, e) => n + toBig(e.taker_risk_amount), 0n);
    const profitWei6 = mine.reduce((n, e) => n + toBig(e.maker_risk_amount), 0n);
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
        positionType: mine[0]?.taker_position_type === 'upper' ? 0 : 1,
        riskWei6,
        profitWei6,
        // The receipt's own stake, from the operator's executor, against the
        // indexer's projection of the same event. Two producers, one quantity —
        // a genuine second witness rather than the same number read twice.
        // `numeric(18,6)` decimal USDC on the receipt; wei6 on the chain side.
        receiptStakeWei6: BigInt(Math.round(Number(receipt.stake_usdc) * WEI6)),
      },
      speculation: {
        speculationStatus: spec.speculation_status,
        winSide: spec.win_side,
        marketType: spec.market_type,
        lineTicks: spec.line_ticks,
      },
      contest,
    };
    const list = byArm.get(receipt.participant_id);
    if (list === undefined) byArm.set(receipt.participant_id, [entry]);
    else list.push(entry);
  }

  const byParticipant = new Map<string, ExecutedSummary>();
  for (const participantId of new Set([...byArm.keys(), ...unresolvedByArm.keys()])) {
    byParticipant.set(
      participantId,
      summarizeExecuted(byArm.get(participantId) ?? [], unresolvedByArm.get(participantId) ?? 0),
    );
  }

  return { fills, byParticipant };
}
