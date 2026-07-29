/**
 * Readiness dependency probes for `/readyz`.
 *
 * Extracted from `server.ts` so the probe is importable — `server.ts` calls
 * `main()` at module scope and starts a listener, so anything living there is
 * unreachable from a test.
 *
 * The probe targets `contests_effective`, the view every contest-shaped read in
 * this service goes through, rather than the base `contests` table. That is
 * deliberate: the view is created by a migration in the protocol indexer's
 * schema, so it can be absent while Postgres itself is perfectly healthy. If
 * this service is deployed before that migration is applied, the dyno boots
 * fine and every contest query fails at the DB layer — a total outage of the
 * primary surface. Probing the base table would report the platform healthy
 * throughout.
 *
 * Connectivity and view-presence are reported as SEPARATE terms because they
 * are separate facts: a PostgREST "relation not found" response proves the
 * round trip succeeded, so the transport is connected AND the view is missing.
 * Readiness requires both.
 *
 * ## Why the probe is a GET, and why success needs positive proof
 *
 * Two transport behaviours make the obvious implementations fail OPEN — they
 * report the view present when it is absent, which is the exact state this
 * probe exists to detect. Both are properties of `@supabase/postgrest-js`, not
 * of this code, so neither is visible in a test that mocks the query builder
 * and hands it a fabricated error object.
 *
 * 1. NEVER probe with `{ head: true }`. That sends an HTTP HEAD, and a HEAD
 *    response carries no body by definition. postgrest-js parses the error
 *    body to build `error`; on an empty body the parse throws, and its catch
 *    rewrites a bodyless 404 to `status: 204` with `error: NULL`. A missing
 *    relation therefore arrives here indistinguishable from success. A GET to
 *    the same missing relation returns the real PostgREST JSON body
 *    (`{"code":"PGRST205",...}`), which parses, so `error.code` is set and the
 *    RELATION_MISSING_CODES branch below fires. `.limit(0)` keeps the GET
 *    row-less, and no `count` is requested — an exact count would make the
 *    probe scan the view.
 *
 * 2. A null `error` is NOT proof of success. The same bodyless-404 rewrite
 *    fires on a GET whenever something upstream of PostgREST answers 404 with
 *    no body (a proxy or router in front of the database, say). So success is
 *    asserted POSITIVELY: a healthy `.select(...).limit(0)` returns a rows
 *    ARRAY (`[]`). `error === null` with no array is the rewrite signature and
 *    is reported as NOT present — fail closed.
 *
 * ## Known residual: a 404 whose body is a JSON ARRAY still reads as healthy
 *
 * postgrest-js has a THIRD rewrite on the same non-ok path: a 404 whose body
 * parses as a JSON array is turned into `status: 200, statusText: "OK",
 * data: [], error: null`. That is byte-for-byte the success envelope, so no
 * check available to this function can tell the two apart — including the
 * rows-array check above, which that branch synthesises. PostgREST itself
 * never produces it (its errors are JSON objects: `{"code":"PGRST205",…}`),
 * so it is not reachable through a correctly-routed database; it is reachable
 * from the same class of actor as point 2, an intermediary answering 404 with
 * an array body. Detecting it would take a probe that reads the raw HTTP
 * status instead of the client envelope. Documented rather than defended,
 * and pinned by a characterization test so a library change is visible.
 */

import { getSupabase } from './supabase.js';
import { formatError } from './logger.js';
import { CONTESTS_VIEW } from './tables.js';

/** PostgREST / Postgres codes for "that relation does not exist". */
const RELATION_MISSING_CODES = new Set(['PGRST205', '42P01']);

export interface SupabaseReadiness {
  connected: boolean;
  error?: string;
}

export interface ContestsViewReadiness {
  present: boolean;
  error?: string;
}

export interface DependencyReadiness {
  supabase: SupabaseReadiness;
  contestsView: ContestsViewReadiness;
}

/**
 * The `/readyz` verdict. Every term must hold — in particular the view term,
 * without which the service reports healthy while its primary surface is a
 * total outage.
 */
export function isReady(
  deps: DependencyReadiness,
  commitments: { configured: boolean },
): boolean {
  return deps.supabase.connected && deps.contestsView.present && commitments.configured;
}

/** The advice appended to every "the view is not usable" verdict. */
const APPLY_MIGRATION_HINT =
  'Every contest-shaped read depends on it; apply the indexer migration that creates it.';

/**
 * One row-less GET round trip against `contests_effective`.
 *
 * Deliberately a GET and not a HEAD, and success is proved by the returned
 * rows array rather than by a null `error` — see the file header for the two
 * transport behaviours that make either shortcut fail open.
 *
 * - rows array returned        → connected, view present
 * - relation-missing response  → connected (the round trip happened), view ABSENT
 * - no error but no rows array → connected, view NOT PROVEN present (fail closed)
 * - any other PostgREST error  → not connected
 * - throw / network failure    → not connected
 *
 * One case is NOT covered — a 404 carrying a JSON-array body, which the client
 * rewrites into an exact copy of the success envelope. See the file header.
 */
export async function checkDependencies(): Promise<DependencyReadiness> {
  try {
    const sb = getSupabase();
    const { data, error, status } = await sb.from(CONTESTS_VIEW).select('contest_id').limit(0);

    // The ONLY success branch: a real rows array came back.
    if (!error && Array.isArray(data)) {
      return { supabase: { connected: true }, contestsView: { present: true } };
    }

    if (error && RELATION_MISSING_CODES.has(error.code)) {
      return {
        supabase: { connected: true },
        contestsView: {
          present: false,
          error: `relation "${CONTESTS_VIEW}" not found (${error.code}). ${APPLY_MIGRATION_HINT}`,
        },
      };
    }

    if (!error) {
      // No error AND no rows array. postgrest-js rewrites a body-less 404 to
      // `204 / error: null`, so this is what a missing relation looks like
      // when something other than PostgREST answered — it must NOT read as
      // healthy.
      return {
        supabase: { connected: true },
        contestsView: {
          present: false,
          error:
            `probe of "${CONTESTS_VIEW}" returned no rows array (HTTP ${status}). ` +
            `A body-less 404 reaches the client as 204 with no error. ${APPLY_MIGRATION_HINT}`,
        },
      };
    }

    return {
      supabase: { connected: false, error: error.message },
      contestsView: { present: false, error: error.message },
    };
  } catch (err) {
    const message = formatError(err);
    return {
      supabase: { connected: false, error: message },
      contestsView: { present: false, error: message },
    };
  }
}
