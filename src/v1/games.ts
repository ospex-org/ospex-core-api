/**
 * GET /v1/games — upcoming games available for contest creation.
 * GET /v1/games/:gameId — single game by jsonodds_id.
 *
 * Reads `games` (writer-managed) instead of `current_schedules` because
 * `games` is the table the writer pipeline actually populates with the
 * three external IDs (jsonodds_id, sportspage_id, rundown_id) needed
 * by `CreOracleReceiver.createContestAndRequestVerify`. Team UUIDs are
 * joined to `teams` for readable home/away names.
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
 * `contest_created = false` AND `status = 'upcoming'`. The default
 * `availableOnly=true` applies the same predicate as a DB filter so the
 * list view matches the computed flag.
 *
 * CAVEAT — the `status` term is INERT as of this writing. The schema admits
 * `live | final | postponed | cancelled`, but a production sweep on
 * 2026-07-29 found all 1200 rows reading `'upcoming'`, including 212 with
 * final scores and 7 with `final_type = 'Postponed'`. No writer observed in
 * the swept repos updates the column. So the check excludes nothing today
 * and a postponed game still reports `canCreateContest: true`. The column
 * that actually carries the postponement signal is `games.final_type`
 * (`'Postponed'` / `'Finished'`), which this endpoint does not select.
 *
 * This is a snapshot, not a guarantee: populating `games.status` from the
 * upstream in-play signal is a proposed writer change. If that lands, this
 * term and the `availableOnly` DB filter below both become live and
 * `/v1/games` output changes — including values that external preflight
 * tooling compares by exact equality. Tightening the predicate onto
 * `final_type` is a deliberate follow-up, not part of this change, for the
 * same reason.
 *
 * `probablePitchers` is advisory supplemental context (MLB only): the
 * probable/announced starters as last reported by the upstream odds feed,
 * refreshed by the writer while the game is on the board. Both sides are
 * null when unannounced and for non-MLB sports. The value means "the last
 * starter the feed reported", not a guaranteed final starter — it never
 * affects contest creation, matching, or scoring.
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

interface ProbablePitchers {
  home: string | null;
  away: string | null;
}

interface GameRow {
  gameId: string;
  slug: string;
  sport: Sport;
  /**
   * The earliest start we currently hold for this game: a bounded minimum of
   * the raw feed value, the monotone floor, and the two provider snapshots
   * (each admitted only within one hour below the feed value — the same
   * freshness guard the `contests_effective` view applies). A conservative
   * safety bound, NOT an observation — compare the raw fields below to see
   * the value it came from. Matches the games-side derivation `/v1/contests*`
   * and `/v1/speculations` read from the view.
   */
  matchTime: string;
  /** The raw current feed value, unminimised. Diagnostic. */
  gameMatchTime: string;
  /**
   * The retained monotone floor, or null if the column is unset. Diagnostic:
   * when this is below `gameMatchTime`, it is what is driving `matchTime`.
   */
  earliestMatchTime: string | null;
  /**
   * Provider start-time snapshots (`games.rundown_match_time` /
   * `games.sportspage_match_time`), verbatim, or null when unset. Dated
   * observations, not live values (captured at id claim, re-observed after
   * absorbed feed moves, nulled on id release); they enter `matchTime` only
   * through the one-hour freshness guard, so a value far below
   * `gameMatchTime` is stale and deliberately NOT driving the minimum.
   */
  rundownMatchTime: string | null;
  sportspageMatchTime: string | null;
  status: string;
  homeTeam: TeamInfo;
  awayTeam: TeamInfo;
  hasOdds: boolean;
  contestCreated: boolean;
  contestId: string | null;
  canCreateContest: boolean;
  externalIds: ExternalIds;
  probablePitchers: ProbablePitchers;
}

interface GamesDbRow {
  network: string;
  jsonodds_id: string;
  sportspage_id: string | null;
  rundown_id: string | null;
  sport: string;
  match_time: string;
  earliest_match_time: string | null;
  rundown_match_time: string | null;
  sportspage_match_time: string | null;
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
  home_probable_pitcher: string | null;
  away_probable_pitcher: string | null;
}

interface TeamDbRow {
  id: string;
  name: string;
  abbrev: string;
}

