/**
 * Shared types + row converters for the upstream-reference-odds wire format.
 *
 * Single source of truth for the per-market odds shape, used by BOTH:
 *   - `GET /v1/contests/:contestId/odds` (REST one-shot snapshot — see odds.ts)
 *   - `GET /v1/stream/odds` (SSE snapshot + live change/refresh — see
 *     stream/oddsHandler.ts)
 * so a stream delta and a REST snapshot for the same market are byte-for-byte
 * the same shape (mirrors how the protocol stream reuses the A1 recovery
 * mappers).
 *
 * Per-market shapes are explicit rather than a shared "line + away/home odds"
 * envelope, so consumers can't misread the semantics:
 *   - moneyline — per-side American odds; line is meaningless, so it's absent.
 *   - spread — both sides of the line are labelled. The writer stores
 *     `current_odds.line` as the *home* team's spread (negative if home is
 *     favored — pollCycle.ts); we expose `homeLine` (raw) and
 *     `awayLine = -homeLine` so callers never guess which side `line` is.
 *   - total — single `line` is the over/under threshold (perspective-neutral).
 *     The writer stores Over → away_odds_american and Under →
 *     home_odds_american; consumers see over/under names, never the storage
 *     convention.
 *
 * None of these shapes carry `jsonoddsId` — the provider's game id is an
 * internal join key, resolved server-side from the Ospex `contestId`, and is
 * intentionally not part of the public surface.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CurrentOddsRow } from '../../lib/oddsClassifier.js';

export type OddsMarket = 'moneyline' | 'spread' | 'total';

export function isOddsMarket(value: string): value is OddsMarket {
  return value === 'moneyline' || value === 'spread' || value === 'total';
}

/**
 * Provenance timestamps shared by every market shape:
 *   - upstreamLastUpdated — when the upstream provider's row last moved
 *   - pollCapturedAt      — when the writer last re-fetched the upstream row
 *   - changedAt           — when any tracked price column last changed
 */
export interface OddsTimestamps {
  upstreamLastUpdated: string;
  pollCapturedAt: string;
  changedAt: string;
}

export interface MoneylineOdds extends OddsTimestamps {
  market: 'moneyline';
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

export interface SpreadOdds extends OddsTimestamps {
  market: 'spread';
  /** Away team's spread (= -homeLine when home line is set). */
  awayLine: number | null;
  /** Home team's spread (raw current_odds.line — negative if home favored). */
  homeLine: number | null;
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

export interface TotalOdds extends OddsTimestamps {
  market: 'total';
  /** Over/under threshold (perspective-neutral). */
  line: number | null;
  overOddsAmerican: number | null;
  underOddsAmerican: number | null;
}

export type MarketOdds = MoneylineOdds | SpreadOdds | TotalOdds;

/** Just the columns `rowToMarketOdds` reads — satisfied by both a full
 * Realtime row and a snapshot SELECT that omits network/jsonodds_id. */
export type MarketOddsRow = Pick<
  CurrentOddsRow,
  'market' | 'line' | 'away_odds_american' | 'home_odds_american' | 'upstream_last_updated' | 'poll_captured_at' | 'changed_at'
>;

/** SELECT list for a `current_odds` snapshot read. Includes `jsonodds_id`
 * (filter/debug only — the mapper never copies it into the public shape). */
export const CURRENT_ODDS_COLUMNS =
  'jsonodds_id, market, line, away_odds_american, home_odds_american, upstream_last_updated, poll_captured_at, changed_at';

/** Map a raw `current_odds` row to its market-specific public shape. Returns
 * null for an unrecognized market (the table has a CHECK constraint, so this
 * is purely defensive — a future market value never crashes the shape). */
export function rowToMarketOdds(row: MarketOddsRow): MarketOdds | null {
  const ts: OddsTimestamps = {
    upstreamLastUpdated: row.upstream_last_updated,
    pollCapturedAt: row.poll_captured_at,
    changedAt: row.changed_at,
  };
  if (row.market === 'moneyline') {
    return {
      ...ts,
      market: 'moneyline',
      awayOddsAmerican: row.away_odds_american,
      homeOddsAmerican: row.home_odds_american,
    };
  }
  if (row.market === 'spread') {
    const homeLine = row.line;
    return {
      ...ts,
      market: 'spread',
      awayLine: homeLine === null ? null : -homeLine,
      homeLine,
      awayOddsAmerican: row.away_odds_american,
      homeOddsAmerican: row.home_odds_american,
    };
  }
  if (row.market === 'total') {
    return {
      ...ts,
      market: 'total',
      line: row.line,
      overOddsAmerican: row.away_odds_american,
      underOddsAmerican: row.home_odds_american,
    };
  }
  return null;
}

export interface ContestLinkage {
  /** True when a contest row exists for (network, contestId). */
  found: boolean;
  /** The contest's upstream game id, or null when there's no linkage. */
  jsonoddsId: string | null;
}

/** Resolve a contest's upstream `jsonodds_id`. Throws on a query error (the
 * caller decides how to surface it); a missing contest is `{ found:false }`. */
export async function resolveContestJsonoddsId(
  sb: SupabaseClient,
  network: string,
  contestId: string,
): Promise<ContestLinkage> {
  const { data, error } = await sb
    .from('contests')
    .select('jsonodds_id')
    .eq('network', network)
    .eq('contest_id', contestId)
    .maybeSingle();
  if (error) throw new Error(`contest lookup failed: ${error.message}`);
  if (data === null) return { found: false, jsonoddsId: null };
  const row = data as unknown as { jsonodds_id: string | null };
  return { found: true, jsonoddsId: row.jsonodds_id ?? null };
}

/** Read the current odds for one (jsonoddsId, market) and map to the public
 * shape; null when the writer hasn't populated that market. Throws on a query
 * error. */
export async function fetchMarketSnapshot(
  sb: SupabaseClient,
  network: string,
  jsonoddsId: string,
  market: OddsMarket,
): Promise<MarketOdds | null> {
  const { data, error } = await sb
    .from('current_odds')
    .select(CURRENT_ODDS_COLUMNS)
    .eq('network', network)
    .eq('jsonodds_id', jsonoddsId)
    .eq('market', market)
    .maybeSingle();
  if (error) throw new Error(`current_odds snapshot failed: ${error.message}`);
  if (data === null) return null;
  return rowToMarketOdds(data as unknown as MarketOddsRow);
}
