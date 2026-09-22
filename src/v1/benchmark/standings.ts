/**
 * GET /v1/benchmark/standings — the model-arm leaderboard.
 *
 * Signer-free and unauthenticated, like every other `/v1` read: the acceptance
 * for this surface is that an auditor holding only the Supabase anon key can
 * reproduce the published numbers.
 *
 * This docblock used to add that the anon key could reach none of the
 * underlying schema. That held for migration 073 and stopped holding at
 * 082/083/086, which grant anon SELECT on the relations this endpoint
 * aggregates — verified with the anon key alone. (Paraphrased rather than
 * quoted on purpose: a grep for the old sentence should find nothing.)
 * What survives is the part that never depended on it: the
 * numbers are computed once, server-side, from one vocabulary, and the
 * `service_role` key never leaves this process.
 *
 * This file is the I/O half. Every number is computed in `standingsProject.ts`,
 * which is pure and is where the tests live.
 *
 * ## The two gates, which answer different questions
 *
 * **May this cohort be shown at all** — `BENCHMARK_PUBLIC_MIN_SLATE_DATE`, a
 * config var. Unset ⇒ nothing. See `lib/env.ts`.
 *
 * **May it be ordered** — `benchmark_scoring_runs.ranking_allowed`, per
 * `(cohort, scoring policy version)`, absent or false ⇒ withheld. Withheld
 * means the front end prints no rank column; the numbers and the server's own
 * ordering are still served, because work-order ruling 4 says the projection
 * "serves metrics with ranking withheld" and migration 073's column comment
 * constrains only sorting ("a UI must not sort participants when it is false").
 *
 * ## Why the scoring policy version is pinned, and why to BOTH sides
 *
 * `benchmark_scores` is `UNIQUE (decision_id, scoring_policy_version)` with no
 * UPDATE grant, so a re-score ADDS a row beside the old one. All 1,299 live
 * rows are `scoring-v0.6.1` and the scorer is now at v0.6.2, so the first
 * re-score gives every decision two rows — and an unpinned aggregate would pool
 * two methodologies and roughly double every count, overnight, with no operator
 * action and nothing red. The defect is invisible on today's single-version
 * data, which is exactly why it is pinned here and pinned by a two-version
 * fixture in the tests rather than left to be discovered.
 */

import type { Request, Response } from 'express';
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { loadConfig, type HeadlineBasis } from '../../lib/env.js';
import { getSupabase } from '../../lib/supabase.js';
import { SPORTS as VALID_SPORTS, type Sport } from '../../lib/sports.js';
import type { ApiError } from '../../middleware/errorHandler.js';
import {
  BENCHMARK,
  POSTGREST_PAGE,
  chunkIds,
  readAllByKeyset,
  respondProjectionFault,
  respondToQueryError,
} from './source.js';
import { parseSlateDate, parseSportParam, resolveWindow, type ResolvedWindow } from './window.js';
import {
  METHODOLOGY,
  featuredOf,
  orderArms,
  projectArms,
  projectBaselines,
  type RosterEntry,
  type ScoredPickRow,
  type ScoringRunRow,
  type WalletBinding,
  type WireArm,
  type WireBaseline,
} from './standingsProject.js';
import { collectExecuted } from './executedFetch.js';
import type { ExecutedSummary } from './executed.js';
import type { ScorerAddresses } from '../../lib/speculation.js';

/**
 * Score-row read bound, a backstop behind the cohort window rather than a
 * limit. 60 cohort-days at the measured ~216 rows per scored day is ~13k; a
 * 400-day window at a full 15-game slate's ~300 is ~120k. Exceeding this
 * RAISES — see `readAllByKeyset` for why a truncated aggregate is worse than
 * no aggregate.
 */
const SCORE_READ_CAP = 200_000;

