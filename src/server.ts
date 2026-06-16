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
import { closeAllStreams, configureConnectionCaps } from './v1/stream/connections.js';

interface LivenessResponse {
  ok: true;
  service: 'ospex-core-api';
  network: 'polygon' | 'amoy';
  chainId: 137 | 80002;
  uptimeSeconds: number;
  timestamp: string;
}

interface ReadinessResponse {
  ok: boolean;
  service: 'ospex-core-api';
  network: 'polygon' | 'amoy';
  chainId: 137 | 80002;
  supabase: { connected: boolean; error?: string };
  commitments: { configured: boolean; missing?: string[] };
  uptimeSeconds: number;
  timestamp: string;
}

function checkCommitmentsConfig(
  config: ReturnType<typeof loadConfig>,
): { configured: boolean; missing?: string[] } {
  const missing: string[] = [];
  if (!config.matchingModuleAddress) missing.push('MATCHING_MODULE_ADDRESS');
  if (!config.scorers) missing.push('SCORER_*_ADDRESS');
  if (missing.length === 0) return { configured: true };
  return { configured: false, missing };
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
  app.use(
    compression({
      // Never compress SSE — buffering/transforming an event stream defeats
      // its purpose. The stream handler sets `Content-Type: text/event-stream`
      // before the first write, so the filter sees it here.
      filter: (req, res) => {
        const ct = res.getHeader('Content-Type');
        if (typeof ct === 'string' && ct.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  // Liveness — process is up. No dependency checks. Always 200 while the
  // event loop can answer. Heroku/uptime monitors should hit this; restarting
  // the dyno doesn't fix Supabase, so we don't fail liveness when Supabase is
  // down.
  app.get('/healthz', (_req: Request, res: Response) => {
    const body: LivenessResponse = {
      ok: true,
      service: 'ospex-core-api',
      network: config.network,
      chainId: config.chainId,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
    res.status(200).json(body);
  });

  // Readiness — process is up AND its required dependencies are reachable
  // AND its mounted endpoints have the env they need. Returns 503 if any
  // of those is missing so traffic routers / smoke tests can avoid sending
  // requests that would fail.
  app.get(
    '/readyz',
    asyncHandler(async (_req: Request, res: Response) => {
      const supabase = await checkSupabase();
      const commitments = checkCommitmentsConfig(config);
      const ok = supabase.connected && commitments.configured;
      const body: ReadinessResponse = {
        ok,
        service: 'ospex-core-api',
        network: config.network,
        chainId: config.chainId,
        supabase,
        commitments,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      };
      res.status(ok ? 200 : 503).json(body);
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
