/**
 * `collectExecuted` — the join from a benchmark fill receipt to the immutable
 * on-chain fill event, and from the event to the outcome as the fill's OWN
 * deployment recorded it.
 *
 * These exist because the first cut reconstructed each fill from the MUTABLE
 * aggregate `positions` row, and review reproduced two concrete money defects
 * from it: two receipts against one aggregate position published double the
 * stake, and reversing the order of two position rows flipped a fill from won
 * to lost. Both are asserted here against the new join, and the second is
 * asserted in the form that matters — the side comes from the event's
 * `taker_position_type`, so there is no row order to depend on.
 *
 * Review then twice reproduced a fill priced against the WRONG outcome row: a
 * reused speculation id after a redeploy, and — once creation-block ordering
 * was added — a reused id created in the same block as the old fill. The
 * "deployment identity" block below pins the design that closed both: the
 * outcome is read from `chain_events` under the emitter that emitted the
 * fill, never from the counter-keyed projections.
 *
 * Driven through the real Supabase client against a fake PostgREST, so the
 * queries are the ones the handler actually issues — including the ones this
 * module must NOT issue any more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import {
  applyFilters,
  startFakePostgrest,
  type CapturedRequest,
  type FakePostgrest,
  type FakeReply,
} from './helpers/fakePostgrest.js';

const COHORT = 'watch-v0-2026-08-15';
const RUN = 'watch-v0-2026-08-15-0b0658';
const ARM = 'anthropic-claude-fable-5';
const TAKER = '0x16dc5d67d080a5521ef2c79680dbfc2abf724d30';
const OTHER = '0x8ff8fc180a1d4aa352bc23e73bf24d98cf94fad5';
const GAME = 'game-a';

/** The R5 Core, the emitter of every production log row measured 2026-08-24. */
const CORE = '0x40047bafcded16c938058b7b67186299a2893561';
/** A later deployment's Core — the reviewer's reused-counter scenario. */
const OTHER_CORE = '0x1111111111111111111111111111111111111111';

const SCORERS = {
  moneyline: '0x59555106d4b5f1a797f3552f60ac418eb6b6f6bd',
  spread: '0xb4b1e2a2a75c34e9e4c5d3bb8a432aff973dada0',
  total: '0x2222222222222222222222222222222222222222',
};

const USDC = 1_000_000;
const FILL_BLOCK = 100;

function receipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cohort_id: COHORT,
    participant_id: ARM,
    network: 'polygon',
    game_id: GAME,
    market: 'moneyline',
    run_id: RUN,
    deployment_round: 'R5',
    contest_id: 41,
    speculation_id: 88,
    commitment_hash: '0xaa',
    taker_address: TAKER,
    tx_hash: '0xtx1',
    block_number: FILL_BLOCK,
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

let logId = 1000;
/** A `chain_events` row. Payload values are strings, addresses checksummed, as the indexer writes them. */
function log(
  eventName: string,
  entityType: string,
  entityId: number,
  payload: Record<string, string>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  logId += 1;
  return {
    id: logId,
    network: 'polygon',
    event_name: eventName,
    entity_type: entityType,
    entity_id: entityId,
    emitter_address: CORE,
    block_number: FILL_BLOCK,
    tx_hash: '0xtx1',
    log_index: 0,
    payload: { raw: '0x', ...payload },
    ...over,
  };
}

/** The fill's own COMMITMENT_MATCHED log row — the deployment mark. */
const matched = (over: Record<string, unknown> = {}, payload: Record<string, string> = {}): Record<string, unknown> =>
  log(
    'COMMITMENT_MATCHED',
    'fill',
    88,
    {
      speculationId: '88',
      contestId: '41',
      taker: '0x16Dc5D67D080a5521ef2c79680dBfC2aBf724D30',
      commitmentHash: '0xAA',
      scorer: SCORERS.moneyline,
      lineTicks: '0',
      ...payload,
    },
    over,
  );
const created = (over: Record<string, unknown> = {}, payload: Record<string, string> = {}): Record<string, unknown> =>
  log(
    'SPECULATION_CREATED',
    'speculation',
    88,
    { speculationId: '88', contestId: '41', scorer: SCORERS.moneyline, lineTicks: '0', ...payload },
    { block_number: 90, tx_hash: '0xcreate', ...over },
  );
const settled = (winSideValue = '1', over: Record<string, unknown> = {}): Record<string, unknown> =>
  log(
    'SPECULATION_SETTLED',
    'speculation',
    88,
    { speculationId: '88', winSideValue, scorer: SCORERS.moneyline },
    { block_number: 200, tx_hash: '0xsettle', ...over },
  );