interface ScoreDbRow {
  id: number;
  scoring_policy_version: string;
  held_out_of_primary: boolean | null;
  refused: boolean;
  refusal_reason: string | null;
  economic_clv_pct: number | null;
  margin_adjusted_clv_pct: number | null;
  scored_at: string;
  benchmark_decisions: {
    cohort_id: string;
    participant_id: string;
    game_id: string;
    market: string;
  };
}

/**
 * The score-row select.
 *
 * `!inner` is not decoration. Measured against production: the same query with
 * a plain `benchmark_decisions(...)` embed and a `benchmark_decisions.cohort_id`
 * filter returns **1299** rows instead of **17** — PostgREST applies the filter
 * to the embed only, so every non-matching parent comes back with a null embed
 * and the aggregator either throws on the null or buckets 1,282 rows under
 * `undefined`. A 76x count inflation that no fixture built from production
 * shape would catch.
 */
const SCORE_SELECT =
  'id, scoring_policy_version, held_out_of_primary, refused, refusal_reason, ' +
  'economic_clv_pct, margin_adjusted_clv_pct, scored_at, ' +
  'benchmark_decisions!inner(cohort_id, participant_id, game_id, market)';

interface VersionCoverage {
  version: string;
  cohortCount: number;
  latestScoredAt: string;
}

/**
 * Which policy version to serve.
 *
 * The version covering the MOST cohorts in the window, ties broken by the
 * latest `scored_at`.
 *
 * Not `max(scored_at)` alone, which was the obvious rule and is wrong in both
 * directions. `scored_at` is the artifact header's scoring time, not a
 * publication clock — Part 2 lists it among the fields deliberately EXCLUDED
 * from the drift comparison precisely because it moves on a legitimate
 * re-score. So a re-score campaign that starts with the OLDEST cohort (1 run,
 * 17 decisions) would give it the global max, and the public standings would
 * collapse from nine cohorts to one — a ~50x sample drop, with the leader free
 * to flip, while nothing about the other eight changed. Coverage cannot do
 * that: a partial re-score never displaces a complete version until it has
 * actually overtaken it.
 *
 * `?scoringPolicyVersion=` overrides, which is also what makes a
 * single-version audit expressible.
 */
export function resolvePolicyVersion(rows: readonly ScoreDbRow[]): {
  version: string | null;
  available: VersionCoverage[];
} {
  const byVersion = new Map<string, { cohorts: Set<string>; latest: string }>();
  for (const r of rows) {
    const entry = byVersion.get(r.scoring_policy_version) ?? {
      cohorts: new Set<string>(),
      latest: r.scored_at,
    };
    entry.cohorts.add(r.benchmark_decisions.cohort_id);
    if (r.scored_at > entry.latest) entry.latest = r.scored_at;
    byVersion.set(r.scoring_policy_version, entry);
  }
  const available: VersionCoverage[] = [...byVersion.entries()]
    .map(([version, v]) => ({
      version,
      cohortCount: v.cohorts.size,
      latestScoredAt: v.latest,
    }))
    .sort(
      (a, b) =>
        b.cohortCount - a.cohortCount ||
        b.latestScoredAt.localeCompare(a.latestScoredAt) ||
        a.version.localeCompare(b.version),
    );
  return { version: available[0]?.version ?? null, available };
}

async function fetchScores(
  sb: SupabaseClient,
  network: string,
  cohortIds: readonly string[],
): Promise<{ rows: ScoreDbRow[]; error: PostgrestError | null }> {
  const rows: ScoreDbRow[] = [];
  for (const chunk of chunkIds(cohortIds, 50)) {

    const page = await readAllByKeyset<ScoreDbRow, number>(
      BENCHMARK.scores,
      SCORE_READ_CAP,
      (r) => r.id,
      (after, limit) => {
        let q = sb
          .from(BENCHMARK.scores)
          .select(SCORE_SELECT)
          .eq('benchmark_decisions.network', network)
          .in('benchmark_decisions.cohort_id', chunk)
          // Ascending id reproduces the order the scored artifact was written
          // in, and that order is part of the contract: `mean()` sums in array
          // order and float addition is not associative.
          .order('id', { ascending: true })
          .limit(limit);
        if (after !== null) q = q.gt('id', after);
        return q as unknown as PromiseLike<{
          data: ScoreDbRow[] | null;
          error: PostgrestError | null;
        }>;
      },
    );
    if (page.error) return { rows, error: page.error };
    rows.push(...page.rows);
  }
  return { rows, error: null };
}

