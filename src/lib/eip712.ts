/**
 * EIP-712 typed-data registry for off-chain signed actions.
 *
 * R4 OspexCommitment schema — 9 fields, NOT 10. The R3 schema (in
 * ospex-agent-server) had a 10th field `contributionAmount`; R4
 * dropped it. Any signer producing a 10-field hash will fail
 * verification on-chain. Source of truth: the typehash in
 * ospex-foundry-matched-pairs/src/modules/MatchingModule.sol.
 *
 * The `verifyingContract` for the domain is the MatchingModule, not
 * OspexCore. The legacy ospex-agent-server middleware used OspexCore,
 * which is the single most common bug for new integrators per the
 * eip712-commitments skill. This module hard-wires MatchingModule.
 */

import { ethers, type TypedDataDomain, type TypedDataField } from 'ethers';
import type { ChainId } from './env.js';

// ────────────────────────────────────────────────────────────────────
// Action registry
// ────────────────────────────────────────────────────────────────────

export type ActionType = 'OspexCommitment' | 'CancelCommitment';

/**
 * R4 OspexCommitment fields — 9, in the exact order the contract's
 * typehash declares them.
 */
const OSPEX_COMMITMENT_FIELDS: TypedDataField[] = [
  { name: 'maker', type: 'address' },
  { name: 'contestId', type: 'uint256' },
  { name: 'scorer', type: 'address' },
  { name: 'lineTicks', type: 'int32' },
  { name: 'positionType', type: 'uint8' },
  { name: 'oddsTick', type: 'uint16' },
  { name: 'riskAmount', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
];

/**
 * Off-chain cancel — the API-only action that flags a commitment as
 * `cancelled` so takers stop seeing it on the order book. Authoritative
 * cancellation is on-chain (`MatchingModule.cancelCommitment` or
 * `raiseMinNonce`); this is the "remove from book" signal.
 *
 * No `maker` in the typed data: the signer recovered from the signature
 * IS the maker, and the handler authoritatively compares against the
 * looked-up commitment's `maker` column. Adding maker to the message
 * would be redundant — the signature already binds the signer.
 */
const CANCEL_COMMITMENT_FIELDS: TypedDataField[] = [
  { name: 'commitmentHash', type: 'bytes32' },
  { name: 'expiry', type: 'uint256' },
];

const ACTION_FIELDS: Record<ActionType, TypedDataField[]> = {
  OspexCommitment: OSPEX_COMMITMENT_FIELDS,
  CancelCommitment: CANCEL_COMMITMENT_FIELDS,
};

export function getActionFields(action: ActionType): TypedDataField[] {
  return ACTION_FIELDS[action];
}

/**
 * Full registry — used by `/v1/auth/domain` to surface every signable
 * action's schema for client introspection. Returned as a Readonly view
 * so callers can serialize but not mutate the underlying record.
 */
export function getAllActionFields(): Readonly<Record<ActionType, TypedDataField[]>> {
  return ACTION_FIELDS;
}

// ────────────────────────────────────────────────────────────────────
// Domain
// ────────────────────────────────────────────────────────────────────

/**
 * Build the EIP-712 domain for a given chain + verifying contract.
 *
 * R4 commitments are signed against MatchingModule. Future signed
 * actions (cancel-by-hash, etc.) live in the same domain.
 */
export function buildDomain(chainId: ChainId, verifyingContract: string): TypedDataDomain {
  return {
    name: 'Ospex',
    version: '1',
    chainId,
    verifyingContract,
  };
}

/**
 * Build the stream-auth EIP-712 domain. SEPARATE `domainSeparator` from the
 * on-chain commitment domain (spec §3.2: namespace under `OspexStreamAuth`) —
 * the `name` field differs, so an `OspexCommitment` signature can never be
 * replayed as an `OspexStreamAuth` and vice-versa. The `verifyingContract`
 * field reuses the matching-module address only to keep the domain shape
 * identical to the existing idiom; nothing on chain reads stream-auth domains.
 */
export function buildStreamAuthDomain(chainId: ChainId, verifyingContract: string): TypedDataDomain {
  return {
    name: 'OspexStreamAuth',
    version: '1',
    chainId,
    verifyingContract,
  };
}

// ────────────────────────────────────────────────────────────────────
// OspexStreamAuth — stream-auth challenge (spec §3.2)
//
// Owner-auth own-state subscribers sign a server-minted challenge; the server
// trades the signature for a short-lived bearer token. The challenge is a
// NESTED typed-data struct (`network.chainId` is its own struct) so future
// network metadata (`network.name`, etc.) doesn't require a breaking schema
// change. Two struct sets get registered for ethers' EIP-712 walker:
// `OspexStreamAuth` (primary) + `StreamAuthNetwork` (nested).
// ────────────────────────────────────────────────────────────────────

const STREAM_AUTH_NETWORK_FIELDS: TypedDataField[] = [
  { name: 'chainId', type: 'uint256' },
];

const OSPEX_STREAM_AUTH_FIELDS: TypedDataField[] = [
  { name: 'address', type: 'address' },
  { name: 'resource', type: 'string' },
  { name: 'scope', type: 'string' },
  { name: 'network', type: 'StreamAuthNetwork' },
  { name: 'audience', type: 'string' },
  { name: 'challengeId', type: 'string' },
  { name: 'issuedAt', type: 'uint256' },
  { name: 'expiresAt', type: 'uint256' },
];

/**
 * Multi-type types Record for an `OspexStreamAuth` challenge. Pass to
 * `verifyTypedData(domain, STREAM_AUTH_TYPES, message, signature)`.
 */
export const STREAM_AUTH_TYPES: Readonly<Record<string, TypedDataField[]>> = {
  OspexStreamAuth: OSPEX_STREAM_AUTH_FIELDS,
  StreamAuthNetwork: STREAM_AUTH_NETWORK_FIELDS,
};

// ────────────────────────────────────────────────────────────────────
// Verify + hash
// ────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  recoveredAddress: string;
  hash: string;
}

