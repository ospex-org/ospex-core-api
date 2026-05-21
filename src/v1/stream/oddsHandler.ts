/**
 * GET /v1/stream/odds?contestId=&market= — the odds SSE connect handler.
 *
 * Odds is latest-state, not a durable log, so this is a simpler model than the
 * protocol stream (no cursor, no catch-up replay):
 *
 *   1. Resolve contestId → jsonodds_id (server-side; the provider id never
 *      reaches the client). Unknown contest → 404 before the stream opens.
 *   2. Open the stream and send one `snapshot` event — the current per-market
 *      odds (or `null` if the writer hasn't populated it).
 *   3. Go live: forward `change` / `refresh` deltas from the shared OddsHub
 *      (one internal Realtime channel for the whole process).
 *
 * Snapshot/live ordering: the handler subscribes to the hub BEFORE running the
 * snapshot query and buffers any live delta that arrives during it, then
 * flushes after the snapshot — so a delta can't be lost in the gap, and
 * `snapshot` is always the first event a client sees.
 *
 * Convergence is by a monotonic `poll_captured_at` watermark (the writer
 * advances it on every poll, change or not): the handler emits a delta only
 * when its `pollCapturedAt` is strictly newer than the last emitted one for
 * this (contestId, market). That makes the stream immune to the snapshot/live
 * race (a buffered delta older than the snapshot is dropped) and to duplicate
 * or out-of-order Realtime delivery.
 *
 * Degradation: if the internal source drops, the hub broadcasts — the handler
 * emits `degraded` and keeps the connection open; on recovery the hub triggers
 * a re-snapshot, which fully resyncs (latest-state) and resumes live.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { getSupabase } from '../../lib/supabase.js';
import type { ApiError } from '../../middleware/errorHandler.js';
import {
  fetchMarketSnapshot,
  isOddsMarket,
  resolveContestJsonoddsId,
  type MarketOdds,
  type OddsMarket,
} from '../utils/odds.js';
import { acquire, release } from './connections.js';
import { getOddsHub, type OddsSubscriber } from './oddsHub.js';
import { initSse, writeComment, writeEvent } from './sse.js';

const HEARTBEAT_MS = 20_000;
// Outbound buffer ceiling: a client that isn't draining gets shed (reconnects).
const MAX_PENDING_BYTES = 1_000_000;

type LiveKind = 'change' | 'refresh';

export async function getOddsStreamHandler(req: Request, res: Response): Promise<void> {
  const contestId = String(req.query.contestId ?? '');
  if (!/^\d+$/.test(contestId)) {
    res.status(400).json({ error: 'contestId is required and must be a numeric string.', code: 'INVALID_PARAM' } satisfies ApiError);
    return;
  }
  const marketRaw = String(req.query.market ?? '');
  if (!isOddsMarket(marketRaw)) {
    res.status(400).json({ error: 'market is required and must be one of: moneyline, spread, total.', code: 'INVALID_PARAM' } satisfies ApiError);
    return;
  }
  const market: OddsMarket = marketRaw;

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

  // A slot is held from here — attach cleanup early so a disconnect during the
  // pre-stream resolve still releases it (and unsubscribes if we got that far).
  let sub: OddsSubscriber | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (sub) getOddsHub().unsubscribe(sub);
    release(ip);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);

  const sb = getSupabase();
  const net = loadConfig().network;

  let jsonoddsId: string | null;
  try {
    const linkage = await resolveContestJsonoddsId(sb, net, contestId);
    if (closed) return;
    if (!linkage.found) {
      res.status(404).json({ error: `Contest not found: ${contestId}`, code: 'NOT_FOUND' } satisfies ApiError);
      cleanup();
      return;
    }
    jsonoddsId = linkage.jsonoddsId;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), contestId }, 'odds stream: contest resolve failed');
    if (!res.headersSent) res.status(500).json({ error: 'Failed to resolve contest.', code: 'INTERNAL_ERROR' } satisfies ApiError);
    cleanup();
    return;
  }

  // ── Open the stream ──────────────────────────────────────────────────────
  initSse(res);
  writeComment(res, 'connected');
  heartbeat = setInterval(() => writeComment(res, 'hb'), HEARTBEAT_MS);
  heartbeat.unref?.();

  // No upstream linkage: there's nothing to stream. Send an empty snapshot so
  // the client has a definitive "no odds for this contest" answer, then idle
  // (heartbeats only). We resolved jsonoddsId once at connect, so we couldn't
  // observe a later linkage anyway — a reconnect picks one up.
  if (jsonoddsId === null || jsonoddsId === '') {
    writeEvent(res, 'snapshot', { contestId, market, odds: null });
    return;
  }
  const jid: string = jsonoddsId;

  // ── snapshot-first state machine ──────────────────────────────────────────
  let phase: 'snapshotting' | 'live' = 'snapshotting';
  const pending: Array<{ kind: LiveKind; odds: MarketOdds }> = [];
  let lastPollMs: number | undefined;
  let snapshotInFlight = false;
  let needsResnapshot = false;

  const shedIfSlow = (): void => {
    const len = (res as { writableLength?: number }).writableLength;
    if (!res.writableEnded && typeof len === 'number' && len > MAX_PENDING_BYTES) {
      logger.warn({ contestId, market, pending: len }, 'odds stream: shedding slow client (backpressure)');
      res.end(); // → 'close' → cleanup; client reconnects + re-snapshots
    }
  };

  // Emit a live delta iff it's strictly newer (by poll_captured_at) than the
  // last thing we emitted — the convergence + dedup guard.
  const emitLive = (kind: LiveKind, odds: MarketOdds): void => {
    const ms = Date.parse(odds.pollCapturedAt);
    if (Number.isFinite(ms)) {
      if (lastPollMs !== undefined && ms <= lastPollMs) return; // stale / duplicate
      lastPollMs = ms;
    }
    writeEvent(res, kind, { contestId, market, odds });
    shedIfSlow();
  };

  // Go live and drain anything buffered during the snapshot query. Synchronous
  // (no await), so no live delta can interleave between phase flip and flush.
  const goLiveAndFlush = (): void => {
    phase = 'live';
    const buffered = pending.splice(0, pending.length);
    for (const ev of buffered) emitLive(ev.kind, ev.odds);
  };

  const runSnapshot = async (): Promise<void> => {
    if (snapshotInFlight) {
      needsResnapshot = true; // fold concurrent resnapshot requests into the in-flight one
      return;
    }
    snapshotInFlight = true;
    try {
      do {
        needsResnapshot = false;
        phase = 'snapshotting'; // buffer live deltas while the query is in flight
        let odds: MarketOdds | null = null;
        let ok = true;
        try {
          odds = await fetchMarketSnapshot(sb, net, jid, market);
        } catch (err) {
          ok = false;
          logger.error({ err: err instanceof Error ? err.message : String(err), contestId, market }, 'odds stream: snapshot query failed');
          if (!closed) writeEvent(res, 'degraded', { reason: 'snapshot_failed' });
        }
        if (closed) return;
        if (ok) {
          // Reset the watermark to the snapshot (it's the authoritative current
          // state). On a failed read we keep the prior watermark, if any.
          const ms = odds ? Date.parse(odds.pollCapturedAt) : NaN;
          lastPollMs = Number.isFinite(ms) ? ms : undefined;
          writeEvent(res, 'snapshot', { contestId, market, odds: odds ?? null });
          shedIfSlow();
        }
        // Always go live — even on a failed snapshot — so deltas keep flowing
        // (a later change or a resnapshot rebuilds state) instead of buffering
        // forever in 'snapshotting'.
        goLiveAndFlush();
      } while (needsResnapshot && !closed);

      // Surface a degradation that's still in effect (e.g. connected mid-outage,
      // or the source dropped during the query). By here goLiveAndFlush has run,
      // so we're live; if we just resynced on recovery, isDegraded() is false
      // and we stay quiet.
      if (!closed && getOddsHub().isDegraded()) {
        writeEvent(res, 'degraded', { reason: 'degraded' });
      }
    } finally {
      snapshotInFlight = false;
    }
  };

  // Subscribe BEFORE the first snapshot so live deltas during the query buffer.
  sub = getOddsHub().subscribe(jid, market, {
    onChange: (odds) => {
      if (phase === 'live') emitLive('change', odds);
      else pending.push({ kind: 'change', odds });
    },
    onRefresh: (odds) => {
      if (phase === 'live') emitLive('refresh', odds);
      else pending.push({ kind: 'refresh', odds });
    },
    onDegraded: (reason) => {
      // While snapshotting, the post-snapshot isDegraded() check covers it.
      if (phase === 'live' && !closed) writeEvent(res, 'degraded', { reason });
    },
    onResnapshot: () => {
      void runSnapshot();
    },
  });

  try {
    await runSnapshot();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), contestId, market }, 'odds stream: initial snapshot failed');
    if (!closed) writeEvent(res, 'degraded', { reason: 'internal_error' });
  }
}
