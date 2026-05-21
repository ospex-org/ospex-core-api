/**
 * GET /v1/stream/:resource — the SSE connect handler.
 *
 * Lifecycle:
 *   1. Validate resource + filters + resume cursor (`?cursor=` or, for native
 *      EventSource auto-reconnect, the `Last-Event-ID` header); enforce the
 *      concurrent-connection cap (429 when full).
 *   2. Open the SSE response.
 *   3. Catch up: replay missed deltas from the cursor (overlap-aware for a
 *      `live` cursor; strict keyset paging thereafter).
 *   4. Attach to the shared poller for live deltas and emit `ready` (only when
 *      catch-up completed cleanly). Deltas committed during catch-up are caught
 *      by the poller's overlap re-scan (a fresh read), so no buffer is needed.
 *   5. On disconnect: unsubscribe, clear the heartbeat, release the cap slot.
 *
 * Events: `delta` (id = opaque live cursor), `resync` (re-snapshot), `ready`
 * (catch-up complete, now live). The cursor is OPAQUE — clients store the last
 * `id` to resume and never decode it. Deltas are NOT ordered by cursor (a
 * late-committed row can arrive after a newer one under the now()-based
 * watermark), so clients apply **last-received-wins** per natural key. Heartbeat
 * comments keep the connection under the platform idle timeout.
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
import { getStreamHub, type Subscriber } from './hub.js';
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
// Outbound buffer ceiling: a client that isn't draining gets shed (forced to reconnect).
const MAX_PENDING_BYTES = 1_000_000;

type CatchupStatus = 'complete' | 'resync';

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

  // Resume cursor: explicit ?cursor= wins; otherwise the Last-Event-ID header a
  // native EventSource auto-sends on reconnect (= the last `id:` we emitted).
  const cursorRaw =
    req.query.cursor !== undefined ? String(req.query.cursor) : (req.header('Last-Event-ID') ?? undefined);
  let cursor: StreamCursor | null = null;
  if (cursorRaw !== undefined && cursorRaw !== '') {
    try {
      cursor = decodeCursor(cursorRaw, resource.cursorTable);
    } catch (err) {
      release(ip);
      res.status(400).json(err instanceof CursorError ? err.apiError : { error: 'Invalid cursor.', code: 'INVALID_CURSOR' });
      return;
    }
  }

  // ── Open the stream ──────────────────────────────────────────────────
  initSse(res);
  writeComment(res, 'connected');

  const shedIfSlow = (): void => {
    const pending = (res as { writableLength?: number }).writableLength;
    if (!res.writableEnded && typeof pending === 'number' && pending > MAX_PENDING_BYTES) {
      logger.warn({ resource: name, pending }, 'stream: shedding slow client (backpressure)');
      res.end(); // → 'close' → cleanup; client reconnects + catches up
    }
  };

  let sub: Subscriber | undefined;
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (sub) getStreamHub().unsubscribe(sub);
    release(ip);
  };
  const heartbeat = setInterval(() => writeComment(res, 'hb'), HEARTBEAT_MS);
  heartbeat.unref?.();
  res.on('close', cleanup);
  res.on('error', cleanup);

  void (async () => {
    const status: CatchupStatus = cursor
      ? await runCatchUp(res, resource, filters, cursor, () => closed, shedIfSlow)
      : 'complete';
    if (closed) return;

    // Attach to live AFTER catch-up. Deltas committed during catch-up are
    // re-read by the poller's overlap re-scan (last-received-wins), so there's
    // no need to buffer them per-connection.
    sub = getStreamHub().subscribe(name, filters, {
      onDelta: (body, cursorId) => {
        writeEvent(res, 'delta', body, cursorId);
        shedIfSlow();
      },
      onResync: (reason) => writeEvent(res, 'resync', { reason }),
    });
    // Lost the race with a disconnect during catch-up/subscribe — don't leak.
    if (closed) {
      getStreamHub().unsubscribe(sub);
      return;
    }
    if (status === 'complete') writeEvent(res, 'ready', { resource: name });
  })();
}

/**
 * Replay missed deltas from `cursor`. First page is overlap-aware (a `live`
 * cursor re-scans `cursor.ts − overlap`); subsequent pages are strict keyset,
 * so it terminates. Returns `'resync'` (and emits a resync event) on query
 * failure or when the backlog exceeds the page budget — the caller then skips
 * `ready`. Otherwise `'complete'`.
 */
async function runCatchUp(
  res: Response,
  resource: StreamResource,
  filters: StreamFilters,
  cursor: StreamCursor,
  isClosed: () => boolean,
  shed: () => void,
): Promise<CatchupStatus> {
  const sb = getSupabase();
  const net = loadConfig().network;
  let orExpr = recoveryKeysetExpr(cursor);

  for (let page = 0; page < CATCHUP_MAX_PAGES; page += 1) {
    if (isClosed()) return 'complete';
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
      return 'resync';
    }
    const rows = (data ?? []) as unknown as StreamRow[];
    for (const row of rows) {
      const body = resource.toBody(row);
      if (body !== null) writeEvent(res, 'delta', body, cursorFromRow(resource.cursorTable, row, 'live'));
    }
    shed();
    if (rows.length < CATCHUP_PAGE) return 'complete'; // caught up
    const last = rows[rows.length - 1];
    if (!last) return 'complete';
    orExpr = keysetOrExpr(last.row_updated_at, String(last.id)); // strict forward
  }

  // Backlog larger than the page budget — cheaper for the client to re-snapshot.
  writeEvent(res, 'resync', { reason: 'backlog_too_large' });
  return 'resync';
}
