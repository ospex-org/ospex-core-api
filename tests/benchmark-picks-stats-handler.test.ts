/**
 * `GET /v1/benchmark/picks` and `GET /v1/benchmark/stats`, through the real
 * Supabase client against a fake PostgREST — same harness reasoning as
 * `benchmark-standings-handler.test.ts`.
 *
 * The two things a builder mock could not see are asserted on the captured
 * query string: that the reveal embed NAMES its foreign key (two constraints
 * join those tables; an unqualified embed is a hard `PGRST201`) and that it is
 * `!inner` (a sealed-but-unrevealed decision is embargoed, and a left embed
 * would publish it with a null body).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  applyFilters,
  expectReached,
  requestTo,
  startFakePostgrest,
  type CapturedRequest,
  type FakePostgrest,
} from './helpers/fakePostgrest.js';

const COHORT = 'watch-v0-2026-08-15';
const GAME_A = 'game-a';
const GAME_B = 'game-b';
const FABLE = 'anthropic-claude-fable-5';

const RUNS = [
  {
    run_id: 'run-1',
    network: 'polygon',
    cohort_id: COHORT,
    slate_date: '2026-08-15',
    benchmark_commit: 'a423bb27',
  },
];

const ATTEMPTS = [GAME_A, GAME_B].map((gameId, i) => ({
  id: i + 1,
  network: 'polygon',
  attempt_ordinal: 0,
  cohort_id: COHORT,
  participant_id: FABLE,
  game_id: gameId,
  supplied_markets: ['moneyline', 'spread', 'total'],
  outcome: 'valid',
}));

function game(id: string, hour: string): Record<string, unknown> {
  return {
    jsonodds_id: id,
    network: 'polygon',
    sport: 'mlb',
    slug: `slug-${id}`,
    match_time: `2026-08-15T${hour}:00:00+00:00`,
    earliest_match_time: null,
    rundown_match_time: null,
    sportspage_match_time: null,
    home_team_id: 'home-uuid',
    away_team_id: 'away-uuid',
    home_score: null,
    away_score: null,
    final_type: null,
  };
}

const GAMES = [game(GAME_B, '23'), game(GAME_A, '17')];

const PARTICIPANTS = [
  {
    participant_id: FABLE,
    kind: 'model',
    lab_id: 'anthropic',
    display_name: 'Claude Fable 5',
    model_id: 'claude-fable-5',
  },
  {
    participant_id: 'baseline-favorite-ml',
    kind: 'baseline',
    lab_id: null,
    display_name: 'Moneyline favorite',
    model_id: null,
  },
];

function decision(
  id: number,
  participant: string,
  gameId: string,
  market: string,
  reveal: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    id,
    network: 'polygon',
    cohort_id: COHORT,
    participant_id: participant,
    game_id: gameId,
    market,
    sealed_at: '2026-08-15T12:00:00+00:00',
    benchmark_decision_reveals: reveal,
  };
}

function reveal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revealed_at: '2026-08-15T12:01:00+00:00',
    selection: 'New York Yankees',
    line: null,
    observed_decimal: 1.8065,
    prob_win: 0.58,
    prob_push: null,
    prob_loss: 0.42,
    confidence: 0.4,
    would_abstain: false,
    selected_for_execution: true,
    primary_axis: 'consensus',
    primary_expectation: 'line moves toward us',
    axis_valuation: 4,
    axis_trend: 3,
    axis_consensus: 5,
    axis_news: 2,
    axis_softness: 4,
    ...over,
  };
}

const DECISIONS = [
  decision(1, FABLE, GAME_A, 'moneyline', reveal({ confidence: 0.4 })),
  // A SPREAD pick — recorded and scored, never counted in `pickCount`.
  decision(2, FABLE, GAME_A, 'spread', reveal({ confidence: 0.9, line: -1.5 })),
  decision(
    3,
    FABLE,
    GAME_A,
    'total',
    reveal({ confidence: 0.62, selection: 'under', line: 8.5, observed_decimal: 1.9091 }),
  ),
  // A baseline reveal — must not appear, and its null axes must not crash.
  decision(
    4,
    'baseline-favorite-ml',
    GAME_A,
    'moneyline',
    reveal({
      confidence: null,
      axis_valuation: null,
      axis_trend: null,
      axis_consensus: null,
      axis_news: null,
      axis_softness: null,
      primary_axis: null,
    }),
  ),
];

const STATS_ROW = {
  network: 'polygon',
  sport: 'all',
  as_of: '2026-08-24T00:00:00+00:00',
  available_commitments: 12,
  fills_last_24h: 4,
  matched_usdc_last_24h: 310.5,
};

interface Tables {
  [table: string]: unknown[];
}

const DEFAULT_TABLES: Tables = {
  benchmark_runs: RUNS,
  benchmark_arm_attempts: ATTEMPTS,
  games: GAMES,
  benchmark_participants: PARTICIPANTS,
  benchmark_decisions: DECISIONS,
  benchmark_execution_fills: [],
  benchmark_site_stats: [STATS_ROW],
  teams: [
    { id: 'home-uuid', name: 'Toronto Blue Jays', abbrev: 'TOR' },
    { id: 'away-uuid', name: 'New York Yankees', abbrev: 'NYY' },
  ],
};

const open: FakePostgrest[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
  vi.resetModules();
});

async function call(
  which: 'picks' | 'stats',
  tables: Tables = {},
  query: Record<string, string> = {},
  config: Record<string, unknown> = {},
  now = new Date('2026-08-15T18:00:00Z'),
): Promise<{ fake: FakePostgrest; body: Record<string, unknown>; status: number }> {
  const data: Tables = { ...DEFAULT_TABLES, ...tables };
  const seen = new Map<string, number>();
  const fake = await startFakePostgrest((req: CapturedRequest) => {
    const table = /^\/rest\/v1\/([^/?]+)/.exec(req.path)?.[1] ?? '';
    const n = seen.get(table) ?? 0;
    seen.set(table, n + 1);
    const offset = req.headers.range;
    if (typeof offset === 'string' && !offset.startsWith('0-')) return { body: [] };
    if (req.params.has('id') && String(req.params.get('id')).startsWith('gt.') && n > 0) {
      return { body: [] };
    }
    return { body: applyFilters(data[table] ?? [], req.params) };
  });
  open.push(fake);

  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.resetModules();
  vi.doMock('../src/lib/env.js', () => ({
    loadConfig: () => ({
      supabaseUrl: fake.url,
      supabaseServiceRoleKey: 'test-key',
      network: 'polygon',
      benchmarkPublicMinSlateDate: '2026-08-01',
      benchmarkStandingsWindowDays: 60,
      benchmarkStatsMaxAgeSeconds: 172_800,
      benchmarkHeadlineBasis: 'marginAdjusted.gameLevel',
      ...config,
    }),
  }));

  const mod =
    which === 'picks'
      ? await import('../src/v1/benchmark/picks.js')
      : await import('../src/v1/benchmark/stats.js');
  const handler =
    which === 'picks'
      ? (mod as { getBenchmarkPicksHandler: typeof import('../src/v1/benchmark/picks.js').getBenchmarkPicksHandler })
          .getBenchmarkPicksHandler
      : (mod as { getBenchmarkStatsHandler: typeof import('../src/v1/benchmark/stats.js').getBenchmarkStatsHandler })
          .getBenchmarkStatsHandler;

  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload as Record<string, unknown>;
      return this;
    },
  } as unknown as Response;

  await handler({ query, params: {} } as unknown as Request, res);
  vi.useRealTimers();
  return { fake, body, status };
}

interface WireGame {
  gameId: string;
  matchTime: string;
  pickCount: number;
  picks: Array<{
    market: string;
    selectionLabel: string | null;
    priceAmerican: number | null;
    axes: Record<string, number> | null;
    confidence: number | null;
    fill: unknown;
  }>;
}
const gamesOf = (body: Record<string, unknown>): WireGame[] => body.games as unknown as WireGame[];

describe('picks — the reveal embed', () => {
  it('names the foreign key and inner-joins it', async () => {
    const { fake } = await call('picks');
    expectReached(fake);
    const select = decodeURIComponent(requestTo(fake, 'benchmark_decisions')?.params.get('select') ?? '');
    expect(select).toContain('benchmark_decision_reveals!fk_benchmark_reveal_decision!inner(');
    // An unqualified embed is a hard PGRST201 against production; a left embed
    // would publish a sealed-but-unrevealed decision with a null body.
    expect(select).not.toMatch(/[^!]benchmark_decision_reveals\(/);
  });
});

describe('picks — the slate', () => {
  it('returns every game in the cohort, including one with no picks', async () => {
    const { body } = await call('picks');
    const games = gamesOf(body);
    expect(games.map((g) => g.gameId)).toEqual([GAME_A, GAME_B]);
    expect(games.find((g) => g.gameId === GAME_B)?.pickCount).toBe(0);
  });

  it('orders the slate by start time', async () => {
    const { body } = await call('picks');
    const times = gamesOf(body).map((g) => g.matchTime);
    expect([...times].sort()).toEqual(times);
  });

  /**
   * Ruling 2: the executed markets are moneyline and total; the run line is
   * measurement-only. Three revealed picks exist on GAME_A and only two count.
   * The spread pick is also the HIGHEST-confidence one (0.9), so a handler that
   * forgot the filter would additionally feature it.
   */
  it('excludes the run line from pickCount and from the feed', async () => {
    const { body } = await call('picks');
    const a = gamesOf(body).find((g) => g.gameId === GAME_A);
    expect(a?.pickCount).toBe(2);
    expect(a?.picks.map((p) => p.market).sort()).toEqual(['moneyline', 'total']);
  });

  it('serves model arms only', async () => {
    const { body } = await call('picks');
    const all = gamesOf(body).flatMap((g) => g.picks);
    expect(all).toHaveLength(2);
  });
});