interface Collected {
  roster: RosterEntry[];
  wallets: WalletBinding[];
  scoringRuns: ScoringRunRow[];
  scores: ScoreDbRow[];
}

/** Split a roster by participant kind. */
function splitRoster(roster: readonly RosterEntry[]): {
  models: RosterEntry[];
  baselines: RosterEntry[];
} {
  return {
    models: roster.filter((r) => r.kind === 'model'),
    baselines: roster.filter((r) => r.kind === 'baseline'),
  };
}

async function collect(
  sb: SupabaseClient,
  network: string,
  cohortIds: readonly string[],
): Promise<{ data: Collected } | { error: PostgrestError; context: string }> {
  const cohortRes = await Promise.all(
    chunkIds(cohortIds, 50).map((chunk) =>
      sb
        .from(BENCHMARK.cohortParticipants)
        .select('cohort_id, participant_id')
        .eq('network', network)
        .in('cohort_id', chunk)
        .limit(POSTGREST_PAGE),
    ),
  );
  for (const r of cohortRes) {
    if (r.error) return { error: r.error, context: BENCHMARK.cohortParticipants };
  }
  const cohortRows = cohortRes.flatMap(
    (r) => (r.data ?? []) as unknown as Array<{ cohort_id: string; participant_id: string }>,
  );

  const participantIds = [...new Set(cohortRows.map((r) => r.participant_id))];
  const identityRes =
    participantIds.length === 0
      ? { data: [], error: null }
      : await sb
          .from(BENCHMARK.participants)
          .select('participant_id, kind, lab_id, display_name, model_id')
          .in('participant_id', participantIds)
          .limit(POSTGREST_PAGE);
  if (identityRes.error) return { error: identityRes.error, context: BENCHMARK.participants };
  const identity = new Map(
    (
      (identityRes.data ?? []) as unknown as Array<{
        participant_id: string;
        kind: string;
        lab_id: string | null;
        display_name: string;
        model_id: string | null;
      }>
    ).map((p) => [p.participant_id, p]),
  );

  // Both kinds are carried; the handler splits them into `arms` and
  // `baselines`. A participant the roster names but `benchmark_participants`
  // does not is dropped rather than served with a fabricated identity - it
  // cannot happen (a foreign key binds them) and the branch says so.
  const roster: RosterEntry[] = [];
  for (const row of cohortRows) {
    const id = identity.get(row.participant_id);
    if (id === undefined) continue;
    roster.push({
      cohortId: row.cohort_id,
      participantId: row.participant_id,
      kind: id.kind,
      displayName: id.display_name,
      labId: id.lab_id,
      modelId: id.model_id,
    });
  }

  const walletRes = await Promise.all(
    chunkIds(cohortIds, 50).map((chunk) =>
      sb
        .from(BENCHMARK.cohortWallets)
        .select('cohort_id, participant_id, wallet_address')
        .eq('network', network)
        .in('cohort_id', chunk)
        .limit(POSTGREST_PAGE),
    ),
  );
  for (const r of walletRes) {
    if (r.error) return { error: r.error, context: BENCHMARK.cohortWallets };
  }
  const wallets: WalletBinding[] = walletRes.flatMap((r) =>
    (
      (r.data ?? []) as unknown as Array<{
        cohort_id: string;
        participant_id: string;
        wallet_address: string;
      }>
    ).map((w) => ({
      cohortId: w.cohort_id,
      participantId: w.participant_id,
      walletAddress: w.wallet_address,
    })),
  );

  const runRes = await Promise.all(
    chunkIds(cohortIds, 50).map((chunk) =>
      sb
        .from(BENCHMARK.scoringRuns)
        .select(
          'cohort_id, scoring_policy_version, eligible, scored, refused, schedule_held_out, ' +
            'refusal_reasons, ranking_allowed, ranking_reason, cost_per_pick_comparable',
        )
        .in('cohort_id', chunk)
        .limit(POSTGREST_PAGE),
    ),
  );
  for (const r of runRes) {
    if (r.error) return { error: r.error, context: BENCHMARK.scoringRuns };
  }
  const scoringRuns: ScoringRunRow[] = runRes.flatMap((r) =>
    (
      (r.data ?? []) as unknown as Array<{
        cohort_id: string;
        scoring_policy_version: string;
        eligible: number;
        scored: number;
        refused: number;
        schedule_held_out: number;
        refusal_reasons: Record<string, number> | null;
        ranking_allowed: boolean | null;
        ranking_reason: string;
        cost_per_pick_comparable: boolean | null;
      }>
    ).map((row) => ({
      cohortId: row.cohort_id,
      scoringPolicyVersion: row.scoring_policy_version,
      eligible: row.eligible,
      scored: row.scored,
      refused: row.refused,
      scheduleHeldOut: row.schedule_held_out,
      refusalReasons: row.refusal_reasons ?? {},
      // "A NULL here must be read as false" — migration 073's own comment. The
      // column is NOT NULL today; the coalesce is the guard, not a workaround.
      rankingAllowed: row.ranking_allowed === true,
      rankingReason: row.ranking_reason,
      costPerPickComparable: row.cost_per_pick_comparable,
    })),
  );

  const scores = await fetchScores(sb, network, cohortIds);
  if (scores.error) return { error: scores.error, context: BENCHMARK.scores };

  return { data: { roster, wallets, scoringRuns, scores: scores.rows } };
}

