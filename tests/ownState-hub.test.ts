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

  it('without a seeded cache, first tick emits every observed position (preReady-abort signal)', async () => {
    // Contract change vs M4b PR1: there is no bootstrap-silent mode. If
    // the handler forgot to seed the cache before `beginLive`, every
    // tick emits the current derivation — those emits arrive in the
    // subscriber's preReady phase and trip the handler's `aborted=true`,
    // forcing `resync` rather than a silent miss.
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
    expect(cb.positionStatuses).toHaveLength(1);
  });

  it('seedStatusCache + matching tick = no-op (no emit)', async () => {
    // The handler's catch-up seeds every position it discovered; if the
    // hub's first tick observes the same statuses, no emit fires.
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
    // Pre-seed with the FULL payload the derivation will produce
    // (away 10 / home 5 + upper position ⇒ pendingSettle, result='won',
    // claimableAmount = risk + profit = 1M + 500k = 1.5M wei6). The
    // dedup now compares result + claimableAmount too, so missing fields
    // in the seed would force a spurious emit on the first tick.
    hub.seedStatusCache(ADDRESS, [
      {
        key: `${row.speculation_id}_0`,
        status: 'pendingSettle',
        sourceUpdatedAt: row.row_updated_at as string,
        result: 'won',
        claimableAmount: '1500000',
      },
    ]);
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toEqual([]);
  });

  it('emits onPositionStatus when derived status differs from seeded entry (claim flip)', async () => {
    const row = positionRow();
    const spec = speculationRow();
    const contest = contestRow();
    let positionsData: Row[] = [row];

    const hub = new OwnStateHub({
      getClient: () =>
        makeClient({
          positions: positionsData,
          speculations: [spec],
          contests: [contest],
        }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    // Seed with the status the catch-up would have observed (active/pendingSettle).
    hub.seedStatusCache(ADDRESS, [
      {
        key: `${row.speculation_id}_0`,
        status: 'pendingSettle',
        sourceUpdatedAt: row.row_updated_at as string,
      },
    ]);
    // Flip claimed=true with bumped row_updated_at on the position row.
    // The new row is `claimed=true`, so the actionable filter drops it —
    // but the cached-key refresh phase re-fetches by spec_id and surfaces
    // the transition before the cache entry falls out of tracking.
    const claimedRow = {
      ...row,
      claimed: true,
      row_updated_at: '2026-05-29T15:40:00.000Z',
    };
    positionsData.length = 0;
    positionsData.push(claimedRow);
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toEqual([
      { ts: '2026-05-29T15:40:00.000Z', id: String(row.id), status: 'claimed' },
    ]);
  });

  it('spec-only transition (speculation_status open→closed, position row unchanged) ⇒ emit', async () => {
    const row = positionRow();
    const specBefore = speculationRow({ speculation_status: 'open', win_side: 'tbd' });
    const contestBefore = contestRow({ contest_status: 'unverified', away_score: null, home_score: null });
    let specs: Row[] = [specBefore];
    let contests: Row[] = [contestBefore];

    const hub = new OwnStateHub({
      getClient: () =>
        makeClient({
          positions: [row],
          speculations: specs,
          contests: contests,
        }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    // Seed with the status the catch-up would have observed (active).
    hub.seedStatusCache(ADDRESS, [
      {
        key: `${row.speculation_id}_0`,
        status: 'active',
        sourceUpdatedAt: row.row_updated_at as string,
      },
    ]);
    // Tick now: spec hasn't changed yet → still 'active' → no emit.
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toEqual([]);
    // Spec settles. Position row.row_updated_at UNCHANGED — raw-row
    // dedup would have missed this; the semantic-key dedup catches it.
    const specAfter = speculationRow({
      speculation_status: 'closed',
      win_side: 'away',
      row_updated_at: '2026-05-29T15:30:00.000Z',
    });
    specs.length = 0;
    specs.push(specAfter);
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toEqual([
      {
        // sourceUpdatedAt is max of (position, spec, contest) — the spec here.
        ts: '2026-05-29T15:30:00.000Z',
        id: String(row.id),
        status: 'claimable',
      },
    ]);
  });

  it('contest-only transition (contest unverified→scored, position+spec unchanged) ⇒ emit', async () => {
    const row = positionRow();
    const specStaticOpen = speculationRow({ speculation_status: 'open', win_side: 'tbd' });
    const contestBefore = contestRow({ contest_status: 'unverified', away_score: null, home_score: null });
    let contests: Row[] = [contestBefore];

    const hub = new OwnStateHub({
      getClient: () =>
        makeClient({
          positions: [row],
          speculations: [specStaticOpen],
          contests: contests,
        }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    hub.seedStatusCache(ADDRESS, [
      {
        key: `${row.speculation_id}_0`,
        status: 'active',
        sourceUpdatedAt: row.row_updated_at as string,
      },
    ]);
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toEqual([]);
    // Contest scored (upper/away predicted winner).
    const contestAfter = contestRow({
      contest_status: 'scored',
      away_score: 10,
      home_score: 5,
      row_updated_at: '2026-05-29T15:35:00.000Z',
    });
    contests.length = 0;
    contests.push(contestAfter);
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toEqual([
      {
        ts: '2026-05-29T15:35:00.000Z',
        id: String(row.id),
        status: 'pendingSettle',
      },
    ]);
  });

  it('population unification: spec transition on actionable position emits even when many newer claimed rows exist', async () => {
    // Scenario from review-32 round 2 blocker 3: a wallet has many recent
    // claimed positions whose row_updated_at dominates the table, plus a
    // few older actionable positions. The previous top-200-by-row_updated_at
    // window could miss the older actives; the new `claimed=false AND
    // risk>0` filter guarantees they're always queried. A spec transition
    // on the OLD active position then surfaces.
    const oldActive = {
      speculation_id: 101,
      user_address: ADDRESS,
      position_type: 'upper',
      risk_amount: '1000000',
      profit_amount: '500000',
      claimed: false,
      // Older than every recent claimed row.
      row_updated_at: '2026-04-01T10:00:00.000Z',
      id: 7,
    };
    const specBefore = speculationRow({
      speculation_id: 101,
      speculation_status: 'open',
      win_side: 'tbd',
      row_updated_at: '2026-04-01T10:00:00.000Z',
    });
    const contestBefore = contestRow({
      contest_id: 42,
      contest_status: 'unverified',
      away_score: null,
      home_score: null,
      row_updated_at: '2026-04-01T10:00:00.000Z',
    });
    let specs: Row[] = [specBefore];
    let contests: Row[] = [contestBefore];
    // The actionable query (claimed=false, risk>0) ONLY returns the old
    // active row regardless of how many recent claimed rows the wallet
    // has — the mock's data returned for the `positions` table reflects
    // the filtered population.
    const hub = new OwnStateHub({
      getClient: () =>
        makeClient({
          positions: [oldActive],
          speculations: specs,
          contests: contests,
        }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    hub.seedStatusCache(ADDRESS, [
      {
        key: '101_0',
        status: 'active',
        sourceUpdatedAt: oldActive.row_updated_at,
      },
    ]);
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toEqual([]);
    // Spec settles (claimable for the upper-position winner).
    const specAfter = speculationRow({
      speculation_id: 101,
      speculation_status: 'closed',
      win_side: 'away',
      row_updated_at: '2026-05-29T15:30:00.000Z',
    });
    specs.length = 0;
    specs.push(specAfter);
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toEqual([
      {
        ts: '2026-05-29T15:30:00.000Z',
        id: '7',
        status: 'claimable',
      },
    ]);
  });

  it('re-emits on a same-status payload change (score correction flips pendingSettle from won to push)', async () => {
    // Hermes review-32 round 4 blocker 3: the prior dedup compared
    // only `status`. A contest score correction that keeps the
    // position at `pendingSettle` but flips its predicted result/payout
    // would have been suppressed, leaving the SDK with a stale payload.
    // The fix compares (status, sourceUpdatedAt, result, claimableAmount).
    const row = positionRow({ row_updated_at: '2026-05-29T15:00:00.000Z' });
    const spec = speculationRow({
      speculation_status: 'open',
      win_side: 'tbd',
      row_updated_at: '2026-05-29T15:00:00.000Z',
    });
    // Initial contest: away 10, home 5 → upper position predicted to win.
    let contests: Row[] = [
      contestRow({
        contest_status: 'scored',
        away_score: 10,
        home_score: 5,
        row_updated_at: '2026-05-29T15:30:00.000Z',
      }),
    ];

    const hub = new OwnStateHub({
      getClient: () =>
        makeClient({
          positions: [row],
          speculations: [spec],
          contests: contests,
        }),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const cb = makeCallbacks();
    hub.subscribe(ADDRESS, cb);
    // Seed with current state (pendingSettle, result='won',
    // claimableAmount = 1M + 500k = 1.5M).
    hub.seedStatusCache(ADDRESS, [
      {
        key: '101_0',
        status: 'pendingSettle',
        sourceUpdatedAt: '2026-05-29T15:30:00.000Z',
        result: 'won',
        claimableAmount: '1500000',
      },
    ]);
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toEqual([]);
    // Score correction: away 7, home 7 → predicted push (status still
    // pendingSettle, but result='push' and claimableAmount=1M (risk only).
    contests.length = 0;
    contests.push(
      contestRow({
        contest_status: 'scored',
        away_score: 7,
        home_score: 7,
        row_updated_at: '2026-05-29T15:40:00.000Z',
      }),
    );
    await hub.pollWallet(ADDRESS);
    expect(cb.positionStatuses).toHaveLength(1);
    expect(cb.positionStatuses[0]!.status).toBe('pendingSettle');
    expect(cb.positionStatuses[0]!.ts).toBe('2026-05-29T15:40:00.000Z');
  });

  it('beginLive starts the per-wallet timer (idempotent on second call)', async () => {
    const hub = new OwnStateHub({
      getClient: () => makeClient({}),
      getNetwork: () => 'polygon',
      pollMs: 1e9,
      resyncMs: 1e9,
    });
    const sub = hub.subscribe(ADDRESS, makeCallbacks());
    expect(hub.stats().wallets).toBe(1);
    // No-op if called twice; the second call doesn't double-start.
    hub.beginLive(sub);
    hub.beginLive(sub);
    hub.unsubscribe(sub);
    expect(hub.stats().wallets).toBe(0);
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
