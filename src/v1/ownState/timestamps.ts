/**
 * Microsecond-safe ISO-8601 timestamptz helpers shared across the
 * own-state derivation path.
 *
 * The own-state cursor wire contract (see `cursor.ts`) intentionally
 * preserves Postgres's microsecond precision verbatim — `Date.parse`
 * truncates to milliseconds, which would let two source-row updates in
 * the same millisecond compare as equal even though their cursor wire
 * forms differ. Same-ms timestamps then mis-sort, mis-filter, and the
 * `max(position, speculation, contest)` derivation could pick the
 * wrong source and freeze cursor.p when a parent transition actually
 * advanced.
 *
 * The shared helpers parse into a compound `(epochSec, micros)` key:
 *
 *   - `epochSec` is the timestamp's whole-second epoch via
 *     `Date.parse` of the timestamp with its fractional seconds
 *     stripped (which is safe — there's no precision loss in the
 *     whole-second component).
 *   - `micros` is the fractional part right-padded to 6 digits.
 *     Inputs with up to 9 fractional digits are accepted (matching
 *     the cursor decoder's range) but truncated to 6 — Postgres
 *     `timestamptz` is microsecond-precise; any ns digits are not
 *     load-bearing for our domain.
 *
 * The original timestamp string is preserved in callers' emitted
 * bodies / wire cursors. The parsed key is comparison-only.
 */

/**
 * Accept the timestamp shapes PostgREST / supabase-js can emit AND
 * the shapes our own minted cursors carry: trailing `Z` or `+00:00`
 * (or `+0000`-style), optional fractional seconds up to 9 digits.
 * Non-zero offsets are deliberately rejected — the server never
 * emits them, and accepting them would break component arithmetic.
 */
const ISO_TIMESTAMPTZ_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|\+00:?00)$/;

export interface IsoTimestamptzKey {
  /** Whole seconds since the Unix epoch. */
  epochSec: bigint;
  /** Microsecond fraction within `epochSec`, 0–999_999. */
  micros: number;
}

/**
 * Parse a Postgres `timestamptz` wire string into a microsecond-safe
 * comparable key. Returns `null` for shapes the wire contract does
 * not admit (caller decides fail-soft vs. throw).
 */
export function parseIsoTimestamptzKey(value: string): IsoTimestamptzKey | null {
  const m = ISO_TIMESTAMPTZ_RE.exec(value);
  if (!m) return null;
  const base = m[1]!;
  const fracStr = m[2];
  const zone = m[3]!;
  // Normalize `+0000` to `+00:00` (Date.parse accepts both; we don't
  // strictly need to, but it documents the intent).
  const normalizedZone = zone === '+0000' ? '+00:00' : zone;
  const ms = Date.parse(`${base}${normalizedZone}`);
  if (!Number.isFinite(ms)) return null;
  const epochSec = BigInt(Math.trunc(ms / 1000));
  let micros = 0;
  if (fracStr !== undefined) {
    // Right-pad / truncate to exactly 6 digits.
    const padded = (fracStr + '000000').slice(0, 6);
    const parsed = Number(padded);
    if (Number.isFinite(parsed)) micros = parsed;
  }
  return { epochSec, micros };
}

/**
 * Compare two timestamp wire strings by microsecond precision.
 * Returns < 0 if `a < b`, > 0 if `a > b`, 0 if equal.
 *
 * Unparseable inputs sort AFTER parseable ones (one-sided ordering
 * keeps `sort()` stable when fed garbage). Two unparseable inputs
 * compare as equal so the rest of the sort key takes over.
 */
export function compareIsoTimestamptz(a: string, b: string): number {
  const ka = parseIsoTimestamptzKey(a);
  const kb = parseIsoTimestamptzKey(b);
  if (ka === null && kb === null) return 0;
  if (ka === null) return 1;
  if (kb === null) return -1;
  if (ka.epochSec !== kb.epochSec) return ka.epochSec < kb.epochSec ? -1 : 1;
  return ka.micros - kb.micros;
}

/**
 * Returns the maximum of the supplied timestamp strings, preserving
 * the original string verbatim (microseconds intact). Null/undefined/
 * unparseable inputs are skipped. When all inputs are skip-worthy,
 * returns Unix epoch with millisecond-zero precision (matches the
 * sentinel used by the rest of the own-state recovery path).
 */
export function maxIsoTimestamptz(
  ...values: Array<string | null | undefined>
): string {
  let best: { s: string; key: IsoTimestamptzKey } | null = null;
  for (const v of values) {
    if (!v) continue;
    const key = parseIsoTimestamptzKey(v);
    if (key === null) continue;
    if (best === null) {
      best = { s: v, key };
      continue;
    }
    if (
      key.epochSec > best.key.epochSec ||
      (key.epochSec === best.key.epochSec && key.micros > best.key.micros)
    ) {
      best = { s: v, key };
    }
  }
  return best ? best.s : '1970-01-01T00:00:00.000Z';
}
