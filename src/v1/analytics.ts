/**
 * /v1/analytics/* — sports analytics surface.
 *
 *   GET /v1/analytics/odds-history/:contestId
 *     Opener (Sportspage open) vs current (latest JsonOdds snapshot)
 *     for the contest's three markets (moneyline, spread, total),
 *     plus a line-movement summary for spread/total.
 *
 * This is the only `/v1/analytics/*` endpoint ported from
 * ospex-agent-server. The other 11 (elo/*, schedule, injuries,
 * standings, team-stats, rankings, rosters, expert-picks, matchup)
 * read from sports-reference tables that have no active writer in
 * the new architecture (writers lived in the retired
 * ospex-agent-server/db/supabase/queries.ts). They will return
 * stale rows until the data-feed question is decided independently.
 * See `audit-agent-server-api.md` for the full inventory.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import type { ApiError } from '../middleware/errorHandler.js';

// ────────────────────────────────────────────────────────────────────
// Line snapping
// ────────────────────────────────────────────────────────────────────

/**
 * Normalize a spread or total line to end in .5. Sportspage opening
 * lines occasionally come through as whole numbers; Ospex requires
 * half-lines (whole numbers introduce push outcomes that the protocol
 * doesn't model).
 *
 * - Already .5 → returned as-is.
 * - Whole number → bumped: total +0.5; spread +0.5 if positive, -0.5 if negative
 *   (preserve direction in away-team perspective).
 * - Other fractions → returned undefined (reject). Keeps weird upstream data
 *   out of downstream consumers.
 */
function snapToHalfLine(raw: unknown, kind: 'spread' | 'total'): number | undefined {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;

  const frac = Math.abs(n) % 1;
  const isHalf = Math.abs(frac - 0.5) < 1e-9;
  const isWhole = Math.abs(frac) < 1e-9;

  if (isHalf) return n;
  if (!isWhole) return undefined;

  if (kind === 'total') return n + 0.5;
  return n >= 0 ? n + 0.5 : n - 0.5;
}

// ────────────────────────────────────────────────────────────────────
// Response shape
// ────────────────────────────────────────────────────────────────────

interface SidedSnapshot {
  capturedAt: string | null;
  moneyline?: { awayOdds: number; homeOdds: number };
  spread?: { line: number; awayOdds: number; homeOdds: number };
  total?: { line: number; overOdds: number; underOdds: number };
}

interface OddsHistoryResponse {
  contestId: string;
  jsonoddsId: string;
  opener: SidedSnapshot;
  current: SidedSnapshot;
  /**
   * Per-market movement from opener → current. Only populated when
   * BOTH opener and current snapshots exist for that market. Always
   * present as an object so callers can do `lineMovement.spread &&
   * ...` without first null-checking the parent.
   */
  lineMovement: {
    spread?: { opened: number; current: number; moved: number };
    total?: { opened: number; current: number; moved: number };
  };
}

interface OddsHistoryRow {
  jsonodds_id: string;
  market: 'moneyline' | 'spread' | 'total';
  line: number | null;
  away_odds_decimal: number | null;
  home_odds_decimal: number | null;
  source: 'jsonodds' | 'sportspage_open';
  captured_at: string;
}

const HISTORY_COLUMNS =
  'jsonodds_id, market, line, away_odds_decimal, home_odds_decimal, source, captured_at';

// ────────────────────────────────────────────────────────────────────
// Snapshot construction
// ────────────────────────────────────────────────────────────────────

/**
 * Reduce a set of odds_history rows (≤3 — one per market) into a
 * SidedSnapshot. The earliest capturedAt across the rows is used as
 * the snapshot's timestamp; markets missing valid odds (null fields
 * or weird-fraction lines) are silently omitted.
 *
 * Over=away, Under=home for total markets — same convention used by
 * the indexer's projection of speculations into the protocol's
 * upper/lower position types.
 */
