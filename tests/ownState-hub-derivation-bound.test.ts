/**
 * `OwnStateHub.reDerivePositionStatuses` — the bound on the live derivation, and
 * whether saturating it is observable (`ospex-core-api#83`).
 *
 * ## Why this file exists separately from `ownState-hub.test.ts`
 *
 * That file's double is deliberately permissive: `for (const m of ['select',
 * 'eq', 'or', 'in', 'lte', 'lt', 'gt', 'order', 'limit']) b[m] = () => b`, with a
 * docstring saying filters are not enforced. It is the right tool for the dedup
 * and ordering contracts it tests, and it is USELESS for a cap — measured, a
 * 250-row one-wallet fixture through it produces 250 emits, so a test asserting
 * "the rows past the cap are dropped" would pass identically against a build with
 * no `.limit()` at all (rule 3c-harness).
 *
 * So these cases use `tests/helpers/positionTables.ts`, the double
 * `positions-bounded.test.ts` already uses, which applies `eq` / `gt` / `in` /
 * `order` / `limit` and RECORDS every query. The assertions below are split
 * deliberately between the two things it can show: which rows the derivation
 * reached (through the emit callbacks) and what it ASKED FOR (through the
 * recorded `queries`, so a chunk size, an `ORDER BY` and an `IN` list are
 * probed at the call rather than inferred from the answer — rule 3i).
 *
 * ## Fixture rule, and it is load-bearing
 *
 * `row_updated_at` descends as `id` ASCENDS: position 1 is the most recently
 * updated and position N the least. So the retained window under the real order
 * (`row_updated_at DESC, id DESC`) is ids 1..200, and under an id-only order it
 * would be the disjoint N..N-199. A fixture with one shared timestamp — which is
 * what `scaleTables` builds — cannot tell those apart, because the id tiebreak
 * decides everything (rule 3g-both: the input has to sit where the two candidate
 * rules disagree).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ADDRESS,
  positionTables,
  type Query,
  type Row,
  type Table,
  type Tables,
} from './helpers/positionTables.js';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const { OwnStateHub } = await import('../src/v1/ownState/hub.js');

// ── fixture ──────────────────────────────────────────────────────────────

/** `2026-09-2X` ISO with microseconds, descending as `id` ascends. */
function stampFor(id: number): string {
  const ms = NOW - id * 60_000;
  return `${new Date(ms).toISOString().replace('Z', '')}456+00:00`;
}

interface PositionSpec {
  /** speculation_status / win_side on the parent speculation. */
  specStatus?: 'open' | 'closed';
  winSide?: string;
  contestStatus?: 'unverified' | 'verified' | 'scored' | 'voided';
  /** Scores. BOTH are needed for the predictive branch — a scored contest with
   *  a null score falls through to `active`, which is how the predicted-loser
   *  case below first failed to be the case it claimed to be (rule 3b). */
  awayScore?: number;
  homeScore?: number;
  riskAmount?: string;
  claimed?: boolean;
  /** Override the recency stamp — used to move one row to the window's head. */
  rowUpdatedAt?: string;
}

/**
 * `count` actionable positions for one wallet, id 1..count, newest-updated first.
 *
 * Defaults derive to `active`: speculation open, contest `unverified`, so the
 * derivation returns `active` and NOTHING is frozen. Every freeze case has to
 * opt in explicitly, which keeps the freeze predicate out of the cases that are
 * about the cap.
 */
function buildTables(count: number, overrides: Record<number, PositionSpec> = {}): Tables {
  const tables: Tables = { positions: [], speculations: [], contests: [] };
  for (let id = 1; id <= count; id += 1) {
    const o = overrides[id] ?? {};
    tables.positions.push({
      id,
      speculation_id: id,
      user_address: ADDRESS,
      network: 'polygon',
      position_type: 'upper',
      risk_amount: o.riskAmount ?? '10000',
      profit_amount: '15000',
      claimed: o.claimed ?? false,
      position_created_at: stampFor(id),
      row_updated_at: o.rowUpdatedAt ?? stampFor(id),
    } satisfies Row);
    tables.speculations.push({
      speculation_id: id,
      contest_id: id,
      network: 'polygon',
      market_type: 'moneyline',
      line_ticks: 0,
      speculation_status: o.specStatus ?? 'open',
      win_side: o.winSide ?? 'tbd',
      row_updated_at: stampFor(id),
    } satisfies Row);
    tables.contests.push({
      contest_id: id,
      network: 'polygon',
      contest_status: o.contestStatus ?? 'unverified',
      away_score: o.awayScore ?? null,
      home_score: o.homeScore ?? null,
      row_updated_at: stampFor(id),
    } satisfies Row);
  }
  return tables;
}

