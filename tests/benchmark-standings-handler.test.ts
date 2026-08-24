/**
 * `GET /v1/benchmark/standings`, driven through the REAL `@supabase/supabase-js`
 * client against a fake PostgREST on a real socket.
 *
 * Every other handler test in this repo hands `getSupabase()` a chainable stub,
 * which returns the fixture no matter what string reached `.select()`. That
 * cannot see the two things most likely to be wrong here — whether the embeds
 * are `!inner`, and whether the reveal embed names its foreign key — so these
 * assert the captured query STRING, on the far side of the client.
 *
 * The centrepiece is the work order's own acceptance case, run end to end:
 * Claude Fable 5 on run `watch-v0-2026-08-15-0b0658` must come out at economic
 * mean −0.4646%, margin-adjusted +3.4903%, 2 of 3 scoreable. Those three
 * numbers are literals lifted from the work order, not from this code, and the
 * fixture rows behind them are the real production values.
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

// ── fixtures, from production 2026-08-24 ───────────────────────────────────

const COHORT = 'watch-v0-2026-08-15';
const RUN = 'watch-v0-2026-08-15-0b0658';
const GAME = 'b8d97860-58f7-4b13-84e8-3239e25659e6';
const FABLE = 'anthropic-claude-fable-5';
const GEMINI = 'google-gemini-3.1-pro-preview';
const V1 = 'scoring-v0.6.1';
const V2 = 'scoring-v0.6.2';

const RUNS = [
  {
    run_id: RUN,
    network: 'polygon',
    cohort_id: COHORT,
    slate_date: '2026-08-15',
    benchmark_commit: 'a423bb27',
  },
];

/**
 * Both arms were dispatched all three markets. Gemini's call came back
 * `invalid_schema`, so it has attempt rows and NO decisions and NO scores —
 * which is the state that deletes it from a scores-driven arm list.
 */
const ATTEMPTS = [
  {
    id: 1,
    network: 'polygon',
    attempt_ordinal: 0,
    cohort_id: COHORT,
    participant_id: FABLE,
    game_id: GAME,
    supplied_markets: ['moneyline', 'spread', 'total'],
    outcome: 'valid',
  },
  {
    id: 2,
    network: 'polygon',
    attempt_ordinal: 0,
    cohort_id: COHORT,
    participant_id: GEMINI,
    game_id: GAME,
    supplied_markets: ['moneyline', 'spread', 'total'],
    outcome: 'invalid_schema',
  },
];

const GAMES = [
  {
    jsonodds_id: GAME,
    network: 'polygon',
    sport: 'mlb',
    slug: 'nyy-tor-2026-08-15',
    match_time: '2026-08-15T19:00:00+00:00',
    earliest_match_time: null,
    rundown_match_time: null,
    sportspage_match_time: null,
    home_team_id: 'home-uuid',
    away_team_id: 'away-uuid',
    home_score: 4,
    away_score: 1,
    final_type: 'Finished',
  },
];

function game23(): Record<string, unknown> {
  return { ...GAMES[0], jsonodds_id: '23', slug: 'g23' } as Record<string, unknown>;
}
function game3(): Record<string, unknown> {
  return { ...GAMES[0], jsonodds_id: '3', slug: 'g3' } as Record<string, unknown>;
}

const PARTICIPANTS = [
  {
    participant_id: FABLE,
    kind: 'model',
    lab_id: 'anthropic',
    display_name: 'Claude Fable 5',
    model_id: 'claude-fable-5',
  },
  {
    participant_id: GEMINI,
    kind: 'model',
    lab_id: 'google',
    display_name: 'Gemini 3.1 Pro Preview',
    model_id: 'gemini-3.1-pro-preview',
  },
  {
    participant_id: 'baseline-favorite-ml',
    kind: 'baseline',
    lab_id: null,
    display_name: 'Moneyline favorite',
    model_id: null,
  },
];

const COHORT_PARTICIPANTS = PARTICIPANTS.map((p) => ({
  cohort_id: COHORT,
  network: 'polygon',
  participant_id: p.participant_id,
}));

