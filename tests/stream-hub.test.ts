/**
 * StreamHub engine tests. Uses a dataset-backed supabase double that actually
 * applies the keyset (`.or`), the overlap upper bound (`.lte`), and `.limit`,
 * so the poller is exercised the way it runs in prod. Pins the clock so the
 * poller's `tip` (seeded from Date.now()) sits just before the test rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { StreamHub, type Subscriber } from '../src/v1/stream/hub.js';
import { decodeCursor } from '../src/lib/cursor.js';

const NOW = Date.parse('2026-05-20T12:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface DRow {
  row_updated_at: string;
  id: number;
  [k: string]: unknown;
}
interface RRow {
  id: number;
  kind: string;
  status: string;
  completed_at?: string;
}

/** Builder state captured from a query chain. */
interface QState {
  or?: string;
  lteTs?: string;
  gtId?: string;
  gtCompletedAt?: string;
  ltCompletedAt?: string;
  limit: number;
  descId: boolean;
  descCompletedAt?: boolean;
  eqStatus?: string;
}

/** A supabase double that resolves queries against in-memory datasets. */
function datasetClient(rows: () => DRow[], recovery: () => RRow[]): SupabaseClient {
  const run = (table: string, st: QState): unknown[] => {
    if (table === 'recovery_runs') {
      let r = recovery().filter((x) => (st.eqStatus ? x.status === st.eqStatus : true));
      if (st.gtId !== undefined) r = r.filter((x) => BigInt(x.id) > BigInt(st.gtId as string));
      if (st.gtCompletedAt !== undefined) {
        const c = Date.parse(st.gtCompletedAt);
        r = r.filter((x) => x.completed_at !== undefined && Date.parse(x.completed_at) > c);
      }
      if (st.ltCompletedAt !== undefined) {
        const c = Date.parse(st.ltCompletedAt);
        r = r.filter((x) => x.completed_at !== undefined && Date.parse(x.completed_at) < c);
      }
      if (st.or !== undefined) {
        // Compound (completed_at, id) keyset used by the recovery watcher poll.
        const m = /^completed_at\.gt\.([^,]+),and\(completed_at\.eq\.([^,]+),id\.gt\.(\d+)\)$/.exec(st.or);
        if (m) {
          const cAt = Date.parse(m[1] as string);
          const cId = BigInt(m[3] as string);
          r = r.filter((x) => {
            if (x.completed_at === undefined) return false;
            const t = Date.parse(x.completed_at);
            return t > cAt || (t === cAt && BigInt(x.id) > cId);
          });
        }
      }
      r = [...r].sort((a, b) => {
        const ta = a.completed_at ? Date.parse(a.completed_at) : 0;
        const tb = b.completed_at ? Date.parse(b.completed_at) : 0;
        if (ta !== tb) return st.descCompletedAt ? tb - ta : ta - tb;
        return st.descId ? b.id - a.id : a.id - b.id;
      });
      return r.slice(0, st.limit);
    }
    let r = rows().slice();
    if (st.or !== undefined) {
      const m = /^row_updated_at\.gt\.([^,]+),and\(row_updated_at\.eq\.([^,]+),id\.gt\.(\d+)\)$/.exec(st.or);
      if (m) {
        const s = Date.parse(m[1] as string);
        const i = BigInt(m[3] as string);
        r = r.filter((x) => {
          const t = Date.parse(x.row_updated_at);
          return t > s || (t === s && BigInt(x.id) > i);
        });
      }
    }
    if (st.lteTs !== undefined) {
      const u = Date.parse(st.lteTs);
      r = r.filter((x) => Date.parse(x.row_updated_at) <= u);
    }
    r.sort((a, b) => {
      const ta = Date.parse(a.row_updated_at);
      const tb = Date.parse(b.row_updated_at);
      return ta !== tb ? ta - tb : a.id - b.id;
    });
    return r.slice(0, st.limit);
  };

  const makeBuilder = (table: string): unknown => {
    const st: QState = { limit: 1000, descId: false };
    const b: Record<string, unknown> = {};
    b['select'] = () => b;
    b['eq'] = (col: string, val: unknown) => {
      if (col === 'status') st.eqStatus = String(val);
      return b;
    };
    b['or'] = (e: string) => {
      st.or = e;
      return b;
    };
    b['lte'] = (col: string, val: unknown) => {
      if (col === 'row_updated_at') st.lteTs = String(val);
      return b;
    };
    b['lt'] = (col: string, val: unknown) => {
      if (col === 'completed_at') st.ltCompletedAt = String(val);
      return b;
    };
    b['gt'] = (col: string, val: unknown) => {
      if (col === 'id') st.gtId = String(val);
      else if (col === 'completed_at') st.gtCompletedAt = String(val);
      return b;
    };
    b['order'] = (col: string, opts?: { ascending?: boolean }) => {
      if (col === 'id' && opts && opts.ascending === false) st.descId = true;
      if (col === 'completed_at' && opts && opts.ascending === false) st.descCompletedAt = true;
      return b;
    };
    b['limit'] = (n: number) => {
      st.limit = n;
      return b;
    };
    b['then'] = (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: run(table, st), error: null });
    return b;
  };
  return { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient;
}

