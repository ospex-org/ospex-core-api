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

/** The configured scorer contracts — what names the market of a chain speculation. */
const SCORERS = {
  moneyline: '0x59555106d4b5f1a797f3552f60ac418eb6b6f6bd',
  spread: '0xb4b1e2a2a75c34e9e4c5d3bb8a432aff973dada0',
  total: '0x2222222222222222222222222222222222222222',
};
const CORE = '0x40047bafcded16c938058b7b67186299a2893561';

/** One raw-log row, in the shape every `chain_events` fixture here shares. */
function chainEvent(o: {
  id: number;
  eventName: string;
  entityType: string;
  entityId: number;
  block: number;
  txHash: string;
  payload: Record<string, string>;
}): Record<string, unknown> {
  return {
    id: o.id,
    network: 'polygon',
    event_name: o.eventName,
    entity_type: o.entityType,
    entity_id: o.entityId,
    emitter_address: CORE,
    block_number: o.block,
    tx_hash: o.txHash,
    log_index: 0,
    payload: { raw: '0x', ...o.payload },
  };
}

/**
 * The SPECULATION-level log one priced fill needs: its own COMMITMENT_MATCHED
 * row (the deployment mark) and the speculation's creation and settlement.
 *
 * ## Every parameter here is a trap the identity chain in `executedFetch` sets
 *
 * Split out of `chainHistory` so a SECOND speculation on the same contest can be
 * built, which is what `#89` asked for, and parameterised rather than copied
 * because each hard-coded value below is a link the chain checks:
 *
 * - **`txHash` must be this fill's own**, distinct from any other fill's. Link 1
 *   requires that EVERY `position_fills` row on the transaction belong to this
 *   receipt (`mine.length !== events.length` refuses), and Link 2 matches the
 *   COMMITMENT_MATCHED row by `tx_hash`. Two fills sharing a hash refuse each
 *   other. `createTxHash` / `settleTxHash` are separate because the raw log is
 *   UNIQUE on `(tx_hash, log_index)` and every row here carries `log_index: 0` —
 *   reusing `'0xcreate'` for a second speculation is not a real history.
 * - **`block` must equal the RECEIPT's `block_number`**, not the creation's.
 *   Link 2 compares them.
 * - **`scorer` must name the receipt's `market`** through the configured
 *   `SCORERS`, and Link 3b additionally requires the MATCHED row and the
 *   SETTLED row to name the SAME scorer and `lineTicks` as the creation. That is
 *   the one that cost the first attempt at this fixture: a second speculation
 *   whose creation said `total` while its copied MATCHED row still said
 *   `moneyline` is refused, and a refused receipt is indistinguishable from a
 *   broken market filter.
 * - **`lineTicks` must parse as an integer** (10x-scaled; `'0'` on moneyline).
 * - **`winSideValue`** is the on-chain enum: `1` away, `2` home, `3` over,
 *   `4` under, `5` push, `6` void. With `taker_position_type: 'upper'`
 *   (positionType 0) the taker wins on `away` or `over` and loses on `home` or
 *   `under`.
 */
function speculationHistory(o: {
  idBase: number;
  speculationId: number;
  contestId: number;
  taker: string;
  commitmentHash: string;
  txHash: string;
  block: number;
  scorer: string;
  lineTicks: string;
  winSideValue: string;
  createTxHash: string;
  createBlock: number;
  settleTxHash: string;
  settleBlock: number;
}): Record<string, unknown>[] {
  const spec = String(o.speculationId);
  const contest = String(o.contestId);
  return [
    chainEvent({
      id: o.idBase, eventName: 'COMMITMENT_MATCHED', entityType: 'fill',
      entityId: o.speculationId, block: o.block, txHash: o.txHash,
      payload: { speculationId: spec, contestId: contest, taker: o.taker, commitmentHash: o.commitmentHash, scorer: o.scorer, lineTicks: o.lineTicks },
    }),
    chainEvent({
      id: o.idBase + 1, eventName: 'SPECULATION_CREATED', entityType: 'speculation',
      entityId: o.speculationId, block: o.createBlock, txHash: o.createTxHash,
      payload: { speculationId: spec, contestId: contest, scorer: o.scorer, lineTicks: o.lineTicks },
    }),
    chainEvent({
      id: o.idBase + 2, eventName: 'SPECULATION_SETTLED', entityType: 'speculation',
      entityId: o.speculationId, block: o.settleBlock, txHash: o.settleTxHash,
      payload: { speculationId: spec, winSideValue: o.winSideValue, scorer: o.scorer },
    }),
  ];
}

/**
 * The CONTEST-level log: the creation (the game spine) and the scores.
 *
 * Emitted **exactly once per contest**, which is why it is not part of
 * `speculationHistory`. Link 4 refuses a receipt when
 * `contestCreated.length !== 1` under the emitter, so a second speculation on
 * the same contest that brought its own copy of these two rows would refuse
 * BOTH fills rather than add one.
 */
function contestHistory(o: {
  idBase: number;
  contestId: number;
  gameId: string;
  createTxHash: string;
  scoreTxHash: string;
}): Record<string, unknown>[] {
  const contest = String(o.contestId);
  return [
    chainEvent({
      id: o.idBase, eventName: 'CONTEST_CREATED', entityType: 'contest',
      entityId: o.contestId, block: 80, txHash: o.createTxHash,
      payload: { contestId: contest, jsonoddsId: o.gameId },
    }),
    chainEvent({
      id: o.idBase + 1, eventName: 'CONTEST_SCORES_SET', entityType: 'contest',
      entityId: o.contestId, block: 190, txHash: o.scoreTxHash,
      payload: { contestId: contest, awayScore: '5', homeScore: '3' },
    }),
  ];
}

