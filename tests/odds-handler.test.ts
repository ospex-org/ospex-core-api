/**
 * Handler-level tests for GET /v1/contests/:contestId/odds. Mocks
 * loadConfig + getSupabase so the test never touches a real network.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    network: 'polygon',
    chainId: 137,
    scorers: {
      moneyline: '0x1111111111111111111111111111111111111111',
      spread: '0x2222222222222222222222222222222222222222',
      total: '0x3333333333333333333333333333333333333333',
    },
  })),
}));

vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);

const { getCurrentOddsHandler } = await import('../src/v1/odds.js');

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

function makeReq(params: Record<string, string> = {}): Request {
  return { params, query: {} } as unknown as Request;
}

interface MockResponse {
  data: unknown;
  error: unknown;
  count?: number;
}

function makeSupabase(tables: Record<string, MockResponse | MockResponse[]>): {
  from: (table: string) => unknown;
} {
  const callCounts = new Map<string, number>();
  return {
    from(table: string): unknown {
      const responses = tables[table];
      const arr = Array.isArray(responses) ? responses : responses ? [responses] : [];
      const count = callCounts.get(table) ?? 0;
      callCounts.set(table, count + 1);
      const response: MockResponse = arr[Math.min(count, arr.length - 1)] ?? {
        data: null,
        error: null,
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        gt: () => builder,
        gte: () => builder,
        lte: () => builder,
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

describe('GET /v1/contests/:contestId/odds', () => {
  it('returns 400 when contestId is non-numeric', async () => {
    const res = makeRes();
    await getCurrentOddsHandler(makeReq({ contestId: 'abc' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('returns 404 when the contest does not exist', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: { data: null, error: null },
      }),
    );
    const res = makeRes();
    await getCurrentOddsHandler(makeReq({ contestId: '999' }), res as unknown as Response);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 200 with all-null markets when the contest has no jsonoddsId linkage', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: { data: { jsonodds_id: null }, error: null },
      }),
    );
    const res = makeRes();
    await getCurrentOddsHandler(makeReq({ contestId: '7' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      contestId: '7',
      jsonoddsId: null,
      odds: { moneyline: null, spread: null, total: null },
    });
  });

  it('returns 200 with all-null markets when current_odds has no rows for this game', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: { data: { jsonodds_id: 'jo-abc' }, error: null },
        current_odds: { data: [], error: null },
      }),
    );
    const res = makeRes();
    await getCurrentOddsHandler(makeReq({ contestId: '7' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      contestId: '7',
      jsonoddsId: 'jo-abc',
      odds: { moneyline: null, spread: null, total: null },
    });
  });

  it('returns 200 with all three markets populated when all three rows exist', async () => {
    const moneyline = {
      jsonodds_id: 'jo-abc',
      market: 'moneyline',
      line: null,
      away_odds_american: 145,
      home_odds_american: -180,
      upstream_last_updated: '2026-05-08T22:00:00Z',
      poll_captured_at: '2026-05-08T22:00:30Z',
      changed_at: '2026-05-08T22:00:30Z',
    };
    const spread = {
      jsonodds_id: 'jo-abc',
      market: 'spread',
      line: -3.5,
      away_odds_american: -110,
      home_odds_american: -110,
      upstream_last_updated: '2026-05-08T22:00:00Z',
      poll_captured_at: '2026-05-08T22:00:30Z',
      changed_at: '2026-05-08T22:00:30Z',
    };
    const total = {
      jsonodds_id: 'jo-abc',
      market: 'total',
      line: 8.5,
      away_odds_american: -105,
      home_odds_american: -115,
      upstream_last_updated: '2026-05-08T22:00:00Z',
      poll_captured_at: '2026-05-08T22:00:30Z',
      changed_at: '2026-05-08T22:00:30Z',
    };
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: { data: { jsonodds_id: 'jo-abc' }, error: null },
        current_odds: { data: [moneyline, spread, total], error: null },
      }),
    );
    const res = makeRes();
    await getCurrentOddsHandler(makeReq({ contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      contestId: string;
      jsonoddsId: string;
      odds: Record<string, unknown>;
    };
    expect(body.contestId).toBe('42');
    expect(body.jsonoddsId).toBe('jo-abc');
    expect(body.odds.moneyline).toMatchObject({
      jsonoddsId: 'jo-abc',
      market: 'moneyline',
      network: 'polygon',
      line: null,
      awayOddsAmerican: 145,
      homeOddsAmerican: -180,
    });
    expect(body.odds.spread).toMatchObject({
      market: 'spread',
      line: -3.5,
      awayOddsAmerican: -110,
      homeOddsAmerican: -110,
    });
    expect(body.odds.total).toMatchObject({
      market: 'total',
      line: 8.5,
      awayOddsAmerican: -105,
      homeOddsAmerican: -115,
    });
  });

  it('returns 200 with partial-market coverage (missing markets stay null)', async () => {
    const moneyline = {
      jsonodds_id: 'jo-abc',
      market: 'moneyline',
      line: null,
      away_odds_american: 200,
      home_odds_american: -250,
      upstream_last_updated: '2026-05-08T22:00:00Z',
      poll_captured_at: '2026-05-08T22:00:30Z',
      changed_at: '2026-05-08T22:00:30Z',
    };
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: { data: { jsonodds_id: 'jo-abc' }, error: null },
        current_odds: { data: [moneyline], error: null },
      }),
    );
    const res = makeRes();
    await getCurrentOddsHandler(makeReq({ contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { odds: Record<string, unknown> };
    expect(body.odds.moneyline).toMatchObject({ market: 'moneyline' });
    expect(body.odds.spread).toBeNull();
    expect(body.odds.total).toBeNull();
  });

  it('returns 500 when the contests query errors', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: { data: null, error: { message: 'db down' } },
      }),
    );
    const res = makeRes();
    await getCurrentOddsHandler(makeReq({ contestId: '7' }), res as unknown as Response);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('returns 500 when the current_odds query errors', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: { data: { jsonodds_id: 'jo-abc' }, error: null },
        current_odds: { data: null, error: { message: 'odds query failed' } },
      }),
    );
    const res = makeRes();
    await getCurrentOddsHandler(makeReq({ contestId: '7' }), res as unknown as Response);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('ignores unknown market values defensively (future market types)', async () => {
    const validMoneyline = {
      jsonodds_id: 'jo-abc',
      market: 'moneyline',
      line: null,
      away_odds_american: 100,
      home_odds_american: -120,
      upstream_last_updated: '2026-05-08T22:00:00Z',
      poll_captured_at: '2026-05-08T22:00:30Z',
      changed_at: '2026-05-08T22:00:30Z',
    };
    const futureMarket = {
      ...validMoneyline,
      market: 'futures', // hypothetical new market type
    };
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: { data: { jsonodds_id: 'jo-abc' }, error: null },
        current_odds: { data: [validMoneyline, futureMarket], error: null },
      }),
    );
    const res = makeRes();
    await getCurrentOddsHandler(makeReq({ contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { odds: Record<string, unknown> };
    expect(body.odds.moneyline).toMatchObject({ market: 'moneyline' });
    // Unknown market type should not appear in response or crash
    expect(body.odds).not.toHaveProperty('futures');
  });
});