const contestCreated = (over: Record<string, unknown> = {}, payload: Record<string, string> = {}): Record<string, unknown> =>
  log(
    'CONTEST_CREATED',
    'contest',
    41,
    { contestId: '41', jsonoddsId: GAME, ...payload },
    { block_number: 80, tx_hash: '0xcontest', ...over },
  );
const scoresSet = (away = '5', home = '3', over: Record<string, unknown> = {}): Record<string, unknown> =>
  log(
    'CONTEST_SCORES_SET',
    'contest',
    41,
    { contestId: '41', awayScore: away, homeScore: home },
    { block_number: 190, tx_hash: '0xscore', ...over },
  );
const voided = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  log('CONTEST_VOIDED', 'contest', 41, { contestId: '41' }, { block_number: 190, tx_hash: '0xvoid', ...over });

/** The default history: created, matched, contest created and scored, speculation settled `away` (upper wins). */
const HISTORY = (): Record<string, unknown>[] => [matched(), created(), settled('1'), contestCreated(), scoresSet()];

interface Tables {
  [table: string]: unknown[];
}

const open: FakePostgrest[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
  vi.resetModules();
});

/**
 * A responder that behaves like PostgREST for the subset these tests use:
 * top-level filters applied, `order` honoured on the ONE column the keyset
 * walks sort by, and `limit`/`offset` honoured — the last two are what make a
 * paging test mean anything. `applyFilters` deliberately does not page, so a
 * fixture larger than one page would come back whole and every walk would
 * terminate on its first request.
 */
function pageLike(rows: readonly unknown[], req: CapturedRequest): unknown[] {
  const filtered = applyFilters(rows, req.params) as Array<Record<string, unknown>>;
  const order = req.params.get('order');
  if (order !== null) {
    const [col, dir] = order.split('.') as [string, string | undefined];
    filtered.sort((a, b) => {
      const x = a[col];
      const y = b[col];
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x).localeCompare(String(y));
    });
    if (dir === 'desc') filtered.reverse();
  }
  const offset = Number(req.params.get('offset') ?? '0');
  const limit = req.params.has('limit') ? Number(req.params.get('limit')) : filtered.length;
  return filtered.slice(offset, offset + limit);
}

async function collect(
  tables: Tables,
  inScope?: Set<string>,
  override?: (req: CapturedRequest, index: number) => FakeReply | undefined,
  // `null`, NOT `undefined`, means "scorers not configured": a default
  // parameter is applied when the argument is `undefined`, so passing
  // `undefined` here would silently run the case WITH scorers — the
  // `??`-collapses-the-null-case trap, one type over. It happened.
  scorers: typeof SCORERS | null = SCORERS,
): Promise<{
  fake: FakePostgrest;
  result: Awaited<ReturnType<typeof import('../src/v1/benchmark/executedFetch.js').collectExecuted>>;
}> {
  const data: Tables = {
    benchmark_execution_fills: [],
    position_fills: [],
    chain_events: HISTORY(),
    recovery_runs: [],
    ...tables,
  };
  const fake = await startFakePostgrest((req: CapturedRequest, index: number) => {
    const forced = override?.(req, index);
    if (forced !== undefined) return forced;
    const table = /^\/rest\/v1\/([^/?]+)/.exec(req.path)?.[1] ?? '';
    return { body: pageLike(data[table] ?? [], req) };
  });
  open.push(fake);

  vi.resetModules();
  vi.doMock('../src/lib/env.js', () => ({
    loadConfig: () => ({ supabaseUrl: fake.url, supabaseServiceRoleKey: 'k', network: 'polygon' }),
  }));
  const { getSupabase } = await import('../src/lib/supabase.js');
  const { collectExecuted } = await import('../src/v1/benchmark/executedFetch.js');
  const result = await collectExecuted(
    getSupabase(),
    'polygon',
    [COHORT],
    scorers === null ? undefined : scorers,
    inScope,
  );
  return { fake, result };
}

interface Summary {
  fills: number;
  stakedWei6: bigint;
  netWei6: bigint;
  pendingStakeWei6: bigint;
  record: { won: number; lost: number; push: number; void: number; pending: number };
  verdictSource: { settled: number; predicted: number; undecided: number };
  stakeDisagreements: number;
  unresolvedFills: number;
}

