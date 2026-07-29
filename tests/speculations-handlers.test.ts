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

describe('GET /v1/speculations — closing-line enrichment', () => {
  const SPECS = [
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
      line_ticks: 35, // line 3.5
      speculation_status: 'open',
    },
    {
      speculation_id: 102,
      contest_id: 42,
      speculation_scorer: SCORERS.total,
      market_type: 'total',
      line_ticks: 85, // line 8.5
      speculation_status: 'open',
    },
  ];

  interface WireClosing {
    speculationId: string;
    type: string;
    closing?: { awayDecimal: number | null; homeDecimal: number | null; line: number | null; estimated: boolean };
  }

  async function run(closingRows: unknown): Promise<WireClosing[]> {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        speculations: { data: SPECS, error: null, count: SPECS.length },
        contests: { data: [{ contest_id: 42, jsonodds_id: 'JID' }], error: null },
        closing_lines: closingRows,
      }),
    );
    const res = makeRes();
    await getSpeculationsHandler(makeReq({ contestId: '42' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    return (res.body as { speculations: WireClosing[] }).speculations;
  }

  it('attaches both no-vig decimals for moneyline (no line to resolve)', async () => {
    const specs = await run({
      data: [{ jsonodds_id: 'JID', market: 'moneyline', line: null, away_p_novig: 0.5, home_p_novig: 0.5 }],
      error: null,
    });
    const ml = specs.find((s) => s.type === 'moneyline');
    expect(ml?.closing).toEqual({ awayDecimal: 2, homeDecimal: 2, line: null, estimated: false });
  });

  it('attaches decimals for a spread whose line matches the close', async () => {
    const specs = await run({
      data: [{ jsonodds_id: 'JID', market: 'spread', line: 3.5, away_p_novig: 0.4, home_p_novig: 0.6 }],
      error: null,
    });
    const spread = specs.find((s) => s.type === 'spread');
    // 1/0.4 = 2.5 ; 1/0.6 = 1.66667 (5dp)
    expect(spread?.closing).toEqual({ awayDecimal: 2.5, homeDecimal: 1.66667, line: 3.5, estimated: false });
  });

  it('nulls the decimals when the total line moved off the speculation line', async () => {
    const specs = await run({
      // speculation line 8.5, market closed at 9.0 → half-run move → not price-resolvable
      data: [{ jsonodds_id: 'JID', market: 'total', line: 9.0, away_p_novig: 0.5, home_p_novig: 0.5 }],
      error: null,
    });
    const total = specs.find((s) => s.type === 'total');
    expect(total?.closing).toEqual({ awayDecimal: null, homeDecimal: null, line: 9, estimated: false });
  });

  it('leaves closing absent when no fresh closing line exists', async () => {
    const specs = await run({ data: [], error: null });
    for (const s of specs) expect(s.closing).toBeUndefined();
  });

  it('degrades to unenriched (no throw) when the closing_lines fetch errors', async () => {
    const specs = await run({ data: null, error: { message: 'boom' } });
    expect(specs).toHaveLength(3);
    for (const s of specs) expect(s.closing).toBeUndefined();
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
        contests_effective: {
          data: {
            contest_id: 42,
            jsonodds_id: null,
            away_team: 'Lakers',
            home_team: 'Celtics',
            sport_slug: 'nba',
            start_time: '2026-05-04T01:00:00Z',
            // No jsonodds_id → no games row joined by the view, so the game
            // side is null and LEAST() degrades to the chain value.
            effective_start_time: '2026-05-04T01:00:00Z',
            game_match_time: null,
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
        // team_ids are null when jsonodds_id is null (no games linkage
        // to resolve through). SDK falls back to exact + nickname matching.
        awayTeamId: null,
        homeTeamId: null,
        sport: 'nba',
        // With no game side, all three time fields degrade to the chain value
        // (gameMatchTime to the `''` sentinel, never to epoch).
        matchTime: '2026-05-04T01:00:00Z',
        chainStartTime: '2026-05-04T01:00:00Z',
        gameMatchTime: '',
        status: 'verified',
      },
    });
  });

  it('surfaces the settled outcome (winSide/settledAt/voided) on a closed speculation', async () => {
    supabaseMock.getSupabase.mockReturnValue(
      makeSupabase({
        speculations: {
          data: {
            speculation_id: 2,
            contest_id: 2,
            speculation_scorer: SCORERS.moneyline,
            market_type: 'moneyline',
            line_ticks: 0,
            speculation_status: 'closed',
            win_side: 'away',
            settled_at: '2026-07-01T04:00:14+00:00',
            voided: false,
          },
          error: null,
        },
        contests_effective: {
          data: {
            contest_id: 2,
            jsonodds_id: null,
            away_team: 'Chicago White Sox',
            home_team: 'Baltimore Orioles',
            sport_slug: 'mlb',
            start_time: '2026-06-30T22:35:00Z',
            effective_start_time: '2026-06-30T22:35:00Z',
            game_match_time: null,
            contest_status: 'scored',
          },
          error: null,
        },
        commitments: { data: [], error: null },
      }),
    );

    const res = makeRes();
    await getSpeculationByIdHandler(makeReq({}, { speculationId: '2' }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      speculationId: '2',
      speculationStatus: 1,
      winSide: 'away',
      settledAt: '2026-07-01T04:00:14+00:00',
      voided: false,
    });
  });

  it('populates team_ids and serves the EARLIER of chain/game start when the games row is present', async () => {
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
        contests_effective: {
          data: {
            contest_id: 42,
            jsonodds_id: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
            away_team: 'Lakers',
            home_team: 'Celtics',
            sport_slug: 'nba',
            // Mode A: the game moved 50 minutes EARLIER than the frozen
            // on-chain start, so the view's LEAST() picks the game side.
            start_time: '2026-05-04T01:00:00Z',
            effective_start_time: '2026-05-04T00:10:00Z',
            game_match_time: '2026-05-04T00:10:00Z',
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
      contest: {
        awayTeamId: string | null;
        homeTeamId: string | null;
        matchTime: string;
        chainStartTime: string;
        gameMatchTime: string;
      };
    };
    expect(body.contest.awayTeamId).toBe('lakers-uuid');
    expect(body.contest.homeTeamId).toBe('celtics-uuid');
    // Goes RED if `matchTime` reverts to serving the raw chain `start_time`.
    expect(body.contest.matchTime).toBe('2026-05-04T00:10:00Z');
    expect(body.contest.matchTime).not.toBe('2026-05-04T01:00:00Z');
    expect(body.contest.chainStartTime).toBe('2026-05-04T01:00:00Z');
    expect(body.contest.gameMatchTime).toBe('2026-05-04T00:10:00Z');
  });
});
