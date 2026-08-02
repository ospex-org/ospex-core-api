/**
 * Shared types + row converters for the speculations wire format.
 *
 * Used by both `/v1/contests/:contestId` (legacy path keeps the
 * scorer-address mapping for back-compat — see `specRowToSpeculationViaScorer`)
 * and the new `/v1/speculations*` endpoints (use `market_type` column
 * directly — `specRowToSpeculation`).
 *
 * The `Speculation` shape always carries `contestId` so a Speculation
 * is meaningful standalone (matches the on-chain `Speculation` struct,
 * where `contestId` is field 1).
 */

import {
  lineTicksToLine,
  scorerToType,
  type MarketType,
  type ScorerAddresses,
  type WinSide,
  type SettledWinSide,
} from '../../lib/speculation.js';
import type { CommitmentBody, CommitmentHiddenBody } from '../commitments.js';

export interface Speculation {
  speculationId: string;
  contestId: string;
  type: MarketType;
  lineTicks: number | null;
  line: number | null;
  awayLine?: number;
  homeLine?: number;
  /**
   * 0 = open (taking commitments), 1 = closed (settled on-chain via
   * `settleSpeculation`). Maps directly from the `speculation_status` column,
   * which flips to `'closed'` ONLY at settle time — never at contest-score time.
   */
  speculationStatus: 0 | 1;
  /**
   * The settled outcome, or `null` while the speculation is still open
   * (`win_side='tbd'`). `'push'`/`'void'` are settled outcomes (non-null).
   *
   * INVARIANT: on this surface `speculationStatus === 1` ⟺ `winSide !== null`.
   * Both fields are projected from the SAME Supabase row, and the indexer writes
   * `speculation_status`, `win_side`, and `settled_at` in one atomic UPDATE — so
   * a closed speculation always carries its winner (no "closed with no winner"
   * window is representable here).
   */
  winSide: SettledWinSide | null;
  /** ISO timestamp of the on-chain settlement, or `null` while open. */
  settledAt: string | null;
  /**
   * True iff the speculation settled to `void` (equivalently `winSide === 'void'`,
   * per the DB `chk_void_consistency` constraint). Surfaced explicitly so
   * consumers don't have to special-case the `'void'` enum value.
   */
  voided: boolean;
  /**
   * No-vig fair closing line for this market, from the materialized
   * `closing_lines` table (poll-liveness `fresh` rows only). Present only when
   * a fresh closing line was captured for the parent contest's market; absent
   * otherwise (renders as CLV-not-measurable). Attached on the list endpoint
   * (`GET /v1/speculations`); the detail / recovery paths do not populate it.
   */
  closing?: ClosingLine;
}

export interface ClosingLine {
  /**
   * No-vig fair closing decimal for the away/over side (0 = upper). `1 / p_novig`.
   * null when the price is not resolvable — a spread/total whose line moved off
   * the speculation's line (push-probability estimate deferred).
   */
  awayDecimal: number | null;
  /** No-vig fair closing decimal for the home/under side (1 = lower). */
  homeDecimal: number | null;
  /** The line the market closed at (transparency; null for moneyline). */
  line: number | null;
  /**
   * True when a side decimal was derived via a push-probability estimate rather
   * than a direct same-line comparison. Always false today (estimate deferred).
   */
  estimated: boolean;
}

export interface SpeculationDetail extends Speculation {
  // Hidden rows are filtered upstream (book_visible=true); the union accepts
  // `CommitmentHiddenBody` for defense-in-depth — a hidden row that ever reaches
  // the mapper SURFACES REDACTED here (flat list, matching the list / recovery /
  // SSE paths) rather than leaking its signed payload. (The contest-detail
  // orderbook instead DROPS such a row — it groups by `speculationKey`, which a
  // redacted body lacks; see getContestByIdHandler.)
  orderbook: Array<CommitmentBody | CommitmentHiddenBody>;
  /**
   * Parent contest context — kept small so consumers don't
   * have to fetch `/v1/contests/:contestId` for the common "what game
   * is this on?" question. Source hashes / scores / lifecycle
   * timestamps stay on the contest detail endpoint.
   */
  contest: SpeculationParentContext;
}

