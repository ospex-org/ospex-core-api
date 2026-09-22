/**
 * GET /v1/benchmark/picks — one cohort's slate, with the model arms' revealed
 * picks on it.
 *
 * This endpoint is BOTH the pick feed and the schedule source, and that is a
 * decision rather than an accident. Work-order item 4 left `pickCount` to the
 * implementer; `/v1/games` is deliberately not changed, because it is the SDK
 * and market-maker hot path for contest creation and a benchmark outage must
 * not degrade it. But `/v1/games` also cannot serve the landing page's schedule
 * section on its own, for two measured reasons:
 *
 *  - it is FUTURE-ONLY (`.gte('match_time', now)`), so on an evening pageview
 *    the afternoon's games are simply gone; and
 *  - its `availableOnly` default excludes games that already have a contest,
 *    which is 45 of 48 sampled benchmark games — ~94% of exactly the games that
 *    have picks.
 *
 * So `games[]` here carries the WHOLE cohort slate, including games with zero
 * picks, and `pickCount` is computed server-side.
 *
 * ## Which picks count
 *
 * `pickCount` is the revealed EXECUTED-market picks — ruling 2: model arms ×
 * (moneyline + total), max 8 per game; run-line picks are measurement-only and
 * excluded. That exclusion belongs HERE and nowhere else: the standings pool
 * all three markets, and the work order's own acceptance number is the mean of
 * a moneyline and a spread pick.
 *
 * ## Writeups are not served HERE, which is not the same as unpublished
 *
 * `benchmark_decision_rationales` is not queried by this endpoint, so a pick
 * card carries no prose. That is a choice about this surface and it stands.
 *
 * What does NOT follow, and what this docblock used to claim, is that
 * abstaining keeps the rationales unpublished. It does not. Indexer migration
 * 081 created the `benchmark_pick_writeups` view over that table and 082/083
 * granted anon SELECT, so the rationale text is public with the anon key alone
 * — measured 2026-09-21, 4,170 rows, full prose in `writeup`. The publication
 * decision was taken elsewhere and it went the other way.
 *
 * The one thing the view does withhold is `evidence_refs`, which it does not
 * project; the prose is public and the internal reference tokens are not. So
 * reason about publication from the GRANTS, never from which queries this file
 * happens to make.
 */

import type { Request, Response } from 'express';
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from '../../lib/env.js';
import { getSupabase } from '../../lib/supabase.js';
import { SPORTS as VALID_SPORTS } from '../../lib/sports.js';
import type { ApiError } from '../../middleware/errorHandler.js';
import {
  BENCHMARK,
  POSTGREST_PAGE,
  REVEAL_EMBED,
  chunkIds,
  readAllByKeyset,
  respondProjectionFault,
  respondToQueryError,
} from './source.js';
import { parseSlateDate, parseSportParam, resolveWindow, type BenchmarkGame } from './window.js';
import { collectExecuted, type BenchmarkFill } from './executedFetch.js';

/**
 * The markets a benchmark arm actually executes. Ruling 2. `spread` (the run
 * line) is recorded and scored but never counted here.
 */
const EXECUTED_MARKETS = new Set(['moneyline', 'total']);

/**
 * The axis scale, stated rather than assumed.
 *
 * The stored values are INTEGERS 1..5 — measured over all 1,930 reveals,
 * `axis_valuation`/`trend`/`consensus`/`news` reach 5 and `axis_softness`
 * reaches only 4. The front-end radar recipe expects an 0..100 domain, so
 * passing the raw integer through collapses every polygon to ~2px from the
 * pentagon centre, and letting the front end infer the ceiling from observed
 * values gives softness a different scale from the other four and tilts every
 * shape. Both the raw value and its declared bounds are served; the normalising
 * map `(v - min) / (max - min) * 100` is the front end's, and it now has the
 * numbers to do it.
 */
const AXIS_SCALE = Object.freeze({ min: 1, max: 5 });

/**
 * How the featured pick is chosen, served with the answer.
 *
 * The front end must not pick: a model puts up ~30 executed-market picks a day
 * and the mockup renders exactly one, so any client-side rule is client-side
 * metric math on the most prominent number on the page.
 *
 * Highest `confidence`, ties to the lowest decision id so the choice is stable
 * across requests. Picks with no confidence are not eligible to be featured —
 * they are still served, they just cannot be the headline. Note that the four
 * live reveals whose axes are all pinned at 1 with a null `primary_axis` carry
 * confidence 0.0–0.5, so a maximum-confidence rule already declines them
 * without a special case for degeneracy.
 */
