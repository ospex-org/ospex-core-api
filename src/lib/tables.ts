/**
 * Canonical names for the Supabase relations this service reads.
 *
 * Only relations whose name is asserted in more than one place live here. The
 * point is not tidiness — it is that a readiness probe naming a DIFFERENT
 * relation from the one the handlers query is a silent fail-open: the probe
 * checks a relation that still exists, `/readyz` answers 200, and every
 * contest read 500s. Holding one constant makes that drift impossible rather
 * than merely detectable.
 *
 * Tests deliberately assert the LITERAL string rather than importing these,
 * so they act as an independent oracle: renaming a constant turns the suite
 * red instead of silently moving the expectation with it.
 */

/**
 * `contests` LEFT JOIN `games` on `(network, jsonodds_id)`, projecting
 * `effective_start_time` — a bounded LEAST over `contests.start_time`,
 * `games.match_time`, `games.earliest_match_time`, and the two provider
 * start-time snapshots (`games.rundown_match_time` /
 * `games.sportspage_match_time`, each admitted only while within one hour
 * below `games.match_time`) — plus the raw `game_match_time`,
 * `game_earliest_match_time`, `game_rundown_match_time`, and
 * `game_sportspage_match_time` alongside `contests.*`.
 *
 * FIVE inputs, two of them guarded. The floor is the game's CURRENT RETAINED
 * SAFETY FLOOR — without it the bound is not stable: `games.match_time` moves
 * in both directions, so a feed rollback would lift `effective_start_time`
 * back up and reopen a gate that had already closed. The snapshots are DATED
 * OBSERVATIONS from the enrichment providers; the one-hour read-time guard is
 * what keeps a stale observation from wrong-closing the bound, and it
 * self-heals — a snapshot the feed later moves away from drops out of the min
 * on the next read.
 *
 * ⚠ STATE THE GUARANTEE AT ITS ACTUAL WIDTH. What the schema enforces is that
 * ORDINARY schedule writes cannot raise the floor (the trigger recomputes it
 * from the prior value on any write touching `match_time`). It is not an
 * absolute: an explicit floor-only operator remedy CAN raise it, an insert may
 * supply the initial floor, a delete-then-reinsert reseeds it, and exactly ONE
 * value is retained — it is not a history of every start this game was ever
 * scheduled at. Nothing served here should be read as proving when, why, or
 * from which source a start moved.
 *
 * Every contest-shaped read in this service goes through it. It is created by
 * a migration in the protocol indexer's schema, so it can be absent while
 * Postgres itself is perfectly healthy — which is why `/readyz` probes it as
 * a term of its own.
 */
export const CONTESTS_VIEW = 'contests_effective';
