/**
 * M2 redaction — public hidden-row allow-list across every anonymous read.
 *
 * Five public anonymous paths can expose a commitment body (from
 * `phase0-redaction-audit.md` §3): `/v1/commitments/:hash`,
 * `/v1/commitments?since=<cursor>` (recovery), `/v1/commitments` default list
 * (with `?includeHidden=true` now removed → 400), and the SSE
 * `/v1/stream/commitments` toBody (used by both catch-up and live deltas).
 *
 * Allow-list (not deny-list) projection is the central guarantee. An upstream
 * column addition that isn't explicitly opted in MUST surface as a failed
 * exact-match assertion in this suite — that's the design.
 *
 * Two operating modes are covered:
 *   - `REDACT_HIDDEN_PUBLIC=true` (default): the redaction enforcement.
 *   - `REDACT_HIDDEN_PUBLIC=false`: the short-lived rollback path. Same paths
 *     return full bodies. Used only as a deploy-window safety valve; the
 *     post-cutover follow-up removes the flag entirely (impl-plan §M7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { encodeCursor } from '../src/lib/cursor.js';

const NOW = Date.parse('2026-05-28T16:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const FUTURE = '2026-05-28T17:00:00.000Z';

// A real recovery cursor — `parseRecovery` rejects anything else as 400.
const RECOVERY_CURSOR = encodeCursor({ t: 'commitments', s: NOW_ISO, i: '1', k: 'page' });

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    network: 'polygon',
    chainId: 137,
    redactHiddenPublic: true,
  })),
}));

vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);

const { getCommitmentByHashHandler, getCommitmentsHandler, PUBLIC_HIDDEN_ALLOWLIST } = await import(
  '../src/v1/commitments.js'
);
const { STREAM_RESOURCES } = await import('../src/v1/stream/resources.js');

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
function makeReq(query: Record<string, string> = {}, params: Record<string, string> = {}): Request {
  return { params, query } as unknown as Request;
}

interface MockResponse {
  data: unknown;
  error: unknown;
  count?: number;
}
function makeSupabase(response: MockResponse | MockResponse[]): { client: unknown } {
  const queue = Array.isArray(response) ? response : null;
  let idx = 0;
  const next = (): MockResponse =>
    queue ? (queue[Math.min(idx++, queue.length - 1)] as MockResponse) : (response as MockResponse);
  const builder: Record<string, unknown> = {};
  const chain =
    () =>
    (..._args: unknown[]): unknown =>
      builder;
  for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'range', 'limit', 'update', 'delete', 'insert']) {
    builder[m] = chain();
  }
  builder['maybeSingle'] = (): Promise<MockResponse> => Promise.resolve(next());
  builder['single'] = (): Promise<MockResponse> => Promise.resolve(next());
  builder['then'] = (resolve: (v: unknown) => void): void => resolve(next());
  return { client: { from: () => builder } };
}

function visibleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commitment_hash: `0x${'a'.repeat(64)}`,
    maker: '0x1111111111111111111111111111111111111111',
    contest_id: 42,
    scorer: '0x2222222222222222222222222222222222222222',
    line_ticks: 0,
    position_type: 'upper',
    odds_tick: 200,
    market_type: 'moneyline',
    risk_amount: '1000000',
    filled_risk_amount: '0',
    nonce: '1',
    expiry: FUTURE,
    speculation_key: `0x${'b'.repeat(64)}`,
    signature: `0x${'9'.repeat(130)}`,
    status: 'open',
    source: 'agent',
    network: 'polygon',
    nonce_invalidated: false,
    book_visible: true,
    created_at: '2026-05-28T10:00:00.000Z',
    id: 1,
    row_updated_at: NOW_ISO,
    ...overrides,
  };
}
function hiddenRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return visibleRow({ book_visible: false, ...overrides });
}

/**
 * The deny-list assertion. These fields MUST NOT appear on a hidden public body
 * (audit §6.2). The allow-list exact-match assertion implicitly catches all
 * of these, but the explicit deny-list call-out documents the threat-model
 * fields and makes a regression unambiguous if a future addition slips in.
 */
const PUBLIC_HIDDEN_DENYLIST = [
  'signature',
  'nonce',
  'oddsTick',
  'riskAmount',
  'remainingRiskAmount',
  'lineTicks',
  'scorer',
  'speculationKey',
  'marketType',
  'source',
  'network',
  'createdAt',
] as const;

