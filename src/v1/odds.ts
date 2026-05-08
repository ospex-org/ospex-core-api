/**
 * GET /v1/contests/:contestId/odds
 *
 * Returns the latest `current_odds` rows for the contest's underlying
 * upstream game (jsonodds row), keyed by market. One entry per market —
 * `null` for markets the writer hasn't populated yet (or for which the
 * upstream provider doesn't carry odds for this game).
 *
 * Scope: this is **upstream reference odds** — what the broader sports
 * betting market is currently pricing the game at, sourced from
 * JSONOdds (live) / Sportspage (opening lines) by `ospex-writer` on a
 * ~30s polling cycle. Ospex commitments are user-priced and don't have
 * to match these. The SDK and CLI surfacing this endpoint label it as
 * reference data for the same reason.
 *
 * Endpoint shape is contest-centric (not jsonodds-id-centric) because
 * the user-facing flow starts from an Ospex contest ID. Resolving
 * jsonoddsId from contestId on the server keeps the public API
 * vocabulary consistent with the rest of /v1.
 *
 * Per-market response shapes are explicit (no shared "line +
 * awayOddsAmerican + homeOddsAmerican" envelope) so consumers can't
 * misread the semantics:
 *
 *   - moneyline { awayOddsAmerican, homeOddsAmerican }
 *       Per-side American odds. Line is meaningless here, so it isn't
 *       in the shape at all.
 *
 *   - spread { awayLine, homeLine, awayOddsAmerican, homeOddsAmerican }
 *       Both sides of the spread line are explicit. Convention from
 *       the writer (pollCycle.ts:523) is that current_odds.line stores
 *       the *home* team's spread (negative if home favored); we expose
 *       both `homeLine` (raw) and `awayLine = -homeLine` so callers
 *       don't have to remember which side the un-labelled `line`
 *       belongs to. Mirrors `/v1/analytics/odds-history` and the
 *       speculation row in `/v1/contests/:contestId`.
 *
 *   - total { line, overOddsAmerican, underOddsAmerican }
 *       Single line is the over/under threshold (perspective-neutral).
 *       Over and under odds are named explicitly even though the
 *       writer stores Over → away_odds_american and Under →
 *       home_odds_american (`pollCycle.ts:526`); consumers should
 *       never see the writer's storage convention.
 *
 * Per-market entries do not duplicate `jsonoddsId` (it's at the
 * top-level response — the snapshot is for one game) or `network`
 * (the API is deployment-bound to one network).
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import type { ApiError } from '../middleware/errorHandler.js';

interface OddsTimestamps {
  upstreamLastUpdated: string;
  pollCapturedAt: string;
  changedAt: string;
}

interface MoneylineOddsResponse extends OddsTimestamps {
  market: 'moneyline';
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

interface SpreadOddsResponse extends OddsTimestamps {
  market: 'spread';
  /** Away team's spread (= -homeLine when home line is set). */
  awayLine: number | null;
  /** Home team's spread (raw current_odds.line — negative if home favored). */
  homeLine: number | null;
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

interface TotalOddsResponse extends OddsTimestamps {
  market: 'total';
  /** Over/under threshold (perspective-neutral). */
  line: number | null;
  overOddsAmerican: number | null;
  underOddsAmerican: number | null;
}

interface ContestOddsResponse {
  contestId: string;
  jsonoddsId: string | null;
  odds: {
    moneyline: MoneylineOddsResponse | null;
    spread: SpreadOddsResponse | null;
    total: TotalOddsResponse | null;
  };
}

interface ContestRow {
  jsonodds_id: string | null;
}

interface CurrentOddsRow {
  jsonodds_id: string;
  market: string;
  line: number | null;
  away_odds_american: number | null;
  home_odds_american: number | null;
  upstream_last_updated: string;
  poll_captured_at: string;
  changed_at: string;
}

const CURRENT_ODDS_SELECT =
  'jsonodds_id, market, line, away_odds_american, home_odds_american, upstream_last_updated, poll_captured_at, changed_at';

