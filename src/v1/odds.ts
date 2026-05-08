/**
 * GET /v1/contests/:contestId/odds
 *
 * Returns the latest `current_odds` rows for the contest's underlying
 * upstream game (jsonodds row), keyed by market. One row per market —
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
 * the user-facing flow starts from an Ospex contest ID — agents and
 * humans alike open `ospex contests show <id>` first. Resolving
 * jsonoddsId from contestId on the server keeps the public API
 * vocabulary consistent with the rest of /v1.
 *
 * Spread line semantics: matches the writer (`ospex-writer/src/loop/
 * pollCycle.ts:523`) — `line` is the **home team's spread**. Total
 * `line` is the over/under threshold. Moneyline `line` is null.
 * Consumers labelling sides should follow this convention.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import type { ApiError } from '../middleware/errorHandler.js';

interface OddsSnapshotResponse {
  jsonoddsId: string;
  market: 'moneyline' | 'spread' | 'total';
  network: string;
  line: number | null;
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
  upstreamLastUpdated: string;
  pollCapturedAt: string;
  changedAt: string;
}

interface ContestOddsResponse {
  contestId: string;
  jsonoddsId: string | null;
  odds: {
    moneyline: OddsSnapshotResponse | null;
    spread: OddsSnapshotResponse | null;
    total: OddsSnapshotResponse | null;
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
    if (row.market !== 'moneyline' && row.market !== 'spread' && row.market !== 'total') {
      // Defensive: the table has a CHECK constraint, but if a future
      // market type is added before this handler is updated we don't
      // want it to crash the response shape.
      continue;
    }
    odds[row.market] = {
      jsonoddsId: row.jsonodds_id,
      market: row.market,
      network,
      line: row.line,
      awayOddsAmerican: row.away_odds_american,
      homeOddsAmerican: row.home_odds_american,
      upstreamLastUpdated: row.upstream_last_updated,
      pollCapturedAt: row.poll_captured_at,
      changedAt: row.changed_at,
    };
  }

  const response: ContestOddsResponse = {
    contestId,
    jsonoddsId,
    odds,
  };
  res.status(200).json(response);
}
