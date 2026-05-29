/**
 * `OwnStateHub` unit tests — per-wallet poller engine.
 *
 * Drives `pollWallet` directly so the tests don't depend on real timers,
 * and uses a table-keyed scripted-response supabase double. The hub's
 * forward + overlap dedup contract means returning the same row twice
 * (forward + overlap) should only emit once; that's tested explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const NOW = Date.parse('2026-05-29T16:00:00.000Z');
const ADDRESS = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const { OwnStateHub } = await import('../src/v1/ownState/hub.js');

interface Row {
  [k: string]: unknown;
}

/**
 * Scripted client: each `from(table)` call resolves to the table's current
 * scripted dataset. Filters are not enforced (the hub's keyset / overlap
 * logic is exercised via repeat ticks rather than dataset semantics) — the
 * tests assert behavior via the emit callbacks instead.
 */
function makeClient(data: Record<string, Row[]>): SupabaseClient {
  const builder = (table: string): unknown => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'in', 'lte', 'lt', 'gt', 'order', 'limit']) {
      b[m] = (): unknown => b;
    }
    b['then'] = (resolve: (v: { data: unknown; error: null }) => void): void =>
      resolve({ data: data[table] ?? [], error: null });
    return b;
  };
  return { from: (table: string): unknown => builder(table) } as unknown as SupabaseClient;
}

function commitmentRow(over: Row = {}): Row {
  return {
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
    ...over,
  };
}

function fillRow(over: Row = {}): Row {
  return {
    speculation_id: 5,
    contest_id: 1,
    commitment_hash: `0x${'b'.repeat(64)}`,
    maker_address: ADDRESS,
    taker_address: `0x${'3'.repeat(40)}`,
    maker_position_type: 'upper',
    taker_position_type: 'lower',
    maker_risk_amount: '1000000',
    taker_risk_amount: '900000',
    odds_tick: 200,
    filled_at: '2026-05-29T15:01:00.000Z',
    contest_started: false,
    tx_hash: `0x${'c'.repeat(64)}`,
    log_index: 0,
    id: 9,
    row_updated_at: '2026-05-29T15:01:00.000Z',
    ...over,
  };
}

function positionRow(over: Row = {}): Row {
  return {
    speculation_id: 101,
    user_address: ADDRESS,
    position_type: 'upper',
    risk_amount: '1000000',
    profit_amount: '500000',
    claimed: false,
    row_updated_at: '2026-05-29T15:02:00.000Z',
    id: 7,
    ...over,
  };
}

function speculationRow(over: Row = {}): Row {
  return {
    speculation_id: 101,
    contest_id: 42,
    market_type: 'moneyline',
    line_ticks: null,
    speculation_status: 'open',
    win_side: 'tbd',
    ...over,
  };
}

function contestRow(over: Row = {}): Row {
  return {
    contest_id: 42,
    contest_status: 'scored',
    away_score: 10,
    home_score: 5,
    ...over,
  };
}

interface RecordedEvents {
  commitments: Array<{ ts: string; id: string; commitmentHash: string }>;
  fills: Array<{ ts: string; id: string; commitmentHash: string }>;
  positionStatuses: Array<{ ts: string; id: string; status: string }>;
  resyncs: string[];
}
function makeCallbacks(): RecordedEvents & {
  onCommitment: (b: { commitmentHash: string }, ts: string, id: string) => void;
  onFill: (b: { commitmentHash: string }, ts: string, id: string) => void;
  onPositionStatus: (b: { status: string }, ts: string, id: string) => void;
  onResync: (r: string) => void;
} {
  const ev: RecordedEvents = {
    commitments: [],
    fills: [],
    positionStatuses: [],
    resyncs: [],
  };
  return {
    ...ev,
    onCommitment(b, ts, id) {
      ev.commitments.push({ ts, id, commitmentHash: b.commitmentHash });
    },
    onFill(b, ts, id) {
      ev.fills.push({ ts, id, commitmentHash: b.commitmentHash });
    },
    onPositionStatus(b, ts, id) {
      ev.positionStatuses.push({ ts, id, status: b.status });
    },
    onResync(r) {
      ev.resyncs.push(r);
    },
  };
}

