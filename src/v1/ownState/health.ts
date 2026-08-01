/**
 * Own-state health probe.
 *
 *   GET /v1/health/own-state
 *   → 200 { indexerLagSeconds, lastIndexedAt, lagSource }
 *
 * PUBLIC (no stream-auth). Indexer lag is a GLOBAL, wallet-independent
 * signal; the market-maker polls it once per runner tick (its
 * `ownState.auditPollIntervalMs` — default 60s, floor 10s) to drive a
 * posting-only health latch. Requiring a minted bearer per poll would be pure
 * overhead for a value that carries no per-wallet information.
 *
 * Lag source — `indexer_cursor.updated_at`, NOT `max(now - row_updated_at)`
 * over the own-state data tables (commitments / positions / fills). The
 * indexer writes `indexer_cursor` after every successfully processed
 * block-range chunk, and it does so whether or not that chunk contained an
 * Ospex event. That last part is what makes `now - updated_at` a liveness
 * measure rather than a book-activity one: a row-age approach over the data
 * tables would report false-high lag during any quiet, no-activity window —
 * common for a sparse P2P book — and spuriously trip the consumer's health
 * gate even when the indexer is perfectly current.
 *
 * The cadence is NOT one write per fixed interval, and a consumer sizing a
 * threshold needs the three cases:
 *   - Caught up — newly finalized blocks normally fit in a single chunk
 *     (`BLOCK_RANGE_CHUNK`, default 2000), so this is usually ONE write per
 *     successful poll iteration. The loop then sleeps `POLL_INTERVAL_MS`,
 *     whose default AND enforced minimum are both 15000ms.
 *   - Behind — the chunk loop runs all the way to the finalized head BEFORE
 *     sleeping, so a catch-up pass writes the cursor many times in succession.
 *   - No newly finalized block — the loop sleeps and continues WITHOUT
 *     writing, so lag grows. That is correct: the indexer genuinely has
 *     nothing newer to report.
 *
 * CONSEQUENCE FOR CONSUMERS: in default caught-up operation the published
 * value sawtooths roughly 0 → ~15s. A threshold at or below that band can
 * therefore read as degraded on a healthy indexer, depending on where the
 * sample lands in the cycle — a sampling race, not a certainty. (An earlier
 * revision of this comment described the cursor as advancing on every
 * confirmed block, ~2s; live measurement on 2026-06-12 falsified that, and a
 * threshold sized against ~2s sits well inside the normal sawtooth.)
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
