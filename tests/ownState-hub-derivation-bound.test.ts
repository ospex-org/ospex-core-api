/**
 * `OwnStateHub.reDerivePositionStatuses` — the bound on the live derivation,
 * whether saturating it is observable (`ospex-core-api#83`), and whether its
 * discovery half can be displaced (`#97`).
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
 * ## Two fixture rules, both load-bearing
 *
 * **1. `row_updated_at` descends as `id` ASCENDS** — position 1 is the most
 * recently updated and position N the least. Written for the recency window
 * `#97` deleted (the retained set was ids 1..200 under `row_updated_at DESC, id
 * DESC` and the disjoint N..N-199 under an id-only order, and a fixture with one
 * shared timestamp cannot tell those apart — rule 3g-both). It still earns its
 * keep: it makes id order and timestamp order disagree, so a drain that ordered
 * by the wrong column returns a different set rather than the same one.
 *
 * **2. `buildTables` stamps into the PAST and is therefore INVISIBLE to the
 * drain.** The poller's tip starts at `subscribe()` time, which the frozen clock
 * pins at `NOW`, so a fixture row at `NOW − 60s` is below the 30s overlap floor
 * and a case that wants its rows DISCOVERED must use `liveTables` /
 * `laterStamp` / `stampBefore(<30)`, while a case that wants them MAINTAINED
 * seeds the cache instead. That split is the design, not an artefact: the
 * pre-existing population belongs to the handler's seed and the delta belongs to
 * the drain. A case that seeds nothing and stamps nothing forward asserts
 * against an empty tick, which is why several of these cases assert their setup
 * before their behaviour (rule 3g-silentsetup).
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

/** A stamp strictly NEWER than any `stampFor` value, for inter-poll churn. */
function laterStamp(minutes: number): string {
  return `${new Date(NOW + minutes * 60_000).toISOString().replace('Z', '')}456+00:00`;
}

/**
 * A stamp `seconds` BEFORE the poller's tip.
 *
 * The tip is `new Date().toISOString()` at `subscribe()`, which the frozen clock
 * pins at exactly `NOW`, so this is the axis the discovery drain's overlap floor
 * sits on: `stampBefore(10)` is inside a 30s overlap and `stampBefore(60)` is
 * outside it. `stampFor` is minutes-scaled and therefore always outside.
 */
function stampBefore(seconds: number): string {
  return `${new Date(NOW - seconds * 1000).toISOString().replace('Z', '')}456+00:00`;
}

/**
 * `count` actionable positions stamped ABOVE the poller's tip, so the discovery
 * drain reaches them on the first poll.
 *
 * `buildTables` stamps minutes into the PAST, which is the right default and the
 * shape of the pre-existing population the handler's seed carries — invisible to
 * a cursor that starts at connect time, by design. This is the other population:
 * rows that arrived since. Before `#97` every case could rely on phase A's
 * recency window reaching back over the whole fixture, so the distinction did not
 * exist and every fixture row was implicitly discoverable.
 */
function liveTables(count: number, overrides: Record<number, PositionSpec> = {}): Tables {
  const tables = buildTables(count, overrides);
  for (const row of tables.positions) row['row_updated_at'] = laterStamp(Number(row['id']));
  return tables;
}