export type VerifyError =
  | { kind: 'invalid_signature_format' }
  | { kind: 'verification_threw'; reason: string }
  | { kind: 'recovered_mismatch'; recovered: string };

/**
 * Recover the signer of a typed-data message and compute its EIP-712
 * hash. Returns the recovered address (always — this function does NOT
 * compare against a claimed maker; the caller does that).
 *
 * `types` is the full Record (`{primaryType: fields, ...nestedTypes}`),
 * not just a single action's fields, so callers with nested struct
 * schemas (e.g. `OspexStreamAuth.network: StreamAuthNetwork`) can pass
 * the complete graph in one call.
 */
export function verifyTypedData(
  domain: TypedDataDomain,
  types: Record<string, TypedDataField[]>,
  message: Record<string, unknown>,
  signature: string,
): VerifyResult | VerifyError {
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    return { kind: 'invalid_signature_format' };
  }
  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyTypedData(domain, types, message, signature);
  } catch (err) {
    return { kind: 'verification_threw', reason: err instanceof Error ? err.message : String(err) };
  }
  const hash = ethers.TypedDataEncoder.hash(domain, types, message);
  return { recoveredAddress, hash };
}

// ────────────────────────────────────────────────────────────────────
// speculation_key derivation
// ────────────────────────────────────────────────────────────────────

/**
 * Derive the speculation_key the contract uses to scope nonce floors.
 *
 *   keccak256(abi.encode(uint256 contestId, address scorer, int32 lineTicks))
 *
 * Mirrors what the indexer computes when it processes
 * MIN_NONCE_UPDATED events. We compute it on insert so the row is
 * immediately consistent with whatever the indexer would write later.
 */
export function deriveSpeculationKey(
  contestId: bigint,
  scorer: string,
  lineTicks: number,
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'int32'],
    [contestId, scorer, lineTicks],
  );
  return ethers.keccak256(encoded);
}
