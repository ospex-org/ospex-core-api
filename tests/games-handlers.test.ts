/**
 * Handler-level tests for the /v1/games endpoints. Mocks loadConfig +
 * getSupabase so the test never touches a real network. Focus: the
 * probablePitchers passthrough (advisory MLB starters) — present on every
 * game row, values passed through when set, nulls when unset/absent.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ network: 'polygon', chainId: 137 })),
}));

vi.mock('../src/lib/supabase.js', () => supabaseMock);
vi.mock('../src/lib/env.js', () => envMock);

const { getGamesHandler, getGameByIdHandler } = await import('../src/v1/games.js');

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
        not: () => builder,
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

const GAME_DB_ROW = {
  network: 'polygon',
  jsonodds_id: '11111111-2222-3333-4444-555555555555',
  sportspage_id: 'sp-1',
  rundown_id: 'rd-1',
  sport: 'mlb',
  match_time: '2026-07-17T23:10:00+00:00',
  status: 'upcoming',
  home_team_id: 'team-home',
  away_team_id: 'team-away',
  has_odds: true,
  contest_created: false,
  contest_id: null,
  slug: 'nym-phi-2026-07-17',
};

const TEAMS_RESPONSE = {
  data: [
    { id: 'team-home', name: 'Philadelphia Phillies', abbrev: 'PHI' },
    { id: 'team-away', name: 'New York Mets', abbrev: 'NYM' },
  ],
  error: null,
};

describe('GET /v1/games/:gameId — probablePitchers', () => {
  it('passes announced starters through as probablePitchers.{home,away}', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        games: {
          data: {
            ...GAME_DB_ROW,
            home_probable_pitcher: 'Z. Wheeler',
            away_probable_pitcher: 'K. Senga',
          },
          error: null,
        },
        teams: TEAMS_RESPONSE,
      }),
    );
    const res = makeRes();
    await getGameByIdHandler(
      makeReq({}, { gameId: GAME_DB_ROW.jsonodds_id }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      gameId: GAME_DB_ROW.jsonodds_id,
      probablePitchers: { home: 'Z. Wheeler', away: 'K. Senga' },
    });
  });

  it('maps unannounced / non-MLB (null columns) to explicit nulls', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        games: {
          data: {
            ...GAME_DB_ROW,
            home_probable_pitcher: null,
            away_probable_pitcher: null,
          },
          error: null,
        },
        teams: TEAMS_RESPONSE,
      }),
    );
    const res = makeRes();
    await getGameByIdHandler(
      makeReq({}, { gameId: GAME_DB_ROW.jsonodds_id }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ probablePitchers: { home: null, away: null } });
  });

  it('shapes probablePitchers to nulls even when the columns are absent from the row', async () => {
    // Defensive: a row shape predating the columns (or a stale schema
    // cache) must not produce an undefined field on the wire.
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        games: { data: { ...GAME_DB_ROW }, error: null },
        teams: TEAMS_RESPONSE,
      }),
    );
    const res = makeRes();
    await getGameByIdHandler(
      makeReq({}, { gameId: GAME_DB_ROW.jsonodds_id }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { probablePitchers: { home: string | null; away: string | null } };
    expect(body.probablePitchers).toEqual({ home: null, away: null });
  });
});

describe('GET /v1/games — probablePitchers on the list view', () => {
  it('includes probablePitchers on every row, mixed announced/unannounced', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        games: {
          data: [
            {
              ...GAME_DB_ROW,
              home_probable_pitcher: 'Z. Wheeler',
              away_probable_pitcher: null,
            },
            {
              ...GAME_DB_ROW,
              jsonodds_id: '66666666-7777-8888-9999-000000000000',
              slug: 'bos-nyy-2026-07-17',
              home_probable_pitcher: null,
              away_probable_pitcher: null,
            },
          ],
          error: null,
          count: 2,
        },
        teams: TEAMS_RESPONSE,
      }),
    );
    const res = makeRes();
    await getGamesHandler(makeReq({ sport: 'mlb' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { games: Array<{ probablePitchers: unknown }> };
    expect(body.games).toHaveLength(2);
    expect(body.games[0]?.probablePitchers).toEqual({ home: 'Z. Wheeler', away: null });
    expect(body.games[1]?.probablePitchers).toEqual({ home: null, away: null });
  });
});