describe('OwnStateHub.subscribe + unsubscribe', () => {
  it('runs a per-wallet poller that stops when the last sub leaves', () => {
    const hub = new OwnStateHub({
      getClient: () => makeClient({}),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    const sub = hub.subscribe(ADDRESS, cb);
    expect(hub.stats().wallets).toBe(1);
    expect(hub.stats().subscribers).toBe(1);
    hub.unsubscribe(sub);
    expect(hub.stats().wallets).toBe(0);
    expect(hub.stats().subscribers).toBe(0);
  });

  it('keeps the poller alive while at least one subscriber remains', () => {
    const hub = new OwnStateHub({
      getClient: () => makeClient({}),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const a = hub.subscribe(ADDRESS, makeCallbacks());
    const b = hub.subscribe(ADDRESS, makeCallbacks());
    expect(hub.stats().subscribers).toBe(2);
    hub.unsubscribe(a);
    expect(hub.stats().wallets).toBe(1); // still running for `b`
    hub.unsubscribe(b);
    expect(hub.stats().wallets).toBe(0);
  });
});

describe('OwnStateHub.pollWallet — single tick emits per resource', () => {
  it('emits onCommitment with body + (ts, id)', async () => {
    const row = commitmentRow();
    const hub = new OwnStateHub({
      getClient: () => makeClient({ commitments: [row] }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    await hub.pollWallet(ADDRESS);
    expect(cb.commitments).toEqual([
      { ts: row.row_updated_at, id: String(row.id), commitmentHash: row.commitment_hash },
    ]);
  });

  it('emits onFill with body + (ts, id)', async () => {
    const row = fillRow();
    const hub = new OwnStateHub({
      getClient: () => makeClient({ position_fills: [row] }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    await hub.pollWallet(ADDRESS);
    expect(cb.fills).toEqual([
      { ts: row.row_updated_at, id: String(row.id), commitmentHash: row.commitment_hash },
    ]);
  });

  it('emits onPositionStatus, joining speculations + contests for derivation', async () => {
    const row = positionRow();
    const spec = speculationRow();
    const contest = contestRow();
    const hub = new OwnStateHub({
      getClient: () =>
        makeClient({
          positions: [row],
          speculations: [spec],
          contests: [contest],
        }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    await hub.pollWallet(ADDRESS);
    // away 10 home 5 → upper (=away) wins predicted → pendingSettle
    expect(cb.positionStatuses).toEqual([
      { ts: row.row_updated_at, id: String(row.id), status: 'pendingSettle' },
    ]);
  });

  it('does not re-emit on a second tick — dedup catches the overlap re-scan', async () => {
    const row = commitmentRow();
    const hub = new OwnStateHub({
      getClient: () => makeClient({ commitments: [row] }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    await hub.pollWallet(ADDRESS);
    await hub.pollWallet(ADDRESS);
    expect(cb.commitments).toHaveLength(1);
  });

  it('skips a position whose speculation row is missing from the join', async () => {
    const row = positionRow();
    const hub = new OwnStateHub({
      getClient: () =>
        makeClient({
          positions: [row],
          speculations: [], // orphan → skip
          contests: [],
        }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toEqual([]);
  });

  it('catches an upstream recovery via resync broadcast', async () => {
    const hub = new OwnStateHub({
      getClient: () =>
        makeClient({
          recovery_runs: [{ completed_at: '2026-05-29T15:59:50.000Z', id: 1, kind: 'reorg' }],
        }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    // The recent-recovery check on subscribe fires asynchronously.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cb.resyncs).toContain('recovery');
  });
});
