/**
 * GET /v1/stream/:resource — the SSE connect handler.
 *
 * The connect→catch-up→live handoff is an explicit two-phase state machine:
 *
 *   phase = 'catchup'  (from subscribe until catch-up resolves)
 *   phase = 'live'     (clean handoff: `ready` emitted, deltas stream)
 *
 * Conservative barrier: the client subscribes to the hub BEFORE catch-up (so a
 * live delta can't slip through the global dedupe), but during catch-up ANY
 * live delta or resync sets `aborted` and is NOT merged into the stream —
 * because the now()-based watermark can't tell us whether a buffered live row
 * is newer or older than a catch-up row for the same key, merging risks a
 * stale-at-`ready` state. Instead, an aborted handoff emits one `resync` and
 * ends the connection, forcing the client through snapshot → reconnect. A
 * clean handoff (no live activity, catch-up complete) emits `ready` and goes
 * live. Invariants this guarantees:
 *   - `ready` is emitted iff catch-up completed AND no live delta/resync raced
 *     it, so at `ready` the client's state == the DB state catch-up observed;
 *   - no `resync` path can be followed by `ready` on the same connection.
 *
 * Cursor source: `Last-Event-ID` header (native EventSource auto-reconnect)
 * wins over a possibly-stale `?cursor=`. The cursor is OPAQUE — clients store
 * the last `id` to resume and never decode it. Live deltas are NOT ordered by
 * cursor (last-received-wins per natural key). Heartbeat comments keep the
 * connection under the platform idle timeout.
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
// Outbound buffer ceiling: a client that isn't draining gets shed (forced to reconnect).
const MAX_PENDING_BYTES = 1_000_000;

type CatchupStatus = 'complete' | 'resync';
type Phase = 'catchup' | 'live';

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

  // Resume cursor: the Last-Event-ID header wins. A native EventSource reconnect
  // reuses the original request URL (so its `?cursor=` is stale) but sends
  // Last-Event-ID = the last `id:` we emitted, the true resume point. `?cursor=`
  // is the fallback for first connect / the fetch-based SDK transport.
  const cursorRaw = req.header('Last-Event-ID') ?? (req.query.cursor !== undefined ? String(req.query.cursor) : undefined);
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

  // Subscribe BEFORE catch-up so a live delta can't slip past the hub's global
  // dedupe. During catch-up we don't merge live events — we abort to `resync`.
  let phase: Phase = 'catchup';
  let aborted = false;
  const sub = getStreamHub().subscribe(name, filters, {
    onDelta: (body, cursorId) => {
      if (phase === 'live') {
        writeEvent(res, 'delta', body, cursorId);
        shedIfSlow();
      } else {
        aborted = true; // live delta raced catch-up → can't safely order → resync
      }
    },
    onResync: (reason) => {
      if (phase === 'live') writeEvent(res, 'resync', { reason });
      else aborted = true; // resync during catch-up → latch; never `ready` after
    },
  });

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    getStreamHub().unsubscribe(sub);
    release(ip);
  };
  const heartbeat = setInterval(() => writeComment(res, 'hb'), HEARTBEAT_MS);
  heartbeat.unref?.();
  res.on('close', cleanup);
  res.on('error', cleanup);

  void (async () => {
    try {
      const status: CatchupStatus = cursor
        ? await runCatchUp(res, resource, filters, cursor, () => closed, shedIfSlow)
        : 'complete';
      if (closed) return;

      if (aborted || status === 'resync') {
        // runCatchUp already emitted a resync on its own failure/backlog; only
        // emit one here when the abort came from a raced live delta/resync.
        if (status !== 'resync') writeEvent(res, 'resync', { reason: 'handoff_raced' });
        res.end(); // force the client through snapshot → reconnect
        return;
      }

      // Clean handoff: nothing raced catch-up and it completed. Going live and
      // emitting `ready` is now honest — the client is at catch-up's DB state.
      phase = 'live';
      writeEvent(res, 'ready', { resource: name });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), resource: name }, 'stream: catch-up/handoff failed');
      writeEvent(res, 'resync', { reason: 'internal_error' });
      res.end();
    }
  })();
}

/**
 * Replay missed deltas from `cursor`. First page is overlap-aware (a `live`
 * cursor re-scans `cursor.ts − overlap`); subsequent pages are strict keyset,
 * so it terminates. Returns `'resync'` (and emits a resync event) on query
 * failure or when the backlog exceeds the page budget. Otherwise `'complete'`.
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