/** Append one actionable position (plus its parents) at `stamp`. */
function pushRow(tables: Tables, id: number, stamp: string): void {
  const one = buildTables(1);
  tables.positions.push({ ...one.positions[0]!, id, speculation_id: id, row_updated_at: stamp, position_created_at: stamp });
  tables.speculations.push({ ...one.speculations[0]!, speculation_id: id, contest_id: id, row_updated_at: stamp });
  tables.contests.push({ ...one.contests[0]!, contest_id: id, row_updated_at: stamp });
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

function makeHub(
  sb: ReturnType<typeof positionTables>,
  deps: { pollLimit?: number; maxForwardPages?: number; overlapMs?: number } = {},
): InstanceType<typeof OwnStateHub> {
  return new OwnStateHub({
    getClient: () => hubClient(sb),
    getNetwork: () => 'polygon',
    ...deps,
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

// ── phase A: the drain, and that it cannot be displaced ──────────────────

/**
 * These cases replace a describe block named "phase A discovery is capped, and
 * says so", whose three cap cases went with the cap (`#97`). What they asserted
 * is recorded here so the deletion is legible rather than silent:
 *
 *   - `derives only the 200 most-recently-updated rows and reports saturation` —
 *     250 rows in, ids 1..200 reached, 201..250 not, one `positionsTruncated`;
 *   - `is silent at 199 rows and speaks at exactly 200` — the `>=` boundary;
 *   - `signals ONCE across repeated ticks, not once per tick` — the latch.
 *
 * The first two described a behaviour that was the defect: a population over 200
 * was reported partial for ever, and the 50 rows it could not see were not
 * merely unreported but unreachable. The third moved to the phase-B budget,
 * which is the only saturation phase left, and the latch is unchanged.
 */
describe('reDerivePositionStatuses — phase A discovery is a keyset drain', () => {
  it('asks for the actionable delta ascending from its tip, one page', async () => {
    // The QUERY, not the answer — the predicate IS the mechanism (rule 3i).
    const sb = positionTables(buildTables(250));
    const hub = makeHub(sb);
    subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);

    const phaseA = sb.queries.filter((q) => q.table === 'positions')[0]!;
    const floor = new Date(NOW - 30_000).toISOString();
    expect(phaseA.or).toBe(
      `row_updated_at.gt.${floor},and(row_updated_at.eq.${floor},id.gt.0)`,
    );
    expect(phaseA.orders).toEqual([
      ['row_updated_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    expect(phaseA.limit).toBe(500);
    // Still the actionable filter, unchanged: the drain reads the same
    // population the snapshot enumerates.
    expect(phaseA.eq).toEqual(
      expect.arrayContaining([
        ['network', 'polygon'],
        ['user_address', ADDRESS],
        ['claimed', false],
      ]),
    );
    expect(phaseA.gt).toEqual([['risk_amount', 0]]);
  });

  it('does not report saturation at any population, where the window used to', async () => {
    // The deleted cap, from both sides of where it used to sit. 250 rows was one
    // `positionsTruncated`; 700 was another. Neither is now — and the negative
    // control that keeps this from passing on a build that cannot signal AT ALL
    // is in the phase-B block: the budget still speaks at 401 keys.
    for (const count of [199, 200, 250, 700]) {
      const sb = positionTables(buildTables(count));
      const hub = makeHub(sb);
      const rec = subscribeRecording(hub);
      await hub.pollWallet(ADDRESS);
      expect(rec.degradeds, `count=${String(count)}`).toEqual([]);
      expect(hub.stats().positionSaturationTotal, `count=${String(count)}`).toBe(0);
      expect(rec.resyncs, `count=${String(count)}`).toEqual([]);
    }
  });

  it('delivers a row inside the overlap and not one outside it', async () => {
    // The bound, stated as the pair where the two candidate rules disagree
    // (rule 3g-both). `now()` is TRANSACTION START, so a write can land a row
    // stamped before the tip; the overlap is what covers that, and its width is
    // what decides how stale a stamp may be. A single assertion on the inside
    // row would pass against a build with no floor at all.
    const tables = buildTables(0);
    pushRow(tables, 10, stampBefore(10)); //  inside  a 30s overlap
    pushRow(tables, 60, stampBefore(60)); // outside a 30s overlap
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);

    expect(rec.statuses.map((s) => s.id)).toEqual(['10']);
  });

  it('advances its tip only over rows it read, and re-floors from there', async () => {
    // Tip monotonicity, asserted at the CALL: a tick that read nothing must ask
    // the same question next time, and a tick that read something must ask from
    // the row it read. A tip advanced to "now" on an empty tick would skip every
    // row stamped in between.
    const tables = buildTables(0);
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);
    const first = sb.queries.filter((q) => q.table === 'positions')[0]!.or;
    await hub.pollWallet(ADDRESS);
    const second = sb.queries.filter((q) => q.table === 'positions')[1]!.or;
    expect(second).toBe(first); // nothing read ⇒ nothing moved

    pushRow(tables, 7, laterStamp(5));
    await hub.pollWallet(ADDRESS);
    const third = sb.queries.filter((q) => q.table === 'positions')[2]!.or;
    expect(third).toBe(first); // the row was read on THIS tick, so the floor is still the old one
    await hub.pollWallet(ADDRESS);
    const fourth = sb.queries.filter((q) => q.table === 'positions')[3]!.or;
    const movedFloor = new Date(Date.parse(laterStamp(5)) - 30_000).toISOString();
    expect(fourth).toBe(
      `row_updated_at.gt.${movedFloor},and(row_updated_at.eq.${movedFloor},id.gt.0)`,
    );
    expect(rec.statuses.map((s) => s.id)).toEqual(['7']);
  });

  it('pages a drain larger than one page, and loses nothing across the pages', async () => {
    // The page limit cuts the NEWEST rows, not the oldest, which is the whole
    // reason a cursor cannot be displaced where a `DESC` window can. Three pages
    // of two, all six rows delivered, ascending.
    const tables = buildTables(0);
    for (let n = 1; n <= 6; n += 1) pushRow(tables, n, laterStamp(n));
    const sb = positionTables(tables);
    const hub = makeHub(sb, { pollLimit: 2 });
    const rec = subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);

    expect(rec.statuses.map((s) => s.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(sb.queries.filter((q) => q.table === 'positions')).toHaveLength(4);
  });

  it('resyncs when the overlap window alone outruns the page budget', async () => {
    // The livelock guard, and it is the same condition and the same answer as
    // `pollCommitments` / `pollFills`: if one tick cannot get past its own
    // overlap floor, the tip never advances and every later tick re-reads the
    // same prefix. Forced with a 1-row page and a 1-page budget.
    const tables = buildTables(0);
    pushRow(tables, 1, stampBefore(20));
    pushRow(tables, 2, stampBefore(19));
    const sb = positionTables(tables);
    const hub = makeHub(sb, { pollLimit: 1, maxForwardPages: 1 });
    const rec = subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);

    expect(rec.resyncs).toEqual(['overlap_window_too_large']);
    // Not a degraded: the view is not partial, the tick could not make progress.
    expect(rec.degradeds).toEqual([]);
  });

  it('keeps going forward when the drain fills its budget ABOVE the tip', async () => {
    // The other side of the same condition, and it must NOT resync: rows above
    // the tip mean the tip advanced, so the next tick continues from there. A
    // build that treated any unexhausted drain as the livelock would turn every
    // burst into a reconnect.
    //
    // The budget here is 2 rows against 1 row inside the overlap, which is the
    // arithmetic that decides it: the drain re-reads its own overlap window out
    // of the SAME page budget, so progress needs a budget strictly greater than
    // the number of rows in that window. Production is 500 × 20 = 10,000 against
    // a whole-wallet population of 621 — the drain's result set is a subset of
    // the actionable set, so it cannot fill that budget at all until one wallet
    // holds more than 10,000 actionable rows. The sibling case above forces the
    // other outcome by making the budget 1.
    const tables = buildTables(0);
    for (const n of [1, 2, 3]) pushRow(tables, n, laterStamp(n));
    const sb = positionTables(tables);
    const hub = makeHub(sb, { pollLimit: 1, maxForwardPages: 2 });
    const rec = subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);
    expect(rec.resyncs).toEqual([]);
    expect(rec.statuses.map((s) => s.id)).toEqual(['1', '2']);

    await hub.pollWallet(ADDRESS);
    expect(rec.resyncs).toEqual([]);
    expect(rec.statuses.map((s) => s.id)).toEqual(['1', '2', '3']);
  });

  it('delivers a 700-row burst in one tick, under the real page budget', async () => {
    // The bulk-stamp case, which is not hypothetical: `ospex-indexer` migrations
    // 025 and 026 each stamped every eligible positions row with one `now()`, and
    // any future positions-touching migration does the same. Every row lands
    // above every subscriber's tip at once, so the drain reads the wallet's whole
    // population on that tick and nothing afterwards — bounded, once, and with no
    // degraded frame, where the 200-row window would have reported truncation for
    // ever afterwards.
    const tables = buildTables(0);
    for (let n = 1; n <= 700; n += 1) pushRow(tables, n, laterStamp(n));
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);

    expect(rec.statuses).toHaveLength(700);
    expect(rec.degradeds).toEqual([]);
    expect(rec.resyncs).toEqual([]);
    // 500 then 200: paged, and the second page is short so the drain exhausts.
    expect(sb.queries.filter((q) => q.table === 'positions')).toHaveLength(2);
  });

  it('discovers a row that RE-ENTERS the actionable set under an old id', async () => {
    // The case that decides the mechanism. `#97` weighed a keyset probe above
    // the highest id the cache has seen; `rpc_position_matched_pair`'s accumulate
    // branch takes a transferred-out row's `risk_amount` from 0 back to positive,
    // and `INSERT … ON CONFLICT DO UPDATE` consumes sequence values so ids are
    // sparse — so the row re-enters the population under an id BELOW the
    // watermark and an id probe cannot see it. Every entry is an UPDATE, so the
    // trigger stamps it, so a timestamp cursor can.
    const tables = buildTables(0);
    pushRow(tables, 1, laterStamp(1));
    pushRow(tables, 2, laterStamp(2));
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    // id 1 is out of the population: transferred out, risk 0.
    tables.positions[0]!['risk_amount'] = '0';

    await hub.pollWallet(ADDRESS);
    expect(rec.statuses.map((s) => s.id)).toEqual(['2']);

    // …and back in, at the same id, stamped now.
    tables.positions[0]!['risk_amount'] = '10000';
    tables.positions[0]!['row_updated_at'] = laterStamp(9);
    await hub.pollWallet(ADDRESS);

    expect(rec.statuses.map((s) => s.id)).toEqual(['2', '1']);
  });


  it('admits a row stamped EXACTLY at the overlap floor', async () => {
    // The floor is `(ts > floor) OR (ts = floor AND id > 0)`, and the second half
    // is not decoration: `rpc_position_matched_pair` stamps its maker and taker
    // rows with one `now()`, so rows sharing an instant are the normal case, and
    // the instant that matters is the boundary one. A strict tuple comparison
    // against a synthetic id would drop every row at exactly the floor.
    const tables = buildTables(0);
    const atFloor = `${new Date(NOW - 30_000).toISOString().replace('Z', '')}000+00:00`;
    pushRow(tables, 1, atFloor);
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);

    // SETUP: the fixture sits ON the boundary, not near it (rule 3g).
    const floorAsked = /row_updated_at\.gt\.([^,]+),/.exec(
      sb.queries.filter((q) => q.table === 'positions')[0]!.or!,
    )![1]!;
    expect(Date.parse(atFloor)).toBe(Date.parse(floorAsked));
    expect(rec.statuses.map((s) => s.id)).toEqual(['1']);
  });

  it('bails the whole tick when the drain read fails, and does not move the tip', async () => {
    // A failed read must not look like an empty one. If it did, every non-frozen
    // cached key would be "not in phase A's result" and the tick would re-fetch
    // the entire work-list by identity on a wallet whose upstream is already
    // failing — and a tip advanced past rows nobody read would skip them for good.
    const tables = buildTables(5);
    let failNext = true;
    const sb = positionTables(tables, (q, _n, reply) => {
      if (q.table === 'positions' && failNext) {
        failNext = false;
        return { data: null, error: { message: 'PGRST500 upstream said no' } };
      }
      return reply;
    });
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    seedAll(hub, [1, 2, 3, 4, 5]);

    await hub.pollWallet(ADDRESS);

    // One read, and nothing after it: no phase-B page, no speculations join, no
    // contests join, no emission.
    expect(sb.queries).toHaveLength(1);
    expect(rec.statuses).toEqual([]);
    expect(rec.resyncs).toEqual([]);

    // …and the next tick asks the SAME question, because the tip never moved.
    await hub.pollWallet(ADDRESS);
    const asked = sb.queries.filter((q) => q.table === 'positions').map((q) => q.or);
    expect(asked[1]).toBe(asked[0]);
  });

  it('recognises a tip that advanced by MICROSECONDS inside one millisecond', async () => {
    // `compareIsoTimestamptz` rather than `Date.parse` in `afterTip`. The floor is
    // millisecond-grained either way, so a coarse comparison loses no rows — it
    // loses the answer to "did the tip advance", which is what separates "there is
    // more above the tip" from "this tick could not get past its own overlap". The
    // discriminating shape: the later row carries a LOWER id, so the id tiebreak
    // cannot rescue a millisecond comparison.
    // The budget is two rows and one page, so tick 2 reads BOTH rows and comes
    // back full — unexhausted, with the tip advanced by microseconds only. That
    // is the one state where the two comparisons disagree about what to do.
    const ms = new Date(NOW + 60_000).toISOString().replace('000Z', '');
    const tables = buildTables(0);
    pushRow(tables, 9, `${ms}000456+00:00`);
    const sb = positionTables(tables);
    const hub = makeHub(sb, { pollLimit: 2, maxForwardPages: 1 });
    const rec = subscribeRecording(hub);

    await hub.pollWallet(ADDRESS);
    expect(rec.statuses.map((s) => s.id)).toEqual(['9']);

    // Same millisecond, 333µs later, id 5 — which sorts AFTER id 9 by timestamp
    // and BEFORE it by id.
    pushRow(tables, 5, `${ms}000789+00:00`);
    await hub.pollWallet(ADDRESS);

    // SETUP: the two stamps really are inside one millisecond, or this case is
    // about something else entirely.
    expect(Date.parse(`${ms}000456+00:00`)).toBe(Date.parse(`${ms}000789+00:00`));
    expect(rec.statuses.map((s) => s.id)).toEqual(['9', '5']);
    // The tick was unexhausted (one row, one page), and the tip DID advance, so
    // there is nothing to resync about.
    expect(rec.resyncs).toEqual([]);
  });

  it('starts a fresh poller once the last subscriber leaves', () => {
    // The poller — and with it both the observability latch and the
    // per-subscriber delivery set — dies with the last subscriber. That is what
    // makes "reconnect to clear it" honest. The harder case, a subscriber
    // joining a poller that is still alive and already latched, is pinned
    // separately below (review blocker B2).
    const sb = positionTables(buildTables(250));
    const hub = makeHub(sb);
    const first = subscribeRecording(hub);
    hub.unsubscribe(first.sub);
    const second = subscribeRecording(hub);
    expect(second.degradeds).toEqual([]);
    expect(hub.stats().wallets).toBe(1);
  });
});

describe('reDerivePositionStatuses — phase B maintains tracked keys deterministically', () => {
  it('delivers a transition the drain cannot see, because the position row never moved', async () => {
    // The acceptance case from `#83`, restated for `#97`: the transition happens
    // on a parent, so `positions.row_updated_at` does not move and the discovery
    // drain returns NOTHING. Phase B owes the event — and delivers it.
    //
    // Under the old phase A this case had to reach for a row outside the 200-row
    // recency window to be attributable to phase B. It no longer does, and that
    // is the point: the drain sees CHANGED POSITION ROWS, so a parent-driven
    // transition is phase B's by construction rather than by fixture size.
    const tables = buildTables(250, {
      250: { specStatus: 'closed', winSide: 'away' },
    });
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    seedAll(hub, Array.from({ length: 250 }, (_, i) => i + 1));

    await hub.pollWallet(ADDRESS);

    // SETUP FIRST (rule 3g-silentsetup). The drain read nothing — every fixture
    // row is stamped minutes before the tip — so a delivery below is phase B's
    // and cannot be "the fixture was small enough".
    const phaseA = sb.queries.filter((q) => q.table === 'positions')[0]!;
    expect(phaseA.or).toContain('row_updated_at.gt.');
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
    // 250 seeded keys and a drain that returned nothing, so all 250 are phase
    // B's: three pages of 100/100/50. Under the old phase A the first 200 were
    // subtracted by the recency window and this was one page of 50 — the whole
    // live work-list now lands here, which is the number `#97` moved and the
    // reason the seed's `terminal` flag went from an optimisation to a
    // requirement.
    expect(lists).toHaveLength(3);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(lists.flat()).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    for (const q of phaseBQueries(sb.queries)) {
      expect(q.orders).toEqual([['id', { ascending: true }]]);
      const ids = (q.joins.find(([c]) => c === 'speculation_id')?.[1] ?? []) as number[];
      // 2N + 1: the SENTINEL row. `2N` is the legal maximum (two sides per
      // speculation per wallet), so asking for exactly 2N and calling 2N a
      // truncation condemns the legal maximum — review blocker B3.
      expect(q.limit).toBe(ids.length * 2 + 1);
    }
  });

  it('reports its own budget, and is silent one key below it', async () => {
    // The boundary, both sides, and it is the only saturation the derivation has
    // left. It is also the negative control for deleting phase A's cap: a build
    // that lost the ability to signal AT ALL passes the phase-A cases above and
    // fails here.
    //
    // The table holds 10 rows and the CACHE holds the rest, so the phase-B budget
    // is the only thing that can produce a signal (rule 3b). The 10 table rows are
    // stamped before the tip, so the drain subtracts nothing from the work-list —
    // which is why these numbers are 400/401 where the window-era version of this
    // case needed 410/500.
    for (const [seeded, expected] of [
      [400, [] as string[]],
      [401, ['positionsTruncated']],
    ] as const) {
      const sb = positionTables(buildTables(10));
      const hub = makeHub(sb);
      const rec = subscribeRecording(hub);
      seedAll(hub, Array.from({ length: seeded }, (_, i) => i + 1));

      await hub.pollWallet(ADDRESS);

      const lists = phaseBIdLists(sb.queries);
      expect(lists.flat().length, `seeded=${String(seeded)}`).toBe(400);
      expect(rec.degradeds, `seeded=${String(seeded)}`).toEqual(expected);
    }
  });

  it('refuses to exceed its page budget, and reports that instead of truncating', async () => {
    // 700 seeded keys against a 4 × 100 budget. The 300 uncovered keys are exactly
    // what the old single `.limit(200)` returned an unspecified subset of,
    // silently.
    const sb = positionTables(buildTables(700));
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    seedAll(hub, Array.from({ length: 700 }, (_, i) => i + 1));

    await hub.pollWallet(ADDRESS);

    const lists = phaseBIdLists(sb.queries);
    expect(lists).toHaveLength(4);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 100, 100]);
    // The covered prefix is specified: ids 1..400, ascending.
    expect(lists.flat()).toEqual(Array.from({ length: 400 }, (_, i) => i + 1));
    expect(rec.degradeds).toEqual(['positionsTruncated']);
  });

  it('lists a two-sided speculation ONCE, so the sentinel keeps its margin', async () => {
    // The work-list is keyed per POSITION and the read is keyed per SPECULATION.
    // Listing one speculation twice costs a chunk slot and doubles that chunk's
    // `legalMax`, which raises the bar the illegal row has to clear and blunts the
    // only check that can prove the uniqueness assumption wrong (B3's sentinel).
    // Phase A used to hide this by returning both rows; with a delta it does not.
    const tables = buildTables(1);
    tables.positions.push({
      ...tables.positions[0]!,
      id: 2,
      position_type: 'lower',
    } satisfies Row);
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    subscribeRecording(hub);
    hub.seedStatusCache(ADDRESS, [
      { key: '1_0', status: 'active', sourceUpdatedAt: stampFor(1) },
      { key: '1_1', status: 'active', sourceUpdatedAt: stampFor(1) },
    ]);

    await hub.pollWallet(ADDRESS);

    const lists = phaseBIdLists(sb.queries);
    expect(lists).toEqual([[1]]);
    expect(phaseBQueries(sb.queries)[0]!.limit).toBe(3);
  });

  it('costs the same per tick at ten times the history', async () => {
    // `.claude/rules/production-cost-review.md`: assert the per-tick COST, not
    // just the result, and assert it at two history sizes. The live delta is one
    // row and the live work-list is two keys in both runs; everything else is
    // finished history, which is what grows and what must not be paid for.
    const measure = async (history: number): Promise<{ queries: number; rows: number }> => {
      const finished: Record<number, PositionSpec> = {};
      for (let id = 3; id <= history; id += 1) {
        finished[id] = { specStatus: 'closed', winSide: 'home', contestStatus: 'scored', awayScore: 1, homeScore: 7 };
      }
      const tables = buildTables(history, finished);
      const sb = positionTables(tables);
      const hub = makeHub(sb);
      subscribeRecording(hub);
      hub.seedStatusCache(
        ADDRESS,
        Array.from({ length: history }, (_, i) => ({
          key: `${String(i + 1)}_0`,
          status: (i < 2 ? 'active' : 'settledLost') as 'active',
          sourceUpdatedAt: stampFor(i + 1),
          // The finished rows arrive retired, which is what `#96` bought and what
          // keeps this measurement flat.
          terminal: i >= 2,
        })),
      );

      await hub.pollWallet(ADDRESS);
      const before = sb.queries.length;
      const rowsBefore = sb.queries.reduce((n, q) => n + (q.rowsReturned ?? 0), 0);
      // …then one row changes, and the SECOND tick is the one measured.
      tables.positions[0]!['row_updated_at'] = laterStamp(1);
      await hub.pollWallet(ADDRESS);
      return {
        queries: sb.queries.length - before,
        rows: sb.queries.reduce((n, q) => n + (q.rowsReturned ?? 0), 0) - rowsBefore,
      };
    };

    const small = await measure(40);
    const large = await measure(400);
    expect(large).toEqual(small);
    // And the absolute numbers, so a regression that inflates BOTH is visible:
    // the drain, one phase-B chunk, the speculations join and the contests join.
    expect(small.queries).toBe(4);
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

  it('retires a loser that never emits, which is the shape production actually takes', async () => {
    // Found by a SURVIVING mutant: deleting the retirement on the non-emitting
    // branch changed nothing, because every other case here seeds `active` and
    // then watches the row transition — so the emission path did the retiring.
    //
    // Production does the opposite. The cold-start seed comes from the SAME
    // derivation the snapshot published (`loadOwnStateSnapshot` returns
    // `seedRows`), so a settled loser is seeded with the status it already has,
    // the first tick finds no change, and NOTHING emits. That makes the
    // non-emitting branch the only path by which the 86% of rows this change
    // exists to retire ever get retired.
    const sb = positionTables(buildTables(205, { 205: { specStatus: 'closed', winSide: 'home' } }));
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    seedAll(hub, Array.from({ length: 204 }, (_, i) => i + 1));
    // Key 205 seeded at its ALREADY-DERIVED state, fields included, so the
    // dedup comparison matches on all four and suppresses the event.
    hub.seedStatusCache(ADDRESS, [
      {
        key: '205_0',
        status: 'settledLost',
        sourceUpdatedAt: stampFor(205),
        result: 'lost',
      },
    ]);

    await hub.pollWallet(ADDRESS);

    // SETUP FIRST: prove we are on the non-emitting branch. If anything emitted
    // for 205, the emission path could be doing the retiring and the assertion
    // below would pass for the wrong reason (rule 3b).
    expect(rec.statuses).toEqual([]);
    expect(phaseBIdLists(sb.queries).flat()).toContain(205);

    const before = sb.queries.length;
    await hub.pollWallet(ADDRESS);
    expect(phaseBIdLists(sb.queries.slice(before)).flat()).not.toContain(205);
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

describe('reDerivePositionStatuses — the saturation signal reaches every connection', () => {
  /**
   * 401 non-frozen cached keys against a 400-key phase-B budget: one key over,
   * on every tick. These two cases were anchored on phase A's 200-row cap until
   * `#97` deleted it; the budget is the saturation that is left, and the latch
   * behaviour under test never depended on which phase raised it.
   */
  const overBudget = 401;

  it('tells a subscriber that joined a poller ALREADY latched, and does not re-tell the first', async () => {
    // Review blocker B2. The poller outlives the connection that first
    // saturated it, so a per-POLLER latch on delivery meant a later subscriber
    // was silenced by a signal sent to someone else. The reviewer's shape: the
    // first subscriber saturates, a second subscriber connects on a view that was
    // complete at the time, and the derivation saturates again. The second
    // connection has to hear about that, and the first must not hear it twice.
    const sb = positionTables(buildTables(10));
    const hub = makeHub(sb);
    const first = subscribeRecording(hub);
    seedAll(hub, Array.from({ length: overBudget }, (_, i) => i + 1));

    await hub.pollWallet(ADDRESS);
    expect(first.degradeds).toEqual(['positionsTruncated']);

    // SETUP: the poller survives (first is still subscribed) and is latched.
    expect(hub.stats().wallets).toBe(1);
    expect(hub.stats().positionSaturationTotal).toBe(1);

    const second = subscribeRecording(hub);
    expect(second.degradeds).toEqual([]);

    await hub.pollWallet(ADDRESS);

    expect(second.degradeds).toEqual(['positionsTruncated']);
    // The first is NOT re-notified: delivery is once per subscriber, and a
    // re-notified maker would re-run its cancel sweep every 1.5s.
    expect(first.degradeds).toEqual(['positionsTruncated']);
    // And the observability half stays deduped per poller — the counter is a
    // count of EPISODES, not of notifications, so it must not move.
    expect(hub.stats().positionSaturationTotal).toBe(1);
  });

  it('retries a subscriber whose onDegraded threw, instead of marking it told', async () => {
    // The same lesson B1 taught the handler, applied here: mark it sent when it
    // was actually sent. A consumer callback that throws has not been told.
    const sb = positionTables(buildTables(10));
    const hub = makeHub(sb);
    let calls = 0;
    const seen: string[] = [];
    hub.subscribe(ADDRESS, {
      onCommitment: () => undefined,
      onFill: () => undefined,
      onPositionStatus: () => undefined,
      onResync: () => undefined,
      onDegraded: (reason) => {
        calls += 1;
        if (calls === 1) throw new Error('consumer blew up');
        seen.push(reason);
      },
    });
    seedAll(hub, Array.from({ length: overBudget }, (_, i) => i + 1));

    await hub.pollWallet(ADDRESS);
    expect(calls).toBe(1);
    expect(seen).toEqual([]);

    await hub.pollWallet(ADDRESS);
    expect(seen).toEqual(['positionsTruncated']);
  });
});

describe('reDerivePositionStatuses — a full legal page is not a truncated one', () => {
  /**
   * One speculation, both sides, the lower one already claimed.
   *
   * A closed PUSH pays both sides, so this is ordinary on-chain state. And the
   * claimed row is what makes the shape reachable at ANY population size: it
   * fails phase A's `claimed=false` filter, so its key is a stale key and phase
   * B is what asks for the speculation — which means the page carries 2 rows for
   * a 1-id chunk, the exact legal maximum.
   *
   * Deliberately ONE speculation, well under phase A's 200-row cap: a fixture
   * large enough to saturate phase A reports truncation for a different reason
   * and cannot tell whether the page bound is right (rule 3b). My first attempt
   * used 205 rows and did exactly that.
   */
  function pushBothSides(extraLowerRows = 0): Tables {
    const tables = buildTables(1, {
      1: { specStatus: 'closed', winSide: 'push', contestStatus: 'scored', awayScore: 10, homeScore: 10 },
    });
    const upper = tables.positions[0]!;
    for (let n = 0; n <= extraLowerRows; n += 1) {
      tables.positions.push({ ...upper, id: 100 + n, position_type: 'lower', claimed: true });
    }
    return tables;
  }

  function seedBothSides(hub: InstanceType<typeof OwnStateHub>): void {
    // Both sides at their already-derived state, so the only event this tick can
    // produce is the claim on the lower side.
    for (const key of ['1_0', '1_1']) {
      hub.seedStatusCache(ADDRESS, [
        {
          key,
          status: 'claimable',
          sourceUpdatedAt: stampFor(1),
          result: 'push',
          claimableAmount: '10000',
        },
      ]);
    }
  }

  it('accepts exactly two sides of one speculation without calling it saturation', async () => {
    // Review blocker B3, and the reason no test here caught it: `buildTables`
    // builds ONE side per speculation, so a chunk of N ids returned N rows and
    // the legal maximum of 2N never appeared. The old bound asked for exactly 2N
    // and treated 2N as overflow, so a closed push with the upper side claimable
    // and the lower side just claimed reported truncation on a page that had
    // omitted nothing — and that can put the market maker on quote hold.
    const sb = positionTables(pushBothSides());
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    seedBothSides(hub);

    await hub.pollWallet(ADDRESS);

    // SETUP FIRST (rule 3g-silentsetup). Phase A is nowhere near its cap, phase B
    // asked for this one speculation, and the page came back FULL — so the
    // absence of a signal below is about the bound and not about a short chunk.
    const phaseA = sb.queries.filter((q) => q.table === 'positions')[0]!;
    expect(phaseA.joins).toEqual([]);
    const phaseB = phaseBQueries(sb.queries)[0]!;
    expect(phaseB.joins).toEqual([['speculation_id', [1]]]);
    expect(phaseB.limit).toBe(1 * 2 + 1); // the sentinel: one more than can exist

    expect(rec.statuses).toEqual([{ id: '100', status: 'claimed' }]);
    expect(rec.degradeds).toEqual([]);
    expect(hub.stats().positionSaturationTotal).toBe(0);
  });

  it('still reports a page that exceeds the legal maximum', async () => {
    // The negative control, and it needs an ILLEGAL fixture: a THIRD row on one
    // (speculation, wallet, side) triple, which the unique key forbids. Without
    // it the sentinel row is untested in the direction it exists for, and a build
    // that deleted the overflow check entirely would pass everything above.
    const sb = positionTables(pushBothSides(1));
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    seedBothSides(hub);

    await hub.pollWallet(ADDRESS);

    expect(rec.degradeds).toEqual(['positionsTruncated']);
    expect(hub.stats().positionSaturationTotal).toBe(1);
  });
});

// ── #76 foundation: a seed that carries retirement and coverage ───────────

describe('seedStatusCache — the seed carries what the deriving read already knew', () => {
  /** 205 rows, so ids 201..205 sit outside phase A's window and land in phase B. */
  function tables(): Tables {
    return buildTables(205, {
      205: { specStatus: 'closed', winSide: 'home' }, // upper loses ⇒ settledLost
    });
  }

  it('retires a terminal key at SEED time, so phase B never asks for it', async () => {
    // The flag comes from `fetchCategorizedPositions`, which computed it over the
    // same join that produced the status. Before this, the seed arrived live and
    // the FIRST TICK had to retire it — affordable at 200 seeded keys and not at
    // 635, where the stale set exceeds phase B's budget and the tick reports
    // saturation for rows it was about to retire.
    const sb = positionTables(tables());
    const hub = makeHub(sb);
    subscribeRecording(hub);
    seedAll(hub, Array.from({ length: 204 }, (_, i) => i + 1));
    hub.seedStatusCache(ADDRESS, [
      { key: '205_0', status: 'settledLost', sourceUpdatedAt: stampFor(205), result: 'lost', terminal: true },
    ]);

    await hub.pollWallet(ADDRESS);

    expect(phaseBIdLists(sb.queries).flat()).not.toContain(205);
  });

  it('keeps asking when the deriving read said the key is still live', async () => {
    // The negative control for the same field. Identical fixture, identical
    // status, `terminal: false` — so only the flag decides, and a build that
    // ignored it would pass the case above and fail here.
    const sb = positionTables(tables());
    const hub = makeHub(sb);
    subscribeRecording(hub);
    seedAll(hub, Array.from({ length: 204 }, (_, i) => i + 1));
    hub.seedStatusCache(ADDRESS, [
      { key: '205_0', status: 'settledLost', sourceUpdatedAt: stampFor(205), result: 'lost', terminal: false },
    ]);

    await hub.pollWallet(ADDRESS);

    expect(phaseBIdLists(sb.queries).flat()).toContain(205);
  });

  it('treats an omitted flag as live, so an unaware caller keeps the old behaviour', async () => {
    const sb = positionTables(tables());
    const hub = makeHub(sb);
    subscribeRecording(hub);
    seedAll(hub, Array.from({ length: 205 }, (_, i) => i + 1));

    await hub.pollWallet(ADDRESS);

    expect(phaseBIdLists(sb.queries).flat()).toContain(205);
  });
});

describe('reDerivePositionStatuses — discovery coverage is not assumed', () => {
  /**
   * A relaxation was tried in `#96` and withdrawn under review: with a seed known
   * to cover the whole actionable population, suppress the saturation signal when
   * a full recency page contains only known keys. The cases that shipped with it
   * were STATIC — a complete seed, one poll, nothing moving — and a static fixture
   * cannot see the hole, which is entirely about what happens BETWEEN polls. They
   * were replaced by the counterexample, kept as a regression guard.
   *
   * `#97` answers that counterexample, so the guard has been REWRITTEN rather than
   * deleted, and its previous expectations are quoted below where they changed.
   * Both cases still change the fixture between polls, which is the property the
   * withdrawn version lacked.
   */

  it('DELIVERS a new row that churn on known keys pushed out of the recency window', async () => {
    // THE counterexample, inverted. 199 actionable rows — inside the old cap, so
    // this never depended on `#76`'s future seed. One new position arrives, and
    // then 200 already-known positions take newer `row_updated_at` values before
    // the next tick. Under the recency window the new row entered at the head AT
    // ITS WRITE and was below the window's floor at the READ, so phase A could not
    // see it and phase B never asked; the tick reported a full page and the row was
    // never delivered.
    //
    // WHAT CHANGED, quoted from the version this replaces:
    //     expect(rec.statuses.some((s) => s.id === '201')).toBe(false);
    //     expect(rec.degradeds).toEqual(['positionsTruncated']);
    //     expect(hub.stats().positionSaturationTotal).toBe(1);
    // Both of those were labelled "current behaviour", and the block comment said
    // a relaxation must answer this scenario by DELIVERING the row or by PROVING
    // nothing was skipped. A keyset drain delivers it: ascending from the tip, key
    // 201 sorts BEFORE the 200 rows that displaced it, and a page limit cuts the
    // newest rows rather than the oldest.
    const tables = buildTables(199);
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    seedAll(hub, Array.from({ length: 199 }, (_, i) => i + 1));

    // A tick with nothing moving: no signal, no delivery, and the control that
    // proves the fixture starts clean.
    await hub.pollWallet(ADDRESS);
    expect(rec.degradeds).toEqual([]);
    expect(rec.statuses).toEqual([]);

    // One key transfers its stake out and one new key arrives, so the population
    // stays at 199 actionable while the cache legitimately tracks 200 identities.
    tables.positions[0]!['risk_amount'] = '0';
    tables.positions[0]!['row_updated_at'] = laterStamp(1);
    pushRow(tables, 200, laterStamp(1));
    await hub.pollWallet(ADDRESS);
    expect(rec.statuses.some((s) => s.id === '200')).toBe(true);
    expect(rec.degradeds).toEqual([]);

    // BETWEEN polls: the unseen key 201 arrives, and THEN all 200 known keys take
    // newer timestamps — including the zero-risk key coming back.
    pushRow(tables, 201, laterStamp(2));
    for (const p of tables.positions) {
      if (Number(p['id']) <= 200) {
        p['risk_amount'] = '11000';
        p['row_updated_at'] = laterStamp(3);
      }
    }

    await hub.pollWallet(ADDRESS);

    // SETUP FIRST (rule 3g-silentsetup): the displacement really happened, or the
    // assertion below is about a different situation than the one named. 200 rows
    // carry a stamp NEWER than key 201's, which is what put it outside a 200-row
    // recency window and is the whole scenario.
    const newerThan201 = tables.positions.filter(
      (p) => String(p['row_updated_at']) > laterStamp(2),
    );
    expect(newerThan201).toHaveLength(200);
    expect(tables.positions.filter((p) => p['risk_amount'] !== '0')).toHaveLength(201);

    // Delivered, in one tick, with no degraded frame and no saturation episode.
    expect(rec.statuses.some((s) => s.id === '201')).toBe(true);
    expect(rec.degradeds).toEqual([]);
    expect(hub.stats().positionSaturationTotal).toBe(0);
    // And delivered in its own place in the order — key 201's stamp is older than
    // the 200 that displaced it, so it comes FIRST. That ordering is what makes a
    // mid-tick disconnect safe: the cursor cannot advance past an undelivered
    // earlier-source event.
    const tickStatuses = rec.statuses.slice(-201);
    expect(tickStatuses[0]!.id).toBe('201');
  });

  it('keeps the whole population off phase B when the seed says it is finished', async () => {
    // The payoff of the retirement flag, at the size of the market maker's own
    // wallet. 635 keys seeded as settled losers on closed speculations — 570 of
    // maker-a's 621 actionable rows are exactly that. Before the flag reached the
    // seed, the first tick spent all four phase-B pages, covered 400 of 435 stale
    // keys and latched a signal it was about to stop needing.
    //
    // WHAT CHANGED, quoted from the version this replaces:
    //     // Reported, because a full page is still saturation until `#97` can
    //     // prove otherwise. That is why `#76`'s complete snapshot waits on `#97`.
    //     expect(rec.degradeds).toEqual(['positionsTruncated']);
    // This is the case `#76` is blocked on, so it is the one that had to change:
    // a seed that covers the whole population now produces a tick that reads the
    // delta, maintains the live keys, and says nothing. The maintenance-cost
    // assertion is unchanged — zero phase-B queries, not four.
    const t: Tables = { positions: [], speculations: [], contests: [] };
    for (let id = 1; id <= 635; id += 1) {
      const one = buildTables(1, { 1: { specStatus: 'closed', winSide: 'home' } });
      t.positions.push({ ...one.positions[0]!, id, speculation_id: id, row_updated_at: stampFor(id), position_created_at: stampFor(id) });
      t.speculations.push({ ...one.speculations[0]!, speculation_id: id, contest_id: id, row_updated_at: stampFor(id) });
      t.contests.push({ ...one.contests[0]!, contest_id: id, row_updated_at: stampFor(id) });
    }
    const sb = positionTables(t);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    hub.seedStatusCache(
      ADDRESS,
      Array.from({ length: 635 }, (_, i) => ({
        key: `${String(i + 1)}_0`,
        status: 'settledLost' as const,
        sourceUpdatedAt: stampFor(i + 1),
        result: 'lost' as const,
        terminal: true,
      })),
    );

    await hub.pollWallet(ADDRESS);

    expect(phaseBIdLists(sb.queries)).toEqual([]);
    expect(rec.statuses).toEqual([]);
    expect(rec.degradeds).toEqual([]);
    expect(hub.stats().positionSaturationTotal).toBe(0);
    // One statement for the whole tick: the drain, which read nothing. No spec or
    // contest join either, because there was nothing to join.
    expect(sb.queries).toHaveLength(1);
    expect(sb.queries[0]!.rowsReturned).toBe(0);
  });

  it('still reports a capped SEED, because that is the snapshot leg and it is unchanged', async () => {
    // The negative control the issue asks for: a wallet whose seed was capped must
    // keep the conservative treatment. It does, and NOT from here — the hub cannot
    // know what the snapshot read, and after `#97` it no longer guesses from its
    // own page being full. The signal comes from `positionsTruncated`, minted in
    // `snapshot.ts` when the seed's own actionable read hits its cap and emitted by
    // the handler before `ready`; `tests/ownState-stream.test.ts` pins that frame.
    //
    // What this case pins is the half that lives here: an incomplete cache means
    // phase B maintains only what it was told about, and the hub adds no second
    // signal of its own. Key 500 exists, is actionable, was never seeded, and its
    // speculation settles without touching the position row — so nothing delivers
    // it, and nothing claims otherwise.
    const tables = buildTables(500, { 500: { specStatus: 'closed', winSide: 'away' } });
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);
    // A capped seed: the 200 the snapshot would have returned.
    seedAll(hub, Array.from({ length: 200 }, (_, i) => i + 1));

    await hub.pollWallet(ADDRESS);

    expect(rec.statuses).toEqual([]);
    expect(rec.degradeds).toEqual([]);
    // …and the moment the row is touched, the drain does deliver it, which is why
    // an incomplete cache degrades gracefully rather than permanently.
    tables.positions[499]!['row_updated_at'] = laterStamp(1);
    await hub.pollWallet(ADDRESS);
    expect(rec.statuses).toEqual([{ id: '500', status: 'claimable' }]);
  });
});

// ── what makes a discarded write harmless, and a retirement safe at scale ──

describe('reDerivePositionStatuses — the emission loop, pinned', () => {
  it('delivers every emission to EVERY subscriber, even when one stops accepting', async () => {
    // The hub advances `statusCache` BEFORE the subscriber callback, and the
    // handler's write is discarded silently once the response has ended
    // (`writeEvent` returns on `res.writableEnded`). I filed `#94` on the reading
    // that this loses rows for a surviving subscriber on the same poller.
    //
    // PROBED, AND IT DOES NOT. The loop is
    //   for (const e of emissions) { cache.set(e); for (const sub of subs) deliver(e) }
    // so every subscriber receives every emission in the SAME iteration. A
    // subscriber can only miss a row if its OWN response ended, and then it is
    // being torn down: its `'close'` handler unsubscribes, the last subscriber
    // leaving destroys the poller AND its cache, and a reconnect re-seeds from a
    // fresh snapshot that also delivers the rows. `#94` was closed as not
    // reachable rather than fixed.
    //
    // WHAT THIS PINS, stated after a reviewer corrected an earlier overclaim
    // here. It is NOT the loop's nesting order: transposing to
    // subscriber-first — cache every emission, then fan out per subscriber —
    // passes all 25 cases in this file, measured rather than assumed. What it
    // pins is the pair of properties that actually make a discarded write
    // harmless: COMPLETE FAN-OUT (every subscriber receives every emission of the
    // tick) and EXCEPTION ISOLATION (see the sibling case below). A refactor that
    // made delivery early-terminating would break one of those and go red here;
    // one that merely reordered the loops would not, and should not.
    const sb = positionTables(liveTables(6, Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [i + 1, { specStatus: 'closed' as const, winSide: 'away' }]),
    )));
    const hub = makeHub(sb);

    // A accepts three events and then discards, exactly as a shed socket does.
    const aTook: string[] = [];
    hub.subscribe(ADDRESS, {
      onCommitment: () => undefined,
      onFill: () => undefined,
      onResync: () => undefined,
      onDegraded: () => undefined,
      onPositionStatus: (_body, _ts, id) => {
        if (aTook.length < 3) aTook.push(id);
      },
    });
    // B is healthy, on the SAME poller.
    const bTook: string[] = [];
    hub.subscribe(ADDRESS, {
      onCommitment: () => undefined,
      onFill: () => undefined,
      onResync: () => undefined,
      onDegraded: () => undefined,
      onPositionStatus: (_body, _ts, id) => {
        bTook.push(id);
      },
    });

    await hub.pollWallet(ADDRESS);

    // SETUP FIRST: A really did stop accepting partway through a multi-row
    // emission, or there is nothing for B's completeness to be robust against.
    expect(aTook).toHaveLength(3);
    expect(bTook).toHaveLength(6);
    expect([...bTook].sort()).toEqual(['1', '2', '3', '4', '5', '6']);

    // And the cache is now correct for B: a second tick with nothing changed
    // emits nothing, which is the same statement as "B is not owed anything".
    const before = bTook.length;
    await hub.pollWallet(ADDRESS);
    expect(bTook).toHaveLength(before);
  });

  it('keeps delivering to a sibling when one subscriber THROWS', async () => {
    // The other half of `#94`: a callback that throws is logged and the cache has
    // already advanced. Same answer, same reason — the sibling was served in the
    // same iteration, before and after the throw.
    const sb = positionTables(liveTables(4, Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [i + 1, { specStatus: 'closed' as const, winSide: 'away' }]),
    )));
    const hub = makeHub(sb);
    hub.subscribe(ADDRESS, {
      onCommitment: () => undefined,
      onFill: () => undefined,
      onResync: () => undefined,
      onDegraded: () => undefined,
      onPositionStatus: () => {
        throw new Error('consumer blew up');
      },
    });
    const bTook: string[] = [];
    hub.subscribe(ADDRESS, {
      onCommitment: () => undefined,
      onFill: () => undefined,
      onResync: () => undefined,
      onDegraded: () => undefined,
      onPositionStatus: (_body, _ts, id) => {
        bTook.push(id);
      },
    });

    await hub.pollWallet(ADDRESS);

    expect([...bTook].sort()).toEqual(['1', '2', '3', '4']);
  });
});

