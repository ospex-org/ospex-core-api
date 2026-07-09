/**
 * GET /v1/protocol/info — static protocol metadata.
 *
 * Contract addresses, chain id, network, and supported sports. The
 * legacy agent server also exposed a `/v1/protocol/agents` endpoint
 * backed by a Firebase collection. It is deliberately NOT ported:
 * this service has no Firebase dependency and the protocol exposes no
 * agent registry.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';

interface ProtocolInfoResponse {
  name: 'Ospex';
  network: 'polygon' | 'amoy';
  chainId: 137 | 80002;
  contracts: {
    matchingModule: string | null;
    scorers: { moneyline: string; spread: string; total: string } | null;
  };
  supportedSports: string[];
  fees: { platformFeePct: number; description: string };
}

const SUPPORTED_SPORTS = ['NBA', 'NHL', 'NCAAB', 'NFL', 'MLB'];

export function getProtocolInfoHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  const body: ProtocolInfoResponse = {
    name: 'Ospex',
    network: config.network,
    chainId: config.chainId,
    contracts: {
      matchingModule: config.matchingModuleAddress ?? null,
      scorers: config.scorers ?? null,
    },
    supportedSports: SUPPORTED_SPORTS,
    fees: {
      platformFeePct: 0,
      description: 'No platform fees. Stakes match peer-to-peer at signed odds.',
    },
  };
  res.status(200).json(body);
}
