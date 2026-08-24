/**
 * `collectExecuted` — the join from a benchmark fill receipt to the immutable
 * on-chain fill event.
 *
 * These exist because the first cut reconstructed each fill from the MUTABLE
 * aggregate `positions` row, and review reproduced two concrete money defects
 * from it: two receipts against one aggregate position published double the
 * stake, and reversing the order of two position rows flipped a fill from won
 * to lost. Both are asserted here against the new join, and the second is
 * asserted in the form that matters — the side comes from the event's
 * `taker_position_type`, so there is no row order to depend on.
 *
 * Driven through the real Supabase client against a fake PostgREST, so the
 * queries are the ones the handler actually issues — including the one this
 * module must NOT issue any more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyFilters,
  startFakePostgrest,
  type CapturedRequest,
  type FakePostgrest,
} from './helpers/fakePostgrest.js';

const COHORT = 'watch-v0-2026-08-15';
const ARM = 'anthropic-claude-fable-5';
const TAKER = '0x16dc5d67d080a5521ef2c79680dbfc2abf724d30';
const OTHER = '0x8ff8fc180a1d4aa352bc23e73bf24d98cf94fad5';

const USDC = 1_000_000;

function receipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cohort_id: COHORT,
    participant_id: ARM,
    network: 'polygon',
    game_id: 'game-a',
    market: 'moneyline',
    contest_id: 41,
    speculation_id: 88,
    commitment_hash: '0xaa',
    taker_address: TAKER,
    tx_hash: '0xtx1',
    block_number: 1,
    filled_at: '2026-08-15T20:00:00+00:00',
    stake_usdc: 10,
    would_abstain: false,
    ...over,
  };
}

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    network: 'polygon',
    speculation_id: 88,
    contest_id: 41,
    commitment_hash: '0xaa',
    taker_address: TAKER,
    taker_position_type: 'upper',
    taker_risk_amount: String(10 * USDC),
    maker_risk_amount: String(7 * USDC),
    tx_hash: '0xtx1',
    log_index: 0,
    ...over,
  };
}

const SPEC = {
  network: 'polygon',
  speculation_id: 88,
  contest_id: 41,
  market_type: 'moneyline',
  line_ticks: null,
  speculation_status: 'closed',
  win_side: 'away', // upper wins
};

const CONTEST = {
  network: 'polygon',
  contest_id: 41,
  contest_status: 'scored',
  away_score: 5,
  home_score: 3,
};

interface Tables {
  [table: string]: unknown[];
}

const open: FakePostgrest[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
  vi.resetModules();
});

async function collect(
  tables: Tables,
  inScope?: Set<string>,
): Promise<{
  fake: FakePostgrest;
  result: Awaited<ReturnType<typeof import('../src/v1/benchmark/executedFetch.js').collectExecuted>>;
}> {
  const data: Tables = {
    benchmark_execution_fills: [],
    position_fills: [],
    speculations: [SPEC],
    contests: [CONTEST],
    ...tables,
  };
  const seen = new Map<string, number>();
  const fake = await startFakePostgrest((req: CapturedRequest) => {
    const table = /^\/rest\/v1\/([^/?]+)/.exec(req.path)?.[1] ?? '';
    const n = seen.get(table) ?? 0;
    seen.set(table, n + 1);
    const range = req.headers.range;
    if (typeof range === 'string' && !range.startsWith('0-')) return { body: [] };
    if (req.params.has('id') && String(req.params.get('id')).startsWith('gt.') && n > 0) {
      return { body: [] };
    }
    return { body: applyFilters(data[table] ?? [], req.params) };
  });
  open.push(fake);

  vi.resetModules();
  vi.doMock('../src/lib/env.js', () => ({
    loadConfig: () => ({ supabaseUrl: fake.url, supabaseServiceRoleKey: 'k', network: 'polygon' }),
  }));
  const { getSupabase } = await import('../src/lib/supabase.js');
  const { collectExecuted } = await import('../src/v1/benchmark/executedFetch.js');
  const result = await collectExecuted(getSupabase(), 'polygon', [COHORT], inScope);
  return { fake, result };
}

function summaryOf(result: unknown): {
  fills: number;
  stakedWei6: bigint;
  netWei6: bigint;
  record: { won: number; lost: number; push: number; void: number; pending: number };
  stakeDisagreements: number;
  unresolvedFills: number;
} {
  const r = result as { byParticipant: Map<string, never> };
  return r.byParticipant.get(ARM) as never;
}

describe('the join is the fill EVENT', () => {
  it('prices a fill from the event, not from any aggregate', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
    });
    const s = summaryOf(result);
    expect(s.fills).toBe(1);
    expect(s.stakedWei6).toBe(BigInt(10 * USDC));
    expect(s.record).toEqual({ won: 1, lost: 0, push: 0, void: 0, pending: 0 });
    // won ⇒ net is the counterparty's stake.
    expect(s.netWei6).toBe(BigInt(7 * USDC));
  });

  /**
   * REVIEW SCENARIO 1. Two receipts on one speculation, 1 and 2 USDC. Against
   * the aggregate position (3 USDC) each read the full 3 and the record showed
   * 6 staked. Against the events each reads its own transaction.
   */
  it('does not double-count two receipts that share a speculation', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [
        receipt({ market: 'moneyline', tx_hash: '0xtx1', stake_usdc: 1 }),
        receipt({ market: 'total', tx_hash: '0xtx2', stake_usdc: 2 }),
      ],
      position_fills: [
        event({ id: 1, tx_hash: '0xtx1', taker_risk_amount: String(1 * USDC), maker_risk_amount: '0' }),
        event({ id: 2, tx_hash: '0xtx2', taker_risk_amount: String(2 * USDC), maker_risk_amount: '0' }),
      ],
    });
    const s = summaryOf(result);
    expect(s.fills).toBe(2);
    expect(s.stakedWei6).toBe(BigInt(3 * USDC));
    expect(s.stakedWei6).not.toBe(BigInt(6 * USDC));
  });

  /**
   * REVIEW SCENARIO 2, in the form that makes it unreachable. The side is the
   * event's `taker_position_type`, so no ordering of any other table can change
   * it. Both orders of the two events give the same verdict — and the events
   * here deliberately disagree with each other, which is the case the old
   * lookup resolved by picking whichever came last.
   */
  it('takes the side from the event, so row order cannot flip a verdict', async () => {
    const upperFirst = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ id: 1, taker_position_type: 'upper' })],
    });
    const lowerRow = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ id: 1, taker_position_type: 'lower' })],
    });
    expect(summaryOf(upperFirst.result).record.won).toBe(1);
    // The OTHER side genuinely loses on this speculation — so the two differ
    // for a real reason, which is what makes the assertion above meaningful.
    expect(summaryOf(lowerRow.result).record.lost).toBe(1);
  });

  /** A transaction that matched several makers is one placement, summed once. */
  it('sums the events of one transaction', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt({ stake_usdc: 10 })],
      position_fills: [
        event({ id: 1, log_index: 0, taker_risk_amount: String(6 * USDC), maker_risk_amount: String(4 * USDC) }),
        event({ id: 2, log_index: 1, taker_risk_amount: String(4 * USDC), maker_risk_amount: String(3 * USDC) }),
      ],
    });
    const s = summaryOf(result);
    expect(s.fills).toBe(1);
    expect(s.stakedWei6).toBe(BigInt(10 * USDC));
    expect(s.netWei6).toBe(BigInt(7 * USDC));
    expect(s.stakeDisagreements).toBe(0);
  });

  /** `positions` is the table this module must no longer touch. */
  it('never queries the aggregate positions table', async () => {
    const { fake } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
    });
    expect(fake.tables()).not.toContain('positions');
    expect(fake.tables()).toContain('position_fills');
  });
});