const DERIVED: ReadonlySet<string> = new Set(['positions', 'speculations', 'contests']);

/**
 * The hub polls commitments and position_fills before it derives positions, and
 * `positionTables` only knows the three derivation tables. So: those three go to
 * the recording double, everything else answers empty.
 */
function hubClient(sb: ReturnType<typeof positionTables>): SupabaseClient {
  const emptyBuilder = (): unknown => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'in', 'lte', 'lt', 'gt', 'order', 'limit']) {
      b[m] = (): unknown => b;
    }
    b['then'] = (resolve: (v: { data: unknown; error: null }) => void): void =>
      resolve({ data: [], error: null });
    return b;
  };
  return {
    from: (table: string): unknown =>
      DERIVED.has(table) ? sb.from(table as Table) : emptyBuilder(),
  } as unknown as SupabaseClient;
}

interface Recorded {
  statuses: Array<{ id: string; status: string }>;
  degradeds: string[];
  resyncs: string[];
}

function subscribeRecording(hub: InstanceType<typeof OwnStateHub>): Recorded & {
  sub: ReturnType<InstanceType<typeof OwnStateHub>['subscribe']>;
} {
  const rec: Recorded = { statuses: [], degradeds: [], resyncs: [] };
  const sub = hub.subscribe(ADDRESS, {
    onCommitment: () => undefined,
    onFill: () => undefined,
    onPositionStatus: (body, _ts, id) => {
      rec.statuses.push({ id, status: body.status });
    },
    onResync: (reason) => {
      rec.resyncs.push(reason);
    },
    onDegraded: (reason) => {
      rec.degradeds.push(reason);
    },
  });
  return { ...rec, sub, statuses: rec.statuses, degradeds: rec.degradeds, resyncs: rec.resyncs };
}

function makeHub(sb: ReturnType<typeof positionTables>): InstanceType<typeof OwnStateHub> {
  return new OwnStateHub({
    getClient: () => hubClient(sb),
    getNetwork: () => 'polygon',
  });
}

/** Every `positions` read after the first (which is phase A). */
function phaseBQueries(queries: Query[]): Query[] {
  return queries.filter((q) => q.table === 'positions').slice(1);
}

/** The `speculation_id` IN-list of each phase-B page, in order. */
function phaseBIdLists(queries: Query[]): number[][] {
  return phaseBQueries(queries).map(
    (q) => (q.joins.find(([col]) => col === 'speculation_id')?.[1] ?? []) as number[],
  );
}

function seedAll(hub: InstanceType<typeof OwnStateHub>, ids: number[], status = 'active'): void {
  hub.seedStatusCache(
    ADDRESS,
    ids.map((id) => ({
      key: `${String(id)}_0`,
      status: status as 'active',
      sourceUpdatedAt: stampFor(id),
    })),
  );
}

// ── phase A: the cap, and that saturating it is observable ───────────────