describe('picks — the pick card fields', () => {
  it('converts the sealed decimal price to American, once, server-side', async () => {
    const { body } = await call('picks');
    const ml = gamesOf(body)
      .flatMap((g) => g.picks)
      .find((p) => p.market === 'moneyline');
    // 1.8065 → -100 / 0.8065 = -123.99…, rounded once.
    expect(ml?.priceAmerican).toBe(-124);
    expect(ml?.selectionLabel).toBe('New York Yankees -124');
  });

  /**
   * The boundary the two branches meet at. Decimal 2.0 is even money: +100 on
   * the American side. A `> 2` branch sends it to the negative formula and
   * prints -100 for the same price — the one input where the two candidate
   * implementations disagree, so a fixture anywhere else cannot separate them.
   */
  it('converts an even-money price at exactly 2.0 to +100', async () => {
    const { body } = await call('picks', {
      benchmark_decisions: [
        decision(1, FABLE, GAME_A, 'moneyline', reveal({ observed_decimal: 2 })),
      ],
    });
    const pick = gamesOf(body).flatMap((g) => g.picks)[0];
    expect(pick?.priceAmerican).toBe(100);
    expect(pick?.selectionLabel).toBe('New York Yankees +100');
  });

  it('refuses to convert a price at or below 1.0', async () => {
    const { body } = await call('picks', {
      benchmark_decisions: [
        decision(1, FABLE, GAME_A, 'moneyline', reveal({ observed_decimal: 1 })),
      ],
    });
    expect(gamesOf(body).flatMap((g) => g.picks)[0]?.priceAmerican).toBeNull();
  });

  it('labels a total by side and number', async () => {
    const { body } = await call('picks');
    const total = gamesOf(body)
      .flatMap((g) => g.picks)
      .find((p) => p.market === 'total');
    expect(total?.selectionLabel).toBe('Under 8.5');
  });

  /**
   * The stored axes are integers 1..5, not the 0..100 the radar recipe expects.
   * Both the raw value and the declared bounds ship; inferring the ceiling from
   * observed values would give softness (live max 4) a different scale from the
   * other four and tilt every polygon.
   */
  it('serves raw axis integers with their declared scale', async () => {
    const { body } = await call('picks');
    expect(body.axisScale).toEqual({ min: 1, max: 5 });
    const ml = gamesOf(body)
      .flatMap((g) => g.picks)
      .find((p) => p.market === 'moneyline');
    expect(ml?.axes).toEqual({ valuation: 4, trend: 3, consensus: 5, news: 2, softness: 4 });
  });

  it('serves null axes rather than a zeroed radar', async () => {
    const { body } = await call('picks', {
      benchmark_decisions: [
        decision(1, FABLE, GAME_A, 'moneyline', reveal({ axis_valuation: null, primary_axis: null })),
      ],
    });
    const pick = gamesOf(body).flatMap((g) => g.picks)[0];
    expect(pick?.axes).toBeNull();
  });

  it('carries no fill when none is published', async () => {
    const { body } = await call('picks');
    expect(gamesOf(body).flatMap((g) => g.picks).every((p) => p.fill === null)).toBe(true);
  });
});

