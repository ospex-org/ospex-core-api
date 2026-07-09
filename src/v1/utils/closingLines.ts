/**
 * Closing-line enrichment for the speculations read path.
 *
 * Attaches a no-vig fair closing line (both sides) to each speculation from the
 * materialized `closing_lines` table (written by ospex-writer). The table stores
 * de-vig'd fair probabilities per (network, jsonodds_id, market); here we resolve
 * each speculation's parent contest → jsonodds_id, look up the FRESH closing row
 * for its market, and expose `1 / p_novig` per side. The frontend derives CLV
 * (beat rate + edge) from each taker's actual price against this reference.
 *
 * Only `confidence='fresh'` rows are surfaced — the writer's poll-liveness gate
 * (the market was still being polled at lock). Spread/total prices only resolve
 * when the speculation's line equals the line the market closed at; a half-run
 * move renders the decimals null (push-probability estimate deferred, per the
 * closing-line spec). Moneyline has no line, so it always resolves.
 *
 * Best-effort + additive: a fetch failure logs and leaves speculations
 * unenriched (CLV renders not-yet-measurable) rather than failing the read.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger.js';
import type { MarketType } from '../../lib/speculation.js';
import type { ClosingLine, Speculation } from './speculations.js';

interface ClosingLineRow {
  jsonodds_id: string;
  market: string;
  line: number | null;
  away_p_novig: number | null;
  home_p_novig: number | null;
}

const CLOSING_LINE_COLUMNS = 'jsonodds_id, market, line, away_p_novig, home_p_novig';
const LINE_EPS = 1e-6;
const PAGE = 1000; // PostgREST default row cap

/** Fair no-vig decimal from a probability. null when the prob is missing/invalid. */
function fairDecimal(p: number | null): number | null {
  if (p === null || !(p > 0)) return null;
  // 5dp matches the numeric(10,5) precision of the raw closing decimals.
  return Math.round((1 / p) * 100000) / 100000;
}

/**
 * Whether the speculation's line matches the line the market closed at. Compared
 * on magnitude (spread sides are sign-mirrored; the side is picked separately by
 * position type). Moneyline has no line → always matches.
 */
function lineResolves(specLine: number | null, closingLine: number | null, market: MarketType): boolean {
  if (market === 'moneyline') return true;
  if (specLine === null || closingLine === null) return false;
  return Math.abs(Math.abs(specLine) - Math.abs(closingLine)) < LINE_EPS;
}

function toClosing(spec: Speculation, row: ClosingLineRow): ClosingLine {
  const resolvable = lineResolves(spec.line, row.line ?? null, spec.type);
  return {
    awayDecimal: resolvable ? fairDecimal(row.away_p_novig) : null,
    homeDecimal: resolvable ? fairDecimal(row.home_p_novig) : null,
    line: row.line ?? null,
    estimated: false,
  };
}

/**
 * Attach `.closing` to each speculation in place. Resolves contest → jsonodds_id,
 * then the fresh closing_lines rows for those games, keyed by (jsonodds_id,
 * market). Speculations with no fresh closing line are left untouched.
 */
export async function attachClosingLines(
  sb: SupabaseClient,
  network: string,
  specs: Speculation[],
): Promise<void> {
  if (specs.length === 0) return;
  try {
    // 1. contest_id → jsonodds_id (paginated `.in` in case the id set is large).
    const contestIds = [...new Set(specs.map((s) => s.contestId))];
    const contestToJsonodds = new Map<string, string>();
    for (let i = 0; i < contestIds.length; i += PAGE) {
      const chunk = contestIds.slice(i, i + PAGE);
      const { data, error } = await sb
        .from('contests')
        .select('contest_id, jsonodds_id')
        .eq('network', network)
        .in('contest_id', chunk);
      if (error) throw new Error(`contests resolve failed: ${error.message}`);
      for (const r of (data ?? []) as Array<{ contest_id: string | number; jsonodds_id: string | null }>) {
        if (r.jsonodds_id) contestToJsonodds.set(String(r.contest_id), r.jsonodds_id);
      }
    }

    const jsonoddsIds = [...new Set(contestToJsonodds.values())];
    if (jsonoddsIds.length === 0) return;

    // 2. fresh closing_lines by (jsonodds_id | market). Each game has <= 3 fresh
    //    markets, so a chunk of PAGE ids can exceed the row cap — page the result.
    const closingByKey = new Map<string, ClosingLineRow>();
    for (let i = 0; i < jsonoddsIds.length; i += PAGE) {
      const chunk = jsonoddsIds.slice(i, i + PAGE);
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await sb
          .from('closing_lines')
          .select(CLOSING_LINE_COLUMNS)
          .eq('network', network)
          .eq('confidence', 'fresh')
          .in('jsonodds_id', chunk)
          .order('jsonodds_id', { ascending: true })
          .order('market', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error(`closing_lines fetch failed: ${error.message}`);
        const rows = (data ?? []) as ClosingLineRow[];
        for (const r of rows) closingByKey.set(`${r.jsonodds_id}|${r.market}`, r);
        if (rows.length < PAGE) break;
      }
    }

    // 3. apply.
    for (const spec of specs) {
      const jsonoddsId = contestToJsonodds.get(spec.contestId);
      if (jsonoddsId === undefined) continue;
      const row = closingByKey.get(`${jsonoddsId}|${spec.type}`);
      if (row === undefined) continue;
      spec.closing = toClosing(spec, row);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'speculations: closing-line enrichment failed (non-fatal)',
    );
  }
}