describe('reDerivePositionStatuses — phase A discovery is capped, and says so', () => {
  it('derives only the 200 most-recently-updated rows and reports saturation', async () => {
    const sb = positionTables(buildTables(250));
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);

    // The query, not the answer: this is the whole mechanism under test.
    const phaseA = sb.queries.filter((q) => q.table === 'positions')[0]!;
    expect(phaseA.limit).toBe(200);
    expect(phaseA.orders).toEqual([
      ['row_updated_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);

    // With no seed every observed key is new, so the emit count IS the number
    // of rows the derivation reached.
    expect(rec.statuses).toHaveLength(200);
    const reached = new Set(rec.statuses.map((s) => Number(s.id)));
    expect(reached.has(1)).toBe(true);
    expect(reached.has(200)).toBe(true);
    // Ids 201..250 are the OLDEST-updated. Under an id-only order they would be
    // the ones KEPT, so their absence is what proves the recency window.
    expect(reached.has(201)).toBe(false);
    expect(reached.has(250)).toBe(false);

    // And the defect this issue is about: the 50 it could not see are reported.
    expect(rec.degradeds).toEqual(['positionsTruncated']);
    expect(hub.stats().positionSaturationTotal).toBe(1);
    // Not a resync. The view is still ordered and still delivering; asking the
    // client to reconnect would not widen it.
    expect(rec.resyncs).toEqual([]);
  });

  it('is silent at 199 rows and speaks at exactly 200', async () => {
    // The boundary, both sides, because `>= CAP` and `> CAP` differ by exactly
    // this case and nothing else in the file distinguishes them.
    for (const [count, expected] of [
      [199, [] as string[]],
      [200, ['positionsTruncated']],
    ] as const) {
      const sb = positionTables(buildTables(count));
      const hub = makeHub(sb);
      const rec = subscribeRecording(hub);
      await hub.pollWallet(ADDRESS);
      expect(rec.statuses, `count=${String(count)}`).toHaveLength(count);
      expect(rec.degradeds, `count=${String(count)}`).toEqual(expected);
    }
  });

  it('signals ONCE across repeated ticks, not once per tick', async () => {
    // A saturated wallet saturates on every tick. Unlatched this is 2,400 wire
    // events and log lines per hour per wallet; the market maker would also
    // re-run its cancel sweep on each one.
    const sb = positionTables(buildTables(250));
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);
    await hub.pollWallet(ADDRESS);
    await hub.pollWallet(ADDRESS);

    expect(rec.degradeds).toEqual(['positionsTruncated']);
    expect(hub.stats().positionSaturationTotal).toBe(1);
  });

  it('tells a subscriber that joined after the latch, on its own poller', () => {
    // The latch lives on the POLLER, so it dies with the last subscriber. That
    // is what makes "reconnect to clear it" honest.
    const sb = positionTables(buildTables(250));
    const hub = makeHub(sb);
    const first = subscribeRecording(hub);
    hub.unsubscribe(first.sub);
    const second = subscribeRecording(hub);
    expect(second.degradeds).toEqual([]);
    expect(hub.stats().wallets).toBe(1);
  });
});

// ── phase B: maintenance of tracked keys ─────────────────────────────────

describe('reDerivePositionStatuses — phase B maintains tracked keys deterministically', () => {
  it('delivers a transition on a row OUTSIDE the recency window, via the by-id refresh', async () => {
    // The acceptance case from the issue: >200 actionable rows, and the
    // transition happens on a row the recency window cannot see. Here the
    // subscriber was told about every row (the `#76` end state), so phase B owes
    // the event — and delivers it.
    const tables = buildTables(250, {
      // 250 is the OLDEST-updated row, so it is outside phase A's window. Its
      // speculation settles on the winning side: active -> claimable, which is
      // money.
      250: { specStatus: 'closed', winSide: 'away' },
    });
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    seedAll(hub, Array.from({ length: 250 }, (_, i) => i + 1));

    await hub.pollWallet(ADDRESS);

    // SETUP FIRST (rule 3g-silentsetup). Phase A asked for 200 of the 250 rows
    // by recency, and 250 is the oldest-updated, so the window cannot hold it —
    // which is what makes the delivery below attributable to phase B and not to
    // "the fixture was small enough".
    const phaseA = sb.queries.filter((q) => q.table === 'positions')[0]!;
    expect(phaseA.limit).toBe(200);
    expect(tables.positions).toHaveLength(250);
    expect(phaseBIdLists(sb.queries).flat()).toContain(250);

    const delivered = rec.statuses.find((s) => s.id === '250');
    expect(delivered).toEqual({ id: '250', status: 'claimable' });
    // Nothing else moved: the other 249 keys were seeded at their derived state.
    expect(rec.statuses).toHaveLength(1);
  });

  it('pages the refresh in ascending chunks of 100, ordered by id', async () => {
    const sb = positionTables(buildTables(250));
    const hub = makeHub(sb);
    subscribeRecording(hub);
    // Seed in DESCENDING order so Map insertion order is the reverse of the
    // ascending order the code must impose. A build that dropped the sort would
    // chunk 250,249,… and this assertion is the only thing that sees it.
    seedAll(hub, Array.from({ length: 250 }, (_, i) => 250 - i));

    await hub.pollWallet(ADDRESS);

    const lists = phaseBIdLists(sb.queries);
    // 250 seeded keys, 200 of them inside phase A's window -> 50 stale.
    expect(lists).toHaveLength(1);
    expect(lists[0]).toEqual(Array.from({ length: 50 }, (_, i) => 201 + i));
    for (const q of phaseBQueries(sb.queries)) {
      expect(q.orders).toEqual([['id', { ascending: true }]]);
      expect(q.limit).toBe(100); // 2 x chunk, the uniqueness bound
    }
  });

  it('refuses to exceed its page budget, and reports that instead of truncating', async () => {
    // 700 actionable rows: 200 inside phase A's window, 500 stale keys against a
    // 4 x 100 budget. The 100 uncovered keys are exactly what the old single
    // `.limit(200)` returned an unspecified subset of, silently.
    const sb = positionTables(buildTables(700));
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    seedAll(hub, Array.from({ length: 700 }, (_, i) => i + 1));

    await hub.pollWallet(ADDRESS);

    const lists = phaseBIdLists(sb.queries);
    expect(lists).toHaveLength(4);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 100, 100]);
    // The covered prefix is specified: ids 201..600, ascending.
    expect(lists.flat()).toEqual(Array.from({ length: 400 }, (_, i) => 201 + i));
    expect(rec.degradeds).toEqual(['positionsTruncated']);
  });
});

