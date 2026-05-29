/**
 * `getOwnStateStreamHandler` integration tests (M4b spec §2.1).
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
const { __resetConnections } = await import('../src/v1/stream/connections.js');
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

const liveCursor = (): string =>
  encodeOwnStateCursor({
    t: 'own-state',
    v: OWN_STATE_CURSOR_VERSION,
    c: { s: '2026-05-29T14:00:00.000Z', i: '1' },
    f: { s: '2026-05-29T14:00:00.000Z', i: '0' },
    p: { s: '2026-05-29T14:00:00.000Z', i: '0' },
    k: 'live',
  });

const pageCursor = (): string =>
  encodeOwnStateCursor({
    t: 'own-state',
    v: OWN_STATE_CURSOR_VERSION,
    c: { s: '2026-05-29T14:00:00.000Z', i: '1' },
    cAnchor: { s: '2026-05-29T13:50:00.000Z', i: '0' },
    f: { s: '2026-05-29T14:00:00.000Z', i: '0' },
    p: { s: '2026-05-29T14:00:00.000Z', i: '0' },
    k: 'page-recovery-active',
  });

let hubInstance: InstanceType<typeof OwnStateHub>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __resetOwnStateStreamMetrics();
  __resetConnections();
  supabaseMock.getSupabase.mockImplementation(() => emptyClient());
  positionFetchMock.fetchCategorizedPositions.mockResolvedValue({
    active: [],
    pendingSettle: [],
    claimable: [],
    hitCap: false,
  });
  envMock.loadConfig.mockReturnValue({
    network: 'polygon',
    chainId: 137,
    redactHiddenPublic: true,
    ownStateSnapshotMaxCommitments: 5000,
  });
  // Real hub but with intervals starved out — tests drive callbacks directly
  // by intercepting `subscribe`. We set a 1e9 ms poll interval so the timer
  // never fires (unref'd by the hub anyway under fake timers).
  hubInstance = new OwnStateHub({
    getClient: () => emptyClient(),
    getNetwork: () => 'polygon',
    pollMs: 1e9,
    resyncMs: 1e9,
  });
  __setOwnStateHubForTest(hubInstance);
});
afterEach(() => {
  __setOwnStateHubForTest(undefined);
  __resetConnections();
  __resetOwnStateStreamMetrics();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('GET /v1/stream/own-state — cursor guards', () => {
  it('400s a malformed cursor', () => {
    const res = makeRes();
    getOwnStateStreamHandler(makeReq({ query: { cursor: '@@@' } }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('400s a page-kind cursor with a message pointing to /v1/own-state/snapshot', () => {
    const res = makeRes();
    getOwnStateStreamHandler(
      makeReq({ query: { cursor: pageCursor() } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
    expect(String((res.body as { error?: string }).error)).toMatch(/\/v1\/own-state\/snapshot/);
  });

  it('Last-Event-ID wins over ?cursor= (both invalid via header → 400)', () => {
    const res = makeRes();
    getOwnStateStreamHandler(
      makeReq({ query: { cursor: liveCursor() }, headers: { 'Last-Event-ID': '@@@' } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/stream/own-state — cold start (no cursor)', () => {
  it('emits snapshot then ready when truncated=false', async () => {
    const res = makeRes();
    getOwnStateStreamHandler(makeReq(), res as unknown as Response);
    await flushTicks(32);
    const ev = events(res);
    expect(ev[0]).toMatchObject({ event: 'snapshot' });
    expect(ev[1]).toMatchObject({ event: 'ready' });
    expect((ev[0] as { data: { truncated: boolean } }).data.truncated).toBe(false);
  });

  it('emits snapshot WITHOUT ready when positions truncated; ends the connection', async () => {
    // Force positions truncation: position helper signals hitCap=true; commitments
    // stay clean. SDK reconnects with the cursor (p preserved as SENTINEL) and the
    // resume catch-up replays position transitions before `ready`.
    positionFetchMock.fetchCategorizedPositions.mockResolvedValue({
      active: [],
      pendingSettle: [],
      claimable: [],
      hitCap: true,
    });
    supabaseMock.getSupabase.mockImplementation(() =>
      sequencedClient([
        { data: [], error: null }, // active commitments query
        { data: null, error: null }, // maxFills
        // No maxPositions query — when positionsTruncated, snapshot preserves
        // cursor.p as SENTINEL_WATERMARK (cold start) instead of querying.
      ]),
    );
    const res = makeRes();
    getOwnStateStreamHandler(makeReq(), res as unknown as Response);
    await flushTicks(64);
    const ev = events(res);
    const snap = ev.find((e) => e.event === 'snapshot');
    expect(snap).toBeDefined();
    expect((snap as { data: { positionsTruncated: boolean } }).data.positionsTruncated).toBe(true);
    expect((snap as { data: { truncated: boolean } }).data.truncated).toBe(false);
    expect(ev.find((e) => e.event === 'ready')).toBeUndefined();
    expect(res.writableEnded).toBe(true);
  });

  it('emits snapshot WITHOUT ready when commitments truncated; ends the connection', async () => {
    // Force truncation: cap the snapshot at maxCommitments=1, return 1 active row.
    envMock.loadConfig.mockReturnValue({
      network: 'polygon',
      chainId: 137,
      redactHiddenPublic: true,
      ownStateSnapshotMaxCommitments: 1,
    });
    const activeRow = {
      commitment_hash: `0x${'a'.repeat(64)}`,
      maker: ADDRESS,
      contest_id: 42,
      scorer: `0x${'2'.repeat(40)}`,
      line_ticks: 0,
      position_type: 'upper',
      odds_tick: 200,
      market_type: 'moneyline',
      risk_amount: '1000000',
      filled_risk_amount: '0',
      nonce: '1',
      expiry: '2026-05-29T17:00:00.000Z',
      speculation_key: `0x${'b'.repeat(64)}`,
      signature: `0x${'9'.repeat(130)}`,
      status: 'open',
      source: 'agent',
      network: 'polygon',
      nonce_invalidated: false,
      book_visible: true,
      created_at: '2026-05-29T10:00:00.000Z',
      id: 1,
      row_updated_at: '2026-05-29T15:00:00.000Z',
    };
    // Sequence per the snapshot's cold-start call order:
    //   1. active commitments query (.limit(maxCommitments)=1) — saturates → truncated=true
    //   2. maxWmFills .maybeSingle()
    //   3. maxWmPositions .maybeSingle()
    // The phase-1-saturated branch in the snapshot uses the last activeRow
    // for the cursor's `c` (not maxWmCommitments) so that query is skipped.
    supabaseMock.getSupabase.mockImplementation(() =>
      sequencedClient([
        { data: [activeRow], error: null },
        { data: null, error: null }, // maxFills
        { data: null, error: null }, // maxPositions
      ]),
    );
    const res = makeRes();
    getOwnStateStreamHandler(makeReq(), res as unknown as Response);
    await flushTicks(64);
    const ev = events(res);
    expect(ev.find((e) => e.event === 'snapshot')).toBeDefined();
    expect(ev.find((e) => e.event === 'ready')).toBeUndefined();
    expect(res.writableEnded).toBe(true);
  });
});

describe('GET /v1/stream/own-state — resume catchup', () => {
  it('runs catchup with the supplied cursor and emits ready on clean completion', async () => {
    const res = makeRes();
    getOwnStateStreamHandler(
      makeReq({ query: { cursor: liveCursor() } }),
      res as unknown as Response,
    );
    await flushTicks(64);
    const ev = events(res);
    // No snapshot on resume; just ready when catchup is empty (default fixtures).
    expect(ev.find((e) => e.event === 'snapshot')).toBeUndefined();
    expect(ev.find((e) => e.event === 'ready')).toBeDefined();
  });

  it('catchup emits positionStatus derived from joined spec/contest even when position row is unchanged', async () => {
    // Spec/contest-driven convergence: a contest scoring (or speculation
    // settling) after the cursor was minted but with no position-row bump
    // still must surface via the resume catch-up — the
    // `sourceUpdatedAt = max(pos, spec, contest)` derivation makes the
    // transition observable through `cursor.p`.
    const positionRow = {
      speculation_id: 101,
      user_address: ADDRESS,
      position_type: 'upper',
      risk_amount: '1000000',
      profit_amount: '500000',
      claimed: false,
      // pre-cursor timestamp
      row_updated_at: '2026-05-29T13:00:00.000Z',
      id: 7,
    };
    const specRowSettled = {
      speculation_id: 101,
      contest_id: 42,
      market_type: 'moneyline',
      line_ticks: null,
      speculation_status: 'closed',
      win_side: 'away',
      // POST-cursor timestamp — drives the derivation forward
      row_updated_at: '2026-05-29T15:30:00.000Z',
    };
    const contestRowStatic = {
      contest_id: 42,
      contest_status: 'verified',
      away_score: null,
      home_score: null,
      row_updated_at: '2026-05-29T13:00:00.000Z',
    };
    // Catchup sequence: commitments empty → fills empty → positions list →
    // speculations IN-list → contests IN-list. The first two return empty data;
    // the positions query returns the single row; the joins return the spec/contest.
    supabaseMock.getSupabase.mockImplementation(() =>
      sequencedClient([
        { data: [], error: null }, // commitments catchup
        { data: [], error: null }, // fills catchup
        { data: [positionRow], error: null }, // positions catchup
        { data: [specRowSettled], error: null }, // speculations join
        { data: [contestRowStatic], error: null }, // contests join
      ]),
    );
    const res = makeRes();
    getOwnStateStreamHandler(
      makeReq({ query: { cursor: liveCursor() } }),
      res as unknown as Response,
    );
    await flushTicks(64);
    const ev = events(res);
    const ps = ev.find((e) => e.event === 'positionStatus');
    expect(ps).toBeDefined();
    expect((ps as { data: { status: string } }).data.status).toBe('claimable');
    // sourceUpdatedAt should be the spec's row_updated_at (the max).
    expect((ps as { data: { sourceUpdatedAt: string } }).data.sourceUpdatedAt).toBe(
      '2026-05-29T15:30:00.000Z',
    );
    expect(ev.find((e) => e.event === 'ready')).toBeDefined();
  });

  it('aborts catchup to resync if a live delta lands during catchup', async () => {
    // Use a racing hub: subscribe fires onResync SYNCHRONOUSLY so the
    // handler's `aborted=true` is set BEFORE the IIFE awaits the first
    // catchup query. After catchup completes, the IIFE sees aborted and
    // emits `resync` instead of `ready`.
    class RacingHub extends OwnStateHub {
      subscribe(
        address: string,
        cb: Parameters<OwnStateHub['subscribe']>[1],
      ): ReturnType<OwnStateHub['subscribe']> {
        const sub = super.subscribe(address, cb);
        cb.onResync('test_race');
        return sub;
      }
    }
    const racing = new RacingHub({
      getClient: () => emptyClient(),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    __setOwnStateHubForTest(racing);

    const res = makeRes();
    getOwnStateStreamHandler(
      makeReq({ query: { cursor: liveCursor() } }),
      res as unknown as Response,
    );
    await flushTicks(64);
    const ev = events(res);
    const resync = ev.find((e) => e.event === 'resync');
    expect(resync).toBeDefined();
    expect(res.writableEnded).toBe(true);
    // The race was during preReady → no `ready` should have been emitted.
    expect(ev.find((e) => e.event === 'ready')).toBeUndefined();
  });
});

describe('GET /v1/stream/own-state — live deltas', () => {
  it('writes commitment events with the running composite cursor as id:', async () => {
    const res = makeRes();
    getOwnStateStreamHandler(
      makeReq({ query: { cursor: liveCursor() } }),
      res as unknown as Response,
    );
    await flushTicks();
    // Find the registered sub by polling the hub's stats.
    expect(hubInstance.stats().subscribers).toBe(1);
    // Drive a live delta by re-subscribing — actually we can simulate by
    // calling pollWallet against a populated client.
    supabaseMock.getSupabase.mockImplementation(() =>
      sequencedClient([
        {
          data: [
            {
              commitment_hash: `0x${'a'.repeat(64)}`,
              maker: ADDRESS,
              contest_id: 42,
              scorer: `0x${'2'.repeat(40)}`,
              line_ticks: 0,
              position_type: 'upper',
              odds_tick: 200,
              market_type: 'moneyline',
              risk_amount: '1000000',
              filled_risk_amount: '0',
              nonce: '1',
              expiry: '2026-05-29T17:00:00.000Z',
              speculation_key: `0x${'b'.repeat(64)}`,
              signature: `0x${'9'.repeat(130)}`,
              status: 'open',
              source: 'agent',
              network: 'polygon',
              nonce_invalidated: false,
              book_visible: true,
              created_at: '2026-05-29T10:00:00.000Z',
              id: 42,
              row_updated_at: '2026-05-29T15:45:00.000Z',
            },
          ],
          error: null,
        },
      ]),
    );
    // Repoint the hub's own client too (it was constructed earlier with
    // emptyClient; the test creates a fresh hub here so the new delta query
    // is routed via the new mock).
    const liveHub = new OwnStateHub({
      getClient: () => supabaseMock.getSupabase(),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    __setOwnStateHubForTest(liveHub);
    // Reconnect for the live hub.
    const res2 = makeRes();
    getOwnStateStreamHandler(
      makeReq({ query: { cursor: liveCursor() } }),
      res2 as unknown as Response,
    );
    await flushTicks();
    await liveHub.pollWallet(ADDRESS);
    await flushTicks();
    const ev = events(res2);
    const commitment = ev.find((e) => e.event === 'commitment');
    expect(commitment).toBeDefined();
    // The id: line should encode a composite cursor with c advanced to
    // (2026-05-29T15:45:00.000Z, 42).
    expect(commitment?.id).toBeDefined();
    const decoded = decodeOwnStateCursor(commitment!.id!);
    expect(decoded.c).toEqual({ s: '2026-05-29T15:45:00.000Z', i: '42' });
    expect(decoded.k).toBe('live');
  });
});
