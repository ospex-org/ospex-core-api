/**
 * The benchmark serving projection's read layer: relation names, the
 * schema-drift classification, and bounded paging.
 *
 * Everything the three `/v1/benchmark/*` endpoints touch goes through here, for
 * the reason `src/lib/tables.ts` gives about `contests_effective`: a name
 * asserted in more than one place drifts, and the drift is silent. These
 * relations live in the protocol indexer's schema and are created by migrations
 * 073–079, so they can be absent while Postgres itself is perfectly healthy —
 * a deploy-order hazard this service must report as a 503 on the affected
 * endpoint rather than as a 500.
 *
 * ## What must NOT happen: benchmark relations in `/readyz`
 *
 * `src/lib/readiness.ts` deliberately probes only `contests_effective`, and
 * nothing here is added to it. `/readyz` gates the whole dyno; the benchmark
 * projection is a secondary public surface, and letting an unapplied benchmark
 * migration mark the service unready would take the contest and commitment
 * paths down with it. The endpoints report their own unavailability instead.
 */

import type { PostgrestError } from '@supabase/supabase-js';
import { logger } from '../../lib/logger.js';
import type { ApiError } from '../../middleware/errorHandler.js';
import type { Response } from 'express';

/**
 * Relation names, asserted once.
 *
 * Tests assert the LITERAL strings rather than importing these, so they act as
 * an independent oracle — the same discipline `src/lib/tables.ts` documents.
 */
export const BENCHMARK = {
  runs: 'benchmark_runs',
  participants: 'benchmark_participants',
  cohortParticipants: 'benchmark_cohort_participants',
  cohortWallets: 'benchmark_cohort_wallets',
  armAttempts: 'benchmark_arm_attempts',
  decisions: 'benchmark_decisions',
  reveals: 'benchmark_decision_reveals',
  scores: 'benchmark_scores',
  scoringRuns: 'benchmark_scoring_runs',
  executionFills: 'benchmark_execution_fills',
  siteStats: 'benchmark_site_stats',
  capability: 'benchmark_schema_capability',
} as const;

/**
 * The reveal embed MUST name its foreign key.
 *
 * `benchmark_decisions` and `benchmark_decision_reveals` are joined by TWO
 * constraints — `fk_benchmark_reveal_decision` on `(id)` and
 * `fk_benchmark_reveal_seal` on `(id, sealed_at)`, the second being what binds
 * a reveal to the instant its decision was sealed. PostgREST refuses an
 * ambiguous embed with `PGRST201` and a 300, so an unqualified
 * `benchmark_decision_reveals(...)` is a hard failure on every request, not a
 * subtle one. Measured against production 2026-08-24.
 *
 * `fk_benchmark_reveal_decision` is the right one to name: it is the plain
 * one-to-one on the decision's primary key. Embedding through the seal FK would
 * additionally require `sealed_at` to match, which is true today and is not the
 * relationship being expressed.
 */
export const REVEAL_EMBED = 'benchmark_decision_reveals!fk_benchmark_reveal_decision';

/** PostgREST / Postgres codes for "that relation does not exist". */
const RELATION_MISSING_CODES = new Set(['PGRST205', '42P01']);
/** "that column does not exist" — the relation answered but predates a migration. */
const COLUMN_MISSING_CODES = new Set(['42703']);
/** "could not embed" — an FK the read path names is absent or ambiguous. */
const EMBED_FAILED_CODES = new Set(['PGRST200', 'PGRST201']);

export type SchemaFault = 'relation-missing' | 'column-missing' | 'embed-failed';

/**
 * Is this error the schema-drift signature, or a real fault?
 *
 * The three codes are separated because they say different things to an
 * operator: the relation is absent (migration not applied), the relation is
 * older than this service expects (partially applied / rolled back), or a
 * foreign key the embed names is gone (a migration changed the join). All three
 * are "apply the migration", none of them is "the database is broken", and none
 * of them should read as a bug in this service.
 */
export function classifySchemaFault(error: PostgrestError): SchemaFault | null {
  if (RELATION_MISSING_CODES.has(error.code)) return 'relation-missing';
  if (COLUMN_MISSING_CODES.has(error.code)) return 'column-missing';
  if (EMBED_FAILED_CODES.has(error.code)) return 'embed-failed';
  return null;
}

const FAULT_HINT: Record<SchemaFault, string> = {
  'relation-missing': 'The benchmark serving tables are absent',
  'column-missing': 'A benchmark serving relation predates a migration this service requires',
  'embed-failed': 'A benchmark foreign key this read path joins on is absent or ambiguous',
};

