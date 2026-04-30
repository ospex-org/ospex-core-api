/**
 * GET /v1/markets               — list upcoming contests with their speculations
 * GET /v1/markets/:contestId    — single contest detail (with stub orderbook)
 *
 * The agent-server's R3 orderbook field has been removed (R4 superseded
 * it with off-chain EIP-712 commitments). For the detail endpoint we
 * return `orderbook: []` for each speculation as a placeholder; a future
 * batch can populate from the `commitments` table aggregated per
 * (speculation_key, position_type).
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { scorerToType, lineTicksToLine, type MarketType } from '../lib/speculation.js';
import type { ApiError } from '../middleware/errorHandler.js';

const VALID_SPORTS = new Set(['nba', 'nhl', 'ncaab', 'nfl', 'mlb']);
// Mirrors what `ospex-indexer/src/handlers/contests.ts` writes today
// (unverified/verified/scored/voided) plus `scored_manually` from
// agent / ops paths. Keep in sync with the indexer's contest-status
// emissions.
const VALID_STATUSES = new Set(['unverified', 'verified', 'scored', 'scored_manually', 'voided']);

const DEFAULT_WINDOW_HOURS = 72;
const MAX_WINDOW_HOURS = 168;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

interface MarketSpeculation {
  speculationId: string;
  type: MarketType;
  lineTicks: number | null;   // raw int32 (10x format, 0 for moneyline)
  line: number | null;        // human-readable: lineTicks / 10
  awayLine?: number;          // spread only
  homeLine?: number;          // spread only
  speculationStatus: number;  // 0 = active, 1 = closed
}

interface MarketSpeculationDetail extends MarketSpeculation {
  orderbook: unknown[];     // intentionally empty — see header comment
}

interface MarketBody {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  sport: string;
  sportId: number;
  matchTime: string;
  status: string;
}

interface MarketListItem extends MarketBody {
  speculations: MarketSpeculation[];
}

interface MarketDetail extends MarketBody {
  speculations: MarketSpeculationDetail[];
}

interface SpecRow {
  speculation_id: string | number;
  contest_id: string | number;
  speculation_scorer: string | null;
  line_ticks: number | null;
  speculation_status: string | null;
}

function specRowToBase(spec: SpecRow, scorers: { moneyline: string; spread: string; total: string }): MarketSpeculation | null {
  const type = scorerToType(spec.speculation_scorer ?? '', scorers);
  if (!type) return null;
  const lineTicks = spec.line_ticks ?? null;
  const line = lineTicksToLine(type, lineTicks);
  const status = spec.speculation_status === 'closed' ? 1 : 0;
  const base: MarketSpeculation = {
    speculationId: String(spec.speculation_id),
    type,
    lineTicks,
    line,
    speculationStatus: status,
  };
  if (type === 'spread' && line != null) {
    base.awayLine = line;
    base.homeLine = -line;
  }
  return base;
}

// ── GET /v1/markets ────────────────────────────────────────────────────

export async function getMarketsHandler(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  if (!config.scorers) {
    res.status(500).json({ error: 'Server not configured: missing scorer addresses.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  const scorers = config.scorers;

  const sportFilter = req.query.sport ? String(req.query.sport).toLowerCase() : null;
  if (sportFilter && !VALID_SPORTS.has(sportFilter)) {
    res.status(400).json({
      error: `Invalid sport "${sportFilter}". Must be one of: ${[...VALID_SPORTS].join(', ')}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const statusFilter = req.query.status ? String(req.query.status).toLowerCase() : null;
  if (statusFilter && !VALID_STATUSES.has(statusFilter)) {
    res.status(400).json({
      error: `Invalid status "${statusFilter}". Must be one of: ${[...VALID_STATUSES].join(', ')}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const windowHours = req.query.window ? Number(req.query.window) : DEFAULT_WINDOW_HOURS;
  if (!Number.isFinite(windowHours) || windowHours < 1 || windowHours > MAX_WINDOW_HOURS) {
    res.status(400).json({
      error: `window must be between 1 and ${MAX_WINDOW_HOURS} hours.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    res.status(400).json({
      error: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    res.status(400).json({
      error: 'offset must be a non-negative integer.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const sb = getSupabase();
  const now = new Date().toISOString();
  const upper = new Date(Date.now() + windowHours * 3600_000).toISOString();

  let q = sb
    .from('contests')
    .select('contest_id, away_team, home_team, sport_slug, jsonodds_sport_id, start_time, contest_status', { count: 'exact' })
    .eq('network', config.network)
    .gte('start_time', now)
    .lte('start_time', upper)
    .order('start_time', { ascending: true })
    .range(offset, offset + limit - 1);

  if (sportFilter) q = q.eq('sport_slug', sportFilter);
  if (statusFilter) q = q.eq('contest_status', statusFilter);

  const contestsRes = await q;
  if (contestsRes.error) {
    logger.error({ err: contestsRes.error.message }, 'markets: contest query failed');
    res.status(500).json({ error: 'Failed to list markets.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const contests = contestsRes.data ?? [];
  const total = contestsRes.count ?? 0;
  if (contests.length === 0) {
    res.status(200).json({
      markets: [],
      pagination: { limit, offset, total, hasMore: false },
    });
    return;
  }

  // Batch-fetch speculations for all contests in this page.
  const contestIds = contests.map((c) => c.contest_id);
  const specsRes = await sb
    .from('speculations')
    .select('speculation_id, contest_id, speculation_scorer, line_ticks, speculation_status')
    .eq('network', config.network)
    .in('contest_id', contestIds);

  if (specsRes.error) {
    logger.error({ err: specsRes.error.message }, 'markets: speculation query failed');
    res.status(500).json({ error: 'Failed to list speculations.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const specsByContest = new Map<string, MarketSpeculation[]>();
  for (const s of specsRes.data ?? []) {
    const ms = specRowToBase(s as SpecRow, scorers);
    if (!ms) continue;
    const key = String(s.contest_id);
    const list = specsByContest.get(key) ?? [];
    list.push(ms);
    specsByContest.set(key, list);
  }

  const markets: MarketListItem[] = contests.map((c) => ({
    contestId: String(c.contest_id),
    awayTeam: c.away_team ?? '',
    homeTeam: c.home_team ?? '',
    sport: c.sport_slug ?? '',
    sportId: c.jsonodds_sport_id ?? 0,
    matchTime: c.start_time ?? '',
    status: c.contest_status ?? '',
    speculations: specsByContest.get(String(c.contest_id)) ?? [],
  }));

  res.status(200).json({
    markets,
    pagination: { limit, offset, total, hasMore: offset + contests.length < total },
  });
}

// ── GET /v1/markets/:contestId ─────────────────────────────────────────

export async function getMarketByIdHandler(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  if (!config.scorers) {
    res.status(500).json({ error: 'Server not configured: missing scorer addresses.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  const scorers = config.scorers;

  const raw = String(req.params.contestId ?? '').trim();
  let contestId: string;
  try {
    const v = BigInt(raw);
    if (v < 0n) throw new Error();
    contestId = v.toString();
  } catch {
    res.status(400).json({
      error: 'Invalid contestId. Must be a non-negative integer.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const sb = getSupabase();
  const contestRes = await sb
    .from('contests')
    .select('contest_id, away_team, home_team, sport_slug, jsonodds_sport_id, start_time, contest_status')
    .eq('network', config.network)
    .eq('contest_id', contestId)
    .maybeSingle();

  if (contestRes.error) {
    logger.error({ err: contestRes.error.message }, 'markets: contest detail query failed');
    res.status(500).json({ error: 'Failed to fetch market.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (!contestRes.data) {
    res.status(404).json({ error: `Contest ${contestId} not found.`, code: 'NOT_FOUND' } satisfies ApiError);
    return;
  }

  const c = contestRes.data;
  const specsRes = await sb
    .from('speculations')
    .select('speculation_id, contest_id, speculation_scorer, line_ticks, speculation_status')
    .eq('network', config.network)
    .eq('contest_id', contestId);

  if (specsRes.error) {
    logger.error({ err: specsRes.error.message }, 'markets: speculation detail query failed');
    res.status(500).json({ error: 'Failed to fetch speculations.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const speculations: MarketSpeculationDetail[] = [];
  for (const s of specsRes.data ?? []) {
    const ms = specRowToBase(s as SpecRow, scorers);
    if (!ms) continue;
    speculations.push({ ...ms, orderbook: [] });
  }

  const body: MarketDetail = {
    contestId: String(c.contest_id),
    awayTeam: c.away_team ?? '',
    homeTeam: c.home_team ?? '',
    sport: c.sport_slug ?? '',
    sportId: c.jsonodds_sport_id ?? 0,
    matchTime: c.start_time ?? '',
    status: c.contest_status ?? '',
    speculations,
  };
  res.status(200).json(body);
}