const GAMES_SELECT =
  'network, jsonodds_id, sportspage_id, rundown_id, sport, match_time, earliest_match_time, rundown_match_time, sportspage_match_time, status, home_team_id, away_team_id, has_odds, contest_created, contest_id, slug, home_probable_pitcher, away_probable_pitcher';

/**
 * The earliest start this game is known to have carried, as a bound.
 *
 * `games.earliest_match_time` is a monotone floor maintained by a DB trigger
 * in the protocol indexer's schema: an ordinary write cannot raise it, so it retains an
 * earlier start the feed has since rolled back. `match_time` alone is the CURRENT
 * feed value and follows a rollback back up, which is why this endpoint used to
 * have no second input to minimise over — a pre-contest caller had exactly one
 * temporal field and could take no minimum at all.
 *
 * Be precise about what each input buys. The floor protects against a MOVE-UP
 * BEING ROLLED BACK by the same provider. The provider snapshots (persisted by
 * the protocol's off-chain writer at id claim, re-observed after absorbed feed
 * moves) are what protect against providers DISAGREEING at record time — the
 * pre-contest gap this endpoint used to state as separate, larger work. They
 * are dated observations, so each is admitted only while within ONE HOUR below
 * the live feed value — the same read-time freshness guard the
 * `contests_effective` view applies — and a stale snapshot is excluded rather
 * than allowed to wrong-close the bound.
 *
 * Exactly ONE value is retained per column, so none of this is a history: a
 * `matchTime` below the raw feed value means only that one of the retained
 * lower inputs — the floor, or a fresh provider snapshot — is currently the
 * minimum; the served raw field equal to `matchTime` identifies which. It does
 * not establish source, causality, or that any particular earlier start was
 * ever scheduled.
 *
 * Null-safe in both directions — the column is fully populated on production
 * today (0 nulls of 1227), but a null must degrade to `match_time` rather than
 * to `null`, which would erase the field for every affected row.
 *
 * Unparseable input degrades to `match_time`, which is the safe direction here:
 * this endpoint must still serve a start time, so a value it cannot read is
 * ignored rather than allowed to produce a bound.
 *
 * The comparison is on INSTANTS, not strings, and at MICROSECOND resolution.
 * Both columns are `timestamptz`, which Postgres stores and PostgREST renders
 * at microseconds; `Date.parse` truncates to milliseconds and maps
 * `…00.000000Z` and `…00.000001Z` onto the same number, so a floor a
 * microsecond below `match_time` would not be detected as the minimum. It is
 * also far too permissive for this to reject anything: `2026-02-30T00:00:00Z`
 * is silently normalised to March 2, and a timestamp with no zone designator is
 * read in the SERVER'S LOCAL time, which is a different instant per deployment.
 *
 * String comparison is wrong for a second reason: `2026-07-30T20:10:00-05:00`
 * sorts before `2026-07-31T00:15:00+00:00` lexicographically while being the
 * LATER instant, so it would serve a start an hour earlier than the real one.
 *
 * The parser is the same grammar the protocol's off-chain writer applies at
 * capture time, deliberately duplicated rather than shared: they are separate
 * deployables with no common package, and a copied 30-line grammar is cheaper
 * than a dependency between them.
 */
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

function parseTimestampMicros(iso: string): bigint | null {
  const m = RFC3339.exec(iso);
  if (m === null) return null;
  const [, yS, moS, dS, hS, miS, sS, fracS, zulu, sign, offHS, offMS] = m;
  const y = Number(yS);
  const mo = Number(moS);
  const d = Number(dS);
  const h = Number(hS);
  const mi = Number(miS);
  const s = Number(sS);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  // Beyond timestamptz resolution; truncating would move the value EARLIER.
  if (fracS !== undefined && fracS.length > 6) return null;
  const micros = fracS === undefined ? 0 : Number(fracS.padEnd(6, '0'));
  const baseMs = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!Number.isFinite(baseMs)) return null;
  // Date.UTC ROLLS OVER an impossible day (Feb 30 -> Mar 2); this rejects it.
  const rt = new Date(baseMs);
  if (rt.getUTCFullYear() !== y || rt.getUTCMonth() !== mo - 1 || rt.getUTCDate() !== d) {
    return null;
  }
  let total = BigInt(baseMs) * 1000n + BigInt(micros);
  if (zulu === undefined) {
    const offH = Number(offHS);
    const offM = Number(offMS);
    if (offH > 23 || offM > 59) return null;
    const offsetMicros = BigInt((offH * 60 + offM) * 60_000_000);
    // Fields are wall-clock at that offset; the instant is fields - offset.
    total += sign === '-' ? offsetMicros : -offsetMicros;
  }
  return total;
}

