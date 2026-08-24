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
  type FakeReply,
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

/** A published scoring run with the ranking brake OPEN. */
const OPEN_RUN = {
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
};

const open: FakePostgrest[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
  vi.resetModules();
});

async function run(
  tables: Tables = {},
  query: Record<string, string> = {},
  config: Record<string, unknown> = {},
  /** Answer a request yourself; return undefined to fall through to the fixture. */
  override?: (req: CapturedRequest, index: number) => FakeReply | undefined,
): Promise<Harness> {
  const data: Tables = { ...DEFAULT_TABLES, ...tables };
  const seen = new Map<string, number>();
  const fake = await startFakePostgrest((req: CapturedRequest, index: number) => {
    const forced = override?.(req, index);
    if (forced !== undefined) return forced;
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

describe('the sport scope', () => {
  /**
   * A cohort can hold games from more than one sport. `resolveWindow` filters
   * each cohort's GAME list, but the score and fill reads are scoped by COHORT
   * — so before this was fixed, requesting one sport still pulled every other
   * sport's rows into the policy-version choice, the means, the counts and the
   * ordering. Every production cohort is 100% MLB, so nothing leaked in
   * practice and no production-shaped fixture could have caught it. Found in
   * review.
   *
   * The NBA row's value is chosen so it cannot hide: including it moves Fable's
   * per-pick economic mean from the acceptance figure -0.4646 to +33.0236 — the same figure the review probe reported.
   */
  const NBA_GAME = 'nba-game-1';
  const MIXED: Tables = {
    benchmark_arm_attempts: [
      ...ATTEMPTS,
      { ...ATTEMPTS[0], id: 3, game_id: NBA_GAME },
    ],
    games: [
      ...GAMES,
      { ...GAMES[0], jsonodds_id: NBA_GAME, sport: 'nba', slug: 'nba-1' },
    ],
    benchmark_scores: [
      ...ACCEPTANCE_SCORES,
      {
        ...scoreRow(70, FABLE, 'moneyline', 100, 100),
        benchmark_decisions: {
          cohort_id: COHORT,
          participant_id: FABLE,
          game_id: NBA_GAME,
          market: 'moneyline',
        },
      },
    ],
  };

  it('excludes another sport from the means when one sport is requested', async () => {
    const { body } = await run(MIXED, { sport: 'mlb' });
    const fable = armFor(body, FABLE);
    expect(fable.metrics.economic.perPick.meanClvPct).toBe(-0.4646);
    expect(fable.sample.scoreable).toBe(2);
  });

  /**
   * Negative control: the same fixture unscoped MUST include it, or the
   * assertion above passes on a handler that drops the row for some unrelated
   * reason (a bad game id, a failed join) rather than because of the filter.
   */
  it('includes it when no sport is requested', async () => {
    const { body } = await run(MIXED);
    const fable = armFor(body, FABLE);
    expect(fable.sample.scoreable).toBe(3);
    expect(fable.metrics.economic.perPick.meanClvPct).toBe(33.0236);
  });

  it('scopes the opportunity denominator the same way', async () => {
    const scoped = await run(MIXED, { sport: 'mlb' });
    const all = await run(MIXED);
    expect(armFor(scoped.body, FABLE).sample.eligible).toBe(3);
    expect(armFor(all.body, FABLE).sample.eligible).toBe(6);
  });

  /**
   * N03. The out-of-scope rows must not choose the POLICY VERSION either. Here
   * the NBA rows are scored under v0.6.2 with a later `scored_at`; unscoped,
   * the two versions tie on cohort coverage and recency breaks it toward
   * v0.6.2, which then excludes every MLB row and empties the table. Scoped,
   * v0.6.2 is not in the population at all.
   *
   * The earlier sport cases could not catch this: their extra row shared the
   * in-scope version, so the choice was the same either way.
   */
  it('excludes another sport from the policy-version choice', async () => {
    const nbaAtV2 = {
      ...MIXED,
      benchmark_scores: [
        ...ACCEPTANCE_SCORES,
        {
          ...scoreRow(80, FABLE, 'moneyline', 100, 100, {}, V2),
          scored_at: '2026-09-01T00:00:00+00:00',
          benchmark_decisions: {
            cohort_id: COHORT,
            participant_id: FABLE,
            game_id: NBA_GAME,
            market: 'moneyline',
          },
        },
      ],
    };
    const scoped = await run(nbaAtV2, { sport: 'mlb' });
    expect(scoped.body.scoringPolicyVersion).toBe(V1);
    expect(armFor(scoped.body, FABLE).metrics.economic.perPick.meanClvPct).toBe(-0.4646);

    // Negative control: unscoped, the NBA version really does win, so the
    // assertion above is about the scope rather than about the fixture.
    const all = await run(nbaAtV2);
    expect(all.body.scoringPolicyVersion).toBe(V2);
  });

  /**
   * N04. The scope has to reach the EXECUTION FILLS too — they are read by
   * cohort like the scores were, and a fill on another sport's game would put
   * another sport's money into this arm's record.
   */
  it('excludes another sport from the executed record', async () => {
    const withFills = {
      ...MIXED,
      benchmark_execution_fills: [
        {
          cohort_id: COHORT,
          participant_id: FABLE,
          network: 'polygon',
          game_id: NBA_GAME,
          market: 'moneyline',
          run_id: RUN,
          deployment_round: 'R5',
          contest_id: 41,
          speculation_id: 88,
          commitment_hash: '0xaa',
          taker_address: '0xabc',
          tx_hash: '0xtx1',
          block_number: 100,
          filled_at: '2026-08-15T20:00:00+00:00',
          stake_usdc: 10,
          would_abstain: false,
        },
      ],
      position_fills: [
        {
          id: 1,
          network: 'polygon',
          speculation_id: 88,
          contest_id: 41,
          commitment_hash: '0xaa',
          taker_address: '0xabc',
          taker_position_type: 'upper',
          taker_risk_amount: '10000000',
          maker_risk_amount: '7000000',
          tx_hash: '0xtx1',
          log_index: 0,
        },
      ],
      speculations: [
        {
          network: 'polygon',
          speculation_id: 88,
          contest_id: 41,
          market_type: 'moneyline',
          line_ticks: null,
          speculation_status: 'closed',
          win_side: 'away',
          source_block: 90,
        },
      ],
      contests: [
        {
          network: 'polygon',
          contest_id: 41,
          jsonodds_id: NBA_GAME,
          contest_status: 'scored',
          away_score: 5,
          home_score: 3,
        },
      ],
    };
    const scoped = await run(withFills, { sport: 'mlb' });
    expect(armFor(scoped.body, FABLE).executed.fills).toBe(0);
    expect(armFor(scoped.body, FABLE).executed.netUsdc).toBeNull();

    // Negative control: unscoped it IS counted, so the scope is what excluded
    // it rather than a broken join.
    const all = await run(withFills);
    expect(armFor(all.body, FABLE).executed.fills).toBe(1);
    expect(armFor(all.body, FABLE).executed.netUsdc).toBe(7);
  });

  it('reports only the sports actually in scope', async () => {
    const scoped = await run(MIXED, { sport: 'mlb' });
    const all = await run(MIXED);
    expect(scoped.body.availableSports).toEqual(['mlb']);
    expect(all.body.availableSports).toEqual(['mlb', 'nba']);
  });
});

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

  it('serves baselines separately, and never lets one be the leader', async () => {
    const { body } = await run({ benchmark_scoring_runs: [OPEN_RUN] });
    expect(armsOf(body).map((a) => a.participantId)).not.toContain('baseline-favorite-ml');
    const baselines = body.baselines as Array<{ participantId: string; markets: string[] }>;
    expect(baselines.map((b) => b.participantId)).toEqual(['baseline-favorite-ml']);
    expect(baselines[0]?.markets).toEqual(['moneyline']);
    // `featuredOf` only ever looks at `arms`, so a baseline cannot be named
    // however it performs.
    const featured = body.featured as { leaderParticipantId: string | null };
    expect(featured.leaderParticipantId).toBe(FABLE);
  });

  /** An arm with no rate sorts last, never first on a null. */
  it('orders by headline beat rate with nulls last, once the gate is open', async () => {
    const { body } = await run({ benchmark_scoring_runs: [OPEN_RUN] });
    expect((body.ranking as { orderedBy: string }).orderedBy).toBe('headline');
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

  /**
   * REVIEW ROUND 2, B7. The case above cannot fail on summation ORDER, because
   * its score ids run in slate order. Here the EARLIER cohort was re-scored
   * later and so carries the HIGHER ids — the rows arrive "later cohort, then
   * earlier" — while the series walks the cohorts oldest first. Float addition
   * is not associative, and these four values were chosen so the two orders
   * round to different fourth decimals: slate order gives −8.1877, id order
   * −8.1876 (the same shape as the review's −9.4200 / −9.4201). One order is
   * now applied to everything before any aggregate reads a row, so the last
   * series point and the headline are the same figure by construction.
   */
  it('ends on the top-level aggregate even when an earlier cohort was backfilled later', async () => {
    const twoDays = [
      { run_id: 'r1', network: 'polygon', cohort_id: 'c-a', slate_date: '2026-08-15', benchmark_commit: 'a' },
      { run_id: 'r2', network: 'polygon', cohort_id: 'c-b', slate_date: '2026-08-16', benchmark_commit: 'a' },
    ];
    const attempts = [
      { ...ATTEMPTS[0], id: 1, cohort_id: 'c-a', game_id: 'g1' },
      { ...ATTEMPTS[0], id: 2, cohort_id: 'c-b', game_id: 'g2' },
      { ...ATTEMPTS[0], id: 3, cohort_id: 'c-b', game_id: 'g3' },
      { ...ATTEMPTS[0], id: 4, cohort_id: 'c-b', game_id: 'g4' },
    ];
    const at = (id: number, cohort: string, gameId: string, v: number): Record<string, unknown> => ({
      ...scoreRow(id, FABLE, 'moneyline', v, v),
      benchmark_decisions: { cohort_id: cohort, participant_id: FABLE, game_id: gameId, market: 'moneyline' },
    });
    const { body } = await run({
      benchmark_runs: twoDays,
      benchmark_arm_attempts: attempts,
      games: ['g1', 'g2', 'g3', 'g4'].map((id) => ({ ...GAMES[0], jsonodds_id: id })),
      benchmark_cohort_participants: [
        { cohort_id: 'c-a', network: 'polygon', participant_id: FABLE },
        { cohort_id: 'c-b', network: 'polygon', participant_id: FABLE },
      ],
      // In ID order, as PostgREST returns them: the later cohort's three rows
      // first, then the earlier cohort's single backfilled row at id 10.
      benchmark_scores: [
        at(1, 'c-b', 'g2', -17.8727),
        at(2, 'c-b', 'g3', -8.8573),
        at(3, 'c-b', 'g4', 9.5023),
        at(10, 'c-a', 'g1', -15.5229),
      ],
    });
    const fable = armFor(body, FABLE);
    const series = (fable as unknown as {
      series: Array<{ cohortId: string; cumulative: { marginAdjusted: { gameLevel: { meanClvPct: number | null }; perPick: { meanClvPct: number | null } } } }>;
    }).series;
    expect(series.map((p) => p.cohortId)).toEqual(['c-a', 'c-b']);
    const last = series[1]?.cumulative.marginAdjusted;
    expect(last?.gameLevel.meanClvPct).toBe(fable.metrics.marginAdjusted.gameLevel.meanClvPct);
    expect(last?.perPick.meanClvPct).toBe(fable.metrics.marginAdjusted.perPick.meanClvPct);
    // The slate-order figure, and NOT the id-order one.
    expect(fable.metrics.marginAdjusted.gameLevel.meanClvPct).toBe(-8.1877);
    expect(fable.metrics.marginAdjusted.gameLevel.meanClvPct).not.toBe(-8.1876);
    // The fixture discriminates: summing in id order really does round the
    // other way, so the assertion above is about the order and not the values.
    const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
    const idOrder = [-17.8727, -8.8573, 9.5023, -15.5229];
    const slateOrder = [-15.5229, -17.8727, -8.8573, 9.5023];
    expect(round4(idOrder.reduce((a, b) => a + b, 0) / 4)).toBe(-8.1876);
    expect(round4(slateOrder.reduce((a, b) => a + b, 0) / 4)).toBe(-8.1877);
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
    const { body } = await run({ benchmark_scoring_runs: [OPEN_RUN] });
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

  /**
   * Withheld gates the ORDER and the leader, never the numbers.
   *
   * Ruling 4 says the projection "serves metrics with ranking withheld", and
   * migration 073 says "a UI must not sort participants when it is false" — so
   * an array served in performance order plus a named leader withholds nothing,
   * which is what the first cut shipped. Both halves are asserted here: the
   * numbers survive, the ranking does not.
   */
  it('serves the metrics but withholds the order and the leader', async () => {
    const { body } = await run();
    const ranking = body.ranking as { allowed: boolean; orderedBy: string };
    expect(ranking.allowed).toBe(false);
    expect(ranking.orderedBy).toBe('neutral');
    expect(armFor(body, FABLE).metrics.marginAdjusted.perPick.meanClvPct).toBe(3.4903);
    expect(body.featured).toEqual({
      leaderParticipantId: null,
      runnerUpParticipantId: null,
    });
  });

  /**
   * The neutral order must not BE the performance order by accident, or the
   * assertion above is decoration. Fable has a beat rate and Gemini has none,
   * so performance order is deterministic ([FABLE, GEMINI]); the hash order for
   * this seed differs, which is what makes the two distinguishable at all.
   */
  it('the withheld order is not the performance order', async () => {
    const withheld = await run();
    const opened = await run({ benchmark_scoring_runs: [OPEN_RUN] });
    expect(armsOf(withheld.body).map((a) => a.participantId)).not.toEqual(
      armsOf(opened.body).map((a) => a.participantId),
    );
  });

  /** Deterministic: the same request twice gives the same neutral order. */
  it('the withheld order is stable across requests', async () => {
    const a = await run();
    const b = await run();
    expect(armsOf(a.body).map((x) => x.participantId)).toEqual(
      armsOf(b.body).map((x) => x.participantId),
    );
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

  /**
   * The receipts walk is keyed on `tx_hash`, and a hash coming back twice is
   * a contradiction the schema rules out. Driven through the HANDLER so the
   * wiring from the throw to the 503 is what is exercised, not just the
   * responder: page one is 1,000 receipts, page two repeats one of them beside
   * a genuinely later one (so the cursor still advances and it is the
   * duplicate check, not the cursor guard, that fires).
   */
  it('answers 503 NOT_READY rather than serving a record over a duplicated receipt', async () => {
    const hash = (i: number): string => `0x${i.toString(16).padStart(6, '0')}`;
    const receipt = (i: number): Record<string, unknown> => ({
      cohort_id: COHORT,
      participant_id: FABLE,
      network: 'polygon',
      game_id: GAME,
      market: 'moneyline',
      run_id: RUN,
      deployment_round: 'R5',
      contest_id: 41,
      speculation_id: 88,
      commitment_hash: '0xaa',
      taker_address: '0xabc',
      tx_hash: hash(i),
      block_number: 100,
      filled_at: '2026-08-15T20:00:00+00:00',
      stake_usdc: 1,
      would_abstain: false,
    });
    const first = Array.from({ length: 1000 }, (_, i) => receipt(i + 1));
    let served = 0;
    const { status, body } = await run({}, {}, {}, (req) => {
      if (req.path !== '/rest/v1/benchmark_execution_fills') return undefined;
      served += 1;
      if (served === 1) return { body: first };
      return { body: [receipt(500), receipt(5000)] };
    });
    expect(served).toBe(2);
    expect(status).toBe(503);
    expect(body.code).toBe('NOT_READY');
    expect(body.arms).toBeUndefined();
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
