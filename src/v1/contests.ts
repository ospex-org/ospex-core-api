/**
 * /v1/contests/* — contest read endpoints.
 *
 *   GET /v1/contests                        — list upcoming contests with their speculations
 *   GET /v1/contests/:contestId             — single contest detail with populated orderbooks
 *
 * The list endpoint stays lean (no orderbook population — heavy and not
 * currently needed). The detail endpoint groups commitments by
 * `speculation_key` and applies the same default open-book filter set
 * as `GET /v1/commitments` (status open or partially_filled, not
 * invalidated, not expired).
 *
 * `/v1/contests` was previously mounted at `/v1/markets`. The handlers
 * keep using `scorerToType(scorer, scorers)` for the scorer→market_type
 * mapping (back-compat — preserves the exact wire output the prior
 * `/v1/markets` endpoint produced). New code should prefer reading
 * `speculations.market_type` directly — see `/v1/speculations*`.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { deriveSpeculationKey } from '../lib/eip712.js';
import { SPORTS as VALID_SPORTS, isSport } from '../lib/sports.js';
import { resolveTeamIdsForContest } from '../lib/teamIds.js';
import type { ApiError } from '../middleware/errorHandler.js';
import { fetchOpenCommitmentsByContestId, type CommitmentBody } from './commitments.js';
import {
  SPECULATION_COLUMNS,
  specRowToSpeculationViaScorer,
  type Speculation,
  type SpeculationRow,
} from './utils/speculations.js';
import type { CursorableRow } from '../lib/cursor.js';
import { nextCursor, parseRecovery, recoveryKeysetExpr } from '../lib/recovery.js';

// VALID_SPORTS is the shared canonical list from lib/sports.ts.
// Previously this file carried a local 5-sport allowlist that omitted
// `ncaaf`; that local set is now retired in favor of the shared module
// so the only place to add a new sport is `lib/sports.ts`.
// Mirrors what the indexer writes today (unverified/verified/scored/
// voided) plus `scored_manually` from ops paths. Keep in sync with the
// indexer's contest-status emissions.
const VALID_STATUSES = new Set(['unverified', 'verified', 'scored', 'scored_manually', 'voided']);

const DEFAULT_WINDOW_HOURS = 72;
const MAX_WINDOW_HOURS = 168;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

interface ContestBody {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  sport: string;
  sportId: number;
  matchTime: string;
  status: string;
}

interface ContestListItem extends ContestBody {
  speculations: Speculation[];
}

// Team UUIDs are resolved via lib/teamIds.ts so contests + speculations
// share the same join logic. See that file's jsdoc for null semantics.

// LOCAL to this file — distinct from the exported `SpeculationDetail` in
// utils/speculations.ts (whose `orderbook` is the `CommitmentBody |
// CommitmentHiddenBody` union). The contest-detail orderbook stays
// `CommitmentBody[]` because this handler DROPS redacted rows — they have no
// `speculationKey` to group on (the speculation-detail endpoint surfaces them
// instead). See getContestByIdHandler.
interface SpeculationDetail extends Speculation {
  orderbook: CommitmentBody[];
}

interface ContestDetail extends ContestBody {
  /**
   * Team UUIDs resolved through the `games` join (see {@link resolveTeamIds}).
   * Surfaced on the detail endpoint only — list responses stay minimal.
   * Null when the contest has no JSONOdds linkage or the games row is
   * missing. Consumers of the SDK resolver layer use these to scope
   * alias matching; nulls trigger fallback to exact + nickname.
   */
  awayTeamId: string | null;
  homeTeamId: string | null;
  /**
   * Upstream JSONOdds ID for this contest, used by the SDK to open
   * Realtime channels on `current_odds`. Null when the contest was
   * created without a JSONOdds linkage. Surfaced on the detail
   * endpoint only — list responses stay minimal.
   */
  jsonoddsId: string | null;
  /** Contest fields surfaced on the detail endpoint only. */
  rundownId: string | null;
  sportspageId: string | null;
  contestCreator: string;
  leagueId: string;
  awayScore: number | null;
  homeScore: number | null;
  contestCreatedAt: string | null;
  verifiedAt: string | null;
  scoredAt: string | null;
  voidedAt: string | null;
  speculations: SpeculationDetail[];
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

