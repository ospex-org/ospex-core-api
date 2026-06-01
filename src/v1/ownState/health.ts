/**
 * Owner-auth own-state health probe — Phase 3 PR0b (amendment A4).
 *
 *   GET /v1/health/own-state
 *   → 200 { indexerLagSeconds, lastIndexedAt, lagSource }
 *
 * PUBLIC (no stream-auth). Indexer lag is a GLOBAL, wallet-independent
 * signal; the market-maker polls this at ~10s cadence to feed the spec §2.6
 * stream-health gate (`indexerLagSeconds < INDEXER_LAG_MAX`). Requiring a
 * minted bearer per poll would be pure overhead for a value that carries no
 * per-wallet information.
 *
 * Lag source — `sync_state.last_processed_at`, NOT `max(now -
 * row_updated_at)` over the own-state data tables (commitments / positions /
 * fills). The indexer advances `sync_state.last_processed_at` on EVERY
 * processed block (via `advance_sync_state`), including empty ones, so this
 * measures TRUE indexer liveness. A row-age approach over the data tables
 * would report false-high lag during any quiet, no-activity window — common
 * for a sparse P2P book — and spuriously trip the consumer's health gate
 * even when the indexer is perfectly current. This is a deliberate deviation
 * from the plan's literal `max(now - last_row_updated_at)` (§3.3); see the
 * PR description. `lagSource` reports `'sync_state'` accordingly.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { getSupabase } from '../../lib/supabase.js';
import type { ApiError } from '../../middleware/errorHandler.js';

export interface OwnStateHealthBody {
  /** Whole seconds since the indexer last advanced its processed-block watermark. */
  indexerLagSeconds: number;
  /** ISO-8601 of that watermark (`sync_state.last_processed_at`). */
  lastIndexedAt: string;
  /** The signal backing the lag measurement. */
  lagSource: 'sync_state';
}

export async function ownStateHealthHandler(_req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();

  const result = await sb
    .from('sync_state')
    .select('last_processed_at')
    .eq('network', config.network)
    .maybeSingle();

  if (result.error) {
    logger.error(
      { err: result.error.message },
      'ownState/health: sync_state query failed',
    );
    res.status(500).json({
      error: 'Failed to load indexer health.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }
  if (!result.data) {
    // No sync_state row for this network — the indexer has never recorded a
    // processed block. We can't assert lag, so report not-ready rather than a
    // fabricated zero; consumers treat any non-200 as unhealthy.
    res.status(503).json({
      error: 'Indexer sync state unavailable for this network.',
      code: 'INDEXER_SYNC_UNAVAILABLE',
    } satisfies ApiError);
    return;
  }

  const lastProcessedAtMs = Date.parse(String(result.data.last_processed_at));
  if (!Number.isFinite(lastProcessedAtMs)) {
    logger.error(
      { lastProcessedAt: result.data.last_processed_at },
      'ownState/health: unparseable sync_state.last_processed_at',
    );
    res.status(500).json({
      error: 'Failed to load indexer health.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }

  // Clamp to 0: clock skew between the API dyno and the DB can put
  // `last_processed_at` marginally in the future; a negative lag is
  // nonsensical and would read as "extremely fresh" while actually
  // signalling skew. 0 is the honest floor.
  const indexerLagSeconds = Math.max(
    0,
    Math.round((Date.now() - lastProcessedAtMs) / 1000),
  );
  const body: OwnStateHealthBody = {
    indexerLagSeconds,
    lastIndexedAt: new Date(lastProcessedAtMs).toISOString(),
    lagSource: 'sync_state',
  };
  res.status(200).json(body);
}