function summaryOf(result: unknown): Summary {
  const r = result as { byParticipant: Map<string, Summary> };
  return r.byParticipant.get(ARM) as Summary;
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
    expect(s.verdictSource).toEqual({ settled: 1, predicted: 0, undecided: 0 });
  });

  /**
   * REVIEW SCENARIO 1. Two receipts on one speculation, 1 and 2 USDC. Against
   * the aggregate position (3 USDC) each read the full 3 and the record showed
   * 6 staked. Against the events each reads its own transaction.
   */
  it('does not double-count two receipts that share a speculation', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [
        receipt({ tx_hash: '0xtx1', stake_usdc: 1 }),
        receipt({ tx_hash: '0xtx2', stake_usdc: 2, block_number: 101 }),
      ],
      position_fills: [
        event({ id: 1, tx_hash: '0xtx1', taker_risk_amount: String(1 * USDC), maker_risk_amount: '0' }),
        event({ id: 2, tx_hash: '0xtx2', taker_risk_amount: String(2 * USDC), maker_risk_amount: '0' }),
      ],
      chain_events: [...HISTORY(), matched({ tx_hash: '0xtx2', block_number: 101 })],
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
      chain_events: [...HISTORY(), matched({ log_index: 1 })],
    });
    const s = summaryOf(result);
    expect(s.fills).toBe(1);
    expect(s.stakedWei6).toBe(BigInt(10 * USDC));
    expect(s.netWei6).toBe(BigInt(7 * USDC));
    expect(s.stakeDisagreements).toBe(0);
  });

  /** The counter-keyed projections are the tables this module must not consult. */
  it('never queries positions, speculations or contests', async () => {
    const { fake } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
    });
    expect(fake.tables()).not.toContain('positions');
    expect(fake.tables()).not.toContain('speculations');
    expect(fake.tables()).not.toContain('contests');
    expect(fake.tables()).toContain('position_fills');
    expect(fake.tables()).toContain('chain_events');
  });

  /** The round and run the receipt cites travel with the fill, as provenance. */
  it('carries the receipt deployment round and run id on the fill', async () => {
    const { result, fake } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
    });
    const fills = (result as { fills: Array<{ deploymentRound: string; runId: string }> }).fills;
    expect(fills[0]?.deploymentRound).toBe('R5');
    expect(fills[0]?.runId).toBe(RUN);
    const select = decodeURIComponent(
      fake.requests.find((r) => r.path === '/rest/v1/benchmark_execution_fills')?.params.get('select') ?? '',
    );
    expect(select).toContain('deployment_round');
    expect(select).toContain('run_id');
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
      chain_events: [...HISTORY(), matched({ log_index: 1 })],
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

  it('refuses when the event cites a different contest than the receipt', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ contest_id: 42 })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses when the event cites a different commitment than the receipt', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ commitment_hash: '0xbb' })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  /**
   * Negative control for the refusals above: the same fixture minus the
   * ambiguity must RESOLVE. Without it, a collector that refused everything
   * would pass all of them.
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

/**
 * REVIEW ROUND 2, B3 — twice. A transaction hash proves which fill happened;
 * it does not prove that a counter-keyed row read today is the speculation the
 * fill was on. The outcome is therefore read from the raw log under the
 * emitter that emitted the fill, and each case below breaks ONE link of that
 * chain while leaving every other link intact, so a build that skipped that
 * link — and only that link — would price the fill.
 */
