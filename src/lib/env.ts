import { isAddress } from 'ethers';
import { logger } from './logger.js';

export type Network = 'polygon' | 'amoy';
export type ChainId = 137 | 80002;

/**
 * Required vars are validated at boot and always present on Config.
 *
 * Optional vars (alchemyRpcUrl, matchingModuleAddress) are reserved for
 * endpoints that haven't migrated yet. They're validated when set, but
 * absence is allowed so the scaffold can boot in environments that don't
 * yet have those secrets. Routes that consume them must check presence
 * at use site (or upgrade them to required as they land).
 */
export interface Config {
  port: number;
  nodeEnv: string;
  network: Network;
  chainId: ChainId;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  alchemyRpcUrl?: string;
  matchingModuleAddress?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    logger.fatal({ var: name }, 'Missing required environment variable');
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    logger.fatal({ value: process.env.PORT }, 'PORT must be an integer between 1 and 65535');
    process.exit(1);
  }

  const nodeEnv = process.env.NODE_ENV ?? 'development';

  const rawNetwork = (process.env.NETWORK ?? 'polygon').toLowerCase();
  if (rawNetwork !== 'polygon' && rawNetwork !== 'amoy') {
    logger.fatal({ network: rawNetwork }, 'NETWORK must be "polygon" or "amoy"');
    process.exit(1);
  }
  const network = rawNetwork as Network;
  const chainId: ChainId = network === 'polygon' ? 137 : 80002;

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseServiceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const alchemyRpcUrl = optionalEnv('ALCHEMY_RPC_URL');
  const matchingModuleAddress = optionalEnv('MATCHING_MODULE_ADDRESS');
  if (matchingModuleAddress !== undefined && !isAddress(matchingModuleAddress)) {
    logger.fatal(
      { address: matchingModuleAddress },
      'MATCHING_MODULE_ADDRESS is set but is not a valid Ethereum address',
    );
    process.exit(1);
  }

  cached = {
    port,
    nodeEnv,
    network,
    chainId,
    supabaseUrl,
    supabaseServiceRoleKey,
    ...(alchemyRpcUrl !== undefined ? { alchemyRpcUrl } : {}),
    ...(matchingModuleAddress !== undefined ? { matchingModuleAddress } : {}),
  };
  return cached;
}
