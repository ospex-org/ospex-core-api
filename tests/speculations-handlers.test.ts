/**
 * Handler-level tests for the /v1/speculations/* endpoints. Mocks
 * loadConfig + getSupabase so the test never touches a real network.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const SCORERS = {
  moneyline: '0x1111111111111111111111111111111111111111',
  spread: '0x2222222222222222222222222222222222222222',
  total: '0x3333333333333333333333333333333333333333',
};

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

const { getSpeculationByIdHandler, getSpeculationsHandler } = await import(
  '../src/v1/speculations.js'
);

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

describe('GET /v1/speculations', () => {
  it('returns 400 for an invalid contestId', async () => {
    const res = makeRes();
    await getSpeculationsHandler(makeReq({ contestId: '-5' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('returns 400 for an unknown sport', async () => {
    const res = makeRes();
    await getSpeculationsHandler(makeReq({ sport: 'cricket' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an invalid status', async () => {
    const res = makeRes();
    await getSpeculationsHandler(makeReq({ status: 'maybe' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with rows scoped to a contestId filter', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        speculations: {
          data: [
            {
              speculation_id: 100,
              contest_id: 42,
              speculation_scorer: SCORERS.moneyline,
              market_type: 'moneyline',
              line_ticks: 0,
              speculation_status: 'open',
            },
            {
              speculation_id: 101,
              contest_id: 42,
              speculation_scorer: SCORERS.spread,
              market_type: 'spread',
              line_ticks: 35,
              speculation_status: 'open',
            },
          ],
          error: null,
          count: 2,
        },
      }),
    );

    const res = makeRes();
    await getSpeculationsHandler(makeReq({ contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      speculations: Array<{ speculationId: string; contestId: string; type: string; awayLine?: number }>;
      pagination: { total: number };
    };
    expect(body.speculations).toHaveLength(2);
    expect(body.speculations[0]!.contestId).toBe('42');
    const spread = body.speculations.find((s) => s.type === 'spread');
    expect(spread?.awayLine).toBe(3.5);
    expect(body.pagination.total).toBe(2);
  });

  it('short-circuits to empty when --sport matches no contests', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: { data: [], error: null },
      }),
    );

    const res = makeRes();
    await getSpeculationsHandler(makeReq({ sport: 'nba' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { speculations: unknown[]; pagination: { total: number } };
    expect(body.speculations).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });
});

describe('GET /v1/speculations/:speculationId', () => {
  it('returns 400 INVALID_PARAM for a non-numeric id', async () => {
    const res = makeRes();
    await getSpeculationByIdHandler(makeReq({}, { speculationId: 'xyz' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('returns 404 when the speculation row does not exist', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        speculations: { data: null, error: null },
      }),
    );

    const res = makeRes();
    await getSpeculationByIdHandler(makeReq({}, { speculationId: '999' }), res as unknown as Response);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 200 with the speculation, parent contest context (team_ids null when no game linkage), and orderbook', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        speculations: {
          data: {
            speculation_id: 100,
            contest_id: 42,
            speculation_scorer: SCORERS.moneyline,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'open',
          },
          error: null,
        },
        contests: {
          data: {
            contest_id: 42,
            jsonodds_id: null,
            away_team: 'Lakers',
            home_team: 'Celtics',
            sport_slug: 'nba',
            start_time: '2026-05-04T01:00:00Z',
            contest_status: 'verified',
          },
          error: null,
        },
        commitments: {
          data: [],
          error: null,
        },
      }),
    );

    const res = makeRes();
    await getSpeculationByIdHandler(makeReq({}, { speculationId: '100' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      speculationId: '100',
      contestId: '42',
      type: 'moneyline',
      orderbook: [],
      contest: {
        contestId: '42',
        awayTeam: 'Lakers',
        homeTeam: 'Celtics',
        // PR 0 widening: team_ids are null when jsonodds_id is null
        // (no games linkage to resolve through). SDK falls back to
        // exact + nickname matching.
        awayTeamId: null,
        homeTeamId: null,
        sport: 'nba',
        matchTime: '2026-05-04T01:00:00Z',
        status: 'verified',
      },
    });
  });

  it('populates team_ids on the parent contest context when the games row is present', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        speculations: {
          data: {
            speculation_id: 100,
            contest_id: 42,
            speculation_scorer: SCORERS.moneyline,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'open',
          },
          error: null,
        },
        contests: {
          data: {
            contest_id: 42,
            jsonodds_id: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
            away_team: 'Lakers',
            home_team: 'Celtics',
            sport_slug: 'nba',
            start_time: '2026-05-04T01:00:00Z',
            contest_status: 'verified',
          },
          error: null,
        },
        games: {
          data: { away_team_id: 'lakers-uuid', home_team_id: 'celtics-uuid' },
          error: null,
        },
        commitments: { data: [], error: null },
      }),
    );

    const res = makeRes();
    await getSpeculationByIdHandler(makeReq({}, { speculationId: '100' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      contest: { awayTeamId: string | null; homeTeamId: string | null };
    };
    expect(body.contest.awayTeamId).toBe('lakers-uuid');
    expect(body.contest.homeTeamId).toBe('celtics-uuid');
  });
});