describe('reDerivePositionStatuses — retirement at population scale', () => {
  it('retires the finished rows and keeps maintaining every live kind behind the window', async () => {
    // Adopted from the maintainer's external reviewer on PR #96, because it covers
    // the main hazard of the retirement flag — OVER-retiring — at a scale and in a
    // mixture the per-branch cases cannot. Four live kinds sit behind the recency
    // window among 635 finished rows, and the flag comes from the REAL producer
    // rather than from the test.
    //
    // The last assertion is the one worth having: phase B's work-list SHRINKS as
    // two of the four become terminal during the session, which proves retirement
    // is dynamic and not merely seeded.
    const tables = buildTables(635, {
      // Every row closed against this position's side => settledLost, finished.
      ...Object.fromEntries(
        Array.from({ length: 635 }, (_, i) => [i + 1, { specStatus: 'closed' as const, winSide: 'home' }]),
      ),
      // The four live kinds take the OLDEST-updated ids, so they sit BEHIND the
      // recency window and phase B is the only phase that can reach them. (In
      // this fixture `row_updated_at` descends as `id` ascends, so high ids are
      // old — the reviewer's version put them low because every row there shared
      // one timestamp and the id tiebreak decided the window.)
      // 632: closed WINNER — owes a claim, and carries money.
      632: { specStatus: 'closed', winSide: 'away' },
      // 633: open with a scored contest — a PREDICTED loser a correction can flip.
      633: { specStatus: 'open', winSide: 'tbd', contestStatus: 'scored', awayScore: 3, homeScore: 9 },
      // 634: voided — a refund that still owes a claim.
      634: { specStatus: 'closed', winSide: 'void' },
      // 635: closed but the side is still unresolved — the defensive `tbd` case.
      635: { specStatus: 'closed', winSide: 'tbd' },
    });
    const sb = positionTables(tables);
    const hub = makeHub(sb);
    const rec = subscribeRecording(hub);

    // The seed is HANDWRITTEN, deliberately: this is a hub-consumer test, and
    // what it exercises is what the hub does with the flag rather than how the
    // flag is computed. An earlier version of this comment claimed the seed came
    // from the real deriving helper, which it does not — the test supplied the
    // value it said the producer had produced (rule 3i, in a comment).
    //
    // The producer's own computation is covered where it belongs, against the
    // real helper over a real relational double: `positions-bounded.test.ts`,
    // "marks each derived status terminal or live from the SAME join that derived
    // it". A build that dropped `isTerminalForever` there escapes THIS case and
    // dies in that one — confirmed by mutation, and by the reviewer
    // independently.
    hub.seedStatusCache(
      ADDRESS,
      Array.from({ length: 635 }, (_, i) => {
        const id = i + 1;
        const live = id >= 632;
        return {
          key: `${String(id)}_0`,
          status: (id === 632 ? 'claimable' : id === 634 ? 'void' : 'settledLost') as 'claimable',
          sourceUpdatedAt: stampFor(id),
          result: (id === 632 ? 'won' : id === 634 ? 'void' : 'lost') as 'won',
          // A winner pays risk + profit (10000 + 15000); a void pays the stake
          // back (10000). Seeding one value for both makes the void row emit on
          // tick 1 on a payload difference and blunts the assertions below.
          ...(id === 632 ? { claimableAmount: '25000' } : {}),
          ...(id === 634 ? { claimableAmount: '10000' } : {}),
          terminal: !live,
        };
      }),
    );

    await hub.pollWallet(ADDRESS);

    // SETUP FIRST (rule 3g-silentsetup): the four live keys are exactly the ones
    // phase B asks about, and the 631 finished ones cost nothing.
    expect(phaseBIdLists(sb.queries)).toEqual([[632, 633, 634, 635]]);

    // Two of the four reach a terminal state; the other two stay live.
    tables.positions.find((p) => p.id === 632)!['claimed'] = true;
    tables.positions.find((p) => p.id === 634)!['claimed'] = true;
    await hub.pollWallet(ADDRESS);

    expect(rec.statuses.filter((s) => s.id === '632' || s.id === '634').map((s) => s.status)).toEqual([
      'claimed',
      'claimed',
    ]);

    // THE assertion: the work-list shrank — retirement is dynamic, not just
    // seeded. It takes the NEXT tick to show, because phase B's id list is built
    // from the cache BEFORE the derivation that discovers the terminal state and
    // writes the retirement. Asserting it on the same tick that emitted the claim
    // would fail for that reason rather than for a broken retirement.
    const before = sb.queries.length;
    await hub.pollWallet(ADDRESS);
    expect(phaseBIdLists(sb.queries.slice(before))).toEqual([[633, 635]]);
  });
});
