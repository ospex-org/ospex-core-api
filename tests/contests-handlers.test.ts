/**
 * Handler-level tests for the /v1/contests/* endpoints. Mocks
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

const { getContestsHandler, getContestByIdHandler } = await import('../src/v1/contests.js');

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

/**
 * Per-table response queue. Each `.from(table)` call pops the next
 * response for that table — lets a single test set up multiple
 * sequential queries against the same table (e.g. /v1/contests/:id
 * queries `commitments` once via the helper).
 */
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

describe('GET /v1/contests', () => {
  it('returns 400 for an unknown sport', async () => {
    const res = makeRes();
    await getContestsHandler(makeReq({ sport: 'soccer' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('returns 400 for an out-of-range window', async () => {
    const res = makeRes();
    await getContestsHandler(makeReq({ window: '999' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with embedded speculations grouped per contest', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: {
          data: [
            {
              contest_id: 42,
              away_team: 'Lakers',
              home_team: 'Celtics',
              sport_slug: 'nba',
              jsonodds_sport_id: 1,
              start_time: '2026-05-04T01:00:00Z',
              contest_status: 'verified',
            },
          ],
          error: null,
          count: 1,
        },
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
              line_ticks: -35,
              speculation_status: 'open',
            },
          ],
          error: null,
        },
      }),
    );

    const res = makeRes();
    await getContestsHandler(makeReq({ sport: 'nba', limit: '10' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      contests: Array<{ contestId: string; speculations: Array<{ type: string; awayLine?: number }> }>;
    };
    expect(body.contests).toHaveLength(1);
    expect(body.contests[0]!.contestId).toBe('42');
    expect(body.contests[0]!.speculations).toHaveLength(2);
    const spread = body.contests[0]!.speculations.find((s) => s.type === 'spread');
    expect(spread?.awayLine).toBe(-3.5);
  });
});

describe('GET /v1/contests/:contestId', () => {
  it('returns 400 INVALID_PARAM for a non-numeric id', async () => {
    const res = makeRes();
    await getContestByIdHandler(makeReq({}, { contestId: 'abc' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('returns 404 NOT_FOUND when the contest row does not exist', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: { data: null, error: null },
      }),
    );

    const res = makeRes();
    await getContestByIdHandler(makeReq({}, { contestId: '999' }), res as unknown as Response);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 200 with the contest detail block + speculations[].orderbook populated', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: {
          data: {
            contest_id: 42,
            jsonodds_id: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
            rundown_id: 'r1',
            sportspage_id: 's1',
            contest_creator: '0x' + '00'.repeat(20),
            league_id: 'nba',
            verify_source_hash: '0x' + 'aa'.repeat(32),
            market_update_source_hash: '0x' + 'bb'.repeat(32),
            score_contest_source_hash: '0x' + 'cc'.repeat(32),
            away_team: 'Lakers',
            home_team: 'Celtics',
            sport_slug: 'nba',
            jsonodds_sport_id: 1,
            start_time: '2026-05-04T01:00:00Z',
            contest_status: 'verified',
            away_score: null,
            home_score: null,
            contest_created_at: '2026-05-01T00:00:00Z',
            verified_at: '2026-05-01T00:01:00Z',
            scored_at: null,
            voided_at: null,
          },
          error: null,
        },
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
          ],
          error: null,
        },
        // The orderbook helper queries `commitments` once.
        commitments: {
          data: [],
          error: null,
        },
      }),
    );

    const res = makeRes();
    await getContestByIdHandler(makeReq({}, { contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      contestId: string;
      jsonoddsId: string | null;
      awayTeamId: string | null;
      homeTeamId: string | null;
      speculations: Array<{ speculationId: string; contestId: string; orderbook: unknown[] }>;
    };
    expect(body.contestId).toBe('42');
    expect(body.jsonoddsId).toBe('a783e37e-4ce1-4f42-9dd6-615568f73044');
    // No games row mocked → team_ids degrade to null. PR 0 widening
    // is present in the response shape, just empty.
    expect(body.awayTeamId).toBeNull();
    expect(body.homeTeamId).toBeNull();
    expect(body.speculations).toHaveLength(1);
    expect(body.speculations[0]!.speculationId).toBe('100');
    expect(body.speculations[0]!.contestId).toBe('42');
    expect(body.speculations[0]!.orderbook).toEqual([]);
  });

  it('populates awayTeamId / homeTeamId when the games row is present', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: {
          data: {
            contest_id: 42,
            jsonodds_id: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
            rundown_id: 'r1',
            sportspage_id: 's1',
            contest_creator: '0x' + '00'.repeat(20),
            league_id: 'nba',
            verify_source_hash: '0x' + 'aa'.repeat(32),
            market_update_source_hash: '0x' + 'bb'.repeat(32),
            score_contest_source_hash: '0x' + 'cc'.repeat(32),
            away_team: 'Lakers',
            home_team: 'Celtics',
            sport_slug: 'nba',
            jsonodds_sport_id: 1,
            start_time: '2026-05-04T01:00:00Z',
            contest_status: 'verified',
            away_score: null,
            home_score: null,
            contest_created_at: '2026-05-01T00:00:00Z',
            verified_at: '2026-05-01T00:01:00Z',
            scored_at: null,
            voided_at: null,
          },
          error: null,
        },
        speculations: { data: [], error: null },
        commitments: { data: [], error: null },
        games: {
          data: {
            away_team_id: 'lakers-uuid',
            home_team_id: 'celtics-uuid',
          },
          error: null,
        },
      }),
    );

    const res = makeRes();
    await getContestByIdHandler(makeReq({}, { contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { awayTeamId: string | null; homeTeamId: string | null };
    expect(body.awayTeamId).toBe('lakers-uuid');
    expect(body.homeTeamId).toBe('celtics-uuid');
  });

  it('degrades awayTeamId / homeTeamId to null on games-side errors', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        contests: {
          data: {
            contest_id: 42,
            jsonodds_id: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
            rundown_id: null,
            sportspage_id: null,
            contest_creator: '0x' + '00'.repeat(20),
            league_id: 'nba',
            verify_source_hash: null,
            market_update_source_hash: null,
            score_contest_source_hash: null,
            away_team: 'Lakers',
            home_team: 'Celtics',
            sport_slug: 'nba',
            jsonodds_sport_id: 1,
            start_time: '2026-05-04T01:00:00Z',
            contest_status: 'verified',
            away_score: null,
            home_score: null,
            contest_created_at: null,
            verified_at: null,
            scored_at: null,
            voided_at: null,
          },
          error: null,
        },
        speculations: { data: [], error: null },
        commitments: { data: [], error: null },
        games: { data: null, error: { message: 'connection reset' } },
      }),
    );

    const res = makeRes();
    await getContestByIdHandler(makeReq({}, { contestId: '42' }), res as unknown as Response);
    // Parent endpoint succeeds; team_ids degrade to null. Trust model:
    // the SDK falls back to exact + nickname matching when team_ids
    // are null. The contest detail itself is not blocked on the
    // games-side enrichment.
    expect(res.statusCode).toBe(200);
    const body = res.body as { awayTeamId: string | null; homeTeamId: string | null };
    expect(body.awayTeamId).toBeNull();
    expect(body.homeTeamId).toBeNull();
  });
});
