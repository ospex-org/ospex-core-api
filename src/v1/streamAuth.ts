/**
 * Stream-auth handlers (M3) — `POST /v1/auth/stream-challenge` and
 * `POST /v1/auth/stream-token`.
 *
 * Flow (spec §3.1):
 *   1. Client POSTs {address} → server mints + stores a fresh EIP-712
 *      challenge, returns it with an `expiresAt`.
 *   2. SDK signs the challenge typed-data with the wallet for `address`.
 *   3. Client POSTs {challenge, signature} → server verifies signature,
 *      verifies challenge constraints (audience, chainId, expiry, not
 *      replayed), single-use-consumes the stored challengeId, and mints a
 *      ~15 min bearer token.
 *
 * Token mint key + audience live on Config (`streamAuthHmacSecret`,
 * `streamAuthAudience`); both are optional at boot so the server still
 * comes up cleanly if stream-auth isn't yet wired. Handlers 503 NOT_READY
 * when missing.
 */

import type { Request, Response } from 'express';
import { isAddress } from 'ethers';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { buildStreamAuthDomain, STREAM_AUTH_TYPES, verifyTypedData } from '../lib/eip712.js';
import {
  challengeStore,
  generateChallengeId,
  mintStreamAuthToken,
  type StreamChallenge,
} from '../lib/streamAuth.js';
import type { ApiError } from '../middleware/errorHandler.js';

// ────────────────────────────────────────────────────────────────────
// POST /v1/auth/stream-challenge
// ────────────────────────────────────────────────────────────────────

interface ChallengeResponseBody {
  challenge: StreamChallenge;
  expiresAt: number;
}