/** The reason served when no cohort has a published scoring run at all. */
const NO_SCORING_RUN_REASON =
  'no scoring run has been published for the cohorts in this window';

/**
 * Everything both the standings table and a single model's profile need, read and
 * projected ONCE.
 *
 * ## Why this is a shared function and not a second read path
 *
 * `/v1/benchmark/profile/...` has to agree with this table exactly - #72 words it
 * as "exact all/all parity". The only way to get that is for the profile's numbers
 * to BE these numbers: same reads, same sport scope, same policy-version choice,
 * same `projectArms`. A profile that re-derived an arm's figures from
 * `benchmark_model_aggregates` would agree on the day it was written and drift
 * afterwards - and a test comparing two derivations that meet at a shared
 * intermediate would not notice (`3d-witness`).
 *
 * So the seam is ASSEMBLE here, then each handler decides what to serve of it. The
 * standings handler orders the arms and publishes the table; the profile handler
 * picks one arm and publishes no order at all.
 *
 * ## What it deliberately does NOT do
 *
 * It does not call `orderArms` or `featuredOf`. Both ARE rankings, both are gated
 * on `rankingAllowed`, and only the table publishes one. Keeping them outside this
 * function is what stops the profile leaking an order by accident.
 *
 * Projection faults are THROWN rather than returned, because both callers already
 * answer them identically through `respondProjectionFault`. Query errors are
 * RETURNED, because they carry the relation name each caller reports.
 */
export type AssembledStandings =
  | {
      kind: 'ok';
      win: ResolvedWindow;
      /** The policy version actually used - the request's, or the resolved default. */
      version: string | null;
      available: VersionCoverage[];
      /** Model arms, projected. Roster-driven, so an arm with no scores is present. */
      arms: WireArm[];
      baselines: WireBaseline[];
      /** Cohorts that contributed at least one scored pick at `version`. */
      /**
       * The executed rollup split by (participant, market), keyed by
       * `armMarketKey`. Built from the same fills and the same
       * `summarizeExecuted` as the pooled figure inside each arm, so a
       * market-scoped money figure is one arithmetic over a subset. The table
       * does not use it; the profile serves #72's filtered risk and ROI from it.
       */
      executedByMarket: ReadonlyMap<string, ExecutedSummary>;
      cohortsWithScores: Set<string>;
      scoringRunByCohort: Map<string, ScoringRunRow>;
      rankingAllowed: boolean;
      withheldBy: Array<{ cohortId: string; reason: string }>;
    }
  | { kind: 'empty'; win: ResolvedWindow }
  | { kind: 'queryError'; error: PostgrestError; context: string };