describe('picks — the featured pick', () => {
  /**
   * Server-designated, because the front end must not choose the most
   * prominent number on the page. Highest confidence among EXECUTED-market
   * picks: the spread pick's 0.9 is higher and is correctly out of scope, so
   * the total's 0.62 wins over the moneyline's 0.4.
   */
  it('designates the highest-confidence executed-market pick', async () => {
    const { body } = await call('picks');
    expect(body.featuredPick).toMatchObject({ participantId: FABLE, decisionId: 3 });
    expect(body.featuredRule).toContain('highest confidence');
  });

  it('exposes a per-participant top pick a caller can look the leader up in', async () => {
    const { body } = await call('picks');
    expect(body.topPickByParticipant).toMatchObject({ [FABLE]: { gameId: GAME_A, decisionId: 3 } });
  });

  it('features nothing when no pick carries a confidence', async () => {
    const { body } = await call('picks', {
      benchmark_decisions: [decision(1, FABLE, GAME_A, 'moneyline', reveal({ confidence: null }))],
    });
    expect(body.featuredPick).toBeNull();
  });
});

describe('picks — the publication gate', () => {
  it('serves an empty slate and issues no query when unset', async () => {
    const { body, fake } = await call('picks', {}, {}, { benchmarkPublicMinSlateDate: undefined });
    expect(body.games).toEqual([]);
    expect(body.cohortId).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });
});