// ── GET /v1/contests?since=<cursor> (recovery mode) ─────────────────────
//
// Cursor-ordered (row_updated_at, id) catch-up for the contests stream:
// surfaces verify / score / void lifecycle transitions (the triggers for
// settlement + claims) a disconnected client missed. Identity filter:
// contestId. Lean lifecycle-focused body; no speculations/orderbook (those
// have their own streams) so this path doesn't need SCORER_* config.
export interface ContestRecoveryRow extends CursorableRow {
  contest_id: string | number;
  away_team: string | null;
  home_team: string | null;
  sport_slug: string | null;
  jsonodds_sport_id: number | null;
  start_time: string | null;
  contest_status: string | null;
  away_score: number | null;
  home_score: number | null;
  verified_at: string | null;
  scored_at: string | null;
  voided_at: string | null;
  contest_created_at: string | null;
}

export interface ContestRecoveryBody {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  sport: string;
  sportId: number;
  matchTime: string;
  status: string;
  awayScore: number | null;
  homeScore: number | null;
  verifiedAt: string | null;
  scoredAt: string | null;
  voidedAt: string | null;
  contestCreatedAt: string | null;
}

export const CONTEST_RECOVERY_COLUMNS =
  'contest_id, away_team, home_team, sport_slug, jsonodds_sport_id, start_time, ' +
  'contest_status, away_score, home_score, verified_at, scored_at, voided_at, ' +
  'contest_created_at, id, row_updated_at';

export function contestRecoveryRowToBody(c: ContestRecoveryRow): ContestRecoveryBody {
  return {
    contestId: String(c.contest_id),
    awayTeam: c.away_team ?? '',
    homeTeam: c.home_team ?? '',
    sport: c.sport_slug ?? '',
    sportId: c.jsonodds_sport_id ?? 0,
    matchTime: c.start_time ?? '',
    status: c.contest_status ?? '',
    awayScore: c.away_score ?? null,
    homeScore: c.home_score ?? null,
    verifiedAt: c.verified_at ?? null,
    scoredAt: c.scored_at ?? null,
    voidedAt: c.voided_at ?? null,
    contestCreatedAt: c.contest_created_at ?? null,
  };
}

