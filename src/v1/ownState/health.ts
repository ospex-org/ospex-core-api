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
 * Lag source — `indexer_cursor.updated_at`, NOT `max(now - row_updated_at)`
 * over the own-state data tables (commitments / positions / fills). The
 * indexer advances `indexer_cursor` on EVERY confirmed block it processes —
 * Polygon mints a block every ~2s, so `updated_at` advances continuously
 * regardless of whether any Ospex event landed. That makes `now - updated_at`
 * a TRUE liveness/lag measure: a row-age approach over the data tables would
 * report false-high lag during any quiet, no-activity window — common for a
 * sparse P2P book — and spuriously trip the consumer's health gate even when
 * the indexer is perfectly current.
 *
 * (`indexer_cursor` is the table the live indexer actually maintains; the
 * `sync_state` table + `advance_sync_state` function exist in the schema but
 * are unpopulated in production — confirmed empty at deploy time. Sourcing
 * from `sync_state` returned `INDEXER_CURSOR_UNAVAILABLE` for every request.)
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { getSupabase } from '../../lib/supabase.js';
import type { ApiError } from '../../middleware/errorHandler.js';

export interface OwnStateHealthBody {
  /** Whole seconds since the indexer last advanced its confirmed-block cursor. */
  indexerLagSeconds: number;
  /** ISO-8601 of that cursor watermark (`indexer_cursor.updated_at`). */
  lastIndexedAt: string;
  /** The signal backing the lag measurement. */
  lagSource: 'indexer_cursor';
}

export async function ownStateHealthHandler(_req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const sb = getSupabase();

  const result = await sb
    .from('indexer_cursor')
    .select('updated_at')
    .eq('network', config.network)
    .maybeSingle();

  if (result.error) {
    logger.error(
      { err: result.error.message },
      'ownState/health: indexer_cursor query failed',
    );
    res.status(500).json({
      error: 'Failed to load indexer health.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }
  if (!result.data) {
    // No indexer_cursor row for this network — the indexer has never recorded
    // a confirmed block. We can't assert lag, so report not-ready rather than
    // a fabricated zero; consumers treat any non-200 as unhealthy.
    res.status(503).json({
      error: 'Indexer cursor unavailable for this network.',
      code: 'INDEXER_CURSOR_UNAVAILABLE',
    } satisfies ApiError);
    return;
  }

  const updatedAtMs = Date.parse(String(result.data.updated_at));
  if (!Number.isFinite(updatedAtMs)) {
    logger.error(
      { updatedAt: result.data.updated_at },
      'ownState/health: unparseable indexer_cursor.updated_at',
    );
    res.status(500).json({
      error: 'Failed to load indexer health.',
      code: 'INTERNAL_ERROR',
    } satisfies ApiError);
    return;
  }

  // Clamp to 0: clock skew between the API dyno and the DB can put
  // `updated_at` marginally in the future; a negative lag is nonsensical and
  // would read as "extremely fresh" while actually signalling skew. 0 is the
  // honest floor.
  const indexerLagSeconds = Math.max(
    0,
    Math.round((Date.now() - updatedAtMs) / 1000),
  );
  const body: OwnStateHealthBody = {
    indexerLagSeconds,
    lastIndexedAt: new Date(updatedAtMs).toISOString(),
    lagSource: 'indexer_cursor',
  };
  res.status(200).json(body);
}
