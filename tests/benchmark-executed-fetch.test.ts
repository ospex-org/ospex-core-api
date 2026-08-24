/**
 * `collectExecuted` — the join from a benchmark fill receipt to the immutable
 * on-chain fill event, and from the event to the outcome rows it is bound to.
 *
 * These exist because the first cut reconstructed each fill from the MUTABLE
 * aggregate `positions` row, and review reproduced two concrete money defects
 * from it: two receipts against one aggregate position published double the
 * stake, and reversing the order of two position rows flipped a fill from won
 * to lost. Both are asserted here against the new join, and the second is
 * asserted in the form that matters — the side comes from the event's
 * `taker_position_type`, so there is no row order to depend on.
 *
 * The second review round added two more, both reproduced and both pinned:
 * a reused speculation id after a redeploy was priced against the WRONG
 * outcome row (the "durable identity" block), and an offset walk over the
 * receipts double-counted when a row landed between two pages (the "paging"
 * block).
 *
 * Driven through the real Supabase client against a fake PostgREST, so the
 * queries are the ones the handler actually issues — including the one this
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

const USDC = 1_000_000;

/**
 * The speculation was created at block 90 and filled at block 100 — the fill
 * strictly AFTER creation, so a fixture that moves creation past the fill is
 * measuring the block-ordering link and nothing else.
 */
const SPEC_BLOCK = 90;
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

function spec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: 'polygon',
    speculation_id: 88,
    contest_id: 41,
    market_type: 'moneyline',
    line_ticks: null,
    speculation_status: 'closed',
    win_side: 'away', // upper wins
    source_block: SPEC_BLOCK,
    ...over,
  };
}

function contest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: 'polygon',
    contest_id: 41,
    jsonodds_id: GAME,
    contest_status: 'scored',
    away_score: 5,
    home_score: 3,
    ...over,
  };
}

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
    const [col] = order.split('.') as [string];
    filtered.sort((a, b) => String(a[col]).localeCompare(String(b[col])));
  }
  const offset = Number(req.params.get('offset') ?? '0');
  const limit = req.params.has('limit') ? Number(req.params.get('limit')) : filtered.length;
  return filtered.slice(offset, offset + limit);
}

async function collect(
  tables: Tables,
  inScope?: Set<string>,
  override?: (req: CapturedRequest, index: number) => FakeReply | undefined,
): Promise<{
  fake: FakePostgrest;
  result: Awaited<ReturnType<typeof import('../src/v1/benchmark/executedFetch.js').collectExecuted>>;
}> {
  const data: Tables = {
    benchmark_execution_fills: [],
    position_fills: [],
    speculations: [spec()],
    contests: [contest()],
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
  const result = await collectExecuted(getSupabase(), 'polygon', [COHORT], inScope);
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
        receipt({ market: 'moneyline', tx_hash: '0xtx2', stake_usdc: 2 }),
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

/**
 * REVIEW ROUND 2, B3. A transaction hash proves which fill happened; it does
 * not prove the `speculations` row read today is the speculation the fill was
 * on, because `speculation_id` and `contest_id` restart on every redeploy and
 * the protocol tables carry no round. Each case below breaks ONE link of the
 * identity chain and leaves every other link intact, so a build that skipped
 * that link — and only that link — would price the fill.
 */
describe('the outcome row is bound by durable identity, not by the counter', () => {
  /**
   * The reviewer's probe: the current row for id 88 was minted by a LATER
   * deployment — created after the fill it is being asked to price. Everything
   * else about it agrees, which is exactly why the counter alone was fooled.
   */
  it('refuses a speculation row created after the fill (a reused id from a later deployment)', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      speculations: [spec({ source_block: FILL_BLOCK + 1 })],
    });
    const s = summaryOf(result);
    expect(s.fills).toBe(0);
    expect(s.unresolvedFills).toBe(1);
  });

  /** Creation IN the fill's block is legitimate: R5 mints a speculation in its first fill. */
  it('accepts a speculation created in the same block as the fill', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      speculations: [spec({ source_block: FILL_BLOCK })],
    });
    expect(summaryOf(result).fills).toBe(1);
  });

  it('refuses a speculation row with no creation block at all', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      speculations: [spec({ source_block: null })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses a speculation row on a different contest than the receipt cites', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      speculations: [spec({ contest_id: 42 })],
      contests: [contest({ contest_id: 42 })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses a speculation row on a different market than the receipt cites', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt({ market: 'total' })],
      position_fills: [event()],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  /** The spine 079 names: the contest must be the receipt's GAME. */
  it('refuses a contest row whose jsonodds_id is not the receipt game', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      contests: [contest({ jsonodds_id: 'some-other-game' })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses a contest row with no jsonodds_id', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      contests: [contest({ jsonodds_id: null })],
    });
    expect(summaryOf(result).unresolvedFills).toBe(1);
  });

  it('refuses when the contest row is missing entirely', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      contests: [],
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
   * Negative control for the nine refusals above, with every link deliberately
   * at its BOUNDARY value rather than a comfortable one: creation in the fill's
   * own block, and the commitment hash differing only in case (079 stores hex
   * lowercase; the comparison is case-insensitive anyway).
   */
  it('prices the fill when every link holds', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt({ commitment_hash: '0xAA' })],
      position_fills: [event()],
      speculations: [spec({ source_block: FILL_BLOCK })],
    });
    const s = summaryOf(result);
    expect(s.unresolvedFills).toBe(0);
    expect(s.fills).toBe(1);
    expect(s.record.won).toBe(1);
  });

  /**
   * The other half of B3. A voided contest can never be scored (`setScores`
   * reverts on any status but Verified) and the only settlement left to an
   * open speculation on it is `WinSide.Void`, so the verdict is decided — only
   * its claim block is not. Pending would hold the stake on a bet already
   * refunded in principle.
   */
  it('prices an open speculation on a voided contest as a void, stake returned', async () => {
    const { result } = await collect({
      benchmark_execution_fills: [receipt()],
      position_fills: [event()],
      speculations: [spec({ speculation_status: 'open', win_side: 'tbd' })],
      contests: [contest({ contest_status: 'voided', away_score: null, home_score: null })],
    });
    const s = summaryOf(result);
    expect(s.record).toEqual({ won: 0, lost: 0, push: 0, void: 1, pending: 0 });
    expect(s.netWei6).toBe(0n);
    expect(s.pendingStakeWei6).toBe(0n);
    expect(s.verdictSource).toEqual({ settled: 0, predicted: 1, undecided: 0 });
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

  /** Negative control: a plain error is not a projection fault and is left to the caller. */
  it('does not swallow an ordinary error', async () => {
    const r = await respondTo(new Error('boom'));
    expect(r.handled).toBe(false);
    expect(r.status).toBe(0);
  });
});