const FEATURED_RULE = 'highest confidence among revealed executed-market picks, ties to the lowest decision id';

/**
 * Decision read bound for one cohort. Four arms × three markets × a 15-game
 * slate is 180 rows; this is a backstop against a runaway relation, and it
 * raises rather than truncates like every bound in `source.ts`.
 */
const DECISION_READ_CAP = 50_000;

interface DecisionRow {
  id: number;
  cohort_id: string;
  participant_id: string;
  game_id: string;
  market: string;
  sealed_at: string;
  benchmark_decision_reveals: {
    revealed_at: string;
    selection: string | null;
    line: number | null;
    observed_decimal: number | null;
    prob_win: number | null;
    prob_push: number | null;
    prob_loss: number | null;
    confidence: number | null;
    would_abstain: boolean | null;
    selected_for_execution: boolean | null;
    primary_axis: string | null;
    primary_expectation: string | null;
    axis_valuation: number | null;
    axis_trend: number | null;
    axis_consensus: number | null;
    axis_news: number | null;
    axis_softness: number | null;
  } | null;
}

/**
 * `!inner` on the reveal, and the foreign key NAMED.
 *
 * Named because two constraints join these tables and PostgREST refuses the
 * ambiguity with a hard `PGRST201`. Inner because a SEALED decision with no
 * reveal is still embargoed — the seal is a commitment, the reveal is the
 * publication — and a left embed would serve it with a null body. Today every
 * one of the 1,930 decisions has a reveal, so a fixture built from production
 * shape passes either way; the day a seal lands without one, the left version
 * publishes it.
 */
const DECISION_SELECT =
  'id, cohort_id, participant_id, game_id, market, sealed_at, ' +
  `${REVEAL_EMBED}!inner(revealed_at, selection, line, observed_decimal, prob_win, prob_push, ` +
  'prob_loss, confidence, would_abstain, selected_for_execution, primary_axis, ' +
  'primary_expectation, axis_valuation, axis_trend, axis_consensus, axis_news, axis_softness)';

/**
 * Decimal odds to the American convention every other odds field in this
 * service uses (`awayOddsAmerican` and friends in `v1/utils/odds.ts`).
 *
 * The front end would otherwise convert the biggest number on the pick card
 * itself, branching at 2.0 and inventing a rounding rule — the live reveal at
 * `observed_decimal = 1.55866` is −178.997, so one implementation prints −179
 * and another −178 for the same sealed price. Rounded half away from zero,
 * once, here.
 */
export function decimalToAmerican(decimal: number | null): number | null {
  if (decimal === null || !Number.isFinite(decimal) || decimal <= 1) return null;
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return -Math.round(100 / (decimal - 1));
}

/** Which side of a game a selection names. */
export type PickSide = 'away' | 'home';

/**
 * The side of the game `selection` names, or null when the canonical teams
 * cannot decide it.
 *
 * A spread reveal's stored `line` is the HOME team's handicap whichever side was
 * picked — `ospex-benchmark/src/prompt.ts` instructs the arm to "copy the
 * bundle's designated run-line `line` value verbatim (it is expressed as the home
 * team's handicap; selecting the away team means taking the away side of that same
 * designated line)", and `src/clv.ts` says the same where it scores them. So
 * rendering a spread pick at all requires knowing which side it is, and this is
 * the only place that decides.
 *
 * `selection` is the bundle's own team string, so the name should match exactly;
 * the abbreviation, trimming and case-folding are there for drift between the
 * bundle's copy and `teams`, not because a fuzzy match is wanted. There is no
 * fuzzy match: anything that resolves to BOTH sides or NEITHER returns null, and
 * the caller then renders no number rather than a guessed sign.
 *
 * Both-sides is reachable in exactly one way today, and it is not a data problem:
 * an unresolved team id falls back to the shared `UNKNOWN_TEAM` sentinel, so a
 * game missing both teams presents two identical sides. A real pair of teams
 * sharing a name or an abbreviation within one game is not a state `games` can
 * hold.
 */
export function resolveSelectionSide(
  selection: string | null,
  away: { name: string; abbreviation: string },
  home: { name: string; abbreviation: string },
): PickSide | null {
  if (selection === null) return null;
  const key = (s: string): string => s.trim().toLowerCase();
  const want = key(selection);
  if (want === '') return null;
  const isAway = want === key(away.name) || want === key(away.abbreviation);
  const isHome = want === key(home.name) || want === key(home.abbreviation);
  // Equal means BOTH matched or NEITHER did. Both are "cannot decide", and
  // collapsing them here is what makes "never guess a sign" one branch.
  if (isAway === isHome) return null;
  return isAway ? 'away' : 'home';
}

