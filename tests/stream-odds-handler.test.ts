/**
 * Odds SSE connect-handler tests: param/contest guards, onActive-driven
 * snapshot (no pre-readiness eager snapshot), the monotonic poll_captured_at
 * watermark, coalesced buffering, the snapshot-first contract on query failure,
 * degraded/recovery passthrough, and disconnect cleanup. A hoisted Supabase
 * double serves the contest-resolve + snapshot reads; an injected fake OddsHub
 * lets the test drive readiness/live callbacks.
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
    poll_captured_at: T2, // baseline watermark
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

  it('does not snapshot until the live source is active (onActive)', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: oddsRow(), error: null };
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);

    expect(fake.subscribeCalls).toBe(1);
    expect(eventsOf(res)).not.toContain('snapshot'); // not before readiness

    fake.captured?.cb.onActive();
    await flush();
    const snap = frames(res).find((f) => f.event === 'snapshot');
    expect(snap?.data).toMatchObject({ contestId: '1', market: 'spread' });
    expect(snap?.data?.odds).toMatchObject({ market: 'spread', homeLine: -3.5, awayLine: 3.5 });
    expect(snap?.data?.odds).not.toHaveProperty('jsonoddsId');
  });

  it('forwards a newer change but drops one older than the snapshot watermark', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: oddsRow(), error: null }; // baseline poll_captured_at = T2
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);
    fake.captured?.cb.onActive();
    await flush();

    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: T3, awayOddsAmerican: -120 }));
    expect(frames(res).filter((f) => f.event === 'change')).toHaveLength(1);

    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: T1 })); // older than T3 → dropped
    expect(frames(res).filter((f) => f.event === 'change')).toHaveLength(1);
  });

  it('buffers + coalesces live deltas during the snapshot query, then flushes the latest (snapshot first)', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: oddsRow(), error: null }; // baseline poll_captured_at = T2
    let releaseGate: () => void = () => undefined;
    sbMock.state.oddsGate = new Promise<void>((r) => {
      releaseGate = r;
    });

    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);
    fake.captured?.cb.onActive(); // triggers the (gated) snapshot
    await flush();

    // Three deltas arrive while snapshotting: one stale, two newer. They must
    // coalesce to a single latest delta (bounded buffer).
    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: '2026-05-20T11:59:00.000Z' }));
    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: '2026-05-20T12:00:45.000Z', awayOddsAmerican: -115 }));
    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: T3, awayOddsAmerican: -120 }));
    expect(eventsOf(res)).not.toContain('snapshot'); // nothing emitted yet

    releaseGate();
    await flush();

    const ev = eventsOf(res);
    expect(ev.indexOf('snapshot')).toBeGreaterThanOrEqual(0);
    expect(ev.indexOf('snapshot')).toBeLessThan(ev.indexOf('change')); // snapshot first
    const changes = frames(res).filter((f) => f.event === 'change');
    expect(changes).toHaveLength(1); // coalesced
    expect(changes[0]?.data?.odds).toMatchObject({ awayOddsAmerican: -120 }); // the newest
  });

  it('passes through a degraded signal and re-snapshots on recovery (onActive)', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: oddsRow(), error: null };
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);
    fake.captured?.cb.onActive();
    await flush();

    fake.captured?.cb.onDegraded('channel_error');
    expect(frames(res).find((f) => f.event === 'degraded')?.data).toMatchObject({ reason: 'channel_error' });

    sbMock.state.odds = { data: oddsRow({ poll_captured_at: '2026-05-20T12:02:00.000Z', away_odds_american: -200 }), error: null };
    fake.captured?.cb.onActive();
    await flush();
    expect(frames(res).filter((f) => f.event === 'snapshot')).toHaveLength(2);
  });

  it('on a snapshot query failure stays pre-baseline (no deltas without a snapshot), then recovers', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: null, error: { message: 'odds boom' } }; // fetchMarketSnapshot throws
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);
    fake.captured?.cb.onActive();
    await flush();

    expect(frames(res).find((f) => f.event === 'degraded')?.data).toMatchObject({ reason: 'snapshot_failed' });
    expect(eventsOf(res)).not.toContain('snapshot');

    // A delta now must NOT be emitted — there's no baseline yet (it buffers).
    fake.captured?.cb.onChange(spreadOdds({ pollCapturedAt: T3, awayOddsAmerican: -120 }));
    expect(eventsOf(res)).not.toContain('change');

    // Recovery: the read succeeds → baseline, then the buffered delta flushes.
    sbMock.state.odds = { data: oddsRow(), error: null }; // poll_captured_at = T2
    fake.captured?.cb.onActive();
    await flush();
    expect(frames(res).filter((f) => f.event === 'snapshot')).toHaveLength(1);
    expect(frames(res).filter((f) => f.event === 'change')).toHaveLength(1); // T3 > T2
  });

  it('unsubscribes and releases the slot when the client disconnects', async () => {
    sbMock.state.contest = { data: { jsonodds_id: 'jo-1' }, error: null };
    sbMock.state.odds = { data: oddsRow(), error: null };
    const res = makeRes();
    await getOddsStreamHandler(makeReq({ contestId: '1', market: 'spread' }), res as unknown as Response);
    fake.captured?.cb.onActive();
    await flush();
    expect(connectionStats().total).toBe(1);

    res.emitClose();
    expect(fake.unsub).toHaveBeenCalledTimes(1);
    expect(connectionStats().total).toBe(0);
  });
});