describe('the outcome is read from the fill deployment, never by counter', () => {
  /**
   * The reviewer's second probe, verbatim in shape: a later deployment reuses
   * the same speculation id, contest id, game and market IN THE SAME BLOCK as
   * the old fill, and settles to the opposite side. Its log rows carry the
   * later Core as emitter. They are not consulted: the fill's own deployment
   * says `away`, and `away` is what gets priced.
   */
  it('ignores a later deployment that reused every id in the same block', async () => {
    const reused = {
      emitter_address: OTHER_CORE,
      block_number: FILL_BLOCK,
      tx_hash: '0xtx-r6',
    };
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [
        ...HISTORY(),
        created(reused),
        settled('2', reused), // the OTHER side wins under the later deployment
        contestCreated(reused),
        scoresSet('3', '5', reused),
      ],
    });
    const s = summaryOf(result);
    expect(s.fills).toBe(1);
    expect(s.record).toEqual({ won: 1, lost: 0, push: 0, void: 0, pending: 0 });
  });

  /**
   * The same probe with the OLD deployment's history gone (a reset-and-reindex
   * redeploy): the fill's own COMMITMENT_MATCHED row is absent, so there is no
   * emitter to read under, and the receipt is unresolved — never priced on the
   * later deployment's rows.
   */
  it('refuses the old receipt when only the later deployment history remains', async () => {
    const reused = { emitter_address: OTHER_CORE, block_number: FILL_BLOCK, tx_hash: '0xtx-r6' };
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [created(reused), settled('2', reused), contestCreated(reused), scoresSet('3', '5', reused)],
    });
    const s = summaryOf(result);
    expect(s.fills).toBe(0);
    expect(s.unresolvedFills).toBe(1);
  });

  /** A counter that restarted UNDER the same Core shows as a second creation. */
  it('refuses a speculation id created twice under the fill emitter', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY(), created({ tx_hash: '0xcreate-again', block_number: FILL_BLOCK })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses a fill with no COMMITMENT_MATCHED log row of its own', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: HISTORY().filter((r) => r.event_name !== 'COMMITMENT_MATCHED'),
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses when the log row for the fill sits in a different block than the receipt', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY().filter((r) => r.event_name !== 'COMMITMENT_MATCHED'), matched({ block_number: FILL_BLOCK + 1 })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses when the log row for the fill names a different commitment', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY().filter((r) => r.event_name !== 'COMMITMENT_MATCHED'), matched({}, { commitmentHash: '0xbb' })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  /**
   * The log holds TWO fill rows for the transaction but the projection holds
   * one: the stake would be summed over one event while the chain says two.
   * A missing log row is refused by the per-event lookup; this is the other
   * direction, which only the count can see.
   */
  it('refuses when the log carries a fill row the projection lacks', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ id: 1, log_index: 0 })],
      chain_events: [...HISTORY(), matched({ log_index: 1 })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses a transaction whose fill log rows disagree on the emitter', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ id: 1, log_index: 0 }), event({ id: 2, log_index: 1 })],
      chain_events: [...HISTORY(), matched({ log_index: 1, emitter_address: OTHER_CORE })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses a creation that cites a different contest than the receipt', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY().filter((r) => r.event_name !== 'SPECULATION_CREATED'), created({}, { contestId: '42' })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses a creation whose scorer names a different market than the receipt', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt({ market: 'total' })],
      position_fills: [event()],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses a creation whose scorer is not one of the configured scorers', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [
        ...HISTORY().filter((r) => r.event_name !== 'SPECULATION_CREATED'),
        created({}, { scorer: '0x3333333333333333333333333333333333333333' }),
      ],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  /** The spine 079 names: the contest, as its own deployment created it, must be the receipt's GAME. */
  it('refuses a contest created for a different game', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY().filter((r) => r.event_name !== 'CONTEST_CREATED'), contestCreated({}, { jsonoddsId: 'some-other-game' })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses when the contest has no creation under the fill emitter', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: HISTORY().filter((r) => r.event_name !== 'CONTEST_CREATED'),
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses a speculation settled twice, and a contest scored twice', async () => {
    const twiceSettled = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY(), settled('2', { tx_hash: '0xsettle-again' })],
    });
    const twiceScored = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY(), scoresSet('9', '9', { tx_hash: '0xscore-again' })],
    });
    expect(summaryOf(twiceSettled.result).unresolvedFills).toBe(1);
    expect(summaryOf(twiceScored.result).unresolvedFills).toBe(1);
  });

  /**
   * REVIEW ROUND 2c, item 2. The fill's own log row and the settlement each
   * name a scorer, and the fill's log row names a line; all three witnesses
   * must agree with the creation. Two immutable events that disagree about
   * which contract scored a speculation are not describing one speculation.
   */
  it('refuses when the fill log row names a different scorer than the creation', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY().filter((r) => r.event_name !== 'COMMITMENT_MATCHED'), matched({}, { scorer: SCORERS.spread })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses when the fill log row names a different line than the creation', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY().filter((r) => r.event_name !== 'COMMITMENT_MATCHED'), matched({}, { lineTicks: '5' })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses when the settlement names a different scorer than the creation', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [
        ...HISTORY().filter((r) => r.event_name !== 'SPECULATION_SETTLED'),
        log('SPECULATION_SETTLED', 'speculation', 88, { speculationId: '88', winSideValue: '1', scorer: SCORERS.spread }, { block_number: 200, tx_hash: '0xsettle' }),
      ],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  /**
   * REVIEW ROUND 2c, item 3 — the NARROWED contract, pinned. Scorer modules
   * are Core-bound; after a Core rotation the configured scorers are the new
   * deployment's, and this service holds no map for the old one. A fill whose
   * history was retained is then reported unresolved rather than priced by a
   * map the service does not have. (The indexer's supported redeploy resets and
   * reindexes, which leaves such fills without an event at all.)
   */
  it('reports a previous deployment fill unresolved once the configured scorers rotate', async () => {
    const rotated = {
      moneyline: '0x4444444444444444444444444444444444444444',
      spread: '0x5555555555555555555555555555555555555555',
      total: '0x6666666666666666666666666666666666666666',
    };
    const { result } = await collect(
      { benchmark_execution_fills: [receipt()], position_fills: [event()] },
      undefined,
      undefined,
      rotated,
    );
    expect(summaryOf(result).unresolvedFills).toBe(1);
    expect(summaryOf(result).fills).toBe(0);
    // Negative control: the same history under the deployment's own scorers prices.
    const own = await collect({ benchmark_execution_fills: [receipt()], position_fills: [event()] });
    expect(summaryOf(own.result).fills).toBe(1);
  });

  it('refuses a settlement whose win side is not one the protocol defines', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY().filter((r) => r.event_name !== 'SPECULATION_SETTLED'), settled('9')],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  /**
   * The scorer addresses are what name a chain speculation's market. Without
   * them nothing can be priced, and nothing is — on the receipt's own word or
   * otherwise.
   */
  it('refuses every receipt when the scorer addresses are not configured', async () => {
    const { result, fake } = await collect(
      { benchmark_execution_fills: [receipt()], position_fills: [event()] },
      undefined,
      undefined,
      null,
    );
    expect(summaryOf(result).unresolvedFills).toBe(1);
    expect(summaryOf(result).fills).toBe(0);
    // And issues no chain read the refusal would be about.
    expect(fake.tables()).not.toContain('chain_events');
    // The harness really ran without scorers: with them, the same fixture prices.
    const control = await collect({ benchmark_execution_fills: [receipt()], position_fills: [event()] });
    expect(summaryOf(control.result).fills).toBe(1);
  });

  /**
   * Negative control for every refusal above, with the links at their
   * BOUNDARY values: the commitment hash and taker differing only in case
   * (payloads are checksummed; 079 stores lowercase), the creation in the
   * fill's own block, and the fill's log row carrying the exact block.
   */
  it('prices the fill when every link holds', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt({ commitment_hash: '0xAA' })],
      position_fills: [event()],
      chain_events: [...HISTORY().filter((r) => r.event_name !== 'SPECULATION_CREATED'), created({ block_number: FILL_BLOCK })],
    });
    const s = summaryOf(result);
    expect(s.unresolvedFills).toBe(0);
    expect(s.fills).toBe(1);
    expect(s.record.won).toBe(1);
  });
});

