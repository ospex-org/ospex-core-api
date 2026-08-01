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
 * A row is served only if it is `confidence='fresh'` AND it clears the same
 * TIMING-ADMISSIBILITY contract ospex-benchmark's CLV scorer applies. That
 * contract is a validation step followed by two verdicts, in this order:
 *
 *   1. close_timing_unusable  — a fresh row must carry ALL THREE of
 *      value_captured_at, last_polled_at and poll_gap_seconds; every instant
 *      must be offset-qualified; and poll_gap_seconds must agree with
 *      `lock_time - last_polled_at` within the tolerance. Evidence is validated
 *      BEFORE any verdict is read off it.
 *   2. close_after_start      — last_polled_at at or after lock_time by >= the
 *      tolerance: the feed was still quoting past the recorded start.
 *   3. close_value_after_lock — value_captured_at > lock_time, strictly, with
 *      no tolerance.
 *
 * Why any of this exists: `confidence` applies only an UPPER bound on the
 * writer's poll gap, so a market polled AFTER its lock still classifies
 * `fresh`. The scorer refuses those independently, so serving them made this
 * API the more permissive of two CLV surfaces over the same data — 147 rows,
 * 4.05%, on the corpus measured 2026-07-31.
 *
 * SCOPE, stated precisely: this is TIMING-admissibility parity, not complete
 * scorer admissibility. The scorer applies further refusals that are NOT
 * ported here — notably its quote-consistency check, which refuses a close
 * whose two no-vig probabilities do not cohere. A row can therefore be served
 * here and still be refused by the scorer on a non-timing ground. Extending to
 * quote consistency is separate work, deliberately not folded in.
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
  value_captured_at: string | null;
  poll_gap_seconds: number | null;
}

// Every timing column the scorer's admissibility contract reads. poll_gap_seconds
// is selected NOT to decide the verdict from -- the verdict comes from the raw
// instants -- but to be cross-checked against them, which is how a forged or
// stale stored gap is caught.
// Kept as ONE string literal, not a concatenation: supabase-js infers the row
// type from the literal, and splitting it collapses that inference to
// GenericStringError[].
const CLOSING_LINE_COLUMNS =
  'jsonodds_id, market, line, away_p_novig, home_p_novig, lock_time, last_polled_at, value_captured_at, poll_gap_seconds';
const LINE_EPS = 1e-6;
const PAGE = 1000; // PostgREST default row cap

/**
 * Sub-second tolerance on the post-start-poll boundary, mirroring the scorer's
 * POLL_GAP_COHERENCE_TOLERANCE_MS. It absorbs rounding only: `poll_gap_seconds`
 * is stored at integer-second granularity, so a poll landing a few hundred
 * milliseconds after lock rounds to a stored gap of 0 and is not meaningfully
 * "after the start". A full second past lock is.
 */
const POLL_GAP_COHERENCE_TOLERANCE_MS = 1000;

/**
 * An offset-qualified ISO-8601 instant parsed to epoch ms, or null if the string
 * is not one.
 *
 * Mirrors the scorer's `instantMs` / `isParseableInstant`. The offset
 * requirement is load-bearing rather than stylistic:
 * `Date.parse('2026-07-28T23:09:00')` carries no offset and is interpreted in
 * the SERVER'S LOCAL ZONE, so the same row resolves to a different instant on a
 * UTC dyno than on a developer machine -- and therefore to a different public
 * verdict.
 *
 * core-api carries no zod dependency, so the scorer's
 * `z.string().datetime({ offset: true })` is reimplemented here. That makes
 * ACCEPT-SET PARITY something to measure, not assume: a first attempt was more
 * permissive than the scorer (lowercase `t`/`z`, and nonexistent calendar dates
 * that Date.parse silently normalises), and a second over-corrected and would
 * have dropped shapes the scorer accepts (`+0000`, seconds omitted, years below
 * 0100). Both directions matter -- too permissive serves rows the scorer
 * refuses, too strict withholds rows it scores.
 *
 * Parity is verified by a differential probe against the scorer's real
 * `isParseableInstant` over 120,328 inputs -- a structured matrix of malformed
 * shapes plus a seeded random sweep -- with zero disagreements in either
 * direction.
 */

// Deliberately mirrors zod's `.datetime({ offset: true })` ACCEPT SET, verified
// by differential probe rather than by reading: uppercase `T`/`Z` only, seconds
// optional, and the offset spelled `+hh:mm`, `+hhmm` or `+hh`.
const OFFSET_QUALIFIED_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

