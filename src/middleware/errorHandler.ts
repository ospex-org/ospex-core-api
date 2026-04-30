import type { Request, Response, NextFunction } from 'express';
import { logger, formatError } from '../lib/logger.js';

/**
 * Standard API error response shape.
 *
 * Error codes:
 * - `INVALID_PARAM`        — Request parameter is invalid or missing
 * - `NOT_FOUND`            — Requested resource does not exist
 * - `RATE_LIMIT_EXCEEDED`  — Too many requests from this IP
 * - `INTERNAL_ERROR`       — Unexpected server error
 * - `AUTH_MISSING`         — No { action, signature } body provided
 * - `AUTH_INVALID`         — Signature verification failed or action type mismatch
 * - `AUTH_REPLAY`          — Nonce has already been used for this wallet
 * - `AUTH_INVALID_WALLET`  — Wallet address is malformed or invalid
 */
export interface ApiError {
  error: string;
  code: string;
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err: formatError(err) }, 'unhandled error');
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' } satisfies ApiError);
  }
}