export interface SpeculationParentContext {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  /**
   * Team UUIDs from `teams` resolved via the writer-managed games row
   * (see lib/teamIds.ts). Null when the contest has no JSONOdds linkage
   * or the games row is missing. The SDK's resolver layer scopes
   * alias matching to these ids when both are non-null and falls back
   * to exact + nickname matching otherwise. These fields are additive —
   * older clients that don't read them are unaffected.
   */
  awayTeamId: string | null;
  homeTeamId: string | null;
  sport: string;
  /**
   * Current conservative start-time safety bound — a bounded minimum over
   * `chainStartTime`, `gameMatchTime`, the game's retained safety floor
   * (served here as `gameEarliestMatchTime`), and the provider snapshots
   * within their one-hour freshness window. A conservative safety bound, NOT
   * a prediction of first pitch; gate on this.
   * `<= chainStartTime` whenever `chainStartTime` is non-empty — but NOT when
   * it is `''` (the unverified window), so a consumer gate must read
   * `chainStartTime === '' || matchTime <= chainStartTime`. See the
   * `/v1/contests` file header for the full six-field contract.
   */
  matchTime: string;
  /** Raw on-chain start (`contests.start_time`). `""` until the contest is verified. */
  chainStartTime: string;
  /** Raw odds-feed schedule (`games.match_time`), joined on `(network, jsonodds_id)`. */
  gameMatchTime: string;
  /** The game's current retained safety floor (`games.earliest_match_time`), verbatim — never
   *  clamped. `""` when no games row is linked. When it is the minimum of the inputs, it
   *  is what is driving `matchTime`. See the `/v1/contests` file header. */
  gameEarliestMatchTime: string;
  /** Provider start-time snapshots (`games.rundown_match_time` /
   *  `games.sportspage_match_time`), verbatim. Dated observations; they enter
   *  `matchTime` only through the view's one-hour freshness guard. `""` when
   *  no games row is linked or no snapshot has been captured. */
  gameRundownMatchTime: string;
  gameSportspageMatchTime: string;
  status: string;
}

export interface SpeculationRow {
  speculation_id: string | number;
  contest_id: string | number;
  speculation_scorer: string | null;
  market_type: MarketType | null;
  line_ticks: number | null;
  speculation_status: string | null;
  win_side: WinSide | null;
  settled_at: string | null;
  voided: boolean | null;
}

/**
 * Project the settlement outcome onto the wire shape. Shared by both
 * converters so they can't drift. `win_side='tbd'` → `winSide: null`
 * (agents test `winSide != null`, not a magic sentinel); timestamps pass
 * through verbatim (ISO | null) — never round-tripped through `Date`, per
 * the timestamptz-precision rule.
 */
function winnerFields(row: SpeculationRow): Pick<Speculation, 'winSide' | 'settledAt' | 'voided'> {
  return {
    winSide: row.win_side && row.win_side !== 'tbd' ? row.win_side : null,
    settledAt: row.settled_at ?? null,
    voided: row.voided ?? false,
  };
}

/**
 * Authoritative path: read `market_type` directly from the column.
 * Used by `/v1/speculations*` endpoints. Drops rows with a null
 * `market_type` (shouldn't happen given the schema NOT NULL, but
 * defensively guard so a malformed row never lands in the response).
 */
export function specRowToSpeculation(row: SpeculationRow): Speculation | null {
  if (!row.market_type) return null;
  const lineTicks = row.line_ticks ?? null;
  const line = lineTicksToLine(row.market_type, lineTicks);
  const status = row.speculation_status === 'closed' ? 1 : 0;
  const out: Speculation = {
    speculationId: String(row.speculation_id),
    contestId: String(row.contest_id),
    type: row.market_type,
    lineTicks,
    line,
    speculationStatus: status,
    ...winnerFields(row),
  };
  if (row.market_type === 'spread' && line != null) {
    out.awayLine = line;
    out.homeLine = -line;
  }
  return out;
}

/**
 * Back-compat path: derive the market type from the scorer address.
 * Used by `/v1/contests/:contestId` to preserve the exact wire output
 * the legacy `/v1/markets/:contestId` endpoint produced. New code
 * should prefer `specRowToSpeculation`.
 */
export function specRowToSpeculationViaScorer(
  row: SpeculationRow,
  scorers: ScorerAddresses,
): Speculation | null {
  const type = scorerToType(row.speculation_scorer ?? '', scorers);
  if (!type) return null;
  const lineTicks = row.line_ticks ?? null;
  const line = lineTicksToLine(type, lineTicks);
  const status = row.speculation_status === 'closed' ? 1 : 0;
  const out: Speculation = {
    speculationId: String(row.speculation_id),
    contestId: String(row.contest_id),
    type,
    lineTicks,
    line,
    speculationStatus: status,
    ...winnerFields(row),
  };
  if (type === 'spread' && line != null) {
    out.awayLine = line;
    out.homeLine = -line;
  }
  return out;
}

export const SPECULATION_COLUMNS =
  'speculation_id, contest_id, speculation_scorer, market_type, line_ticks, speculation_status, win_side, settled_at, voided';
