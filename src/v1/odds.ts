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
 * The per-market shapes (and the row→shape mapping) are shared with the
 * SSE odds stream via `utils/odds.ts`, so a one-shot snapshot here and a
 * live `change`/`refresh` delta on `/v1/stream/odds` are the same shape
 * for the same market.
 *
 * This REST response still carries a top-level `jsonoddsId` (the snapshot
 * is for one game); the SSE stream omits it. Per-market entries never
 * duplicate it or `network` (the API is deployment-bound to one network).
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import type { ApiError } from '../middleware/errorHandler.js';
import {
  rowToMarketOdds,
  CURRENT_ODDS_COLUMNS,
  type MarketOddsRow,
  type MoneylineOdds,
  type SpreadOdds,
  type TotalOdds,
} from './utils/odds.js';

interface ContestOddsResponse {
  contestId: string;
  jsonoddsId: string | null;
  odds: {
    moneyline: MoneylineOdds | null;
    spread: SpreadOdds | null;
    total: TotalOdds | null;
  };
}

interface ContestRow {
  jsonodds_id: string | null;
}

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
    .select(CURRENT_ODDS_COLUMNS)
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

  const rows = (oddsRes.data ?? []) as unknown as MarketOddsRow[];
  const odds: ContestOddsResponse['odds'] = {
    moneyline: null,
    spread: null,
    total: null,
  };

  for (const row of rows) {
    const shape = rowToMarketOdds(row);
    if (shape === null) continue; // defensive: unknown market value
    if (shape.market === 'moneyline') odds.moneyline = shape;
    else if (shape.market === 'spread') odds.spread = shape;
    else odds.total = shape;
  }

  const response: ContestOddsResponse = {
    contestId,
    jsonoddsId,
    odds,
  };
  res.status(200).json(response);
}
