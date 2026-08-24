/**
 * Which benchmark cohorts are public, which one is live right now, and what
 * sport each of their games is.
 *
 * Shared by all three `/v1/benchmark/*` endpoints, because all three answer the
 * same two questions first: what may be shown, and over what period.
 *
 * ## The publication gate is a DATE, and it is the only one
 *
 * A cohort is public iff its `slate_date` is on or after
 * `BENCHMARK_PUBLIC_MIN_SLATE_DATE` (see `lib/env.ts` for why it lives in
 * config rather than the database). Unset ⇒ nothing is public, and the
 * endpoints answer 200 with empty collections.
 *
 * Deliberately NOT a second gate on `benchmark_scoring_runs`. That row answers
 * a different question — may these numbers be ORDERED — and work-order ruling 4
 * says so in plain words: "absent or false `ranking_allowed` → the projection
 * serves metrics with ranking withheld." Making an absent row also mean "show
 * nothing" would put two levers on one decision, and the more consequential of
 * the two would be an insert-once row that `benchmark_writer` can write and
 * nothing in this service can withdraw (migration 074 left `service_role` with
 * SELECT only).
 *
 * ## Why `activeCohortId` is resolved from the GAMES and not from the calendar
 *
 * Both obvious rules are measurably wrong, because cohorts overlap in
 * wall-clock time. Measured on production: cohort `watch-v0-2026-08-23`'s first
 * run started **2026-08-22T21:40:22Z**, with its decisions revealed ~23ms after
 * seal. So from 21:40Z on the 22nd, `max(slate_date)` names TOMORROW's
 * two-game cohort while tonight's fifteen games are still being played — the
 * landing page's pick-of-the-day would silently jump a day every evening.
 * `slate_date = today's UTC date` fails the other way: it returns nothing
 * between 00:00Z and whenever the run fires (2026-08-15's only run started
 * 05:43Z).
 *
 * So the active cohort is the one whose SLATE WINDOW — earliest to latest start
 * across its own games — contains now; failing that, the most recent window
 * that has already ended. The next one is exposed separately as
 * `upcomingCohortId` rather than being allowed to displace it.
 *
 * `activeCohortId` scopes the picks and schedule sections. It never scopes the
 * standings: a cohort cannot be scored until its games have finished, so the
 * active cohort is structurally the one cohort with no scores yet.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PostgrestError } from '@supabase/supabase-js';
import { effectiveMatchTime, parseTimestampMicros } from '../utils/gameTime.js';
import { isSport, type Sport } from '../../lib/sports.js';
import { BENCHMARK, POSTGREST_PAGE, chunkIds, readAllByKeyset } from './source.js';

/** One published cohort-day. */
export interface CohortWindowEntry {
  cohortId: string;
  /** `YYYY-MM-DD`, the benchmark's own day dimension. */
  slateDate: string;
  runIds: string[];
  gameIds: string[];
  /**
   * The build that produced the runs, when every run in the cohort agrees.
   * `null` when they do not — a cohort spanning two builds has no single
   * commit, and serving one of them would name a build that produced only some
   * of the numbers. Uniform across all 98 runs on production 2026-08-24.
   */
  benchmarkCommit: string | null;
  /** Every distinct commit in the cohort, so a disagreement is inspectable. */
  benchmarkCommits: string[];
  /** Earliest / latest start across this cohort's games, or null when unknown. */
  slateStart: string | null;
  slateEnd: string | null;
}

/** A `games` row, reduced to what the benchmark endpoints project. */
export interface BenchmarkGame {
  gameId: string;
  sport: string;
  slug: string;
  /** The bounded minimum `/v1/games` serves, NOT the raw `match_time`. */
  matchTime: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
  finalType: string | null;
}

export interface ResolvedWindow {
  /** The gate, echoed. `null` ⇒ unset ⇒ nothing is published. */
  minSlateDate: string | null;
  /** Cohorts inside the served window, oldest first. */
  cohorts: CohortWindowEntry[];
  /** Cohorts past the gate BEFORE the window bound — so a bound that bit is visible. */
  cohortsPublished: number;
  windowDays: number;
  activeCohortId: string | null;
  upcomingCohortId: string | null;
  /** Max `slateDate` over `cohorts`, or null. What the standings actually cover. */
  standingsThrough: string | null;
  games: Map<string, BenchmarkGame>;
  /** Distinct sports with at least one game in the window, sorted. */
  availableSports: string[];
  /** Dispatch rows for the windowed cohorts, already sport-scoped. */
  attempts: ArmAttempt[];
}