function instantMs(iso: string): number | null {
  const m = OFFSET_QUALIFIED_INSTANT.exec(iso);
  if (m === null) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || sec > 59) return null;
  if (m[9] !== undefined && Number(m[9]) > 23) return null;
  if (m[10] !== undefined && Number(m[10]) > 59) return null;

  // Calendar round-trip. Date.parse NORMALISES an impossible date rather than
  // failing -- 2026-02-29 becomes March 1, 2026-04-31 becomes May 1 -- so
  // without this a nonexistent date is silently accepted as a real instant.
  const rt = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  // Date.UTC maps years 0-99 onto 1900-1999, so a bare round-trip would wrongly
  // reject e.g. 0064-03-18. Restore the real year before comparing.
  if (y < 100) rt.setUTCFullYear(y);
  if (rt.getUTCFullYear() !== y || rt.getUTCMonth() !== mo - 1 || rt.getUTCDate() !== d) {
    return null;
  }

  // Syntax and range are separate checks, as they are in the scorer: the
  // pattern admits offsets Date.parse still turns into NaN.
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Validated timing evidence, or the reasons it cannot be trusted. */
type CloseTiming =
  | { kind: 'unusable'; violations: string[] }
  | {
      kind: 'usable';
      lockMs: number;
      valueCapturedMs: number | null;
      lastPolledMs: number | null;
    };

/**
 * Validate a close's timing evidence BEFORE any timing verdict is read off it.
 *
 * This is the scorer's `closeTiming` PRECONDITION, not merely its final
 * comparison. An earlier revision of this file ported only `closeAfterStart` --
 * the last rung of the scorer's ladder -- which reproduces the scorer's answer
 * for well-formed rows and silently disagrees on every malformed one. A row with
 * null timing, or a stored gap contradicting its own instants, was SERVED here
 * while the scorer refuses it as `close_timing_unusable`. "The two agree by
 * construction" is only true when the precondition travels with the comparison.
 *
 * Every rule below is the scorer's, applied to the `fresh` rows this query
 * fetches:
 *
 *   - a fresh row must carry ALL THREE of value_captured_at, last_polled_at and
 *     poll_gap_seconds. `fresh` is a claim that the capture observed this market
 *     at a known instant, so a fresh row missing those instants is evidence of
 *     nothing;
 *   - lock_time must be a parseable offset-qualified instant -- it is the cutoff
 *     every other comparison is relative to;
 *   - value_captured_at and last_polled_at, when present, must parse likewise;
 *   - poll_gap_seconds must be finite, and must not be present alongside a null
 *     last_polled_at (a gap with nothing to corroborate it against);
 *   - poll_gap_seconds must agree with `lock_time - last_polled_at` within the
 *     tolerance, so a forged or stale stored gap cannot override the instants.
 *
 * Violations accumulate rather than short-circuiting, so a withheld row reports
 * every problem it has at once instead of only the first.
 */
function closeTiming(row: ClosingLineRow): CloseTiming {
  const violations: string[] = [];

  const absent = (
    [
      ['value_captured_at', row.value_captured_at],
      ['last_polled_at', row.last_polled_at],
      ['poll_gap_seconds', row.poll_gap_seconds],
    ] as const
  )
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  if (absent.length > 0) {
    violations.push(
      `a fresh close must carry complete timing evidence, but ${absent.join(', ')} ` +
        `${absent.length === 1 ? 'is' : 'are'} null`,
    );
  }

  function parseField(label: string, iso: string | null): number | null | undefined {
    if (iso === null) return null;
    const ms = instantMs(iso);
    if (ms === null) {
      violations.push(`${label} is not a valid offset-qualified instant: "${iso}"`);
      return undefined;
    }
    return ms;
  }

  let lockMs: number | undefined;
  if (row.lock_time === null) {
    violations.push('lock_time is null — there is no cutoff to judge anything against');
  } else {
    const parsed = parseField('lock_time', row.lock_time);
    if (typeof parsed === 'number') lockMs = parsed;
  }
  const valueCapturedMs = parseField('value_captured_at', row.value_captured_at);
  const lastPolledMs = parseField('last_polled_at', row.last_polled_at);

  const gap = row.poll_gap_seconds;
  if (gap !== null) {
    if (!Number.isFinite(gap)) {
      violations.push(`poll_gap_seconds is not a finite number: ${String(gap)}`);
    } else if (row.last_polled_at === null) {
      violations.push(
        `poll_gap_seconds is ${gap} but last_polled_at is null — ` +
          'the stored gap cannot be corroborated against any instant',
      );
    } else if (typeof lockMs === 'number' && typeof lastPolledMs === 'number') {
      const residual = Math.abs(gap * 1000 - (lockMs - lastPolledMs));
      if (residual > POLL_GAP_COHERENCE_TOLERANCE_MS) {
        violations.push(
          `poll_gap_seconds (${gap}s) disagrees with lock_time - last_polled_at ` +
            `by ${residual}ms, beyond the ${POLL_GAP_COHERENCE_TOLERANCE_MS}ms tolerance`,
        );
      }
    }
  }

  if (violations.length > 0) return { kind: 'unusable', violations };
  return {
    kind: 'usable',
    lockMs: lockMs as number,
    valueCapturedMs: valueCapturedMs as number | null,
    lastPolledMs: lastPolledMs as number | null,
  };
}

