/**
 * `verifyStreamToken` — bearer-token gate for the M4 own-state surfaces.
 *
 * Reads `Authorization: Bearer <token>`, verifies the HMAC, audience, and
 * chain bindings, and attaches `{address, expiresAt}` to the request for
 * downstream handlers. No-ops to a 401 with a distinct code per failure
 * mode so the SDK can give the operator an actionable error (vs a generic
 * "auth failed"). The raw token never appears in the response body or in
 * any log line emitted from here — combined with the pino redact rules
 * added in router boot, that keeps the token off the wire and out of
 * persisted logs.
 *
 * Pre-conditions: `streamAuthHmacSecret` + `streamAuthAudience` are set on
 * Config. Absent at middleware entry → 503 NOT_READY (mirrors the mint
 * handlers, so the boot story is consistent).
 */

import type { Request, Response, NextFunction } from 'express';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { verifyStreamAuthToken } from '../lib/streamAuth.js';
import type { ApiError } from './errorHandler.js';

/** Augmented request after a successful pass through `verifyStreamToken`. */
export interface StreamAuthRequest extends Request {
  streamAuth: { address: string; expiresAt: number };
}

const BEARER_PREFIX = 'Bearer ';

export function verifyStreamToken(req: Request, res: Response, next: NextFunction): void {
  const config = loadConfig();
  if (!config.streamAuthHmacSecret || !config.streamAuthAudience) {
    logger.warn('verifyStreamToken: stream-auth env not configured');
    res.status(503).json({
      error: 'Server not configured for stream auth: set STREAM_AUTH_HMAC_SECRET and STREAM_AUTH_AUDIENCE.',
      code: 'NOT_READY',
    } satisfies ApiError);
    return;
  }

  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
    res.status(401).json({
      error: 'Missing Authorization: Bearer header.',
      code: 'AUTH_MISSING',
    } satisfies ApiError);
    return;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    res.status(401).json({
      error: 'Bearer token is empty.',
      code: 'AUTH_MISSING',
    } satisfies ApiError);
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const result = verifyStreamAuthToken(token, config.streamAuthHmacSecret, nowSec);
  if (!result.ok) {
    const codeMap = {
      malformed: 'AUTH_TOKEN_MALFORMED',
      unknown_kid: 'AUTH_TOKEN_UNKNOWN_KID',
      bad_signature: 'AUTH_TOKEN_INVALID',
      expired: 'AUTH_TOKEN_EXPIRED',
    } as const;
    // Log the reason but NEVER the token (the redact list on `req.headers.authorization`
    // covers structured logs; explicit-string logging here would defeat that).
    logger.warn({ reason: result.reason }, 'verifyStreamToken: token rejected');
    res.status(401).json({
      error: `Stream token rejected: ${result.reason}.`,
      code: codeMap[result.reason],
    } satisfies ApiError);
    return;
  }
  const claims = result.claims;

  // Audience + chain bindings — defends against a token minted for another
  // deployment / network being replayed against this one.
  if (claims.audience !== config.streamAuthAudience) {
    logger.warn(
      { tokenAudience: claims.audience, serverAudience: config.streamAuthAudience },
      'verifyStreamToken: audience mismatch',
    );
    res.status(401).json({
      error: 'Token audience does not match this deployment.',
      code: 'AUTH_TOKEN_AUDIENCE_MISMATCH',
    } satisfies ApiError);
    return;
  }
  if (claims.chainId !== config.chainId) {
    logger.warn(
      { tokenChainId: claims.chainId, serverChainId: config.chainId },
      'verifyStreamToken: chainId mismatch',
    );
    res.status(401).json({
      error: 'Token chainId does not match this deployment.',
      code: 'AUTH_TOKEN_CHAIN_MISMATCH',
    } satisfies ApiError);
    return;
  }

  const augmented = req as StreamAuthRequest;
  augmented.streamAuth = { address: claims.address, expiresAt: claims.expiresAt };
  next();
}
