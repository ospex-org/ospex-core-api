/**
 * /v1/contests/* — contest read endpoints.
 *
 *   GET /v1/contests                        — list upcoming contests with their speculations
 *   GET /v1/contests?date=YYYY-MM-DD        — dated discovery: one UTC day, past or future
 *   GET /v1/contests/:contestId             — single contest detail with populated orderbooks
 *
 * The list endpoint stays lean (no orderbook population — heavy and not
 * currently needed). The detail endpoint groups commitments by
 * `speculation_key` and applies the same default open-book filter set
 * as `GET /v1/commitments` (status open or partially_filled, not
 * invalidated, not expired).
 *
 * ## Dated discovery (`?date=`)
 *
 * `date=YYYY-MM-DD` (a UTC calendar day) replaces the forward-only hours
 * window with `[date 00:00Z, date+1 00:00Z)` on the same
 * `effective_start_time` the listing orders on and serves as `matchTime` —
 * so an agent can enumerate a past day's contests for the settle-and-claim
 * half of its lifecycle. `date` and `window` are mutually exclusive (400 on
 * both). The accepted domain is `0100-01-01` through `9999-12-30`: years
 * below 0100 are real calendar dates but are refused (JS `Date.UTC` remaps
 * years 0–99 into 1900–1999, and the round-trip guard rejects the remap
 * rather than silently shifting the century), and `9999-12-31` is refused
 * because its +1-day upper bound leaves the 4-digit ISO year domain (see
 * parseUtcDay). Nothing this endpoint serves sits outside that domain.
 * Dated ordering adds a unique `contest_id` tiebreaker after
 * `effective_start_time`: the mode enumerates a whole day, and offset
 * pagination over tied start instants would otherwise be able to skip or
 * repeat a row between pages. The forward listing keeps its single-key
 * ordering. Eligibility (unverified contests stay excluded), the `sport` /
 * `status` filters, the limit caps, and signer-free reads are all the
 * default listing's.
 *
 * Dated rows additionally carry `gameFinalType` — the linked game's
 * `games.final_type`, VERBATIM. The `contests_effective` view deliberately
 * projects no games finality column, so dated mode reads `games` directly
 * over the same `(network, jsonodds_id)` join the view uses. The default
 * (no-`date`) response is unchanged and does not carry the field; the
 * contest's own scored state is already served as `status`
 * (`scored` / `scored_manually`).
 *
 * ## Game identity on list rows
 *
 * Every list row — BOTH the default forward window and `?date=` — carries
 * the linked game's canonical identity as two deliberately redundant keys:
 *
 *   - `gameId`     — the contest's JSONOdds linkage
 *                    (`contests.jsonodds_id`), under the name the games
 *                    surface uses: `/v1/games` serves the SAME string as
 *                    its `gameId`. The games table has no surrogate UUID —
 *                    `(network, jsonodds_id)` is its primary key — so this
 *                    IS the canonical game identity, and it gives
 *                    consumers an exact-equality join key between contest
 *                    rows and the games surface. Teams + start-time
 *                    matching demotes to defense-in-depth.
 *   - `jsonoddsId` — the same value under the contest-detail naming
 *                    convention (the detail endpoint has always served
 *                    it). Mirrors the intentional `gameId` /
 *                    `externalIds.jsonodds` redundancy documented in
 *                    `games.ts`.
 *
 * Both keys are always present and serve `null` when the contest was
 * created without a JSONOdds linkage. The value is the contest row's OWN
 * binding, chosen at creation — deliberately not gated on a `games` row
 * existing, so identity stays servable even when the games mirror row is
 * absent (dated `gameFinalType` is then `''`). Detail, `?since=`
 * recovery, and the SSE stream are unchanged by this addition (the detail
 * body already carries `jsonoddsId`; extending identity to the
 * recovery/stream bodies is a separate decision).
 *
 * `/v1/contests` was previously mounted at `/v1/markets`. The handlers
 * keep using `scorerToType(scorer, scorers)` for the scorer→market_type
 * mapping (back-compat — preserves the exact wire output the prior
 * `/v1/markets` endpoint produced). New code should prefer reading
 * `speculations.market_type` directly — see `/v1/speculations*`.
 *
 * ## Start-time fields
 *
 * Contest-shaped bodies carry SIX time fields, all read from the
 * `contests_effective` view (never computed here — see below):
 *
 *   - `matchTime`      — the CURRENT CONSERVATIVE SAFETY BOUND: a bounded
 *                        minimum over `chainStartTime`, `gameMatchTime`, the
 *                        game's current retained safety floor (served below
 *                        as `gameEarliestMatchTime`), and — only while within
 *                        ONE HOUR below `gameMatchTime` — the two provider
 *                        start-time snapshots (served below as
 *                        `gameRundownMatchTime` / `gameSportspageMatchTime`).
 *                        A conservative safety bound, NOT a prediction of
 *                        first pitch. Gate on this. `matchTime` can sit
 *                        strictly BELOW both raw published SCHEDULE fields
 *                        (`chainStartTime` and `gameMatchTime`) — correct,
 *                        not a bug — but it always EQUALS at least one served
 *                        input: the floor or an eligible snapshot is then the
 *                        driver, identifiable from the body. It proves
 *                        nothing about when, why, or from which source the
 *                        schedule moved.
 *   - `chainStartTime` — the raw `contests.start_time` written on-chain at
 *                        verification.
 *   - `gameMatchTime`  — the raw odds-feed schedule (`games.match_time`),
 *                        which tracks reschedules.
 *   - `gameEarliestMatchTime` — the game's current retained safety floor
 *                        (`games.earliest_match_time`), served VERBATIM —
 *                        never clamped. `floor <= gameMatchTime` is NOT an
 *                        invariant: a floor-only operator remedy can raise
 *                        the floor above the current schedule, in which case
 *                        `matchTime` keeps tracking the lower inputs.
 *   - `gameRundownMatchTime` / `gameSportspageMatchTime` — the enrichment
 *                        providers' start-time SNAPSHOTS
 *                        (`games.rundown_match_time` /
 *                        `games.sportspage_match_time`), served VERBATIM.
 *                        Dated observations, not live values: captured when
 *                        the provider id was claimed, re-observed after
 *                        absorbed feed moves, nulled on id release. They
 *                        enter `matchTime` only through the view's one-hour
 *                        read-time freshness guard, so a served snapshot can
 *                        sit far below `matchTime` (stale — excluded from the
 *                        min) or within an hour of it (a candidate input).
 *
 * ### The ordering guarantee, and its one exception
 *
 * `matchTime <= chainStartTime` holds WHENEVER `chainStartTime` is non-empty
 * — off-chain gating is then never more permissive than the protocol's
 * immutable on-chain gates.
 *
 * It does NOT hold unconditionally. `contests.start_time` is NULL between
 * `CONTEST_CREATED` and `CONTEST_VERIFIED` — a window every contest passes
 * through — so an unverified contest with a linked games row serves
 * `chainStartTime: ""` alongside a non-empty `matchTime`. A comparison that
 * does not first check `chainStartTime !== ''` is false for exactly that
 * window. The list endpoint excludes those rows; the detail, recovery, and
 * stream surfaces do not. Any consumer gate must read:
 *
 *     chainStartTime === '' || matchTime <= chainStartTime
 *
 * For the same reason `chainStartTime` is not immutable-from-first-sight: it
 * transitions once, from `""` to its on-chain value, when the contest is
 * verified. After that the protocol never rewrites it.
 *
 * The recorded start time is a PREDICTION, not ground truth. `min(...)` is
 * a SAFETY rule, not a truth-recovery rule — it does not "serve the correct
 * time"; it serves the bounded minimum of the current retained inputs.
 *
 * The minimum is computed in Postgres by the `contests_effective` view — a
 * bounded LEAST over `c.start_time`, `g.match_time`, `g.earliest_match_time`,
 * and the two provider snapshots each behind a
 * `CASE WHEN snapshot >= g.match_time - interval '1 hour'` freshness guard —
 * over a `(network, jsonodds_id)`
 * join — never over the `games.contest_id` back-pointer, which is not unique
 * per contest). It is deliberately NOT computed in JS: doing it in the DB
 * keeps `contestRecoveryRowToBody` synchronous (`StreamResource.toBody` is a
 * sync interface called from the SSE poller), lets the list endpoint filter
 * and order on the value at the DB layer, and avoids a `Date.parse`
 * comparison that would truncate `timestamptz` microseconds.
 *
 * The view is owned by the protocol indexer's schema; this service only reads
 * it, and every contest-shaped read here goes through it. It must exist before
 * this service is deployed — otherwise every contest query fails at the DB
 * layer.
 *
 * NOTE: `/v1/contests.matchTime` and `/v1/games.matchTime` are BOTH derived
 * conservative bounds, computed over DIFFERENT input sets: the contest
 * surfaces minimise over the chain start as well, while `/v1/games` (whose
 * rows precede any contest) has no chain input. They are still not
 * equality-comparable across endpoints. Compare raw with raw: `gameMatchTime`
 * here against `/v1/games.gameMatchTime`, and `gameEarliestMatchTime` here
 * against `/v1/games.earliestMatchTime` — the same underlying columns; note
 * the null encodings differ (`""` here, `null` on `/v1/games`).
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { CONTESTS_VIEW } from '../lib/tables.js';
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
  /** Current conservative start-time safety bound — the bounded min over chain start, feed schedule,
   *  the game's retained safety floor (served below as `gameEarliestMatchTime`), and the two provider
   *  snapshots behind their one-hour freshness guard (served below as `gameRundownMatchTime` /
   *  `gameSportspageMatchTime`). See the file header. */
  matchTime: string;
  /** Raw on-chain start (`contests.start_time`). `""` until the contest is verified. */
  chainStartTime: string;
  /** Raw odds-feed schedule (`games.match_time`), joined on `(network, jsonodds_id)`. */
  gameMatchTime: string;
  /** The game's current retained safety floor (`games.earliest_match_time`), verbatim — never
   *  clamped. `""` when no games row is linked. When it is the minimum of the inputs, it
   *  is what is driving `matchTime`. See the file header. */
  gameEarliestMatchTime: string;
  /** Provider start-time snapshots (`games.rundown_match_time` /
   *  `games.sportspage_match_time`), verbatim. Dated observations — they enter
   *  `matchTime` only through the view's one-hour freshness guard. `""` when
   *  no games row is linked or no snapshot has been captured. */
  gameRundownMatchTime: string;
  gameSportspageMatchTime: string;
  status: string;
}