type UsableTiming = Extract<CloseTiming, { kind: 'usable' }>;

/**
 * Was the feed still quoting this market at or after its own recorded lock?
 *
 * Read from the raw instants, never from the stored `poll_gap_seconds` -- a
 * rounded integer written at capture should not override what the timestamps
 * say. The gap is cross-checked in closeTiming instead.
 *
 * A null `last_polled_at` is NOT a refusal here: that market was never seen in
 * the poll snapshot, which closeTiming has already refused above on its own,
 * more specific ground. Refusing it a second time here would double-count one
 * problem under two names.
 *
 * MILLISECOND RESOLUTION IS DELIBERATE, and is not the Date.parse precision
 * defect corrected elsewhere in this sweep. This predicate's job is to return
 * what the scorer returns, and the scorer compares milliseconds against a
 * 1000ms tolerance; making it microsecond-exact would make it DISAGREE within a
 * microsecond of the boundary. Strictness and precision are separate axes --
 * the strict offset requirement above is ported, the ms comparison is kept.
 */
function closeAfterStart(t: UsableTiming): boolean {
  if (t.lastPolledMs === null) return false;
  return t.lastPolledMs - t.lockMs >= POLL_GAP_COHERENCE_TOLERANCE_MS;
}

/**
 * Was the quoted VALUE captured after the lock? Distinct from closeAfterStart:
 * that asks whether the FEED was still listing the market, this asks whether the
 * price we would publish post-dates the cutoff.
 *
 * STRICTLY after, with NO tolerance -- deliberately unlike closeAfterStart. That
 * allowance exists because poll_gap_seconds is quantised to whole seconds;
 * value_captured_at is a direct timestamp with no such quantisation, so
 * borrowing the allowance would silently accept a price captured up to 999ms
 * past its own cutoff.
 *
 * Expected to be dead on arrival -- ospex-writer bounds this at the source and
 * the captured corpus carries 0 violations -- but it is the scorer's third
 * refusal, and keeping it measured rather than assumed is the whole point of
 * porting the contract rather than a summary of it.
 */
function closeValueAfterLock(t: UsableTiming): boolean {
  if (t.valueCapturedMs === null) return false;
  return t.valueCapturedMs > t.lockMs;
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
    let timingUnusableWithheld = 0;
    let valueAfterLockWithheld = 0;
    const unusableSamples: string[] = [];
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
          // The scorer's ladder, in the scorer's order: evidence is VALIDATED
          // before any verdict is read off it, and each refusal is counted
          // under its own name so the log is truthful about why a row was
          // withheld rather than labelling everything post-start.
          const timing = closeTiming(r);
          if (timing.kind === 'unusable') {
            timingUnusableWithheld += 1;
            if (unusableSamples.length < 3) {
              unusableSamples.push(`${r.jsonodds_id}|${r.market}: ${timing.violations.join('; ')}`);
            }
            continue;
          }
          if (closeAfterStart(timing)) {
            postStartWithheld += 1;
            continue;
          }
          if (closeValueAfterLock(timing)) {
            valueAfterLockWithheld += 1;
            continue;
          }
          closingByKey.set(`${r.jsonodds_id}|${r.market}`, r);
        }
        if (rows.length < PAGE) break;
      }
    }

    // Say so rather than dropping quietly, and name the actual reason. An
    // earlier revision logged every withheld row as `close_after_start`, which
    // was untrue for malformed timing and made the count unusable as evidence.
    if (postStartWithheld > 0) {
      logger.info(
        { withheld: postStartWithheld, games: jsonoddsIds.length },
        'speculations: withheld fresh closes polled past their own lock (scorer: close_after_start)',
      );
    }
    if (timingUnusableWithheld > 0) {
      logger.warn(
        { withheld: timingUnusableWithheld, games: jsonoddsIds.length, samples: unusableSamples },
        'speculations: withheld fresh closes whose timing evidence is unusable (scorer: close_timing_unusable)',
      );
    }
    if (valueAfterLockWithheld > 0) {
      logger.warn(
        { withheld: valueAfterLockWithheld, games: jsonoddsIds.length },
        'speculations: withheld fresh closes whose VALUE post-dates its lock (scorer: close_value_after_lock)',
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
