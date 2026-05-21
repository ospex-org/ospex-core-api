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
  const state: { response: { data: unknown; error: unknown }; lastOr?: string } = { response: { data: [], error: null } };
  const client = {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'lte', 'order', 'limit']) b[m] = () => b;
      b['or'] = (e: string) => {
        state.lastOr = e; // capture the catch-up keyset to assert which cursor was used
        return b;
      };
      b['then'] = (resolve: (v: unknown) => void) => resolve(state.response);
      return b;
    },
  };
  return { state, getSupabase: () => client };
});
vi.mock('../src/lib/supabase.js', () => ({ getSupabase: sb.getSupabase }));
vi.mock('../src/lib/env.js', () => ({ loadConfig: () => ({ network: 'polygon', chainId: 137 }) }));

const { getStreamHandler } = await import('../src/v1/stream/handler.js');
const { StreamHub, __setStreamHubForTest } = await import('../src/v1/stream/hub.js');
const { __resetConnections, acquire, connectionStats } = await import('../src/v1/stream/connections.js');
const { encodeCursor } = await import('../src/lib/cursor.js');

function emptyClient(): SupabaseClient {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'or', 'gt', 'lt', 'lte', 'order', 'limit']) b[m] = () => b;
  b['then'] = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return { from: () => b } as unknown as SupabaseClient;
}

let hub: InstanceType<typeof StreamHub>;
beforeEach(() => {
  __resetConnections();
  hub = new StreamHub({ getClient: () => emptyClient(), getNetwork: () => 'polygon', pollMs: 1e9, resyncMs: 1e9 });
  __setStreamHubForTest(hub);
  sb.state.response = { data: [], error: null };
  sb.state.lastOr = undefined;
});
afterEach(() => {
  __setStreamHubForTest(undefined);
  __resetConnections();
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
});
