import { isAddress } from 'ethers';
import { logger } from './logger.js';

export type Network = 'polygon' | 'amoy';
export type ChainId = 137 | 80002;

export interface Config {
  port: number;
  nodeEnv: string;
  network: Network;
  chainId: ChainId;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  alchemyRpcUrl: string;
  matchingModuleAddress: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    logger.fatal({ var: name }, 'Missing required environment variable');
    process.exit(1);
  }
  return value;
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
  const alchemyRpcUrl = requireEnv('ALCHEMY_RPC_URL');

  const matchingModuleAddress = requireEnv('MATCHING_MODULE_ADDRESS');
  if (!isAddress(matchingModuleAddress)) {
    logger.fatal(
      { address: matchingModuleAddress },
      'MATCHING_MODULE_ADDRESS is not a valid Ethereum address',
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
    alchemyRpcUrl,
    matchingModuleAddress,
  };
  return cached;
}
