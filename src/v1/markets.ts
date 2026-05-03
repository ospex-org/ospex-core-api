/**
 * GET /v1/markets               — list upcoming contests with their speculations
 * GET /v1/markets/:contestId    — single contest detail with populated orderbooks
 *
 * The agent-server's R3 orderbook field has been removed (R4 superseded
 * it with off-chain EIP-712 commitments). The detail endpoint groups
 * commitments by `speculation_key` and attaches the same default
 * open-book filter set as `GET /v1/commitments` (status open or
 * partially_filled, not invalidated, not expired). The list endpoint
 * intentionally still returns speculations without orderbooks — populating
 * for every contest in a window is heavy and not currently needed.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { scorerToType, lineTicksToLine, type MarketType } from '../lib/speculation.js';
import { deriveSpeculationKey } from '../lib/eip712.js';
import type { ApiError } from '../middleware/errorHandler.js';
import { fetchOpenCommitmentsByContestId, type CommitmentBody } from './commitments.js';

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
  orderbook: CommitmentBody[];
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
  /**
   * Upstream JSONOdds ID for this contest, used by the SDK to open
   * Realtime channels on `current_odds`. Null when the contest was
   * created without a JSONOdds linkage. Surfaced on the detail
   * endpoint only — list responses stay minimal.
   */
  jsonoddsId: string | null;
  /**
   * Contest fields surfaced on the detail endpoint only. The list
   * endpoint omits them to keep page payloads lean. Source hashes are
   * the keccak256 of the Chainlink Functions JS sources baked into
   * the on-chain contest at creation; they're persisted by the
   * indexer and surfaced here so SDK consumers can verify the contest
   * was created against the protocol-approved scripts.
   *
   * Naming conflates Contest and Market for now. A future rename pass
   * (`client.markets` → `client.speculations`, separating Contest as
   * its own entity) will untangle this.
   */
  rundownId: string | null;
  sportspageId: string | null;
  contestCreator: string;
  leagueId: string;
  verifySourceHash: string | null;
  marketUpdateSourceHash: string | null;
  scoreContestSourceHash: string | null;
  awayScore: number | null;
  homeScore: number | null;
  contestCreatedAt: string | null;
  verifiedAt: string | null;
  scoredAt: string | null;
  voidedAt: string | null;
  speculations: MarketSpeculationDetail[];
}

interface SpecRow {
  speculation_id: string | number;
  contest_id: string | number;
  speculation_scorer: string | null;
  line_ticks: number | null;
  speculation_status: string | null;
}

/**
 * Explicit row shape for the detail query. Supabase's inference gives
 * up at this column count and falls back to `GenericStringError`, so
 * we narrow with an `as` cast at the consumer instead.
 */
interface ContestDetailRow {
  contest_id: string | number;
  jsonodds_id: string | null;
  rundown_id: string | null;
  sportspage_id: string | null;
  contest_creator: string | null;
  league_id: string | null;
  verify_source_hash: string | null;
  market_update_source_hash: string | null;
  score_contest_source_hash: string | null;
  away_team: string | null;
  home_team: string | null;
  sport_slug: string | null;
  jsonodds_sport_id: number | null;
  start_time: string | null;
  contest_status: string | null;
  away_score: number | null;
  home_score: number | null;
  contest_created_at: string | null;
  verified_at: string | null;
  scored_at: string | null;
  voided_at: string | null;
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
    .select(
      'contest_id, jsonodds_id, rundown_id, sportspage_id, contest_creator, league_id, ' +
        'verify_source_hash, market_update_source_hash, score_contest_source_hash, ' +
        'away_team, home_team, sport_slug, jsonodds_sport_id, start_time, contest_status, ' +
        'away_score, home_score, contest_created_at, verified_at, scored_at, voided_at',
    )
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

  const c = contestRes.data as unknown as ContestDetailRow;
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

  const ob = await fetchOpenCommitmentsByContestId(contestId);
  if (ob.error || !ob.commitments) {
    logger.error({ err: ob.error }, 'markets: orderbook query failed');
    res.status(500).json({ error: 'Failed to fetch orderbook.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  // Group commitments by speculation_key. Indexer-only rows that haven't
  // been enriched yet (speculationKey === null) cannot be attributed to a
  // speculation and are dropped from the orderbook.
  const orderbookByKey = new Map<string, CommitmentBody[]>();
  for (const c of ob.commitments) {
    if (!c.speculationKey) continue;
    const list = orderbookByKey.get(c.speculationKey) ?? [];
    list.push(c);
    orderbookByKey.set(c.speculationKey, list);
  }
  // TODO: price-aware sort. The existing /v1/commitments endpoint sorts
  // by created_at DESC for chronological listing; an orderbook wants
  // best-price-first, but "best" depends on which side a commitment
  // takes (positionType + oddsTick) and there's no convention here yet.
  // For now, sort by createdAt ascending (earliest first) only.
  for (const list of orderbookByKey.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  const contestIdBig = BigInt(contestId);
  const speculations: MarketSpeculationDetail[] = [];
  for (const s of specsRes.data ?? []) {
    const ms = specRowToBase(s as SpecRow, scorers);
    if (!ms) continue;
    let orderbook: CommitmentBody[] = [];
    if (s.speculation_scorer && s.line_ticks != null) {
      const key = deriveSpeculationKey(
        contestIdBig,
        String(s.speculation_scorer).toLowerCase(),
        s.line_ticks,
      );
      orderbook = orderbookByKey.get(key) ?? [];
    }
    speculations.push({ ...ms, orderbook });
  }

  const body: MarketDetail = {
    contestId: String(c.contest_id),
    jsonoddsId: c.jsonodds_id ?? null,
    rundownId: c.rundown_id ?? null,
    sportspageId: c.sportspage_id ?? null,
    contestCreator: c.contest_creator ?? '',
    leagueId: c.league_id ?? 'unknown',
    verifySourceHash: c.verify_source_hash ?? null,
    marketUpdateSourceHash: c.market_update_source_hash ?? null,
    scoreContestSourceHash: c.score_contest_source_hash ?? null,
    awayTeam: c.away_team ?? '',
    homeTeam: c.home_team ?? '',
    sport: c.sport_slug ?? '',
    sportId: c.jsonodds_sport_id ?? 0,
    matchTime: c.start_time ?? '',
    status: c.contest_status ?? '',
    awayScore: c.away_score ?? null,
    homeScore: c.home_score ?? null,
    contestCreatedAt: c.contest_created_at ?? null,
    verifiedAt: c.verified_at ?? null,
    scoredAt: c.scored_at ?? null,
    voidedAt: c.voided_at ?? null,
    speculations,
  };
  res.status(200).json(body);
}
