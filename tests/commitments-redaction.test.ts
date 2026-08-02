/**
 * Hidden-row redaction — public allow-list across every anonymous read.
 *
 * These are the public anonymous paths that can expose a commitment body:
 * `/v1/commitments/:hash`, `/v1/commitments?since=<cursor>` (recovery),
 * `/v1/commitments` default list (with `?includeHidden=true` now removed →
 * 400), and the SSE `/v1/stream/commitments` toBody (used by both catch-up
 * and live deltas).
 *
 * Allow-list (not deny-list) projection is the central guarantee. An upstream
 * column addition that isn't explicitly opted in MUST surface as a failed
 * exact-match assertion in this suite — that's the design.
 *
 * Two operating modes are covered:
 *   - `REDACT_HIDDEN_PUBLIC=true` (default): the redaction enforcement.
 *   - `REDACT_HIDDEN_PUBLIC=false`: the short-lived rollback path. Same paths
 *     return full bodies. Used only as a deploy-window safety valve; a
 *     follow-up removes the flag entirely once the rollout has soaked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { encodeCursor } from '../src/lib/cursor.js';

const NOW = Date.parse('2026-05-28T16:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const FUTURE = '2026-05-28T17:00:00.000Z';

// Scorer addresses for the contest/speculation orderbook-embed leak paths
// (getContestByIdHandler requires config.scorers). Kept in sync with the
// inlined copy in the hoisted env mock below.
const SCORERS = {
  moneyline: '0x1111111111111111111111111111111111111111',
  spread: '0x2222222222222222222222222222222222222222',
  total: '0x3333333333333333333333333333333333333333',
};

// A real recovery cursor — `parseRecovery` rejects anything else as 400.
const RECOVERY_CURSOR = encodeCursor({ t: 'commitments', s: NOW_ISO, i: '1', k: 'page' });

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    network: 'polygon',
    chainId: 137,
    redactHiddenPublic: true,
    scorers: {
      moneyline: '0x1111111111111111111111111111111111111111',
      spread: '0x2222222222222222222222222222222222222222',
      total: '0x3333333333333333333333333333333333333333',
    },
  })),
}));

const loggerMock = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);
vi.mock('../src/lib/logger.js', () => loggerMock);

const {
  getCommitmentByHashHandler,
  getCommitmentsHandler,
  fetchOpenCommitmentsByContestId,
  rowToHiddenAllowlistBody,
  PUBLIC_HIDDEN_ALLOWLIST,
} = await import('../src/v1/commitments.js');
const { STREAM_RESOURCES } = await import('../src/v1/stream/resources.js');
const { getContestByIdHandler } = await import('../src/v1/contests.js');
const { getSpeculationByIdHandler } = await import('../src/v1/speculations.js');
const { deriveSpeculationKey } = await import('../src/lib/eip712.js');

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
 * The deny-list assertion. These fields MUST NOT appear on a hidden public
 * body. The allow-list exact-match assertion implicitly catches all of these,
 * but the explicit deny-list call-out documents the threat-model fields and
 * makes a regression unambiguous if a future addition slips in.
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

// ── multi-query handler mock (keyed by table) ─────────────────────────────
// The flat `makeSupabase` above queues responses across ALL `.from()` calls;
// the contest/speculation detail handlers issue several queries against
// different tables, so they need per-table responses. Mirrors the harness in
// speculations-handlers.test.ts. Filters (`eq`/`in`/`gt`/…) are no-ops, so a
// hidden row passed here reaches the mapper AS IF the `book_visible=true`
// filter had failed — exactly the defense-in-depth case under test.
function makeSupabaseByTable(tables: Record<string, MockResponse | MockResponse[]>): {
  from: (table: string) => unknown;
} {
  const callCounts = new Map<string, number>();
  return {
    from(table: string): unknown {
      const responses = tables[table];
      const arr = Array.isArray(responses) ? responses : responses ? [responses] : [];
      const count = callCounts.get(table) ?? 0;
      callCounts.set(table, count + 1);
      const response: MockResponse = arr[Math.min(count, arr.length - 1)] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        gt: () => builder,
        gte: () => builder,
        lte: () => builder,
        or: () => builder,
        order: () => builder,
        range: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(response),
        single: () => Promise.resolve(response),
        then: (resolve: (v: unknown) => void) => resolve(response),
      };
      return builder;
    },
  };
}

// Full `ContestDetailRow` shape for getContestByIdHandler. `jsonodds_id: null`
// short-circuits the team-id resolve (no `games` query).
function contestDetailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contest_id: 42,
    jsonodds_id: null,
    rundown_id: null,
    sportspage_id: null,
    contest_creator: '0x4444444444444444444444444444444444444444',
    league_id: '1',
    verify_source_hash: null,
    market_update_source_hash: null,
    score_contest_source_hash: null,
    away_team: 'Away',
    home_team: 'Home',
    sport_slug: 'nba',
    jsonodds_sport_id: 2,
    start_time: FUTURE,
    // `contests_effective` view columns — no games row joined, so the game
    // side is null and LEAST() degrades to the chain value.
    effective_start_time: FUTURE,
    game_match_time: null,
    game_earliest_match_time: null,
    contest_status: 'verified',
    away_score: null,
    home_score: null,
    contest_created_at: null,
    verified_at: null,
    scored_at: null,
    voided_at: null,
    ...overrides,
  };
}
// Parent-contest context row for getSpeculationByIdHandler (jsonodds_id null →
// no games query).
function contestContextRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contest_id: 42,
    jsonodds_id: null,
    away_team: 'Away',
    home_team: 'Home',
    sport_slug: 'nba',
    start_time: FUTURE,
    effective_start_time: FUTURE,
    game_match_time: null,
    game_earliest_match_time: null,
    contest_status: 'verified',
    ...overrides,
  };
}
// A moneyline speculation row on contest 42 (line_ticks 0). Drives the
// speculationKey the orderbook groups on.
function specRowMoneyline(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    speculation_id: 100,
    contest_id: 42,
    speculation_scorer: SCORERS.moneyline,
    market_type: 'moneyline',
    line_ticks: 0,
    speculation_status: 'open',
    ...overrides,
  };
}

// Recursively collect every object key in a response tree.
function collectKeys(value: unknown, acc: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      collectKeys(v, acc);
    }
  }
}

// The hard security invariant: the full signed payload must not appear ANYWHERE
// in a response — neither the signature value nor any commitment-only matchable
// key. `lineTicks` is deliberately excluded: the Speculation wire type
// legitimately carries it (a hidden COMMITMENT body never does).
const COMMITMENT_SIGNED_KEYS = [
  'signature',
  'oddsTick',
  'riskAmount',
  'remainingRiskAmount',
  'speculationKey',
  'nonce',
  'marketType',
  'scorer',
] as const;
function assertNoSignedPayloadAnywhere(responseBody: unknown): void {
  // The fixture signature value (0x + 130 hex) must never appear in the wire.
  expect(JSON.stringify(responseBody)).not.toContain('9'.repeat(130));
  const keys = new Set<string>();
  collectKeys(responseBody, keys);
  for (const k of COMMITMENT_SIGNED_KEYS) {
    expect(keys.has(k), `response leaked a "${k}" field`).toBe(false);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  envMock.loadConfig.mockReturnValue({
    network: 'polygon',
    chainId: 137,
    redactHiddenPublic: true,
    scorers: SCORERS,
  });
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
  it('?since= + includeHidden=true is STILL rejected — recovery does NOT bypass the removal (review regression)', async () => {
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
// (Short-lived; removed once the redaction rollout has soaked.)
// ─────────────────────────────────────────────────────────────────────────
describe('REDACT_HIDDEN_PUBLIC=false rollback', () => {
  beforeEach(() => {
    // `scorers` included so the contest embed (which 500s without them) can be
    // exercised under the rollback flag too.
    envMock.loadConfig.mockReturnValue({ network: 'polygon', chainId: 137, redactHiddenPublic: false, scorers: SCORERS });
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

  it('speculation-detail orderbook hidden row → full body (legacy behavior; the new embed honors the flag)', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabaseByTable({
        speculations: { data: specRowMoneyline(), error: null },
        contests_effective: { data: contestContextRow(), error: null },
        commitments: { data: [hiddenRow()], error: null },
      }),
    );
    const res = makeRes();
    await getSpeculationByIdHandler(makeReq({}, { speculationId: '100' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { orderbook: Array<Record<string, unknown>> };
    expect(body.orderbook).toHaveLength(1);
    expect(body.orderbook[0]).toMatchObject({ signature: expect.any(String), bookVisible: false });
    expect(body.orderbook[0]).not.toHaveProperty('redacted');
  });

  it('contest-detail orderbook hidden row → full body grouped (legacy behavior; flag reverts the new embed too)', async () => {
    // Under rollback the hidden row is NOT redacted → it keeps its speculationKey
    // → it groups into the orderbook as a full body (the legacy "full body for all
    // rows" behavior the flag restores).
    const specKey = deriveSpeculationKey(42n, SCORERS.moneyline.toLowerCase(), 0);
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabaseByTable({
        contests_effective: { data: contestDetailRow(), error: null },
        speculations: { data: [specRowMoneyline()], error: null },
        commitments: { data: [hiddenRow({ speculation_key: specKey })], error: null },
      }),
    );
    const res = makeRes();
    await getContestByIdHandler(makeReq({}, { contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { speculations: Array<{ orderbook: Array<Record<string, unknown>> }> };
    expect(body.speculations[0]!.orderbook).toHaveLength(1);
    expect(body.speculations[0]!.orderbook[0]).toMatchObject({ signature: expect.any(String), bookVisible: false });
    expect(body.speculations[0]!.orderbook[0]).not.toHaveProperty('redacted');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F4 — the allow-list is the LOAD-BEARING runtime projection
// ─────────────────────────────────────────────────────────────────────────
describe('F4 — runtime allow-list projection (not just a CI assertion)', () => {
  it('projects a fully-signed hidden row down to EXACTLY the allow-list at runtime (drops signature + the whole matchable struct)', () => {
    // `hiddenRow()`'s FULL body would carry every signed/matchable field
    // (signature, nonce, oddsTick, riskAmount, lineTicks, scorer,
    // speculationKey, marketType). `rowToHiddenAllowlistBody` projects through
    // PUBLIC_HIDDEN_ALLOWLIST, so none of them can survive — the projection,
    // not a type wall, is the guarantee.
    const body = rowToHiddenAllowlistBody(hiddenRow() as never, NOW);
    // Asserted on the EMITTED body shape (keys === allow-list, deny-list gone),
    // not on the existence of the constant.
    assertHiddenBody(body);
  });

  it('the projection (pick), not the type, drops every off-allow-list field that IS present on the full candidate body', () => {
    // These are real `CommitmentBody` fields that `rowToBody` populates, so they
    // genuinely reach the candidate that `pick` projects — i.e. `pick` (not
    // `rowToBody` ignoring an unknown column) is what drops them. A hidden row
    // whose full body carries the entire signed/matchable struct must emerge
    // carrying none of it.
    const body = rowToHiddenAllowlistBody(
      hiddenRow({
        signature: `0x${'9'.repeat(130)}`,
        nonce: '42',
        odds_tick: 175,
        risk_amount: '7000000',
        line_ticks: 25,
        scorer: SCORERS.spread,
        speculation_key: `0x${'e'.repeat(64)}`,
        market_type: 'spread',
      }) as never,
      NOW,
    ) as Record<string, unknown>;
    // Emitted key set is EXACTLY the allow-list — every present off-list field dropped.
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_HIDDEN_ALLOWLIST].sort());
    // Spell out the high-value signed/matchable fields the candidate carried.
    for (const k of [
      'signature',
      'nonce',
      'oddsTick',
      'riskAmount',
      'remainingRiskAmount',
      'lineTicks',
      'scorer',
      'speculationKey',
      'marketType',
    ]) {
      expect(body, `pick failed to drop off-list field "${k}"`).not.toHaveProperty(k);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Leak path 6 — GET /v1/contests/:contestId orderbook embed
//           7 — GET /v1/speculations/:speculationId orderbook embed
//
// The two anonymous orderbook embeds used to map through the FULL-body
// `rowToBody`, bypassing the redaction router (single `book_visible=true`
// filter as the only guard). They now route through `commitmentRowToPublicBody`
// — defense-in-depth on top of the filter. These tests drive a hidden row past
// the (mocked-away) filter and assert no signed payload escapes.
// ─────────────────────────────────────────────────────────────────────────
describe('Leak path 6 — GET /v1/contests/:contestId orderbook embed', () => {
  it('fetchOpenCommitmentsByContestId redacts a hidden row that slips past book_visible=true', async () => {
    const { client } = makeSupabase({ data: [hiddenRow()], error: null });
    supabaseMock.getSupabase.mockReturnValue(client);
    const out = await fetchOpenCommitmentsByContestId('42', NOW);
    expect(out.error).toBeNull();
    expect(out.commitments).toHaveLength(1);
    assertHiddenBody(out.commitments![0]);
  });

  it('getContestByIdHandler: a hidden row reaching the orderbook is redacted + dropped — no signed payload in the response', async () => {
    // speculation_key matches the moneyline speculation, so a REGRESSION (full
    // body) would be grouped into that speculation's orderbook and leak. The
    // fixed path redacts (no speculationKey) → the row is dropped.
    const specKey = deriveSpeculationKey(42n, SCORERS.moneyline.toLowerCase(), 0);
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabaseByTable({
        contests_effective: { data: contestDetailRow(), error: null },
        speculations: { data: [specRowMoneyline()], error: null },
        commitments: { data: [hiddenRow({ speculation_key: specKey })], error: null },
      }),
    );
    const res = makeRes();
    await getContestByIdHandler(makeReq({}, { contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { speculations: Array<{ orderbook: unknown[] }> };
    expect(body.speculations.length).toBeGreaterThan(0);
    for (const s of body.speculations) expect(s.orderbook).toEqual([]);
    assertNoSignedPayloadAnywhere(res.body);
  });

  it('getContestByIdHandler: a MIX of visible + hidden rows — visible rows group (createdAt-sorted), the hidden one is dropped + warn-logged, never leaked', async () => {
    // The realistic defense-in-depth case: a mostly-visible orderbook with one
    // hidden row that slipped the filter. This pins the PER-ROW drop (a regression
    // to `break` would lose visible rows after the hidden one) AND the operational
    // warn signal. `created_at` ordering: visible2 (08:00) sorts before visible1 (09:00).
    const specKey = deriveSpeculationKey(42n, SCORERS.moneyline.toLowerCase(), 0);
    // The hidden row gets a DISTINCT signature sentinel so we can assert its
    // payload (and its hash) never appear — the two visible rows legitimately
    // carry the default `0x9…9` signature, so a blanket no-signature scan
    // wouldn't fit the mixed case.
    const HIDDEN_SIG = `0x${'7'.repeat(130)}`;
    const HIDDEN_HASH = `0x${'3'.repeat(64)}`;
    const visible1 = visibleRow({ commitment_hash: `0x${'1'.repeat(64)}`, speculation_key: specKey, created_at: '2026-05-28T09:00:00.000Z' });
    const visible2 = visibleRow({ commitment_hash: `0x${'2'.repeat(64)}`, speculation_key: specKey, created_at: '2026-05-28T08:00:00.000Z' });
    const hidden = hiddenRow({ commitment_hash: HIDDEN_HASH, speculation_key: specKey, signature: HIDDEN_SIG });
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabaseByTable({
        contests_effective: { data: contestDetailRow(), error: null },
        speculations: { data: [specRowMoneyline()], error: null },
        commitments: { data: [visible1, hidden, visible2], error: null },
      }),
    );
    const res = makeRes();
    await getContestByIdHandler(makeReq({}, { contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { speculations: Array<{ orderbook: Array<Record<string, unknown>> }> };
    const ob = body.speculations[0]!.orderbook;
    // Both visible rows survive the drop and group; hidden row is gone.
    expect(ob).toHaveLength(2);
    expect(ob[0]).toMatchObject({ commitmentHash: `0x${'2'.repeat(64)}`, signature: expect.any(String) }); // earlier created_at first
    expect(ob[1]).toMatchObject({ commitmentHash: `0x${'1'.repeat(64)}` });
    for (const e of ob) expect(e).not.toHaveProperty('redacted');
    // The hidden row's payload + hash never surface, and the drop emitted its warn.
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(HIDDEN_SIG);
    expect(json).not.toContain(HIDDEN_HASH);
    expect(loggerMock.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ commitmentHash: HIDDEN_HASH }),
      expect.stringContaining('redacted + dropped'),
    );
  });
});

describe('Leak path 7 — GET /v1/speculations/:speculationId orderbook embed', () => {
  it('getSpeculationByIdHandler: a hidden row reaching the orderbook surfaces REDACTED, never the full signed payload', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabaseByTable({
        speculations: { data: specRowMoneyline(), error: null },
        contests_effective: { data: contestContextRow(), error: null },
        commitments: { data: [hiddenRow()], error: null },
      }),
    );
    const res = makeRes();
    await getSpeculationByIdHandler(makeReq({}, { speculationId: '100' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { orderbook: unknown[] };
    expect(body.orderbook).toHaveLength(1);
    assertHiddenBody(body.orderbook[0]);
    assertNoSignedPayloadAnywhere(res.body);
  });

  it('getSpeculationByIdHandler: a VISIBLE row still renders the full body (no regression)', async () => {
    // speculation_key matches the derived key so the fixture is a true end-to-end
    // happy path (the mock's .eq() is a no-op, but keep it internally consistent).
    const specKey = deriveSpeculationKey(42n, SCORERS.moneyline.toLowerCase(), 0);
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabaseByTable({
        speculations: { data: specRowMoneyline(), error: null },
        contests_effective: { data: contestContextRow(), error: null },
        commitments: { data: [visibleRow({ speculation_key: specKey })], error: null },
      }),
    );
    const res = makeRes();
    await getSpeculationByIdHandler(makeReq({}, { speculationId: '100' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { orderbook: Array<Record<string, unknown>> };
    expect(body.orderbook).toHaveLength(1);
    expect(body.orderbook[0]).toMatchObject({ signature: expect.any(String), nonce: '1', bookVisible: true });
    expect(body.orderbook[0]).not.toHaveProperty('redacted');
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
