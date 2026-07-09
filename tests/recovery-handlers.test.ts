/**
 * Handler tests for the cursor-recovery surfaces:
 *   - GET /v1/commitments?since=  (recovery branch of getCommitmentsHandler)
 *   - GET /v1/fills
 *   - GET /v1/positions           (bare recovery endpoint)
 *   - GET /v1/speculations?since=
 *   - GET /v1/contests?since=
 *
 * Asserts the recovery contract: keyset (row_updated_at, id) ordering, the
 * `.or(...)` keyset filter (strict for `page` cursors, overlap-floored for
 * `live` resume cursors), the {resource, nextCursor, hasMore} envelope with a
 * PAGE nextCursor, and that recovery does NOT inherit the open-book
 * status/expiry filters that would hide terminal rows.
 *
 * Mocks loadConfig + getSupabase, matching the existing handler-test harness
 * (extended with `.or` on the recorded builder).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { encodeCursor, keysetOrExpr } from '../src/lib/cursor.js';
import { RECOVERY_OVERLAP_MS } from '../src/lib/recovery.js';

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ network: 'polygon', chainId: 137 })),
}));
vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);

const { getCommitmentsHandler } = await import('../src/v1/commitments.js');
const { getFillsHandler } = await import('../src/v1/fills.js');
const { getPositionsRecoveryHandler } = await import('../src/v1/positions.js');
const { getSpeculationsHandler } = await import('../src/v1/speculations.js');
const { getContestsHandler } = await import('../src/v1/contests.js');

// ── test doubles ────────────────────────────────────────────────────────
interface FakeRes {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
}
function makeRes(): FakeRes {
  const res: FakeRes = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}
function makeReq(query: Record<string, string> = {}): Request {
  return { params: {}, query } as unknown as Request;
}

interface MockResponse {
  data: unknown;
  error: unknown;
}
interface RecordedCall {
  method: string;
  args: unknown[];
}
function makeSupabase(response: MockResponse): { client: unknown; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const builder: Record<string, unknown> = {};
  const chain =
    (method: string) =>
    (...args: unknown[]): unknown => {
      calls.push({ method, args });
      return builder;
    };
  for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'range', 'limit']) {
    builder[m] = chain(m);
  }
  builder['maybeSingle'] = (): Promise<MockResponse> => Promise.resolve(response);
  builder['single'] = (): Promise<MockResponse> => Promise.resolve(response);
  builder['then'] = (resolve: (v: unknown) => void): void => resolve(response);
  return { client: { from: () => builder }, calls };
}

function has(calls: RecordedCall[], method: string, arg0?: unknown): boolean {
  return calls.some((c) => c.method === method && (arg0 === undefined || c.args[0] === arg0));
}
function orArg(calls: RecordedCall[]): string | undefined {
  return calls.find((c) => c.method === 'or')?.args[0] as string | undefined;
}

beforeEach(() => {
  supabaseMock.getSupabase.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

// ── row factories ─────────────────────────────────────────────────────
const TS = '2026-05-20T12:00:00.000Z';
function commitmentRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commitment_hash: `0x${'a'.repeat(64)}`,
    maker: '0x1111111111111111111111111111111111111111',
    contest_id: 1,
    scorer: '0x2222222222222222222222222222222222222222',
    line_ticks: 0,
    position_type: 'upper',
    odds_tick: 200,
    market_type: 'moneyline',
    risk_amount: '1000000',
    filled_risk_amount: '0',
    nonce: '1',
    expiry: '2026-05-21T00:00:00.000Z',
    speculation_key: '0xspec',
    signature: '0xsig',
    status: 'filled',
    source: 'agent',
    network: 'polygon',
    nonce_invalidated: false,
    created_at: '2026-05-20T10:00:00.000Z',
    id: 42,
    row_updated_at: TS,
    ...o,
  };
}
function fillRow(o: Record<string, unknown> = {}): Record<string, unknown> {
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
    log_index: 3,
    id: 7,
    row_updated_at: TS,
    ...o,
  };
}
function positionRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    speculation_id: 5,
    user_address: '0x1111111111111111111111111111111111111111',
    position_type: 'lower',
    risk_amount: '1000000',
    profit_amount: '500000',
    claimed: true,
    claimed_at: TS,
    position_created_at: '2026-05-20T09:00:00.000Z',
    id: 11,
    row_updated_at: TS,
    ...o,
  };
}

// ── GET /v1/commitments?since= ──────────────────────────────────────────
describe('commitments recovery', () => {
  const CURSOR_TS = '2026-05-20T11:00:00.000Z';
  const pageCursor = encodeCursor({ t: 'commitments', s: CURSOR_TS, i: '40', k: 'page' });
  const liveCursor = encodeCursor({ t: 'commitments', s: CURSOR_TS, i: '40', k: 'live' });

  it('page cursor: strict keyset, terminal rows included, NO open-book filters, PAGE nextCursor', async () => {
    const { client, calls } = makeSupabase({ data: [commitmentRow()], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ since: pageCursor, limit: '1' }), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    const body = res.body as { commitments: Array<{ status: string }>; nextCursor: string; hasMore: boolean };
    expect(body.commitments[0]?.status).toBe('filled'); // terminal row surfaces
    expect(body.hasMore).toBe(true); // 1 row == limit 1
    // PAGE nextCursor (so subsequent paging is strict + terminating)
    expect(body.nextCursor).toBe(encodeCursor({ t: 'commitments', s: TS, i: '42', k: 'page' }));
    // strict keyset on the cursor's own (s, i)
    expect(orArg(calls)).toBe(keysetOrExpr(CURSOR_TS, '40'));
    expect(has(calls, 'order', 'row_updated_at')).toBe(true);
    expect(has(calls, 'order', 'id')).toBe(true);
    // NOT the open-book defaults
    expect(has(calls, 'in', 'status')).toBe(false);
    expect(has(calls, 'gt', 'expiry')).toBe(false);
  });

  it('live (resume) cursor: re-scans the overlap window before the cursor timestamp', async () => {
    const { client, calls } = makeSupabase({ data: [], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ since: liveCursor }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const floored = new Date(Date.parse(CURSOR_TS) - RECOVERY_OVERLAP_MS).toISOString();
    expect(orArg(calls)).toBe(keysetOrExpr(floored, '0'));
  });

  it('hasMore=false and echoes the input cursor when the page is empty', async () => {
    const { client } = makeSupabase({ data: [], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ since: pageCursor }), res as unknown as Response);
    const body = res.body as { nextCursor: string | null; hasMore: boolean };
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBe(pageCursor);
  });

  it('rejects a malformed cursor with 400 INVALID_CURSOR', async () => {
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ since: '@@@not-a-cursor' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('rejects a cursor minted for a different resource with 400', async () => {
    const wrong = encodeCursor({ t: 'fills', s: TS, i: '1', k: 'page' });
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ since: wrong }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
  });
});

// ── GET /v1/fills ───────────────────────────────────────────────────────
describe('fills', () => {
  it('maps fill rows and is keyset-ordered; nextCursor null when empty', async () => {
    const { client, calls } = makeSupabase({ data: [], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getFillsHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { fills: unknown[]; nextCursor: string | null; hasMore: boolean };
    expect(body.fills).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(has(calls, 'order', 'row_updated_at')).toBe(true);
  });

  it('applies a maker filter and a page-cursor strict keyset, maps the body shape', async () => {
    const cursorTs = '2026-05-20T11:00:00.000Z';
    const cursor = encodeCursor({ t: 'fills', s: cursorTs, i: '1', k: 'page' });
    const { client, calls } = makeSupabase({ data: [fillRow()], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    const maker = '0x1111111111111111111111111111111111111111';
    await getFillsHandler(makeReq({ maker, since: cursor, limit: '1' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(has(calls, 'eq', 'maker_address')).toBe(true);
    expect(orArg(calls)).toBe(keysetOrExpr(cursorTs, '1'));
    const body = res.body as { fills: Array<{ makerPositionType: number; takerPositionType: number; logIndex: number }>; hasMore: boolean };
    expect(body.fills[0]).toMatchObject({ makerPositionType: 0, takerPositionType: 1, logIndex: 3 });
    expect(body.hasMore).toBe(true);
  });

  it('rejects a bad maker address with 400', async () => {
    const res = makeRes();
    await getFillsHandler(makeReq({ maker: 'nope' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });
});

// ── GET /v1/positions (recovery) ────────────────────────────────────────
describe('positions recovery', () => {
  it('filters by address and maps userAddress + claim fields', async () => {
    const { client, calls } = makeSupabase({ data: [positionRow()], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    const address = '0x1111111111111111111111111111111111111111';
    await getPositionsRecoveryHandler(makeReq({ address }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(has(calls, 'eq', 'user_address')).toBe(true);
    const body = res.body as { positions: Array<{ userAddress: string; claimed: boolean; positionType: number }> };
    expect(body.positions[0]).toMatchObject({ userAddress: address, claimed: true, positionType: 1 });
  });
});

// ── GET /v1/speculations?since= ─────────────────────────────────────────
describe('speculations recovery', () => {
  it('returns the recovery envelope keyset-ordered', async () => {
    const cursorTs = '2026-05-20T11:00:00.000Z';
    const cursor = encodeCursor({ t: 'speculations', s: cursorTs, i: '1', k: 'page' });
    const { client, calls } = makeSupabase({ data: [], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getSpeculationsHandler(makeReq({ since: cursor }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ speculations: [], hasMore: false });
    expect(orArg(calls)).toBe(keysetOrExpr(cursorTs, '1'));
    expect(has(calls, 'order', 'row_updated_at')).toBe(true);
  });
});

// ── GET /v1/contests?since= ─────────────────────────────────────────────
describe('contests recovery', () => {
  it('works without SCORER_* config (recovery branch precedes the scorers check)', async () => {
    const cursorTs = '2026-05-20T11:00:00.000Z';
    const cursor = encodeCursor({ t: 'contests', s: cursorTs, i: '1', k: 'page' });
    const { client, calls } = makeSupabase({
      data: [{ contest_id: 1, contest_status: 'scored', away_score: 3, home_score: 1, scored_at: TS, id: 9, row_updated_at: TS }],
      error: null,
    });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getContestsHandler(makeReq({ since: cursor }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { contests: Array<{ contestId: string; status: string; scoredAt: string | null }> };
    expect(body.contests[0]).toMatchObject({ contestId: '1', status: 'scored', scoredAt: TS });
    expect(orArg(calls)).toBe(keysetOrExpr(cursorTs, '1'));
  });
});
