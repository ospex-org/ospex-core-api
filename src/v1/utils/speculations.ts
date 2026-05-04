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

import { lineTicksToLine, scorerToType, type MarketType, type ScorerAddresses } from '../../lib/speculation.js';
import type { CommitmentBody } from '../commitments.js';

export interface Speculation {
  speculationId: string;
  contestId: string;
  type: MarketType;
  lineTicks: number | null;
  line: number | null;
  awayLine?: number;
  homeLine?: number;
  /** 0 = open (taking commitments), 1 = closed (settled or scored). */
  speculationStatus: 0 | 1;
}

export interface SpeculationDetail extends Speculation {
  orderbook: CommitmentBody[];
  /**
   * Parent contest context — kept small (5 fields) so consumers don't
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
  sport: string;
  matchTime: string;
  status: string;
}

export interface SpeculationRow {
  speculation_id: string | number;
  contest_id: string | number;
  speculation_scorer: string | null;
  market_type: MarketType | null;
  line_ticks: number | null;
  speculation_status: string | null;
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
  };
  if (type === 'spread' && line != null) {
    out.awayLine = line;
    out.homeLine = -line;
  }
  return out;
}

export const SPECULATION_COLUMNS =
  'speculation_id, contest_id, speculation_scorer, market_type, line_ticks, speculation_status';