function rowsToSnapshot(rows: OddsHistoryRow[]): SidedSnapshot {
  const snap: SidedSnapshot = { capturedAt: null };
  for (const row of rows) {
    if (snap.capturedAt === null) snap.capturedAt = row.captured_at;
    const away = row.away_odds_decimal;
    const home = row.home_odds_decimal;
    if (away == null || home == null) continue;

    if (row.market === 'moneyline') {
      snap.moneyline = { awayOdds: away, homeOdds: home };
    } else if (row.market === 'spread' && row.line !== null) {
      const line = snapToHalfLine(row.line, 'spread');
      if (line !== undefined) snap.spread = { line, awayOdds: away, homeOdds: home };
    } else if (row.market === 'total' && row.line !== null) {
      const line = snapToHalfLine(row.line, 'total');
      if (line !== undefined) snap.total = { line, overOdds: away, underOdds: home };
    }
  }
  return snap;
}

// ────────────────────────────────────────────────────────────────────
// GET /v1/analytics/odds-history/:contestId
// ────────────────────────────────────────────────────────────────────

export async function getOddsHistoryHandler(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();

  // Validate :contestId via BigInt — matches GET /v1/commitments contestId
  // parsing. Number() loses precision above 2^53.
  let contestId: bigint;
  try {
    contestId = BigInt(String(req.params['contestId'] ?? ''));
  } catch {
    res.status(400).json({
      error: 'contestId must be a non-negative integer.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  if (contestId < 0n) {
    res.status(400).json({
      error: 'contestId must be non-negative.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  // Resolve jsonodds_id from the on-chain contest. odds_history isn't
  // network-scoped (one global JSONOdds ID space), but contests are.
  const lookup = await sb
    .from('contests')
    .select('jsonodds_id')
    .eq('network', config.network)
    .eq('contest_id', contestId.toString())
    .maybeSingle();

  if (lookup.error) {
    logger.error({ err: lookup.error.message }, 'odds-history: contest lookup failed');
    res.status(500).json({
      error: 'Failed to look up contest.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }
  if (!lookup.data) {
    res.status(404).json({
      error: `Contest ${contestId.toString()} not found on ${config.network}.`,
      code: 'NOT_FOUND',
    } satisfies ApiError);
    return;
  }

  const jsonoddsId = lookup.data.jsonodds_id as string | null;
  if (!jsonoddsId) {
    res.status(404).json({
      error: `Contest ${contestId.toString()} has no upstream odds source (jsonodds_id is null).`,
      code: 'NOT_FOUND',
    } satisfies ApiError);
    return;
  }

  // Two queries: opener (oldest sportspage_open per market) + current
  // (newest jsonodds per market). Limit 3 because there are at most
  // 3 markets per contest (moneyline, spread, total). For a contest
  // with all 3 markets seeded, this returns one row per market.
  const [openerQ, currentQ] = await Promise.all([
    sb
      .from('odds_history')
      .select(HISTORY_COLUMNS)
      .eq('jsonodds_id', jsonoddsId)
      .eq('source', 'sportspage_open')
      .order('captured_at', { ascending: true })
      .limit(3),
    sb
      .from('odds_history')
      .select(HISTORY_COLUMNS)
      .eq('jsonodds_id', jsonoddsId)
      .eq('source', 'jsonodds')
      .order('captured_at', { ascending: false })
      .limit(3),
  ]);

  if (openerQ.error || currentQ.error) {
    logger.error(
      { openerErr: openerQ.error?.message, currentErr: currentQ.error?.message },
      'odds-history: snapshot query failed',
    );
    res.status(500).json({
      error: 'Failed to fetch odds history.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }

  const opener = rowsToSnapshot((openerQ.data ?? []) as unknown as OddsHistoryRow[]);
  const current = rowsToSnapshot((currentQ.data ?? []) as unknown as OddsHistoryRow[]);

  const lineMovement: OddsHistoryResponse['lineMovement'] = {};
  if (opener.spread && current.spread) {
    lineMovement.spread = {
      opened: opener.spread.line,
      current: current.spread.line,
      moved: current.spread.line - opener.spread.line,
    };
  }
  if (opener.total && current.total) {
    lineMovement.total = {
      opened: opener.total.line,
      current: current.total.line,
      moved: current.total.line - opener.total.line,
    };
  }

  const body: OddsHistoryResponse = {
    contestId: contestId.toString(),
    jsonoddsId,
    opener,
    current,
    lineMovement,
  };
  res.status(200).json(body);
}
