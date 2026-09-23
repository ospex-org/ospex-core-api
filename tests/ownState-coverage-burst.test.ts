/**
 * THE COVERAGE-BURST COUNTEREXAMPLE, end to end (`ospex-core-api#97`).
 *
 * This file is the maintainer's external reviewer's own probe from the PR #96
 * review, kept because that PR's withdrawal commit promised to keep it: "the
 * counterexample is kept as a regression guard … so a future relaxation goes RED
 * and has to answer the scenario deliberately." It is the only test that drives
 * the REAL `fetchCategorizedPositions`, the REAL SSE handler and the REAL hub
 * across three polls with the fixture changing between them, and asserts on the
 * frames that reached the socket rather than on what the hub handed a callback
 * (rule 2: probe the artifact, not the function).
 *
 * ## What #96 measured, and what it measures now
 *
 * Then:  {snapshotRows: 199, actualActionable: 201, missingKey: '201_0',
 *         missingKeyEmitted: FALSE, degradedFrames: [], saturation: 0}
 * Now:   {snapshotRows: 199, actualActionable: 201, missingKey: '201_0',
 *         missingKeyEmitted: TRUE,  degradedFrames: [], saturation: 0,
 *         readLimits: [500, 500]}
 *
 * ## The two adaptations, stated because the second one is a design limit
 *
 * 1. **Four expectations were FLIPPED**, and they are the ones that encoded the
 *    recency window: the page limit (200 → 500 with a keyset predicate), the
 *    read count, `speculationId === '201'` emitted (false → true), and the
 *    `degraded` frame (present → absent).
 *
 * 2. **The ARRIVING rows are stamped at-or-after the connection instant**, where
 *    the original stamped them five minutes before it. Unadapted, this probe now
 *    fails EARLIER than the scenario it was written for — at the key-200
 *    assertion — and the reason is worth writing down rather than patching
 *    quietly: a backward-looking window cannot tell "a row written just now" from
 *    "a row written before you connected", and a forward cursor can. A real write
 *    carries `now()`, so the adapted stamps are the production shape. What the
 *    original stamps model is a five-minute gap between a writer transaction's
 *    `now()` and its commit, which is outside the 30s overlap this design states
 *    as its bound — the one axis on which the window was stronger, and the trade
 *    the PR body prices.
 */
/**
 * `getOwnStateStreamHandler` integration tests.
 *
 * Covers the connect-time guards (cursor validation), the cold-start
 * snapshot-then-ready vs snapshot-only-on-truncation paths, the
 * resume-from-cursor catchup, and the live-phase delta wire format.
 * The hub is mock-injected via `__setOwnStateHubForTest` so the tests
 * fire `onCommitment` / `onFill` / `onPositionStatus` callbacks
 * synchronously and assert on the recorded SSE frames.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
// Type-only: erased at runtime, so it does not perturb the deliberate
// `vi.mock` + `await import` ordering the runtime bindings below rely on.
import type { OwnStateCursor } from '../src/v1/ownState/cursor.js';

const NOW = Date.parse('2026-05-29T16:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const ADDRESS = '0x1111111111111111111111111111111111111111';

// ── module mocks ────────────────────────────────────────────────────────
const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    network: 'polygon',
    chainId: 137,
    redactHiddenPublic: true,
    ownStateSnapshotMaxCommitments: 5000,
  })),
}));
const positionFetchMock = vi.hoisted(() => ({
  fetchCategorizedPositions: vi.fn(),
}));
vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);
vi.mock('../src/v1/utils/positionFetch.js', () => ({
  fetchCategorizedPositions: positionFetchMock.fetchCategorizedPositions,
}));

const { getOwnStateStreamHandler, __resetOwnStateStreamMetrics } = await import(
  '../src/v1/ownState/stream.js'
);
const { OwnStateHub, __setOwnStateHubForTest } = await import('../src/v1/ownState/hub.js');
const { __resetConnections, acquire, configureConnectionCaps } = await import('../src/v1/stream/connections.js');
const {
  encodeOwnStateCursor,
  decodeOwnStateCursor,
  OWN_STATE_CURSOR_VERSION,
} = await import('../src/v1/ownState/cursor.js');

// ── test doubles ────────────────────────────────────────────────────────

interface FakeRes {
  statusCode: number;
  body?: unknown;
  writableEnded: boolean;
  writableLength: number;
  headers: Record<string, unknown>;
  written: string[];
  closeHandlers: Array<() => void>;
  setHeader: (k: string, v: unknown) => void;
  flushHeaders: () => void;
  write: (s: string) => boolean;
  end: () => void;
  on: (ev: string, cb: () => void) => FakeRes;
  status: (c: number) => FakeRes;
  json: (b: unknown) => FakeRes;
  emitClose: () => void;
  flush: () => void;
}
function makeRes(): FakeRes {
  return {
    statusCode: 0,
    writableEnded: false,
    writableLength: 0,
    headers: {},
    written: [],
    closeHandlers: [],
    setHeader(k, v) {
      this.headers[k] = v;
    },
    flushHeaders() {},
    write(s) {
      this.written.push(s);
      return true;
    },
    end() {
      this.writableEnded = true;
      this.emitClose();
    },
    on(ev, cb) {
      if (ev === 'close') this.closeHandlers.push(cb);
      return this;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    emitClose() {
      for (const h of this.closeHandlers) h();
    },
    flush() {},
  };
}

function makeReq(opts: { query?: Record<string, string>; headers?: Record<string, string> } = {}): Request {
  const headers = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    query: opts.query ?? {},
    params: {},
    ip: '9.9.9.9',
    header: (n: string) => headers[n.toLowerCase()],
    streamAuth: { address: ADDRESS, expiresAt: Math.floor(NOW / 1000) + 900 },
  } as unknown as Request;
}

interface MockResponse {
  data: unknown;
  error: unknown;
}
function sequencedClient(responses: MockResponse[]): SupabaseClient {
  let idx = 0;
  const next = (): MockResponse => responses[Math.min(idx++, responses.length - 1)]!;
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lt', 'lte', 'or', 'order', 'limit', 'is']) {
    builder[m] = (): unknown => builder;
  }
  builder['maybeSingle'] = (): Promise<MockResponse> => Promise.resolve(next());
  builder['then'] = (resolve: (v: MockResponse) => void): void => resolve(next());
  return { from: (): unknown => builder } as unknown as SupabaseClient;
}
/**
 * Mirrors supabase-js's `.maybeSingle()` contract for the "no row" case:
 * data is `null`, not `[]`. Snapshot's max-watermark helpers branch on
 * `!res.data` so `data: []` would incorrectly proceed to `String([].row_updated_at)`.
 */