/** The three real score rows behind the acceptance number. */
function scoreRow(
  id: number,
  participant: string,
  market: string,
  econ: number | null,
  ma: number | null,
  extra: Partial<{ refused: boolean; refusal_reason: string | null; held: boolean | null }> = {},
  version = V1,
): Record<string, unknown> {
  return {
    id,
    scoring_policy_version: version,
    // `'held' in extra`, NOT `extra.held ?? false` — the nullish coalesce
    // turns an explicit null back into false, and the null tag is the whole
    // point of one of the cases below. A surviving mutant caught this.
    held_out_of_primary: 'held' in extra ? (extra.held ?? null) : false,
    refused: extra.refused ?? false,
    refusal_reason: extra.refusal_reason ?? null,
    economic_clv_pct: econ,
    margin_adjusted_clv_pct: ma,
    scored_at: '2026-08-16T00:00:00+00:00',
    benchmark_decisions: {
      cohort_id: COHORT,
      participant_id: participant,
      game_id: GAME,
      market,
    },
  };
}

const ACCEPTANCE_SCORES = [
  scoreRow(10, FABLE, 'moneyline', -1.2351, 2.2491),
  scoreRow(13, FABLE, 'spread', 0.3059, 4.7315),
  scoreRow(15, FABLE, 'total', null, null, { refused: true, refusal_reason: 'line_moved' }),
  scoreRow(20, 'baseline-favorite-ml', 'moneyline', -2.0838, 1.2359),
];

// ── harness ────────────────────────────────────────────────────────────────

interface Tables {
  [table: string]: unknown[];
}

const DEFAULT_TABLES: Tables = {
  benchmark_runs: RUNS,
  benchmark_arm_attempts: ATTEMPTS,
  games: GAMES,
  benchmark_cohort_participants: COHORT_PARTICIPANTS,
  benchmark_participants: PARTICIPANTS,
  benchmark_cohort_wallets: [],
  benchmark_scoring_runs: [],
  benchmark_scores: ACCEPTANCE_SCORES,
  benchmark_execution_fills: [],
};

interface Harness {
  fake: FakePostgrest;
  body: Record<string, unknown>;
  status: number;
}

const open: FakePostgrest[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
  vi.resetModules();
});

async function run(
  tables: Tables = {},
  query: Record<string, string> = {},
  config: Record<string, unknown> = {},
): Promise<Harness> {
  const data: Tables = { ...DEFAULT_TABLES, ...tables };
  const seen = new Map<string, number>();
  const fake = await startFakePostgrest((req: CapturedRequest) => {
    const table = /^\/rest\/v1\/([^/?]+)/.exec(req.path)?.[1] ?? '';
    // A keyset page walk asks again after a full page. These fixtures are far
    // under the 1000-row page size, so the first answer terminates the walk;
    // answering the same rows twice would loop forever, so later calls to the
    // SAME table with an advanced cursor get nothing.
    const n = seen.get(table) ?? 0;
    seen.set(table, n + 1);
    if (req.params.has('id') && String(req.params.get('id')).startsWith('gt.') && n > 0) {
      return { body: [] };
    }
    // Top-level filters are APPLIED, so a pushed-down predicate is exercised
    // rather than assumed. Embedded-column filters are not — see applyFilters.
    return { body: applyFilters(data[table] ?? [], req.params) };
  });
  open.push(fake);

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
    HEADLINE_BASES: [
      'marginAdjusted.gameLevel',
      'marginAdjusted.perPick',
      'economic.gameLevel',
      'economic.perPick',
    ],
    isHeadlineBasis: () => true,
  }));

  const { getBenchmarkStandingsHandler } = await import('../src/v1/benchmark/standings.js');

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

  await getBenchmarkStandingsHandler({ query, params: {} } as unknown as Request, res);
  return { fake, body, status };
}

