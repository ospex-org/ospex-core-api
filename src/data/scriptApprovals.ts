/**
 * Static EIP-712 ScriptApproval data for OracleModule.createContestFromOracle.
 *
 * Edit this file to refresh approvals (e.g., when the verify approval is
 * re-signed). A core-api redeploy publishes the change; no DB dependency.
 *
 * Source of truth: ospex-foundry-matched-pairs/docs/deployment/POLYGON_MAINNET_R4_SCRIPT_APPROVALS.md.
 *
 * Amoy R4 does not currently have committed script approvals — its entry is
 * null. The handler returns 503 SCRIPT_APPROVALS_NOT_CONFIGURED when the
 * deployment's network resolves to an unconfigured entry.
 */
import type { Network } from '../lib/env.js';

export type ScriptPurpose = 0 | 1 | 2;

export interface ScriptApprovalEntry {
  scriptHash: `0x${string}`;
  purpose: ScriptPurpose;
  leagueId: number;
  version: number;
  /** Unix seconds. 0 = permanent, no expiry. */
  validUntil: number;
  signature: `0x${string}`;
  sourceUrl: string;
}

export interface ScriptApprovalsBundle {
  network: Network;
  approvedSigner: `0x${string}`;
  verify: ScriptApprovalEntry;
  marketUpdate: ScriptApprovalEntry;
  score: ScriptApprovalEntry;
}

const polygon: ScriptApprovalsBundle = {
  network: 'polygon',
  approvedSigner: '0xfd6C7Fc1F182de53AA636584f1c6B80d9D885886',
  verify: {
    // Re-signed 2026-05-27 for the Athletics MLB teamLegend fix (was 0x01c48e15...,
    // validUntil 1793030835). See ospex-foundry-matched-pairs POLYGON_MAINNET_R4_SCRIPT_APPROVALS.md.
    scriptHash: '0xec6a7e9cdffa09fdcaa611220e2c99ba0ec58cc082812a01b5d321ccc1e5ebcf',
    purpose: 0,
    leagueId: 0,
    version: 1,
    validUntil: 1795737600,
    signature:
      '0x0ab097985df80cc08e75e88af7b337b2e645a62c9a53eea96a38faf1fe4911d15dc731abbe099e7256d9f005860a6f48f22267f22286d032fbf6152fa9c6625e1b',
    sourceUrl:
      'https://raw.githubusercontent.com/ospex-org/ospex-source-files-and-other/master/src/contestCreation.js',
  },
  marketUpdate: {
    scriptHash: '0x7f5ce70565133fedb2e0f1aeb925f38a3b26924917cff852e7de40a9297119b4',
    purpose: 1,
    leagueId: 0,
    version: 1,
    validUntil: 0,
    signature:
      '0x29658d908ba488863afb292eb15de7004f34c3a76a2fe14a8c098d776dc9499027b678f1308c45cc196587f291657235d641e842a19e183277ad711a2c7d16631c',
    sourceUrl:
      'https://raw.githubusercontent.com/ospex-org/ospex-source-files-and-other/master/src/contestMarketsUpdate.js',
  },
  score: {
    scriptHash: '0xcb2a11db3190c322239b52afb3caefccfccd850566834819b012c5520f8d31cd',
    purpose: 2,
    leagueId: 0,
    version: 1,
    validUntil: 0,
    signature:
      '0x3e72c199479665aa148cb1ac05bc4261b74b8581447adcb9165bdb67f6f6c99b7753a7a6186ac5fc4046ba9f626954cfefe47a6d9ce8437204feb109bb9713791b',
    sourceUrl:
      'https://raw.githubusercontent.com/ospex-org/ospex-source-files-and-other/master/src/contestScoring.js',
  },
};

export const SCRIPT_APPROVALS_BY_NETWORK: Record<Network, ScriptApprovalsBundle | null> = {
  polygon,
  amoy: null,
};