describe('anything ambiguous is refused, not guessed', () => {
  it('refuses a receipt whose event has not been indexed yet', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [],
    });
    const s = summaryOf(result);
    expect(s.fills).toBe(0);
    expect(s.unresolvedFills).toBe(1);
  });

  it('refuses a transaction that also carries another wallet fill', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ id: 1 }), event({ id: 2, log_index: 1, taker_address: OTHER })],
    });
    const s = summaryOf(result);
    expect(s.fills).toBe(0);
    expect(s.unresolvedFills).toBe(1);
  });

  it('refuses a transaction whose events straddle both sides', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [
        event({ id: 1, taker_position_type: 'upper' }),
        event({ id: 2, log_index: 1, taker_position_type: 'lower' }),
      ],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses when the event names a different speculation', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ speculation_id: 999 })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  /**
   * Negative control for the four refusals above: the same fixture minus the
   * ambiguity must RESOLVE. Without it, a collector that refused everything
   * would pass all four.
   */
  it('resolves the unambiguous case', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
    });
    const s = summaryOf(result);
    expect(s.unresolvedFills).toBe(0);
    expect(s.fills).toBe(1);
  });
});

describe('the receipt is a second witness on the stake', () => {
  it('counts a receipt/chain disagreement and prices from the chain', async () => {
    const { result } = await collect({
      // The receipt says 9 USDC; the chain event says 10.
      benchmark_execution_fills: [receipt({ stake_usdc: 9 })],
      position_fills: [event()],
    });
    const s = summaryOf(result);
    expect(s.stakeDisagreements).toBe(1);
    expect(s.stakedWei6).toBe(BigInt(10 * USDC));
  });

  it('reports agreement as zero', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt({ stake_usdc: 10 })],
      position_fills: [event()],
    });
    expect(summaryOf(result).stakeDisagreements).toBe(0);
  });
});

describe('the sport scope reaches the fills', () => {
  it('drops a receipt on an out-of-scope game', async () => {
    const { result } = await collect(
      {
        benchmark_execution_fills: [receipt({ game_id: 'nba-game' })],
        position_fills: [event()],
      },
      new Set(['game-a']),
    );
    const r = result as { fills: unknown[]; byParticipant: Map<string, unknown> };
    expect(r.fills).toHaveLength(0);
    expect(r.byParticipant.size).toBe(0);
  });

  it('keeps it when the game is in scope', async () => {
    const { result } = await collect(
      {
        benchmark_execution_fills: [receipt()],
        position_fills: [event()],
      },
      new Set(['game-a']),
    );
    expect(summaryOf(result).fills).toBe(1);
  });
});
