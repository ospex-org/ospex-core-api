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
 * ## Writeups are not read
 *
 * `benchmark_decision_rationales` is not queried at all. It is operator-gated
 * pending a publication decision, and the way to not publish something is to
 * not read it.
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
import { parseSportParam, resolveWindow, type BenchmarkGame } from './window.js';
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
 */
export function selectionLabel(
  market: string,
  selection: string | null,
  line: number | null,
  american: number | null,
): string | null {
  if (selection === null) return null;
  const signed = (v: number): string => (v > 0 ? `+${String(v)}` : String(v));
  if (market === 'total') {
    const side = selection.charAt(0).toUpperCase() + selection.slice(1);
    return line === null ? side : `${side} ${String(line)}`;
  }
  if (market === 'spread') {
    return line === null ? selection : `${selection} ${signed(line)}`;
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
    const raw = String(req.query.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      res.status(400).json({
        error: 'date must be a slate date in YYYY-MM-DD form.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    slateDate = raw;
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
    line: number | null;
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
    const pick: WirePick = {
      decisionId: d.id,
      participantId: d.participant_id,
      displayName: who.display_name,
      lab: who.lab_id,
      market: d.market,
      selection: reveal.selection,
      selectionLabel: selectionLabel(d.market, reveal.selection, reveal.line, american),
      line: reveal.line,
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