// ── the freeze: retiring keys that can never transition again ────────────

describe('reDerivePositionStatuses — a finished position is retired from the work-list', () => {
  /** Two ticks; returns the phase-B id lists of each. */
  async function twoTicks(spec: PositionSpec): Promise<{
    first: number[];
    second: number[];
    statuses: Array<{ id: string; status: string }>;
  }> {
    // 205 rows so ids 201..205 sit outside phase A's window and therefore land
    // in phase B, which is where the retirement is observable.
    const sb = positionTables(buildTables(205, { 205: spec }));
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    // Seed EVERY key, not just the one under test: an unseeded key emits
    // unconditionally (`prior === undefined`), so a partial seed would bury the
    // one emission this case is about under 200 first-observations.
    seedAll(hub, Array.from({ length: 205 }, (_, i) => i + 1));
    await hub.pollWallet(ADDRESS);
    const first = phaseBIdLists(sb.queries).flat();
    const before = sb.queries.length;
    await hub.pollWallet(ADDRESS);
    const second = phaseBIdLists(sb.queries.slice(before)).flat();
    return { first, second, statuses: rec.statuses };
  }

  it('stops re-querying a settled loser whose speculation is closed', async () => {
    // upper position, win_side 'home' -> the other side won -> settledLost, and
    // `claimPosition` reverts forever.
    const { first, second, statuses } = await twoTicks({
      specStatus: 'closed',
      winSide: 'home',
    });
    expect(first).toContain(205);
    expect(statuses).toEqual([{ id: '205', status: 'settledLost' }]);
    expect(second).not.toContain(205);
  });

  it('keeps re-querying a PREDICTED loser while the speculation is still open', async () => {
    // The negative control for the `speculationStatus === 'closed'` clause, and
    // it is not academic: a contest score correction flips this row's prediction
    // (the 2026-09-18 stale-final incident). A build that froze on the status
    // alone passes every other case in this file.
    const { first, second, statuses } = await twoTicks({
      specStatus: 'open',
      contestStatus: 'scored',
      // Home wins, so the `upper` (away) position is the PREDICTED loser while
      // the speculation is still open. Both scores present, or the derivation
      // falls through to `active` and the case tests nothing.
      awayScore: 6,
      homeScore: 7,
      winSide: 'tbd',
    });
    expect(first).toContain(205);
    expect(statuses.map((s) => s.status)).toEqual(['settledLost']);
    expect(second).toContain(205);
  });

  it('keeps re-querying a closed speculation still carrying win_side tbd', async () => {
    // The negative control for the `winSide !== 'tbd'` clause. `closed` + `tbd`
    // is a shouldn't-happen state the derivation handles defensively; if the real
    // side arrives later the row turns claimable, so freezing it would drop money.
    const { first, second, statuses } = await twoTicks({
      specStatus: 'closed',
      winSide: 'tbd',
    });
    expect(first).toContain(205);
    expect(statuses.map((s) => s.status)).toEqual(['settledLost']);
    expect(second).toContain(205);
  });

  it('still delivers a change on a retired key, because a touched row re-enters the window', async () => {
    // The safety net the retirement leans on, asserted rather than assumed
    // (rule 3b-rescue: name the rival mechanism and exclude it). Tick 1 retires
    // the key while it is outside the window. Then the stake comes back — a
    // secondary-market transfer bumps `row_updated_at` to now — and the row is
    // the NEWEST in the table, so phase A carries it even though phase B has
    // stopped asking for it.
    const tables = buildTables(205, { 205: { specStatus: 'closed', winSide: 'away', riskAmount: '0' } });
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    seedAll(hub, Array.from({ length: 205 }, (_, i) => i + 1));

    await hub.pollWallet(ADDRESS);
    // risk 0 on a winning closed speculation is `settledLost` (payout 0, the
    // claim reverts) — terminal, and retired.
    expect(rec.statuses).toEqual([{ id: '205', status: 'settledLost' }]);

    const row = tables.positions.find((p) => p.id === 205)!;
    row['risk_amount'] = '10000';
    row['row_updated_at'] = `${new Date(NOW + 60_000).toISOString().replace('Z', '')}456+00:00`;

    const before = sb.queries.length;
    await hub.pollWallet(ADDRESS);

    // The rival is excluded: phase B never asked for it.
    expect(phaseBIdLists(sb.queries.slice(before)).flat()).not.toContain(205);
    expect(rec.statuses[1]).toEqual({ id: '205', status: 'claimable' });
  });
});