/** One hour in microseconds — the snapshot freshness window. Must match the
 *  `interval '1 hour'` guard in the `contests_effective` view: two
 *  implementations of one rule, deliberately (this endpoint reads the games
 *  TABLE, not the view), so a drift here silently forks the served bound. */
const SNAPSHOT_FRESHNESS_MICROS = 3_600_000_000n;

function effectiveMatchTime(
  matchTime: string,
  earliest: string | null,
  rundown: string | null,
  sportspage: string | null,
): string {
  const m = parseTimestampMicros(matchTime);
  if (m === null) return matchTime;
  let best = m;
  let bestIso = matchTime;
  const consider = (iso: string | null, freshnessGuarded: boolean): void => {
    if (iso === null) return;
    const v = parseTimestampMicros(iso);
    if (v === null) return; // unparseable degrades to the other inputs
    if (freshnessGuarded && v < m - SNAPSHOT_FRESHNESS_MICROS) return; // stale — excluded
    if (v < best) {
      best = v;
      bestIso = iso;
    }
  };
  consider(earliest, false);
  consider(rundown, true);
  consider(sportspage, true);
  return bestIso;
}

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

/**
 * All three external IDs present AND not already created AND `status ===
 * 'upcoming'`. The status term is inert against production data as of this
 * writing — see the file header for why, and why fixing it is a separate
 * change.
 */
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
    matchTime: effectiveMatchTime(
      row.match_time,
      row.earliest_match_time,
      row.rundown_match_time,
      row.sportspage_match_time,
    ),
    gameMatchTime: row.match_time,
    earliestMatchTime: row.earliest_match_time,
    rundownMatchTime: row.rundown_match_time,
    sportspageMatchTime: row.sportspage_match_time,
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
    probablePitchers: {
      home: row.home_probable_pitcher ?? null,
      away: row.away_probable_pitcher ?? null,
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

  // KNOWN LIMITATION, stated rather than hidden: the window and the ordering key
  // on the RAW `match_time`, while the response serves the bounded MINIMUM over
  // that, the monotone floor, and the freshness-guarded provider snapshots. The
  // window key and the served value can disagree.
  //
  // Why it is not fixed here: PostgREST cannot express a `LEAST(...)` filter or
  // sort. `/v1/contests*` avoids this only because `contests_effective` is a
  // VIEW that materialises the minimum as a real column, so its window and sort
  // key on the same value they serve. `games` has no such view.
  //
  // Consequences, small and real. A game whose minimum-driving input (a floor
  // below the feed value, or a FRESH provider snapshot below it) is earlier
  // than `start` can be returned carrying a `matchTime` before the requested
  // window; one whose lower input falls inside the window while `match_time`
  // is past `end` is NOT returned. Divergence needs some input strictly below
  // `match_time`: floor-below-feed rows are rare by construction (1 of 1227 as
  // of 2026-07-31 — an ordinary write cannot raise the floor, so the two are
  // equal until a move-up is rolled back), and a snapshot can now diverge by
  // up to its one-hour window whenever a provider quotes an earlier start than
  // the odds feed — the sub-hour disagreement class this endpoint exists to
  // surface, so expect it at a low steady rate rather than never.
  //
  // Closing it properly means a `games_effective` view mirroring
  // `contests_effective`, which is an indexer migration and is deliberately out
  // of scope here.
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
  // don't return rows that would be wasted page-fill. The `status`
  // ('upcoming') term mirrors computeCanCreateContest so the filter and the
  // flag agree — but as of this writing no production row carries a
  // non-'upcoming' status (see the file header), so it excludes nothing today
  // and a postponed game is still returned.
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
