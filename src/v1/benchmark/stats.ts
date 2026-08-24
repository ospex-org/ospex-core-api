/**
 * GET /v1/benchmark/stats — the landing page's three site-wide counters.
 *
 * `benchmark_site_stats` is APPEND-ONLY snapshots, one per `(network, sport,
 * as_of)`, written by a publisher on another box. A reader takes the newest
 * `as_of` per sport.
 *
 * ## The freshness bound, which is the whole reason this file is more than four
 * lines
 *
 * The front-end labels are fixed verbatim by the handoff — `available
 * commitments`, `filled · last 24h`, `matched · last 24h`. Serving the newest
 * row unconditionally means a publisher that dies on a Friday renders a
 * 72-hour-old count under a "last 24h" label all weekend: a false public
 * statement about money, with nothing on the page looking wrong and no error
 * anywhere to notice.
 *
 * So past `BENCHMARK_STATS_MAX_AGE_SECONDS` (default 48h, twice a daily
 * cadence) the three counters go null and `stale` goes true, with `asOf` and
 * `ageSeconds` still populated so a reader can see exactly how old the data
 * was rather than just that it was withheld. The front end's empty-state
 * doctrine renders nothing for a null, which is the correct thing to render
 * when nobody knows the number.
 *
 * ## 200 with nulls, never 404
 *
 * An absent row is an ordinary state — the publisher has not run yet — and a
 * 404 reads as a broken route. Same reasoning the arms' `executed` block uses
 * for its own empty case.
 *
 * ## Why `sport` is validated against the shared constant
 *
 * `benchmark_site_stats.sport` is CHECK-bounded to a lowercase token rather
 * than an enumeration, deliberately: migration 079 says "a sport should not
 * need a migration to appear". This endpoint is narrower than the column on
 * purpose, validating against `lib/sports.ts` so all three benchmark endpoints
 * and `/v1/games` speak ONE vocabulary. A sport published here but not yet in
 * that constant answers 400, and the fix is to add it there — which `/v1/games`
 * would need anyway.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../../lib/env.js';
import { getSupabase } from '../../lib/supabase.js';
import { SPORTS as VALID_SPORTS } from '../../lib/sports.js';
import type { ApiError } from '../../middleware/errorHandler.js';
import { BENCHMARK, respondToQueryError } from './source.js';
import { parseSportParam } from './window.js';
import { parseTimestampMicros } from '../utils/gameTime.js';

interface StatsRow {
  sport: string;
  as_of: string;
  available_commitments: number;
  fills_last_24h: number;
  matched_usdc_last_24h: number;
}

/**
 * Age in whole seconds, at microsecond resolution.
 *
 * `Date.parse` truncates to milliseconds and accepts shapes Postgres never
 * emits (`2026-02-30`, a zone-less local time); this surface has a house parser
 * that does neither and it is a one-line reuse.
 */
export function ageSeconds(asOf: string, now: Date): number | null {
  const then = parseTimestampMicros(asOf);
  if (then === null) return null;
  const nowMicros = BigInt(now.getTime()) * 1000n;
  return Number((nowMicros - then) / 1_000_000n);
}

/**
 * The no-numbers body, shared by the gate-closed and no-row paths.
 *
 * Identical on purpose: a caller cannot distinguish "the operator has not
 * published" from "the publisher has not run", and does not need to — both mean
 * there is no counter to render, and the front end's empty-state doctrine
 * renders nothing for either.
 */
function unavailable(network: string, sport: string, maxAgeSeconds: number): Record<string, unknown> {
  return {
    network,
    sport,
    asOf: null,
    ageSeconds: null,
    stale: true,
    maxAgeSeconds,
    availableCommitments: null,
    fillsLast24h: null,
    matchedUsdcLast24h: null,
  };
}

export async function getBenchmarkStatsHandler(req: Request, res: Response): Promise<void> {
  const parsed = parseSportParam(req.query.sport);
  if (parsed === 'invalid') {
    res.status(400).json({
      error: `Invalid "sport". Must be "all" or one of: ${[...VALID_SPORTS].sort().join(', ')}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  // `all` is a REAL stored value in this column, not an absence — the publisher
  // writes a pooled row under that literal sport. So the default is `all`, and
  // it is passed through to the filter rather than dropped.
  const sport = parsed ?? 'all';

  const config = loadConfig();

  // THE PUBLICATION GATE. Absent, this endpoint answers like the other two:
  // 200 with nulls, and NO query.
  //
  // It was missing here in the first cut, and the README's "unset means nothing
  // is served and no benchmark read happens" was therefore false of one of the
  // three endpoints — an untruth in prose that no test enforced, which is the
  // failure this repo's verification rules name first. Caught in review.
  //
  // `benchmark_site_stats` is site-wide rather than cohort-scoped, so the gate
  // here is presence of the config var rather than a slate-date comparison:
  // the question it answers is "is the benchmark surface public at all", and
  // the counters are the most money-adjacent numbers this projection serves.
  if (config.benchmarkPublicMinSlateDate === undefined) {
    res.status(200).json(unavailable(config.network, sport, config.benchmarkStatsMaxAgeSeconds));
    return;
  }

  const sb = getSupabase();

  const result = await sb
    .from(BENCHMARK.siteStats)
    .select('sport, as_of, available_commitments, fills_last_24h, matched_usdc_last_24h')
    .eq('network', config.network)
    .eq('sport', sport)
    .order('as_of', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    respondToQueryError(res, result.error, BENCHMARK.siteStats);
    return;
  }

  const maxAge = config.benchmarkStatsMaxAgeSeconds;

  if (result.data === null) {
    res.status(200).json(unavailable(config.network, sport, maxAge));
    return;
  }

  const row = result.data as unknown as StatsRow;
  const age = ageSeconds(row.as_of, new Date());
  // An unparseable `as_of` is treated as stale rather than as fresh. The column
  // is `timestamptz NOT NULL` so it cannot happen through Postgres; failing
  // open here would mean an unreadable timestamp silently licensed a "last 24h"
  // label on a row of unknown age.
  const stale = age === null || age > maxAge;

  res.status(200).json({
    network: config.network,
    sport: row.sport,
    asOf: row.as_of,
    ageSeconds: age,
    stale,
    maxAgeSeconds: maxAge,
    availableCommitments: stale ? null : row.available_commitments,
    fillsLast24h: stale ? null : row.fills_last_24h,
    matchedUsdcLast24h: stale ? null : Number(row.matched_usdc_last_24h),
  });
}
