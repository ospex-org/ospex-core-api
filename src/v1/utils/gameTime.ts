/**
 * Game start-time derivation, shared by every read path that serves one.
 *
 * `effectiveMatchTime` is the bounded minimum `/v1/games` has served since the
 * start-time move-up remediation, and the benchmark picks endpoint has to serve
 * the SAME value: two sections of one page printing two different starts for
 * one game - with the earlier one correct - is exactly the confusion the
 * remediation exists to remove.
 *
 * Extracted verbatim from `v1/games.ts` when the second consumer arrived,
 * rather than copied. The RFC3339 grammar below is deliberately duplicated from
 * the protocol's off-chain writer (separate deployables, no shared package),
 * but duplicating it a second time INSIDE this service would be drift with no
 * excuse.
 */

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
export const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

export function parseTimestampMicros(iso: string): bigint | null {
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
export const SNAPSHOT_FRESHNESS_MICROS = 3_600_000_000n;

export function effectiveMatchTime(
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