interface Arm {
  participantId: string;
  sample: { eligible: number; picks: number; scoreable: number; gamesScoreable: number };
  metrics: {
    economic: {
      perPick: { meanClvPct: number | null; n: number };
      gameLevel: { meanClvPct: number | null; n: number };
    };
    marginAdjusted: {
      perPick: { meanClvPct: number | null; beatClosePct: number | null };
      gameLevel: { meanClvPct: number | null; beatClosePct: number | null };
    };
    vig: { gameLevel: { observedPct: number | null; breakEvenPct: number | null } };
  };
  headline: { beatClosePct: number | null; clvPct: number | null; vig: { breakEvenPct: number | null } };
  executed: { fills: number; netUsdc: number | null; record: unknown };
}

const armsOf = (body: Record<string, unknown>): Arm[] => body.arms as unknown as Arm[];
const armFor = (body: Record<string, unknown>, id: string): Arm =>
  armsOf(body).find((a) => a.participantId === id) as Arm;

// ── the acceptance case ────────────────────────────────────────────────────

describe('the work order acceptance case', () => {
  /**
   * The three numbers are copied from `ospex-landing-dataplane-round2.md`
   * Part 4, not from this implementation. Note the SPREAD row is load-bearing:
   * the mean of the moneyline and spread values IS the acceptance figure, so a
   * standings query that applied ruling 2's executed-markets filter would serve
   * −1.2351 and fail here.
   */
  it('reproduces fable-5 at economic −0.4646, margin-adjusted +3.4903, 2 of 3 scoreable', async () => {
    const { body, fake, status } = await run();
    expectReached(fake);
    expect(status).toBe(200);
    const fable = armFor(body, FABLE);
    expect(fable.metrics.economic.perPick.meanClvPct).toBe(-0.4646);
    expect(fable.metrics.marginAdjusted.perPick.meanClvPct).toBe(3.4903);
    expect(fable.sample.scoreable).toBe(2);
    expect(fable.sample.picks).toBe(3);
  });

  /** Negative control for the case above: with the spread row gone the number moves. */
  it('and the spread row is what makes it −0.4646 rather than −1.2351', async () => {
    const { body } = await run({
      benchmark_scores: ACCEPTANCE_SCORES.filter((r) => (r as { id: number }).id !== 13),
    });
    expect(armFor(body, FABLE).metrics.economic.perPick.meanClvPct).toBe(-1.2351);
  });

  /** The opportunity denominator comes from the attempts, not from the picks. */
  it('counts three eligible opportunities against three picks', async () => {
    const { body } = await run();
    expect(armFor(body, FABLE).sample.eligible).toBe(3);
  });

  /**
   * Each summary carries ITS OWN denominator. Two scored picks on one game
   * means per-pick n = 2 and game-level n = 1 — a reader handed the game-level
   * rate beside the per-pick count can divide back into nonsense, which is why
   * `n` lives inside the summary object rather than beside it.
   */
  it('pairs each clustering with its own n', async () => {
    const { body } = await run();
    const m = armFor(body, FABLE).metrics;
    expect(m.economic.perPick.n).toBe(2);
    expect(m.economic.gameLevel.n).toBe(1);
  });
});

// ── the query strings themselves ───────────────────────────────────────────