export async function getCurrentOddsHandler(req: Request, res: Response): Promise<void> {
  // Express types `req.params[key]` as `string | string[]` (the array
  // arm covers a few exotic route-pattern matchers); contestId is a
  // plain `:contestId` segment so it's always a string at runtime, but
  // narrow defensively for the type-checker.
  const contestIdRaw = req.params.contestId;
  if (typeof contestIdRaw !== 'string' || contestIdRaw === '') {
    res.status(400).json({
      error: 'contestId is required.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const contestId: string = contestIdRaw;

  // Contest IDs are bigint on chain — accept any numeric string.
  if (!/^\d+$/.test(contestId)) {
    res.status(400).json({
      error: 'contestId must be a numeric string.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const { network } = loadConfig();
  const sb = getSupabase();

  // Step 1 — resolve the contest's upstream jsonoddsId. We deliberately
  // do this in a separate query (rather than joining to current_odds in
  // one shot) so that "contest exists but has no upstream linkage" is a
  // distinguishable success state (200 with all-null markets) rather
  // than a 404.
  const contestRes = await sb
    .from('contests')
    .select('jsonodds_id')
    .eq('network', network)
    .eq('contest_id', contestId)
    .maybeSingle();

  if (contestRes.error) {
    logger.error(
      { err: contestRes.error.message, contestId },
      'odds: contest lookup failed',
    );
    res.status(500).json({
      error: 'Failed to fetch contest.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }

  if (contestRes.data === null) {
    res.status(404).json({
      error: `Contest not found: ${contestId}`,
      code: 'NOT_FOUND',
    } satisfies ApiError);
    return;
  }

  const contestRow = contestRes.data as unknown as ContestRow;
  const jsonoddsId = contestRow.jsonodds_id;

  // No upstream linkage → 200 with all-null markets. Same shape as a
  // contest whose writer hasn't populated current_odds yet, so consumers
  // have one code path to handle "no odds available" regardless of why.
  if (jsonoddsId === null || jsonoddsId === '') {
    const empty: ContestOddsResponse = {
      contestId,
      jsonoddsId: null,
      odds: { moneyline: null, spread: null, total: null },
    };
    res.status(200).json(empty);
    return;
  }

  // Step 2 — fetch current_odds for this jsonoddsId. Filter to network
  // because (network, jsonodds_id, market) is the row scope; without
  // the network filter, mainnet and amoy rows for the same upstream
  // game id would collide.
  const oddsRes = await sb
    .from('current_odds')
    .select(CURRENT_ODDS_SELECT)
    .eq('network', network)
    .eq('jsonodds_id', jsonoddsId);

  if (oddsRes.error) {
    logger.error(
      { err: oddsRes.error.message, contestId, jsonoddsId },
      'odds: current_odds query failed',
    );
    res.status(500).json({
      error: 'Failed to fetch odds.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }

  const rows = (oddsRes.data ?? []) as unknown as CurrentOddsRow[];
  const odds: ContestOddsResponse['odds'] = {
    moneyline: null,
    spread: null,
    total: null,
  };

  for (const row of rows) {
    const ts: OddsTimestamps = {
      upstreamLastUpdated: row.upstream_last_updated,
      pollCapturedAt: row.poll_captured_at,
      changedAt: row.changed_at,
    };
    if (row.market === 'moneyline') {
      odds.moneyline = {
        ...ts,
        market: 'moneyline',
        awayOddsAmerican: row.away_odds_american,
        homeOddsAmerican: row.home_odds_american,
      };
    } else if (row.market === 'spread') {
      // Writer stores `line` as the home team's spread (PointSpreadHome
      // — pollCycle.ts:523). Expose both sides explicitly so callers
      // never have to remember which side the raw column belongs to.
      const homeLine = row.line;
      odds.spread = {
        ...ts,
        market: 'spread',
        awayLine: homeLine === null ? null : -homeLine,
        homeLine,
        awayOddsAmerican: row.away_odds_american,
        homeOddsAmerican: row.home_odds_american,
      };
    } else if (row.market === 'total') {
      // Writer stores Over → away_odds_american and Under →
      // home_odds_american (pollCycle.ts:526 reads OverLine into the
      // away slot). Consumers see over/under names directly; the
      // storage convention does not leak.
      odds.total = {
        ...ts,
        market: 'total',
        line: row.line,
        overOddsAmerican: row.away_odds_american,
        underOddsAmerican: row.home_odds_american,
      };
    }
    // Defensive: an unknown market value (the table has a CHECK
    // constraint, but a future market type would otherwise crash the
    // shape contract) is silently ignored.
  }

  const response: ContestOddsResponse = {
    contestId,
    jsonoddsId,
    odds,
  };
  res.status(200).json(response);
}