function emptyClient(): SupabaseClient {
  return sequencedClient([{ data: null, error: null }]);
}

const flushTicks = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

function events(res: FakeRes): Array<{ event: string; data: unknown; id?: string }> {
  const out: Array<{ event: string; data: unknown; id?: string }> = [];
  const lines = res.written.join('').split('\n\n');
  for (const frame of lines) {
    if (!frame.includes('event:')) continue;
    const parts = frame.split('\n');
    let event = '';
    let dataStr = '';
    let id: string | undefined;
    for (const p of parts) {
      if (p.startsWith('event:')) event = p.slice('event:'.length).trim();
      else if (p.startsWith('data:')) dataStr = p.slice('data:'.length).trim();
      else if (p.startsWith('id:')) id = p.slice('id:'.length).trim();
    }
    if (event) {
      const data: unknown = (() => {
        try {
          return JSON.parse(dataStr);
        } catch {
          return dataStr;
        }
      })();
      out.push(id !== undefined ? { event, data, id } : { event, data });
    }
  }
  return out;
}
import { positionTables, scaleTables, type Table, type Tables } from './helpers/positionTables.js';
const actualPositionFetch = await vi.importActual<typeof import('../src/v1/utils/positionFetch.js')>('../src/v1/utils/positionFetch.js');
const DERIVED = new Set(['positions', 'speculations', 'contests']);
function hubClient(sb: ReturnType<typeof positionTables>): SupabaseClient {
  return { from(table: string) {
    if (DERIVED.has(table)) return sb.from(table as Table);
    const b: Record<string, unknown> = {};
    for (const name of ['select', 'eq', 'or', 'in', 'lte', 'lt', 'gt', 'order', 'limit']) b[name] = () => b;
    b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
    return b;
  }} as unknown as SupabaseClient;
}
function tablesFor(count: number): Tables {
  const t = scaleTables(count);
  for (const p of t.positions) { p.user_address = ADDRESS; p.position_created_at = '2026-05-29T15:50:00.000Z'; p.row_updated_at = '2026-05-29T15:50:00.000Z'; }
  for (const s of t.speculations) s.row_updated_at = '2026-05-29T15:50:00.000Z';
  for (const c of t.contests) { c.row_updated_at = '2026-05-29T15:50:00.000Z'; c.contest_status = 'verified'; c.away_score = null; c.home_score = null; c.start_time = null; }
  return t;
}
function addRow(t: Tables, id: number, stamp: string): void {
  const one = tablesFor(1);
  t.positions.push({ ...one.positions[0]!, id, speculation_id: id, row_updated_at: stamp, position_created_at: stamp });
  t.speculations.push({ ...one.speculations[0]!, speculation_id: id, contest_id: id, row_updated_at: stamp });
  t.contests.push({ ...one.contests[0]!, contest_id: id, row_updated_at: stamp });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  __resetOwnStateStreamMetrics(); __resetConnections();
  supabaseMock.getSupabase.mockImplementation(() => emptyClient());
});
afterEach(() => {
  __setOwnStateHubForTest(undefined); __resetConnections(); __resetOwnStateStreamMetrics();
  vi.useRealTimers(); vi.clearAllMocks();
});

