/**
 * EIP-712 signature-verification middleware.
 *
 * Body shape: `{ action: { type, ...fields }, signature }`.
 *
 * On success, attaches three fields to the request:
 *   - `authenticatedWallet` — the recovered signer (checksummed)
 *   - `actionMessage`       — the verified typed-data message
 *   - `actionHash`          — the EIP-712 digest (commitment_hash for OspexCommitment)
 *
 * Pipeline order (each step is a fast-fail):
 *   1. Body has `action` + `signature`?
 *   2. `action.type` matches expected?
 *   3. All fields present and structurally well-typed?
 *   4. Per-action business rules (lot size, range, expiry)?
 *   5. Signature recovers to a valid address?
 *   6. Recovered == claimed maker?
 *
 * The legacy ospex-agent-server middleware also kept an in-memory
 * nonce LRU for replay protection. R4 OspexCommitment nonces are
 * invalidation thresholds, not single-use tokens — the contract
 * (`s_minNonces[maker][speculationKey]`) is the canonical authority,
 * so off-chain uniqueness checking would actively cause false
 * rejections. The LRU is dropped here; if a future Verify-style
 * action is added, it can opt into uniqueness via a per-action mode.
 */

import type { Request, Response, NextFunction } from 'express';
import { ethers } from 'ethers';
import { loadConfig } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import {
  type ActionType,
  buildDomain,
  getActionFields,
  verifyTypedData,
} from '../lib/eip712.js';
import type { ApiError } from './errorHandler.js';

// ────────────────────────────────────────────────────────────────────
// Per-action structural + business validators
// ────────────────────────────────────────────────────────────────────

type ActionValidator = (raw: Record<string, unknown>) =>
  | { ok: true; message: Record<string, unknown> }
  | { ok: false; status: number; error: ApiError };

const validators: Record<ActionType, ActionValidator> = {
  OspexCommitment: validateOspexCommitment,
  CancelCommitment: validateCancelCommitment,
};

/**
 * Off-chain cancel action — `{ commitmentHash, expiry }`. Maker is NOT
 * in the typed data; the recovered signer must match the looked-up
 * commitment's maker (handler-side check). The middleware validates
 * shape + expiry only.
 *
 * Cancel signatures are short-lived (1 hour cap). They authorize a
 * one-shot action, not a standing order, so a year-long replay window
 * has no upside. 1 hour is generous for human signing latency without
 * leaving a stale signature lying around.
 */
const CANCEL_MAX_EXPIRY_OFFSET_SEC = 60n * 60n;

function validateCancelCommitment(raw: Record<string, unknown>): ReturnType<ActionValidator> {
  // commitmentHash — 0x-prefixed 32-byte hash
  const rawHash = raw['commitmentHash'];
  if (typeof rawHash !== 'string') {
    return { ok: false, status: 400, error: err('commitmentHash must be a string.', 'INVALID_PARAM') };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(rawHash)) {
    return { ok: false, status: 400, error: err('commitmentHash must be a 0x-prefixed 32-byte hex string.', 'INVALID_PARAM') };
  }
  const commitmentHash = rawHash.toLowerCase();

  // expiry — unix seconds; in the future, ≤ 1 hour out
  let expiry: bigint;
  try {
    expiry = BigInt(raw['expiry'] as string | number);
  } catch {
    return { ok: false, status: 400, error: err('expiry must be a unix-seconds integer.', 'INVALID_PARAM') };
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiry <= nowSec) {
    return { ok: false, status: 400, error: err('Cancel signature has already expired.', 'INVALID_PARAM') };
  }
  if (expiry > nowSec + CANCEL_MAX_EXPIRY_OFFSET_SEC) {
    return {
      ok: false,
      status: 400,
      error: err('Cancel expiry is more than 1 hour in the future; pick a closer expiry.', 'INVALID_PARAM'),
    };
  }

  return { ok: true, message: { commitmentHash, expiry } };
}

function err(error: string, code: string): ApiError {
  return { error, code };
}