export async function assembleStandings(
  sb: SupabaseClient,
  config: {
    network: string;
    benchmarkPublicMinSlateDate?: string | undefined;
    benchmarkStandingsWindowDays: number;
    benchmarkHeadlineBasis: HeadlineBasis;
    scorers: ScorerAddresses | undefined;
  },
  params: {
    sport?: Sport | 'all' | undefined;
    slateDate?: string | undefined;
    requestedVersion?: string | undefined;
  },
): Promise<AssembledStandings> {
  const { sport, slateDate, requestedVersion } = params;

  const windowRes = await resolveWindow(sb, {
    network: config.network,
    minSlateDate: config.benchmarkPublicMinSlateDate,
    windowDays: config.benchmarkStandingsWindowDays,
    ...(sport !== undefined && sport !== 'all' ? { sport } : {}),
    ...(slateDate !== undefined ? { slateDate } : {}),
  });
  if (!windowRes.ok) {
    return { kind: 'queryError', error: windowRes.error, context: windowRes.context };
  }
  const win = windowRes.window;
  if (win.cohorts.length === 0) return { kind: 'empty', win };

  const cohortIds = win.cohorts.map((c) => c.cohortId);
  const collected = await collect(sb, config.network, cohortIds);
  if ('error' in collected) {
    return { kind: 'queryError', error: collected.error, context: collected.context };
  }

  // SPORT SCOPE, applied before anything reads the rows.
  //
  // `resolveWindow` filters each cohort's game list by sport, but the score and
  // fill reads are scoped by COHORT - so on a mixed-sport cohort every
  // out-of-scope row came back too, and fed the policy-version choice, the
  // means, the counts, the ordering and the executed totals. Every cohort on
  // production is 100% MLB today, so nothing leaked in practice and no
  // production-shaped fixture could have caught it; the benchmark adding a
  // second sport is what would have made it real. Caught in review.
  //
  // Filtering here rather than in the query keeps it in ONE place for both
  // streams: `cohort.gameIds` is already the sport-scoped set, and the
  // alternative - pushing a game-id list into every read - would be a second
  // definition of the same scope that could drift from the first.
  const inScopeGames = new Set(win.cohorts.flatMap((c) => c.gameIds));
  const scopedScoreRows = collected.data.scores.filter((r) =>
    inScopeGames.has(r.benchmark_decisions.game_id),
  );

  const { version: defaultVersion, available } = resolvePolicyVersion(scopedScoreRows);
  const version = requestedVersion ?? defaultVersion;

  const atVersion = scopedScoreRows.filter((r) => r.scoring_policy_version === version);
  const scores: ScoredPickRow[] = atVersion.map((r) => ({
    cohortId: r.benchmark_decisions.cohort_id,
    participantId: r.benchmark_decisions.participant_id,
    gameId: r.benchmark_decisions.game_id,
    market: r.benchmark_decisions.market,
    heldOutOfPrimary: r.held_out_of_primary,
    refused: r.refused,
    refusalReason: r.refusal_reason,
    economicClvPct: r.economic_clv_pct,
    marginAdjustedClvPct: r.margin_adjusted_clv_pct,
  }));

  const cohortsWithScores = new Set(scores.map((s) => s.cohortId));

  const fills = await collectExecuted(sb, config.network, cohortIds, config.scorers, inScopeGames);
  if ('error' in fills) {
    return { kind: 'queryError', error: fills.error, context: fills.context };
  }
  const executed = fills.byParticipant;
  const executedByMarket = fills.byParticipantMarket;

  const slateDateByCohort = new Map(win.cohorts.map((c) => [c.cohortId, c.slateDate]));
  const { models, baselines: baselineRoster } = splitRoster(collected.data.roster);
  const modelIds = new Set(models.map((r) => r.participantId));
  const baselineIds = new Set(baselineRoster.map((r) => r.participantId));

  const arms = projectArms({
    roster: models,
    scores: scores.filter((s) => modelIds.has(s.participantId)),
    attempts: win.attempts,
    wallets: collected.data.wallets,
    executed,
    cohortOrder: cohortIds,
    slateDateByCohort,
    headlineBasis: config.benchmarkHeadlineBasis,
  });
  const baselines: WireBaseline[] = projectBaselines(
    baselineRoster,
    scores.filter((s) => baselineIds.has(s.participantId)),
    config.benchmarkHeadlineBasis,
    cohortIds,
  );

  // Ranking is unanimous or it is withheld. One cohort whose operator has not
  // opened the gate is enough: the table is a single ordering over a pooled
  // sample, so a partially-approved sample has not been approved.
  const runsAtVersion = collected.data.scoringRuns.filter(
    (r) => version !== null && r.scoringPolicyVersion === version,
  );
  const scoringRunByCohort = new Map(runsAtVersion.map((r) => [r.cohortId, r]));
  const contributing = [...cohortsWithScores];
  const withheldBy = contributing
    .filter((c) => scoringRunByCohort.get(c)?.rankingAllowed !== true)
    .sort()
    .map((cohortId) => ({
      cohortId,
      reason: scoringRunByCohort.get(cohortId)?.rankingReason ?? NO_SCORING_RUN_REASON,
    }));
  const rankingAllowed = contributing.length > 0 && withheldBy.length === 0;

  return {
    kind: 'ok',
    win,
    version,
    available,
    arms,
    baselines,
    executedByMarket,
    cohortsWithScores,
    scoringRunByCohort,
    rankingAllowed,
    withheldBy,
  };
}

