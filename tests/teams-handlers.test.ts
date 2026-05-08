/**
 * Handler-level tests for GET /v1/teams/aliases. Mocks getSupabase so
 * the test never touches a real network. Exercises:
 *   - happy path: rows are mapped through the teams!inner join into the
 *     flat alias shape (sport, sportId, teamName, abbrev surfaced).
 *   - sport filter: invalid sport => 400 INVALID_PARAM with the full
 *     supported list, including ncaaf.
 *   - pagination: limit/offset validation, hasMore signaling.
 *   - degraded: query error => 500 INTERNAL_ERROR.
 *   - defensive: rows whose join failed (team === null) are dropped.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
vi.mock('../src/lib/supabase.js', () => supabaseMock);

const { getTeamAliasesHandler } = await import('../src/v1/teams.js');

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
  return { query, params: {} } as unknown as Request;
}

interface MockResponse {
  data: unknown;
  error: unknown;
  count?: number;
}

function makeSupabase(response: MockResponse): { from: (table: string) => unknown } {
  return {
    from(_table: string): unknown {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        range: () => builder,
        then: (resolve: (v: unknown) => void) => resolve(response),
      };
      return builder;
    },
  };
}

describe('GET /v1/teams/aliases', () => {
  it('returns flattened alias rows joined to canonical team metadata', async () => {
    supabaseMock.getSupabase.mockReturnValueOnce(
      makeSupabase({
        data: [
          {
            team_id: 'team-uuid-1',
            alias: 'Lakers',
            alias_type: 'nickname',
            source: 'manual',
            team: {
              id: 'team-uuid-1',
              name: 'Los Angeles Lakers',
              abbrev: 'LAL',
              sport: 'nba',
              sport_id: 1,
            },
          },
          {
            team_id: 'team-uuid-1',
            alias: 'LAL',
            alias_type: 'abbrev',
            source: 'seed',
            team: {
              id: 'team-uuid-1',
              name: 'Los Angeles Lakers',
              abbrev: 'LAL',
              sport: 'nba',
              sport_id: 1,
            },
          },
        ],
        error: null,
        count: 2,
      }),
    );
    const res = makeRes();
    await getTeamAliasesHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      aliases: [
        {
          teamId: 'team-uuid-1',
          sport: 'nba',
          sportId: 1,
          teamName: 'Los Angeles Lakers',
          abbrev: 'LAL',
          alias: 'Lakers',
          aliasType: 'nickname',
          source: 'manual',
        },
        {
          teamId: 'team-uuid-1',
          sport: 'nba',
          sportId: 1,
          teamName: 'Los Angeles Lakers',
          abbrev: 'LAL',
          alias: 'LAL',
          aliasType: 'abbrev',
          source: 'seed',
        },
      ],
      pagination: { limit: 2000, offset: 0, total: 2, hasMore: false },
    });
  });

  it('drops rows whose teams join failed (team === null)', async () => {
    supabaseMock.getSupabase.mockReturnValueOnce(
      makeSupabase({
        data: [
          { team_id: 't1', alias: 'a1', alias_type: 'abbrev', source: 'seed', team: null },
          {
            team_id: 't2',
            alias: 'a2',
            alias_type: 'nickname',
            source: 'manual',
            team: { id: 't2', name: 'Team Two', abbrev: 'TT2', sport: 'mlb', sport_id: 0 },
          },
        ],
        error: null,
        count: 2,
      }),
    );
    const res = makeRes();
    await getTeamAliasesHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { aliases: { alias: string }[] };
    expect(body.aliases).toHaveLength(1);
    expect(body.aliases[0]?.alias).toBe('a2');
  });

  it('rejects invalid sport with 400 INVALID_PARAM and lists ncaaf', async () => {
    const res = makeRes();
    await getTeamAliasesHandler(makeReq({ sport: 'foo' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
    const err = res.body as { error: string };
    expect(err.error).toContain('ncaaf');
    expect(err.error).toContain('mlb');
    expect(err.error).toContain('nba');
    expect(err.error).toContain('ncaab');
    expect(err.error).toContain('nfl');
    expect(err.error).toContain('nhl');
  });

  it('accepts ncaaf as a valid sport (anti-staleness check)', async () => {
    supabaseMock.getSupabase.mockReturnValueOnce(
      makeSupabase({ data: [], error: null, count: 0 }),
    );
    const res = makeRes();
    await getTeamAliasesHandler(makeReq({ sport: 'ncaaf' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ aliases: [], pagination: { total: 0, hasMore: false } });
  });

  it('rejects non-integer / out-of-range limit', async () => {
    const res1 = makeRes();
    await getTeamAliasesHandler(makeReq({ limit: '0' }), res1 as unknown as Response);
    expect(res1.statusCode).toBe(400);
    expect(res1.body).toMatchObject({ code: 'INVALID_PARAM' });

    const res2 = makeRes();
    await getTeamAliasesHandler(makeReq({ limit: '999999' }), res2 as unknown as Response);
    expect(res2.statusCode).toBe(400);

    const res3 = makeRes();
    await getTeamAliasesHandler(makeReq({ limit: '1.5' }), res3 as unknown as Response);
    expect(res3.statusCode).toBe(400);
  });

  it('rejects negative offset', async () => {
    const res = makeRes();
    await getTeamAliasesHandler(makeReq({ offset: '-1' }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('signals hasMore=true when offset+returned < total', async () => {
    supabaseMock.getSupabase.mockReturnValueOnce(
      makeSupabase({
        data: [
          {
            team_id: 't1',
            alias: 'a',
            alias_type: 'abbrev',
            source: 'seed',
            team: { id: 't1', name: 'T One', abbrev: 'T1', sport: 'mlb', sport_id: 0 },
          },
        ],
        error: null,
        count: 5,
      }),
    );
    const res = makeRes();
    await getTeamAliasesHandler(makeReq({ limit: '1' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      pagination: { limit: 1, offset: 0, total: 5, hasMore: true },
    });
  });

  it('returns 500 INTERNAL_ERROR on supabase error', async () => {
    supabaseMock.getSupabase.mockReturnValueOnce(
      makeSupabase({ data: null, error: { message: 'boom' } }),
    );
    const res = makeRes();
    await getTeamAliasesHandler(makeReq(), res as unknown as Response);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