/**
 * REVIEW ROUND 2c, item 1. The chain reads are separate statements and the
 * indexer's recovery replaces a block range across several of its own, so a
 * read can pair a fill from one canonical history with an outcome from
 * another. Every recovery runs inside a `recovery_runs` row (`in_progress` →
 * `complete` | `failed`); the reader snapshots that ledger before its first
 * chain read and after its last, and refuses the whole read if anything is
 * incomplete at either point or the latest row changed in between.
 */
describe('the chain read is bracketed by the indexer recovery ledger', () => {
  const run = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 7,
    network: 'polygon',
    kind: 'reorg',
    phase: 'validating',
    status: 'complete',
    started_at: '2026-08-24T00:00:00+00:00',
    completed_at: '2026-08-24T00:05:00+00:00',
    ...over,
  });

  /**
   * What the opening snapshot guards is that NO chain read is issued while a
   * recovery is mutating state — the refusal itself would also come from the
   * closing snapshot, but only after reading rows mid-rewrite. So the case
   * asserts on the requests, not only on the rejection.
   */
  it('fails closed when a recovery is in progress before the read, without reading the chain', async () => {
    const seen: string[] = [];
    await expect(
      collect(
        {
          benchmark_execution_fills: [receipt()],
          position_fills: [event()],
          recovery_runs: [run({ status: 'in_progress', completed_at: null })],
        },
        undefined,
        (req) => {
          seen.push(req.path);
          return undefined;
        },
      ),
    ).rejects.toMatchObject({ name: 'ProjectionUnstableError' });
    expect(seen).not.toContain('/rest/v1/position_fills');
    expect(seen).not.toContain('/rest/v1/chain_events');
    expect(seen).toContain('/rest/v1/recovery_runs');
  });

  /** A failed recovery blocks the indexer's own ingest until triaged; it blocks this reader the same way. */
  it('fails closed on a failed recovery, however old', async () => {
    await expect(
      collect({
        benchmark_execution_fills: [receipt()],
        position_fills: [event()],
        recovery_runs: [
          run({ id: 3, status: 'failed', completed_at: null, started_at: '2026-07-01T00:00:00+00:00' }),
          run({ id: 9 }),
        ],
      }),
    ).rejects.toMatchObject({ name: 'ProjectionUnstableError' });
  });

  /**
   * The reviewer's sequence: the fill and its log row are read, a recovery
   * then replaces the fork, and the outcome history is read from the
   * replacement. The recovery leaves a newer `complete` row than the one seen
   * before the read; the after-snapshot sees it and the read is refused.
   */
  it('fails closed when a recovery completes between the fill read and the outcome read', async () => {
    const ledger: Record<string, unknown>[] = [run({ id: 7 })];
    let chainReads = 0;
    await expect(
      collect(
        { benchmark_execution_fills: [receipt()], position_fills: [event()] },
        undefined,
        (req) => {
          if (req.path === '/rest/v1/chain_events') {
            chainReads += 1;
            // After the first chain read (the fill's own log rows), a
            // recovery starts and completes.
            if (chainReads === 1) ledger.push(run({ id: 8, kind: 'reorg' }));
          }
          if (req.path === '/rest/v1/recovery_runs') return { body: pageLike(ledger, req) };
          return undefined;
        },
      ),
    ).rejects.toMatchObject({ name: 'ProjectionUnstableError' });
  });

  it('fails closed when a recovery is in progress after the read', async () => {
    const ledger: Record<string, unknown>[] = [];
    let chainReads = 0;
    await expect(
      collect(
        { benchmark_execution_fills: [receipt()], position_fills: [event()] },
        undefined,
        (req) => {
          if (req.path === '/rest/v1/chain_events') {
            chainReads += 1;
            if (chainReads === 3) ledger.push(run({ id: 8, status: 'in_progress', completed_at: null }));
          }
          if (req.path === '/rest/v1/recovery_runs') return { body: pageLike(ledger, req) };
          return undefined;
        },
      ),
    ).rejects.toMatchObject({ name: 'ProjectionUnstableError' });
  });

  /** Negative control: a completed recovery that predates the read and does not change is not a fault. */
  it('serves when the ledger is complete and unchanged across the read', async () => {
    const { result, fake } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      recovery_runs: [run({ id: 7 })],
    });
    expect(summaryOf(result).fills).toBe(1);
    // The bracket really surrounds the chain reads: the ledger is the first
    // thing read after the receipts and the last thing read at all.
    const tables = fake.tables();
    const firstChain = tables.findIndex((t) => t === 'position_fills' || t === 'chain_events');
    const lastChain = tables.length - 1 - [...tables].reverse().findIndex((t) => t === 'position_fills' || t === 'chain_events');
    expect(tables.slice(0, firstChain)).toContain('recovery_runs');
    expect(tables.slice(lastChain + 1)).toContain('recovery_runs');
    expect(tables[tables.length - 1]).toBe('recovery_runs');
  });

  /** With no receipts nothing chain-derived is read, so the ledger is not consulted either. */
  it('does not consult the ledger when there is nothing to read', async () => {
    const { fake } = await collect({ recovery_runs: [run({ status: 'in_progress', completed_at: null })] });
    expect(fake.tables()).not.toContain('recovery_runs');
  });
});