export function postStreamChallengeHandler(req: Request, res: Response): void {
  const config = loadConfig();
  // Unified readiness contract: BOTH endpoints require all three env vars.
  // A challenge that can be minted but never traded for a token is dead-end
  // UX (the SDK can't recover); fail fast at the first call so the operator
  // sees the misconfiguration immediately.
  if (
    !config.streamAuthHmacSecret ||
    !config.streamAuthAudience ||
    !config.matchingModuleAddress
  ) {
    logger.warn('postStreamChallengeHandler: stream-auth env not configured');
    res.status(503).json({
      error:
        'Server not configured for stream auth: set STREAM_AUTH_HMAC_SECRET, STREAM_AUTH_AUDIENCE, MATCHING_MODULE_ADDRESS.',
      code: 'NOT_READY',
    } satisfies ApiError);
    return;
  }

  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({
      error: 'Request body must be JSON: { address }.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const rawAddress = body['address'];
  if (typeof rawAddress !== 'string') {
    res.status(400).json({
      error: 'address must be a string.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const addressLower = rawAddress.trim().toLowerCase();
  if (!isAddress(addressLower)) {
    res.status(400).json({
      error: 'address must be a valid Ethereum address.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + config.streamChallengeTtlSec;
  const challengeId = generateChallengeId();
  const challenge: StreamChallenge = {
    address: addressLower,
    resource: 'own-state',
    scope: 'read:own-state',
    network: { chainId: config.chainId },
    audience: config.streamAuthAudience,
    challengeId,
    issuedAt: nowSec,
    expiresAt,
  };
  challengeStore.add(challengeId, challenge);
  const responseBody: ChallengeResponseBody = { challenge, expiresAt };
  res.status(200).json(responseBody);
}

// ────────────────────────────────────────────────────────────────────
// POST /v1/auth/stream-token
// ────────────────────────────────────────────────────────────────────

interface TokenResponseBody {
  token: string;
  expiresAt: number;
}

export function postStreamTokenHandler(req: Request, res: Response): void {
  const config = loadConfig();
  if (
    !config.streamAuthHmacSecret ||
    !config.streamAuthAudience ||
    !config.matchingModuleAddress
  ) {
    logger.warn('postStreamTokenHandler: stream-auth env not configured');
    res.status(503).json({
      error:
        'Server not configured for stream auth: set STREAM_AUTH_HMAC_SECRET, STREAM_AUTH_AUDIENCE, MATCHING_MODULE_ADDRESS.',
      code: 'NOT_READY',
    } satisfies ApiError);
    return;
  }

  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({
      error: 'Request body must be JSON: { challenge, signature }.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const rawChallenge = body['challenge'];
  const rawSignature = body['signature'];
  if (typeof rawSignature !== 'string' || !rawSignature.startsWith('0x')) {
    res.status(400).json({
      error: 'signature must be a 0x-prefixed hex string.',
      code: 'INVALID_PARAM',
    } satisfies ApiError);
    return;
  }
  const challenge = parseChallenge(rawChallenge);
  if (!challenge.ok) {
    res.status(400).json({ error: challenge.error, code: 'INVALID_PARAM' } satisfies ApiError);
    return;
  }
  const c = challenge.value;

  // Defence: even before signature recovery, refuse challenges minted for
  // some OTHER deployment / chain — a signature-valid foreign challenge
  // would still 401 below, but failing fast here keeps the audit trail
  // crisp and prevents any future bug from accepting a same-domain replay.
  if (c.audience !== config.streamAuthAudience) {
    res.status(401).json({
      error: 'Challenge audience does not match this deployment.',
      code: 'AUTH_AUDIENCE_MISMATCH',
    } satisfies ApiError);
    return;
  }
  if (c.network.chainId !== config.chainId) {
    res.status(401).json({
      error: 'Challenge chainId does not match this deployment.',
      code: 'AUTH_CHAIN_MISMATCH',
    } satisfies ApiError);
    return;
  }

  // Verify EIP-712 signature against the supplied challenge. The recovered
  // signer MUST equal `challenge.address` — otherwise the SDK signed a
  // challenge for someone else and is trying to claim their identity.
  const domain = buildStreamAuthDomain(config.chainId, config.matchingModuleAddress);
  const message = {
    address: c.address,
    resource: c.resource,
    scope: c.scope,
    network: c.network,
    audience: c.audience,
    challengeId: c.challengeId,
    issuedAt: BigInt(c.issuedAt),
    expiresAt: BigInt(c.expiresAt),
  };
  const verifyResult = verifyTypedData(domain, STREAM_AUTH_TYPES, message, rawSignature);
  if ('kind' in verifyResult) {
    logger.warn({ kind: verifyResult.kind }, 'stream-token: signature verification failed');
    res.status(401).json({
      error: 'Signature verification failed.',
      code: 'AUTH_SIGNATURE_INVALID',
    } satisfies ApiError);
    return;
  }
  if (verifyResult.recoveredAddress.toLowerCase() !== c.address) {
    logger.warn(
      { recovered: verifyResult.recoveredAddress, claimed: c.address },
      'stream-token: recovered signer does not match challenge.address',
    );
    res.status(401).json({
      error: 'Recovered signer does not match challenge.address.',
      code: 'AUTH_SIGNATURE_INVALID',
    } satisfies ApiError);
    return;
  }

  // Single-use consumption — covers replay + expiry + address-binding +
  // server-bound issuedAt/expiresAt comparison. The burn-DoS and
  // tampered-timestamp defences live inside ChallengeStore.consume.
  const nowSec = Math.floor(Date.now() / 1000);
  const consumed = challengeStore.consume(c.challengeId, c, nowSec);
  if (!consumed.ok) {
    const codeMap = {
      unknown: 'AUTH_CHALLENGE_UNKNOWN',
      expired: 'AUTH_CHALLENGE_EXPIRED',
      already_used: 'AUTH_CHALLENGE_REPLAY',
      address_mismatch: 'AUTH_CHALLENGE_ADDRESS_MISMATCH',
      tampered: 'AUTH_CHALLENGE_TAMPERED',
    } as const;
    res.status(401).json({
      error: `Challenge consume rejected: ${consumed.reason}.`,
      code: codeMap[consumed.reason],
    } satisfies ApiError);
    return;
  }

  // Mint the bearer token. TTL is `streamTokenTtlSec` from boot config; the
  // claims mirror the challenge contract so the verifier middleware can
  // re-check audience + chain on every stream connect.
  const tokenExpiresAt = nowSec + config.streamTokenTtlSec;
  const token = mintStreamAuthToken(
    {
      address: c.address,
      resource: 'own-state',
      scope: 'read:own-state',
      audience: config.streamAuthAudience,
      chainId: config.chainId,
      issuedAt: nowSec,
      expiresAt: tokenExpiresAt,
    },
    config.streamAuthHmacSecret,
  );

  const responseBody: TokenResponseBody = { token, expiresAt: tokenExpiresAt };
  res.status(200).json(responseBody);
}

// ────────────────────────────────────────────────────────────────────
// Internal: structural challenge parser
// ────────────────────────────────────────────────────────────────────

function parseChallenge(raw: unknown):
  | { ok: true; value: StreamChallenge }
  | { ok: false; error: string }
{
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'challenge must be an object.' };
  }
  const o = raw as Record<string, unknown>;
  const address = typeof o['address'] === 'string' ? o['address'].trim().toLowerCase() : '';
  if (!isAddress(address)) {
    return { ok: false, error: 'challenge.address must be a valid Ethereum address.' };
  }
  if (o['resource'] !== 'own-state') {
    return { ok: false, error: 'challenge.resource must be "own-state".' };
  }
  if (o['scope'] !== 'read:own-state') {
    return { ok: false, error: 'challenge.scope must be "read:own-state".' };
  }
  const network = o['network'];
  if (typeof network !== 'object' || network === null) {
    return { ok: false, error: 'challenge.network must be an object.' };
  }
  const chainId = (network as Record<string, unknown>)['chainId'];
  // Strict numeric validation: `typeof === 'number'` alone lets fractional
  // / Infinity / NaN through, and the BigInt() conversion downstream throws
  // RangeError → Express 500. Safe-integer + non-negative everywhere a
  // value flows into BigInt or into a JSON-roundtrip comparison.
  if (!Number.isSafeInteger(chainId) || (chainId as number) <= 0) {
    return {
      ok: false,
      error: 'challenge.network.chainId must be a positive safe-integer.',
    };
  }
  const audience = o['audience'];
  if (typeof audience !== 'string' || audience.length === 0) {
    return { ok: false, error: 'challenge.audience must be a non-empty string.' };
  }
  const challengeId = o['challengeId'];
  if (typeof challengeId !== 'string' || challengeId.length === 0) {
    return { ok: false, error: 'challenge.challengeId must be a non-empty string.' };
  }
  const issuedAt = o['issuedAt'];
  const expiresAt = o['expiresAt'];
  if (!Number.isSafeInteger(issuedAt) || (issuedAt as number) < 0) {
    return {
      ok: false,
      error: 'challenge.issuedAt must be a non-negative safe-integer unix-seconds value.',
    };
  }
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 0) {
    return {
      ok: false,
      error: 'challenge.expiresAt must be a non-negative safe-integer unix-seconds value.',
    };
  }
  return {
    ok: true,
    value: {
      address,
      resource: 'own-state',
      scope: 'read:own-state',
      network: { chainId: chainId as number },
      audience,
      challengeId,
      issuedAt: issuedAt as number,
      expiresAt: expiresAt as number,
    },
  };
}
