/**
 * Handler-level tests for /v1/commitments read surfaces, focused on the
 * effective-status contract: a time-expired or nonce-invalidated commitment
 * whose stored status is still open/partially_filled must surface as terminal
 * (`expired` / `cancelled`) while preserving fill accounting. The list
 * `status=`/include* filters operate on the STORED columns (DB-exact pagination),
 * while the response `status` is effective.
 *
 * Mocks loadConfig + getSupabase. `Date.now()` is pinned via fake timers so
 * expiry comparisons are deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../src/middleware/eip712Auth.js';

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

const { rowToBody, getCommitmentByHashHandler, getCommitmentsHandler, deleteCommitmentHandler, computeFillability } =
  await import('../src/v1/commitments.js');

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
function makeAuthReq(hash: string, signedHash: string, wallet: string): AuthenticatedRequest {
  return {
    params: { hash },
    actionMessage: { commitmentHash: signedHash },
    authenticatedWallet: wallet,
  } as unknown as AuthenticatedRequest;
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

/**
 * Supabase mock that records every builder call so branch/filter choices can be
 * asserted. Pass a single response (returned for every terminal call) or an array
 * to return responses in sequence — needed for multi-step flows like DELETE
 * (lookup → CAS update → re-read), where each terminal call wants a distinct row.
 */
