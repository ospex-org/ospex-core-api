/**
 * StreamHub engine tests — dependency-injected, so no timers/DB needed.
 * Covers fan-out, event-cursor dedup across overlap re-scans, filter matching,
 * toBody null-skip, poller ref-counting, and resync broadcast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { StreamHub, type Subscriber } from '../src/v1/stream/hub.js';
import { decodeCursor } from '../src/lib/cursor.js';

// Pin the clock to the row timestamps. The poller seeds its watermark from
// Date.now() and evicts dedupe entries older than now − 2×overlap; with a real
// clock the fixed test timestamps look "ancient" and get evicted between ticks.
const NOW = Date.parse('2026-05-20T12:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface MockResp {
  data: unknown;
  error: unknown;
}

/** Chainable supabase double whose terminal `await` shifts the next queued response. */
function makeClient() {
  const queue: MockResp[] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'or', 'gt', 'order', 'limit']) {
    builder[m] = (): unknown => builder;
  }
  builder['then'] = (resolve: (v: MockResp) => void): void => resolve(queue.shift() ?? { data: [], error: null });
  const client = { from: (): unknown => builder } as unknown as SupabaseClient;
  return { client, enqueue: (r: MockResp): number => queue.push(r) };
}

const TS = '2026-05-20T12:00:00.000Z';
function fillRow(id: number, o: Record<string, unknown> = {}): Record<string, unknown> {
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
    filled_at: TS,
    contest_started: false,
    tx_hash: `0x${'c'.repeat(64)}`,
    log_index: id,
    id,
    row_updated_at: TS,
    ...o,
  };
}

function newHub(client: SupabaseClient): StreamHub {
  // Long intervals so the internal timers never auto-fire; ticks are driven manually.
  return new StreamHub({ getClient: () => client, getNetwork: () => 'polygon', pollMs: 1e9, resyncMs: 1e9 });
}

function collector(resource: Subscriber['resource'], filters: Record<string, string> = {}) {
  const deltas: Array<{ body: unknown; cursorId: string }> = [];
  const resyncs: string[] = [];
  return {
    resource,
    filters,
    cb: {
      onDelta: (body: unknown, cursorId: string) => deltas.push({ body, cursorId }),
      onResync: (reason: string) => resyncs.push(reason),
    },
    deltas,
    resyncs,
  };
}

describe('StreamHub fan-out + dedup', () => {
  it('fans matching deltas out with live cursors, and dedupes across overlap re-scans', async () => {
    const { client, enqueue } = makeClient();
    const hub = newHub(client);
    const c = collector('fills');
    const sub = hub.subscribe('fills', c.filters, c.cb);

    enqueue({ data: [fillRow(1), fillRow(2)], error: null });
    await hub.pollResource('fills');
    expect(c.deltas).toHaveLength(2);
    // cursor is a live cursor for the fills resource
    const cur = decodeCursor(c.deltas[0]!.cursorId, 'fills');
    expect(cur.k).toBe('live');
    expect(cur.i).toBe('1');

    // Next tick re-scans the overlap window and returns the same rows — must not re-emit.
    enqueue({ data: [fillRow(1), fillRow(2)], error: null });
    await hub.pollResource('fills');
    expect(c.deltas).toHaveLength(2);

    // A genuinely new row IS emitted.
    enqueue({ data: [fillRow(1), fillRow(2), fillRow(3, { row_updated_at: '2026-05-20T12:00:01.000Z' })], error: null });
    await hub.pollResource('fills');
    expect(c.deltas).toHaveLength(3);

    hub.unsubscribe(sub);
  });

  it('only delivers rows matching a subscriber filter', async () => {
    const { client, enqueue } = makeClient();
    const hub = newHub(client);
    const mine = '0x2222222222222222222222222222222222222222';
    const c = collector('fills', { maker_address: mine });
    const sub = hub.subscribe('fills', c.filters, c.cb);

    enqueue({
      data: [fillRow(1, { maker_address: '0x9999999999999999999999999999999999999999' }), fillRow(2, { maker_address: mine })],
      error: null,
    });
    await hub.pollResource('fills');
    expect(c.deltas).toHaveLength(1);
    expect((c.deltas[0]!.body as { maker: string }).maker).toBe(mine);

    hub.unsubscribe(sub);
  });

  it('skips rows whose toBody returns null (unenriched speculation)', async () => {
    const { client, enqueue } = makeClient();
    const hub = newHub(client);
    const c = collector('speculations');
    const sub = hub.subscribe('speculations', c.filters, c.cb);

    enqueue({
      data: [
        { speculation_id: 1, contest_id: 1, market_type: null, line_ticks: 0, speculation_status: 'open', id: 1, row_updated_at: TS },
        { speculation_id: 2, contest_id: 1, market_type: 'moneyline', line_ticks: 0, speculation_status: 'open', id: 2, row_updated_at: TS },
      ],
      error: null,
    });
    await hub.pollResource('speculations');
    expect(c.deltas).toHaveLength(1); // the null-market_type row is dropped
    hub.unsubscribe(sub);
  });
});

describe('StreamHub poller ref-counting', () => {
  it('starts one poller per resource and stops it when the last subscriber leaves', () => {
    const { client } = makeClient();
    const hub = newHub(client);
    const a = hub.subscribe('fills', {}, collector('fills').cb);
    const b = hub.subscribe('fills', {}, collector('fills').cb);
    const c = hub.subscribe('commitments', {}, collector('commitments').cb);
    expect(hub.stats()).toEqual({ resources: 2, subscribers: 3 });

    hub.unsubscribe(a);
    expect(hub.stats()).toEqual({ resources: 2, subscribers: 2 }); // fills poller still up (b)
    hub.unsubscribe(b);
    expect(hub.stats()).toEqual({ resources: 1, subscribers: 1 }); // fills poller gone
    hub.unsubscribe(c);
    expect(hub.stats()).toEqual({ resources: 0, subscribers: 0 });
  });
});

describe('StreamHub resync', () => {
  it('baselines silently, then broadcasts resync for each newly-completed recovery', async () => {
    const { client, enqueue } = makeClient();
    const hub = newHub(client);
    const c = collector('positions');
    const sub = hub.subscribe('positions', {}, c.cb);

    // First resync poll: baseline to the current max completed id (no broadcast).
    enqueue({ data: [{ id: 5 }], error: null });
    await hub.pollResync();
    expect(c.resyncs).toHaveLength(0);

    // Next poll: two newly-completed runs → two resync broadcasts with their kinds.
    enqueue({ data: [{ id: 6, kind: 'reorg' }, { id: 7, kind: 'backfill' }], error: null });
    await hub.pollResync();
    expect(c.resyncs).toEqual(['reorg', 'backfill']);

    hub.unsubscribe(sub);
  });
});
