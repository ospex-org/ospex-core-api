import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { loadConfig } from './lib/env.js';
import { logger, formatError } from './lib/logger.js';
import { getSupabase } from './lib/supabase.js';
import { asyncHandler } from './middleware/asyncHandler.js';
import { errorHandler } from './middleware/errorHandler.js';
import { v1Router } from './v1/router.js';

interface HealthResponse {
  ok: boolean;
  service: 'ospex-core-api';
  network: 'polygon' | 'amoy';
  chainId: 137 | 80002;
  supabase: { connected: boolean; error?: string };
  uptimeSeconds: number;
  timestamp: string;
}

async function checkSupabase(): Promise<{ connected: boolean; error?: string }> {
  try {
    const sb = getSupabase();
    // Lightweight ping: HEAD-style query. The chosen table doesn't have to
    // exist for this scaffold — any PostgREST response (including a 404 for
    // a missing table) proves we reached the service. We treat network-level
    // errors as "not connected" and PostgREST table-existence errors as
    // "connected" since they confirm round-trip.
    const { error } = await sb
      .from('contests')
      .select('contest_id', { head: true, count: 'exact' })
      .limit(0);
    if (!error) return { connected: true };
    // PostgREST "table not found" still proves connectivity
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return { connected: true };
    }
    return { connected: false, error: error.message };
  } catch (err) {
    return { connected: false, error: formatError(err) };
  }
}

function buildApp(config: ReturnType<typeof loadConfig>): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  app.get(
    '/healthz',
    asyncHandler(async (_req: Request, res: Response) => {
      const supabase = await checkSupabase();
      const body: HealthResponse = {
        ok: supabase.connected,
        service: 'ospex-core-api',
        network: config.network,
        chainId: config.chainId,
        supabase,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      };
      res.status(supabase.connected ? 200 : 503).json(body);
    }),
  );

  app.use('/v1', v1Router);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', code: 'NOT_FOUND' });
  });

  app.use(errorHandler);

  return app;
}

function main(): void {
  const config = loadConfig();
  const app = buildApp(config);

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, network: config.network, nodeEnv: config.nodeEnv },
      'ospex-core-api listening',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