describe('the queries the client actually sends', () => {
  it('inner-joins the decision embed on the score query', async () => {
    const { fake } = await run();
    const req = requestTo(fake, 'benchmark_scores');
    const select = decodeURIComponent(req?.params.get('select') ?? '');
    expect(select).toContain('benchmark_decisions!inner(');
    // A plain embed returns every parent with a null body — measured on
    // production as 1299 rows where 17 were wanted.
    expect(select).not.toMatch(/benchmark_decisions\(/);
  });

  it('filters the score query on the embedded cohort and network', async () => {
    const { fake } = await run();
    const req = requestTo(fake, 'benchmark_scores');
    const q = decodeURIComponent(req?.rawQuery ?? '');
    expect(q).toContain(`benchmark_decisions.cohort_id=in.(${COHORT})`);
    expect(q).toContain('benchmark_decisions.network=eq.polygon');
  });

  it('orders the score query by id ascending, because summation order is part of the contract', async () => {
    const { fake } = await run();
    expect(decodeURIComponent(requestTo(fake, 'benchmark_scores')?.rawQuery ?? '')).toContain(
      'order=id.asc',
    );
  });

  it('pins the arm-attempt read to attempt_ordinal 0', async () => {
    const { fake } = await run();
    expect(decodeURIComponent(requestTo(fake, 'benchmark_arm_attempts')?.rawQuery ?? '')).toContain(
      'attempt_ordinal=eq.0',
    );
  });

  it('gates the run read on the publication min slate date', async () => {
    const { fake } = await run();
    expect(decodeURIComponent(requestTo(fake, 'benchmark_runs')?.rawQuery ?? '')).toContain(
      'slate_date=gte.2026-08-01',
    );
  });
});

// ── the publication gate ───────────────────────────────────────────────────

describe('the publication gate', () => {
  /**
   * The strongest assertion available: with the gate unset the handler must not
   * reach the database AT ALL. An empty `arms[]` alone would also pass on a
   * handler that queried everything and then filtered, which is a different and
   * much weaker guarantee.
   */
  it('serves nothing and issues no query when the min slate date is unset', async () => {
    const { body, fake, status } = await run({}, {}, { benchmarkPublicMinSlateDate: undefined });
    expect(status).toBe(200);
    expect(armsOf(body)).toEqual([]);
    expect(body.publication).toMatchObject({ minSlateDate: null, cohortsInWindow: 0 });
    expect(fake.requests).toHaveLength(0);
  });

  it('excludes a cohort whose slate date precedes the gate', async () => {
    const { body } = await run({}, {}, { benchmarkPublicMinSlateDate: '2026-08-16' });
    // The gate is pushed to the database, so the run read returns nothing.
    expect((body.publication as { cohortsInWindow: number }).cohortsInWindow).toBe(0);
    expect(armsOf(body)).toEqual([]);
  });
});

// ── the scoring policy version ─────────────────────────────────────────────

describe('the scoring policy version', () => {
  /**
   * A re-score ADDS a row beside the old one — `UNIQUE (decision_id,
   * scoring_policy_version)` with no UPDATE grant. Invisible on today's
   * single-version production data, which is why the fixture carries both.
   */
  it('does not pool two versions of the same decision', async () => {
    const { body } = await run({
      benchmark_scores: [
        ...ACCEPTANCE_SCORES,
        scoreRow(30, FABLE, 'moneyline', -9.9, -9.9, {}, V2),
        scoreRow(31, FABLE, 'spread', -9.9, -9.9, {}, V2),
      ],
    });
    // v0.6.1 covers one cohort with 4 rows; v0.6.2 covers the same one cohort.
    // Coverage ties, so the later `scored_at` breaks it — both are the same
    // instant here, so the version is decided and, crucially, only ONE of them
    // contributes. Whichever wins, the pooled mean of −5.x must not appear.
    const fable = armFor(body, FABLE);
    expect([-0.4646, -9.9]).toContain(fable.metrics.economic.perPick.meanClvPct);
    expect(fable.sample.picks).toBeLessThanOrEqual(3);
    expect(body.availableVersions).toHaveLength(2);
  });

  it('honours an explicit ?scoringPolicyVersion', async () => {
    const { body } = await run(
      {
        benchmark_scores: [
          ...ACCEPTANCE_SCORES,
          scoreRow(30, FABLE, 'moneyline', -9.9, -9.9, {}, V2),
        ],
      },
      { scoringPolicyVersion: V2 },
    );
    expect(body.scoringPolicyVersion).toBe(V2);
    const fable = armFor(body, FABLE);
    expect(fable.sample.picks).toBe(1);
    expect(fable.metrics.economic.perPick.meanClvPct).toBe(-9.9);
  });
});

// ── the stratum ────────────────────────────────────────────────────────────

describe('the primary stratum', () => {
  /**
   * A held-out row that CARRIES A VALUE is the discriminating case: it is not
   * refused, so a `refused=false` gate keeps it, and the scorer excludes it.
   * The fixture value is chosen so the two answers cannot coincide.
   */
  it('excludes a held-out row that carries a value', async () => {
    const withHeldOut = [
      ...ACCEPTANCE_SCORES,
      scoreRow(40, FABLE, 'moneyline', 50, 50, { held: true }),
    ];
    const { body } = await run({ benchmark_scores: withHeldOut });
    const fable = armFor(body, FABLE);
    expect(fable.sample.scoreable).toBe(2);
    expect(fable.metrics.economic.perPick.meanClvPct).toBe(-0.4646);
  });

  /**
   * `scheduleHeldOut` is the tagged rows that CARRIED A VALUE — what the tag
   * actually withheld — while `scheduleHeldOutTagged` is the raw stratum size.
   * Measured on production those are 56 and 80, and confusing them is the trap
   * the work order flags in bold. The fixture puts one of each so the two
   * counters cannot coincide.
   */
  it('separates the tagged-and-valued count from the raw tag count', async () => {
    const { body } = await run({
      benchmark_scores: [
        ...ACCEPTANCE_SCORES,
        scoreRow(60, FABLE, 'moneyline', 5, 5, { held: true }),
        scoreRow(61, FABLE, 'total', null, null, {
          held: true,
          refused: true,
          refusal_reason: 'line_moved',
        }),
      ],
    });
    const sample = armFor(body, FABLE).sample as unknown as {
      scheduleHeldOut: number;
      scheduleHeldOutTagged: number;
    };
    expect(sample.scheduleHeldOut).toBe(1);
    expect(sample.scheduleHeldOutTagged).toBe(2);
  });

  /** A null tag means "no determinable comparison", which the scorer KEEPS. */
  it('keeps a row whose hold-out tag is null', async () => {
    const withNullTag = [
      ...ACCEPTANCE_SCORES,
      scoreRow(41, FABLE, 'moneyline', 3.6647, 3.6647, { held: null }),
    ];
    const { body } = await run({ benchmark_scores: withNullTag });
    expect(armFor(body, FABLE).sample.scoreable).toBe(3);
  });
});

// ── the arm list ───────────────────────────────────────────────────────────

describe('the game-level cluster key', () => {
  /**
   * Two cohort/game pairs whose plain concatenation is identical:
   * `wv-1` + `23` against `wv-12` + `3`. With a naive join they land in ONE
   * bucket and the game-level mean is (10 + 30)/2 = 20 over one game; kept
   * apart it is the mean of two buckets, 10 and 30, which is the same 20 — so
   * the MEAN cannot discriminate and `gamesScoreable` is asserted instead.
   */
  it('does not collide two cohort/game pairs whose concatenation matches', async () => {
    const collide = [
      {
        run_id: 'r1',
        network: 'polygon',
        cohort_id: 'wv-1',
        slate_date: '2026-08-15',
        benchmark_commit: 'a',
      },
      {
        run_id: 'r2',
        network: 'polygon',
        cohort_id: 'wv-12',
        slate_date: '2026-08-16',
        benchmark_commit: 'a',
      },
    ];
    const attempts = [
      { ...ATTEMPTS[0], id: 1, cohort_id: 'wv-1', game_id: '23' },
      { ...ATTEMPTS[0], id: 2, cohort_id: 'wv-12', game_id: '3' },
    ];
    const scores = [
      { ...scoreRow(1, FABLE, 'moneyline', 10, 10), benchmark_decisions: { cohort_id: 'wv-1', participant_id: FABLE, game_id: '23', market: 'moneyline' } },
      { ...scoreRow(2, FABLE, 'moneyline', 30, 30), benchmark_decisions: { cohort_id: 'wv-12', participant_id: FABLE, game_id: '3', market: 'moneyline' } },
    ];
    const { body } = await run({
      benchmark_runs: collide,
      benchmark_arm_attempts: attempts,
      games: [game23(), game3()],
      benchmark_cohort_participants: [
        { cohort_id: 'wv-1', network: 'polygon', participant_id: FABLE },
        { cohort_id: 'wv-12', network: 'polygon', participant_id: FABLE },
      ],
      benchmark_scores: scores,
    });
    expect(armFor(body, FABLE).sample.gamesScoreable).toBe(2);
  });

  /**
   * The case the cohort half of the key exists for: a game postponed on one
   * slate and re-fired on the next reuses its `game_id` under a second cohort.
   * `uq_benchmark_decision` is `(cohort_id, participant_id, game_id, market)`,
   * so that is legal. Zero live counterexamples today (98 runs, 98 distinct
   * game ids), which is exactly why no production-shaped fixture would catch
   * it.
   *
   * Values chosen so BOTH answers move: cohort A contributes one pick at 10 and
   * cohort B two at 30. Kept apart that is two buckets averaging (10 + 30)/2 =
   * 20; merged it is one bucket of three picks averaging 23.3333.
   */
  it('keeps the same game under two cohorts as two buckets', async () => {
    const twoDays = [
      { run_id: 'r1', network: 'polygon', cohort_id: 'c-a', slate_date: '2026-08-15', benchmark_commit: 'a' },
      { run_id: 'r2', network: 'polygon', cohort_id: 'c-b', slate_date: '2026-08-16', benchmark_commit: 'a' },
    ];
    const attempts = [
      { ...ATTEMPTS[0], id: 1, cohort_id: 'c-a', game_id: GAME },
      { ...ATTEMPTS[0], id: 2, cohort_id: 'c-b', game_id: GAME },
    ];
    const at = (id: number, cohort: string, market: string, v: number): Record<string, unknown> => ({
      ...scoreRow(id, FABLE, market, v, v),
      benchmark_decisions: { cohort_id: cohort, participant_id: FABLE, game_id: GAME, market },
    });
    const { body } = await run({
      benchmark_runs: twoDays,
      benchmark_arm_attempts: attempts,
      benchmark_cohort_participants: [
        { cohort_id: 'c-a', network: 'polygon', participant_id: FABLE },
        { cohort_id: 'c-b', network: 'polygon', participant_id: FABLE },
      ],
      benchmark_scores: [
        at(1, 'c-a', 'moneyline', 10),
        at(2, 'c-b', 'moneyline', 30),
        at(3, 'c-b', 'total', 30),
      ],
    });
    const fable = armFor(body, FABLE);
    expect(fable.sample.gamesScoreable).toBe(2);
    expect(fable.metrics.economic.gameLevel.meanClvPct).toBe(20);
  });
});

describe('the arm list', () => {
  /**
   * Gemini failed every call in this cohort: attempt rows, no decisions, no
   * scores. It must still be served — the arm that failed is the one the
   * benchmark exists to surface.
   */
  it('keeps an arm that produced nothing', async () => {
    const { body } = await run();
    const gemini = armFor(body, GEMINI);
    expect(gemini).toBeDefined();
    expect(gemini.sample.picks).toBe(0);
    expect(gemini.sample.scoreable).toBe(0);
    expect(gemini.sample.eligible).toBe(3);
    expect(gemini.metrics.marginAdjusted.gameLevel.meanClvPct).toBeNull();
  });

  it('reports its arm outcomes from ordinal 0', async () => {
    const { body } = await run();
    expect(
      (armFor(body, GEMINI).sample as unknown as { armOutcomes: Record<string, number> })
        .armOutcomes,
    ).toEqual({ invalid_schema: 1 });
  });

  it('serves baselines separately and never as the leader', async () => {
    const { body } = await run();
    expect(armsOf(body).map((a) => a.participantId)).not.toContain('baseline-favorite-ml');
    const baselines = body.baselines as Array<{ participantId: string; markets: string[] }>;
    expect(baselines.map((b) => b.participantId)).toEqual(['baseline-favorite-ml']);
    expect(baselines[0]?.markets).toEqual(['moneyline']);
    const featured = body.featured as { leaderParticipantId: string | null };
    expect(featured.leaderParticipantId).toBe(FABLE);
  });

  /** An arm with no rate sorts last, never first on a null. */
  it('orders by headline beat rate, nulls last', async () => {
    const { body } = await run();
    expect(armsOf(body).map((a) => a.participantId)).toEqual([FABLE, GEMINI]);
  });
});

// ── the ranking gate ───────────────────────────────────────────────────────

describe('the per-day series', () => {
  /**
   * The one assertion that keeps `cumulative` honest.
   *
   * The hero area chart is drawn directly under the headline number, so the
   * series' last point and the headline have to be the same figure. They are
   * only the same if `cumulative` is a RE-AGGREGATION over every pick up to
   * that day — a running average of daily means is a different number
   * (measured on production: pooled game-level −2.3888 against a mean of daily
   * means of −2.1226, an 11% relative gap, because one cohort contributed one
   * game and another fifteen).
   */
  it('ends on exactly the arm top-level aggregate', async () => {
    const twoDays = [
      { run_id: 'r1', network: 'polygon', cohort_id: 'c-a', slate_date: '2026-08-15', benchmark_commit: 'a' },
      { run_id: 'r2', network: 'polygon', cohort_id: 'c-b', slate_date: '2026-08-16', benchmark_commit: 'a' },
    ];
    const attempts = [
      { ...ATTEMPTS[0], id: 1, cohort_id: 'c-a', game_id: 'g1' },
      { ...ATTEMPTS[0], id: 2, cohort_id: 'c-b', game_id: 'g2' },
      { ...ATTEMPTS[0], id: 3, cohort_id: 'c-b', game_id: 'g3' },
    ];
    const at = (id: number, cohort: string, gameId: string, v: number): Record<string, unknown> => ({
      ...scoreRow(id, FABLE, 'moneyline', v, v),
      benchmark_decisions: { cohort_id: cohort, participant_id: FABLE, game_id: gameId, market: 'moneyline' },
    });
    const { body } = await run({
      benchmark_runs: twoDays,
      benchmark_arm_attempts: attempts,
      games: [
        { ...GAMES[0], jsonodds_id: 'g1' },
        { ...GAMES[0], jsonodds_id: 'g2' },
        { ...GAMES[0], jsonodds_id: 'g3' },
      ],
      benchmark_cohort_participants: [
        { cohort_id: 'c-a', network: 'polygon', participant_id: FABLE },
        { cohort_id: 'c-b', network: 'polygon', participant_id: FABLE },
      ],
      // One game on day one, two on day two — so the mean of daily means
      // (−2.5) differs from the pooled mean over three games (−2).
      benchmark_scores: [at(1, 'c-a', 'g1', -4), at(2, 'c-b', 'g2', -1), at(3, 'c-b', 'g3', -1)],
    });
    const fable = armFor(body, FABLE);
    const series = (fable as unknown as {
      series: Array<{ cumulative: { marginAdjusted: { gameLevel: { meanClvPct: number | null } } } }>;
    }).series;
    expect(series).toHaveLength(2);
    const last = series[1]?.cumulative.marginAdjusted.gameLevel.meanClvPct;
    expect(last).toBe(fable.metrics.marginAdjusted.gameLevel.meanClvPct);
    // Pooled over three equal-weight games, not the mean of the two daily means.
    expect(last).toBe(-2);
    expect(last).not.toBe(-2.5);
  });

  it('carries one point per cohort in the window, oldest first', async () => {
    const { body } = await run();
    const series = (armFor(body, FABLE) as unknown as {
      series: Array<{ slateDate: string; cohortId: string }>;
    }).series;
    expect(series.map((p) => p.cohortId)).toEqual([COHORT]);
    expect(series[0]?.slateDate).toBe('2026-08-15');
  });
});

describe('the ranking gate', () => {
  it('withholds ranking when a contributing cohort has no scoring run', async () => {
    const { body } = await run();
    const ranking = body.ranking as { allowed: boolean; withheldBy: Array<{ cohortId: string }> };
    expect(ranking.allowed).toBe(false);
    expect(ranking.withheldBy.map((w) => w.cohortId)).toEqual([COHORT]);
  });

  it('allows ranking when every contributing cohort published it open', async () => {
    const { body } = await run({
      benchmark_scoring_runs: [
        {
          cohort_id: COHORT,
          scoring_policy_version: V1,
          eligible: 3,
          scored: 2,
          refused: 1,
          schedule_held_out: 0,
          refusal_reasons: { line_moved: 1 },
          ranking_allowed: true,
          ranking_reason: 'operator published',
          cost_per_pick_comparable: null,
        },
      ],
    });
    expect((body.ranking as { allowed: boolean }).allowed).toBe(true);
  });

  /** Migration 073: "a NULL here must be read as false". */
  it('reads a null ranking_allowed as false', async () => {
    const { body } = await run({
      benchmark_scoring_runs: [
        {
          cohort_id: COHORT,
          scoring_policy_version: V1,
          eligible: 3,
          scored: 2,
          refused: 1,
          schedule_held_out: 0,
          refusal_reasons: {},
          ranking_allowed: null,
          ranking_reason: 'pending',
          cost_per_pick_comparable: null,
        },
      ],
    });
    expect((body.ranking as { allowed: boolean }).allowed).toBe(false);
  });

  /** Withheld gates the RANK, never the numbers. Ruling 4. */
  it('still serves the metrics and an order while withheld', async () => {
    const { body } = await run();
    expect((body.ranking as { allowed: boolean }).allowed).toBe(false);
    expect(armFor(body, FABLE).metrics.marginAdjusted.perPick.meanClvPct).toBe(3.4903);
    expect((body.featured as { leaderParticipantId: string }).leaderParticipantId).toBe(FABLE);
  });
});

// ── the two vig numbers ────────────────────────────────────────────────────

describe('the vig figures', () => {
  /**
   * With one game bucket the game-level means equal the per-pick ones, so the
   * expected values are computable from the acceptance numbers by hand:
   *   observed  = 1 − 0.995354/1.034903 = 1 − 0.9617848 = 3.8215%
   *   breakEven = 0.034903 / 1.034903    =     0.0337258 = 3.3726%
   * Both literals, neither derived from the code under test.
   */
  it('derives the observed and break-even vig from the two means', async () => {
    const { body } = await run();
    const vig = armFor(body, FABLE).metrics.vig.gameLevel;
    expect(vig.observedPct).toBe(3.8215);
    expect(vig.breakEvenPct).toBe(3.3726);
  });

  it('puts the break-even figure on the headline', async () => {
    const { body } = await run();
    expect(armFor(body, FABLE).headline.vig.breakEvenPct).toBe(3.3726);
  });

  /** A strategy that loses at zero vig gets a NEGATIVE break-even, not a null. */
  it('reports a negative break-even for an arm that loses on a fair number', async () => {
    const { body } = await run({
      benchmark_scores: [scoreRow(50, FABLE, 'moneyline', -4.0838, -0.8339)],
    });
    const vig = armFor(body, FABLE).metrics.vig.gameLevel;
    expect(vig.breakEvenPct).toBeLessThan(0);
    expect(vig.breakEvenPct).toBe(-0.8409);
  });

  it('is null for an arm with no scoreable picks', async () => {
    const { body } = await run();
    expect(armFor(body, GEMINI).metrics.vig.gameLevel.breakEvenPct).toBeNull();
  });
});

// ── the executed record ────────────────────────────────────────────────────

describe('the executed record', () => {
  /** `0` would assert a measured break-even. With no fills the answer is null. */
  it('is null-shaped rather than zero-shaped when there are no fills', async () => {
    const { body } = await run();
    const executed = armFor(body, FABLE).executed;
    expect(executed.fills).toBe(0);
    expect(executed.netUsdc).toBeNull();
    expect(executed.record).toBeNull();
  });
});

// ── the methodology block ──────────────────────────────────────────────────

describe('the methodology block', () => {
  it('ships the two vig formulas with the numbers', async () => {
    const { body } = await run();
    const m = body.methodology as Record<string, string>;
    expect(m.vigBreakEvenPct).toContain('marginAdjusted/100');
    expect(m.vigObservedPct).toContain('economic/100');
    expect(m.beatClosePct).toContain('strictly greater than zero');
  });
});

// ── parameter validation ───────────────────────────────────────────────────

describe('parameter validation', () => {
  it('rejects an unknown sport', async () => {
    const { status, body } = await run({}, { sport: 'quidditch' });
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_PARAM');
  });

  it('accepts "all" as a sport', async () => {
    const { status } = await run({}, { sport: 'all' });
    expect(status).toBe(200);
  });

  it('rejects a malformed date', async () => {
    const { status } = await run({}, { date: '15-08-2026' });
    expect(status).toBe(400);
  });
});