const TS = (sec: number): string => new Date(NOW + sec * 1000).toISOString();
function fillRow(id: number, sec: number, o: Record<string, unknown> = {}): DRow {
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
    filled_at: TS(sec),
    contest_started: false,
    tx_hash: `0x${'c'.repeat(64)}`,
    log_index: id,
    id,
    row_updated_at: TS(sec),
    ...o,
  };
}

function collector(resource: Subscriber['resource'], filters: Record<string, string> = {}) {
  const deltas: Array<{ body: unknown; cursorId: string }> = [];
  const resyncs: string[] = [];
  return {
    filters,
    cb: {
      onDelta: (body: unknown, cursorId: string) => deltas.push({ body, cursorId }),
      onResync: (reason: string) => resyncs.push(reason),
    },
    deltas,
    resyncs,
    resource,
  };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe('StreamHub forward drain — no starvation under a page budget', () => {
  it('reaches every row across ticks even when the per-tick budget is small', async () => {
    // Starvation regression: a small budget + floor re-scan kept re-reading
    // rows 1-4 and never reached row 5. With a strict advancing tip, each
    // tick makes forward progress.
    const data = [fillRow(1, 1), fillRow(2, 2), fillRow(3, 3), fillRow(4, 4), fillRow(5, 5)];
    const hub = new StreamHub({
      getClient: () => datasetClient(() => data, () => []),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
      overlapMs: 0,
      pollLimit: 2,
      maxForwardPages: 1, // only 2 rows of forward progress per tick
    });
    const c = collector('fills');
    const sub = hub.subscribe('fills', c.filters, c.cb);

    await hub.pollResource('fills'); // rows 1,2
    await hub.pollResource('fills'); // rows 3,4
    await hub.pollResource('fills'); // row 5
    const ids = c.deltas.map((d) => decodeCursor(d.cursorId, 'fills').i);
    expect(ids).toEqual(['1', '2', '3', '4', '5']);

    hub.unsubscribe(sub);
  });
});

describe('StreamHub dedup + overlap', () => {
  function hubFor(data: DRow[]): StreamHub {
    return new StreamHub({
      getClient: () => datasetClient(() => data, () => []),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
  }

  it('emits each row once across overlap re-scans, and picks up new + late rows', async () => {
    const data = [fillRow(1, 1), fillRow(2, 2)];
    const hub = hubFor(data);
    const c = collector('fills');
    const sub = hub.subscribe('fills', c.filters, c.cb);

    await hub.pollResource('fills');
    expect(c.deltas).toHaveLength(2);
    const cur = decodeCursor(c.deltas[0]!.cursorId, 'fills');
    expect(cur.k).toBe('live');

    // Re-poll with no new data — overlap re-scan must not re-emit.
    await hub.pollResource('fills');
    expect(c.deltas).toHaveLength(2);

    // A new (forward) row and a late row (older ts, within the overlap window).
    data.push(fillRow(3, 3));
    data.push(fillRow(4, 1, { id: 4 })); // ts = +1s (older than tip), id 4
    await hub.pollResource('fills');
    const ids = c.deltas.map((d) => decodeCursor(d.cursorId, 'fills').i).sort();
    expect(ids).toEqual(['1', '2', '3', '4']); // late row 4 caught by the overlap re-scan

    hub.unsubscribe(sub);
  });

  it('only delivers rows matching a subscriber filter', async () => {
    const mine = '0x2222222222222222222222222222222222222222';
    const data = [fillRow(1, 1, { maker_address: '0x9999999999999999999999999999999999999999' }), fillRow(2, 2, { maker_address: mine })];
    const hub = hubFor(data);
    const c = collector('fills', { maker_address: mine });
    const sub = hub.subscribe('fills', c.filters, c.cb);

    await hub.pollResource('fills');
    expect(c.deltas).toHaveLength(1);
    expect((c.deltas[0]!.body as { maker: string }).maker).toBe(mine);

    hub.unsubscribe(sub);
  });

  it('skips rows whose toBody returns null (unenriched speculation)', async () => {
    const data: DRow[] = [
      { speculation_id: 1, contest_id: 1, market_type: null, line_ticks: 0, speculation_status: 'open', id: 1, row_updated_at: TS(1) },
      { speculation_id: 2, contest_id: 1, market_type: 'moneyline', line_ticks: 0, speculation_status: 'open', id: 2, row_updated_at: TS(2) },
    ];
    const hub = hubFor(data);
    const c = collector('speculations');
    const sub = hub.subscribe('speculations', c.filters, c.cb);
    await hub.pollResource('speculations');
    expect(c.deltas).toHaveLength(1);
    hub.unsubscribe(sub);
  });
});

describe('StreamHub overlap window (blocker 1)', () => {
  it('drains a multi-page overlap window to reach a late row (no overlap starvation)', async () => {
    const data = [fillRow(1, 1), fillRow(2, 2), fillRow(3, 3), fillRow(4, 4)];
    const hub = new StreamHub({
      getClient: () => datasetClient(() => data, () => []),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
      overlapMs: 60_000, // window covers all rows
      pollLimit: 2, // small pages → the window spans multiple overlap pages
    });
    const c = collector('fills');
    const sub = hub.subscribe('fills', c.filters, c.cb);

    await hub.pollResource('fills'); // forward-emits 1-4
    expect(c.deltas).toHaveLength(4);

    // A late commit lands in the MIDDLE of the already-emitted window. The
    // overlap re-scan must page past the deduped 1,2 to reach it.
    data.push(fillRow(5, 2.5));
    await hub.pollResource('fills');
    const ids = c.deltas.map((d) => decodeCursor(d.cursorId, 'fills').i).sort((a, b) => Number(a) - Number(b));
    expect(ids).toEqual(['1', '2', '3', '4', '5']);

    hub.unsubscribe(sub);
  });

  it('broadcasts resync when the overlap window exceeds the page budget', async () => {
    const data = [fillRow(1, 1), fillRow(2, 2)];
    const hub = new StreamHub({
      getClient: () => datasetClient(() => data, () => []),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
      overlapMs: 60_000,
      pollLimit: 1,
      maxOverlapPages: 1, // can't fully re-read a 2-row window in one tick
    });
    const c = collector('fills');
    const sub = hub.subscribe('fills', c.filters, c.cb);
    expect(hub.stats().resyncBroadcastTotal).toBe(0);
    await hub.pollResource('fills');
    expect(c.resyncs).toContain('overlap_window_too_large');
    // Each resyncResource() call bumps the counter once (regardless of subscriber count).
    expect(hub.stats().resyncBroadcastTotal).toBe(1);
    hub.unsubscribe(sub);
  });

  it('cumulatively counts resyncBroadcastTotal across multiple overflow ticks', async () => {
    const data = [fillRow(1, 1), fillRow(2, 2)];
    const hub = new StreamHub({
      getClient: () => datasetClient(() => data, () => []),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
      overlapMs: 60_000,
      pollLimit: 1,
      maxOverlapPages: 1,
    });
    const c = collector('fills');
    const sub = hub.subscribe('fills', c.filters, c.cb);
    await hub.pollResource('fills');
    await hub.pollResource('fills');
    await hub.pollResource('fills');
    expect(hub.stats().resyncBroadcastTotal).toBe(3);
    hub.unsubscribe(sub);
  });
});

describe('StreamHub per-subscriber recovery check (blocker 3)', () => {
  it('re-syncs a subscriber that connects soon after a recovery completed', async () => {
    const recovery: RRow[] = [
      { id: 1, kind: 'reorg', status: 'complete', completed_at: new Date(NOW - 5_000).toISOString() },
    ];
    const hub = new StreamHub({
      getClient: () => datasetClient(() => [], () => recovery),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
      resyncGraceMs: 60_000,
    });
    const c = collector('positions');
    const sub = hub.subscribe('positions', {}, c.cb);
    await flush(); // checkRecentRecovery is async
    expect(c.resyncs).toContain('recovery'); // checkRecentRecovery's reason
    hub.unsubscribe(sub);
  });
});

describe('StreamHub poller ref-counting', () => {
  it('starts one poller per resource and stops it when the last subscriber leaves', () => {
    const hub = new StreamHub({ getClient: () => datasetClient(() => [], () => []), getNetwork: () => 'polygon', pollMs: 1e9, resyncMs: 1e9 });
    const a = hub.subscribe('fills', {}, collector('fills').cb);
    const b = hub.subscribe('fills', {}, collector('fills').cb);
    const c = hub.subscribe('commitments', {}, collector('commitments').cb);
    expect(hub.stats()).toEqual({ resources: 2, subscribers: 3, resyncBroadcastTotal: 0 });
    hub.unsubscribe(a);
    expect(hub.stats()).toEqual({ resources: 2, subscribers: 2, resyncBroadcastTotal: 0 });
    hub.unsubscribe(b);
    expect(hub.stats()).toEqual({ resources: 1, subscribers: 1, resyncBroadcastTotal: 0 });
    hub.unsubscribe(c);
    expect(hub.stats()).toEqual({ resources: 0, subscribers: 0, resyncBroadcastTotal: 0 });
  });
});

describe('StreamHub resync', () => {
  it('baselines on subscribe, then broadcasts resync for each newly-completed recovery', async () => {
    const recovery: RRow[] = [];
    const hub = new StreamHub({
      getClient: () => datasetClient(() => [], () => recovery),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const c = collector('positions');
    const sub = hub.subscribe('positions', {}, c.cb); // kicks an immediate baseline poll
    await flush(); // let the immediate baseline settle (resyncHighId = 0, empty dataset)
    expect(c.resyncs).toHaveLength(0);

    recovery.push(
      { id: 6, kind: 'reorg', status: 'complete', completed_at: new Date(NOW - 2_000).toISOString() },
      { id: 7, kind: 'backfill', status: 'complete', completed_at: new Date(NOW - 1_000).toISOString() },
    );
    await hub.pollResync();
    expect(c.resyncs).toEqual(['reorg', 'backfill']);

    // Already-broadcast completions aren't repeated.
    await hub.pollResync();
    expect(c.resyncs).toEqual(['reorg', 'backfill']);

    hub.unsubscribe(sub);
  });

  it('broadcasts by completion time, not id (a lower-id recovery that completes later is not skipped)', async () => {
    // recovery_runs.id is assigned at run start; a long-running lower-id run can
    // complete after a higher-id one. An id-cursor would skip it — a completed_at
    // cursor does not.
    const recovery: RRow[] = [
      { id: 2, kind: 'reorg', status: 'complete', completed_at: new Date(NOW - 4_000).toISOString() }, // higher id, earlier completion
      { id: 1, kind: 'backfill', status: 'complete', completed_at: new Date(NOW - 2_000).toISOString() }, // lower id, later completion
    ];
    const hub = new StreamHub({
      getClient: () => datasetClient(() => [], () => recovery),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
      resyncGraceMs: 60_000,
    });
    const c = collector('positions');
    const sub = hub.subscribe('positions', {}, c.cb);
    await flush();
    // Both are broadcast, ordered by completion time — the lower-id one included.
    expect(c.resyncs).toContain('reorg');
    expect(c.resyncs).toContain('backfill');
    hub.unsubscribe(sub);
  });

  it('is tie-safe at the page boundary — 51 completions sharing one completed_at all broadcast', async () => {
    // With a completed_at-only cursor, poll 1 (limit 50) advances the watermark
    // to T and poll 2 (completed_at > T) skips the 51st forever. The compound
    // (completed_at, id) cursor resumes at id > 50 within the same timestamp.
    const t = new Date(NOW - 5_000).toISOString();
    const recovery: RRow[] = Array.from({ length: 51 }, (_, k) => ({
      id: k + 1,
      kind: 'reorg',
      status: 'complete',
      completed_at: t,
    }));
    const hub = new StreamHub({
      getClient: () => datasetClient(() => [], () => recovery),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
      resyncGraceMs: 60_000,
    });
    const c = collector('positions');
    const sub = hub.subscribe('positions', {}, c.cb); // immediate poll → first 50
    await flush();
    await hub.pollResync(); // second poll → the 51st (id > 50 at the same completed_at)
    // 'reorg' is the broadcast kind (checkRecentRecovery emits the distinct 'recovery').
    expect(c.resyncs.filter((r) => r === 'reorg')).toHaveLength(51);
    hub.unsubscribe(sub);
  });

  it('does not absorb a within-grace recovery — the baseline excludes it and the first poll broadcasts it', async () => {
    // The race: a recovery completing right around the first subscribe must not
    // be swallowed by the baseline. The baseline excludes completions newer than
    // the grace window, so this one has id > baseline and is broadcast.
    const recovery: RRow[] = [
      { id: 9, kind: 'reorg', status: 'complete', completed_at: new Date(NOW - 5_000).toISOString() },
    ];
    const hub = new StreamHub({
      getClient: () => datasetClient(() => [], () => recovery),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
      resyncGraceMs: 60_000,
    });
    const c = collector('positions');
    const sub = hub.subscribe('positions', {}, c.cb); // kicks the immediate baseline + broadcast
    await flush();
    // 'reorg' is the recovery's kind, emitted only by the broadcast path — its
    // presence proves the baseline did NOT absorb the within-grace completion.
    expect(c.resyncs).toContain('reorg');
    hub.unsubscribe(sub);
  });

  it('absorbs a recovery older than the grace window (a fresh snapshot already has it)', async () => {
    const recovery: RRow[] = [
      { id: 9, kind: 'reorg', status: 'complete', completed_at: new Date(NOW - 120_000).toISOString() },
    ];
    const hub = new StreamHub({
      getClient: () => datasetClient(() => [], () => recovery),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
      resyncGraceMs: 60_000,
    });
    const c = collector('positions');
    const sub = hub.subscribe('positions', {}, c.cb);
    await flush();
    expect(c.resyncs).toHaveLength(0);
    hub.unsubscribe(sub);
  });
});