export const EMPTY_WINDOW: ResolvedWindow = {
  minSlateDate: null,
  cohorts: [],
  cohortsPublished: 0,
  windowDays: 0,
  activeCohortId: null,
  upcomingCohortId: null,
  standingsThrough: null,
  games: new Map(),
  availableSports: [],
  attempts: [],
};

interface RunRow {
  run_id: string;
  cohort_id: string;
  slate_date: string;
  benchmark_commit: string | null;
}

/**
 * `benchmark_arm_attempts` at `attempt_ordinal = 0`.
 *
 * Read once, here, and handed to whoever needs it: it is simultaneously the
 * list of games a cohort covered, the per-arm opportunity denominator, and the
 * arm-outcome histogram. Reading it twice would be two chances to disagree
 * about which of those three the ordinal filter applied to.
 *
 * `attempt_ordinal = 0` is load-bearing on all three counts. Ordinal 1 is the
 * deterministic format repair, and `outcome` / `supplied_markets` are
 * response-level values COPIED onto the repair row by design — measured,
 * `google-gemini-3.1-pro-preview` carries `invalid_schema` at both ordinals on
 * run `watch-v0-2026-08-15-0b0658` — so an unfiltered read double-counts every
 * repaired arm.
 */
export interface ArmAttempt {
  id: number;
  cohortId: string;
  participantId: string;
  gameId: string;
  suppliedMarkets: string[];
  outcome: string;
}

interface AttemptGameRow {
  id: number;
  cohort_id: string;
  participant_id: string;
  game_id: string;
  supplied_markets: string[] | null;
  outcome: string;
}

interface GameRow {
  jsonodds_id: string;
  sport: string;
  slug: string | null;
  match_time: string;
  earliest_match_time: string | null;
  rundown_match_time: string | null;
  sportspage_match_time: string | null;
  home_team_id: string;
  away_team_id: string;
  home_score: number | null;
  away_score: number | null;
  final_type: string | null;
}

/**
 * A run-relation read bound. 400 window-days at 15 runs a day is 6,000; this
 * sits an order above any real slate and exists only so a runaway relation
 * raises instead of walking forever.
 */
const RUN_READ_CAP = 50_000;

export interface WindowOptions {
  network: string;
  minSlateDate: string | undefined;
  windowDays: number;
  /** Restrict to one sport. `undefined` ⇒ every sport. */
  sport?: Sport | undefined;
  /** Restrict to one cohort's slate date (`YYYY-MM-DD`). */
  slateDate?: string | undefined;
  now?: Date | undefined;
}

export type WindowResult =
  | { ok: true; window: ResolvedWindow }
  | { ok: false; error: PostgrestError; context: string };

/**
 * Resolve the served window.
 *
 * Four reads at most, all bounded: the runs in range, the attempt rows that
 * name their games, and the games themselves. Nothing here touches
 * `benchmark_scores` — the volume lives there and only the standings handler
 * pays for it.
 */