describe('the verdict comes from the deployment history', () => {
  it('replays the scorer on the created line when the contest is scored but the speculation is open', async () => {
    // Spread, away −1.5 (lineTicks −15 in the 10x domain), away 5 home 3 ⇒ away covers.
    const { result } = await collect({
      benchmark_execution_fills: [receipt({ market: 'spread' })],
      position_fills: [event()],
      chain_events: [
        matched({}, { scorer: SCORERS.spread, lineTicks: '-15' }),
        created({}, { scorer: SCORERS.spread, lineTicks: '-15' }),
        contestCreated(),
        scoresSet('5', '3'),
      ],
    });
    const s = summaryOf(result);
    expect(s.record).toEqual({ won: 1, lost: 0, push: 0, void: 0, pending: 0 });
    expect(s.verdictSource).toEqual({ settled: 0, predicted: 1, undecided: 0 });
  });

  /** Same fixture, line pushed out to −2.5: the replay is reading the created line. */
  it('and the line it replays is the one the deployment created', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt({ market: 'spread' })],
      position_fills: [event()],
      chain_events: [
        matched({}, { scorer: SCORERS.spread, lineTicks: '-25' }),
        created({}, { scorer: SCORERS.spread, lineTicks: '-25' }),
        contestCreated(),
        scoresSet('5', '3'),
      ],
    });
    expect(summaryOf(result).record).toEqual({ won: 0, lost: 1, push: 0, void: 0, pending: 0 });
  });

  /**
   * A voided contest can never be scored and the only settlement left to an
   * open speculation on it is `WinSide.Void`, so the verdict is decided.
   */
  it('prices an open speculation on a voided contest as a void, stake returned', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [matched(), created(), contestCreated(), voided()],
    });
    const s = summaryOf(result);
    expect(s.record).toEqual({ won: 0, lost: 0, push: 0, void: 1, pending: 0 });
    expect(s.netWei6).toBe(0n);
    expect(s.pendingStakeWei6).toBe(0n);
    expect(s.verdictSource).toEqual({ settled: 0, predicted: 1, undecided: 0 });
  });

  it('is pending while the contest is neither scored nor voided', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [matched(), created(), contestCreated()],
    });
    const s = summaryOf(result);
    expect(s.record.pending).toBe(1);
    expect(s.pendingStakeWei6).toBe(BigInt(10 * USDC));
  });

  it('prefers the protocol settlement over the replay when both exist', async () => {
    // Scores say away; the protocol settled home. The protocol wins.
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [matched(), created(), settled('2'), contestCreated(), scoresSet('5', '3')],
    });
    const s = summaryOf(result);
    expect(s.record.lost).toBe(1);
    expect(s.verdictSource.settled).toBe(1);
  });
});

