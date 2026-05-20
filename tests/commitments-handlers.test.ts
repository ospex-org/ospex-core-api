/**
 * Handler-level tests for /v1/commitments read surfaces, focused on the
 * effective-status contract: a time-expired or nonce-invalidated commitment
 * whose stored status is still open/partially_filled must surface as terminal
 * (`expired` / `cancelled`) while preserving fill accounting, and the list
 * `status=` filter must match the effective `status` it returns.
 *
 * Mocks loadConfig + getSupabase. `Date.now()` is pinned via fake timers so
 * expiry comparisons are deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const NOW = Date.parse('2026-05-20T16:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const FUTURE = '2026-05-20T17:00:00.000Z';
const PAST = '2026-05-20T15:00:00.000Z';

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ network: 'polygon', chainId: 137 })),
}));

vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);

const { rowToBody, getCommitmentByHashHandler, getCommitmentsHandler } = await import(
  '../src/v1/commitments.js'
);

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
function makeReq(query: Record<string, string> = {}, params: Record<string, string> = {}): Request {
  return { params, query } as unknown as Request;
}

interface MockResponse {
  data: unknown;
  error: unknown;
  count?: number;
}
interface RecordedCall {
  method: string;
  args: unknown[];
}

/** Supabase mock that records every builder call so branch/filter choices can be asserted. */
function makeSupabase(response: MockResponse): { client: unknown; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const builder: Record<string, unknown> = {};
  const chain =
    (method: string) =>
    (...args: unknown[]): unknown => {
      calls.push({ method, args });
      return builder;
    };
  for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'order', 'range', 'limit']) {
    builder[m] = chain(m);
  }
  builder['maybeSingle'] = (): Promise<MockResponse> => Promise.resolve(response);
  builder['single'] = (): Promise<MockResponse> => Promise.resolve(response);
  builder['then'] = (resolve: (v: unknown) => void): void => resolve(response);
  return { client: { from: () => builder }, calls };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    expiry: FUTURE,
    speculation_key: '0xspec',
    signature: '0xsig',
    status: 'open',
    source: 'agent',
    network: 'polygon',
    nonce_invalidated: false,
    created_at: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── rowToBody: effective status + storedStatus + preserved accounting ─────
describe('rowToBody effective status', () => {
  it('open + past expiry → status expired, storedStatus open', () => {
    const b = rowToBody(row({ status: 'open', expiry: PAST }) as never, NOW);
    expect(b.status).toBe('expired');
    expect(b.storedStatus).toBe('open');
  });

  it('open + future expiry → status open', () => {
    const b = rowToBody(row({ status: 'open', expiry: FUTURE }) as never, NOW);
    expect(b.status).toBe('open');
    expect(b.storedStatus).toBe('open');
  });

  it('partially_filled + past expiry → expired, fill accounting preserved', () => {
    const b = rowToBody(
      row({
        status: 'partially_filled',
        expiry: PAST,
        risk_amount: '100000',
        filled_risk_amount: '35900',
      }) as never,
      NOW,
    );
    expect(b.status).toBe('expired');
    expect(b.storedStatus).toBe('partially_filled');
    expect(b.filledRiskAmount).toBe('35900');
    expect(b.remainingRiskAmount).toBe('64100');
  });

  it('nonce-invalidated open → status cancelled, storedStatus open, flag true', () => {
    const b = rowToBody(
      row({ status: 'open', expiry: FUTURE, nonce_invalidated: true }) as never,
      NOW,
    );
    expect(b.status).toBe('cancelled');
    expect(b.storedStatus).toBe('open');
    expect(b.nonceInvalidated).toBe(true);
  });

  it('filled stays filled regardless of expiry', () => {
    const b = rowToBody(row({ status: 'filled', expiry: PAST }) as never, NOW);
    expect(b.status).toBe('filled');
    expect(b.storedStatus).toBe('filled');
  });
});

// ── GET /v1/commitments/:hash agrees with effective status ────────────────
describe('GET /v1/commitments/:hash', () => {
  const hash = `0x${'a'.repeat(64)}`;

  it('returns effective "expired" for a past-expiry open row (the reported bug)', async () => {
    const { client } = makeSupabase({ data: row({ status: 'open', expiry: PAST }), error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentByHashHandler(makeReq({}, { hash }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'expired', storedStatus: 'open' });
  });

  it('returns effective "cancelled" for a nonce-invalidated open row', async () => {
    const { client } = makeSupabase({
      data: row({ status: 'open', expiry: FUTURE, nonce_invalidated: true }),
      error: null,
    });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentByHashHandler(makeReq({}, { hash }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'cancelled',
      storedStatus: 'open',
      nonceInvalidated: true,
    });
  });
});

// ── GET /v1/commitments list: effective-aware filter ──────────────────────
describe('GET /v1/commitments list', () => {
  it('default path uses the efficient SQL filter (live status + expiry boundary)', async () => {
    const { client, calls } = makeSupabase({ data: [row()], error: null, count: 1 });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(calls).toContainEqual({ method: 'in', args: ['status', ['open', 'partially_filled']] });
    expect(calls).toContainEqual({ method: 'eq', args: ['nonce_invalidated', false] });
    expect(calls).toContainEqual({ method: 'gt', args: ['expiry', NOW_ISO] });
  });

  it('status=expired is rejected (400) — "expired" is effective-only, not a stored filter value', async () => {
    const { client } = makeSupabase({ data: [], error: null, count: 0 });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ status: 'expired' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('includeExpired=true drops the expiry SQL boundary; a past-expiry stored-open row is returned labeled effective "expired"', async () => {
    const rows = [
      row({ commitment_hash: `0x${'1'.repeat(64)}`, status: 'open', expiry: PAST }), // eff expired
      row({ commitment_hash: `0x${'2'.repeat(64)}`, status: 'open', expiry: FUTURE }), // eff open
    ];
    const { client, calls } = makeSupabase({ data: rows, error: null, count: 2 });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ includeExpired: 'true' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(calls.some((c) => c.method === 'gt' && c.args[0] === 'expiry')).toBe(false);
    const body = res.body as { commitments: Array<{ status: string; storedStatus: string }>; pagination: { total: number } };
    expect(body.commitments.map((c) => c.status)).toEqual(['expired', 'open']);
    expect(body.commitments.every((c) => c.storedStatus === 'open')).toBe(true);
    expect(body.pagination.total).toBe(2); // DB-exact count, no in-memory cap
  });

  it('includeInvalidated=true drops the nonce_invalidated SQL filter (original meaning); the row is labeled effective "cancelled"', async () => {
    const rows = [
      row({ commitment_hash: `0x${'1'.repeat(64)}`, status: 'open', expiry: FUTURE, nonce_invalidated: true }), // eff cancelled
    ];
    const { client, calls } = makeSupabase({ data: rows, error: null, count: 1 });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ includeInvalidated: 'true' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'nonce_invalidated')).toBe(false);
    const body = res.body as { commitments: Array<{ status: string; storedStatus: string; nonceInvalidated: boolean }> };
    expect(body.commitments[0]).toMatchObject({ status: 'cancelled', storedStatus: 'open', nonceInvalidated: true });
  });
});