export async function resolveWindow(
  sb: SupabaseClient,
  opts: WindowOptions,
): Promise<WindowResult> {
  if (opts.minSlateDate === undefined) {
    // The gate is closed. Answer without reading anything: an unset gate is a
    // deliberate operator state, not an error, and a request that reaches the
    // database anyway would make "nothing is published" cost the same as
    // serving.
    return { ok: true, window: { ...EMPTY_WINDOW, windowDays: opts.windowDays } };
  }

  const runs = await readAllByKeyset<RunRow, string>(
    BENCHMARK.runs,
    RUN_READ_CAP,
    (r) => r.run_id,
    (after, limit) => {
      let q = sb
        .from(BENCHMARK.runs)
        .select('run_id, cohort_id, slate_date, benchmark_commit')
        .eq('network', opts.network)
        .gte('slate_date', opts.minSlateDate as string)
        .order('run_id', { ascending: true })
        .limit(limit);
      if (opts.slateDate !== undefined) q = q.eq('slate_date', opts.slateDate);
      if (after !== null) q = q.gt('run_id', after);
      return q as unknown as PromiseLike<{ data: RunRow[] | null; error: PostgrestError | null }>;
    },
  );
  if (runs.error) return { ok: false, error: runs.error, context: BENCHMARK.runs };

  const byCohort = new Map<string, CohortWindowEntry>();
  for (const row of runs.rows) {
    let entry = byCohort.get(row.cohort_id);
    if (entry === undefined) {
      entry = {
        cohortId: row.cohort_id,
        slateDate: row.slate_date,
        runIds: [],
        gameIds: [],
        benchmarkCommit: null,
        benchmarkCommits: [],
        slateStart: null,
        slateEnd: null,
      };
      byCohort.set(row.cohort_id, entry);
    }
    entry.runIds.push(row.run_id);
    if (row.benchmark_commit !== null && !entry.benchmarkCommits.includes(row.benchmark_commit)) {
      entry.benchmarkCommits.push(row.benchmark_commit);
    }
  }
  for (const entry of byCohort.values()) {
    entry.benchmarkCommits.sort();
    entry.benchmarkCommit =
      entry.benchmarkCommits.length === 1 ? (entry.benchmarkCommits[0] as string) : null;
  }

  // Newest-first to apply the window bound, then back to oldest-first: the
  // series the front end draws reads left to right in time.
  const allCohorts = [...byCohort.values()].sort((a, b) =>
    a.slateDate === b.slateDate
      ? a.cohortId.localeCompare(b.cohortId)
      : b.slateDate.localeCompare(a.slateDate),
  );
  const cohortsPublished = allCohorts.length;
  const windowed = allCohorts.slice(0, opts.windowDays).reverse();

  if (windowed.length === 0) {
    return {
      ok: true,
      window: {
        ...EMPTY_WINDOW,
        minSlateDate: opts.minSlateDate,
        windowDays: opts.windowDays,
        cohortsPublished,
      },
    };
  }

  // Which games each cohort covered. `benchmark_arm_attempts` at
  // `attempt_ordinal = 0` is the right source: it is one row per arm-game
  // DISPATCH, so a game every arm failed on still appears — unlike
  // `benchmark_decisions`, which only exists where an arm answered.
  const cohortIds = windowed.map((c) => c.cohortId);
  const attempts: AttemptGameRow[] = [];
  for (const chunk of chunkIds(cohortIds, 50)) {

    const page = await readAllByKeyset<AttemptGameRow, number>(
      BENCHMARK.armAttempts,
      RUN_READ_CAP,
      (r) => r.id,
      (after, limit) => {
        let q = sb
          .from(BENCHMARK.armAttempts)
          .select('id, cohort_id, participant_id, game_id, supplied_markets, outcome')
          .eq('network', opts.network)
          .eq('attempt_ordinal', 0)
          .in('cohort_id', chunk)
          .order('id', { ascending: true })
          .limit(limit);
        if (after !== null) q = q.gt('id', after);
        return q as unknown as PromiseLike<{
          data: AttemptGameRow[] | null;
          error: PostgrestError | null;
        }>;
      },
    );
    if (page.error) return { ok: false, error: page.error, context: BENCHMARK.armAttempts };
    attempts.push(...page.rows);
  }

  const gameIdsByCohort = new Map<string, Set<string>>();
  for (const a of attempts) {
    const set = gameIdsByCohort.get(a.cohort_id) ?? new Set<string>();
    set.add(a.game_id);
    gameIdsByCohort.set(a.cohort_id, set);
  }

  const allGameIds = [...new Set(attempts.map((a) => a.game_id))];
  const games = new Map<string, BenchmarkGame>();
  for (const chunk of chunkIds(allGameIds, 100)) {

    const res = await sb
      .from('games')
      .select(
        'jsonodds_id, sport, slug, match_time, earliest_match_time, rundown_match_time, ' +
          'sportspage_match_time, home_team_id, away_team_id, home_score, away_score, final_type',
      )
      .eq('network', opts.network)
      .in('jsonodds_id', chunk)
      .limit(POSTGREST_PAGE);
    if (res.error) return { ok: false, error: res.error, context: 'games' };
    for (const raw of (res.data ?? []) as unknown as GameRow[]) {
      games.set(raw.jsonodds_id, {
        gameId: raw.jsonodds_id,
        sport: raw.sport,
        slug: raw.slug ?? raw.jsonodds_id,
        // The bounded minimum, not the raw column. `/v1/games` has served this
        // since the start-time move-up remediation, and selecting `match_time`
        // here would print two different start times for one game in two
        // sections of the same page — with the earlier one correct.
        matchTime: effectiveMatchTime(
          raw.match_time,
          raw.earliest_match_time,
          raw.rundown_match_time,
          raw.sportspage_match_time,
        ),
        homeTeamId: raw.home_team_id,
        awayTeamId: raw.away_team_id,
        homeScore: raw.home_score,
        awayScore: raw.away_score,
        finalType: raw.final_type,
      });
    }
  }

  // Sport scope. Applied HERE, before any aggregation: a sport filter applied
  // after the fact would change every mean and beat rate it touched.
  const inScope = (gameId: string): boolean => {
    if (opts.sport === undefined) return true;
    return games.get(gameId)?.sport === opts.sport;
  };

  for (const cohort of windowed) {
    const ids = [...(gameIdsByCohort.get(cohort.cohortId) ?? new Set<string>())]
      .filter(inScope)
      .sort();
    cohort.gameIds = ids;
    let start: string | null = null;
    let end: string | null = null;
    for (const id of ids) {
      const t = games.get(id)?.matchTime;
      if (t === undefined) continue;
      if (start === null || compareInstants(t, start) < 0) start = t;
      if (end === null || compareInstants(t, end) > 0) end = t;
    }
    cohort.slateStart = start;
    cohort.slateEnd = end;
  }

  // A sport filter can empty a cohort entirely; it then contributes nothing and
  // must not appear in the window, or the series carries a day with no games.
  const cohorts = windowed.filter((c) => c.gameIds.length > 0);

  const availableSports = [
    ...new Set(
      [...games.values()]
        .filter((g) => cohorts.some((c) => c.gameIds.includes(g.gameId)))
        .map((g) => g.sport),
    ),
  ].sort();

  const { activeCohortId, upcomingCohortId } = resolveActiveCohort(
    cohorts,
    opts.now ?? new Date(),
  );

  // Sport-scope the dispatch rows the same way the cohorts were scoped, so a
  // per-arm denominator can never count an opportunity on a game the caller
  // filtered out.
  const keptCohorts = new Set(cohorts.map((c) => c.cohortId));
  const scopedAttempts: ArmAttempt[] = attempts
    .filter((a) => keptCohorts.has(a.cohort_id) && inScope(a.game_id))
    .map((a) => ({
      id: a.id,
      cohortId: a.cohort_id,
      participantId: a.participant_id,
      gameId: a.game_id,
      // NOT NULL with a `{}` default in migration 073 and CHECK-bounded to one
      // to three known markets, so an empty array is a real state and a null is
      // not reachable — coalesced rather than trusted.
      suppliedMarkets: a.supplied_markets ?? [],
      outcome: a.outcome,
    }));

  return {
    ok: true,
    window: {
      minSlateDate: opts.minSlateDate,
      cohorts,
      cohortsPublished,
      windowDays: opts.windowDays,
      activeCohortId,
      upcomingCohortId,
      standingsThrough: cohorts.length > 0 ? (cohorts[cohorts.length - 1] as CohortWindowEntry).slateDate : null,
      games,
      availableSports,
      attempts: scopedAttempts,
    },
  };
}