/**
 * Found by an adversarial pass: the first cut read an unparseable chain
 * amount as ZERO and still priced the fill — a record with no stake and the
 * full profit. Every other fault in this module refuses; this one now does.
 */
describe('an amount the service cannot read refuses the receipt', () => {
  it('refuses a fractional taker risk rather than pricing it as zero', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ taker_risk_amount: '10000000.5' })],
    });
    const s = summaryOf(result);
    expect(s.fills).toBe(0);
    expect(s.unresolvedFills).toBe(1);
    expect(s.stakedWei6).toBe(0n);
    expect(s.netWei6).toBe(0n);
  });

  /**
   * The same value as a JSON NUMBER, which is how PostgREST serialises a
   * `numeric` column. A string fixture alone cannot reach the number branch —
   * a mutant truncating `10000000.5` to `10000000` survived until this case.
   */
  it('refuses a fractional taker risk that arrives as a number', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ taker_risk_amount: 10000000.5 })],
    });
    const s = summaryOf(result);
    expect(s.unresolvedFills).toBe(1);
    expect(s.fills).toBe(0);
  });

  it('refuses an unreadable maker risk', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ maker_risk_amount: 'seven' })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses an unreadable receipt stake', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt({ stake_usdc: 'ten' })],
      position_fills: [event()],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses a created line that is not an integer', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      chain_events: [...HISTORY().filter((r) => r.event_name !== 'SPECULATION_CREATED'), created({}, { lineTicks: '1.5' })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  /** Negative control: amounts as numbers and as bigint strings both price. */
  it('prices whole amounts whether they arrive as numbers or strings', async () => {
    const asNumbers = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event({ taker_risk_amount: 10 * USDC, maker_risk_amount: 7 * USDC })],
    });
    const asStrings = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
    });
    expect(summaryOf(asNumbers.result).netWei6).toBe(BigInt(7 * USDC));
    expect(summaryOf(asStrings.result).netWei6).toBe(BigInt(7 * USDC));
  });
});

/** Each carried receipt says whether the identity chain resolved it. */
describe('the resolved flag on a carried receipt', () => {
  it('is true for a priced fill and false for a refused one', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt({ tx_hash: '0xtx1' }), receipt({ tx_hash: '0xtx2', market: 'total' })],
      // Only the first has its event; the second is refused at link 1.
      position_fills: [event({ tx_hash: '0xtx1' })],
    });
    const fills = (result as { fills: Array<{ txHash: string; resolved: boolean }> }).fills;
    expect(fills.map((f) => [f.txHash, f.resolved])).toEqual([
      ['0xtx1', true],
      ['0xtx2', false],
    ]);
    expect(summaryOf(result).fills).toBe(1);
    expect(summaryOf(result).unresolvedFills).toBe(1);
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
      new Set([GAME]),
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
      new Set([GAME]),
    );
    expect(summaryOf(result).fills).toBe(1);
  });
});

/**
 * REVIEW ROUND 2, B5. The receipts relation is append-only under a publisher
 * that can insert between two pages. Offset paging re-read a row when one
 * landed before page two: 1,001 unique receipts came back as 1,002 fills.
 */
