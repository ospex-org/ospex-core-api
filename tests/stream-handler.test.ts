/**
 * SSE connect-handler lifecycle tests — the blockers from the A2 review:
 * Last-Event-ID resume (#1), `ready` only on clean catch-up (#2), plus the
 * 404/400/429 guards and disconnect cleanup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

// Mutable catch-up response the handler's runCatchUp sees via getSupabase().
const sb = vi.hoisted(() => {
  const state: { response: { data: unknown; error: unknown }; lastOr?: string; gate?: Promise<void> } = {
    response: { data: [], error: null },
  };
  const client = {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'lte', 'order', 'limit']) b[m] = () => b;
      b['or'] = (e: string) => {
        state.lastOr = e; // capture the catch-up keyset to assert which cursor was used
        return b;
      };
      // `state.gate` (when set) defers catch-up resolution so tests can inject
      // live deltas / resyncs mid-handoff.
      b['then'] = (resolve: (v: unknown) => void) => {
        if (state.gate) void state.gate.then(() => resolve(state.response));
        else resolve(state.response);
      };
      return b;
    },
  };
  return { state, getSupabase: () => client };
});
vi.mock('../src/lib/supabase.js', () => ({ getSupabase: sb.getSupabase }));
vi.mock('../src/lib/env.js', () => ({ loadConfig: () => ({ network: 'polygon', chainId: 137 }) }));

const { getStreamHandler, handlerStats, __resetHandlerMetrics } = await import('../src/v1/stream/handler.js');
const { StreamHub, __setStreamHubForTest } = await import('../src/v1/stream/hub.js');
const { __resetConnections, acquire, closeAllStreams, connectionStats } = await import('../src/v1/stream/connections.js');
const { encodeCursor } = await import('../src/lib/cursor.js');

function emptyClient(): SupabaseClient {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'or', 'gt', 'lt', 'lte', 'order', 'limit']) b[m] = () => b;
  b['then'] = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return { from: () => b } as unknown as SupabaseClient;
}

/**
 * Hub client for abort tests: serves `recovery` rows for recovery_runs queries
 * (drives onResync via checkRecentRecovery / the watcher) and `protocolOnce`
 * rows on the first protocol query (drives one live onDelta via pollResource).
 */
function makeHubClient(opts: { protocolOnce?: Array<Record<string, unknown>>; recovery?: Array<Record<string, unknown>> }): SupabaseClient {
  let served = false;
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'or', 'gt', 'lt', 'lte', 'order', 'limit']) b[m] = () => b;
      b['then'] = (resolve: (v: unknown) => void) => {
        if (table === 'recovery_runs') {
          resolve({ data: opts.recovery ?? [], error: null });
          return;
        }
        const rows = served ? [] : (opts.protocolOnce ?? []);
        served = true;
        resolve({ data: rows, error: null });
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

let hub: InstanceType<typeof StreamHub>;
beforeEach(() => {
  __resetConnections();
  __resetHandlerMetrics();
  hub = new StreamHub({ getClient: () => emptyClient(), getNetwork: () => 'polygon', pollMs: 1e9, resyncMs: 1e9 });
  __setStreamHubForTest(hub);
  sb.state.response = { data: [], error: null };
  sb.state.lastOr = undefined;
  sb.state.gate = undefined;
});
afterEach(() => {
  __setStreamHubForTest(undefined);
  __resetConnections();
  __resetHandlerMetrics();
  vi.restoreAllMocks();
});

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
function makeReq(opts: { resource: string; query?: Record<string, string>; headers?: Record<string, string>; ip?: string }): Request {
  const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    params: { resource: opts.resource },
    query: opts.query ?? {},
    ip: opts.ip ?? '9.9.9.9',
    header: (n: string) => headers[n.toLowerCase()],
  } as unknown as Request;
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
const events = (res: FakeRes): string[] =>
  res.written.join('').split('\n').filter((l) => l.startsWith('event:')).map((l) => l.slice('event:'.length).trim());

const fillCursor = encodeCursor({ t: 'fills', s: '2026-05-20T11:00:00.000Z', i: '1', k: 'live' });
function fillRow(id: number): Record<string, unknown> {
  return {
    speculation_id: 5,
    contest_id: 1,
    commitment_hash: `0x${'b'.repeat(64)}`,
    maker_address: '0x1111111111111111111111111111111111111111',
    taker_address: '0x3333333333333333333333333333333333333333',
    maker_position_type: 'upper',
    taker_position_type: 'lower',
    maker_risk_amount: '1000000',
    taker_risk_amount: '900000',
    odds_tick: 200,
    filled_at: '2026-05-20T12:00:00.000Z',
    contest_started: false,
    tx_hash: `0x${'c'.repeat(64)}`,
    log_index: id,
    id,
    row_updated_at: '2026-05-20T12:00:00.000Z',
  };
}

describe('GET /v1/stream/:resource guards', () => {
  it('404s an unknown resource', () => {
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'teams' }), res as unknown as Response);
    expect(res.statusCode).toBe(404);
  });

  it('400s a malformed cursor and releases the slot', () => {
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills', query: { cursor: '@@@' } }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
    expect(connectionStats().total).toBe(0); // slot released on the error path
  });

  it('429s when the per-IP connection cap is full', () => {
    const ip = '5.5.5.5';
    for (let i = 0; i < 10; i += 1) expect(acquire(ip).ok).toBe(true);
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills', ip }), res as unknown as Response);
    expect(res.statusCode).toBe(429);
  });
});

