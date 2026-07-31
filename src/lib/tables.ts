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
 * `effective_start_time = LEAST(contests.start_time, games.match_time,
 * games.earliest_match_time)` and the raw `game_match_time` alongside
 * `contests.*`.
 *
 * THREE inputs, not two. The third is the game's MONOTONE FLOOR — the
 * earliest start the game was ever recorded with, which no schedule write can
 * raise. Without it the bound is not monotone: `games.match_time` moves in
 * both directions, so a feed rollback would lift `effective_start_time` back
 * up and reopen a gate that had already closed.
 *
 * Every contest-shaped read in this service goes through it. It is created by
 * a migration in the protocol indexer's schema, so it can be absent while
 * Postgres itself is perfectly healthy — which is why `/readyz` probes it as
 * a term of its own.
 */
export const CONTESTS_VIEW = 'contests_effective';
