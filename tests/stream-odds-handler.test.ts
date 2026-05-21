/**
 * Odds SSE connect-handler tests: param/contest guards, snapshot-first
 * ordering, the monotonic poll_captured_at watermark, degraded/resnapshot
 * passthrough, and disconnect cleanup. A hoisted Supabase double serves the
 * contest-resolve + snapshot reads; an injected fake OddsHub lets the test
 * drive live callbacks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { OddsHub, OddsSubscriber, OddsSubscriberCallbacks } from '../src/v1/stream/oddsHub.js';
import type { MarketOdds, OddsMarket } from '../src/v1/utils/odds.js';

const T1 = '2026-05-20T12:00:00.000Z';
const T2 = '2026-05-20T12:00:30.000Z';
const T3 = '2026-05-20T12:01:00.000Z';

// Mutable Supabase responses the handler reads via getSupabase().
const sbMock = vi.hoisted(() => {
  const state: {
    contest: { data: unknown; error: unknown };
    odds: { data: unknown; error: unknown };
    oddsGate: Promise<void> | undefined;
  } = {
    contest: { data: null, error: null },
    odds: { data: null, error: null },
    oddsGate: undefined,
  };
  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      b['select'] = () => b;
      b['eq'] = () => b;
      b['maybeSingle'] = async () => {
        if (table === 'contests') return state.contest;
        if (state.oddsGate) await state.oddsGate;
        return state.odds;
      };
      return b;
    },
  };
  return { state, getSupabase: () => client };
});
vi.mock('../src/lib/supabase.js', () => ({ getSupabase: sbMock.getSupabase }));
vi.mock('../src/lib/env.js', () => ({ loadConfig: () => ({ network: 'polygon', chainId: 137 }) }));

const { getOddsStreamHandler } = await import('../src/v1/stream/oddsHandler.js');
const { __setOddsHubForTest } = await import('../src/v1/stream/oddsHub.js');
const { __resetConnections, acquire, connectionStats } = await import('../src/v1/stream/connections.js');

interface FakeHub {
  hub: OddsHub;
  captured?: { jid: string; market: OddsMarket; cb: OddsSubscriberCallbacks };
  subscribeCalls: number;
  unsub: ReturnType<typeof vi.fn>;
  setDegraded: (d: boolean) => void;
}
function makeFakeHub(): FakeHub {
  let degraded = false;
  const f: FakeHub = {
    hub: undefined as unknown as OddsHub,
    subscribeCalls: 0,
    unsub: vi.fn(),
    setDegraded: (d) => {
      degraded = d;
    },
  };
  f.hub = {
    subscribe(jid: string, market: OddsMarket, cb: OddsSubscriberCallbacks): OddsSubscriber {
      f.captured = { jid, market, cb };
      f.subscribeCalls += 1;
      return { jsonoddsId: jid, market, ...cb };
    },
    unsubscribe: f.unsub,
    isDegraded: () => degraded,
  } as unknown as OddsHub;
  return f;
}

let fake: FakeHub;
beforeEach(() => {
  __resetConnections();
  fake = makeFakeHub();
  __setOddsHubForTest(fake.hub);
  sbMock.state.contest = { data: null, error: null };
  sbMock.state.odds = { data: null, error: null };
  sbMock.state.oddsGate = undefined;
});
afterEach(() => {
  __setOddsHubForTest(undefined);
  __resetConnections();
  vi.restoreAllMocks();
});

interface FakeRes {
  statusCode: number;
  body?: unknown;
  writableEnded: boolean;
  writableLength: number;
  headersSent: boolean;
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
    headersSent: false,
    headers: {},
    written: [],
    closeHandlers: [],
    setHeader(k, v) {
      this.headers[k] = v;
    },
    flushHeaders() {
      this.headersSent = true;
    },
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
function makeReq(opts: { contestId?: string; market?: string; ip?: string }): Request {
  const query: Record<string, string> = {};
  if (opts.contestId !== undefined) query.contestId = opts.contestId;
  if (opts.market !== undefined) query.market = opts.market;
  return {
    query,
    ip: opts.ip ?? '9.9.9.9',
    header: () => undefined,
  } as unknown as Request;
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
interface Frame {
  event?: string;
  data?: Record<string, unknown>;
  comment?: string;
}
function frames(res: FakeRes): Frame[] {
  return res.written
    .join('')
    .split('\n\n')
    .filter((b) => b.length > 0)
    .map((block) => {
      const out: Frame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) out.event = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) out.data = JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>;
        else if (line.startsWith(':')) out.comment = line.slice(1).trim();
      }
      return out;
    });
}
const eventsOf = (res: FakeRes): string[] => frames(res).flatMap((f) => (f.event ? [f.event] : []));

function spreadOdds(o: Partial<MarketOdds> = {}): MarketOdds {
  return {
    market: 'spread',
    awayLine: 3.5,
    homeLine: -3.5,
    awayOddsAmerican: -110,
    homeOddsAmerican: -110,
    upstreamLastUpdated: T1,
    pollCapturedAt: T1,
    changedAt: T1,
    ...o,
  } as MarketOdds;
}
function oddsRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonodds_id: 'jo-1',
    market: 'spread',
    line: -3.5,
    away_odds_american: -110,
    home_odds_american: -110,
    upstream_last_updated: T1,
    poll_captured_at: T2,
    changed_at: T1,
    ...o,
  };
}

describe('GET /v1/stream/odds guards', () => {
  it('400s a non-numeric contestId and holds no slot', async () => {
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: 'abc', market: 'spread' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(connectionStats().total).toBe(0);
  });

  it('400s an invalid market', async () => {
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'parlay' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(connectionStats().total).toBe(0);
  });

  it('429s when the per-IP cap is full', async () => {
    const ip = '5.5.5.5';
    for (let i = 0; i < 10; i += 1) expect(acquire(ip).ok).toBe(true);
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread', ip }), res as unknown as Response);
    expect(res.statusCode).toBe(429);
  });

  it('404s an unknown contest and releases the slot', async () => {
    sbMock.state.contest = { data: null, error: null };
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '999', market: 'spread' }), res as unknown as Response);
    expect(res.statusCode).toBe(404);
    expect(connectionStats().total).toBe(0);
    expect(fake.subscribeCalls).toBe(0);
  });

  it('500s on a contest lookup error and releases the slot', async () => {
    sbMock.state.contest = { data: null, error: { message: 'boom' } };
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);
    expect(res.statusCode).toBe(500);
    expect(connectionStats().total).toBe(0);
  });
});

describe('GET /v1/stream/odds snapshot + live', () => {
  it('a contest with no upstream linkage gets an empty snapshot and no hub subscription', async () => {
    sbMock.state.contest = { data: { jsonodds_id: null }, error: null };
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);
    const snap = frames(res).find((f) => f.event === 'snapshot');
    expect(snap?.data).toMatchObject({ contestId: '1', market: 'spread', odds: null });
    expect(fake.subscribeCalls).toBe(0);
    expect(connectionStats().total).toBe(1); // stays open
  });

  it('emits the snapshot first, then subscribes for live deltas', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: oddsRow(), error: null };
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);

    const snap = frames(res).find((f) => f.event === 'snapshot');
    expect(snap?.data).toMatchObject({ contestId: '1', market: 'spread' });
    expect(snap?.data?.odds).toMatchObject({ market: 'spread', homeLine: -3.5, awayLine: 3.5 });
    expect(snap?.data?.odds).not.toHaveProperty('jsonoddsId');
    expect(fake.subscribeCalls).toBe(1);
    expect(fake.captured?.jid).toBe('jo-1');
    expect(fake.captured?.market).toBe('spread');
  });

  it('forwards a newer change but drops one older than the snapshot watermark', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: oddsRow(), error: null }; // snapshot poll_captured_at = T2
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);

    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: T3, awayOddsAmerican: -120 }));
    expect(frames(res).filter((f) => f.event === 'change')).toHaveLength(1);

    // Older than the last emitted (T3) → dropped.
    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: T1 }));
    expect(frames(res).filter((f) => f.event === 'change')).toHaveLength(1);
  });

  it('buffers live deltas during the snapshot query and flushes them after (snapshot first, stale dropped)', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: oddsRow(), error: null }; // snapshot poll_captured_at = T2
    let releaseGate: () => void = () => undefined;
    sbMock.state.oddsGate = new Promise<void>((r) => {
      releaseGate = r;
    });

    const res = makeRes();
    const p = getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);
    await flush(); // resolves contest, opens SSE, subscribes, blocks on the gate

    expect(fake.captured).toBeDefined();
    // A delta older than the snapshot and one newer arrive while snapshotting.
    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: '2026-05-20T11:59:00.000Z' }));
    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: T3, awayOddsAmerican: -120 }));
    expect(eventsOf(res)).not.toContain('snapshot'); // nothing emitted yet

    releaseGate();
    await flush();
    await p;

    const ev = eventsOf(res);
    expect(ev.indexOf('snapshot')).toBeGreaterThanOrEqual(0);
    expect(ev.indexOf('snapshot')).toBeLessThan(ev.indexOf('change')); // snapshot first
    expect(frames(res).filter((f) => f.event === 'change')).toHaveLength(1); // stale one dropped
  });

  it('passes through a degraded signal and re-snapshots on recovery', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: oddsRow(), error: null };
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);

    fake.captured?.cb.onDegraded('channel_error');
    expect(frames(res).find((f) => f.event === 'degraded')?.data).toMatchObject({ reason: 'channel_error' });

    sbMock.state.odds = { data: oddsRow({ poll_captured_at: '2026-05-20T12:02:00.000Z', away_odds_american: -200 }), error: null };
    fake.captured?.cb.onResnapshot();
    await flush();
    expect(frames(res).filter((f) => f.event === 'snapshot')).toHaveLength(2);
  });

  it('on a snapshot query failure: emits degraded, goes live anyway, and still forwards deltas', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: null, error: { message: 'odds boom' } }; // fetchMarketSnapshot throws
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);

    expect(frames(res).find((f) => f.event === 'degraded')?.data).toMatchObject({ reason: 'snapshot_failed' });
    expect(frames(res).filter((f) => f.event === 'snapshot')).toHaveLength(0);

    // The handler must be live (not stuck buffering) — a live delta flows.
    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: T3, awayOddsAmerican: -120 }));
    expect(frames(res).filter((f) => f.event === 'change')).toHaveLength(1);
  });

  it('unsubscribes and releases the slot when the client disconnects', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: oddsRow(), error: null };
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);
    expect(connectionStats().total).toBe(1);

    res.emitClose();
    expect(fake.unsub).toHaveBeenCalledTimes(1);
    expect(connectionStats().total).toBe(0);
  });
});