async function getContestsRecovery(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();

  const recovery = parseRecovery(req, 'contests');
  if ('errorBody' in recovery) {
    res.status(400).json(recovery.errorBody);
    return;
  }

  let contestId: string | undefined;
  if (req.query.contestId !== undefined) {
    try {
      const v = BigInt(String(req.query.contestId));
      if (v < 0n) throw new Error();
      contestId = v.toString();
    } catch {
      res.status(400).json({ error: 'contestId must be a non-negative integer.', code: 'INVALID_PARAM' } satisfies ApiError);
      return;
    }
  }

  let q = sb.from('contests').select(CONTEST_RECOVERY_COLUMNS).eq('network', config.network);
  if (contestId !== undefined) q = q.eq('contest_id', contestId);
  if (recovery.cursor) q = q.or(recoveryKeysetExpr(recovery.cursor));
  q = q.order('row_updated_at', { ascending: true }).order('id', { ascending: true }).limit(recovery.limit);

  const { data, error } = await q;
  if (error) {
    logger.error({ err: error.message }, 'contests: recovery query failed');
    res.status(500).json({ error: 'Failed to fetch contest changes.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const rows = (data ?? []) as unknown as ContestRecoveryRow[];
  const contests: ContestRecoveryBody[] = rows.map(contestRecoveryRowToBody);
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
  res.status(200).json({
    contests,
    nextCursor: nextCursor('contests', last, recovery.sinceRaw),
    hasMore: rows.length === recovery.limit,
  });
}

// ── GET /v1/contests ───────────────────────────────────────────────────

export async function getContestsHandler(req: Request, res: Response): Promise<void> {
  if (req.query.since !== undefined) {
    await getContestsRecovery(req, res);
    return;
  }

  const config = loadConfig();
  if (!config.scorers) {
    res.status(500).json({ error: 'Server not configured: missing scorer addresses.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  const scorers = config.scorers;

  const sportFilter = req.query.sport ? String(req.query.sport).toLowerCase() : null;
  if (sportFilter && !isSport(sportFilter)) {
    res.status(400).json({
      error: `Invalid sport "${sportFilter}". Must be one of: ${[...VALID_SPORTS].sort().join(', ')}.`,
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
    logger.error({ err: contestsRes.error.message }, 'contests: list query failed');
    res.status(500).json({ error: 'Failed to list contests.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const contests = contestsRes.data ?? [];
  const total = contestsRes.count ?? 0;
  if (contests.length === 0) {
    res.status(200).json({
      contests: [],
      pagination: { limit, offset, total, hasMore: false },
    });
    return;
  }

  const contestIds = contests.map((c) => c.contest_id);
  const specsRes = await sb
    .from('speculations')
    .select(SPECULATION_COLUMNS)
    .eq('network', config.network)
    .in('contest_id', contestIds);

  if (specsRes.error) {
    logger.error({ err: specsRes.error.message }, 'contests: speculation query failed');
    res.status(500).json({ error: 'Failed to list speculations.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const specsByContest = new Map<string, Speculation[]>();
  for (const s of specsRes.data ?? []) {
    const ms = specRowToSpeculationViaScorer(s as SpeculationRow, scorers);
    if (!ms) continue;
    const key = String(s.contest_id);
    const list = specsByContest.get(key) ?? [];
    list.push(ms);
    specsByContest.set(key, list);
  }

  const contestsList: ContestListItem[] = contests.map((c) => ({
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
    contests: contestsList,
    pagination: { limit, offset, total, hasMore: offset + contests.length < total },
  });
}

// ── GET /v1/contests/:contestId ─────────────────────────────────────────

export async function getContestByIdHandler(req: Request, res: Response): Promise<void> {
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
    logger.error({ err: contestRes.error.message }, 'contests: detail query failed');
    res.status(500).json({ error: 'Failed to fetch contest.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (!contestRes.data) {
    res.status(404).json({ error: `Contest ${contestId} not found.`, code: 'NOT_FOUND' } satisfies ApiError);
    return;
  }

  const c = contestRes.data as unknown as ContestDetailRow;
  const specsRes = await sb
    .from('speculations')
    .select(SPECULATION_COLUMNS)
    .eq('network', config.network)
    .eq('contest_id', contestId);

  if (specsRes.error) {
    logger.error({ err: specsRes.error.message }, 'contests: detail speculation query failed');
    res.status(500).json({ error: 'Failed to fetch speculations.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const ob = await fetchOpenCommitmentsByContestId(contestId);
  if (ob.error || !ob.commitments) {
    logger.error({ err: ob.error }, 'contests: orderbook query failed');
    res.status(500).json({ error: 'Failed to fetch orderbook.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  // Group commitments by speculation_key. Indexer-only rows that haven't
  // been enriched yet (speculationKey === null) cannot be attributed to a
  // speculation and are dropped from the orderbook.
  const orderbookByKey = new Map<string, CommitmentBody[]>();
  for (const cm of ob.commitments) {
    // Defense-in-depth: `fetchOpenCommitmentsByContestId` filters
    // book_visible=true AND routes every row through the redaction router. A
    // hidden row that ever slips past the filter arrives REDACTED
    // (`redacted: true`, no `speculationKey`) — it has no key to group on and an
    // off-book row has no place in the public orderbook, so log + drop it.
    if ('redacted' in cm) {
      logger.warn(
        { commitmentHash: cm.commitmentHash },
        'contests: hidden row reached the contest orderbook embed — redacted + dropped',
      );
      continue;
    }
    if (!cm.speculationKey) continue;
    const list = orderbookByKey.get(cm.speculationKey) ?? [];
    list.push(cm);
    orderbookByKey.set(cm.speculationKey, list);
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
  const speculations: SpeculationDetail[] = [];
  for (const s of specsRes.data ?? []) {
    const ms = specRowToSpeculationViaScorer(s as SpeculationRow, scorers);
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

  const teamIds = await resolveTeamIdsForContest(config.network, c.jsonodds_id ?? null);

  const body: ContestDetail = {
    contestId: String(c.contest_id),
    awayTeamId: teamIds.awayTeamId,
    homeTeamId: teamIds.homeTeamId,
    jsonoddsId: c.jsonodds_id ?? null,
    rundownId: c.rundown_id ?? null,
    sportspageId: c.sportspage_id ?? null,
    contestCreator: c.contest_creator ?? '',
    leagueId: c.league_id ?? 'unknown',
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
