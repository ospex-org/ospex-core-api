import { buildApp } from './app.js';
import { loadConfig } from './lib/env.js';
import { logger } from './lib/logger.js';
import { closeAllStreams, configureConnectionCaps } from './v1/stream/connections.js';

function main(): void {
  const config = loadConfig();
  configureConnectionCaps({
    maxTotal: config.maxStreamConnectionsTotal,
    maxPerIp: config.maxStreamConnectionsPerIp,
    reservedPerIpOwner: config.reservedStreamConnectionsPerIpOwner,
  });
  const app = buildApp(config);

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, network: config.network, nodeEnv: config.nodeEnv },
      'ospex-core-api listening',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    // End open SSE responses first — they're long-lived, so without this
    // server.close() waits on them until the force-exit timeout fires.
    closeAllStreams();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
