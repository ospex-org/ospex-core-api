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
 * TWO gates, not one, and they are independent.
 *
 * 1. `confidence='fresh'` — the writer's poll-liveness gate (the market was
 *    still being polled near lock).
 * 2. NOT a post-start poll — `last_polled_at` did not land at or after
 *    `lock_time`, which means the feed was still quoting this market past its
 *    own recorded start.
 *
 * The second gate exists because the first does not imply it. `confidence`
 * applies only an UPPER bound on the poll gap, so a NEGATIVE gap — polled after
 * the lock — classifies `fresh`. That is a defensible call in the writer, which
 * is reporting capture quality, but it is not the right call here: ospex-
 * benchmark's CLV scorer independently refuses exactly those rows as
 * `close_after_start`, so serving them made the public API the more permissive
 * of two CLV surfaces over the same data. On the corpus measured 2026-07-31
 * that was 147 rows, 4.05%, and the two sets partition exactly — every negative
 * gap is a scorer refusal and vice versa, with no row on either side alone.
 *
 * The predicate is replicated from the scorer rather than approximated: derived
 * from the raw instants (NOT the stored `poll_gap_seconds`, which a forged or
 * stale value could bend), `>=` against a sub-second tolerance, and a null
 * `last_polled_at` is NOT a refusal because a never-polled market is already
 * covered by `confidence`. If the scorer's boundary moves, this must move with
 * it — the point is that the two agree, not that either number is sacred.
 *
 * What this does NOT gate: whether the quoted VALUE was captured post-lock.
 * ospex-writer bounds that at the source (`captured_at <= lock`, re-asserted at
 * the write) and the corpus carries zero violations, so there is nothing to
 * filter here and a duplicate check would only drift.
 *
 * Spread/total prices only resolve when the speculation's line equals the line
 * the market closed at; a half-run move renders the decimals null (push-
 * probability estimate deferred, per the closing-line spec). Moneyline has no
 * line, so it always resolves.
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
  lock_time: string | null;
  last_polled_at: string | null;
}

const CLOSING_LINE_COLUMNS =
  'jsonodds_id, market, line, away_p_novig, home_p_novig, lock_time, last_polled_at';
const LINE_EPS = 1e-6;
const PAGE = 1000; // PostgREST default row cap

/**
 * Sub-second tolerance on the post-start-poll boundary, mirroring the scorer's
 * POLL_GAP_COHERENCE_TOLERANCE_MS. It absorbs rounding only: a poll landing a
 * few hundred milliseconds after lock rounds to a stored gap of 0 and is not
 * meaningfully "after the start". A full second past lock is.
 */
const POST_START_POLL_TOLERANCE_MS = 1000;

/**
 * Was the feed still quoting this market at or after its own recorded lock?
 *
 * Mirrors ospex-benchmark's `closeAfterStart`. Two properties are load-bearing
 * and must not be "simplified":
 *
 * - It reads the raw instants, never `poll_gap_seconds`. The stored gap is a
 *   rounded integer written at capture; deciding on it lets a stale or wrong
 *   value override what the timestamps plainly say.
 * - A null `last_polled_at` is NOT a refusal. That means the market was never
 *   seen in the poll snapshot at all, which `confidence` already covers — and
 *   treating absent evidence as guilt would withhold rows on a different ground
 *   than the scorer uses, re-opening the disagreement from the other side.
 *
 * An unparseable instant fails CLOSED (withheld): this decides what reaches a
 * public CLV surface, and a timestamp we cannot read is not evidence of safety.
 *
 * MILLISECOND RESOLUTION IS DELIBERATE HERE, and is not the `Date.parse`
 * precision defect corrected elsewhere in this sweep. Both columns are
 * `timestamptz`, so microseconds are available — but this predicate's entire
 * job is to return what ospex-benchmark's scorer returns, and the scorer
 * compares milliseconds against a 1000ms tolerance. Making this one
 * microsecond-exact would make it DISAGREE with the scorer within a microsecond
 * of the boundary, which is the opposite of the point.
 *
 * Where the resolution genuinely matters, it is fixed: ospex-writer's
 * `isValueAtOrBeforeLock` and this repo's `effectiveMatchTime` both compare
 * exact microseconds, because both are equality-sensitive boundaries rather
 * than a comparison against a one-second tolerance. If the scorer's own
 * precision ever changes, this must move with it.
 */
function isPostStartPoll(row: ClosingLineRow): boolean {
  if (row.last_polled_at === null) return false;
  if (row.lock_time === null) return true;
  const polled = Date.parse(row.last_polled_at);
  const lock = Date.parse(row.lock_time);
  if (!Number.isFinite(polled) || !Number.isFinite(lock)) return true;
  return polled - lock >= POST_START_POLL_TOLERANCE_MS;
}

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
    //
    //    The post-start-poll gate is applied HERE, in JS, not in the query:
    //    PostgREST cannot express a column-to-column comparison, and deciding it
    //    from the stored `poll_gap_seconds` (which PostgREST could filter) is
    //    precisely what the scorer moved away from. Paging is unaffected — the
    //    `rows.length < PAGE` termination still counts rows the SERVER returned,
    //    so filtering after the fact cannot end a page walk early.
    const closingByKey = new Map<string, ClosingLineRow>();
    let postStartWithheld = 0;
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
        for (const r of rows) {
          if (isPostStartPoll(r)) {
            postStartWithheld += 1;
            continue;
          }
          closingByKey.set(`${r.jsonodds_id}|${r.market}`, r);
        }
        if (rows.length < PAGE) break;
      }
    }

    // Say so rather than dropping quietly. A `fresh` row withheld here is one
    // the writer captured and the scorer refuses; if this count ever runs at a
    // rate far from the ~4% measured on the corpus, something upstream moved.
    if (postStartWithheld > 0) {
      logger.info(
        { withheld: postStartWithheld, games: jsonoddsIds.length },
        'speculations: withheld fresh closes polled past their own lock (scorer refuses these as close_after_start)',
      );
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