describe('paging over the receipts', () => {
  /** Zero-padded so lexical order is generation order — what `order=tx_hash.asc` gives. */
  const hash = (i: number): string => `0x${i.toString(16).padStart(6, '0')}`;
  const manyReceipts = (n: number): Array<Record<string, unknown>> =>
    Array.from({ length: n }, (_, i) => receipt({ tx_hash: hash(i + 1) }));

  /**
   * 1,001 receipts, and a row inserted at the FRONT of the relation after page
   * one was served — the shape review used. A keyset walk resumes from the last
   * hash seen and cannot re-read anything; an offset walk resumes from
   * position 1000, which the insert has just shifted onto the old row 999.
   */
  it('counts 1,001 receipts exactly once when a row lands between pages', async () => {
    const live = manyReceipts(1001);
    let served = 0;
    const { result, fake } = await collect({}, undefined, (req) => {
      if (req.path !== '/rest/v1/benchmark_execution_fills') return undefined;
      served += 1;
      if (served === 2) live.unshift(receipt({ tx_hash: hash(0) }));
      return { body: pageLike(live, req) };
    });
    const fills = (result as { fills: Array<{ txHash: string }> }).fills;
    expect(fills).toHaveLength(1001);
    expect(new Set(fills.map((f) => f.txHash)).size).toBe(1001);
    // Every receipt was unresolvable (no events in this fixture) and counted
    // once — the same 1,001, not 1,002.
    expect(summaryOf(result).unresolvedFills).toBe(1001);

    // The walk itself: the second page asks for hashes ABOVE the first page's
    // last one, ordered by the same column, with no offset anywhere.
    const pages = fake.requests.filter((r) => r.path === '/rest/v1/benchmark_execution_fills');
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const p of pages) {
      expect(p.params.get('order')).toBe('tx_hash.asc');
      expect(p.params.has('offset')).toBe(false);
    }
    expect(pages[1]?.params.get('tx_hash')).toBe(`gt.${hash(1000)}`);
  });

  /**
   * A server that ignores the cursor and repeats a FULL page trips the
   * cursor-advance guard in `readAllByKeyset`. That is the same class of fault
   * as a duplicate — the server answered outside its contract — and is typed
   * the same way, so both handlers answer 503 rather than a bare 500.
   */
  it('refuses the whole read when the cursor does not advance', async () => {
    const first = manyReceipts(1000);
    await expect(
      collect({}, undefined, (req) =>
        req.path === '/rest/v1/benchmark_execution_fills' ? { body: first } : undefined,
      ),
    ).rejects.toMatchObject({ name: 'ProjectionIntegrityError', relation: 'benchmark_execution_fills' });
  });

  /**
   * The contradiction check behind the keyset. A relation that is UNIQUE on
   * `tx_hash` cannot return the same hash twice to a walk that only ever asks
   * for hashes above its cursor; if it does, the read cannot be trusted and
   * nothing is served from it. The cursor here still advances (the page's last
   * row is new), so this is the duplicate check firing and not the
   * cursor-did-not-advance guard in `readAllByKeyset`.
   */
  it('refuses the whole read when a receipt comes back twice', async () => {
    const first = manyReceipts(1000);
    let served = 0;
    await expect(
      collect({}, undefined, (req) => {
        if (req.path !== '/rest/v1/benchmark_execution_fills') return undefined;
        served += 1;
        if (served === 1) return { body: first };
        return { body: [first[499] as Record<string, unknown>, receipt({ tx_hash: hash(5000) })] };
      }),
    ).rejects.toMatchObject({ name: 'ProjectionIntegrityError', relation: 'benchmark_execution_fills' });
  });
});

/**
 * The shared fault responder both handlers route the two typed faults through.
 * Each fault is a 503 `NOT_READY` — the projection is not servable, the
 * service is — and anything else is NOT handled, so a genuine bug still
 * reaches the error handler as a 500.
 */
describe('respondProjectionFault', () => {
  async function respondTo(err: unknown): Promise<{ handled: boolean; status: number; body: unknown }> {
    const { respondProjectionFault } = await import('../src/v1/benchmark/source.js');
    let status = 0;
    let body: unknown = null;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Response;
    const handled = respondProjectionFault(res, err);
    return { handled, status, body };
  }

  it('answers an integrity fault with 503 NOT_READY', async () => {
    const { ProjectionIntegrityError } = await import('../src/v1/benchmark/source.js');
    const r = await respondTo(new ProjectionIntegrityError('benchmark_execution_fills', 'dup'));
    expect(r.handled).toBe(true);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'NOT_READY' });
  });

  it('answers a size fault with 503 NOT_READY', async () => {
    const { ProjectionTooLargeError } = await import('../src/v1/benchmark/source.js');
    const r = await respondTo(new ProjectionTooLargeError('benchmark_scores', 200_000));
    expect(r.handled).toBe(true);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'NOT_READY' });
  });

  it('answers an unstable read (indexer recovery) with 503 NOT_READY', async () => {
    const { ProjectionUnstableError } = await import('../src/v1/benchmark/source.js');
    const r = await respondTo(new ProjectionUnstableError('recovery 8 is in_progress'));
    expect(r.handled).toBe(true);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'NOT_READY' });
  });

  /** Negative control: a plain error is not a projection fault and is left to the caller. */
  it('does not swallow an ordinary error', async () => {
    const r = await respondTo(new Error('boom'));
    expect(r.handled).toBe(false);
    expect(r.status).toBe(0);
  });
});