function makeSupabase(response: MockResponse | MockResponse[]): { client: unknown; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = Array.isArray(response) ? response : null;
  let idx = 0;
  const nextResp = (): MockResponse =>
    queue ? (queue[Math.min(idx++, queue.length - 1)] as MockResponse) : (response as MockResponse);
  const builder: Record<string, unknown> = {};
  const chain =
    (method: string) =>
    (...args: unknown[]): unknown => {
      calls.push({ method, args });
      return builder;
    };
  for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'order', 'range', 'limit', 'update', 'delete', 'insert']) {
    builder[m] = chain(m);
  }
  builder['maybeSingle'] = (): Promise<MockResponse> => Promise.resolve(nextResp());
  builder['single'] = (): Promise<MockResponse> => Promise.resolve(nextResp());
  builder['then'] = (resolve: (v: unknown) => void): void => resolve(nextResp());
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
    book_visible: true,
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

  it('open + hidden (book_visible false) → status cancelled, storedStatus open, bookVisible false', () => {
    const b = rowToBody(row({ status: 'open', expiry: FUTURE, book_visible: false }) as never, NOW);
    expect(b.status).toBe('cancelled');
    expect(b.storedStatus).toBe('open');
    expect(b.bookVisible).toBe(false);
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

// ── GET /v1/commitments list: stored-status filter, effective-status response ──
describe('GET /v1/commitments list', () => {
  it('default path uses the efficient SQL filter (live status + expiry boundary)', async () => {
    const { client, calls } = makeSupabase({ data: [row()], error: null, count: 1 });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(calls).toContainEqual({ method: 'in', args: ['status', ['open', 'partially_filled']] });
    expect(calls).toContainEqual({ method: 'eq', args: ['book_visible', true] });
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

  it('any includeHidden value is rejected (400 INCLUDE_HIDDEN_REMOVED) — the param has been removed', async () => {
    const { client, calls } = makeSupabase({ data: [row()], error: null, count: 1 });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ includeHidden: 'true' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INCLUDE_HIDDEN_REMOVED' });
    // Hard fail-fast before the DB call: no select issued.
    expect(calls.some((c) => c.method === 'select')).toBe(false);
  });

  it('the default list always filters book_visible=true (includeHidden removal means the filter is unconditional)', async () => {
    const { client, calls } = makeSupabase({ data: [row()], error: null, count: 1 });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(calls).toContainEqual({ method: 'eq', args: ['book_visible', true] });
  });
});

// ── DELETE /v1/commitments/:hash → off-chain cancel = book_visible=false ───
describe('DELETE /v1/commitments/:hash', () => {
  const hash = `0x${'a'.repeat(64)}`;
  const maker = '0x1111111111111111111111111111111111111111';

  it('open visible row → hides (book_visible=false), status untouched, 200', async () => {
    const { client, calls } = makeSupabase([
      { data: row({ status: 'open', book_visible: true }), error: null }, // lookup
      { data: row({ status: 'open', book_visible: false }), error: null }, // CAS update
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await deleteCommitmentHandler(makeAuthReq(hash, hash, maker), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    // off-chain cancel writes ONLY book_visible=false — never status='cancelled'
    expect(calls.find((c) => c.method === 'update')?.args[0]).toEqual({ book_visible: false });
    // CAS guard: only an open + currently-visible row
    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'open'] });
    expect(calls).toContainEqual({ method: 'eq', args: ['book_visible', true] });
    // response: effective cancelled (back-compat), stored open, hidden
    expect(res.body).toMatchObject({ status: 'cancelled', storedStatus: 'open', bookVisible: false });
  });

  it('already-hidden row → idempotent 200, no update', async () => {
    const { client, calls } = makeSupabase({
      data: row({ status: 'open', book_visible: false }),
      error: null,
    });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await deleteCommitmentHandler(makeAuthReq(hash, hash, maker), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(calls.some((c) => c.method === 'update')).toBe(false);
    expect(res.body).toMatchObject({ status: 'cancelled', storedStatus: 'open', bookVisible: false });
  });

  it('on-chain cancelled row → idempotent 200, no update', async () => {
    const { client, calls } = makeSupabase({
      data: row({ status: 'cancelled', book_visible: false }),
      error: null,
    });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await deleteCommitmentHandler(makeAuthReq(hash, hash, maker), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(calls.some((c) => c.method === 'update')).toBe(false);
    expect(res.body).toMatchObject({ status: 'cancelled' });
  });

  it('VISIBLE partially_filled row → 409 COMMITMENT_MATCHED, no update', async () => {
    const { client, calls } = makeSupabase({ data: row({ status: 'partially_filled' }), error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await deleteCommitmentHandler(makeAuthReq(hash, hash, maker), res as unknown as Response);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'COMMITMENT_MATCHED' });
    expect(calls.some((c) => c.method === 'update')).toBe(false);
  });

  // The race this split fixes can leave a row hidden AND matched (book_visible=false,
  // status partially_filled/filled). DELETE = "hide from book" — it's already hidden,
  // so a retry is idempotent 200, NOT 409. The body surfaces the real fill state.
  it('HIDDEN + matched (book_visible=false, partially_filled) → idempotent 200, no update', async () => {
    const { client, calls } = makeSupabase({
      data: row({
        status: 'partially_filled',
        book_visible: false,
        risk_amount: '1000000',
        filled_risk_amount: '37500',
      }),
      error: null,
    });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await deleteCommitmentHandler(makeAuthReq(hash, hash, maker), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(calls.some((c) => c.method === 'update')).toBe(false);
    // Effective status stays 'cancelled' (off-book), but storedStatus + bookVisible
    // + fill accounting carry the truth (per review).
    expect(res.body).toMatchObject({
      status: 'cancelled',
      storedStatus: 'partially_filled',
      bookVisible: false,
      filledRiskAmount: '37500',
      remainingRiskAmount: '962500',
    });
  });

  it('HIDDEN + filled (book_visible=false, filled) → idempotent 200, no update', async () => {
    const { client, calls } = makeSupabase({
      data: row({ status: 'filled', book_visible: false, risk_amount: '1000000', filled_risk_amount: '1000000' }),
      error: null,
    });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await deleteCommitmentHandler(makeAuthReq(hash, hash, maker), res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(calls.some((c) => c.method === 'update')).toBe(false);
    expect(res.body).toMatchObject({ status: 'filled', storedStatus: 'filled', bookVisible: false });
  });

  it('CAS reread shows the row already hidden (matched in the race) → idempotent 200', async () => {
    const { client } = makeSupabase([
      { data: row({ status: 'open', book_visible: true }), error: null }, // lookup
      { data: null, error: null }, // CAS update misses
      { data: row({ status: 'partially_filled', book_visible: false }), error: null }, // reread: hidden + matched
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await deleteCommitmentHandler(makeAuthReq(hash, hash, maker), res as unknown as Response);
    expect(res.statusCode).toBe(200);
  });

  it('CAS lost to an on-chain match during update → 409 COMMITMENT_MATCHED', async () => {
    const { client } = makeSupabase([
      { data: row({ status: 'open', book_visible: true }), error: null }, // lookup
      { data: null, error: null }, // CAS update misses
      { data: row({ status: 'partially_filled' }), error: null }, // re-read: matched
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await deleteCommitmentHandler(makeAuthReq(hash, hash, maker), res as unknown as Response);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'COMMITMENT_MATCHED' });
  });

  it('signer ≠ maker → 403 FORBIDDEN', async () => {
    const { client } = makeSupabase({ data: row({ status: 'open' }), error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await deleteCommitmentHandler(
      makeAuthReq(hash, hash, '0x9999999999999999999999999999999999999999'),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ── GET /v1/commitments list: advisory fillability (Layer D) ──────────────
describe('GET /v1/commitments list — fillability', () => {
  const MAKER = '0x1111111111111111111111111111111111111111';
  function fundingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      maker_address: MAKER,
      backing_wei6: '5000000',
      visible_committed_wei6: '1000000',
      checked_at_block: 73491234,
      updated_at: NOW_ISO, // fresh under the pinned clock
      ...overrides,
    };
  }

  it('includeFillability=true attaches a fully_backed verdict + queries maker_funding by maker', async () => {
    const { client, calls } = makeSupabase([
      { data: [row({ maker: MAKER, risk_amount: '1000000', filled_risk_amount: '0' })], error: null, count: 1 },
      { data: [fundingRow()], error: null },
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ includeFillability: 'true' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    // one extra indexed query keyed by the page's makers
    expect(calls).toContainEqual({ method: 'in', args: ['maker_address', [MAKER]] });
    const body = res.body as { commitments: Array<{ fillability?: Record<string, unknown> }> };
    expect(body.commitments[0]?.fillability).toMatchObject({
      advisory: true,
      makerFundingStatus: 'fully_backed',
      orderIndividuallyBackedNow: true,
      makerBookBackedNow: true,
      makerBackingWei6: '5000000',
      makerVisibleCommittedWei6: '1000000',
      makerCoverageRatioBps: 50000,
      checkedAtBlock: '73491234',
      stale: false,
    });
  });

  it('default (no param) attaches no fillability and issues no maker_funding query', async () => {
    const { client, calls } = makeSupabase({ data: [row({ maker: MAKER })], error: null, count: 1 });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(calls.some((c) => c.method === 'in' && c.args[0] === 'maker_address')).toBe(false);
    const body = res.body as { commitments: Array<{ fillability?: unknown }> };
    expect(body.commitments[0]?.fillability).toBeUndefined();
  });

  it('maker with no snapshot → fillability unknown', async () => {
    const { client } = makeSupabase([
      { data: [row({ maker: MAKER })], error: null, count: 1 },
      { data: [], error: null }, // no funding row for this maker
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ includeFillability: 'true' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { commitments: Array<{ fillability?: Record<string, unknown> }> };
    expect(body.commitments[0]?.fillability).toMatchObject({
      makerFundingStatus: 'unknown',
      orderIndividuallyBackedNow: null,
      makerBackingWei6: null,
      stale: false,
    });
  });

  it('maker_funding query failure degrades to unknown — list still 200', async () => {
    const { client } = makeSupabase([
      { data: [row({ maker: MAKER })], error: null, count: 1 },
      { data: null, error: { message: 'boom' } }, // funding query errors
    ]);
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ includeFillability: 'true' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { commitments: Array<{ fillability?: Record<string, unknown> }> };
    expect(body.commitments[0]?.fillability).toMatchObject({ makerFundingStatus: 'unknown' });
  });

  it('includeFillability with a bad value → 400', async () => {
    const { client } = makeSupabase({ data: [], error: null, count: 0 });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ includeFillability: 'maybe' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });
});

// ── computeFillability (pure verdict logic) ───────────────────────────────
describe('computeFillability', () => {
  const STALE = 120_000;
  const fresh = (
    over: Partial<{ backingWei6: bigint; visibleCommittedWei6: bigint; checkedAtBlock: string; updatedAtMs: number }> = {},
  ) => ({
    backingWei6: 100_000_000n,
    visibleCommittedWei6: 50_000_000n,
    checkedAtBlock: '73491234',
    updatedAtMs: NOW,
    ...over,
  });

  it('fresh, backing ≥ whole book → fully_backed, both booleans true', () => {
    const f = computeFillability({ remainingRiskWei6: 10_000_000n, funding: fresh(), nowMs: NOW, staleThresholdMs: STALE });
    expect(f).toMatchObject({
      advisory: true,
      makerFundingStatus: 'fully_backed',
      orderIndividuallyBackedNow: true,
      makerBookBackedNow: true,
      makerCoverageRatioBps: 20000, // 100M / 50M = 200%
      stale: false,
    });
  });

  it('fake-liquidity case: backing covers THIS order but not the whole book → overcommitted (individually-backed true, book-backed false)', () => {
    const f = computeFillability({
      remainingRiskWei6: 10_000_000n,
      funding: fresh({ backingWei6: 15_000_000n, visibleCommittedWei6: 100_000_000n }),
      nowMs: NOW,
      staleThresholdMs: STALE,
    });
    expect(f.makerFundingStatus).toBe('overcommitted');
    expect(f.orderIndividuallyBackedNow).toBe(true); // 15M ≥ 10M
    expect(f.makerBookBackedNow).toBe(false); // 15M < 100M
    expect(f.makerCoverageRatioBps).toBe(1500); // 15%
  });

  it('order not even individually backed → overcommitted, both booleans false', () => {
    const f = computeFillability({
      remainingRiskWei6: 20_000_000n,
      funding: fresh({ backingWei6: 15_000_000n, visibleCommittedWei6: 100_000_000n }),
      nowMs: NOW,
      staleThresholdMs: STALE,
    });
    expect(f.orderIndividuallyBackedNow).toBe(false);
    expect(f.makerBookBackedNow).toBe(false);
  });

  it('stale snapshot → status stale, "...Now" booleans null, numbers kept as last-known', () => {
    const f = computeFillability({
      remainingRiskWei6: 10_000_000n,
      funding: fresh({ updatedAtMs: NOW - 200_000 }), // 200s old > 120s
      nowMs: NOW,
      staleThresholdMs: STALE,
    });
    expect(f.makerFundingStatus).toBe('stale');
    expect(f.stale).toBe(true);
    expect(f.orderIndividuallyBackedNow).toBeNull();
    expect(f.makerBookBackedNow).toBeNull();
    expect(f.makerBackingWei6).toBe('100000000'); // last-known kept
    expect(f.checkedAtBlock).toBe('73491234');
  });

  it('no snapshot → unknown, everything null, stale false', () => {
    const f = computeFillability({ remainingRiskWei6: 10_000_000n, funding: undefined, nowMs: NOW, staleThresholdMs: STALE });
    expect(f).toMatchObject({
      makerFundingStatus: 'unknown',
      orderIndividuallyBackedNow: null,
      makerBookBackedNow: null,
      makerBackingWei6: null,
      makerVisibleCommittedWei6: null,
      makerCoverageRatioBps: null,
      checkedAtBlock: null,
      stale: false,
    });
  });

  it('exact-coverage boundary (backing == committed == remaining) → fully_backed, both true (>= inclusive)', () => {
    const f = computeFillability({
      remainingRiskWei6: 50_000_000n,
      funding: fresh({ backingWei6: 50_000_000n, visibleCommittedWei6: 50_000_000n }),
      nowMs: NOW,
      staleThresholdMs: STALE,
    });
    expect(f.makerFundingStatus).toBe('fully_backed');
    expect(f.orderIndividuallyBackedNow).toBe(true);
    expect(f.makerBookBackedNow).toBe(true);
    expect(f.makerCoverageRatioBps).toBe(10000); // 100%
  });

  it('non-finite age (bad updated_at) → treated as stale (fail safe)', () => {
    const f = computeFillability({
      remainingRiskWei6: 10_000_000n,
      funding: fresh({ updatedAtMs: NaN }),
      nowMs: NOW,
      staleThresholdMs: STALE,
    });
    expect(f.makerFundingStatus).toBe('stale');
  });
});