/**
 * Answer a query failure.
 *
 * Schema drift is a 503 on THIS endpoint — the projection is not ready, the
 * service is. Anything else is a 500, logged with the PostgREST code so the
 * cause is recoverable from Papertrail rather than from a reproduction.
 */
export function respondToQueryError(
  res: Response,
  error: PostgrestError,
  context: string,
): void {
  const fault = classifySchemaFault(error);
  if (fault !== null) {
    logger.warn(
      { err: error.message, code: error.code, fault, context },
      'benchmark: serving projection not ready',
    );
    res.status(503).json({
      error:
        `${FAULT_HINT[fault]} (${error.code}). ` +
        'Apply the indexer migrations that create the benchmark serving projection (073-079).',
      code: 'NOT_READY',
    } satisfies ApiError);
    return;
  }
  logger.error({ err: error.message, code: error.code, context }, 'benchmark: query failed');
  res.status(500).json({
    error: 'Failed to read the benchmark projection.',
    code: 'INTERNAL_ERROR',
  } satisfies ApiError);
}

/** PostgREST's own per-request row ceiling. Asking for more silently gets 1000. */
export const POSTGREST_PAGE = 1000;

/** Thrown when a paged read would exceed its bound. Never truncates — see below. */
export class ProjectionTooLargeError extends Error {
  constructor(
    readonly relation: string,
    readonly cap: number,
  ) {
    super(`${relation} exceeded the ${cap}-row read bound`);
    this.name = 'ProjectionTooLargeError';
  }
}

export interface KeysetPage<Row> {
  data: Row[] | null;
  error: PostgrestError | null;
}

/**
 * Read every row of an append-only relation by KEYSET, in ascending key order.
 *
 * Offset paging is wrong here even though each read is one-shot. PostgREST caps
 * a request at 1000 rows, so anything larger is several round trips, and these
 * relations are append-only under a publisher that can insert between two of
 * them: with `range(offset, ...)` a row inserted mid-scan shifts every later
 * page and the scan silently skips one. A keyset cursor is a VALUE rather than
 * a position, so it cannot.
 *
 * The ordering is not only for paging. `mean()` in the ported scorer arithmetic
 * sums in array order and float addition is not associative — measured, 1.65%
 * of random 3-42 element CLV vectors give a different `round4` under a
 * different summation order. `order=<key>.asc` is therefore part of the
 * published contract, not an implementation detail, and on `benchmark_scores`
 * it reproduces the order the scored artifact was written in.
 *
 * **The cap raises rather than truncates.** An aggregate over an arbitrary
 * prefix of the population is a wrong number wearing a right number's clothes:
 * the caller cannot tell it from the real one, it bites unevenly across
 * participants (whoever sorts last loses the most), and it would be published
 * on a page whose whole purpose is to report measured results. A 503 is
 * legible; a quietly short mean is not. Bounding by a NAMED window — the last N
 * cohort-days, echoed in the payload — is the supported way to keep the read
 * small; this cap is the backstop behind it.
 */
export async function readAllByKeyset<Row, Key extends string | number>(
  relation: string,
  cap: number,
  keyOf: (row: Row) => Key,
  page: (after: Key | null, limit: number) => PromiseLike<KeysetPage<Row>>,
): Promise<{ rows: Row[]; error: PostgrestError | null }> {
  const rows: Row[] = [];
  let after: Key | null = null;
  for (;;) {
     
    const { data, error } = await page(after, POSTGREST_PAGE);
    if (error) return { rows, error };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < POSTGREST_PAGE) return { rows, error: null };
    if (rows.length >= cap) throw new ProjectionTooLargeError(relation, cap);
    const last = batch[batch.length - 1];
    if (last === undefined) throw new Error(`${relation}: full page with no last row`);
    const next = keyOf(last);
    // A full page whose cursor did not advance loops forever. It cannot happen
    // with a unique, strictly-increasing key and a matching `order` — which is
    // exactly why this helper requires both. The guard makes "cannot happen"
    // enforced rather than assumed.
    if (after !== null && next <= after) {
      throw new Error(`${relation}: keyset cursor did not advance past ${String(after)}`);
    }
    after = next;
  }
}

/**
 * Chunk a list of ids for `.in(...)` filters.
 *
 * PostgREST puts the whole list in the query string and both the client and any
 * proxy in front of it bound a URL. `games` lookups here can carry ~2,700
 * distinct game ids at a 180-day window, which is far past any safe single URL.
 */
export function chunkIds<T>(ids: readonly T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