it('reports partial coverage when a new row is displaced by updates to already-known keys between live polls', async () => {
  // Current production cold start, not a future >200-key seed: real deriving
  // helper proves 199 actionable rows and supplies the actual snapshot/seed.
  const t = tablesFor(199);
  const sb = positionTables(t);
  supabaseMock.getSupabase.mockReturnValue(sb);
  const result = await actualPositionFetch.fetchCategorizedPositions(ADDRESS);
  expect(result.hitCap).toBe(false);
  expect(result.active).toHaveLength(199);
  expect(result.derivedStatuses).toHaveLength(199);
  positionFetchMock.fetchCategorizedPositions.mockResolvedValue(result);
  supabaseMock.getSupabase.mockImplementation(() => emptyClient());
  const hub = new OwnStateHub({ getClient: () => hubClient(sb), getNetwork: () => 'polygon', pollMs: 1e9, resyncMs: 1e9 });
  __setOwnStateHubForTest(hub);
  const res = makeRes();
  getOwnStateStreamHandler(makeReq(), res as unknown as Response);
  await flushTicks(128);
  expect(events(res).map(e => e.event)).toEqual(['snapshot', 'ready']);
  expect((events(res)[0]!.data as any).positionsTruncated).toBe(false);
  await hub.pollWallet(ADDRESS);
  expect(events(res).filter(e => e.event === 'degraded')).toEqual([]);

  // One old key transfers its stake out; one new key arrives. Still only 199
  // actionable rows, no capped tick, but the cache legitimately holds 200 keys.
  t.positions[0]!.risk_amount = '0';
  t.positions[0]!.row_updated_at = '2026-05-29T16:00:05.000Z';
  addRow(t, 200, '2026-05-29T16:00:05.000Z');
  await hub.pollWallet(ADDRESS);
  expect(t.positions.filter(p => p.risk_amount !== '0')).toHaveLength(199);
  expect(events(res).some(e => e.event === 'positionStatus' && (e.data as any).speculationId === '200')).toBe(true);
  expect(events(res).some(e => e.event === 'positionStatus' && (e.data as any).speculationId === '1' && (e.data as any).status === 'settledLost')).toBe(true);
  expect(events(res).filter(e => e.event === 'degraded')).toEqual([]);

  // BETWEEN polls: unseen key 201 arrives, THEN the 200 known keys receive
  // newer updates, including an incoming transfer to key 1. A new row enters
  // at the head AT ITS WRITE, not necessarily at the later poll's read.
  addRow(t, 201, '2026-05-29T16:00:10.000Z');
  for (const p of t.positions.filter(p => Number(p.id) <= 200)) {
    p.risk_amount = '11000'; p.row_updated_at = '2026-05-29T16:00:20.000Z';
  }
  const qstart = sb.queries.length;
  await hub.pollWallet(ADDRESS);
  await hub.pollWallet(ADDRESS);
  const wire = events(res);
  const queries = sb.queries.slice(qstart).filter(q => q.table === 'positions');
  expect(queries.length).toBeGreaterThanOrEqual(2); // two drains, plus maintenance pages
  expect(queries.some(q => q.limit === 500 && q.or !== undefined)).toBe(true);
  expect(t.positions.filter(p => p.risk_amount !== '0')).toHaveLength(201);
  expect(wire.some(e => e.event === 'positionStatus' && (e.data as any).speculationId === '201')).toBe(true);
  expect(res.writableEnded).toBe(false);
  console.log('COVERAGE_BURST', JSON.stringify({snapshotRows: result.active.length, actualActionable: t.positions.filter(p => p.risk_amount !== '0').length, missingKey: '201_0', missingKeyEmitted: wire.some(e => e.event === 'positionStatus' && (e.data as any).speculationId === '201'), degradedFrames: wire.filter(e => e.event === 'degraded'), saturation: hub.stats().positionSaturationTotal, readLimits: queries.map(q=>q.limit), open: !res.writableEnded}));
  expect(wire.filter(e => e.event === 'degraded').map(e => e.data)).toEqual([]);
});