/**
 * The handicap on each side of a spread, from the stored HOME handicap.
 *
 * Same shape and same rule as `utils/odds.ts` serves for `current_odds`
 * (`awayLine = -homeLine`), deliberately: this service already decided that a
 * spread carries both sides explicitly and no bare `line`, because one
 * un-labelled number is what lets a caller misalign. See `README.md`.
 *
 * Zero is normalised rather than negated. `-0` is a distinct IEEE value, and
 * although it happens to stringify as `"0"` today, a pick-em line is neutral on
 * both sides and should not depend on that.
 */
export function spreadLines(homeLine: number | null): {
  awayLine: number | null;
  homeLine: number | null;
} {
  if (homeLine === null) return { awayLine: null, homeLine: null };
  return { awayLine: homeLine === 0 ? 0 : -homeLine, homeLine };
}

/**
 * The whole `ospex-core-api#71` convention for ONE stored number, in one place.
 *
 * A spread's stored value is the HOME handicap, so this service serves the
 * side-labelled pair and a null bare `line`; every other market has no sides and
 * serves the number as `line` with both sides null.
 *
 * ## Why this is a function and not a two-line expression at each call site
 *
 * It was the expression, twice, twelve lines apart inside one response literal —
 * and review caught the second one still serving a raw HOME number after the
 * first had been fixed. The pick's line was labelled and its CLOSING line was
 * not, so an away pick displayed `+1.5` beside a close of `-2.5` when the away
 * close is `+2.5`. That is `3d-sibling` in
 * `.claude/rules/verification-discipline.md`: a convention applied at one site
 * and not at its sibling, at a scale too small to look like two sites.
 *
 * All four sites that serve a spread number now call this: the list endpoint's
 * pick line, and the detail endpoint's pick line and closing line, and the
 * ledger's two. Adding another is a call rather than a re-derivation, which is
 * the property worth having — not a promise that none will ever be added
 * elsewhere, which no comment can keep.
 */
export function sidedLine(
  market: string,
  stored: number | null,
): { line: number | null; awayLine: number | null; homeLine: number | null } {
  if (market !== 'spread') return { line: stored, awayLine: null, homeLine: null };
  const { awayLine, homeLine } = spreadLines(stored);
  return { line: null, awayLine, homeLine };
}

/**
 * A human-readable selection, composed once.
 *
 * `selection` is a full team name on `moneyline` and `spread` and a lowercase
 * side (`over` / `under`) on `total`, with the number in `line` — so the front
 * end cannot render it without knowing the per-market semantics. The mockup
 * wants a short name ("Yankees"), which no column supplies: `teams` carries
 * `name` and `abbrev` and nothing between, and splitting on whitespace breaks
 * on Red Sox, Blue Jays and White Sox. A proper short name needs a nickname
 * column on `teams`, which is an indexer change and out of scope here; the full
 * name is served instead of a guess.
 *
 * ## The number this appends on a spread is the SELECTED side's, not the stored one
 *
 * `line` in is the raw HOME handicap (see `resolveSelectionSide`). An away pick's
 * handicap is its negation, so pasting the stored value onto an away selection
 * names the opposite bet — `ospex-core-api#71`. `side` is therefore required
 * rather than optional: the compiler, not a convention, is what stops a caller
 * from omitting it.
 *
 * When `side` is null the label carries no number at all. That is the whole of
 * the "unknown or ambiguous selection must not guess a sign" rule, and it is
 * safe in the direction that matters — a missing number is a rendering gap, a
 * wrong sign is a wrong bet.
 */
export function selectionLabel(
  market: string,
  selection: string | null,
  line: number | null,
  american: number | null,
  side: PickSide | null,
): string | null {
  if (selection === null) return null;
  const signed = (v: number): string => (v > 0 ? `+${String(v)}` : String(v));
  if (market === 'total') {
    const overUnder = selection.charAt(0).toUpperCase() + selection.slice(1);
    return line === null ? overUnder : `${overUnder} ${String(line)}`;
  }
  if (market === 'spread') {
    if (line === null || side === null) return selection;
    const lines = spreadLines(line);
    const selected = side === 'away' ? lines.awayLine : lines.homeLine;
    return selected === null ? selection : `${selection} ${signed(selected)}`;
  }
  return american === null ? selection : `${selection} ${signed(american)}`;
}

