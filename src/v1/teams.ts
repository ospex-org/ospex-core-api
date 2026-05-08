/**
 * GET /v1/teams/aliases — flat list of every team alias rows joined to
 * canonical team metadata.
 *
 * Closes the `resolveTeam` gap called out in this repo's README §"Schedule"
 * (the legacy resolver lived in deprecated `ospex-agent-server`). The
 * SDK's resolver layer needs alias data to map free-form user input
 * ("Lakers", "LAL", "Los Angeles Lakers") to a canonical team id when
 * the user is staking a commitment. Centralizing the read here lets the
 * writer be the single source of truth for aliases — operators add
 * aliases as `team_resolution_failures` get triaged and the change
 * propagates without a SDK release.
 *
 * Pagination caveat: PostgREST returns at most 1000 rows per query by
 * default. `team_aliases` is ~1300+ rows today, so the SDK paginates
 * until `hasMore: false`. The response sets `limit` to 2000 to avoid
 * gratuitous round-trips for the typical "fetch everything once and
 * cache" pattern; callers can pass an explicit `?limit=` if they want
 * smaller pages.
 *
 * Data shape note: `team_aliases` stores `sport_id` (smallint) but not
 * `sport` (text). This handler joins through `teams` to surface
 * `sport`, `teamName`, and `abbrev` so callers don't have to maintain
 * their own sport_id → sport mapping.
 *
 * No network filter: `team_aliases` and `teams` are sports-reference
 * tables shared across networks. The endpoint is network-agnostic.
 */

import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { SPORTS, isSport, type Sport } from '../lib/sports.js';
import type { ApiError } from '../middleware/errorHandler.js';

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

interface AliasRow {
  teamId: string;
  sport: Sport;
  sportId: number;
  teamName: string;
  abbrev: string;
  alias: string;
  aliasType: string;
  source: string;
}

interface AliasesResponseBody {
  aliases: AliasRow[];
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
}

interface AliasDbRow {
  team_id: string;
  alias: string;
  alias_type: string;
  source: string;
  team: {
    id: string;
    name: string;
    abbrev: string;
    sport: string;
    sport_id: number;
  } | null;
}

const ALIAS_SELECT =
  'team_id, alias, alias_type, source, team:teams!inner(id, name, abbrev, sport, sport_id)';

export async function getTeamAliasesHandler(req: Request, res: Response): Promise<void> {
  // ── Parse + validate query params ─────────────────────────────────────
  let sport: Sport | undefined;
  if (req.query.sport !== undefined) {
    const raw = String(req.query.sport).toLowerCase();
    if (!isSport(raw)) {
      res.status(400).json({
        error: `Invalid "sport". Must be one of: ${[...SPORTS].sort().join(', ')}.`,
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    sport = raw;
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

  // ── Query ─────────────────────────────────────────────────────────────
  const sb = getSupabase();
  let q = sb
    .from('team_aliases')
    .select(ALIAS_SELECT, { count: 'exact' })
    .order('team_id', { ascending: true })
    .order('alias', { ascending: true })
    .range(offset, offset + limit - 1);

  // sport_id on team_aliases is denormalized but `sport` (text) lives on
  // teams. Filter on the joined teams.sport for readability.
  if (sport !== undefined) q = q.eq('team.sport', sport);

  const result = await q;
  if (result.error) {
    logger.error({ err: result.error.message }, 'teams: aliases query failed');
    res.status(500).json({
      error: 'Failed to fetch team aliases.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }

  // PostgREST returns the joined `team` as either an object or null.
  // Coerce + drop rows where the join failed (shouldn't happen given the
  // !inner join, but be defensive — a stale alias whose team got deleted
  // would produce a null team).
  const rows = (result.data ?? []) as unknown as AliasDbRow[];
  const aliases: AliasRow[] = [];
  for (const r of rows) {
    if (!r.team) continue;
    aliases.push({
      teamId: r.team_id,
      sport: r.team.sport as Sport,
      sportId: r.team.sport_id,
      teamName: r.team.name,
      abbrev: r.team.abbrev,
      alias: r.alias,
      aliasType: r.alias_type,
      source: r.source,
    });
  }

  const total = result.count ?? aliases.length;
  const body: AliasesResponseBody = {
    aliases,
    pagination: { limit, offset, total, hasMore: offset + aliases.length < total },
  };
  res.status(200).json(body);
}