describe('GET /v1/stream/:resource lifecycle', () => {
  it('no cursor → goes live and emits ready (no catch-up deltas)', async () => {
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills' }), res as unknown as Response);
    await flush();
    const ev = events(res);
    expect(ev).toContain('ready');
    expect(ev).not.toContain('delta');
  });

  it('resumes catch-up from the Last-Event-ID header, then ready (#1)', async () => {
    sb.state.response = { data: [fillRow(1)], error: null }; // one row < page size → caught up
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills', headers: { 'Last-Event-ID': fillCursor } }), res as unknown as Response);
    await flush();
    const ev = events(res);
    expect(ev).toContain('delta'); // catch-up replayed the missed row
    expect(ev.indexOf('delta')).toBeLessThan(ev.indexOf('ready')); // delta before ready
    expect(ev).toContain('ready');
  });

  it('prefers Last-Event-ID over a stale ?cursor= on reconnect', async () => {
    // Native EventSource reconnects reuse the original URL (stale ?cursor=) and
    // send Last-Event-ID = the true resume point. The header must win.
    const headerCursor = encodeCursor({ t: 'fills', s: '2026-05-20T11:00:00.000Z', i: '1', k: 'live' });
    const queryCursor = encodeCursor({ t: 'fills', s: '2026-05-20T10:00:00.000Z', i: '2', k: 'live' });
    const res = makeRes();
    getStreamHandler(
      makeReq({ resource: 'fills', query: { cursor: queryCursor }, headers: { 'Last-Event-ID': headerCursor } }),
      res as unknown as Response,
    );
    await flush();
    // Catch-up's first-page keyset floors the HEADER cursor (11:00:00 − 30s),
    // not the stale query cursor (10:00:00 − 30s).
    expect(sb.state.lastOr).toContain('2026-05-20T10:59:30.000Z');
    expect(sb.state.lastOr).not.toContain('09:59:30');
  });

  it('catch-up failure emits resync and NOT ready (#2)', async () => {
    sb.state.response = { data: null, error: { message: 'boom' } };
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills', query: { cursor: fillCursor } }), res as unknown as Response);
    await flush();
    const ev = events(res);
    expect(ev).toContain('resync');
    expect(ev).not.toContain('ready');
  });

  it('a resync during catch-up is latched — no ready (#1)', async () => {
    // A recovery within the grace window makes checkRecentRecovery fire onResync
    // while catch-up is still gated. The handoff must abort to resync, not ready.
    const recovHub = new StreamHub({
      getClient: () => makeHubClient({ recovery: [{ id: 1, kind: 'reorg', status: 'complete', completed_at: new Date(Date.now() - 5_000).toISOString() }] }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
      resyncGraceMs: 60_000,
    });
    __setStreamHubForTest(recovHub);
    let release: () => void = () => {};
    sb.state.gate = new Promise<void>((r) => {
      release = r;
    });
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills', query: { cursor: fillCursor } }), res as unknown as Response);
    await flush(); // checkRecentRecovery → onResync during gated catch-up → aborted
    release();
    await flush(); // catch-up resolves
    const ev = events(res);
    expect(ev).toContain('resync');
    expect(ev).not.toContain('ready');
  });

  it('a live delta during catch-up aborts to resync — no ready, no stale (#2)', async () => {
    const liveClient = makeHubClient({ protocolOnce: [fillRow(1)] });
    const liveHub = new StreamHub({
      getClient: () => liveClient,
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    __setStreamHubForTest(liveHub);
    let release: () => void = () => {};
    sb.state.gate = new Promise<void>((r) => {
      release = r;
    });
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills', query: { cursor: fillCursor } }), res as unknown as Response);
    await flush(); // subscribed; catch-up gated
    await liveHub.pollResource('fills'); // fans fillRow(1) → onDelta during catch-up → aborted
    release();
    await flush();
    const ev = events(res);
    expect(ev).toContain('resync');
    expect(ev).not.toContain('ready');
  });

  it('releases the connection slot and unsubscribes on disconnect', async () => {
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills' }), res as unknown as Response);
    await flush();
    expect(connectionStats().total).toBe(1);
    expect(hub.stats().subscribers).toBe(1);

    res.emitClose();
    expect(connectionStats().total).toBe(0);
    expect(hub.stats().subscribers).toBe(0);
  });

  it('on server shutdown, emits resync(server_shutdown), ends the stream, and cleans up', async () => {
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills' }), res as unknown as Response);
    await flush();
    expect(connectionStats().total).toBe(1);

    closeAllStreams();

    const ev = events(res);
    expect(ev).toContain('resync');
    expect(res.written.join('')).toContain('"reason":"server_shutdown"');
    expect(res.writableEnded).toBe(true);
    // The closer's res.end() drives 'close' → cleanup: slot released, unsubscribed.
    expect(connectionStats().total).toBe(0);
    expect(hub.stats().subscribers).toBe(0);
  });
});

// ── M0 catchup counters ──────────────────────────────────────────────────────

describe('catchup counters', () => {
  it('a no-cursor handler → 1 started, 1 completed, 0 resynced', async () => {
    expect(handlerStats()).toEqual({
      catchupStartedTotal: 0,
      catchupCompletedTotal: 0,
      catchupResyncedTotal: 0,
    });
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills' }), res as unknown as Response);
    await flush();
    expect(events(res)).toContain('ready');
    expect(handlerStats()).toEqual({
      catchupStartedTotal: 1,
      catchupCompletedTotal: 1,
      catchupResyncedTotal: 0,
    });
  });

  it('catch-up failure path → started + resynced bump, completed does NOT', async () => {
    sb.state.response = { data: null, error: { message: 'boom' } };
    const res = makeRes();
    getStreamHandler(makeReq({ resource: 'fills', query: { cursor: fillCursor } }), res as unknown as Response);
    await flush();
    expect(events(res)).toContain('resync');
    expect(events(res)).not.toContain('ready');
    expect(handlerStats()).toEqual({
      catchupStartedTotal: 1,
      catchupCompletedTotal: 0,
      catchupResyncedTotal: 1,
    });
  });

  it('counters accumulate cumulatively across multiple connections', async () => {
    // Two ready connections + one resync connection → started=3, completed=2, resynced=1.
    const r1 = makeRes();
    getStreamHandler(makeReq({ resource: 'fills' }), r1 as unknown as Response);
    await flush();
    r1.emitClose();

    const r2 = makeRes();
    getStreamHandler(makeReq({ resource: 'fills' }), r2 as unknown as Response);
    await flush();
    r2.emitClose();

    sb.state.response = { data: null, error: { message: 'boom' } };
    const r3 = makeRes();
    getStreamHandler(makeReq({ resource: 'fills', query: { cursor: fillCursor } }), r3 as unknown as Response);
    await flush();

    expect(handlerStats()).toEqual({
      catchupStartedTotal: 3,
      catchupCompletedTotal: 2,
      catchupResyncedTotal: 1,
    });
  });

  it('slow-client shed during catch-up is NOT counted as completed (Hermes review-28 blocker)', async () => {
    // Production race: makeShedIfSlow calls res.end() synchronously but the 'close'
    // event fires asynchronously, so the wrapper's `closed` flag stays false on the
    // microtask boundary the IIFE re-enters on. Before the fix, runCatchUp returned
    // 'complete' after the short page and the wrapper bumped catchupCompletedTotal
    // even though no `ready` reached the client. The metric must attribute this to
    // slowClientShedTotal only, not to completed/resynced.
    const { MAX_PENDING_BYTES } = await import('../src/v1/stream/common.js');
    sb.state.response = { data: [fillRow(1)], error: null };

    const res = makeRes();
    res.writableLength = MAX_PENDING_BYTES + 1; // first shed() inside runCatchUp trips
    // Override end() so writableEnded is set but the 'close' event is NOT emitted
    // synchronously — mirrors the production race.
    res.end = function () {
      (this as FakeRes).writableEnded = true;
    };

    getStreamHandler(
      makeReq({ resource: 'fills', query: { cursor: fillCursor } }),
      res as unknown as Response,
    );
    await flush();

    expect(connectionStats().slowClientShedTotal).toBe(1);
    expect(events(res)).not.toContain('ready');
    expect(handlerStats()).toEqual({
      catchupStartedTotal: 1,
      catchupCompletedTotal: 0,
      catchupResyncedTotal: 0,
    });

    // Clean up: emit close manually so the slot is released for subsequent tests.
    res.emitClose();
  });
});
