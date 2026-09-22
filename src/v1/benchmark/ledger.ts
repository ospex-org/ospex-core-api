/**
 * GET /v1/benchmark/ledger — a filtered, keyset-paged page of the pick ledger,
 * with an opt-in exact count.
 *
 * Part of #72. The list endpoint (`/benchmark/picks`) answers "what did the
 * cohort pick on this date"; the detail endpoint (`/benchmark/pick/...`) answers
 * "everything about this one pick". This answers "walk the published ledger
 * along an axis" — one arm's whole history, one game across arms, one slate day
 * — which is the shape a research or audit consumer needs and neither sibling
 * serves.
 *
 * ## A filter is REQUIRED, and that is a measurement rather than a preference
 *
 * `benchmark_pick_ledger` is a view whose body ranks over the live-scoped set
 * (indexer migration 086:375) and filters above the window, so no `LIMIT`
 * pushes through to the ranking. Measured against the live anon REST surface on
 * 2026-09-21, with `slate_date >= 2026-08-15` (the publication gate) pushed
 * down, ordering `source_decision_id desc`, `limit 25`:
 *
 * | filter                    | page   | `count=exact` | rows |
 * |---------------------------|--------|---------------|------|
 * | `participant_id`          | 0.34s  | 0.48s         | 1095 |
 * | `game_id`                 | 0.31s  | 0.44s         |   20 |
 * | `slate_date` (one day)    | 0.94s  | 1.06s         |  137 |
 * | `participant_id`+`market` | 0.32s  | 0.41s         |  395 |
 * | `game_id`+`market`        | 0.31s  | 0.39s         |    8 |
 * | `sport` alone             | **57014 timeout** | **57014 timeout** | — |
 * | the gate alone            | **57014 timeout** | —  | — |
 *
 * Two conclusions, and the second is the one that shapes the contract.
 *
 * First, **the publication gate is not a filter.** `slate_date >= 2026-08-15`
 * on its own is a 3.2-second statement timeout. An endpoint that accepted a
 * bare request and leaned on the gate to bound it would 500 on every call.
 *
 * Second, **what matters is selectivity, not which column.** `market` alone
 * measured a comfortable 0.59s and is still refused here, because that number
 * is a property of today's data — one sport and three markets, so `market`
 * selects about a third of the table — and not a bound. `sport` alone times out
 * for exactly the same reason in the other direction: every row is `mlb`, so
 * `sport=eq.mlb` is the unfiltered read wearing a filter's clothes. Admitting a
 * filter because it is fast on the current distribution is how an endpoint
 * starts 500ing a year later with nothing changed but row count.
 *
 * So the contract is structural: at least one **anchor** —
 * `participantId`, `gameId` or `slateDate` — each of which bounds the result by
 * construction (one arm's picks, one game's picks, one day's picks). `sport` and
 * `market` are refinements that narrow an anchored read and cannot stand alone.
 * Anything else is `400 FILTER_REQUIRED`, which names the anchors.
 *
 * The honest residue: the `participantId` anchor is bounded by *days of
 * history*, not by a constant — 1,095 rows today, growing about 27 a day. That
 * is why the exact count is **opt-in** rather than always served, and why
 * `limit` is capped: the default page is one keyed read regardless of history,
 * and the caller has to ask for the part that grows.
 *
 * ## Ordering: `source_decision_id desc`, and why not "newest reveal"
 *
 * The natural ordering for a ledger walk is by reveal time. It is not
 * available: 086 has `revealed_at` in the ledger's inner subqueries only and
 * never projects it to the outer select list, so no consumer of this view can
 * order by it. `as_of` is a publisher stamp that ties heavily — picks land on
 * exact 15-minute boundaries — so it cannot key a cursor either.
 *
 * `source_decision_id` is the available monotone proxy, and a keyset on it is
 * only correct if it is unique per row. Measured over the largest scope that
 * exists (`participant_id=anthropic-claude-fable-5`, the full 1,095 rows past
 * the gate, walked in two requests): **1,095 rows, 1,095 distinct
 * `source_decision_id`, zero duplicates, strictly decreasing** — and 1,095
 * distinct `(participant_id, game_id, market)` keys, which independently
 * confirms the view's latest-per-key property on live data.
 *
 * That is a measurement over one scope on one day, not a schema guarantee, so
 * the handler does not rely on it: a page carrying the same
 * `source_decision_id` twice is refused as an integrity fault rather than
 * served, the same way `readAllByKeyset` refuses a cursor that fails to
 * advance. A strict `lt` cursor over a non-unique key silently SKIPS rows, and
 * a silent skip on a page whose purpose is to report measured results is the
 * failure worth spending three lines to make loud.
 *
 * ## The latent `network` interaction, inherited from the view
 *
 * Like every other reader of this view, the handler filters
 * `.eq('network', ...)` AFTER a dedup that partitions on
 * `(participant_id, game_id, market)` with no `network` (086:375). If one key
 * ever exists on two networks, the dedup keeps whichever row has the newer
 * `as_of` and this filter can then drop it — a row missing rather than an
 * error. Unreachable today: `benchmark_cohort_participants` is 358 rows, all
 * `polygon`. Recorded here because the fix belongs in the indexer view and this
 * is the second endpoint to inherit it; see the merge commit of #85.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../../lib/env.js';
import { getSupabase } from '../../lib/supabase.js';
import type { ApiError } from '../../middleware/errorHandler.js';
import {
  BENCHMARK,
  ProjectionIntegrityError,
  respondProjectionFault,
  respondToQueryError,
} from './source.js';
import { decimalToAmerican, resolveSelectionSide, selectionLabel, sidedLine } from './picks.js';
import { axesOf } from './pick.js';

/** Markets a pick can be on. A typo is a 400, not a 200 with nothing. */
const LEDGER_MARKETS = new Set(['moneyline', 'spread', 'total']);