function assertHiddenBody(body: unknown): void {
  expect(body).toBeTypeOf('object');
  const keys = Object.keys(body as object).sort();
  expect(keys).toEqual([...PUBLIC_HIDDEN_ALLOWLIST].sort());
  expect(body).toMatchObject({
    redacted: true,
    payloadAvailable: false,
    bookVisible: false,
  });
  for (const denied of PUBLIC_HIDDEN_DENYLIST) {
    expect(body as Record<string, unknown>).not.toHaveProperty(denied);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  envMock.loadConfig.mockReturnValue({ network: 'polygon', chainId: 137, redactHiddenPublic: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const hash = `0x${'a'.repeat(64)}`;

// ─────────────────────────────────────────────────────────────────────────
// Leak path 1 — GET /v1/commitments/:hash
// ─────────────────────────────────────────────────────────────────────────
describe('Leak path 1 — GET /v1/commitments/:hash', () => {
  it('visible row → full body (no regression)', async () => {
    const { client } = makeSupabase({ data: visibleRow(), error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentByHashHandler(makeReq({}, { hash }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      commitmentHash: hash,
      signature: expect.any(String),
      nonce: '1',
      oddsTick: 200,
      riskAmount: '1000000',
      bookVisible: true,
    });
    expect(res.body).not.toHaveProperty('redacted');
  });

  it('hidden row → keys exact-match PUBLIC_HIDDEN_ALLOWLIST', async () => {
    const { client } = makeSupabase({ data: hiddenRow(), error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentByHashHandler(makeReq({}, { hash }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    assertHiddenBody(res.body);
  });

  it('hidden row carries effective status="cancelled" + storedStatus="open" (lifecycle signal preserved)', async () => {
    const { client } = makeSupabase({ data: hiddenRow({ status: 'open' }), error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentByHashHandler(makeReq({}, { hash }), res as unknown as Response);
    expect(res.body).toMatchObject({ status: 'cancelled', storedStatus: 'open', bookVisible: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Leak path 2 — GET /v1/commitments?since=<cursor> (recovery)
// ─────────────────────────────────────────────────────────────────────────
describe('Leak path 2 — GET /v1/commitments?since=<cursor> (recovery)', () => {
  const cursor = RECOVERY_CURSOR;

  it('visible row → full body per row (no regression)', async () => {
    const { client } = makeSupabase({ data: [visibleRow()], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ since: cursor }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { commitments: unknown[] };
    expect(body.commitments).toHaveLength(1);
    expect(body.commitments[0]).toMatchObject({ signature: expect.any(String), nonce: '1' });
  });

  it('hidden row → allow-list projection (lifecycle transition surfaced redacted)', async () => {
    const { client } = makeSupabase({ data: [hiddenRow()], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ since: cursor }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { commitments: unknown[] };
    expect(body.commitments).toHaveLength(1);
    assertHiddenBody(body.commitments[0]);
  });

  it('mixed visible + hidden in one recovery batch → each row gets the correct projection', async () => {
    const v = visibleRow({ commitment_hash: `0x${'1'.repeat(64)}` });
    const h = hiddenRow({ commitment_hash: `0x${'2'.repeat(64)}` });
    const { client } = makeSupabase({ data: [v, h], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ since: cursor }), res as unknown as Response);
    const body = res.body as { commitments: Array<Record<string, unknown>> };
    expect(body.commitments).toHaveLength(2);
    expect(body.commitments[0]).toHaveProperty('signature');
    expect(body.commitments[0]).not.toHaveProperty('redacted');
    assertHiddenBody(body.commitments[1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Leak path 3 — GET /v1/commitments?includeHidden=true (REMOVED)
// ─────────────────────────────────────────────────────────────────────────
describe('Leak path 3 — GET /v1/commitments?includeHidden=true (removed)', () => {
  it('any includeHidden value → 400 INCLUDE_HIDDEN_REMOVED, no DB query', async () => {
    // No supabase mock needed — handler must bail before any DB call.
    supabaseMock.getSupabase.mockReturnValue(undefined);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ includeHidden: 'true' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INCLUDE_HIDDEN_REMOVED' });
  });

  it('includeHidden=false also rejected (the param does not exist at all)', async () => {
    supabaseMock.getSupabase.mockReturnValue(undefined);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ includeHidden: 'false' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INCLUDE_HIDDEN_REMOVED' });
  });

  it('absent includeHidden → list proceeds and default-filters book_visible=true', async () => {
    const { client } = makeSupabase({ data: [visibleRow()], error: null, count: 1 });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
  });

  // Regression: `?since=` is dispatched to recovery in `getCommitmentsHandler`
  // BEFORE the inline `includeHidden` check ran, so combining the two slipped
  // through the contract ("removed everywhere, 400 before any DB call"). The
  // check now sits at the top of `getCommitmentsHandler` and closes both
  // branches at one site. These two regressions pin the contract whether the
  // caller hits the list OR the recovery sub-route.
  it('?since= + includeHidden=true is STILL rejected — recovery does NOT bypass the removal (review-29 blocker)', async () => {
    supabaseMock.getSupabase.mockReturnValue(undefined); // no DB allowed
    const res = makeRes();
    await getCommitmentsHandler(
      makeReq({ since: RECOVERY_CURSOR, includeHidden: 'true' }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INCLUDE_HIDDEN_REMOVED' });
  });

  it('?since= + includeHidden=false is STILL rejected — the value does not matter', async () => {
    supabaseMock.getSupabase.mockReturnValue(undefined);
    const res = makeRes();
    await getCommitmentsHandler(
      makeReq({ since: RECOVERY_CURSOR, includeHidden: 'false' }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INCLUDE_HIDDEN_REMOVED' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Leak path 4 — GET /v1/stream/commitments (toBody = catch-up + live)
// ─────────────────────────────────────────────────────────────────────────
describe('Leak path 4 — GET /v1/stream/commitments (toBody)', () => {
  const toBody = STREAM_RESOURCES.commitments.toBody;

  it('visible row → full body (no regression)', () => {
    const body = toBody(visibleRow() as never);
    expect(body).toMatchObject({ signature: expect.any(String), nonce: '1', bookVisible: true });
    expect(body).not.toHaveProperty('redacted');
  });

  it('hidden row → allow-list projection', () => {
    const body = toBody(hiddenRow() as never);
    assertHiddenBody(body);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Leak path 5 — Chain via fills (commitmentHash leaks, /:hash must redact)
// ─────────────────────────────────────────────────────────────────────────
describe('Leak path 5 — chain via fills → /v1/commitments/:hash', () => {
  it('an attacker reading /v1/fills (commitmentHash leaked) cannot reconstruct a hidden body via /:hash', async () => {
    // /v1/fills carries commitmentHash by design — that part is public on chain.
    // The chain closes when /:hash redacts the hidden row instead of serving it.
    const hiddenHash = `0x${'c'.repeat(64)}`;
    const { client } = makeSupabase({ data: hiddenRow({ commitment_hash: hiddenHash }), error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentByHashHandler(makeReq({}, { hash: hiddenHash }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    assertHiddenBody(res.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// REDACT_HIDDEN_PUBLIC=false — rollback parity check
// (Short-lived; removed post-cutover per impl-plan §M7.)
// ─────────────────────────────────────────────────────────────────────────
describe('REDACT_HIDDEN_PUBLIC=false rollback', () => {
  beforeEach(() => {
    envMock.loadConfig.mockReturnValue({ network: 'polygon', chainId: 137, redactHiddenPublic: false });
  });

  it('/:hash hidden row → full body (legacy behavior)', async () => {
    const { client } = makeSupabase({ data: hiddenRow(), error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentByHashHandler(makeReq({}, { hash }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ signature: expect.any(String), nonce: '1' });
    expect(res.body).not.toHaveProperty('redacted');
  });

  it('recovery hidden row → full body (legacy behavior)', async () => {
    const cursor = RECOVERY_CURSOR;
    const { client } = makeSupabase({ data: [hiddenRow()], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ since: cursor }), res as unknown as Response);
    const body = res.body as { commitments: Array<Record<string, unknown>> };
    expect(body.commitments[0]).toHaveProperty('signature');
    expect(body.commitments[0]).not.toHaveProperty('redacted');
  });

  it('stream toBody hidden row → full body (legacy behavior)', () => {
    const body = STREAM_RESOURCES.commitments.toBody(hiddenRow() as never);
    expect(body).toMatchObject({ signature: expect.any(String), bookVisible: false });
    expect(body).not.toHaveProperty('redacted');
  });

  it('includeHidden=true is STILL rejected (the param removal is independent of the flag)', async () => {
    supabaseMock.getSupabase.mockReturnValue(undefined);
    const res = makeRes();
    await getCommitmentsHandler(makeReq({ includeHidden: 'true' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INCLUDE_HIDDEN_REMOVED' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Allow-list integrity — the constant itself
// ─────────────────────────────────────────────────────────────────────────
describe('PUBLIC_HIDDEN_ALLOWLIST integrity', () => {
  it('is frozen-shape — exactly the 12 documented fields', () => {
    expect([...PUBLIC_HIDDEN_ALLOWLIST].sort()).toEqual(
      [
        'commitmentHash',
        'maker',
        'contestId',
        'positionType',
        'status',
        'storedStatus',
        'filledRiskAmount',
        'expiry',
        'bookVisible',
        'nonceInvalidated',
        'redacted',
        'payloadAvailable',
      ].sort(),
    );
  });
});