/** The whole raw-log history one settled, WON moneyline fill needs. */
function chainHistory(o: { gameId: string; txHash: string; block: number; taker: string }): Record<string, unknown>[] {
  return [
    ...speculationHistory({
      idBase: 1, speculationId: 88, contestId: 41, taker: o.taker, commitmentHash: '0xaa',
      txHash: o.txHash, block: o.block, scorer: SCORERS.moneyline, lineTicks: '0',
      winSideValue: '1', createTxHash: '0xcreate', createBlock: 90,
      settleTxHash: '0xsettle', settleBlock: 200,
    }),
    ...contestHistory({
      idBase: 4, contestId: 41, gameId: o.gameId,
      createTxHash: '0xcontest', scoreTxHash: '0xscore',
    }),
  ];
}

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

/**
 * One priced fill for FABLE on the in-scope game: 10 USDC risked, 7 USDC net.
 *
 * Module scope, and deliberately its own fixture rather than a reuse of the
 * sport-scope one, because the DEFAULT tables give FABLE no executed money at all.
 * A money formula tested against those is not tested: a mutant putting the ROI
 * percentage out by a factor of ten survived the battery until this existed,
 * because every branch that could have caught it was reading nulls.
 */
const FABLE_WITH_FILL = {
  benchmark_execution_fills: [
    {
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
  chain_events: chainHistory({ gameId: GAME, txHash: '0xtx1', block: 100, taker: '0xabc' }),
};

/**
 * `FABLE_WITH_FILL` plus a SECOND priced fill on a different market — `#89`.
 *
 * One arm, one sport, one contest, two speculations:
 *
 * | view | risk | net | ROI |
 * |---|---|---|---|
 * | `?market=moneyline` | 10 | +7 | 70% |
 * | `?market=total` | 30 | −30 | −100% |
 * | pooled | 40 | −23 | −57.5% |
 *
 * Three DIFFERENT triples, which is the whole point: with only the moneyline
 * fill, a projection that ignored the market filter and answered the pooled
 * figure everywhere agreed with the correct one on the market that had the fill,
 * and the grouping key itself was unpinned. The mutant that measured that gap
 * forced every fill into `'moneyline'` and changed nothing the suite could see.
 *
 * ## Why this is a separate fixture rather than a second fill in the one above
 *
 * Nine tests read `FABLE_WITH_FILL` and several assert its pooled 10 / +7 / 70%.
 * Those assertions are coverage in their own right — the single-fill case is the
 * one where a market filter and a pooled answer COINCIDE, which is worth keeping
 * pinned — so this extends rather than replaces, and the blast radius is zero.
 *
 * ## What the second fill has to satisfy, and what it must not collide with
 *
 * A separate speculation (89) under the SAME contest, which is how Ospex models
 * a second market on one game. See `speculationHistory` for the per-link reasons;
 * the collision surfaces are its own `tx_hash` (`0xtx2`, so Link 1's
 * every-event-is-mine check holds), its own `commitment_hash` (`0xbb`), its own
 * `position_fills.id`, its own `chain_events.id` range (6–8, after the first
 * fill's 1–3 and the contest's 4–5), and its own creation and settlement hashes.
 * The contest rows are NOT repeated: Link 4 wants exactly one CONTEST_CREATED.
 *
 * It LOSES on purpose, because a fixture where both fills win cannot tell a
 * market-scoped net from a doubled one: +7 and +21 sum to +28 either way, while
 * +7 and −30 make the pooled net land between the two market nets and outside
 * both. `winSideValue: '4'` is `under` and the taker is `'upper'` (over), so
 * `didWin(0, 'under')` is false — payout 0, net −30, ROI −100%.
 */
const FABLE_TWO_MARKETS = {
  ...FABLE_WITH_FILL,
  benchmark_execution_fills: [
    ...FABLE_WITH_FILL.benchmark_execution_fills,
    {
      cohort_id: COHORT,
      participant_id: FABLE,
      network: 'polygon',
      game_id: GAME,
      market: 'total',
      run_id: RUN,
      deployment_round: 'R5',
      contest_id: 41,
      speculation_id: 89,
      commitment_hash: '0xbb',
      taker_address: '0xabc',
      tx_hash: '0xtx2',
      block_number: 101,
      filled_at: '2026-08-15T20:05:00+00:00',
      stake_usdc: 30,
      would_abstain: false,
    },
  ],
  position_fills: [
    ...FABLE_WITH_FILL.position_fills,
    {
      id: 2,
      network: 'polygon',
      speculation_id: 89,
      contest_id: 41,
      commitment_hash: '0xbb',
      taker_address: '0xabc',
      taker_position_type: 'upper',
      taker_risk_amount: '30000000',
      maker_risk_amount: '21000000',
      tx_hash: '0xtx2',
      log_index: 0,
    },
  ],
  chain_events: [
    ...FABLE_WITH_FILL.chain_events,
    ...speculationHistory({
      idBase: 6, speculationId: 89, contestId: 41, taker: '0xabc', commitmentHash: '0xbb',
      txHash: '0xtx2', block: 101, scorer: SCORERS.total, lineTicks: '85',
      winSideValue: '4', createTxHash: '0xcreate2', createBlock: 91,
      settleTxHash: '0xsettle2', settleBlock: 201,
    }),
  ],
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
  /**
   * Drive `/benchmark/profile/:participantId` instead of the standings table,
   * over THIS SAME fixture.
   *
   * Appended rather than given its own harness on purpose: the profile's binding
   * acceptance criterion is exact all/all parity with the table, and a parity
   * test whose two sides read different fixtures is not testing parity. Both
   * sides now share one fake, one fixture and one config, so the only difference
   * between the calls is which handler runs.
   */
  profileFor?: string,
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
      scorers: SCORERS,
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

  if (profileFor === undefined) {
    const { getBenchmarkStandingsHandler } = await import('../src/v1/benchmark/standings.js');
    await getBenchmarkStandingsHandler({ query, params: {} } as unknown as Request, res);
  } else {
    const { getBenchmarkProfileHandler } = await import('../src/v1/benchmark/profile.js');
    await getBenchmarkProfileHandler(
      { query, params: { participantId: profileFor } } as unknown as Request,
      res,
    );
  }
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
      chain_events: chainHistory({ gameId: NBA_GAME, txHash: '0xtx1', block: 100, taker: '0xabc' }),
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

  /**
   * An indexer recovery in progress means the chain reads behind the record
   * may straddle two histories; the endpoint answers 503 rather than serving
   * a record from either. Driven through the handler so the wiring is what is
   * exercised. Fills are needed for the ledger to be consulted at all.
   */
  it('answers 503 NOT_READY while the indexer is recovering', async () => {
    const { status, body } = await run({
      benchmark_execution_fills: [
        {
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
          tx_hash: '0xtx1',
          block_number: 100,
          filled_at: '2026-08-15T20:00:00+00:00',
          stake_usdc: 10,
          would_abstain: false,
        },
      ],
      recovery_runs: [
        { id: 8, network: 'polygon', kind: 'reorg', phase: 'pre_swap', status: 'in_progress', started_at: '2026-08-24T00:00:00+00:00', completed_at: null },
      ],
    });
    expect(status).toBe(503);
    expect(body.code).toBe('NOT_READY');
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

  /**
   * Shape is not validity, and this endpoint was answering 500 on the difference.
   *
   * Measured against the deployed service on 2026-09-22: `?date=2026-02-30`
   * returned `500 INTERNAL_ERROR`, because the old check tested only
   * `/^\d{4}-\d{2}-\d{2}$/`, the string reached Postgres, and `22008` is not one
   * of the schema-drift codes `source.ts` classifies. A malformed request is a
   * 400. Now routed through the shared `parseSlateDate`.
   */
  it.each([
    ['February 30th', '2026-02-30'],
    ['a leap day in a non-leap year', '2026-02-29'],
    ['month 13', '2026-13-01'],
    ['year zero', '0000-01-01'],
  ])('rejects %s with 400 rather than 500', async (_why, date) => {
    const { status, body } = await run({}, { date });
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_PARAM');
  });

  it('still accepts a real leap day — the control the four refusals need', async () => {
    const { status } = await run({}, { date: '2024-02-29' });
    expect(status).toBe(200);
  });

  /**
   * `?scoringPolicyVersion=` is malformed, like the empty spelling of the
   * other two params — not "the default". Served as a literal it would be an
   * empty table labelled '', and a 200 that the cache could store.
   */
  it('rejects an empty scoringPolicyVersion', async () => {
    const { status, body } = await run({}, { scoringPolicyVersion: '' });
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_PARAM');
    // Negative control: absent still serves the default version.
    const { status: ok, body: served } = await run();
    expect(ok).toBe(200);
    expect(served.scoringPolicyVersion).toBe(V1);
  });
});

// ── /v1/benchmark/profile/:participantId ───────────────────────────────────
//
// In THIS file, not a new one, because the fixture is here. The profile's binding
// acceptance criterion is exact all/all parity with the table above, and a parity
// test whose two sides read different fixtures tests nothing. `run(..., FABLE)`
// drives the profile handler over the same fake, the same rows and the same
// config, so the only difference between the two calls is which handler runs.

describe('profile — exact all/all parity with the standings table', () => {
  /**
   * #72's binding criterion. Parity here is STRUCTURAL — both handlers consume one
   * `assembleStandings` — so this test is not what makes the numbers agree. What
   * it guards is a future change that separates the two paths, which is exactly
   * the drift a shared-intermediate comparison would miss (`3d-witness`).
   *
   * It compares the whole arm object rather than a chosen field, because a
   * per-field list is the shape that goes stale silently: add a field to
   * `WireArm` and a field-by-field test keeps passing while the new field is
   * unpinned (`3d`).
   */
  it('serves the same figures the table serves for that arm', async () => {
    const table = await run({ benchmark_scoring_runs: [OPEN_RUN] });
    const profile = await run({ benchmark_scoring_runs: [OPEN_RUN] }, {}, {}, undefined, FABLE);

    expect(table.status).toBe(200);
    expect(profile.status).toBe(200);
    expect(profile.body.found).toBe(true);

    const arms = table.body.arms as Array<Record<string, unknown>>;
    const fromTable = arms.find((a) => a.participantId === FABLE);
    expect(fromTable).toBeDefined();

    const m = profile.body.metrics as Record<string, unknown>;
    // The metric family and its denominators, whole.
    expect(m.scope).toBe('all-markets');
    expect(m.sample).toEqual(fromTable?.sample);
    expect(m.metrics).toEqual(fromTable?.metrics);
    // The headline pair, the per-market splits, the money and the chart.
    expect(profile.body.headline).toEqual({ ...(fromTable?.headline as object), scope: 'all-markets' });
    expect(profile.body.byMarket).toEqual(fromTable?.byMarket);
    expect(profile.body.executed).toEqual({ ...(fromTable?.executed as object), scope: 'all-markets' });
    expect((profile.body.series as Record<string, unknown>).points).toEqual(fromTable?.series);
    expect(profile.body.trend).toEqual(fromTable?.trend);
    // And the published context a reader needs to interpret them.
    expect(profile.body.scoringPolicyVersion).toEqual(table.body.scoringPolicyVersion);
    expect(profile.body.availableVersions).toEqual(table.body.availableVersions);
    expect(profile.body.publication).toEqual(table.body.publication);
    expect(profile.body.methodology).toEqual(table.body.methodology);
  });

  it('keeps parity under a sport filter and under a policy-version choice', async () => {
    for (const query of [{ sport: 'mlb' }, { scoringPolicyVersion: V1 }, { sport: 'all' }]) {
      const table = await run({ benchmark_scoring_runs: [OPEN_RUN] }, query);
      const profile = await run({ benchmark_scoring_runs: [OPEN_RUN] }, query, {}, undefined, FABLE);
      const arms = table.body.arms as Array<Record<string, unknown>>;
      const fromTable = arms.find((a) => a.participantId === FABLE);
      const m = profile.body.metrics as Record<string, unknown>;
      expect(m.metrics).toEqual(fromTable?.metrics);
      expect(m.sample).toEqual(fromTable?.sample);
      expect(profile.body.scoringPolicyVersion).toEqual(table.body.scoringPolicyVersion);
    }
  });
});

describe('profile — publishes no ranking', () => {
  /**
   * `standingsProject.ts` states that an order IS a ranking, and `3j-ordering`
   * extends it: a designated winner, a default sort key or a rendered position are
   * the same judgement in another costume. A single arm's own page is where a rank
   * looks most harmless and is exactly as much of a published ranking as the table.
   *
   * So the assertion is on the ABSENCE of a whole family of fields, over the
   * serialised body, rather than on one name — a handler that renamed `rank` to
   * `position` would pass a single-key check.
   */
  it.each([['rank'], ['position'], ['place'], ['percentile'], ['standing'], ['leader'], ['orderedBy']])(
    'serves no "%s" anywhere in the body',
    async (field) => {
      const { body } = await run({ benchmark_scoring_runs: [OPEN_RUN] }, {}, {}, undefined, FABLE);
      expect(JSON.stringify(body)).not.toContain(`"${field}"`);
    },
  );

  it('echoes the gate STATE without deriving anything from it', async () => {
    const open = await run({ benchmark_scoring_runs: [OPEN_RUN] }, {}, {}, undefined, FABLE);
    expect((open.body.ranking as Record<string, unknown>).allowed).toBe(true);
    expect((open.body.ranking as Record<string, unknown>).withheldBy).toEqual([]);

    // Withheld: the figures still serve, and still no rank. A profile that went
    // blank when ranking was withheld would be withholding the DATA rather than
    // the judgement, which is the opposite error.
    const shut = await run({}, {}, {}, undefined, FABLE);
    expect(shut.status).toBe(200);
    expect((shut.body.ranking as Record<string, unknown>).allowed).toBe(false);
    expect(shut.body.found).toBe(true);
    expect((shut.body.metrics as Record<string, unknown>).metrics).toBeDefined();
  });
});

describe('profile — a market filter scopes the metrics and says what it does not scope', () => {
  it('serves the per-market split, matching the table row for that market', async () => {
    const table = await run({ benchmark_scoring_runs: [OPEN_RUN] });
    const profile = await run(
      { benchmark_scoring_runs: [OPEN_RUN] }, { market: 'moneyline' }, {}, undefined, FABLE,
    );
    const arms = table.body.arms as Array<Record<string, unknown>>;
    const fromTable = arms.find((a) => a.participantId === FABLE);
    const split = (fromTable?.byMarket as Array<Record<string, unknown>>).find(
      (s) => s.market === 'moneyline',
    );
    const m = profile.body.metrics as Record<string, unknown>;
    expect(m).toMatchObject({ scope: 'market', market: 'moneyline' });
    expect(m.metrics).toEqual(split?.metrics);
    expect(m.sample).toEqual({
      eligible: split?.eligible, picks: split?.picks, scoreable: split?.scoreable,
    });
  });

  /**
   * The honesty requirement: every block carries its OWN scope, and the labels
   * differ within one response.
   *
   * `metrics`, `executed` and `roi` are market-scoped. `series` and `headline`
   * are pooled by nature — a series point is a cohort-day's figure across
   * markets and the headline is the basis over the whole sample — so they say
   * `all-markets` rather than pretending.
   *
   * Two earlier claims are superseded and deliberately paraphrased rather than
   * quoted, so a grep for them finds nothing (`3c`). The first version of this
   * docblock said a market-filtered request could not have market-scoped money
   * because the wire fill type carried no market; that was a limitation of the
   * projection, not of the source row, which carries a `market` (`3b-layer`).
   * The second said pooled money under an honest label was sufficient; #72 asks
   * for filtered risk and ROI, and a label saying a figure is pooled does not
   * make it filtered. Both were fixed in #88.
   */
  it('scopes the money to the market, and labels what still cannot be scoped', async () => {
    const { body } = await run(
      { ...FABLE_WITH_FILL, benchmark_scoring_runs: [OPEN_RUN] },
      { market: 'total' }, {}, undefined, FABLE,
    );
    expect((body.metrics as Record<string, unknown>).scope).toBe('market');
    expect((body.executed as Record<string, unknown>).scope).toBe('market');
    expect((body.roi as Record<string, unknown>).scope).toBe('market');
    // These two are pooled by nature: a series point is a cohort-day's figure
    // across markets, and the headline is the basis over the whole sample.
    expect((body.series as Record<string, unknown>).scope).toBe('all-markets');
    expect((body.headline as Record<string, unknown>).scope).toBe('all-markets');
  });

  /**
   * The blocker's property, pinned on the fixture that actually prices a fill.
   *
   * This arm's one priced fill is MONEYLINE. So `?market=moneyline` must answer its
   * 10 / +7 / 70%, and `?market=spread` and `?market=total` must answer NOTHING —
   * a handler that ignored the filter would answer the pooled 10 for all three,
   * which is exactly the defect review caught.
   *
   * WHAT THIS CASE UNIQUELY COVERS, now that `#89` has added the two-market
   * fixture below. This is the COINCIDENCE case: with one priced fill, the correct
   * market-scoped answer and the pooled answer are the same numbers, so it pins
   * that the empty markets stay empty and that the rollup invents no
   * unresolved-receipt count. What it cannot pin is the grouping KEY, because
   * every fill belongs to the same market — that is the two-market block's job,
   * and a mutant forcing every fill into `'moneyline'` survived until it existed.
   */
  it('serves the requested market’s risk, not the pooled figure', async () => {
    const tables = { ...FABLE_WITH_FILL, benchmark_scoring_runs: [OPEN_RUN] };
    const roi = (b: Record<string, unknown>): Record<string, number | null> =>
      b.roi as Record<string, number | null>;

    const pooled = await run(tables, {}, {}, undefined, FABLE);
    expect(roi(pooled.body).riskUsdc).toBe(10);
    expect(roi(pooled.body).netUsdc).toBe(7);
    expect(roi(pooled.body).pct).toBe(70);

    const ml = await run(tables, { market: 'moneyline' }, {}, undefined, FABLE);
    expect(roi(ml.body).riskUsdc).toBe(10);
    expect(roi(ml.body).netUsdc).toBe(7);
    expect(roi(ml.body).pct).toBe(70);
    // On the market that HAS fills: the rollup must invent no unresolved-receipt
    // count. An unresolved receipt was never bound to a priced fill, so it has no
    // market, and attributing one to a market would be a fabricated figure. This
    // has to be asserted here rather than on an empty market, where the summary is
    // absent and the zero comes from the empty default instead of from the rollup.
    expect((ml.body.executed as Record<string, unknown>).unresolvedFills).toBe(0);

    // The discriminating half: no fill on these markets, so no money on them.
    for (const market of ['spread', 'total']) {
      const other = await run(tables, { market }, {}, undefined, FABLE);
      expect(roi(other.body).riskUsdc).toBeNull();
      expect(roi(other.body).netUsdc).toBeNull();
      expect(roi(other.body).pct).toBeNull();
      expect((other.body.executed as Record<string, unknown>).fills).toBe(0);
      // A market rollup must invent NO unresolved-receipt count: an unresolved
      // receipt was never bound to a priced fill, so it has no market and
      // attributing one to a market would be a fabricated figure.
      expect((other.body.executed as Record<string, unknown>).unresolvedFills).toBe(0);
    }
  });

  /**
   * The one assertion that catches a wrong filter, a double count and a divergent
   * conversion together: the markets must SUM to the pooled totals.
   *
   * `unresolvedFills` is deliberately excluded — those receipts were never bound to
   * a priced fill, so they have no market and appear only in the pooled entry. That
   * is why a market response carries `unattributedFills` instead.
   */
  it('has the three markets sum to the pooled executed totals', async () => {
    const tables = { ...FABLE_WITH_FILL, benchmark_scoring_runs: [OPEN_RUN] };
    const pooled = (await run(tables, {}, {}, undefined, FABLE)).body.executed as Record<
      string,
      number | null
    >;
    // Annotated, like its two-market sibling below. Left bare this was the last
    // `yarn typecheck:tests` error in the repo (TS7034/TS7005, implicit any[]).
    const parts: Record<string, number | null>[] = [];
    for (const market of ['moneyline', 'spread', 'total']) {
      const { body } = await run(tables, { market }, {}, undefined, FABLE);
      parts.push(body.executed as Record<string, number | null>);
    }
    const sum = (k: string): number => parts.reduce((a, p) => a + (p[k] ?? 0), 0);
    expect(sum('fills')).toBe(pooled.fills);
    expect(sum('stakedUsdc')).toBe(pooled.stakedUsdc);
    expect(sum('netUsdc')).toBe(pooled.netUsdc);
    expect(sum('pendingStakeUsdc')).toBe(pooled.pendingStakeUsdc ?? 0);
    // And the pooled-only quantity is surfaced rather than attributed to a market.
    const ml = await run(tables, { market: 'moneyline' }, {}, undefined, FABLE);
    expect((ml.body.executed as Record<string, unknown>).unattributedFills).toBe(
      pooled.unresolvedFills,
    );
  });

  /**
   * `#89` — the two-priced-market case, which is what actually pins the grouping key.
   *
   * With one priced fill, the correct answer and the pooled answer COINCIDE on the
   * market that has it, so a mutant forcing every fill into `'moneyline'` changed
   * nothing any test could see. Two fills on different markets, with different
   * money, is the fixture where they diverge.
   */
  describe('profile — two priced markets', () => {
    const tables = { ...FABLE_TWO_MARKETS, benchmark_scoring_runs: [OPEN_RUN] };
    const roi = (b: Record<string, unknown>): Record<string, number | null> =>
      b.roi as Record<string, number | null>;
    const executed = (b: Record<string, unknown>): Record<string, number | null> =>
      b.executed as Record<string, number | null>;

    /**
     * THE SETUP ASSERTION, and it comes first for a reason (`3g-silentsetup`).
     *
     * The first attempt at this fixture produced a second receipt that silently
     * failed to bind to a priced fill, so the pooled total stayed at the first
     * fill's 10 — which is exactly what a broken market filter produces. A
     * fixture named for two markets that delivers one is worse than none, because
     * its name is what does the lying. So: both fills priced, nothing unresolved,
     * asserted before a single claim about the split.
     */
    it('prices BOTH fills, so the split below is about the filter', async () => {
      const { body } = await run(tables, {}, {}, undefined, FABLE);
      const e = executed(body);
      expect(e.fills).toBe(2);
      expect(e.stakedUsdc).toBe(40);
      // A receipt that failed to bind lands here instead, and it is the number
      // that tells a setup failure apart from a projection failure.
      expect(e.unresolvedFills).toBe(0);
    });

    it('answers three different money triples for the two markets and the pool', async () => {
      const pooled = await run(tables, {}, {}, undefined, FABLE);
      const ml = await run(tables, { market: 'moneyline' }, {}, undefined, FABLE);
      const total = await run(tables, { market: 'total' }, {}, undefined, FABLE);

      expect(roi(ml.body)).toMatchObject({ riskUsdc: 10, netUsdc: 7, pct: 70 });
      expect(roi(total.body)).toMatchObject({ riskUsdc: 30, netUsdc: -30, pct: -100 });
      expect(roi(pooled.body)).toMatchObject({ riskUsdc: 40, netUsdc: -23, pct: -57.5 });

      // The three are pairwise DISTINCT, which is the property a single-fill
      // fixture cannot have: there, the pooled and the one market's figures are
      // the same numbers, so answering either was indistinguishable.
      const triples = [ml, total, pooled].map((r) => JSON.stringify([
        roi(r.body).riskUsdc, roi(r.body).netUsdc, roi(r.body).pct,
      ]));
      expect(new Set(triples).size).toBe(3);
      // And the pooled net lands BETWEEN the two market nets rather than beside
      // either, so a response that answered one market's money for the pool is
      // refused by arithmetic and not only by a literal.
      expect(roi(pooled.body).netUsdc as number).toBeLessThan(roi(ml.body).netUsdc as number);
      expect(roi(pooled.body).netUsdc as number).toBeGreaterThan(roi(total.body).netUsdc as number);
    });

    it('keeps each market’s record and fill count its own', async () => {
      const ml = await run(tables, { market: 'moneyline' }, {}, undefined, FABLE);
      const total = await run(tables, { market: 'total' }, {}, undefined, FABLE);
      const spread = await run(tables, { market: 'spread' }, {}, undefined, FABLE);

      expect(executed(ml.body).fills).toBe(1);
      expect((ml.body.executed as Record<string, unknown>).record)
        .toMatchObject({ won: 1, lost: 0 });
      expect(executed(total.body).fills).toBe(1);
      expect((total.body.executed as Record<string, unknown>).record)
        .toMatchObject({ won: 0, lost: 1 });
      // The market with no fill still answers nothing rather than a pooled
      // figure — the negative control, on a fixture that now has money on two
      // markets to leak from.
      expect(executed(spread.body).fills).toBe(0);
      expect(roi(spread.body)).toMatchObject({ riskUsdc: null, netUsdc: null, pct: null });
    });

    it('has the two markets sum to the pooled totals', async () => {
      const pooled = executed((await run(tables, {}, {}, undefined, FABLE)).body);
      const parts: Record<string, number | null>[] = [];
      for (const market of ['moneyline', 'spread', 'total']) {
        parts.push(executed((await run(tables, { market }, {}, undefined, FABLE)).body));
      }
      const sum = (k: string): number => parts.reduce((a, p) => a + (p[k] ?? 0), 0);
      expect(sum('fills')).toBe(pooled.fills);
      expect(sum('stakedUsdc')).toBe(pooled.stakedUsdc);
      expect(sum('netUsdc')).toBe(pooled.netUsdc);
      // Stated because the single-fill version of this test could not: the sum is
      // now over two non-zero contributions, so a rollup that dropped one or
      // double-counted the other fails here rather than agreeing by coincidence.
      expect(parts.filter((p) => (p.fills ?? 0) > 0)).toHaveLength(2);
    });
  });

  /**
   * REPLACES a conditional test. The first version branched on
   * `if (marketPresent === false) … else …`, so it passed either way and the mutant
   * flipping that flag SURVIVED — an unfalsifiable test reading as coverage. The
   * branch it probed was dead code (`byMarket` is `MARKETS.map(...)`, so every
   * market always has a split) and is now deleted from the handler.
   *
   * The real property: an arm with no picks in a market gets a split of ZEROES
   * rather than an absence. GEMINI carries no score rows in this fixture.
   */
  it('serves a zeroed split for a market the arm never picked, not an absence', async () => {
    const { status, body } = await run(
      { benchmark_scoring_runs: [OPEN_RUN] }, { market: 'spread' }, {}, undefined, GEMINI,
    );
    expect(status).toBe(200);
    expect(body.found).toBe(true);
    const m = body.metrics as Record<string, unknown>;
    expect(m).toMatchObject({ scope: 'market', market: 'spread' });
    // `eligible: 1` beside `picks: 0` is the point, and it is why an absence would
    // be the wrong rendering: this arm WAS offered a spread on a dispatched game
    // and did not pick it. Opportunities and picks are different denominators,
    // which #72 asks to have documented, and a null would throw that away.
    expect(m.sample).toEqual({ eligible: 1, picks: 0, scoreable: 0 });
    expect(m.metrics).not.toBeNull();
  });

  /**
   * `picks` and `scoreable` are DIFFERENT denominators, and exactly one split in
   * this fixture can tell them apart: FABLE's `total` carries a REFUSED pick, so it
   * has a pick with no primary value. Everywhere else the two are equal, which is
   * why a mutant reporting `scoreable: split.picks` survived until this case
   * existed — the fixture was too tidy to discriminate (`3g`).
   */
  it('keeps picks and scoreable distinct, on the split where they differ', async () => {
    const table = await run({ benchmark_scoring_runs: [OPEN_RUN] });
    const profile = await run(
      { benchmark_scoring_runs: [OPEN_RUN] }, { market: 'total' }, {}, undefined, FABLE,
    );
    const arms = table.body.arms as Array<Record<string, unknown>>;
    const splits = arms.find((a) => a.participantId === FABLE)?.byMarket as Array<
      Record<string, unknown>
    >;
    const split = splits.find((s) => s.market === 'total');
    const sample = (profile.body.metrics as Record<string, unknown>).sample;
    // The assertion that makes this discriminate: here the two numbers differ.
    expect(split?.picks).not.toBe(split?.scoreable);
    expect(sample).toEqual({
      eligible: split?.eligible,
      picks: split?.picks,
      scoreable: split?.scoreable,
    });
  });
});

describe('profile — the ROI denominator ships with its own numerator', () => {
  /**
   * Verified against `executed.ts:296-307` rather than inferred from field names:
   * `stakedWei6` accumulates on EVERY fill unconditionally, while
   * `pendingStakeWei6` accumulates only for fills with no payout. So pending risk
   * is a SUBSET of staked, and `staked + pending` double-counts it — the
   * `3d-aggregate` shape where a money figure silently doubles.
   */
  it('divides by staked alone, which already includes pending risk', async () => {
    // FABLE_WITH_FILL, not the default tables: the default fixture gives this arm
    // NO executed money, so every assertion below would compare nulls and the
    // arithmetic would go unpinned. Verified by the battery — a mutant scaling the
    // percentage by ten survived while this test read the default fixture.
    const { body } = await run(
      { ...FABLE_WITH_FILL, benchmark_scoring_runs: [OPEN_RUN] },
      {},
      {},
      undefined,
      FABLE,
    );
    const roi = body.roi as Record<string, number | null | string>;
    const executed = body.executed as Record<string, number | null>;
    expect(roi.netUsdc).toBe(executed.netUsdc);
    expect(roi.riskUsdc).toBe(executed.stakedUsdc);
    expect(roi.pendingRiskUsdc).toBe(executed.pendingStakeUsdc);

    // Asserted UNCONDITIONALLY. Pinning that the fixture HAS money is what makes
    // the arithmetic below discriminate; the first version wrapped it in
    // `if (typeof … === 'number') … else expect(pct).toBeNull()`, which passes on a
    // wrong formula whenever the numbers happen to be null.
    expect(typeof roi.riskUsdc).toBe('number');
    expect(typeof roi.netUsdc).toBe('number');
    const net = roi.netUsdc as number;
    const risk = roi.riskUsdc as number;
    expect(risk).not.toBe(0);
    // Pending is INSIDE staked, so it can never exceed it — this is what reddens
    // if the denominator is ever changed to staked + pending.
    expect(roi.pendingRiskUsdc ?? 0).toBeLessThanOrEqual(risk);
    // And the quotient is derivable from the two numbers served beside it.
    expect(roi.pct).toBe(Math.round((10_000 * net) / risk) / 100);
  });

  /**
   * REVIEW ROUND. The basis used to say "net over SETTLED fills", and that was
   * false: `netWei6` accumulates whenever `payoutWei6` is non-null, and
   * `deriveExecutedVerdict` produces a payout for a `'predicted'` source (scores
   * posted, not yet settled) as well as a `'settled'` one.
   *
   * The pair below is what makes the label checkable rather than asserted. The
   * fixture's `chainHistory` carries a `SPECULATION_SETTLED` event; dropping just
   * that row leaves the contest's posted scores, so the verdict falls to the
   * predicted path — and the net is STILL counted, which is the whole point.
   */
  it('counts a PREDICTED payout in the numerator, and says so', async () => {
    const withoutSettle = {
      ...FABLE_WITH_FILL,
      chain_events: FABLE_WITH_FILL.chain_events.filter(
        (e) => (e as { event_name: string }).event_name !== 'SPECULATION_SETTLED',
      ),
      benchmark_scoring_runs: [OPEN_RUN],
    };
    const { body } = await run(withoutSettle, {}, {}, undefined, FABLE);
    const executed = body.executed as Record<string, unknown>;
    const source = executed.verdictSource as Record<string, number>;
    // The fixture really is predicted-only — without this the case could pass on a
    // settled fill and prove nothing about the label.
    expect(source.settled).toBe(0);
    expect(source.predicted).toBeGreaterThan(0);
    // And the predicted payout IS in the numerator.
    expect(executed.netUsdc).not.toBeNull();
    expect(executed.netUsdc).not.toBe(0);
    const basis = String((body.roi as Record<string, unknown>).basis);
    expect(basis).toContain('DECIDED');
    expect(basis).toContain('predicted');
    // The word that was wrong must not come back.
    expect(basis).not.toContain('SETTLED fills');
  });

  it('records a chain-settled verdict as settled — the control for the case above', async () => {
    const { body } = await run(
      { ...FABLE_WITH_FILL, benchmark_scoring_runs: [OPEN_RUN] }, {}, {}, undefined, FABLE,
    );
    const source = (body.executed as Record<string, unknown>).verdictSource as Record<
      string,
      number
    >;
    // With the settlement event present the provenance differs, which is what
    // proves the previous case's `settled: 0` was the fixture and not a constant.
    expect(source.settled).toBeGreaterThan(0);
  });

  /**
   * REPLACES another conditional test, which read
   * `if (riskUsdc === 0 || riskUsdc === null) expect(pct).toBeNull()` and so
   * asserted nothing when neither held.
   *
   * It also could not discriminate the guard it was aimed at: with no fills,
   * `EMPTY_WIRE_EXECUTED` sets BOTH `stakedUsdc` and `netUsdc` to null, so the
   * `netUsdc === null` clause answers first and `riskUsdc === 0` never decides
   * anything — the `3b` wrong-reason trap. A zero denominator beside a non-null net
   * needs every fill to carry zero risk, which the data model does not produce; that
   * clause is a guard against a REFACTOR defaulting `stakedUsdc` to 0, after which
   * `net / 0` would ship as Infinity. It is recorded as a documented-equivalent
   * survivor in the battery rather than pretended to be covered.
   */
  it('reports an undefined ratio as null rather than as a zero return', async () => {
    const { body } = await run(
      { benchmark_execution_fills: [], position_fills: [], chain_events: [] },
      {}, {}, undefined, GEMINI,
    );
    const roi = body.roi as Record<string, unknown>;
    // Nothing at risk and nothing settled: null throughout, and `pct` null rather
    // than 0, because an undefined ratio and a break-even return are different
    // claims. Unconditional.
    expect(roi.riskUsdc).toBeNull();
    expect(roi.netUsdc).toBeNull();
    expect(roi.pct).toBeNull();
  });
});

describe('profile — absences, validation and the gate', () => {
  it('serves sources and notebook as null by contract, not by omission', async () => {
    const { body } = await run({ benchmark_scoring_runs: [OPEN_RUN] }, {}, {}, undefined, FABLE);
    // #72: evidence-reference URLs need a producer (artifact source_path/sha256
    // are provenance, not citations), and the notebook must stay absent until
    // editorial data exists. Present-and-null says "known to be missing"; absent
    // would say "forgotten".
    expect('sources' in body).toBe(true);
    expect('notebook' in body).toBe(true);
    expect(body.sources).toBeNull();
    expect(body.notebook).toBeNull();
  });

  it('answers not_on_roster for an unknown arm, distinct from an arm with no picks', async () => {
    const { status, body } = await run(
      { benchmark_scoring_runs: [OPEN_RUN] }, {}, {}, undefined, 'nobody-at-all',
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ found: false, reason: 'not_on_roster', arm: null, roi: null });
  });

  it('answers not_published with NO read at all when the gate is unset', async () => {
    const { status, body, fake } = await run(
      {}, {}, { benchmarkPublicMinSlateDate: undefined }, undefined, FABLE,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ found: false, reason: 'not_published' });
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ['an unknown sport', { sport: 'quidditch' }],
    ['an unknown market', { market: 'parlay' }],
    ['a market differing only in case', { market: 'Moneyline' }],
    ['an impossible date', { date: '2026-02-30' }],
    ['a malformed date', { date: '15-08-2026' }],
    ['an empty scoringPolicyVersion', { scoringPolicyVersion: '' }],
  ])('refuses %s with 400 before any read', async (_why, query) => {
    const { status, body, fake } = await run({}, query, {}, undefined, FABLE);
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_PARAM');
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ['a real leap day', { date: '2024-02-29' }],
    ['sport=all', { sport: 'all' }],
    ['each executed market', { market: 'moneyline' }],
  ])('accepts %s — the control the refusals need', async (_why, query) => {
    const { status } = await run({ benchmark_scoring_runs: [OPEN_RUN] }, query, {}, undefined, FABLE);
    expect(status).toBe(200);
  });
});
