/**
 * Canonical list of sports the protocol indexes / writes / supports.
 *
 * Single source of truth for the `sport` query param across handlers
 * (`/v1/games`, `/v1/contests`, `/v1/speculations`, `/v1/teams/aliases`).
 * Previously `contests.ts` and `speculations.ts` carried a 5-sport
 * allowlist that omitted `ncaaf`; this module replaces those local
 * `VALID_SPORTS` sets so adding a new sport requires editing exactly
 * one file.
 *
 * The list mirrors the seeds in `ospex-indexer/scripts/seeds/seed-{mlb,
 * nfl,ncaaf}-teams.ts` plus the pre-existing nba / ncaab / nhl seeds.
 */

export type Sport = 'mlb' | 'nba' | 'ncaab' | 'ncaaf' | 'nfl' | 'nhl';

export const SPORTS: ReadonlySet<Sport> = new Set<Sport>([
  'mlb',
  'nba',
  'ncaab',
  'ncaaf',
  'nfl',
  'nhl',
]);

export function isSport(value: string): value is Sport {
  return SPORTS.has(value as Sport);
}
