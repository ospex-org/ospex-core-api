/**
 * Shared SSE-handler scaffolding for the two connect handlers (handler.ts,
 * oddsHandler.ts). Constants and small helpers only — the per-stream state
 * machines stay in their own files. Behavior is identical to the inlined
 * versions these replaced; the only per-handler variation (the shed log
 * payload) is passed in.
 */

import type { Request, Response } from 'express';
import type { ApiError } from '../../middleware/errorHandler.js';
import { acquire } from './connections.js';

/** Heartbeat comment interval — keeps the connection under the platform idle timeout. */
export const HEARTBEAT_MS = 20_000;

/** Outbound buffer ceiling: a client that isn't draining gets shed (forced to reconnect). */
export const MAX_PENDING_BYTES = 1_000_000;

/**
 * Acquire a concurrent-stream slot for the request. On success returns the
 * client IP (the key the caller passes to `release`); when the cap is full,
 * sends a `429 RATE_LIMIT_EXCEEDED` and returns null — the caller returns early.
 */
export function acquireStreamSlot(req: Request, res: Response): string | null {
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
    return null;
  }
  return ip;
}

/**
 * Build a backpressure guard: ends the response (→ 'close' → cleanup → the client
 * reconnects + catches up) when the outbound buffer exceeds MAX_PENDING_BYTES.
 * `onShed` logs the handler-specific context before the response is ended.
 */
export function makeShedIfSlow(res: Response, onShed: (pending: number) => void): () => void {
  return () => {
    const pending = (res as { writableLength?: number }).writableLength;
    if (!res.writableEnded && typeof pending === 'number' && pending > MAX_PENDING_BYTES) {
      onShed(pending);
      res.end();
    }
  };
}
