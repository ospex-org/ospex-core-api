/**
 * GET /v1/stream/:resource — the SSE connect handler.
 *
 * Lifecycle:
 *   1. Validate resource + filters + optional `?cursor=`; enforce the
 *      concurrent-connection cap (429 when full).
 *   2. Open the SSE response.
 *   3. Subscribe to the shared poller BEFORE catch-up, buffering live deltas —
 *      this closes the gap between catch-up's last read and going live.
 *   4. Catch up: replay missed deltas from the cursor (overlap-aware for a
 *      `live` cursor; strict keyset paging thereafter).
 *   5. Flush the buffer (client dedupes any overlap by event cursor), emit
 *      `ready`, then stream live.
 *   6. On disconnect: unsubscribe, clear the heartbeat, release the cap slot.
 *
 * Events: `delta` (id = opaque live cursor), `resync` (re-snapshot), `ready`
 * (catch-up complete, now live). Heartbeat comments keep the connection under
 * the platform idle timeout.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { getSupabase } from '../../lib/supabase.js';
import {
  CursorError,
  cursorFromRow,
  decodeCursor,
  keysetOrExpr,
  type StreamCursor,
} from '../../lib/cursor.js';
import { recoveryKeysetExpr } from '../../lib/recovery.js';
import type { ApiError } from '../../middleware/errorHandler.js';
import { acquire, release } from './connections.js';
import { getStreamHub } from './hub.js';
import { initSse, writeComment, writeEvent } from './sse.js';
import {
  STREAM_RESOURCES,
  isStreamResource,
  type StreamFilters,
  type StreamResource,
  type StreamRow,
} from './resources.js';

const HEARTBEAT_MS = 20_000;
const CATCHUP_PAGE = 500;
const CATCHUP_MAX_PAGES = 50;

export function getStreamHandler(req: Request, res: Response): void {
  const name = String(req.params.resource ?? '');
  if (!isStreamResource(name)) {
    res.status(404).json({ error: `Unknown stream resource "${name}".`, code: 'NOT_FOUND' } satisfies ApiError);
    return;
  }
  const resource = STREAM_RESOURCES[name];

  const ip = req.ip ?? 'unknown';
  const slot = acquire(ip);
  if (!slot.ok) {
    res.status(429).json({
      error:
        slot.scope === 'ip'
          ? 'Too many concurrent streams from this client.'
          : 'Server stream capacity reached, try again shortly.',
      code: 'RATE_LIMIT_EXCEEDED',
    } satisfies ApiError);
    return;
  }

  // From here a slot is held — every early return must release it.
  const filters = resource.parseFilters(req);
  if ('errorBody' in filters) {
    release(ip);
    res.status(400).json(filters.errorBody);
    return;
  }

  let cursor: StreamCursor | null = null;
  if (req.query.cursor !== undefined) {
    try {
      cursor = decodeCursor(String(req.query.cursor), resource.cursorTable);
    } catch (err) {
      release(ip);
      res.status(400).json(err instanceof CursorError ? err.apiError : { error: 'Invalid cursor.', code: 'INVALID_CURSOR' });
      return;
    }
  }

  // ── Open the stream ──────────────────────────────────────────────────
  initSse(res);
  writeComment(res, 'connected');

  let liveMode = false;
  const buffer: Array<{ body: unknown; cursorId: string }> = [];
  const sub = getStreamHub().subscribe(name, filters, {
    onDelta: (body, cursorId) => {
      if (liveMode) writeEvent(res, 'delta', body, cursorId);
      else buffer.push({ body, cursorId });
    },
    onResync: (reason) => writeEvent(res, 'resync', { reason }),
  });

  const heartbeat = setInterval(() => writeComment(res, 'hb'), HEARTBEAT_MS);
  heartbeat.unref?.();

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    getStreamHub().unsubscribe(sub);
    release(ip);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);

  void (async () => {
    if (cursor) {
      await runCatchUp(res, resource, filters, cursor, () => closed);
    }
    if (closed) return;
    // Go live: flush whatever the poller buffered during catch-up, in order.
    liveMode = true;
    const buffered = buffer.splice(0);
    for (const d of buffered) writeEvent(res, 'delta', d.body, d.cursorId);
    writeEvent(res, 'ready', { resource: name });
  })();
}

/**
 * Replay missed deltas from `cursor`. First page is overlap-aware (a `live`
 * cursor re-scans `cursor.ts − overlap`); subsequent pages are strict keyset,
 * so it terminates. If the backlog exceeds the page budget, emit a `resync`
 * (re-snapshot) rather than streaming an unbounded history.
 */
async function runCatchUp(
  res: Response,
  resource: StreamResource,
  filters: StreamFilters,
  cursor: StreamCursor,
  isClosed: () => boolean,
): Promise<void> {
  const sb = getSupabase();
  const net = loadConfig().network;
  let orExpr = recoveryKeysetExpr(cursor);

  for (let page = 0; page < CATCHUP_MAX_PAGES; page += 1) {
    if (isClosed()) return;
    let q = sb.from(resource.table).select(resource.columns).eq('network', net);
    for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
    q = q
      .or(orExpr)
      .order('row_updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(CATCHUP_PAGE);

    const { data, error } = await q;
    if (error) {
      logger.error({ err: error.message, resource: resource.name }, 'stream catch-up: query failed');
      writeEvent(res, 'resync', { reason: 'catchup_failed' });
      return;
    }
    const rows = (data ?? []) as unknown as StreamRow[];
    for (const row of rows) {
      const body = resource.toBody(row);
      if (body !== null) {
        writeEvent(res, 'delta', body, cursorFromRow(resource.cursorTable, row, 'live'));
      }
    }
    if (rows.length < CATCHUP_PAGE) return; // caught up
    const last = rows[rows.length - 1];
    if (!last) return;
    orExpr = keysetOrExpr(last.row_updated_at, String(last.id)); // strict forward
  }

  // Backlog larger than the page budget — cheaper for the client to re-snapshot.
  writeEvent(res, 'resync', { reason: 'backlog_too_large' });
}