/**
 * The filters that bound a read BY CONSTRUCTION. At least one is required.
 *
 * Named as data rather than spelled out in the branch so the 400 message, the
 * README and the check cannot disagree about what qualifies.
 */
const ANCHORS = ['participantId', 'gameId', 'slateDate'] as const;

/** Page size bounds. The default is a card grid's worth; the cap bounds payload. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** `YYYY-MM-DD`, checked before it reaches PostgREST — a bad date is 22007 otherwise. */
const SLATE_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface LedgerFilters {
  participantId: string | null;
  gameId: string | null;
  slateDate: string | null;
  market: string | null;
  sport: string | null;
}

/** The subset of the view this endpoint projects. A list, not a dossier. */
interface LedgerPageRow {
  participant_id: string;
  participant_name: string;
  lab_id: string | null;
  cohort_id: string;
  slate_date: string;
  game_id: string;
  away_team_name: string;
  away_team_abbreviation: string;
  home_team_name: string;
  home_team_abbreviation: string;
  start_time: string | null;
  game_status: string | null;
  away_score: number | null;
  home_score: number | null;
  sport: string;
  market: string;
  selection: string | null;
  line: number | null;
  pick_price_decimal: number | null;
  closing_line: number | null;
  closing_price_decimal: number | null;
  closing_captured_at: string | null;
  clv_pct: number | null;
  margin_adjusted_clv_pct: number | null;
  unscored_reason: string | null;
  scoring_policy_version: string | null;
  clv_scored_at: string | null;
  held_out_of_primary: boolean | null;
  primary_axis: string | null;
  axis_valuation: number | null;
  axis_trend: number | null;
  axis_consensus: number | null;
  axis_news: number | null;
  axis_softness: number | null;
  result: string | null;
  filled_at: string | null;
  stake_usdc: number | null;
  net_usdc: number | null;
  fill_tx_hash: string | null;
  as_of: string;
  source_decision_id: number;
}

