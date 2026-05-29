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

const noPositions = {
  active: [],
  pendingSettle: [],
  claimable: [],
  hitCap: false,
  derivedStatuses: [],
};

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
    // No actionable positions (`derivedStatuses=[]`) → p falls back to
    // SENTINEL. Snapshot no longer mints p from `positions.row_updated_at`;
    // it mints from `max(sourceUpdatedAt)` across derived statuses, which
    // is empty here.
    expect(decoded.p).toEqual({ s: '1970-01-01T00:00:00.000Z', i: '0' });
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
    // Two-phase wire ordering puts active first (in (row, id) ASC from the
    // phase-1 query) then terminals (in (row, id) ASC from the phase-2
    // query). No merge interleaving.
    expect(body.commitments[0]?.commitmentHash).toBe(activeRow.commitment_hash);
    expect(body.commitments[1]?.commitmentHash).toBe(terminalRow.commitment_hash);
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

  it('preserves f watermark from input cursor — never advances past undelivered fills', async () => {
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
      hitCap: false,
      derivedStatuses: [],
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
// Cursor overlap-floor + recovery-paging regressions
// ─────────────────────────────────────────────────────────────────────────

describe('GET /v1/own-state/snapshot — overlap floor + paging regressions', () => {
  // Terminal-recovery keyset on k='live' input applies the 30s overlap
  // floor — a late-committed row whose `row_updated_at` predates the
  // cursor by < 30s is included rather than skipped forever.
  it('k=live input → terminal-recovery keyset is FLOORED by 30s overlap', async () => {
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

  // Paging across truncation MUST keep terminals coming. With the
  // two-phase model: k='page-recovery-terminal' input continues phase 2
  // (terminal query with STRICT keyset advance) AND skips phase 1 entirely.
  it('k=page-recovery-terminal input → phase-2 query runs with STRICT keyset, phase-1 skipped', async () => {
    const cursor = encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T11:30:00.000Z', i: '300' },
      cAnchor: { s: '2026-05-29T09:59:30.000Z', i: '0' },
      f: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      p: { s: '2026-05-29T11:30:00.000Z', i: '0' },
      k: 'page-recovery-terminal',
    });
    const { client, calls } = makeSupabase([
      { data: [], error: null },                          // terminal query (phase 2 only)
      { data: [], error: null },                          // claimed
      { data: null, error: null },                        // max commitments
      { data: null, error: null },                        // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    await ownStateSnapshotHandler(
      makeReq({ query: { cursor } }),
      makeRes() as unknown as Response,
    );

    const commitmentsOrCalls = calls.filter((c) => c.method === 'or' && c.table === 'commitments');
    // Exactly ONE phase-2 query → 2 .or() calls (terminal-predicate + keyset).
    // The active query is SKIPPED entirely (phase-1 done on a prior page).
    expect(commitmentsOrCalls).toHaveLength(2);
    // Keyset arg must be STRICT against the cursor's raw c (NOT floored).
    const keysetArgs = commitmentsOrCalls.map((c) => String(c.args[0]));
    expect(keysetArgs.some((a) => a.includes('2026-05-29T11:30:00.000Z'))).toBe(true);
    expect(keysetArgs.some((a) => a.includes('2026-05-29T11:29:30.000Z'))).toBe(false);
  });

  // Active fills the page on recovery → output cursor.k =
  // 'page-recovery-active' (not 'page-active') AND cAnchor is preserved
  // so the next page can switch to phase-2 once active drains.
  it('active saturates recovery page → output cursor.k = page-recovery-active + cAnchor preserved', async () => {
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
      // phase-2 skipped because phase-1 saturated
      { data: [], error: null },                          // claimed
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
    expect(decoded.k).toBe('page-recovery-active');
    // cAnchor present, preserves the floored recovery start point.
    expect(decoded.cAnchor).toEqual({ s: '2026-05-29T09:59:30.000Z', i: '0' });
  });

  // Even when active fills the page, terminals are NOT permanently lost —
  // they wait for phase 1 to drain. On the NEXT page (k='page-recovery-active'
  // input), phase 1 query still runs (advancing past c) and, when phase 1
  // returns < MAX, phase 2 fires with the preserved cAnchor as its keyset
  // start.
  it('page-recovery-active continuation transitions to phase-2 when active drains', async () => {
    const cursor = encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T14:00:01.000Z', i: '12' },
      cAnchor: { s: '2026-05-29T09:59:30.000Z', i: '0' },
      f: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      p: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      k: 'page-recovery-active',
    });
    const { client, calls } = makeSupabase([
      { data: [], error: null },                          // active (drained)
      { data: [], error: null },                          // phase-2 terminal query
      { data: [], error: null },                          // claimed
      { data: null, error: null },                        // max commitments
      { data: null, error: null },                        // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    await ownStateSnapshotHandler(
      makeReq({ query: { cursor } }),
      makeRes() as unknown as Response,
    );

    // Phase-2 terminal query DID fire with cAnchor as keyset start.
    const commitmentsOrCalls = calls.filter((c) => c.method === 'or' && c.table === 'commitments');
    // active .or() (strict keyset) + phase-2 .or() pair (predicate + keyset).
    expect(commitmentsOrCalls).toHaveLength(3);
    const keysetArgs = commitmentsOrCalls.map((c) => String(c.args[0]));
    // Phase-2 keyset uses cAnchor (the floored recovery start).
    expect(keysetArgs.some((a) => a.includes('2026-05-29T09:59:30.000Z'))).toBe(true);
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
      hitCap: true, // raw-cap signal from helper — what `positionsTruncated` derives from
      derivedStatuses: [],
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
    // `truncated` is COMMITMENTS-ONLY, decoupled from `positionsTruncated`.
    // Commitments here are empty → false.
    expect(body.truncated).toBe(false);
    const decoded = decodeOwnStateCursor(body.cursor);
    // p preserved at input value — stream replays every position transition since.
    expect(decoded.p).toEqual(inputP);
  });

  // Wire-contract regression: a snapshot mint that the cursor decoder
  // then rejects breaks paging. A Z-only decoder regex rejected the
  // `+00:00`-form DB timestamps the snapshot was minting. This pins the
  // self-compat invariant: a cursor the handler mints MUST round-trip
  // through the handler.
  it('cursor minted from DB-format (+00:00, microseconds) row_updated_at survives a round-trip', async () => {
    const dbRow = commitmentRow({
      row_updated_at: '2026-05-29T15:00:00.123456+00:00',
      id: 42,
    });
    const { client } = makeSupabase([
      { data: [dbRow], error: null },                                                              // active
      { data: { row_updated_at: '2026-05-29T15:00:00.123456+00:00', id: 42 }, error: null },        // max c
      { data: { row_updated_at: '2026-05-29T15:00:00.000+00:00', id: 7 }, error: null },           // max f
      { data: { row_updated_at: '2026-05-29T15:00:00.000+00:00', id: 99 }, error: null },          // max p
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res1 = makeRes();
    await ownStateSnapshotHandler(makeReq(), res1 as unknown as Response);
    expect(res1.statusCode).toBe(200);
    const body1 = res1.body as { cursor: string };

    // Re-present the cursor to the handler — server MUST not reject its own mint.
    const { client: client2 } = makeSupabase([
      { data: [], error: null },                                                                    // active
      { data: null, error: null },                                                                  // max c
      { data: null, error: null },                                                                  // max p
    ]);
    supabaseMock.getSupabase.mockReturnValue(client2);

    const res2 = makeRes();
    await ownStateSnapshotHandler(
      makeReq({ query: { cursor: body1.cursor } }),
      res2 as unknown as Response,
    );
    expect(res2.statusCode).toBe(200); // not 400 INVALID_CURSOR
    // Microsecond precision preserved on the response — never normalized through Date.toISOString.
    const decoded = decodeOwnStateCursor(body1.cursor);
    expect(decoded.c.s).toBe('2026-05-29T15:00:00.123456+00:00');
  });

  // Passive expiry contract. The indexer doesn't advance `row_updated_at`
  // for time alone, so a commitment whose only terminal transition is
  // `expiry <= now` appears in NEITHER half of recovery (active query
  // excludes by `expiry > now`; terminal query's keyset excludes by
  // `row_updated_at < anchor`). Documented contract: the snapshot's
  // active set is authoritative of currently-matchable rows — the SDK
  // reducer prunes locally-expired commitments using its own clock (same
  // `deriveEffectiveStatus` pattern used everywhere else in the codebase,
  // and matches the existing `/v1/commitments?since=` semantics — see
  // snapshot.ts handler docstring).
  it('passive expiry contract — open row that expired since the cursor with unchanged row_updated_at is NOT emitted (SDK time-prunes locally)', async () => {
    vi.setSystemTime(new Date('2026-05-29T10:06:00.000Z'));

    const cursor = encodeOwnStateCursor({
      t: 'own-state',
      v: OWN_STATE_CURSOR_VERSION,
      c: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      f: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      p: { s: '2026-05-29T10:00:00.000Z', i: '0' },
      k: 'live',
    });

    // The expiring row exists in the DB. The handler's active query
    // EXCLUDES it via `.gt('expiry', nowISO)` — the mock returns []
    // because the test asserts the documented contract, not the raw query
    // behavior. Similarly the terminal query's keyset (row_updated_at >
    // floor(09:59:30) excludes a row updated at 09:00:00, so it also
    // returns []. Both empty → the response carries no commitment for
    // this row.
    const { client } = makeSupabase([
      { data: [], error: null },                                    // active (excludes by `expiry > now`)
      { data: [], error: null },                                    // terminal (excludes by keyset row_updated_at)
      { data: [], error: null },                                    // claimed
      { data: null, error: null },                                  // max commitments
      { data: null, error: null },                                  // max positions
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);

    const res = makeRes();
    await ownStateSnapshotHandler(
      makeReq({ query: { cursor } }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { commitments: unknown[]; truncated: boolean };
    expect(body.commitments).toHaveLength(0);
    expect(body.truncated).toBe(false);

    // Per the documented contract: the SDK reducer is responsible for
    // computing effective status locally on each tick / on reconnect and
    // marking any locally-held commitment with stored `expiry <= now` as
    // terminal. The server emitting it would require a third recovery
    // phase keyed by `expiry` rather than `row_updated_at` — out of scope
    // for M4a and not required by the spec (which says "recently terminal
    // since prior cursor", scoping to rows the indexer WROTE).
  });

  // Higher-level black-box pagination test: feed rows + DB-format
  // timestamps through mocked pages, repeatedly call the handler until
  // `truncated:false`, assert no skipped rows and every emitted cursor
  // decodes.
  it('full pagination loop with DB-format timestamps: all rows delivered, no duplicates, every cursor decodes', async () => {
    envMock.loadConfig.mockReturnValue({
      network: 'polygon',
      chainId: 137,
      redactHiddenPublic: true,
      ownStateSnapshotMaxCommitments: 2,
    });
    // Page 1: 2 active rows (saturates the cap=2).
    const page1Rows = [
      commitmentRow({
        id: 1,
        row_updated_at: '2026-05-29T10:00:00.111111+00:00',
        commitment_hash: `0x${'1'.repeat(64)}`,
      }),
      commitmentRow({
        id: 2,
        row_updated_at: '2026-05-29T11:00:00.222222+00:00',
        commitment_hash: `0x${'2'.repeat(64)}`,
      }),
    ];
    const { client: client1 } = makeSupabase([
      { data: page1Rows, error: null },                                                             // active
      // no max-c query (commitments truncated)
      { data: { row_updated_at: '2026-05-29T15:00:00.123456+00:00', id: 7 }, error: null },          // max f
      { data: { row_updated_at: '2026-05-29T15:00:00.000+00:00', id: 99 }, error: null },           // max p
    ]);
    supabaseMock.getSupabase.mockReturnValue(client1);
    const res1 = makeRes();
    await ownStateSnapshotHandler(makeReq(), res1 as unknown as Response);
    const body1 = res1.body as { cursor: string; truncated: boolean; commitments: Array<{ commitmentHash: string }> };
    expect(body1.truncated).toBe(true);
    expect(body1.commitments).toHaveLength(2);
    // Cursor decodes — wire contract.
    expect(() => decodeOwnStateCursor(body1.cursor)).not.toThrow();

    // Page 2: 1 active row, then drained.
    const page2Rows = [
      commitmentRow({
        id: 3,
        row_updated_at: '2026-05-29T12:00:00.333333+00:00',
        commitment_hash: `0x${'3'.repeat(64)}`,
      }),
    ];
    const { client: client2 } = makeSupabase([
      { data: page2Rows, error: null },                                                              // active (drained)
      { data: { row_updated_at: '2026-05-29T12:00:00.333333+00:00', id: 3 }, error: null },          // max c
      { data: { row_updated_at: '2026-05-29T15:00:00.000+00:00', id: 99 }, error: null },           // max p
    ]);
    supabaseMock.getSupabase.mockReturnValue(client2);
    const res2 = makeRes();
    await ownStateSnapshotHandler(
      makeReq({ query: { cursor: body1.cursor } }),
      res2 as unknown as Response,
    );
    const body2 = res2.body as { cursor: string; truncated: boolean; commitments: Array<{ commitmentHash: string }> };
    expect(body2.truncated).toBe(false);
    expect(body2.commitments).toHaveLength(1);
    expect(() => decodeOwnStateCursor(body2.cursor)).not.toThrow();
    expect(decodeOwnStateCursor(body2.cursor).k).toBe('live');

    // All rows delivered, no duplicates.
    const allHashes = [...body1.commitments, ...body2.commitments].map((c) => c.commitmentHash);
    expect(allHashes).toEqual([
      `0x${'1'.repeat(64)}`,
      `0x${'2'.repeat(64)}`,
      `0x${'3'.repeat(64)}`,
    ]);
    expect(new Set(allHashes).size).toBe(allHashes.length);
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
      hitCap: true, // raw-cap signal from helper — what `positionsTruncated` derives from
      derivedStatuses: [],
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

  it('cursor.p mint picks the microsecond-later sourceUpdatedAt across derivedStatuses (round-6 regression)', async () => {
    // Two derived statuses with sourceUpdatedAt values that differ only
    // in microseconds within the same millisecond. The snapshot's
    // cursor.p mint MUST pick the later one — `Date.parse`-based max
    // would tie them and pick whichever was iterated first, freezing
    // `p` even though the actual newer source did advance.
    positionFetchMock.fetchCategorizedPositions.mockResolvedValue({
      active: [
        {
          positionId: 'A_x_0',
          speculationId: '101',
          positionType: 0,
          team: 't',
          opponent: 'o',
          market: 'moneyline',
          oddsDecimal: 2,
          riskAmountUSDC: 1,
          profitAmountUSDC: 1,
        },
        {
          positionId: 'B_x_0',
          speculationId: '202',
          positionType: 0,
          team: 't',
          opponent: 'o',
          market: 'moneyline',
          oddsDecimal: 2,
          riskAmountUSDC: 1,
          profitAmountUSDC: 1,
        },
      ],
      pendingSettle: [],
      claimable: [],
      hitCap: false,
      // Iteration order: A first. A's sourceUpdatedAt is microsecond-
      // EARLIER. The `Date.parse`-based max would pick A (same ms ⇒
      // no update). `maxIsoTimestamptz` picks B (later microseconds).
      derivedStatuses: [
        {
          key: '101_0',
          status: 'active',
          sourceUpdatedAt: '2026-05-29T15:00:00.000100Z',
          result: undefined,
          claimableAmount: undefined,
        },
        {
          key: '202_0',
          status: 'active',
          sourceUpdatedAt: '2026-05-29T15:00:00.000200Z',
          result: undefined,
          claimableAmount: undefined,
        },
      ],
    });
    const { client } = makeSupabase([
      { data: [], error: null }, // active commitments
      { data: null, error: null }, // max commitments
      { data: null, error: null }, // max fills
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await ownStateSnapshotHandler(makeReq(), res as unknown as Response);
    const body = res.body as { cursor: string };
    const decoded = decodeOwnStateCursor(body.cursor);
    // p.s = .000200 (the microsecond-later one), NOT .000100.
    expect(decoded.p.s).toBe('2026-05-29T15:00:00.000200Z');
    expect(decoded.p.i).toBe('0');
  });
});
