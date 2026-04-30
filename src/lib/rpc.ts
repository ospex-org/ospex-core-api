import { JsonRpcProvider } from 'ethers';
import { loadConfig } from './env.js';

let provider: JsonRpcProvider | undefined;

/**
 * Lazy-init ethers JsonRpcProvider. Throws if `ALCHEMY_RPC_URL` is unset
 * — handlers that need RPC (e.g. tx-receipt parsers) catch this and
 * return 500 with `INTERNAL_ERROR` so the operator gets a clear signal
 * to set the env var.
 */
export function getProvider(): JsonRpcProvider {
  if (provider) return provider;
  const { alchemyRpcUrl } = loadConfig();
  if (!alchemyRpcUrl) {
    throw new Error('ALCHEMY_RPC_URL is not configured — required for tx-receipt parsing');
  }
  provider = new JsonRpcProvider(alchemyRpcUrl);
  return provider;
}
