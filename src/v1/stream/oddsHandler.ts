/**
 * GET /v1/stream/odds?contestId=&market= — the odds SSE connect handler.
 *
 * Odds is latest-state, not a durable log, so this is a simpler model than the
 * protocol stream (no cursor, no catch-up replay). The contract:
 *
 *   - `snapshot {contestId, market, odds}` — the current per-market odds (or
 *     `null`). Sent only once the internal live source is confirmed active
 *     (`onActive` ⇒ Realtime SUBSCRIBED), and re-sent after a reconnect. The
 *     client is live with this baseline. ALWAYS the first data the client acts
 *     on — we never emit a delta before a snapshot.
 *   - `change` / `refresh {contestId, market, odds}` — live deltas, classified
 *     server-side; only after a snapshot.
 *   - `degraded {reason}` — the live source is behind/unavailable; updates are
 *     paused. May arrive before any snapshot (source down at connect → the
 *     client gets no baseline until recovery) or after (source dropped). On
 *     recovery a fresh `snapshot` resyncs (latest-state).
 *
 * Why snapshot-on-`onActive` and not eagerly: Realtime only delivers changes
 * that occur after SUBSCRIBED, and that handshake is async. Snapshotting before
 * the channel is live could miss an update committed in between (in neither the
 * snapshot nor a delta). So the hub signals readiness and the snapshot is taken
 * then; live deltas that arrive while the snapshot query is in flight are
 * buffered (coalesced) and flushed after.
 *
 * Convergence/dedup is a monotonic `poll_captured_at` watermark (the writer
 * advances it every poll): a delta is emitted only when strictly newer than the
 * last emitted for this (contestId, market). The buffer holds at most one
 * (coalesced latest) delta — odds is latest-state and single-market, so an
 * older buffered delta is always superseded — keeping per-connection memory
 * bounded even if a snapshot read stalls during active updates.
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
// Backoff between baseline-snapshot retries after a query failure.
const SNAPSHOT_RETRY_MS = 2_000;

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
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (retryTimer) clearTimeout(retryTimer);
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

  // ── state ─────────────────────────────────────────────────────────────────
  let live = false; // a baseline snapshot has been sent
  let snapshotInFlight = false;
  let needsResnapshot = false;
  let clientDegraded = false; // we've told the client it's behind (deduped)
  let pendingDelta: { kind: LiveKind; odds: MarketOdds } | undefined; // coalesced buffer (≤1)
  let lastPollMs: number | undefined; // watermark

  const shedIfSlow = (): void => {
    const len = (res as { writableLength?: number }).writableLength;
    if (!res.writableEnded && typeof len === 'number' && len > MAX_PENDING_BYTES) {
      logger.warn({ contestId, market, pending: len }, 'odds stream: shedding slow client (backpressure)');
      res.end(); // → 'close' → cleanup; client reconnects + re-snapshots
    }
  };

  const markDegraded = (reason: string): void => {
    if (clientDegraded || closed) return; // deduped: one degraded per outage
    clientDegraded = true;
    writeEvent(res, 'degraded', { reason });
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

  // Coalesce into the single buffer slot: keep the newest odds; the kind is a
  // change if any coalesced delta was a change (a real move since the baseline).
  const bufferDelta = (kind: LiveKind, odds: MarketOdds): void => {
    const prev = pendingDelta;
    if (prev === undefined) {
      pendingDelta = { kind, odds };
      return;
    }
    const newer = Date.parse(odds.pollCapturedAt) >= Date.parse(prev.odds.pollCapturedAt) ? odds : prev.odds;
    const mergedKind: LiveKind = kind === 'change' || prev.kind === 'change' ? 'change' : 'refresh';
    pendingDelta = { kind: mergedKind, odds: newer };
  };

  // Live deltas emit only once a baseline exists and no snapshot is mid-flight;
  // otherwise they coalesce into the buffer and flush after the next snapshot.
  const deliver = (kind: LiveKind, odds: MarketOdds): void => {
    if (live && !snapshotInFlight) emitLive(kind, odds);
    else bufferDelta(kind, odds);
  };

  const flushPending = (): void => {
    const d = pendingDelta;
    pendingDelta = undefined;
    if (d) emitLive(d.kind, d.odds);
  };

  const scheduleRetry = (): void => {
    if (closed || retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void runSnapshot();
    }, SNAPSHOT_RETRY_MS);
    retryTimer.unref?.();
  };

  // Take (or refresh) the baseline. Only runs when the live source is active —
  // if it's degraded we wait for onActive (recovery), so we never publish a
  // baseline the stream can't keep current.
  const runSnapshot = async (): Promise<void> => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (snapshotInFlight) {
      needsResnapshot = true; // fold concurrent requests into the in-flight one
      return;
    }
    if (getOddsHub().isDegraded()) return; // source down — onActive will retrigger

    snapshotInFlight = true;
    let ok = true;
    try {
      do {
        needsResnapshot = false;
        ok = true;
        let odds: MarketOdds | null = null;
        try {
          odds = await fetchMarketSnapshot(sb, net, jid, market);
        } catch (err) {
          ok = false;
          logger.error({ err: err instanceof Error ? err.message : String(err), contestId, market }, 'odds stream: snapshot query failed');
        }
        if (closed) return;
        if (ok) {
          const ms = odds ? Date.parse(odds.pollCapturedAt) : NaN;
          lastPollMs = Number.isFinite(ms) ? ms : undefined;
          writeEvent(res, 'snapshot', { contestId, market, odds: odds ?? null });
          shedIfSlow();
          live = true;
          // The snapshot is the recovery signal — clear degraded if the source
          // is healthy; if it dropped during the query, keep the client behind.
          if (getOddsHub().isDegraded()) markDegraded('channel_error');
          else clientDegraded = false;
          flushPending();
        } else {
          // Stay pre-baseline (no deltas emitted without a snapshot) and retry,
          // so the documented snapshot-first contract holds.
          markDegraded('snapshot_failed');
          scheduleRetry();
        }
      } while (needsResnapshot && !closed && ok);
    } finally {
      snapshotInFlight = false;
    }
  };

  sub = getOddsHub().subscribe(jid, market, {
    onChange: (odds) => deliver('change', odds),
    onRefresh: (odds) => deliver('refresh', odds),
    onDegraded: (reason) => markDegraded(reason),
    onActive: () => {
      void runSnapshot();
    },
  });
}