describe('stats', () => {
  it('serves the newest row for the requested sport', async () => {
    const { body, status } = await call('stats', {}, {}, {}, new Date('2026-08-24T06:00:00Z'));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      sport: 'all',
      stale: false,
      availableCommitments: 12,
      fillsLast24h: 4,
      matchedUsdcLast24h: 310.5,
    });
  });

  /**
   * The front-end labels say "last 24h" verbatim. A publisher that died on
   * Friday would otherwise render a three-day-old count under that label all
   * weekend — a false public statement about money with nothing looking wrong.
   */
  it('nulls the counters past the freshness bound but keeps the age', async () => {
    const { body } = await call('stats', {}, {}, {}, new Date('2026-08-28T00:00:00Z'));
    expect(body).toMatchObject({
      stale: true,
      availableCommitments: null,
      fillsLast24h: null,
      matchedUsdcLast24h: null,
      asOf: '2026-08-24T00:00:00+00:00',
    });
    expect(body.ageSeconds).toBeGreaterThan(172_800);
  });

  /**
   * Negative control for the pair above: a one-sided test passes on a handler
   * that always nulls, so the fresh case is asserted alongside — and the two
   * differ only in the clock.
   */
  it('is not always stale', async () => {
    const fresh = await call('stats', {}, {}, {}, new Date('2026-08-24T06:00:00Z'));
    const stale = await call('stats', {}, {}, {}, new Date('2026-08-28T00:00:00Z'));
    expect(fresh.body.stale).toBe(false);
    expect(stale.body.stale).toBe(true);
  });

  it('answers 200 with nulls when no row exists at all', async () => {
    const { body, status } = await call('stats', { benchmark_site_stats: [] });
    expect(status).toBe(200);
    expect(body).toMatchObject({ asOf: null, stale: true, availableCommitments: null });
  });

  it('defaults to the "all" sport, which is a real stored value', async () => {
    const { fake } = await call('stats');
    expect(decodeURIComponent(requestTo(fake, 'benchmark_site_stats')?.rawQuery ?? '')).toContain(
      'sport=eq.all',
    );
  });

  it('rejects an unknown sport', async () => {
    const { status } = await call('stats', {}, { sport: 'quidditch' });
    expect(status).toBe(400);
  });

  /**
   * THE PUBLICATION GATE, which this endpoint did not honour in the first cut.
   *
   * The README claimed all three endpoints serve nothing and issue no query
   * with the gate unset; `stats` queried and published anyway. A prose claim no
   * test enforced — and these counters are the most money-adjacent numbers the
   * projection serves. Found in review.
   *
   * `fake.requests` is the assertion that matters: an empty body alone would
   * also pass on a handler that read the row and then discarded it, which is a
   * materially weaker guarantee.
   */
  it('serves nothing and issues no query when the gate is unset', async () => {
    const { body, status, fake } = await call(
      'stats',
      {},
      {},
      { benchmarkPublicMinSlateDate: undefined },
    );
    expect(status).toBe(200);
    expect(fake.requests).toHaveLength(0);
    expect(body).toMatchObject({
      asOf: null,
      ageSeconds: null,
      stale: true,
      availableCommitments: null,
      fillsLast24h: null,
      matchedUsdcLast24h: null,
    });
  });

  /**
   * Negative control for the gate: with it SET, the very same fixture is read
   * and served. Without this the test above passes on a handler that never
   * queries anything.
   */
  it('does query once the gate is set', async () => {
    const { body, fake } = await call('stats', {}, {}, {}, new Date('2026-08-24T06:00:00Z'));
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(body.availableCommitments).toBe(12);
  });
});