const PAGE_SELECT = [
  'participant_id', 'participant_name', 'lab_id', 'cohort_id', 'slate_date', 'game_id',
  'away_team_name', 'away_team_abbreviation', 'home_team_name', 'home_team_abbreviation',
  'start_time', 'game_status', 'away_score', 'home_score', 'sport', 'market',
  'selection', 'line', 'pick_price_decimal', 'closing_line', 'closing_price_decimal',
  'closing_captured_at', 'clv_pct', 'margin_adjusted_clv_pct', 'unscored_reason',
  'scoring_policy_version', 'clv_scored_at', 'held_out_of_primary', 'primary_axis',
  'axis_valuation', 'axis_trend', 'axis_consensus', 'axis_news', 'axis_softness',
  'result', 'filled_at', 'stake_usdc', 'net_usdc', 'fill_tx_hash', 'as_of',
  'source_decision_id',
].join(', ');

/**
 * One served row.
 *
 * Every nullable field passes through as the DDL stores it, for the reasons
 * `pick.ts` documents: `netUsdc` null only means `pending`, a `clvPct` null WITH
 * an `unscoredReason` is a refusal rather than a gap, and `heldOutOfPrimary`
 * stays tri-state because `?? false` turns "not tagged" into "not held".
 *
 * `axesOf` and `sidedLine` are IMPORTED rather than re-derived. That is
 * deliberate and it is the whole lesson of #85's review: both of that PR's
 * defects arrived by copying this logic out of an adjacent handler, so the third
 * endpoint to need it calls the same function instead of carrying a third copy.
 */
function toRow(row: LedgerPageRow): Record<string, unknown> {
  const american = decimalToAmerican(row.pick_price_decimal);
  const away = { name: row.away_team_name, abbreviation: row.away_team_abbreviation };
  const home = { name: row.home_team_name, abbreviation: row.home_team_abbreviation };
  const side = resolveSelectionSide(row.selection, away, home);
  const pickLine = sidedLine(row.market, row.line);
  const closingLine = sidedLine(row.market, row.closing_line);

  return {
    participantId: row.participant_id,
    displayName: row.participant_name,
    lab: row.lab_id,
    cohortId: row.cohort_id,
    slateDate: row.slate_date,
    sport: row.sport,
    market: row.market,
    game: {
      gameId: row.game_id,
      awayTeam: away,
      homeTeam: home,
      startTime: row.start_time,
      status: row.game_status,
      awayScore: row.away_score,
      homeScore: row.home_score,
    },
    selection: row.selection,
    selectionLabel: selectionLabel(row.market, row.selection, row.line, american, side),
    selectionSide: side,
    line: pickLine.line,
    awayLine: pickLine.awayLine,
    homeLine: pickLine.homeLine,
    priceDecimal: row.pick_price_decimal,
    priceAmerican: american,
    closing: {
      line: closingLine.line,
      awayLine: closingLine.awayLine,
      homeLine: closingLine.homeLine,
      priceDecimal: row.closing_price_decimal,
      priceAmerican: decimalToAmerican(row.closing_price_decimal),
      capturedAt: row.closing_captured_at,
      ready: row.closing_captured_at !== null,
    },
    clv: {
      pct: row.clv_pct,
      marginAdjustedPct: row.margin_adjusted_clv_pct,
      unscoredReason: row.unscored_reason,
      scoringPolicyVersion: row.scoring_policy_version,
      scoredAt: row.clv_scored_at,
      heldOutOfPrimary: row.held_out_of_primary,
    },
    axes: axesOf(row),
    primaryAxis: row.primary_axis,
    execution: {
      result: row.result,
      filledAt: row.filled_at,
      stakeUsdc: row.stake_usdc,
      netUsdc: row.net_usdc,
      fillTxHash: row.fill_tx_hash,
    },
    decisionId: row.source_decision_id,
    asOf: row.as_of,
  };
}

/** The shape of an answer that serves no rows, so an empty page is never bare. */
function emptyPage(
  network: string,
  filters: LedgerFilters,
  limit: number,
  minSlateDate: string | null,
  count: number | null,
): Record<string, unknown> {
  return {
    network,
    minSlateDate,
    filters,
    page: { limit, returned: 0, nextAfter: null, hasMore: false },
    count: { exact: count },
    axisScale: { min: 1, max: 5 },
    rows: [],
  };
}

