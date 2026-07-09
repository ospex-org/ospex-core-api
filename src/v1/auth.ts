/**
 * /v1/auth/* — EIP-712 self-discovery for clients.
 *
 *   GET /v1/auth/domain — returns the EIP-712 domain, every registered
 *                         action's typed-field schema, and a per-endpoint
 *                         map (which action.type each signed endpoint
 *                         accepts). Clients can copy `domain` + the
 *                         relevant action's fields straight into
 *                         `wallet.signTypedData(domain, types, message)`.
 *
 * A verify-style sign-test endpoint is deliberately not ported here.
 * Signature-only "prove you hold this key" has no resource to gate on
 * this service, and the owner-auth surfaces already have a purpose-built
 * challenge/token handshake (`/v1/auth/stream-{challenge,token}`). If a
 * session-auth need ever materializes, SIWE is the thing to evaluate.
 */

import type { Request, Response } from 'express';
import type { TypedDataField } from 'ethers';
import { loadConfig, type ChainId, type Network } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { buildDomain, getAllActionFields, type ActionType } from '../lib/eip712.js';
import type { ApiError } from '../middleware/errorHandler.js';

interface AuthDomainResponse {
  domain: {
    name: string;
    version: string;
    chainId: ChainId;
    verifyingContract: string;
  };
  network: Network;
  actions: Record<ActionType, TypedDataField[]>;
  requestFormat: {
    description: string;
    endpoints: Record<string, ActionType>;
    example: {
      action: Record<string, unknown>;
      signature: string;
    };
  };
}

// Static example — kept deterministic so the response is cacheable.
// Hash + signature are illustrative placeholders, not valid recovery targets.
const EXAMPLE: AuthDomainResponse['requestFormat']['example'] = {
  action: {
    type: 'CancelCommitment',
    commitmentHash: '0x' + 'ab'.repeat(32),
    expiry: '1730000000',
  },
  signature: '0x' + 'ee'.repeat(65),
};

const REQUEST_FORMAT_DESCRIPTION =
  'All signed-action endpoints accept { action, signature }. ' +
  'Sign with wallet.signTypedData(domain, { [action.type]: actions[action.type] }, message), ' +
  'where `message` is the action object minus the `type` field. ' +
  'Address fields are case-insensitive (lowercased server-side). ' +
  'uint fields accept decimal string or number (BigInt-compatible). ' +
  'signature is 0x-prefixed hex (65 bytes / 132 chars).';

const ENDPOINT_TO_ACTION: Record<string, ActionType> = {
  'POST /v1/commitments': 'OspexCommitment',
  'DELETE /v1/commitments/:hash': 'CancelCommitment',
};

export function getAuthDomainHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  if (!config.matchingModuleAddress) {
    logger.warn('getAuthDomainHandler: MATCHING_MODULE_ADDRESS not configured');
    res.status(503).json({
      error: 'Server not configured for signed actions: MATCHING_MODULE_ADDRESS is not set.',
      code: 'NOT_READY',
    } satisfies ApiError);
    return;
  }
  const domain = buildDomain(config.chainId, config.matchingModuleAddress);
  const body: AuthDomainResponse = {
    domain: {
      name: String(domain.name),
      version: String(domain.version),
      chainId: config.chainId,
      verifyingContract: config.matchingModuleAddress,
    },
    network: config.network,
    actions: getAllActionFields(),
    requestFormat: {
      description: REQUEST_FORMAT_DESCRIPTION,
      endpoints: ENDPOINT_TO_ACTION,
      example: EXAMPLE,
    },
  };
  // The response only changes on deploy (new action type, new contract,
  // chain switch). 5 min is conservative.
  res.set('Cache-Control', 'public, max-age=300');
  res.status(200).json(body);
}
