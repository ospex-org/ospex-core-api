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
 */

import { getSupabase } from './supabase.js';
import { formatError } from './logger.js';

/** PostgREST / Postgres codes for "that relation does not exist". */
const RELATION_MISSING_CODES = new Set(['PGRST205', '42P01']);

/** The view every contest-shaped read in this service goes through. */
export const CONTESTS_VIEW = 'contests_effective';

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

/**
 * One HEAD-style round trip against `contests_effective`.
 *
 * - success                    → connected, view present
 * - relation-missing response  → connected (the round trip happened), view ABSENT
 * - any other PostgREST error  → not connected
 * - throw / network failure    → not connected
 */
export async function checkDependencies(): Promise<DependencyReadiness> {
  try {
    const sb = getSupabase();
    const { error } = await sb
      .from(CONTESTS_VIEW)
      .select('contest_id', { head: true, count: 'exact' })
      .limit(0);

    if (!error) {
      return { supabase: { connected: true }, contestsView: { present: true } };
    }

    if (RELATION_MISSING_CODES.has(error.code)) {
      return {
        supabase: { connected: true },
        contestsView: {
          present: false,
          error:
            `relation "${CONTESTS_VIEW}" not found (${error.code}). ` +
            'Every contest-shaped read depends on it; apply the indexer migration that creates it.',
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