interface TeamRow {
  id: string;
  name: string;
  abbrev: string;
}

async function resolveTeams(
  sb: SupabaseClient,
  games: readonly BenchmarkGame[],
): Promise<{ teams: Map<string, { name: string; abbreviation: string }> } | { error: PostgrestError }> {
  const ids = [...new Set(games.flatMap((g) => [g.homeTeamId, g.awayTeamId]))];
  const teams = new Map<string, { name: string; abbreviation: string }>();
  for (const chunk of chunkIds(ids, 100)) {

    const res = await sb.from('teams').select('id, name, abbrev').in('id', chunk).limit(POSTGREST_PAGE);
    if (res.error) return { error: res.error };
    for (const t of (res.data ?? []) as unknown as TeamRow[]) {
      teams.set(t.id, { name: t.name, abbreviation: t.abbrev });
    }
  }
  return { teams };
}

const UNKNOWN_TEAM = { name: 'Unknown', abbreviation: '???' };

export async function getBenchmarkPicksHandler(req: Request, res: Response): Promise<void> {
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

  const config = loadConfig();
  const sb = getSupabase();

  let windowRes;
  try {
    windowRes = await resolveWindow(sb, {
      network: config.network,
      minSlateDate: config.benchmarkPublicMinSlateDate,
      windowDays: config.benchmarkStandingsWindowDays,
      ...(sport !== undefined && sport !== 'all' ? { sport } : {}),
      ...(slateDate !== undefined ? { slateDate } : {}),
    });
  } catch (err) {
    // The same two typed faults standings answers as 503 — a bound or an
    // integrity fault inside the window's own keyset walks.
    if (respondProjectionFault(res, err)) return;
    throw err;
  }
  if (!windowRes.ok) {
    respondToQueryError(res, windowRes.error, windowRes.context);
    return;
  }
  const win = windowRes.window;

  // One cohort: the requested date's, or the active one. `activeCohortId` is
  // resolved from the games' own slate window rather than from the calendar —
  // see `window.ts` for why both obvious rules are measurably wrong.
  const cohort =
    slateDate !== undefined
      ? win.cohorts.find((c) => c.slateDate === slateDate)
      : win.cohorts.find((c) => c.cohortId === win.activeCohortId);

  if (cohort === undefined) {
    res.status(200).json({
      sport: sport ?? null,
      network: config.network,
      date: slateDate ?? null,
      cohortId: null,
      activeCohortId: win.activeCohortId,
      upcomingCohortId: win.upcomingCohortId,
      availableSports: win.availableSports,
      axisScale: AXIS_SCALE,
      featuredRule: FEATURED_RULE,
      featuredPick: null,
      games: [],
    });
    return;
  }

  // Keyset on `id`, not offset: `benchmark_decisions` is append-only under a
  // publisher that can insert between two pages, and an offset walk over it
  // re-reads a row when one lands before page two — the same double-count
  // review reproduced on the fill receipts. `readAllByKeyset` explains why.
  const decisions: DecisionRow[] = [];
  try {
    for (const chunk of chunkIds(cohort.gameIds, 60)) {
      const page = await readAllByKeyset<DecisionRow, number>(
        BENCHMARK.decisions,
        DECISION_READ_CAP,
        (r) => r.id,
        (after, limit) => {
          let q = sb
            .from(BENCHMARK.decisions)
            .select(DECISION_SELECT)
            .eq('network', config.network)
            .eq('cohort_id', cohort.cohortId)
            .in('game_id', chunk)
            .order('id', { ascending: true })
            .limit(limit);
          if (after !== null) q = q.gt('id', after);
          return q as unknown as PromiseLike<{
            data: DecisionRow[] | null;
            error: PostgrestError | null;
          }>;
        },
      );
      if (page.error) {
        respondToQueryError(res, page.error, BENCHMARK.decisions);
        return;
      }
      decisions.push(...page.rows);
    }
  } catch (err) {
    if (respondProjectionFault(res, err)) return;
    throw err;
  }

  const identityRes = await sb
    .from(BENCHMARK.participants)
    .select('participant_id, kind, lab_id, display_name, model_id')
    .limit(POSTGREST_PAGE);
  if (identityRes.error) {
    respondToQueryError(res, identityRes.error, BENCHMARK.participants);
    return;
  }
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

  let executed;
  try {
    executed = await collectExecuted(sb, config.network, [cohort.cohortId], config.scorers);
  } catch (err) {
    if (respondProjectionFault(res, err)) return;
    throw err;
  }
  if ('error' in executed) {
    respondToQueryError(res, executed.error, executed.context);
    return;
  }
  const fillByKey = new Map<string, BenchmarkFill>();
  for (const f of executed.fills) {
    fillByKey.set(`${f.participantId} ${f.gameId} ${f.market}`, f);
  }

  const slateGames = cohort.gameIds
    .map((id) => win.games.get(id))
    .filter((g): g is BenchmarkGame => g !== undefined);
  const teamsRes = await resolveTeams(sb, slateGames);
  if ('error' in teamsRes) {
    respondToQueryError(res, teamsRes.error, 'teams');
    return;
  }

  interface WirePick {
    decisionId: number;
    participantId: string;
    displayName: string;
    lab: string | null;
    market: string;
    selection: string | null;
    selectionLabel: string | null;
    /**
     * `total` only — the perspective-neutral over/under threshold. Null on
     * `moneyline`, which is line-less, and null on `spread`, which carries the
     * side-labelled pair below instead of one un-labelled number.
     */
    line: number | null;
    /**
     * `spread` only — the handicap on each side, always negations of each other.
     * Null on every other market. Same convention as `/v1/odds`: the stored value
     * is the HOME handicap, and serving both sides is what stops a caller pairing
     * a number with the wrong team (`ospex-core-api#71`).
     */
    awayLine: number | null;
    homeLine: number | null;
    observedDecimal: number | null;
    priceAmerican: number | null;
    confidence: number | null;
    probWin: number | null;
    probPush: number | null;
    probLoss: number | null;
    primaryAxis: string | null;
    primaryExpectation: string | null;
    axes: Record<string, number> | null;
    wouldAbstain: boolean | null;
    selectedForExecution: boolean | null;
    sealedAt: string;
    revealedAt: string;
    fill: {
      txHash: string;
      blockNumber: string;
      filledAt: string;
      stakeUsdc: number;
      /** Which deployment's counters `contestId` / `speculationId` are — provenance, not a key. */
      deploymentRound: string;
      runId: string;
      contestId: string;
      speculationId: string;
      takerAddress: string;
      /**
       * Whether the identity chain in `executedFetch.ts` bound this receipt to
       * exactly one on-chain fill and outcome. The receipt itself is served
       * either way — it is the operator's published statement that the
       * placement happened — but the standings record only PRICES fills that
       * resolved, and a reader of the pick card is entitled to the same fact.
       */
      resolved: boolean;
    } | null;
  }

  const picksByGame = new Map<string, WirePick[]>();
  for (const d of decisions) {
    const reveal = d.benchmark_decision_reveals;
    if (reveal === null) continue;
    const who = identity.get(d.participant_id);
    if (who === undefined || who.kind !== 'model') continue;
    if (!EXECUTED_MARKETS.has(d.market)) continue;

    const american = decimalToAmerican(reveal.observed_decimal);
    // Null on every baseline row and on any model reveal that carried no axis
    // set — served as null rather than as five zeroes, because a zeroed radar
    // is a shape and "no shape" is the honest rendering.
    const axes =
      reveal.axis_valuation === null
        ? null
        : {
            valuation: reveal.axis_valuation,
            trend: reveal.axis_trend ?? 0,
            consensus: reveal.axis_consensus ?? 0,
            news: reveal.axis_news ?? 0,
            softness: reveal.axis_softness ?? 0,
          };
    const fill = fillByKey.get(`${d.participant_id} ${d.game_id} ${d.market}`);
    // The same two teams the game card below serves, resolved through the same
    // `?? UNKNOWN_TEAM` fallback — so a label and the card it sits on cannot
    // disagree about who is who.
    const game = win.games.get(d.game_id);
    const away = (game === undefined ? undefined : teamsRes.teams.get(game.awayTeamId)) ?? UNKNOWN_TEAM;
    const home = (game === undefined ? undefined : teamsRes.teams.get(game.homeTeamId)) ?? UNKNOWN_TEAM;
    const side = resolveSelectionSide(reveal.selection, away, home);
    // Normalised ONCE, here. Everything downstream reads this pair rather than
    // re-deriving a sign from the stored HOME value.
    // Through the shared helper, like the other two endpoints. This was the THIRD
    // site deriving the pair independently — in the file that defines the helper,
    // which is what made the docblock's "no second site to forget" false until now.
    const pickLine = sidedLine(d.market, reveal.line);
    const pick: WirePick = {
      decisionId: d.id,
      participantId: d.participant_id,
      displayName: who.display_name,
      lab: who.lab_id,
      market: d.market,
      selection: reveal.selection,
      selectionLabel: selectionLabel(d.market, reveal.selection, reveal.line, american, side),
      // A spread's number is served as the labelled pair, never here.
      line: pickLine.line,
      awayLine: pickLine.awayLine,
      homeLine: pickLine.homeLine,
      observedDecimal: reveal.observed_decimal,
      priceAmerican: american,
      confidence: reveal.confidence,
      probWin: reveal.prob_win,
      probPush: reveal.prob_push,
      probLoss: reveal.prob_loss,
      primaryAxis: reveal.primary_axis,
      primaryExpectation: reveal.primary_expectation,
      axes,
      wouldAbstain: reveal.would_abstain,
      selectedForExecution: reveal.selected_for_execution,
      sealedAt: d.sealed_at,
      revealedAt: reveal.revealed_at,
      fill:
        fill === undefined
          ? null
          : {
              txHash: fill.txHash,
              blockNumber: fill.blockNumber,
              filledAt: fill.filledAt,
              stakeUsdc: fill.stakeUsdc,
              deploymentRound: fill.deploymentRound,
              runId: fill.runId,
              contestId: fill.contestId,
              speculationId: fill.speculationId,
              takerAddress: fill.takerAddress,
              resolved: fill.resolved,
            },
    };
    const list = picksByGame.get(d.game_id);
    if (list === undefined) picksByGame.set(d.game_id, [pick]);
    else list.push(pick);
  }

  /** {@link FEATURED_RULE}. */
  const designate = (candidates: readonly WirePick[]): WirePick | null => {
    let best: WirePick | null = null;
    for (const p of candidates) {
      if (p.confidence === null) continue;
      if (
        best === null ||
        p.confidence > (best.confidence as number) ||
        (p.confidence === best.confidence && p.decisionId < best.decisionId)
      ) {
        best = p;
      }
    }
    return best;
  };

  const allPicks = [...picksByGame.values()].flat();
  const topByParticipant: Record<string, { gameId: string; decisionId: number }> = {};
  for (const participantId of new Set(allPicks.map((p) => p.participantId))) {
    const top = designate(allPicks.filter((p) => p.participantId === participantId));
    if (top === null) continue;
    const gameId = decisions.find((d) => d.id === top.decisionId)?.game_id;
    if (gameId !== undefined) topByParticipant[participantId] = { gameId, decisionId: top.decisionId };
  }
  const featured = designate(allPicks);
  const featuredGameId =
    featured === null ? null : (decisions.find((d) => d.id === featured.decisionId)?.game_id ?? null);

  res.status(200).json({
    sport: sport ?? null,
    network: config.network,
    date: cohort.slateDate,
    cohortId: cohort.cohortId,
    activeCohortId: win.activeCohortId,
    upcomingCohortId: win.upcomingCohortId,
    availableSports: win.availableSports,
    axisScale: AXIS_SCALE,
    featuredRule: FEATURED_RULE,
    featuredPick:
      featured === null || featuredGameId === null
        ? null
        : {
            participantId: featured.participantId,
            gameId: featuredGameId,
            decisionId: featured.decisionId,
          },
    /** Per participant, so a caller holding the standings leader can look it up. */
    topPickByParticipant: topByParticipant,
    games: slateGames
      .slice()
      .sort((a, b) => a.matchTime.localeCompare(b.matchTime) || a.gameId.localeCompare(b.gameId))
      .map((g) => {
        const picks = (picksByGame.get(g.gameId) ?? []).sort(
          (a, b) => a.participantId.localeCompare(b.participantId) || a.market.localeCompare(b.market),
        );
        return {
          gameId: g.gameId,
          sport: g.sport,
          slug: g.slug,
          matchTime: g.matchTime,
          homeTeam: teamsRes.teams.get(g.homeTeamId) ?? UNKNOWN_TEAM,
          awayTeam: teamsRes.teams.get(g.awayTeamId) ?? UNKNOWN_TEAM,
          homeScore: g.homeScore,
          awayScore: g.awayScore,
          finalType: g.finalType,
          pickCount: picks.length,
          picks,
        };
      }),
  });
}
