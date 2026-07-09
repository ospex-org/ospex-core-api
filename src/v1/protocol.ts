/**
 * GET /v1/protocol/info — static protocol metadata.
 *
 * Contract addresses, chain id, network, and supported sports. The
 * legacy agent server also exposed a `/v1/protocol/agents` endpoint
 * backed by a Firebase collection. It is deliberately NOT ported:
 * this service has no Firebase dependency and the protocol exposes no
 * agent registry.
 *
 * The `build` block reports the git commit the running service was built
 * from, so a reader of the public repo can confirm which source is live
 * (`commitUrl` → the exact reviewed code) and spot deploy drift against
 * `main`. It is a self-reported build identifier — a checkable pointer, not
 * a cryptographic proof that the dyno runs unmodified code. `null` in local
 * dev and until the Heroku dyno-metadata features are enabled.
 *
 * `commit` prefers `HEROKU_BUILD_COMMIT` (from `runtime-dyno-build-metadata`),
 * the current, correct build SHA. It falls back to the DEPRECATED
 * `HEROKU_SLUG_COMMIT`, which can reflect the previously-running slug —
 * `commitSource` names which one was used so a reader knows the reliability.
 */

import type { Request, Response } from 'express';
import { loadConfig } from '../lib/env.js';

/** Public source repository the deployed commit resolves to. */
const REPO_URL = 'https://github.com/ospex-org/ospex-core-api';

interface BuildInfo {
  commit: string;
  commitUrl: string;
  /** `build` = the current `HEROKU_BUILD_COMMIT`; `slug` = the deprecated `HEROKU_SLUG_COMMIT` fallback. */
  commitSource: 'build' | 'slug';
  releaseVersion: string | null;
  releasedAt: string | null;
}

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
  build: BuildInfo | null;
}

const SUPPORTED_SPORTS = ['NBA', 'NHL', 'NCAAB', 'NFL', 'MLB'];

export function getProtocolInfoHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  const commit = config.herokuBuildCommit ?? config.herokuSlugCommit;
  const build: BuildInfo | null = commit
    ? {
        commit,
        commitUrl: `${REPO_URL}/commit/${commit}`,
        commitSource: config.herokuBuildCommit ? 'build' : 'slug',
        releaseVersion: config.herokuReleaseVersion ?? null,
        releasedAt: config.herokuReleaseCreatedAt ?? null,
      }
    : null;
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
    build,
  };
  res.status(200).json(body);
}
