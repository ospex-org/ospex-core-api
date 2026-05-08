/**
 * Resolve `(awayTeamId, homeTeamId)` for a contest by joining through
 * the writer-managed `games` table.
 *
 * `contests` rows do NOT store team UUIDs — the indexer captures the
 * team-name strings (`away_team`, `home_team`) at CONTEST_CREATED time
 * but not the canonical team_id. The linkage is reconstructed via
 *   contests.network + contests.jsonodds_id → games.{home_team_id, away_team_id}
 *
 * This helper is consumed by the contest/speculation detail endpoints
 * to widen their response with team UUIDs, which the SDK's resolver
 * layer uses to scope team_alias matching to the contest's two teams.
 *
 * Returns `{ awayTeamId: null, homeTeamId: null }` when:
 *   - `jsonoddsId` is null on the contest row, or
 *   - the matching `games` row is missing, or
 *   - the games-side query errors (degrades gracefully — team ids are
 *     an enrichment, not load-bearing for the parent endpoint).
 *
 * The SDK falls back to exact + nickname matching when both ids are
 * null; abbrev/alias matching is only used when both ids resolve.
 */

import type { Network } from './env.js';
import { logger } from './logger.js';
import { getSupabase } from './supabase.js';

export interface TeamIds {
  awayTeamId: string | null;
  homeTeamId: string | null;
}

const NULL_IDS: TeamIds = { awayTeamId: null, homeTeamId: null };

export async function resolveTeamIdsForContest(
  network: Network,
  jsonoddsId: string | null,
): Promise<TeamIds> {
  if (jsonoddsId === null || jsonoddsId === '') return NULL_IDS;

  const sb = getSupabase();
  const result = await sb
    .from('games')
    .select('away_team_id, home_team_id')
    .eq('network', network)
    .eq('jsonodds_id', jsonoddsId)
    .maybeSingle();

  if (result.error) {
    logger.warn(
      { err: result.error.message, jsonoddsId, network },
      'team_id resolve failed; degrading to nulls',
    );
    return NULL_IDS;
  }
  if (!result.data) return NULL_IDS;
  const row = result.data as { away_team_id: string | null; home_team_id: string | null };
  return {
    awayTeamId: row.away_team_id ?? null,
    homeTeamId: row.home_team_id ?? null,
  };
}
