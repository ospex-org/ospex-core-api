/**
 * Snapshot handler tests (M4a). Drives `ownStateSnapshotHandler` with mocked
 * supabase + env + categorized-position-fetcher so the test exercises:
 *   - active-set filtering (status / nonce / expiry; `book_visible`
 *     intentionally NOT filtered — hidden-but-still-matchable rows belong);
 *   - cursor handling (`live` → terminals-since-cursor; `page` → next page
 *     of active set);
 *   - truncation + page cursor emission;
 *   - composite cursor watermark assembly (commitments / fills / positions);
 *   - the owner-auth scope (`req.streamAuth.address` is the only address
 *     queried — there is no `?address` param on the route);
 *   - cursor decode errors → 400.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const NOW = Date.parse('2026-05-29T16:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const ADDRESS = '0x1111111111111111111111111111111111111111';

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

const { ownStateSnapshotHandler } = await import('../src/v1/ownState/snapshot.js');
const {
  OWN_STATE_CURSOR_VERSION,
  decodeOwnStateCursor,
  encodeOwnStateCursor,
} = await import('../src/v1/ownState/cursor.js');

// ── test doubles ────────────────────────────────────────────────────────

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
}
function makeRes(): FakeRes {
  const res: FakeRes = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

function makeReq(opts: { query?: Record<string, string>; address?: string } = {}): Request {
  const req = {
    query: opts.query ?? {},
    params: {},
    headers: {},
    streamAuth: { address: opts.address ?? ADDRESS, expiresAt: Math.floor(NOW / 1000) + 900 },
  } as unknown as Request;
  return req;
}

interface MockResponse {
  data: unknown;
  error: unknown;
}
interface RecordedCall {
  table?: string;
  method: string;
  args: unknown[];
}

/**
 * Sequenced-response mock. The handler issues queries in a deterministic
 * order; each terminal `.then` / `.maybeSingle` consumes the next response.
 * `from(table)` re-uses the same builder so the `calls` log captures which
 * table was selected for which sequence step.
 */
function makeSupabase(responses: MockResponse[]): { client: unknown; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let idx = 0;
  let currentTable: string | undefined;
  const next = (): MockResponse => responses[Math.min(idx++, responses.length - 1)]!;
  const builder: Record<string, unknown> = {};
  const chain =
    (method: string) =>
    (...args: unknown[]): unknown => {
      calls.push({ table: currentTable, method, args });
      return builder;
    };
  for (const m of [
    'select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'range', 'limit',
  ]) {
    builder[m] = chain(m);
  }
  builder['maybeSingle'] = (): Promise<MockResponse> => {
    calls.push({ table: currentTable, method: 'maybeSingle', args: [] });
    return Promise.resolve(next());
  };
  builder['then'] = (resolve: (v: unknown) => void): void => resolve(next());
  return {
    client: {
      from: (t: string): unknown => {
        currentTable = t;
        return builder;
      },
    },
    calls,
  };
}

function commitmentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commitment_hash: `0x${'a'.repeat(64)}`,
    maker: ADDRESS,
    contest_id: 42,
    scorer: '0x2222222222222222222222222222222222222222',
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

const sentinelWatermarkRow = { row_updated_at: '2026-05-29T15:30:00.000Z', id: 42 };
const fillsWatermarkRow = { row_updated_at: '2026-05-29T15:31:00.000Z', id: 7 };
const positionsWatermarkRow = { row_updated_at: '2026-05-29T15:32:00.000Z', id: 99 };

