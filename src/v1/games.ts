/**
 * GET /v1/games — upcoming games available for contest creation.
 * GET /v1/games/:gameId — single game by jsonodds_id.
 *
 * Reads `games` (writer-managed) instead of `current_schedules` because
 * `games` is the table the writer pipeline actually populates with the
 * three external IDs (jsonodds_id, sportspage_id, rundown_id) needed
 * by `OracleModule.createContestFromOracle`. Team UUIDs are joined to
 * `teams` for readable home/away names.
 *
 * **gameId stability.** The canonical `gameId` in the response is the
 * row's `jsonodds_id` — part of the writer's `(network, jsonodds_id)`
 * primary key, immutable for the life of the row. The writer's `slug`
 * field is exposed separately for human readability (e.g.
 * `lal-okc-2026-05-05`), but slugs are mutable: the writer renames them
 * when a doubleheader lands or a game is rescheduled. Anything that
 * stores a gameId between calls (CLI clipboard, SDK retries, scripts)
 * MUST use the jsonodds_id form, not the slug form, or `/v1/games/:id`
 * will 404 after a rename.
 *
 * The response includes `externalIds` ({ jsonodds, sportspage, rundown })
 * because contest creation needs all three; the SDK is responsible for
 * hiding them from end-user-facing public types so consumers only think
 * in terms of `gameId` + `client.contests.create({ gameId })`. Note that
 * `externalIds.jsonodds` is intentionally redundant with `gameId` — the
 * SDK code that builds the contract call reads it from `externalIds`
 * for symmetry with the other two IDs.
 *
 * `canCreateContest` is computed: all three external IDs present AND
 * `contest_created = false` AND `status = 'upcoming'`. Status is part
 * of the predicate because the schema admits `live | final | postponed |
 * cancelled` — without the status check, a postponed game with all IDs
 * would still report as creatable. The default `availableOnly=true`
 * applies the same predicate as a DB filter so the list view never
 * includes uncreatable rows.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { SPORTS as VALID_SPORTS, isSport, type Sport } from '../lib/sports.js';
import type { ApiError } from '../middleware/errorHandler.js';

const DEFAULT_WINDOW_HOURS = 168;
const MAX_WINDOW_HOURS = 720; // ~30 days
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

interface TeamInfo {
  name: string;
  abbreviation: string;
}

interface ExternalIds {
  jsonodds: string;
  sportspage: string | null;
  rundown: string | null;
}

interface GameRow {
  gameId: string;
  slug: string;
  sport: Sport;
  matchTime: string;
  status: string;
  homeTeam: TeamInfo;
  awayTeam: TeamInfo;
  hasOdds: boolean;
  contestCreated: boolean;
  contestId: string | null;
  canCreateContest: boolean;
  externalIds: ExternalIds;
}

interface GamesDbRow {
  network: string;
  jsonodds_id: string;
  sportspage_id: string | null;
  rundown_id: string | null;
  sport: string;
  match_time: string;
  status: string;
  home_team_id: string;
  away_team_id: string;
  has_odds: boolean | null;
  contest_created: boolean | null;
  // contest_id is `bigint` in PG; PostgREST may serialize as either
  // string (if it exceeds Number.MAX_SAFE_INTEGER) or number. Stringify
  // defensively in the handler — existing endpoints in this repo
  // (commitments / positions) follow the same pattern for bigint IDs.
  contest_id: string | number | null;
  slug: string;
}

interface TeamDbRow {
  id: string;
  name: string;
  abbrev: string;
}

const GAMES_SELECT =
  'network, jsonodds_id, sportspage_id, rundown_id, sport, match_time, status, home_team_id, away_team_id, has_odds, contest_created, contest_id, slug';

function parseBoolParam(raw: string | undefined): boolean | 'invalid' | undefined {
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return 'invalid';
}

function buildTeamLookup(rows: TeamDbRow[]): Map<string, TeamInfo> {
  const map = new Map<string, TeamInfo>();
  for (const t of rows) {
    map.set(t.id, { name: t.name, abbreviation: t.abbrev });
  }
  return map;
}

const FALLBACK_TEAM: TeamInfo = { name: 'Unknown', abbreviation: '???' };

function computeCanCreateContest(row: GamesDbRow): boolean {
  return (
    row.sportspage_id !== null &&
    row.sportspage_id !== '' &&
    row.rundown_id !== null &&
    row.rundown_id !== '' &&
    row.contest_created !== true &&
    row.status === 'upcoming'
  );
}

function dbRowToGameRow(row: GamesDbRow, teams: Map<string, TeamInfo>): GameRow {
  return {
    gameId: row.jsonodds_id,
    slug: row.slug,
    sport: row.sport as Sport,
    matchTime: row.match_time,
    status: row.status,
    homeTeam: teams.get(row.home_team_id) ?? FALLBACK_TEAM,
    awayTeam: teams.get(row.away_team_id) ?? FALLBACK_TEAM,
    hasOdds: row.has_odds === true,
    contestCreated: row.contest_created === true,
    contestId: row.contest_id !== null ? String(row.contest_id) : null,
    canCreateContest: computeCanCreateContest(row),
    externalIds: {
      jsonodds: row.jsonodds_id,
      sportspage: row.sportspage_id,
      rundown: row.rundown_id,
    },
  };
}

async function resolveTeams(rows: GamesDbRow[]): Promise<Map<string, TeamInfo>> {
  const teamIds = new Set<string>();
  for (const r of rows) {
    teamIds.add(r.home_team_id);
    teamIds.add(r.away_team_id);
  }
  if (teamIds.size === 0) return new Map();

  const sb = getSupabase();
  const teamsRes = await sb.from('teams').select('id, name, abbrev').in('id', [...teamIds]);
  if (teamsRes.error) {
    throw new Error(`teams query failed: ${teamsRes.error.message}`);
  }
  return buildTeamLookup((teamsRes.data ?? []) as unknown as TeamDbRow[]);
}

export async function getGamesHandler(req: Request, res: Response): Promise<void> {
  // sport — optional. If omitted, all in-scope sports are returned.
  let sport: Sport | undefined;
  if (req.query.sport !== undefined) {
    const sportRaw = String(req.query.sport).toLowerCase();
    if (!isSport(sportRaw)) {
      res.status(400).json({
        error: `Invalid "sport". Must be one of: ${[...VALID_SPORTS].sort().join(', ')}.`,
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    sport = sportRaw;
  }

  const windowHours = req.query.windowHours ? Number(req.query.windowHours) : DEFAULT_WINDOW_HOURS;
  if (!Number.isFinite(windowHours) || windowHours < 1 || windowHours > MAX_WINDOW_HOURS) {
    res.status(400).json({
      error: `windowHours must be between 1 and ${MAX_WINDOW_HOURS}.`,
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

  const availableOnlyRaw = parseBoolParam(
    req.query.availableOnly === undefined ? undefined : String(req.query.availableOnly),
  );
  if (availableOnlyRaw === 'invalid') {
    res.status(400).json({
      error: 'availableOnly must be "true" or "false".',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const availableOnly = availableOnlyRaw ?? true;

  const { network } = loadConfig();
  const sb = getSupabase();
  const start = new Date().toISOString();
  const end = new Date(Date.now() + windowHours * 3600_000).toISOString();

  let q = sb
    .from('games')
    .select(GAMES_SELECT, { count: 'exact' })
    .eq('network', network)
    .gte('match_time', start)
    .lte('match_time', end)
    .order('match_time', { ascending: true });

  if (sport !== undefined) q = q.eq('sport', sport);

  // The DB has no single "available" boolean; emulate canCreateContest
  // server-side so callers don't have to filter client-side AND so we
  // don't return rows that would be wasted page-fill. Status check
  // ('upcoming') is required — without it, a postponed/cancelled game
  // with all three IDs would still pass the filter.
  if (availableOnly) {
    q = q
      .not('sportspage_id', 'is', null)
      .not('rundown_id', 'is', null)
      .eq('status', 'upcoming')
      .or('contest_created.is.null,contest_created.eq.false');
  }

  q = q.range(offset, offset + limit - 1);

  const result = await q;
  if (result.error) {
    logger.error({ err: result.error.message }, 'games: query failed');
    res
      .status(500)
      .json({ error: 'Failed to fetch games.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const rows = (result.data ?? []) as unknown as GamesDbRow[];
  const total = result.count ?? 0;

  let teams: Map<string, TeamInfo>;
  try {
    teams = await resolveTeams(rows);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'games: teams query failed');
    res
      .status(500)
      .json({ error: 'Failed to resolve team names.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const games = rows.map((r) => dbRowToGameRow(r, teams));

  res.status(200).json({
    sport: sport ?? null,
    windowHours,
    availableOnly,
    games,
    pagination: { limit, offset, total, hasMore: offset + games.length < total },
  });
}

export async function getGameByIdHandler(req: Request, res: Response): Promise<void> {
  const gameId = req.params.gameId;
  if (gameId === undefined || gameId === '') {
    res.status(400).json({
      error: 'gameId is required.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const { network } = loadConfig();
  const sb = getSupabase();

  // (network, jsonodds_id) is the games table primary key — guaranteed
  // unique and immutable. We deliberately do NOT match against `slug`
  // here: slugs are mutable (writer renames them on doubleheader detect
  // / reschedule) and unsafe to use as a stable lookup key.
  const result = await sb
    .from('games')
    .select(GAMES_SELECT)
    .eq('network', network)
    .eq('jsonodds_id', gameId)
    .maybeSingle();

  if (result.error) {
    logger.error({ err: result.error.message, gameId }, 'games: get-by-id query failed');
    res
      .status(500)
      .json({ error: 'Failed to fetch game.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  if (result.data === null) {
    res.status(404).json({
      error: `Game not found: ${gameId}`,
      code: 'NOT_FOUND',
    } satisfies ApiError);
    return;
  }

  const row = result.data as unknown as GamesDbRow;

  let teams: Map<string, TeamInfo>;
  try {
    teams = await resolveTeams([row]);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'games: teams query failed');
    res
      .status(500)
      .json({ error: 'Failed to resolve team names.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  res.status(200).json(dbRowToGameRow(row, teams));
}
