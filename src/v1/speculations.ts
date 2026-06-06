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
import { SPORTS as VALID_SPORTS, isSport } from '../lib/sports.js';
import { resolveTeamIdsForContest } from '../lib/teamIds.js';
import {
  COMMITMENT_COLUMNS,
  OPEN_BOOK_MAX_ROWS,
  commitmentRowToPublicBody,
  type CommitmentBody,
  type CommitmentHiddenBody,
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
import type { CursorableRow } from '../lib/cursor.js';
import { nextCursor, parseRecovery, recoveryKeysetExpr } from '../lib/recovery.js';
import type { ApiError } from '../middleware/errorHandler.js';

// VALID_SPORTS is the shared canonical list from lib/sports.ts (drops
// the prior local 5-sport set that omitted ncaaf). The detail handler
// uses lib/teamIds.ts to widen the parent contest context with team
// UUIDs the SDK resolver needs.
const VALID_SPECULATION_STATUSES = new Set(['open', 'closed']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ── GET /v1/speculations ───────────────────────────────────────────────

interface SpeculationsListBody {
  speculations: Speculation[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

// ── GET /v1/speculations?since=<cursor> (recovery mode) ─────────────────
//
// Cursor-ordered (row_updated_at, id) catch-up for the speculations stream:
// surfaces scored / settled / voided lifecycle transitions a disconnected
// client missed. Identity filter: contestId. No status/open-book defaults.
// State-delta convergence (latest state per row), not a full event log.
type SpeculationRecoveryRow = SpeculationRow & CursorableRow;

async function getSpeculationsRecovery(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();

  const recovery = parseRecovery(req, 'speculations');
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

  let q = sb
    .from('speculations')
    .select(`${SPECULATION_COLUMNS}, id, row_updated_at`)
    .eq('network', config.network);
  if (contestId !== undefined) q = q.eq('contest_id', contestId);
  if (recovery.cursor) q = q.or(recoveryKeysetExpr(recovery.cursor));
  q = q.order('row_updated_at', { ascending: true }).order('id', { ascending: true }).limit(recovery.limit);

  const { data, error } = await q;
  if (error) {
    logger.error({ err: error.message }, 'speculations: recovery query failed');
    res.status(500).json({ error: 'Failed to fetch speculation changes.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const rows = (data ?? []) as unknown as SpeculationRecoveryRow[];
  const speculations: Speculation[] = [];
  for (const r of rows) {
    const s = specRowToSpeculation(r as unknown as SpeculationRow);
    if (s) speculations.push(s);
  }
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
  res.status(200).json({
    speculations,
    nextCursor: nextCursor('speculations', last, recovery.sinceRaw),
    hasMore: rows.length === recovery.limit,
  });
}

export async function getSpeculationsHandler(req: Request, res: Response): Promise<void> {
  if (req.query.since !== undefined) {
    await getSpeculationsRecovery(req, res);
    return;
  }

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
  if (sportFilter && !isSport(sportFilter)) {
    res.status(400).json({
      error: `Invalid sport "${sportFilter}". Must be one of: ${[...VALID_SPORTS].sort().join(', ')}.`,
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
  // contests table. Skip when --sport isn't set. Paginate the lookup —
  // PostgREST caps each query at 1000 rows, and a single sport can
  // accumulate well past that across a season, so an unpaginated select
  // would silently drop contests and the resulting speculation list
  // would be missing rows with no error.
  const CONTEST_ID_PAGE = 1000;
  let contestIdsFromSport: string[] | undefined;
  if (sportFilter) {
    const ids: string[] = [];
    for (let pageOffset = 0; ; pageOffset += CONTEST_ID_PAGE) {
      const page = await sb
        .from('contests')
        .select('contest_id')
        .eq('network', config.network)
        .eq('sport_slug', sportFilter)
        .order('contest_id', { ascending: true })
        .range(pageOffset, pageOffset + CONTEST_ID_PAGE - 1);
      if (page.error) {
        logger.error({ err: page.error.message }, 'speculations: sport→contest_id resolve failed');
        res.status(500).json({ error: 'Failed to resolve sport filter.', code: 'INTERNAL_ERROR' } satisfies ApiError);
        return;
      }
      const rows = page.data ?? [];
      for (const r of rows) ids.push(String(r.contest_id));
      if (rows.length < CONTEST_ID_PAGE) break;
    }
    contestIdsFromSport = ids;
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
  jsonodds_id: string | null;
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

  // Parent contest context. Source hashes / lifecycle timestamps stay
  // on /v1/contests/:contestId; this block is the bare minimum the SDK
  // resolver needs. `jsonodds_id` is selected (but not surfaced in the
  // response body) so we can resolve team UUIDs via the games join.
  const ctxRes = await sb
    .from('contests')
    .select('contest_id, jsonodds_id, away_team, home_team, sport_slug, start_time, contest_status')
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
  const teamIds = await resolveTeamIdsForContest(config.network, ctxRow.jsonodds_id ?? null);
  const contest: SpeculationParentContext = {
    contestId: String(ctxRow.contest_id),
    awayTeam: ctxRow.away_team ?? '',
    homeTeam: ctxRow.home_team ?? '',
    awayTeamId: teamIds.awayTeamId,
    homeTeamId: teamIds.homeTeamId,
    sport: ctxRow.sport_slug ?? '',
    matchTime: ctxRow.start_time ?? '',
    status: ctxRow.contest_status ?? '',
  };

  // Orderbook — single targeted query keyed on speculation_key. Same
  // default open-book filter as `/v1/commitments` (open or
  // partially_filled, not invalidated, not expired).
  let orderbook: Array<CommitmentBody | CommitmentHiddenBody> = [];
  if (specRow.speculation_scorer && specRow.line_ticks != null) {
    const speculationKey = deriveSpeculationKey(
      BigInt(speculation.contestId),
      String(specRow.speculation_scorer).toLowerCase(),
      specRow.line_ticks,
    );
    // One captured `now` for both the expiry boundary and body labeling.
    const nowMs = Date.now();
    const obRes = await sb
      .from('commitments')
      .select(COMMITMENT_COLUMNS)
      .eq('network', config.network)
      .eq('speculation_key', speculationKey)
      .in('status', ['open', 'partially_filled'])
      .eq('book_visible', true)
      .eq('nonce_invalidated', false)
      .gt('expiry', new Date(nowMs).toISOString())
      .order('created_at', { ascending: true })
      .limit(OPEN_BOOK_MAX_ROWS);

    if (obRes.error) {
      logger.error({ err: obRes.error.message }, 'speculations: orderbook query failed');
      res.status(500).json({ error: 'Failed to fetch orderbook.', code: 'INTERNAL_ERROR' } satisfies ApiError);
      return;
    }
    // Route every row through the redaction router (defense-in-depth on top of
    // the `book_visible=true` filter): a hidden row that ever slips past the
    // filter surfaces REDACTED in the flat orderbook (matching the list /
    // recovery paths), never as the full signed payload.
    orderbook = (obRes.data ?? []).map((r) => commitmentRowToPublicBody(r as unknown as CommitmentRow, nowMs));
  }

  const body: SpeculationDetail = { ...speculation, orderbook, contest };
  res.status(200).json(body);
}
