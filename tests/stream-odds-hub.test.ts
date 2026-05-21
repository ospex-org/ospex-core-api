/**
 * OddsHub tests. A fake Supabase Realtime channel lets the test drive
 * postgres_changes payloads and channel-status transitions directly, so the
 * classify → map → fan-out path and the readiness/degraded/reset lifecycle run
 * exactly as in prod, without a websocket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { OddsHub } from '../src/v1/stream/oddsHub.js';
import type { MarketOdds, OddsMarket } from '../src/v1/utils/odds.js';

const T1 = '2026-05-20T12:00:00.000Z';
const T2 = '2026-05-20T12:00:30.000Z';

afterEach(() => vi.useRealTimers());

interface FakeChannel {
  name: string;
  changeCb?: (p: unknown) => void;
  statusCb?: (s: string, e?: Error) => void;
  removed: boolean;
  on: (ev: unknown, cfg: unknown, cb: (p: unknown) => void) => FakeChannel;
  subscribe: (cb: (s: string, e?: Error) => void) => FakeChannel;
  emit: (p: unknown) => void;
  status: (s: string, e?: Error) => void;
}

function makeRealtime(): { client: SupabaseClient; channels: FakeChannel[] } {
  const channels: FakeChannel[] = [];
  const client = {
    channel(name: string): FakeChannel {
      const ch: FakeChannel = {
        name,
        removed: false,
        on(_ev, _cfg, cb) {
          ch.changeCb = cb;
          return ch;
        },
        subscribe(cb) {
          ch.statusCb = cb;
          return ch;
        },
        emit(p) {
          ch.changeCb?.(p);
        },
        status(s, e) {
          ch.statusCb?.(s, e);
        },
      };
      channels.push(ch);
      return ch;
    },
    removeChannel(ch: unknown): Promise<string> {
      (ch as FakeChannel).removed = true;
      return Promise.resolve('ok');
    },
  };
  return { client: client as unknown as SupabaseClient, channels };
}

interface Collector {
  jsonoddsId: string;
  market: OddsMarket;
  changes: MarketOdds[];
  refreshes: MarketOdds[];
  degraded: string[];
  actives: number;
  cb: {
    onChange: (o: MarketOdds) => void;
    onRefresh: (o: MarketOdds) => void;
    onDegraded: (r: string) => void;
    onActive: () => void;
  };
}
function collector(jsonoddsId: string, market: OddsMarket): Collector {
  const c: Collector = {
    jsonoddsId,
    market,
    changes: [],
    refreshes: [],
    degraded: [],
    actives: 0,
    cb: {
      onChange: (o) => c.changes.push(o),
      onRefresh: (o) => c.refreshes.push(o),
      onDegraded: (r) => c.degraded.push(r),
      onActive: () => {
        c.actives += 1;
      },
    },
  };
  return c;
}

function oddsRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: 'polygon',
    jsonodds_id: 'jo-1',
    market: 'spread',
    line: -3.5,
    away_odds_american: -110,
    home_odds_american: -110,
    upstream_last_updated: T1,
    poll_captured_at: T1,
    changed_at: T1,
    ...o,
  };
}
function evt(newRow: Record<string, unknown> | null, oldRow: Record<string, unknown> | null = null): unknown {
  return { eventType: 'UPDATE', new: newRow ?? {}, old: oldRow ?? {} };
}

// Large reset delay so the backstop timer never fires in tests that don't drive it.
function makeHub(client: SupabaseClient, resetDelayMs = 1e9): OddsHub {
  return new OddsHub({ getClient: () => client, getNetwork: () => 'polygon', resetDelayMs });
}

describe('OddsHub lifecycle', () => {
  it('opens a channel lazily on the first subscriber and closes it on the last unsubscribe', () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    expect(hub.stats().channelOpen).toBe(false);

    const c = collector('jo-1', 'spread');
    const sub = hub.subscribe(c.jsonoddsId, c.market, c.cb);
    expect(channels).toHaveLength(1);
    expect(hub.stats().channelOpen).toBe(true);

    hub.unsubscribe(sub);
    expect(channels[0]?.removed).toBe(true);
    expect(hub.stats().channelOpen).toBe(false);
  });

  it('fires onActive (deferred) for a subscriber that joins an already-subscribed channel', async () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    const c1 = collector('jo-1', 'spread');
    hub.subscribe(c1.jsonoddsId, c1.market, c1.cb);
    channels[0]?.status('SUBSCRIBED');
    expect(c1.actives).toBe(1);

    const c2 = collector('jo-2', 'total');
    hub.subscribe(c2.jsonoddsId, c2.market, c2.cb);
    expect(c2.actives).toBe(0); // deferred to a microtask
    await Promise.resolve();
    expect(c2.actives).toBe(1); // late joiner caught up to the live channel
  });
});

describe('OddsHub fan-out + classification', () => {
  it('delivers a price move as a mapped change to the matching subscriber', () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    const c = collector('jo-1', 'spread');
    hub.subscribe(c.jsonoddsId, c.market, c.cb);

    channels[0]?.emit(evt(oddsRow({ away_odds_american: -120 }), oddsRow()));

    expect(c.changes).toHaveLength(1);
    const got = c.changes[0];
    expect(got?.market).toBe('spread');
    expect(got).toMatchObject({ homeLine: -3.5, awayLine: 3.5, awayOddsAmerican: -120 });
    expect(got).not.toHaveProperty('jsonoddsId');
    expect(c.refreshes).toHaveLength(0);
  });

  it('delivers a no-price re-poll as a refresh', () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    const c = collector('jo-1', 'spread');
    hub.subscribe(c.jsonoddsId, c.market, c.cb);

    channels[0]?.emit(evt(oddsRow({ poll_captured_at: T2 }), oddsRow()));

    expect(c.refreshes).toHaveLength(1);
    expect(c.changes).toHaveLength(0);
  });

  it('drops a no-op (none) update', () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    const c = collector('jo-1', 'spread');
    hub.subscribe(c.jsonoddsId, c.market, c.cb);

    channels[0]?.emit(evt(oddsRow(), oddsRow()));

    expect(c.changes).toHaveLength(0);
    expect(c.refreshes).toHaveLength(0);
  });

  it('treats an INSERT (empty old) as a change and ignores a DELETE (empty new)', () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    const c = collector('jo-1', 'spread');
    hub.subscribe(c.jsonoddsId, c.market, c.cb);

    channels[0]?.emit({ eventType: 'INSERT', new: oddsRow(), old: {} });
    expect(c.changes).toHaveLength(1);

    channels[0]?.emit({ eventType: 'DELETE', new: {}, old: oddsRow() });
    expect(c.changes).toHaveLength(1); // unchanged — DELETE ignored
  });

  it('routes only to subscribers matching (jsonoddsId, market)', () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    const spread = collector('jo-1', 'spread');
    const total = collector('jo-1', 'total');
    const other = collector('jo-2', 'spread');
    hub.subscribe(spread.jsonoddsId, spread.market, spread.cb);
    hub.subscribe(total.jsonoddsId, total.market, total.cb);
    hub.subscribe(other.jsonoddsId, other.market, other.cb);

    channels[0]?.emit(evt(oddsRow({ away_odds_american: -120 }), oddsRow()));

    expect(spread.changes).toHaveLength(1);
    expect(total.changes).toHaveLength(0); // wrong market
    expect(other.changes).toHaveLength(0); // wrong game
  });

  it('ignores rows for another network', () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    const c = collector('jo-1', 'spread');
    hub.subscribe(c.jsonoddsId, c.market, c.cb);

    channels[0]?.emit(evt(oddsRow({ network: 'amoy', away_odds_american: -120 }), oddsRow({ network: 'amoy' })));

    expect(c.changes).toHaveLength(0);
  });
});

describe('OddsHub readiness + degradation', () => {
  it('broadcasts onActive on the first SUBSCRIBED (initial snapshot trigger)', () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    const c = collector('jo-1', 'spread');
    hub.subscribe(c.jsonoddsId, c.market, c.cb);

    channels[0]?.status('SUBSCRIBED');
    expect(c.actives).toBe(1);
    expect(hub.stats().subscribed).toBe(true);
  });

  it('broadcasts degraded once per outage, then onActive on return to SUBSCRIBED', () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    const c = collector('jo-1', 'spread');
    hub.subscribe(c.jsonoddsId, c.market, c.cb);

    channels[0]?.status('SUBSCRIBED'); // initial
    expect(c.actives).toBe(1);

    channels[0]?.status('CHANNEL_ERROR');
    expect(c.degraded).toEqual(['channel_error']);
    expect(hub.isDegraded()).toBe(true);

    channels[0]?.status('CHANNEL_ERROR'); // still degraded — must not re-fire
    expect(c.degraded).toHaveLength(1);

    channels[0]?.status('SUBSCRIBED'); // recovery
    expect(c.actives).toBe(2);
    expect(hub.isDegraded()).toBe(false);
  });

  it('treats an unexpected CLOSED as degraded', () => {
    const { client, channels } = makeRealtime();
    const hub = makeHub(client);
    const c = collector('jo-1', 'spread');
    hub.subscribe(c.jsonoddsId, c.market, c.cb);

    channels[0]?.status('SUBSCRIBED');
    channels[0]?.status('CLOSED');
    expect(c.degraded).toEqual(['closed']);
    expect(hub.isDegraded()).toBe(true);
    expect(hub.stats().subscribed).toBe(false);
  });

  it('hard-resets the channel as a backstop and ignores the torn-down channel afterwards', async () => {
    vi.useFakeTimers();
    const { client, channels } = makeRealtime();
    const hub = makeHub(client, 10_000);
    const c = collector('jo-1', 'spread');
    hub.subscribe(c.jsonoddsId, c.market, c.cb);

    channels[0]?.status('CHANNEL_ERROR');
    expect(c.degraded).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000); // reset backstop fires

    expect(channels[0]?.removed).toBe(true);
    expect(channels).toHaveLength(2);

    // A late status callback from the OLD channel must be ignored.
    channels[0]?.status('SUBSCRIBED');
    expect(c.actives).toBe(0);

    // The current channel coming up triggers onActive (resnapshot).
    channels[1]?.status('SUBSCRIBED');
    expect(c.actives).toBe(1);
    expect(hub.isDegraded()).toBe(false);
  });
});