export async function getBenchmarkStandingsHandler(req: Request, res: Response): Promise<void> {
  const sport = parseSportParam(req.query.sport);
  if (sport === 'invalid') {
    res.status(400).json({
      error: `Invalid "sport". Must be "all" or one of: ${[...VALID_SPORTS].sort().join(', ')}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  let slateDate: string | undefined;
  if (req.query.date !== undefined) {
    // Calendar validity, not just shape: `date=2026-02-30` was shape-valid, reached
    // Postgres as a 22008 and answered 500 on the deployed service — measured
    // 2026-09-22. See `parseSlateDate`.
    const parsed = parseSlateDate(req.query.date);
    if (parsed === 'invalid') {
      res.status(400).json({
        error: 'date must be a real calendar date in YYYY-MM-DD form.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    slateDate = parsed;
  }

  const requestedVersion =
    req.query.scoringPolicyVersion === undefined
      ? undefined
      : String(req.query.scoringPolicyVersion);
  // `?scoringPolicyVersion=` is malformed, not "the default": the other two
  // params already refuse their empty spelling, and an empty literal would
  // otherwise serve an empty table labelled ''.
  if (requestedVersion !== undefined && requestedVersion.trim() === '') {
    res.status(400).json({
      error: 'scoringPolicyVersion must be a non-empty version string.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const config = loadConfig();
  const sb = getSupabase();

  let assembled: AssembledStandings;
  try {
    assembled = await assembleStandings(
      sb,
      {
        network: config.network,
        benchmarkPublicMinSlateDate: config.benchmarkPublicMinSlateDate,
        benchmarkStandingsWindowDays: config.benchmarkStandingsWindowDays,
        benchmarkHeadlineBasis: config.benchmarkHeadlineBasis,
        scorers: config.scorers,
      },
      { sport, slateDate, requestedVersion },
    );
  } catch (err) {
    if (respondProjectionFault(res, err)) return;
    throw err;
  }
  if (assembled.kind === 'queryError') {
    respondToQueryError(res, assembled.error, assembled.context);
    return;
  }
  if (assembled.kind === 'empty') {
    res
      .status(200)
      .json(emptyBody(sport ?? null, config.network, assembled.win, requestedVersion ?? null));
    return;
  }

  const {
    win,
    version,
    available,
    arms: projected,
    baselines,
    cohortsWithScores,
    scoringRunByCohort: runByCohort,
    rankingAllowed,
    withheldBy,
  } = assembled;


  // Ordering is gated on the same flag, because an order IS a ranking — see
  // `orderArms`. The seed keeps the neutral order stable within a cohort-day.
  const ordered = orderArms(projected, rankingAllowed, win.activeCohortId ?? win.standingsThrough ?? '');
  const arms = ordered.arms;

  res.status(200).json({
    sport: sport ?? null,
    network: config.network,
    publication: {
      minSlateDate: win.minSlateDate,
      cohortsPublished: win.cohortsPublished,
      cohortsInWindow: win.cohorts.length,
      cohortsScored: cohortsWithScores.size,
      windowDays: win.windowDays,
      standingsThrough: win.standingsThrough,
    },
    activeCohortId: win.activeCohortId,
    upcomingCohortId: win.upcomingCohortId,
    availableSports: win.availableSports,
    scoringPolicyVersion: version,
    availableVersions: available,
    ranking: {
      allowed: rankingAllowed,
      /**
       * `headline` only when the gate is open; `neutral` is a deterministic
       * hash carrying no meaning. A consumer must not re-sort either way — the
       * served order is the whole contract.
       */
      orderedBy: ordered.orderedBy,
      withheldBy,
    },
    featured: featuredOf(arms, rankingAllowed),
    methodology: METHODOLOGY,
    cohorts: win.cohorts.map((c) => {
      const run = runByCohort.get(c.cohortId);
      return {
        cohortId: c.cohortId,
        slateDate: c.slateDate,
        games: c.gameIds.length,
        benchmarkCommit: c.benchmarkCommit,
        benchmarkCommits: c.benchmarkCommits,
        scored: cohortsWithScores.has(c.cohortId),
        // The operator's own published coverage statement, verbatim and
        // labelled as theirs. NOT recomputed: `eligible` needs the attempt
        // rows and `scheduleHeldOut` is the tagged-AND-valued count, which is
        // a different population from the raw tag this service can see.
        operatorCoverage:
          run === undefined
            ? null
            : {
                eligible: run.eligible,
                scored: run.scored,
                refused: run.refused,
                scheduleHeldOut: run.scheduleHeldOut,
                refusalReasons: run.refusalReasons,
                rankingAllowed: run.rankingAllowed,
                rankingReason: run.rankingReason,
                costPerPickComparable: run.costPerPickComparable,
              },
      };
    }),
    arms,
    baselines,
  });
}

function emptyBody(
  sport: string | null,
  network: string,
  win: ResolvedWindow,
  requestedVersion: string | null,
): Record<string, unknown> {
  return {
    sport,
    network,
    publication: {
      minSlateDate: win.minSlateDate,
      cohortsPublished: win.cohortsPublished,
      cohortsInWindow: 0,
      cohortsScored: 0,
      windowDays: win.windowDays,
      standingsThrough: null,
    },
    activeCohortId: null,
    upcomingCohortId: null,
    availableSports: [],
    scoringPolicyVersion: requestedVersion,
    availableVersions: [],
    ranking: { allowed: false, orderedBy: 'neutral', withheldBy: [] },
    featured: { leaderParticipantId: null, runnerUpParticipantId: null },
    methodology: METHODOLOGY,
    cohorts: [],
    arms: [] as WireArm[],
    baselines: [] as WireBaseline[],
  };
}
