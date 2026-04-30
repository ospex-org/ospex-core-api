/**
 * GET /v1/schedule?sport= — upcoming games from `current_schedules`.
 *
 * Returns the next `windowHours` (default 36) of games for the
 * requested sport, paginated. Team UUIDs are resolved to names via
 * the `teams` table.
 *
 * The agent-server's version did a best-effort merge with on-chain
 * `contests` rows — flagging which games already have a contest. That
 * merge depended on the `resolveTeam` alias resolver in
 * `db/supabase/queries.ts` to bridge name differences between feeds.
 * The resolver isn't ported in this batch; consumers can cross-check
 * against `GET /v1/markets`. Adding the merge with proper alias
 * resolution is a follow-up.
 */

import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import type { ApiError } from '../middleware/errorHandler.js';

type Sport = 'nba' | 'nhl' | 'ncaab' | 'mlb';
const VALID_SPORTS = new Set<Sport>(['nba', 'nhl', 'ncaab', 'mlb']);

const DEFAULT_WINDOW_HOURS = 36;
const MAX_WINDOW_HOURS = 168;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

interface TeamInfo {
  name: string;
  abbreviation: string;
}

interface ScheduleGame {
  gameId: string;
  sport: Sport;
  gameDate: string;
  status: string;
  statusDetail: string | null;
  homeTeam: TeamInfo;
  awayTeam: TeamInfo;
  homeScore: number | null;
  awayScore: number | null;
  broadcast: string | null;
  venue: string | null;
}

interface ScheduleRow {
  game_id: string;
  sport: string;
  game_date: string;
  status: string;
  status_detail: string | null;
  home_team_id: string;
  away_team_id: string;
  home_score: number | null;
  away_score: number | null;
  broadcast: string | null;
  venue_name: string | null;
}

interface TeamRow {
  id: string;
  name: string;
  abbrev: string;
}

export async function getScheduleHandler(req: Request, res: Response): Promise<void> {
  const sportRaw = req.query.sport ? String(req.query.sport).toLowerCase() : '';
  if (!VALID_SPORTS.has(sportRaw as Sport)) {
    res.status(400).json({
      error: `Missing or invalid "sport" query parameter. Must be one of: ${[...VALID_SPORTS].join(', ')}.`,
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const sport = sportRaw as Sport;

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

  const sb = getSupabase();
  const start = new Date().toISOString();
  const end = new Date(Date.now() + windowHours * 3600_000).toISOString();

  const sched = await sb
    .from('current_schedules')
    .select(
      'game_id, sport, game_date, status, status_detail, home_team_id, away_team_id, home_score, away_score, broadcast, venue_name',
      { count: 'exact' },
    )
    .eq('sport', sport)
    .gte('game_date', start)
    .lte('game_date', end)
    .order('game_date', { ascending: true })
    .range(offset, offset + limit - 1);

  if (sched.error) {
    logger.error({ err: sched.error.message }, 'schedule: query failed');
    res.status(500).json({ error: 'Failed to fetch schedule.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  const rows = (sched.data ?? []) as unknown as ScheduleRow[];
  const total = sched.count ?? 0;

  // Batch-resolve team UUIDs → { name, abbreviation }.
  const teamIds = new Set<string>();
  for (const r of rows) {
    teamIds.add(r.home_team_id);
    teamIds.add(r.away_team_id);
  }

  const teamLookup = new Map<string, TeamInfo>();
  if (teamIds.size > 0) {
    const teamsRes = await sb.from('teams').select('id, name, abbrev').in('id', [...teamIds]);
    if (teamsRes.error) {
      logger.error({ err: teamsRes.error.message }, 'schedule: teams query failed');
      res.status(500).json({ error: 'Failed to resolve team names.', code: 'INTERNAL_ERROR' } satisfies ApiError);
      return;
    }
    for (const t of (teamsRes.data ?? []) as unknown as TeamRow[]) {
      teamLookup.set(t.id, { name: t.name, abbreviation: t.abbrev });
    }
  }

  const fallback: TeamInfo = { name: 'Unknown', abbreviation: '???' };

  const games: ScheduleGame[] = rows.map((r) => ({
    gameId: r.game_id,
    sport,
    gameDate: r.game_date,
    status: r.status,
    statusDetail: r.status_detail,
    homeTeam: teamLookup.get(r.home_team_id) ?? fallback,
    awayTeam: teamLookup.get(r.away_team_id) ?? fallback,
    homeScore: r.home_score,
    awayScore: r.away_score,
    broadcast: r.broadcast,
    venue: r.venue_name,
  }));

  res.status(200).json({
    sport,
    windowHours,
    games,
    pagination: { limit, offset, total, hasMore: offset + games.length < total },
  });
}