interface ContestListItem extends ContestBody {
  /** Canonical identity of the linked game, served on BOTH list modes: the
   *  contest's JSONOdds linkage (`contests.jsonodds_id`), the same string
   *  `/v1/games` serves as its `gameId` — the games table has no surrogate
   *  UUID; `(network, jsonodds_id)` is its primary key. `null` when the
   *  contest was created without a linkage; the key is always present.
   *  Deliberately NOT gated on a `games` row existing — this is the
   *  contest row's own binding. See the file header. */
  gameId: string | null;
  /** The same value under the contest-detail naming convention —
   *  deliberately redundant with `gameId`, mirroring the documented
   *  `gameId` / `externalIds.jsonodds` pair on `/v1/games`. */
  jsonoddsId: string | null;
  /** The linked game's upstream result status (`games.final_type`), served
   *  VERBATIM — free upstream text, e.g. `'Finished'`, `'Postponed'`,
   *  `'Canceled'` (upstream spelling). `''` when no games row is linked or
   *  the feed has reported no result status. Present in dated (`?date=`)
   *  mode ONLY — the default forward-window listing is unchanged and does
   *  not carry the key. */
  gameFinalType?: string;
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
   * created without a JSONOdds linkage. Also served on every list row
   * (beside its `gameId` twin) — see the file header's game identity
   * section.
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

/** Explicit row shape for the list query (see the cast in getContestsHandler). */
interface ContestListRow {
  contest_id: string | number;
  /** The contest's JSONOdds linkage, selected in BOTH list modes: served on
   *  every list row as `gameId` / `jsonoddsId` (see the file header's game
   *  identity section), and additionally consumed server-side in dated mode
   *  as the `(network, jsonodds_id)` games finality join key. */
  jsonodds_id: string | null;
  away_team: string | null;
  home_team: string | null;
  sport_slug: string | null;
  jsonodds_sport_id: number | null;
  start_time: string | null;
  /** The bounded min from `contests_effective`: `LEAST` over `start_time`,
   *  `game_match_time`, `game_earliest_match_time`, and the two provider
   *  snapshots (each admitted only within one hour below `game_match_time`). */
  effective_start_time: string | null;
  /** Joined `games.match_time` from `contests_effective`. */
  game_match_time: string | null;
  /** Joined `games.earliest_match_time` (the current retained safety floor)
   *  from `contests_effective`. */
  game_earliest_match_time: string | null;
  /** Joined provider start-time snapshots (`games.rundown_match_time` /
   *  `games.sportspage_match_time`) from `contests_effective`. */
  game_rundown_match_time: string | null;
  game_sportspage_match_time: string | null;
  contest_status: string | null;
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
  /** The bounded min from `contests_effective`: `LEAST` over `start_time`,
   *  `game_match_time`, `game_earliest_match_time`, and the two provider
   *  snapshots (each admitted only within one hour below `game_match_time`). */
  effective_start_time: string | null;
  /** Joined `games.match_time` from `contests_effective`. */
  game_match_time: string | null;
  /** Joined `games.earliest_match_time` (the current retained safety floor)
   *  from `contests_effective`. */
  game_earliest_match_time: string | null;
  /** Joined provider start-time snapshots (`games.rundown_match_time` /
   *  `games.sportspage_match_time`) from `contests_effective`. */
  game_rundown_match_time: string | null;
  game_sportspage_match_time: string | null;
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
  /** The bounded min from `contests_effective`: `LEAST` over `start_time`,
   *  `game_match_time`, `game_earliest_match_time`, and the two provider
   *  snapshots (each admitted only within one hour below `game_match_time`). */
  effective_start_time: string | null;
  /** Joined `games.match_time` from `contests_effective`. */
  game_match_time: string | null;
  /** Joined `games.earliest_match_time` (the current retained safety floor)
   *  from `contests_effective`. */
  game_earliest_match_time: string | null;
  /** Joined provider start-time snapshots (`games.rundown_match_time` /
   *  `games.sportspage_match_time`) from `contests_effective`. */
  game_rundown_match_time: string | null;
  game_sportspage_match_time: string | null;
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
  /** Current conservative start-time safety bound — the bounded min over chain start, feed schedule,
   *  the game's retained safety floor (served below as `gameEarliestMatchTime`), and the two provider
   *  snapshots behind their one-hour freshness guard (served below as `gameRundownMatchTime` /
   *  `gameSportspageMatchTime`). See the file header. */
  matchTime: string;
  /** Raw on-chain start (`contests.start_time`). `""` until the contest is verified. */
  chainStartTime: string;
  /** Raw odds-feed schedule (`games.match_time`), joined on `(network, jsonodds_id)`. */
  gameMatchTime: string;
  /** The game's current retained safety floor (`games.earliest_match_time`), verbatim — never
   *  clamped. `""` when no games row is linked. When it is the minimum of the inputs, it
   *  is what is driving `matchTime`. See the file header. */
  gameEarliestMatchTime: string;
  /** Provider start-time snapshots (`games.rundown_match_time` /
   *  `games.sportspage_match_time`), verbatim. Dated observations — they enter
   *  `matchTime` only through the view's one-hour freshness guard. `""` when
   *  no games row is linked or no snapshot has been captured. */
  gameRundownMatchTime: string;
  gameSportspageMatchTime: string;
  status: string;
  awayScore: number | null;
  homeScore: number | null;
  verifiedAt: string | null;
  scoredAt: string | null;
  voidedAt: string | null;
  contestCreatedAt: string | null;
}

// ── column lists ────────────────────────────────────────────────────────
//
// PostgREST projects to exactly the columns named here — an omitted column
// arrives as `undefined`, which the mappers below turn into the `''` sentinel
// rather than an error. Dropping `effective_start_time` would therefore serve
// `matchTime: ""` silently, and a consumer that parses that gets NaN. Every
// contest-shaped list is named so the query shape is assertable in tests; keep
// all six time columns in each.

/** `GET /v1/contests` (list) — one shared column set for BOTH the forward
 *  window and `?date=` dated discovery. `jsonodds_id` is served on every
 *  list row (`gameId` / `jsonoddsId` — the game identity keys) and doubles
 *  as the `(network, jsonodds_id)` join key for the dated-mode games
 *  finality read that supplies `gameFinalType`. */
const CONTEST_LIST_COLUMNS =
  'contest_id, jsonodds_id, away_team, home_team, sport_slug, jsonodds_sport_id, start_time, ' +
  'effective_start_time, game_match_time, game_earliest_match_time, ' +
  'game_rundown_match_time, game_sportspage_match_time, contest_status';

/** `GET /v1/contests/:contestId` (detail). */
const CONTEST_DETAIL_COLUMNS =
  'contest_id, jsonodds_id, rundown_id, sportspage_id, contest_creator, league_id, ' +
  'verify_source_hash, market_update_source_hash, score_contest_source_hash, ' +
  'away_team, home_team, sport_slug, jsonodds_sport_id, start_time, ' +
  'effective_start_time, game_match_time, game_earliest_match_time, ' +
  'game_rundown_match_time, game_sportspage_match_time, contest_status, ' +
  'away_score, home_score, contest_created_at, verified_at, scored_at, voided_at';

/** `GET /v1/contests?since=` (recovery) AND `GET /v1/stream/contests`. */
export const CONTEST_RECOVERY_COLUMNS =
  'contest_id, away_team, home_team, sport_slug, jsonodds_sport_id, start_time, ' +
  'effective_start_time, game_match_time, game_earliest_match_time, ' +
  'game_rundown_match_time, game_sportspage_match_time, ' +
  'contest_status, away_score, home_score, verified_at, scored_at, voided_at, ' +
  'contest_created_at, id, row_updated_at';

export function contestRecoveryRowToBody(c: ContestRecoveryRow): ContestRecoveryBody {
  return {
    contestId: String(c.contest_id),
    awayTeam: c.away_team ?? '',
    homeTeam: c.home_team ?? '',
    sport: c.sport_slug ?? '',
    sportId: c.jsonodds_sport_id ?? 0,
    // The min arrives pre-computed from the view — this mapper stays sync
    // (it is `StreamResource.toBody` for the contests SSE resource) and never
    // parses a timestamp.
    matchTime: c.effective_start_time ?? '',
    chainStartTime: c.start_time ?? '',
    gameMatchTime: c.game_match_time ?? '',
    gameEarliestMatchTime: c.game_earliest_match_time ?? '',
    gameRundownMatchTime: c.game_rundown_match_time ?? '',
    gameSportspageMatchTime: c.game_sportspage_match_time ?? '',
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

  let q = sb.from(CONTESTS_VIEW).select(CONTEST_RECOVERY_COLUMNS).eq('network', config.network);
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

/**
 * `YYYY-MM-DD` → the UTC day window `[date 00:00Z, date+1 00:00Z)`, or null
 * for anything outside the ACCEPTED DOMAIN: real calendar dates from
 * `0100-01-01` through `9999-12-30`. Same round-trip idiom as `games.ts`'s
 * `parseTimestampMicros`: `Date.UTC` ROLLS OVER an impossible day
 * (Feb 30 → Mar 2), so the components are compared back after the
 * conversion and a rolled-over value is rejected. The same comparison also
 * refuses years 0001–0099 — real dates, but `Date.UTC` remaps years 0–99
 * into 1900–1999, and refusing the remap beats silently shifting the
 * century; deliberate, since nothing this endpoint serves predates 0100.
 * The upper edge is the clamp below.
 */
function parseUtcDay(raw: string): { gte: string; lt: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  if (!Number.isFinite(ms)) return null;
  const rt = new Date(ms);
  if (rt.getUTCFullYear() !== y || rt.getUTCMonth() !== mo - 1 || rt.getUTCDate() !== d) return null;
  const end = ms + 86_400_000;
  // Both bounds must serialize inside the plain 4-digit ISO year domain:
  // year 10000 serializes as the expanded form `+010000-…`, which Postgres
  // rejects (SQLSTATE 22009, measured) — so date=9999-12-31, the one
  // accepted input whose +1-day bound crosses over, is refused here as a
  // 400 rather than surfacing as a 500 from the DB layer.
  if (end > Date.UTC(9999, 11, 31)) return null;
  return { gte: new Date(ms).toISOString(), lt: new Date(end).toISOString() };
}

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

  // Dated discovery: a UTC calendar day replaces the forward-only hours
  // window (see the file header). Mutually exclusive with `window` — the
  // two describe incompatible windows, so a request naming both is a
  // caller bug and fails loudly rather than picking one.
  let datedDay: { gte: string; lt: string } | null = null;
  if (req.query.date !== undefined) {
    if (req.query.window !== undefined) {
      res.status(400).json({
        error: 'date and window are mutually exclusive. Pass exactly one.',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
    datedDay = parseUtcDay(String(req.query.date));
    if (datedDay === null) {
      res.status(400).json({
        error: 'date must be a real calendar date in YYYY-MM-DD form (a UTC day).',
        code: 'INVALID_PARAM',
      } satisfies ApiError);
      return;
    }
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

  // The window filter + ordering run on `effective_start_time`, the same value
  // served as `matchTime`, so the endpoint never returns a row whose served
  // start falls outside its own window. Consequence for a moved-up contest: it
  // drops out of the listing at the EARLIER time and a run-loop consumer
  // untracks it, rather than keeping it listed until the frozen chain time.
  //
  // `.not('start_time', 'is', null)` preserves a pre-existing behaviour that
  // would otherwise silently change: `.gte('start_time', now)` excluded rows
  // with a NULL `start_time` (an unverified contest), and
  // `effective_start_time` is non-null whenever a games row exists — so
  // without this, unverified contests would newly appear in the list.
  // Dated mode keeps the same eligibility rule for the same reason — the day
  // window is a different bound, not a different listing.
  //
  // The dated window is HALF-OPEN — `.lt`, not `.lte` — so a start at exactly
  // `date+1 00:00:00Z` belongs to the next day and each contest lands in
  // exactly one day. The bound comparison happens in Postgres at full
  // `timestamptz` precision; nothing here parses a served timestamp.
  let q = sb
    .from(CONTESTS_VIEW)
    .select(CONTEST_LIST_COLUMNS, { count: 'exact' })
    .eq('network', config.network)
    .not('start_time', 'is', null);
  q =
    datedDay === null
      ? q.gte('effective_start_time', now).lte('effective_start_time', upper)
      : q.gte('effective_start_time', datedDay.gte).lt('effective_start_time', datedDay.lt);
  q = q.order('effective_start_time', { ascending: true });
  // Dated mode exists to enumerate a whole day COMPLETELY, and slates
  // cluster on shared start instants — so ties are routine and an
  // order-by without a unique key makes offset pagination able to skip or
  // repeat a tied row between pages. `contest_id` is unique within the
  // `.eq('network', …)` scope. The forward listing shares the tie hazard
  // but is left untouched here to keep the no-date path unchanged;
  // aligning it is a follow-up decision.
  if (datedDay !== null) q = q.order('contest_id', { ascending: true });
  q = q.range(offset, offset + limit - 1);

  if (sportFilter) q = q.eq('sport_slug', sportFilter);
  if (statusFilter) q = q.eq('contest_status', statusFilter);

  const contestsRes = await q;
  if (contestsRes.error) {
    logger.error({ err: contestsRes.error.message }, 'contests: list query failed');
    res.status(500).json({ error: 'Failed to list contests.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    return;
  }

  // Supabase's select-string inference gives up at this column count and
  // falls back to `GenericStringError`, so narrow with an explicit row shape
  // at the consumer — same pattern as `ContestDetailRow` below.
  const contests = (contestsRes.data ?? []) as unknown as ContestListRow[];
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

  // Dated mode: attach the linked game's finality. `contests_effective`
  // deliberately projects no games finality column, so this reads `games`
  // directly over the SAME `(network, jsonodds_id)` join the view uses —
  // NEVER `games.contest_id`, which still carries R4-epoch ids that resolve
  // to the wrong game. Finality is the point of a dated query, so a failed
  // read is a 500 like the other list queries — not a silent `''` degrade
  // that postgame tooling would misread as "not final".
  let finalTypeByJsonoddsId: Map<string, string> | null = null;
  if (datedDay !== null) {
    finalTypeByJsonoddsId = new Map();
    const jsonoddsIds = [
      ...new Set(
        contests
          .map((c) => c.jsonodds_id)
          .filter((v): v is string => typeof v === 'string' && v !== ''),
      ),
    ];
    if (jsonoddsIds.length > 0) {
      const gamesRes = await sb
        .from('games')
        .select('jsonodds_id, final_type')
        .eq('network', config.network)
        .in('jsonodds_id', jsonoddsIds);
      if (gamesRes.error) {
        logger.error({ err: gamesRes.error.message }, 'contests: dated finality query failed');
        res.status(500).json({ error: 'Failed to fetch game finality.', code: 'INTERNAL_ERROR' } satisfies ApiError);
        return;
      }
      const gameRows = (gamesRes.data ?? []) as unknown as Array<{
        jsonodds_id: string;
        final_type: string | null;
      }>;
      for (const g of gameRows) {
        if (g.final_type != null) finalTypeByJsonoddsId.set(g.jsonodds_id, g.final_type);
      }
    }
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

  const contestsList: ContestListItem[] = contests.map((c) => {
    const item: ContestListItem = {
      contestId: String(c.contest_id),
      // Game identity, both modes, always-present keys (see the file
      // header): the same string under the games-surface name and the
      // contest-detail name.
      gameId: c.jsonodds_id ?? null,
      jsonoddsId: c.jsonodds_id ?? null,
      awayTeam: c.away_team ?? '',
      homeTeam: c.home_team ?? '',
      sport: c.sport_slug ?? '',
      sportId: c.jsonodds_sport_id ?? 0,
      matchTime: c.effective_start_time ?? '',
      chainStartTime: c.start_time ?? '',
      gameMatchTime: c.game_match_time ?? '',
      gameEarliestMatchTime: c.game_earliest_match_time ?? '',
      gameRundownMatchTime: c.game_rundown_match_time ?? '',
      gameSportspageMatchTime: c.game_sportspage_match_time ?? '',
      status: c.contest_status ?? '',
      speculations: specsByContest.get(String(c.contest_id)) ?? [],
    };
    // `gameFinalType` is ADDED only in dated mode — the default listing's
    // rows never carry the key (pinned by the dated-discovery suite's
    // absence test).
    if (finalTypeByJsonoddsId !== null) {
      item.gameFinalType =
        c.jsonodds_id != null ? (finalTypeByJsonoddsId.get(c.jsonodds_id) ?? '') : '';
    }
    return item;
  });

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
    .from(CONTESTS_VIEW)
    .select(CONTEST_DETAIL_COLUMNS)
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
    matchTime: c.effective_start_time ?? '',
    chainStartTime: c.start_time ?? '',
    gameMatchTime: c.game_match_time ?? '',
    gameEarliestMatchTime: c.game_earliest_match_time ?? '',
    gameRundownMatchTime: c.game_rundown_match_time ?? '',
    gameSportspageMatchTime: c.game_sportspage_match_time ?? '',
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