/**
 * B1's RECOVERY AXIS, end to end — the reviewer's three cases from the PR #99
 * review, kept verbatim except for the log label.
 *
 * The cursor used to be acknowledged by the READ: the drain advanced
 * `positionsTip` the moment rows came back, and the maintenance page and both
 * parent joins run after it. A position arriving during a transient outage in any
 * of those three was therefore never delivered, never cached, and — once its
 * stamp fell outside the overlap — unreachable, with the connection still open
 * and no `degraded`, `resync` or error frame. Reproduced here before fixing:
 * `ids: ['1','3']` / `['3']` / `['3']`, identical to their run.
 *
 * These are the cases that a `DESC LIMIT 200` window passed for free — it
 * re-read every row every tick, so a transient failure healed itself — and that
 * a cursor only passes when the tip is committed after the derivation. That is
 * why they are here and not only in the hub-level file: the property is about what
 * reaches the SOCKET across six polls, and the hub-level cases assert the cursor
 * (`the discovery cursor is acknowledged by the WORK`).
 */
for (const failure of ['maintenance', 'speculations', 'contests'] as const) {
  it(`B1: retains discovery through ${failure} failure until recovery`, async () => {
    const t = tablesFor(1);
    let broken = false;
    let errors = 0;
    const sb = positionTables(t, (q, _n, reply) => {
      const selected = failure === 'maintenance'
        ? q.table === 'positions' && q.joins.length > 0
        : q.table === failure;
      if (broken && selected) { errors++; return { data: null, error: { message: `review-${failure}-outage` } }; }
      return reply;
    });
    supabaseMock.getSupabase.mockReturnValue(sb);
    const result = await actualPositionFetch.fetchCategorizedPositions(ADDRESS);
    expect(result.hitCap).toBe(false);
    expect(result.active).toHaveLength(1);
    positionFetchMock.fetchCategorizedPositions.mockResolvedValue(result);
    supabaseMock.getSupabase.mockImplementation(() => emptyClient());
    const hub = new OwnStateHub({ getClient: () => hubClient(sb), getNetwork: () => 'polygon', pollMs: 1e9 });
    __setOwnStateHubForTest(hub);
    const res = makeRes();
    getOwnStateStreamHandler(makeReq(), res as unknown as Response);
    await flushTicks(128);
    expect(events(res).map(e => e.event)).toEqual(['snapshot', 'ready']);
    expect((events(res)[0]!.data as any).positionsTruncated).toBe(false);
    await hub.pollWallet(ADDRESS);
    const qstart = sb.queries.length;
    broken = true;
    // A transfer out makes key 1 require maintenance on BOTH base and head.
    if (failure === 'maintenance') t.positions[0]!.risk_amount = '0';
    for (let ms = 1000; ms <= 40000; ms += 1500) {
      vi.setSystemTime(NOW + ms);
      if (ms === 1000) addRow(t, 2, new Date(NOW + ms).toISOString());
      if (ms === 40000) addRow(t, 3, new Date(NOW + ms).toISOString());
      await hub.pollWallet(ADDRESS);
    }
    expect(errors).toBeGreaterThan(0);
    expect(t.positions).toHaveLength(3);
    broken = false;
    for (let ms = 41500; ms <= 46000; ms += 1500) {
      vi.setSystemTime(NOW + ms);
      await hub.pollWallet(ADDRESS);
    }
    const wire = events(res);
    const ids = wire.filter(e => e.event === 'positionStatus').map(e => (e.data as any).speculationId);
    const health = wire.filter(e => e.event === 'degraded' || e.event === 'resync');
    console.log('B1_RECOVERY', JSON.stringify({failure, errors, ids, health, open:!res.writableEnded,
      actionable: t.positions.filter(p => p.risk_amount !== '0').length, 
      discoveryFloors: sb.queries.slice(qstart).filter(q=>q.table==='positions' && q.or).map(q=>q.or),
    }));
    expect(ids, 'new row 2 must be delivered after transient join/maintenance failure').toContain('2');
    expect(ids).toContain('3');
    expect(health).toEqual([]);
    expect(res.writableEnded).toBe(false);
    res.end();
  });
}