/** Microsecond-exact instant comparison. Never `Date.parse`, which truncates to ms. */
function compareInstants(a: string, b: string): number {
  const av = parseTimestampMicros(a);
  const bv = parseTimestampMicros(b);
  if (av === null || bv === null) return a.localeCompare(b);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

/**
 * The live cohort, and the next one.
 *
 * A cohort's window runs from its earliest start to its latest. `now` inside a
 * window makes that cohort active. Otherwise the active cohort is the most
 * recent window that has ENDED, and the earliest window that has not yet
 * started is `upcoming` — which is how the overlap resolves: at 21:40Z on the
 * 22nd, the 22nd's slate is mid-flight and the 23rd's is upcoming, rather than
 * the 23rd's displacing it.
 *
 * A cohort whose games have no usable start is skipped rather than guessed at.
 */
function resolveActiveCohort(
  cohorts: readonly CohortWindowEntry[],
  now: Date,
): { activeCohortId: string | null; upcomingCohortId: string | null } {
  const nowIso = now.toISOString();
  const dated = cohorts.filter((c) => c.slateStart !== null && c.slateEnd !== null);

  const live = dated.filter(
    (c) =>
      compareInstants(c.slateStart as string, nowIso) <= 0 &&
      compareInstants(nowIso, c.slateEnd as string) <= 0,
  );
  const ended = dated.filter((c) => compareInstants(c.slateEnd as string, nowIso) < 0);
  const future = dated.filter((c) => compareInstants(nowIso, c.slateStart as string) < 0);

  // Ties inside an overlap go to the EARLIER slate: the games being played now
  // belong to it, and the later cohort is by definition still upcoming.
  const active =
    live.length > 0
      ? live.reduce((a, b) => (compareInstants(a.slateStart as string, b.slateStart as string) <= 0 ? a : b))
      : ended.length > 0
        ? ended.reduce((a, b) => (compareInstants(a.slateEnd as string, b.slateEnd as string) >= 0 ? a : b))
        : null;

  const upcoming =
    future.length > 0
      ? future.reduce((a, b) => (compareInstants(a.slateStart as string, b.slateStart as string) <= 0 ? a : b))
      : null;

  return {
    activeCohortId: active?.cohortId ?? null,
    upcomingCohortId: upcoming?.cohortId ?? null,
  };
}

/** `sport` query-param validation shared by all three endpoints. */
export function parseSportParam(raw: unknown): Sport | 'all' | 'invalid' | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw).toLowerCase();
  if (value === 'all') return 'all';
  if (isSport(value)) return value;
  return 'invalid';
}