const noPositions = { active: [], pendingSettle: [], claimable: [] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  positionFetchMock.fetchCategorizedPositions.mockResolvedValue(noPositions);
  // Reset the env mock implementation — vi.clearAllMocks() only clears call
  // history, so a test that overrides maxCommitments would otherwise leak
  // the override into every subsequent test.
  envMock.loadConfig.mockReturnValue({
    network: 'polygon',
    chainId: 137,
    redactHiddenPublic: true,
    ownStateSnapshotMaxCommitments: 5000,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// No cursor — cold start
// ─────────────────────────────────────────────────────────────────────────

describe('GET /v1/own-state/snapshot — cold start (no cursor)', () => {
  it('returns active commitments + empty positions + live cursor (untruncated, < MAX rows)', async () => {
    const { client } = makeSupabase([
      { data: [commitmentRow()], error: null },         // active commitments
      { data: sentinelWatermarkRow, error: null },      // max watermark commitments
      { data: fillsWatermarkRow, error: null },         // max watermark fills
      { data: positionsWatermarkRow, error: null },     // max watermark positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(makeReq(), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    const body = res.body as { cursor: string; commitments: unknown[]; positions: unknown[]; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.commitments).toHaveLength(1);
    expect(body.positions).toHaveLength(0);
    const decoded = decodeOwnStateCursor(body.cursor);
    expect(decoded.k).toBe('live');
    expect(decoded.t).toBe('own-state');
    expect(decoded.v).toBe(OWN_STATE_CURSOR_VERSION);
    expect(decoded.c).toEqual({ s: sentinelWatermarkRow.row_updated_at, i: '42' });
    expect(decoded.f).toEqual({ s: fillsWatermarkRow.row_updated_at, i: '7' });
    expect(decoded.p).toEqual({ s: positionsWatermarkRow.row_updated_at, i: '99' });
  });

  it('queries commitments scoped to the authenticated address (the only address)', async () => {
    const { client, calls } = makeSupabase([
      { data: [], error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    // A "wrong-address scope" attempt — the URL has no address param to pass,
    // and we don't echo any query-derived address; only the token's address.
    await ownStateSnapshotHandler(
      makeReq({ query: { address: '0x9999999999999999999999999999999999999999' } }),
      makeRes() as unknown as Response,
    );

    const makerEqs = calls.filter((c) => c.method === 'eq' && c.args[0] === 'maker');
    expect(makerEqs.length).toBeGreaterThan(0);
    for (const c of makerEqs) expect(c.args[1]).toBe(ADDRESS);
  });

  it('active commitments query filters status + nonce + expiry but NOT book_visible (hidden-but-still-matchable belongs to active set)', async () => {
    const { client, calls } = makeSupabase([
      { data: [], error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    await ownStateSnapshotHandler(makeReq(), makeRes() as unknown as Response);

    const activeQueryCalls = calls.filter((c) => c.table === 'commitments');
    expect(activeQueryCalls).toContainEqual({
      table: 'commitments',
      method: 'in',
      args: ['status', ['open', 'partially_filled']],
    });
    expect(activeQueryCalls).toContainEqual({
      table: 'commitments',
      method: 'eq',
      args: ['nonce_invalidated', false],
    });
    expect(activeQueryCalls).toContainEqual({
      table: 'commitments',
      method: 'gt',
      args: ['expiry', NOW_ISO],
    });
    expect(activeQueryCalls.some((c) => c.method === 'eq' && c.args[0] === 'book_visible')).toBe(false);
  });

  it('returns truncated=true + page-active cursor at the last returned row when result fills the cap (cold start)', async () => {
    envMock.loadConfig.mockReturnValue({
      network: 'polygon',
      chainId: 137,
      redactHiddenPublic: true,
      ownStateSnapshotMaxCommitments: 2,
    });
    const rows = [
      commitmentRow({ id: 11, row_updated_at: '2026-05-29T14:00:00.000Z', commitment_hash: `0x${'1'.repeat(64)}` }),
      commitmentRow({ id: 12, row_updated_at: '2026-05-29T14:00:01.000Z', commitment_hash: `0x${'2'.repeat(64)}` }),
    ];
    const { client } = makeSupabase([
      { data: rows, error: null },                       // active
      { data: fillsWatermarkRow, error: null },          // max fills (cold start — no input cursor)
      { data: positionsWatermarkRow, error: null },      // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(makeReq(), res as unknown as Response);
    const body = res.body as { cursor: string; truncated: boolean; commitments: unknown[] };
    expect(body.truncated).toBe(true);
    expect(body.commitments).toHaveLength(2);
    const decoded = decodeOwnStateCursor(body.cursor);
    // Cold-start truncation → page-active (subsequent pages don't run terminal query).
    expect(decoded.k).toBe('page-active');
    expect(decoded.c).toEqual({ s: '2026-05-29T14:00:01.000Z', i: '12' });
  });

  it('returns sentinel watermarks for an empty wallet', async () => {
    const { client } = makeSupabase([
      { data: [], error: null },                          // empty active
      { data: null, error: null },                        // null commitments max
      { data: null, error: null },                        // null fills max
      { data: null, error: null },                        // null positions max
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(makeReq(), res as unknown as Response);
    const body = res.body as { cursor: string; truncated: boolean; commitments: unknown[]; positions: unknown[] };
    expect(body.truncated).toBe(false);
    expect(body.commitments).toHaveLength(0);
    expect(body.positions).toHaveLength(0);
    const decoded = decodeOwnStateCursor(body.cursor);
    // SENTINEL_WATERMARK
    expect(decoded.c).toEqual({ s: '1970-01-01T00:00:00.000Z', i: '0' });
    expect(decoded.f).toEqual({ s: '1970-01-01T00:00:00.000Z', i: '0' });
    expect(decoded.p).toEqual({ s: '1970-01-01T00:00:00.000Z', i: '0' });
    expect(decoded.k).toBe('live');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cursor with k='live' — state-loss recovery
// ─────────────────────────────────────────────────────────────────────────

describe('GET /v1/own-state/snapshot — cursor k=live (recovery)', () => {
  function liveCursor(): string {
    return encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      f: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      p: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      k: 'live',
    });
  }

  it('issues a second query for terminals-since-cursor and merges results', async () => {
    const activeRow = commitmentRow({
      id: 1,
      row_updated_at: '2026-05-29T15:00:00.000Z',
      status: 'open',
    });
    const terminalRow = commitmentRow({
      id: 2,
      row_updated_at: '2026-05-29T11:00:00.000Z',
      status: 'filled',
      commitment_hash: `0x${'c'.repeat(64)}`,
    });
    const { client, calls } = makeSupabase([
      { data: [activeRow], error: null },             // active query
      { data: [terminalRow], error: null },           // terminal-since-cursor
      { data: [], error: null },                      // claimed-since-cursor positions
      { data: sentinelWatermarkRow, error: null },    // max commitments
      { data: fillsWatermarkRow, error: null },       // max fills
      { data: positionsWatermarkRow, error: null },   // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(
      makeReq({ query: { cursor: liveCursor() } }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { commitments: Array<{ commitmentHash: string }>; truncated: boolean };
    expect(body.commitments).toHaveLength(2);
    // Sorted by (row_updated_at, id) ASC → terminal (earlier ts) first.
    expect(body.commitments[0]?.commitmentHash).toBe(terminalRow.commitment_hash);
    expect(body.commitments[1]?.commitmentHash).toBe(activeRow.commitment_hash);
    expect(body.truncated).toBe(false);

    const orCalls = calls.filter((c) => c.method === 'or' && c.table === 'commitments');
    expect(orCalls.length).toBe(2); // terminal-predicate OR + cursor-watermark OR
  });

  it('also queries claimed-since-cursor on positions', async () => {
    const { client, calls } = makeSupabase([
      { data: [], error: null },                          // active commitments
      { data: [], error: null },                          // terminal commitments
      { data: [], error: null },                          // claimed positions
      { data: null, error: null },                        // max commitments
      { data: null, error: null },                        // max fills
      { data: null, error: null },                        // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    await ownStateSnapshotHandler(
      makeReq({ query: { cursor: liveCursor() } }),
      makeRes() as unknown as Response,
    );

    const positionsCalls = calls.filter((c) => c.table === 'positions');
    expect(positionsCalls).toContainEqual({
      table: 'positions',
      method: 'eq',
      args: ['claimed', true],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cursor with k='page' — paging through cold-start truncation
// ─────────────────────────────────────────────────────────────────────────

describe('GET /v1/own-state/snapshot — cursor k=page-active (cold-start paging)', () => {
  function pageActiveCursor(): string {
    return encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T11:00:00.000Z', i: '12' },
      f: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      p: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      k: 'page-active',
    });
  }

  it('advances the active-set query past the page cursor — no terminal query', async () => {
    const { client, calls } = makeSupabase([
      { data: [], error: null },                          // active (past page cursor)
      { data: null, error: null },                        // max commitments (not truncated)
      { data: null, error: null },                        // max positions (not positions_truncated)
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    await ownStateSnapshotHandler(
      makeReq({ query: { cursor: pageActiveCursor() } }),
      makeRes() as unknown as Response,
    );

    const commitmentsCalls = calls.filter((c) => c.table === 'commitments');
    const orCalls = commitmentsCalls.filter((c) => c.method === 'or');
    // ONE .or() for the active-set page (cursor watermark); no terminal .or().
    expect(orCalls).toHaveLength(1);
    expect(String(orCalls[0]?.args[0])).toContain('2026-05-29T11:00:00.000Z');
  });

  it('preserves f watermark from input cursor — never advances past undelivered fills (Hermes blocker #3)', async () => {
    const inputF = { s: '2026-05-29T10:00:00.000Z', i: '0' };
    const { client, calls } = makeSupabase([
      { data: [], error: null },                          // active
      { data: null, error: null },                        // max commitments
      { data: null, error: null },                        // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(
      makeReq({ query: { cursor: pageActiveCursor() } }),
      res as unknown as Response,
    );
    const body = res.body as { cursor: string };
    const decoded = decodeOwnStateCursor(body.cursor);
    expect(decoded.f).toEqual(inputF);
    // Critically: NO position_fills MAX query was issued on a cursor input.
    expect(calls.some((c) => c.table === 'position_fills')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Error paths
// ─────────────────────────────────────────────────────────────────────────

describe('GET /v1/own-state/snapshot — error paths', () => {
  it('400 INVALID_CURSOR on malformed ?cursor=', async () => {
    supabaseMock.getSupabase.mockReturnValue({ from: vi.fn() });
    const res = makeRes();
    await ownStateSnapshotHandler(
      makeReq({ query: { cursor: '!!!malformed!!!' } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('400 INVALID_PARAM on empty ?cursor=', async () => {
    supabaseMock.getSupabase.mockReturnValue({ from: vi.fn() });
    const res = makeRes();
    await ownStateSnapshotHandler(
      makeReq({ query: { cursor: '' } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('500 INTERNAL_ERROR when the active commitments query fails', async () => {
    const { client } = makeSupabase([{ data: null, error: { message: 'boom' } }]);
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await ownStateSnapshotHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('500 INTERNAL_ERROR when fetchCategorizedPositions throws', async () => {
    const { client } = makeSupabase([
      { data: [], error: null },                          // active
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);
    positionFetchMock.fetchCategorizedPositions.mockRejectedValueOnce(new Error('positions down'));
    const res = makeRes();
    await ownStateSnapshotHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Position categorization flow
// ─────────────────────────────────────────────────────────────────────────

describe('GET /v1/own-state/snapshot — position categorization', () => {
  it('flattens active/pendingSettle/claimable into a discriminated union by status', async () => {
    positionFetchMock.fetchCategorizedPositions.mockResolvedValue({
      active: [{ positionId: 'A_x_0', speculationId: 'A', positionType: 0, team: 't', opponent: 'o', market: 'moneyline', oddsDecimal: 2, riskAmountUSDC: 1, profitAmountUSDC: 1 }],
      pendingSettle: [{ positionId: 'B_x_1', speculationId: 'B', positionType: 1, team: 't', opponent: 'o', market: 'spread', oddsDecimal: null, riskAmountUSDC: 2, profitAmountUSDC: 0.5, result: 'won', predictedWinSide: 'home', estimatedPayoutUSDC: 2.5, estimatedPayoutWei6: '2500000' }],
      claimable: [{ positionId: 'C_x_0', speculationId: 'C', positionType: 0, team: 't', opponent: 'o', market: 'total', oddsDecimal: 3, riskAmountUSDC: 5, profitAmountUSDC: 10, result: 'won', estimatedPayoutUSDC: 15, estimatedPayoutWei6: '15000000' }],
    });
    const { client } = makeSupabase([
      { data: [], error: null },                          // active commitments
      { data: null, error: null },                        // max commitments
      { data: null, error: null },                        // max fills
      { data: null, error: null },                        // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(makeReq(), res as unknown as Response);

    const body = res.body as { positions: Array<{ status: string }>; positionsTruncated: boolean };
    expect(body.positions).toHaveLength(3);
    expect(body.positions.map((p) => p.status)).toEqual(['active', 'pendingSettle', 'claimable']);
    expect(body.positionsTruncated).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Hermes review-31 round 1 — blocker regressions
// ─────────────────────────────────────────────────────────────────────────

describe('GET /v1/own-state/snapshot — Hermes review-31 round 1 regressions', () => {
  // Blocker 1: terminal-recovery keyset on k='live' input applies the
  // 30s overlap floor — a late-committed row whose `row_updated_at` predates
  // the cursor by < 30s is included rather than skipped forever.
  it('k=live input → terminal-recovery keyset is FLOORED by 30s overlap (blocker #1)', async () => {
    const cursor = encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T10:00:00.000Z', i: '500' },
      f: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      p: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      k: 'live',
    });
    const { client, calls } = makeSupabase([
      { data: [], error: null },                          // active
      { data: [], error: null },                          // terminal
      { data: [], error: null },                          // claimed
      { data: null, error: null },                        // max commitments
      { data: null, error: null },                        // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    await ownStateSnapshotHandler(
      makeReq({ query: { cursor } }),
      makeRes() as unknown as Response,
    );

    // The terminal query's .or() calls = [terminal-predicate, keyset].
    const commitmentsOrCalls = calls.filter((c) => c.method === 'or' && c.table === 'commitments');
    expect(commitmentsOrCalls).toHaveLength(2);
    // Second .or() is the keyset — must contain the FLOORED timestamp,
    // NOT the cursor's raw 10:00:00.
    const keysetArg = String(commitmentsOrCalls[1]?.args[0]);
    expect(keysetArg).toContain('2026-05-29T09:59:30.000Z'); // 10:00:00 - 30s
    expect(keysetArg).not.toContain('2026-05-29T10:00:00.000Z');
  });

  // Same on the claimed-positions keyset.
  it('k=live input → claimed-position keyset is FLOORED by 30s overlap', async () => {
    const cursor = encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      f: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      p: { s: '2026-05-29T10:00:00.000Z', i: '500' },
      k: 'live',
    });
    const { client, calls } = makeSupabase([
      { data: [], error: null },                          // active
      { data: [], error: null },                          // terminal
      { data: [], error: null },                          // claimed
      { data: null, error: null },                        // max commitments
      { data: null, error: null },                        // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    await ownStateSnapshotHandler(
      makeReq({ query: { cursor } }),
      makeRes() as unknown as Response,
    );

    const positionsOrCalls = calls.filter((c) => c.method === 'or' && c.table === 'positions');
    // Single .or() on positions (claimed keyset).
    expect(positionsOrCalls).toHaveLength(1);
    expect(String(positionsOrCalls[0]?.args[0])).toContain('2026-05-29T09:59:30.000Z');
  });

  // Blocker 2: paging across truncation MUST keep terminals coming. After
  // a recovery-mode truncation, the next page (k='page-recovery') runs the
  // terminal query AGAIN, this time with STRICT keyset advance.
  it('k=page-recovery input → terminal query still runs, with STRICT keyset (blocker #2)', async () => {
    const cursor = encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T11:30:00.000Z', i: '300' },
      f: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      p: { s: '2026-05-29T11:30:00.000Z', i: '0' },
      k: 'page-recovery',
    });
    const { client, calls } = makeSupabase([
      { data: [], error: null },                          // active
      { data: [], error: null },                          // terminal (still runs!)
      { data: [], error: null },                          // claimed (still runs!)
      { data: null, error: null },                        // max commitments
      { data: null, error: null },                        // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    await ownStateSnapshotHandler(
      makeReq({ query: { cursor } }),
      makeRes() as unknown as Response,
    );

    // Active and terminal both ran — 2 .or() pairs on commitments, NOT just 1.
    const commitmentsOrCalls = calls.filter((c) => c.method === 'or' && c.table === 'commitments');
    // active .or() (keyset, strict) + terminal .or() pair (predicate + keyset, strict).
    expect(commitmentsOrCalls).toHaveLength(3);
    // Keyset arg must be STRICT (uses cursor.c.s exactly, NOT floored).
    const keysetArgs = commitmentsOrCalls.map((c) => String(c.args[0]));
    // At least one keyset arg references the cursor's raw timestamp.
    expect(keysetArgs.some((a) => a.includes('2026-05-29T11:30:00.000Z'))).toBe(true);
    // And none reference the FLOORED timestamp (no overlap on page-recovery).
    expect(keysetArgs.some((a) => a.includes('2026-05-29T11:29:30.000Z'))).toBe(false);
  });

  // Blocker 2 (cont.): truncation during recovery emits k='page-recovery'
  // (not 'page-active'), so paging stays in recovery mode.
  it('truncation while recovering → output cursor.k = page-recovery, NOT page-active', async () => {
    envMock.loadConfig.mockReturnValue({
      network: 'polygon',
      chainId: 137,
      redactHiddenPublic: true,
      ownStateSnapshotMaxCommitments: 2,
    });
    const cursor = encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      f: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      p: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      k: 'live',
    });
    const activeRow1 = commitmentRow({
      id: 11,
      row_updated_at: '2026-05-29T14:00:00.000Z',
      commitment_hash: `0x${'1'.repeat(64)}`,
    });
    const activeRow2 = commitmentRow({
      id: 12,
      row_updated_at: '2026-05-29T14:00:01.000Z',
      commitment_hash: `0x${'2'.repeat(64)}`,
    });
    const { client } = makeSupabase([
      { data: [activeRow1, activeRow2], error: null },    // active (hits cap=2)
      { data: [], error: null },                          // claimed (no terminal query since cap reached)
      { data: null, error: null },                        // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(
      makeReq({ query: { cursor } }),
      res as unknown as Response,
    );
    const body = res.body as { cursor: string; truncated: boolean };
    expect(body.truncated).toBe(true);
    const decoded = decodeOwnStateCursor(body.cursor);
    expect(decoded.k).toBe('page-recovery');
  });

  // Blocker 3: f watermark NEVER advances past undelivered fills. Snapshot
  // doesn't carry fills[], so the watermark either preserves (input cursor)
  // or starts at MAX-in-DB (cold start), but it cannot move past the SDK's
  // last-seen point on a recovery call.
  it('input cursor.f is PRESERVED on the response cursor (blocker #3)', async () => {
    const inputF = { s: '2026-05-29T10:00:00.000Z', i: '99' };
    const cursor = encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      f: inputF,
      p: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      k: 'live',
    });
    const { client, calls } = makeSupabase([
      { data: [], error: null },                          // active
      { data: [], error: null },                          // terminal
      { data: [], error: null },                          // claimed
      { data: null, error: null },                        // max commitments
      { data: null, error: null },                        // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(
      makeReq({ query: { cursor } }),
      res as unknown as Response,
    );
    const body = res.body as { cursor: string };
    const decoded = decodeOwnStateCursor(body.cursor);
    expect(decoded.f).toEqual(inputF);
    // The handler must NOT query position_fills when f is preserved.
    expect(calls.some((c) => c.table === 'position_fills')).toBe(false);
  });

  // Blocker 4: positions truncation surfaces via `positionsTruncated` flag,
  // and the p watermark is preserved (or sentinel on cold start) so the
  // M4b stream catches every position transition the snapshot couldn't.
  it('positions categorized count at the 200 cap → positionsTruncated=true + p preserved', async () => {
    // Build a 200-position categorized set (cap proxy).
    const buildActive = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        positionId: `A_x_${i}`,
        speculationId: `${i}`,
        positionType: 0 as const,
        team: 't',
        opponent: 'o',
        market: 'moneyline' as const,
        oddsDecimal: 2,
        riskAmountUSDC: 1,
        profitAmountUSDC: 1,
      }));
    positionFetchMock.fetchCategorizedPositions.mockResolvedValue({
      active: buildActive(200),
      pendingSettle: [],
      claimable: [],
    });
    const inputP = { s: '2026-05-29T10:00:00.000Z', i: '0' };
    const cursor = encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      f: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      p: inputP,
      k: 'live',
    });
    const { client } = makeSupabase([
      { data: [], error: null },                          // active commitments
      { data: [], error: null },                          // terminal
      { data: [], error: null },                          // claimed
      { data: null, error: null },                        // max commitments
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(
      makeReq({ query: { cursor } }),
      res as unknown as Response,
    );
    const body = res.body as { cursor: string; truncated: boolean; positionsTruncated: boolean };
    expect(body.positionsTruncated).toBe(true);
    expect(body.truncated).toBe(true); // truncated = commitments_truncated OR positions_truncated
    const decoded = decodeOwnStateCursor(body.cursor);
    // p preserved at input value — stream replays every position transition since.
    expect(decoded.p).toEqual(inputP);
  });

  it('cold start with positions at cap → positionsTruncated=true + p watermark = sentinel', async () => {
    const buildActive = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        positionId: `A_x_${i}`,
        speculationId: `${i}`,
        positionType: 0 as const,
        team: 't',
        opponent: 'o',
        market: 'moneyline' as const,
        oddsDecimal: 2,
        riskAmountUSDC: 1,
        profitAmountUSDC: 1,
      }));
    positionFetchMock.fetchCategorizedPositions.mockResolvedValue({
      active: buildActive(200),
      pendingSettle: [],
      claimable: [],
    });
    const { client } = makeSupabase([
      { data: [], error: null },                          // active
      { data: null, error: null },                        // max commitments
      { data: null, error: null },                        // max fills (cold start)
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(makeReq(), res as unknown as Response);
    const body = res.body as { cursor: string; positionsTruncated: boolean };
    expect(body.positionsTruncated).toBe(true);
    const decoded = decodeOwnStateCursor(body.cursor);
    expect(decoded.p).toEqual({ s: '1970-01-01T00:00:00.000Z', i: '0' }); // sentinel
  });
});