export async function getBenchmarkLedgerHandler(req: Request, res: Response): Promise<void> {
  const str = (name: string): string | null => {
    const raw = req.query[name];
    if (raw === undefined) return null;
    const trimmed = String(raw).trim();
    return trimmed === '' ? null : trimmed;
  };

  const filters: LedgerFilters = {
    participantId: str('participantId'),
    gameId: str('gameId'),
    slateDate: str('slateDate'),
    market: str('market'),
    sport: str('sport'),
  };

  const bad = (error: string, code: string): void => {
    res.status(400).json({ error, code } satisfies ApiError);
  };

  // ── Request validity first, before the publication gate.
  //
  // A malformed request is a statement about the REQUEST, and answering it is
  // useful whether or not anything is published. Checking the gate first would
  // hand a client with a typo a cheerful empty page, which is the shape of bug
  // that gets diagnosed as "the API returns nothing" a week later. `pick.ts`
  // validates its market before its gate for the same reason.
  if (!ANCHORS.some((a) => filters[a] !== null)) {
    bad(
      `At least one of ${ANCHORS.join(', ')} is required. ` +
        'The ledger view ranks over the whole live set before any limit applies, so an ' +
        'unanchored read exceeds the statement timeout. "sport" and "market" narrow an ' +
        'anchored read and do not qualify on their own.',
      'FILTER_REQUIRED',
    );
    return;
  }
  if (filters.market !== null && !LEDGER_MARKETS.has(filters.market)) {
    bad(
      `Invalid "market". Must be one of: ${[...LEDGER_MARKETS].sort().join(', ')}.`,
      'INVALID_PARAM',
    );
    return;
  }
  if (filters.slateDate !== null && !SLATE_DATE.test(filters.slateDate)) {
    bad('Invalid "slateDate". Must be YYYY-MM-DD.', 'INVALID_PARAM');
    return;
  }

  const limitRaw = str('limit');
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    // `Number.parseInt` would accept "25abc" and "25.9". A page size is an
    // integer or it is a client bug worth reporting.
    if (!/^\d+$/.test(limitRaw)) {
      bad(`Invalid "limit". Must be an integer between 1 and ${String(MAX_LIMIT)}.`, 'INVALID_PARAM');
      return;
    }
    limit = Number(limitRaw);
    if (limit < 1 || limit > MAX_LIMIT) {
      bad(`Invalid "limit". Must be an integer between 1 and ${String(MAX_LIMIT)}.`, 'INVALID_PARAM');
      return;
    }
  }

  const afterRaw = str('after');
  let after: number | null = null;
  if (afterRaw !== null) {
    if (!/^\d+$/.test(afterRaw)) {
      bad('Invalid "after". Must be a decisionId from a previous page\'s nextAfter.', 'INVALID_PARAM');
      return;
    }
    after = Number(afterRaw);
  }

  const countRaw = str('count');
  if (countRaw !== null && countRaw !== 'exact') {
    // `planned` and `estimated` are deliberately NOT offered. Measured
    // 2026-09-21 on a scope whose true total is 1095: `count=planned` answers
    // `Content-Range: */1` and `count=estimated` answers `*/1001`. Both are
    // accepted by the server and both are wrong by orders of magnitude, and "1"
    // reads as a plausible small result rather than as an error. An exact count
    // or none.
    bad('Invalid "count". The only supported value is "exact".', 'INVALID_PARAM');
    return;
  }
  const wantCount = countRaw === 'exact';

  const config = loadConfig();

  // THE PUBLICATION GATE. Unset means nothing is public, answered without
  // reading anything — same doctrine as `window.ts`, `stats.ts` and `pick.ts`.
  const minSlateDate = config.benchmarkPublicMinSlateDate;
  if (minSlateDate === undefined) {
    res.status(200).json(emptyPage(config.network, filters, limit, null, wantCount ? 0 : null));
    return;
  }

  const sb = getSupabase();

  // ONE list of equality filters, consumed by BOTH reads below.
  //
  // Written as data rather than as two chains on purpose. The page and the count
  // must describe the same population — a filter added to one and forgotten on
  // the other publishes a total that does not match its own rows, and no type
  // checker can see the omission in two hand-built chains. This is the same
  // `3d-sibling` shape that `sidedLine` exists to close, one layer out.
  const eqFilters: Array<[string, string]> = [['network', config.network]];
  if (filters.participantId !== null) eqFilters.push(['participant_id', filters.participantId]);
  if (filters.gameId !== null) eqFilters.push(['game_id', filters.gameId]);
  if (filters.slateDate !== null) eqFilters.push(['slate_date', filters.slateDate]);
  if (filters.market !== null) eqFilters.push(['market', filters.market]);
  if (filters.sport !== null) eqFilters.push(['sport', filters.sport]);

  // One extra row is the `hasMore` probe. Asking for `limit + 1` and serving
  // `limit` costs one row and needs no count, so paging stays correct when the
  // caller has not asked for the expensive total.
  let pageQ = sb.from(BENCHMARK.pickLedger).select(PAGE_SELECT);
  for (const [column, value] of eqFilters) pageQ = pageQ.eq(column, value);
  pageQ = pageQ.gte('slate_date', minSlateDate);
  // The cursor belongs to the PAGE only — see the count read below.
  if (after !== null) pageQ = pageQ.lt('source_decision_id', after);
  const pageRes = await pageQ
    .order('source_decision_id', { ascending: false })
    .limit(limit + 1);
  if (pageRes.error) {
    respondToQueryError(res, pageRes.error, BENCHMARK.pickLedger);
    return;
  }

  // Same cast the sibling handlers use: a runtime-built select string gives the
  // client nothing to infer from, so the row type is asserted here and pinned by
  // the tests rather than by the compiler.
  const fetched = (pageRes.data ?? []) as unknown as LedgerPageRow[];
  const hasMore = fetched.length > limit;
  const served = hasMore ? fetched.slice(0, limit) : fetched;

  try {
    // The keyset cursor is only sound while `source_decision_id` is unique per
    // row. Measured true over the largest live scope (1,095/1,095 distinct), and
    // enforced here rather than assumed: a `lt` cursor over a non-unique key
    // SKIPS rows across the page boundary, silently, on an endpoint whose whole
    // purpose is to report measured results.
    const ids = new Set<number>();
    for (const row of served) {
      if (ids.has(row.source_decision_id)) {
        throw new ProjectionIntegrityError(
          BENCHMARK.pickLedger,
          `decisionId ${String(row.source_decision_id)} appeared twice in one page, so a keyset ` +
            'cursor on it would skip rows',
        );
      }
      ids.add(row.source_decision_id);
    }

    let exact: number | null = null;
    if (wantCount) {
      // Its own read, deliberately WITHOUT the cursor: a total that shrank as
      // the caller paged would be a different number on every page and useless
      // for the thing a count is for. Opt-in because this is the part of the
      // request that grows with history — 0.41-1.06s measured across the
      // qualifying filter sets, against 0.31-0.94s for the page alone.
      let countQ = sb
        .from(BENCHMARK.pickLedger)
        .select('source_decision_id', { count: 'exact' });
      for (const [column, value] of eqFilters) countQ = countQ.eq(column, value);
      countQ = countQ.gte('slate_date', minSlateDate);
      // Deliberately NO `.lt('source_decision_id', after)`: the total describes
      // the filtered population, not what is left after the cursor. A count that
      // shrank as the caller paged would be a different number on every page.
      const countRes = await countQ.limit(1);
      if (countRes.error) {
        respondToQueryError(res, countRes.error, BENCHMARK.pickLedger);
        return;
      }
      exact = countRes.count;
    }

    const last = served.length > 0 ? served[served.length - 1] : undefined;
    res.status(200).json({
      network: config.network,
      minSlateDate,
      filters,
      page: {
        limit,
        returned: served.length,
        // The cursor to pass back as `after`. Null when there is no next page,
        // so a caller that follows it terminates rather than re-reading the tail.
        nextAfter: hasMore && last !== undefined ? last.source_decision_id : null,
        hasMore,
      },
      count: { exact },
      axisScale: { min: 1, max: 5 },
      rows: served.map(toRow),
    });
  } catch (err: unknown) {
    if (respondProjectionFault(res, err)) return;
    throw err;
  }
}
