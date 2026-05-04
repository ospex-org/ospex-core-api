/**
 * /v1/speculations/* — speculation read endpoints. First-class entity
 * surface to complement `/v1/contests/*`; mirrors the on-chain
 * `Speculation` struct (a single bettable line on a contest).
 *
 *   GET /v1/speculations                       — list speculations with filters
 *                                                (contestId, sport, status,
 *                                                limit, offset). List rows omit
 *                                                orderbook (parallel to /v1/contests).
 *   GET /v1/speculations/:speculationId        — single speculation with the
 *                                                full orderbook + a parent
 *                                                contest context block.
 *
 * The `?contestId=` filter is the fast path (single-table query keyed
 * on the indexed `contest_id` column). `?sport=` joins through contests
 * (extra round-trip — there's no sport column on speculations).
 *
 * Reads `speculations.market_type` directly — does not depend on the
 * `SCORER_*_ADDRESS` env vars (the indexer enriches market_type at
 * speculation-creation time, and the column is NOT NULL).
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { deriveSpeculationKey } from '../lib/eip712.js';
import {
  COMMITMENT_COLUMNS,
  rowToBody,
  type CommitmentBody,
  type CommitmentRow,
} from './commitments.js';
import {
  SPECULATION_COLUMNS,
  specRowToSpeculation,
  type Speculation,
  type SpeculationDetail,
  type SpeculationParentContext,
  type SpeculationRow,
} from './utils/speculations.js';
import type { ApiError } from '../middleware/errorHandler.js';

const VALID_SPORTS = new Set(['nba', 'nhl', 'ncaab', 'nfl', 'mlb']);
const VALID_SPECULATION_STATUSES = new Set(['open', 'closed']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ── GET /v1/speculations ───────────────────────────────────────────────

interface SpeculationsListBody {
  speculations: Speculation[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

export async function getSpeculationsHandler(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();

  // ── Parse + validate query params ─────────────────────────────────────
  let contestIdFilter: string | undefined;
  if (req.query.contestId !== undefined) {
    try {
      const v = BigInt(String(req.query.contestId));
      if (v < 0n) throw new Error();
      contestIdFilter = v.toString();
    } catch {
      res.status(400).json({
        error: 'contestId must be a non-negative integer.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
  }

  const sportFilter = req.query.sport ? String(req.query.sport).toLowerCase() : null;
  if (sportFilter && !VALID_SPORTS.has(sportFilter)) {
    res.status(400).json({
      error: `Invalid sport "${sportFilter}". Must be one of: ${[...VALID_SPORTS].join(', ')}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const statusFilter = req.query.status ? String(req.query.status).toLowerCase() : null;
  if (statusFilter && !VALID_SPECULATION_STATUSES.has(statusFilter)) {
    res.status(400).json({
      error: `Invalid status "${statusFilter}". Must be one of: ${[...VALID_SPECULATION_STATUSES].join(', ')}.`,
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

  // ── Resolve --sport to a contest_id list (slow path) ─────────────────
  // No sport column on speculations; have to filter via the parent
  // contests table. Skip when --sport isn't set.
  let contestIdsFromSport: string[] | undefined;
  if (sportFilter) {
    const sportRes = await sb
      .from('contests')
      .select('contest_id')
      .eq('network', config.network)
      .eq('sport_slug', sportFilter);
    if (sportRes.error) {
      logger.error({ err: sportRes.error.message }, 'speculations: sport→contest_id resolve failed');
      res.status(500).json({ error: 'Failed to resolve sport filter.', code: 'INTERNAL_ERROR' } satisfies ApiError);
      return;
    }
    contestIdsFromSport = (sportRes.data ?? []).map((r) => String(r.contest_id));
    if (contestIdsFromSport.length === 0) {
      res.status(200).json({
        speculations: [],
        pagination: { limit, offset, total: 0, hasMore: false },
      } satisfies SpeculationsListBody);
      return;
    }
  }

  // ── Build the speculations query ──────────────────────────────────────
  let q = sb
    .from('speculations')
    .select(SPECULATION_COLUMNS, { count: 'exact' })
    .eq('network', config.network)
    .order('contest_id', { ascending: false })
    .order('speculation_id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (contestIdFilter !== undefined) q = q.eq('contest_id', contestIdFilter);
  if (statusFilter) q = q.eq('speculation_status', statusFilter);
  if (contestIdsFromSport !== undefined) q = q.in('contest_id', contestIdsFromSport);

  const { data, count, error } = await q;
  if (error) {
    logger.error({ err: error.message }, 'speculations: list query failed');
    res.status(500).json({ error: 'Failed to list speculations.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const speculations: Speculation[] = [];
  for (const row of data ?? []) {
    const s = specRowToSpeculation(row as SpeculationRow);
    if (s) speculations.push(s);
  }

  const total = count ?? 0;
  const body: SpeculationsListBody = {
    speculations,
    pagination: { limit, offset, total, hasMore: offset + (data?.length ?? 0) < total },
  };
  res.status(200).json(body);
}

// ── GET /v1/speculations/:speculationId ────────────────────────────────

interface ContestContextRow {
  contest_id: string | number;
  away_team: string | null;
  home_team: string | null;
  sport_slug: string | null;
  start_time: string | null;
  contest_status: string | null;
}

export async function getSpeculationByIdHandler(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();

  const raw = String(req.params.speculationId ?? '').trim();
  let speculationId: string;
  try {
    const v = BigInt(raw);
    if (v < 0n) throw new Error();
    speculationId = v.toString();
  } catch {
    res.status(400).json({
      error: 'Invalid speculationId. Must be a non-negative integer.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const specRes = await sb
    .from('speculations')
    .select(SPECULATION_COLUMNS)
    .eq('network', config.network)
    .eq('speculation_id', speculationId)
    .maybeSingle();

  if (specRes.error) {
    logger.error({ err: specRes.error.message }, 'speculations: detail query failed');
    res.status(500).json({ error: 'Failed to fetch speculation.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (!specRes.data) {
    res.status(404).json({ error: `Speculation ${speculationId} not found.`, code: 'NOT_FOUND' } satisfies ApiError);
    return;
  }

  const specRow = specRes.data as unknown as SpeculationRow;
  const speculation = specRowToSpeculation(specRow);
  if (!speculation) {
    // market_type missing / unrecognized — schema says NOT NULL but be defensive
    logger.error({ speculationId, row: specRow }, 'speculations: row missing market_type');
    res.status(500).json({ error: 'Speculation row malformed.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  // Parent contest context (5 fields — keeps the response useful without
  // a second fetch). Source hashes / lifecycle timestamps stay on
  // /v1/contests/:contestId.
  const ctxRes = await sb
    .from('contests')
    .select('contest_id, away_team, home_team, sport_slug, start_time, contest_status')
    .eq('network', config.network)
    .eq('contest_id', speculation.contestId)
    .maybeSingle();

  if (ctxRes.error) {
    logger.error({ err: ctxRes.error.message }, 'speculations: parent contest query failed');
    res.status(500).json({ error: 'Failed to fetch parent contest.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  if (!ctxRes.data) {
    // Speculation row exists but parent contest doesn't — indicates an
    // indexer inconsistency, not a client error. 500 is right.
    logger.error({ speculationId, contestId: speculation.contestId }, 'speculations: parent contest missing');
    res.status(500).json({ error: 'Parent contest not found.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }
  const ctxRow = ctxRes.data as unknown as ContestContextRow;
  const contest: SpeculationParentContext = {
    contestId: String(ctxRow.contest_id),
    awayTeam: ctxRow.away_team ?? '',
    homeTeam: ctxRow.home_team ?? '',
    sport: ctxRow.sport_slug ?? '',
    matchTime: ctxRow.start_time ?? '',
    status: ctxRow.contest_status ?? '',
  };

  // Orderbook — single targeted query keyed on speculation_key. Same
  // default open-book filter as `/v1/commitments` (open or
  // partially_filled, not invalidated, not expired).
  let orderbook: CommitmentBody[] = [];
  if (specRow.speculation_scorer && specRow.line_ticks != null) {
    const speculationKey = deriveSpeculationKey(
      BigInt(speculation.contestId),
      String(specRow.speculation_scorer).toLowerCase(),
      specRow.line_ticks,
    );
    const obRes = await sb
      .from('commitments')
      .select(COMMITMENT_COLUMNS)
      .eq('network', config.network)
      .eq('speculation_key', speculationKey)
      .in('status', ['open', 'partially_filled'])
      .eq('nonce_invalidated', false)
      .gt('expiry', new Date().toISOString())
      .order('created_at', { ascending: true });

    if (obRes.error) {
      logger.error({ err: obRes.error.message }, 'speculations: orderbook query failed');
      res.status(500).json({ error: 'Failed to fetch orderbook.', code: 'INTERNAL_ERROR' } satisfies ApiError);
      return;
    }
    orderbook = (obRes.data ?? []).map((r) => rowToBody(r as unknown as CommitmentRow));
  }

  const body: SpeculationDetail = { ...speculation, orderbook, contest };
  res.status(200).json(body);
}