function validateOspexCommitment(raw: Record<string, unknown>): ReturnType<ActionValidator> {
  // maker
  let maker: string;
  try {
    maker = ethers.getAddress(raw['maker'] as string);
  } catch {
    return { ok: false, status: 400, error: err('Invalid maker address.', 'INVALID_PARAM') };
  }
  // scorer
  let scorer: string;
  try {
    scorer = ethers.getAddress(raw['scorer'] as string);
  } catch {
    return { ok: false, status: 400, error: err('Invalid scorer address.', 'INVALID_PARAM') };
  }
  // contestId — uint256 → use bigint
  let contestId: bigint;
  try {
    contestId = BigInt(raw['contestId'] as string | number);
  } catch {
    return { ok: false, status: 400, error: err('contestId must be an integer.', 'INVALID_PARAM') };
  }
  if (contestId < 0n) {
    return { ok: false, status: 400, error: err('contestId must be non-negative.', 'INVALID_PARAM') };
  }
  if (contestId > 9_223_372_036_854_775_807n) {
    return { ok: false, status: 400, error: err('contestId exceeds database bigint range.', 'INVALID_PARAM') };
  }
  // lineTicks — int32
  const lineTicks = Number(raw['lineTicks']);
  if (!Number.isInteger(lineTicks) || lineTicks < -2_147_483_648 || lineTicks > 2_147_483_647) {
    return { ok: false, status: 400, error: err('lineTicks must be an int32.', 'INVALID_PARAM') };
  }
  // positionType — 0 (Upper) | 1 (Lower)
  const positionType = Number(raw['positionType']);
  if (positionType !== 0 && positionType !== 1) {
    return { ok: false, status: 400, error: err('positionType must be 0 (upper) or 1 (lower).', 'INVALID_PARAM') };
  }
  // oddsTick — uint16, range 101..10100
  const oddsTick = Number(raw['oddsTick']);
  if (!Number.isInteger(oddsTick) || oddsTick < 101 || oddsTick > 10100) {
    return { ok: false, status: 400, error: err('oddsTick must be an integer between 101 and 10100.', 'INVALID_PARAM') };
  }
  // riskAmount — uint256, must be a multiple of 100 (ODDS_SCALE)
  let riskAmount: bigint;
  try {
    riskAmount = BigInt(raw['riskAmount'] as string | number);
  } catch {
    return { ok: false, status: 400, error: err('riskAmount must be an integer.', 'INVALID_PARAM') };
  }
  if (riskAmount <= 0n) {
    return { ok: false, status: 400, error: err('riskAmount must be positive.', 'INVALID_PARAM') };
  }
  if (riskAmount % 100n !== 0n) {
    return {
      ok: false,
      status: 400,
      error: err('riskAmount must be lot-size aligned (divisible by 100).', 'INVALID_PARAM'),
    };
  }
  // nonce — uint256
  let nonce: bigint;
  try {
    nonce = BigInt(raw['nonce'] as string | number);
  } catch {
    return { ok: false, status: 400, error: err('nonce must be an integer.', 'INVALID_PARAM') };
  }
  if (nonce < 0n) {
    return { ok: false, status: 400, error: err('nonce must be non-negative.', 'INVALID_PARAM') };
  }
  // expiry — unix seconds; must be in the future, but bounded above so a
  // signed 2^255-1 (or anything beyond JS Date / Postgres timestamptz range)
  // can't reach `new Date(Number(expiry) * 1000).toISOString()` and throw a
  // RangeError that would leak as a 500. 1 year is well past any realistic
  // sports market and well below Number.MAX_SAFE_INTEGER seconds.
  let expiry: bigint;
  try {
    expiry = BigInt(raw['expiry'] as string | number);
  } catch {
    return { ok: false, status: 400, error: err('expiry must be a unix-seconds integer.', 'INVALID_PARAM') };
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiry <= nowSec) {
    return { ok: false, status: 400, error: err('Commitment has already expired.', 'INVALID_PARAM') };
  }
  const MAX_EXPIRY_OFFSET_SEC = 366n * 24n * 60n * 60n;
  if (expiry > nowSec + MAX_EXPIRY_OFFSET_SEC) {
    return {
      ok: false,
      status: 400,
      error: err('expiry is more than 1 year in the future; pick a closer expiry.', 'INVALID_PARAM'),
    };
  }

  return {
    ok: true,
    message: {
      maker,
      contestId,
      scorer,
      lineTicks,
      positionType,
      oddsTick,
      riskAmount,
      nonce,
      expiry,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Middleware factory
// ────────────────────────────────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
  authenticatedWallet: string;
  actionMessage: Record<string, unknown>;
  actionHash: string;
}

export function eip712Auth(action: ActionType) {
  // Fail loudly at boot if the action isn't registered.
  if (!getActionFields(action)) {
    throw new Error(`eip712Auth: unknown action type "${action}"`);
  }
  const validate = validators[action];
  if (!validate) {
    throw new Error(`eip712Auth: no validator registered for action "${action}"`);
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const config = loadConfig();
    if (!config.matchingModuleAddress) {
      logger.error('eip712Auth invoked but MATCHING_MODULE_ADDRESS is not configured');
      res.status(500).json(err('Server not configured for signed actions.', 'INTERNAL_ERROR'));
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json(err('Request body must be JSON: { action, signature }.', 'INVALID_PARAM'));
      return;
    }
    const rawAction = body['action'] as Record<string, unknown> | undefined;
    const signature = body['signature'];
    if (!rawAction || typeof rawAction !== 'object') {
      res.status(400).json(err('Missing "action" object.', 'INVALID_PARAM'));
      return;
    }
    if (typeof signature !== 'string' || !signature.startsWith('0x')) {
      res.status(400).json(err('Missing or invalid "signature" (must be 0x-prefixed hex).', 'INVALID_PARAM'));
      return;
    }
    const claimedType = String(rawAction['type'] ?? '');
    if (claimedType !== action) {
      res.status(400).json(err(`Expected action.type "${action}", got "${claimedType}".`, 'INVALID_PARAM'));
      return;
    }

    // Structural + business validation BEFORE signature recovery.
    const validation = validate(rawAction);
    if (!validation.ok) {
      res.status(validation.status).json(validation.error);
      return;
    }
    const message = validation.message;

    // Verify signature.
    const domain = buildDomain(config.chainId, config.matchingModuleAddress);
    const result = verifyTypedData(
      domain,
      { [action]: getActionFields(action) },
      message,
      signature,
    );
    if ('kind' in result) {
      if (result.kind === 'invalid_signature_format') {
        res.status(400).json(err('signature must be 0x-prefixed hex.', 'INVALID_PARAM'));
        return;
      }
      if (result.kind === 'verification_threw') {
        logger.warn({ reason: result.reason }, 'eip712Auth: signature verification threw');
        res.status(401).json(err('Signature verification failed.', 'AUTH_INVALID'));
        return;
      }
      // exhaustive
      res.status(401).json(err('Signature verification failed.', 'AUTH_INVALID'));
      return;
    }
    const { recoveredAddress, hash } = result;
    // Some action types (e.g. CancelCommitment) bind the signer's
    // identity entirely through the recovered address — they don't
    // include `maker` in the typed data, and the handler does the
    // authoritative match against a looked-up row. Only enforce the
    // claimed-maker comparison when the action declares one.
    if (message['maker'] !== undefined) {
      if (recoveredAddress.toLowerCase() !== String(message['maker']).toLowerCase()) {
        logger.warn(
          { claimed: message['maker'], recovered: recoveredAddress },
          'eip712Auth: recovered signer does not match claimed maker',
        );
        res.status(401).json(err('Signature does not match the claimed signer.', 'AUTH_INVALID'));
        return;
      }
    }

    const augmented = req as AuthenticatedRequest;
    augmented.authenticatedWallet = recoveredAddress;
    augmented.actionMessage = message;
    augmented.actionHash = hash;
    next();
  };
}
