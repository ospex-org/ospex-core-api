/**
 * Spawn + supervise a LOCAL core-api process for the load harness. The server is
 * run from source via the tsx loader (`node --import tsx src/server.ts`) with a
 * fully-explicit env (no .env file is loaded), so the run is hermetic and points
 * at the in-harness fake Supabase.
 *
 * SIGTERM note: `proc.kill('SIGTERM')` triggers the server's graceful-shutdown
 * handler on POSIX. On Windows there is no catchable SIGTERM — Node maps
 * `kill()` to TerminateProcess (abrupt). The harness detects this (see
 * `SIGTERM_IS_GRACEFUL`) and scopes the graceful-shutdown assertions to POSIX.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'src', 'server.ts');

/** True only where `kill('SIGTERM')` runs the process's SIGTERM handler. */
export const SIGTERM_IS_GRACEFUL = process.platform !== 'win32';

export interface ServerHandle {
  readonly port: number;
  readonly proc: ChildProcess;
  waitReady(timeoutMs?: number): Promise<void>;
  /** Resolves on process exit with the exit metadata. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; durationMs: number }>;
  sigterm(): void;
  forceKill(): void;
  stderrTail(): string;
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer(env: Record<string, string>, port: number): Promise<ServerHandle> {
  const startedAt = Date.now();
  const proc = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrLines: string[] = [];
  proc.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) if (line.trim()) stderrLines.push(line);
  });
  proc.stdout?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) if (line.trim()) stderrLines.push(line);
  });

  let exitMeta: { code: number | null; signal: NodeJS.Signals | null; durationMs: number } | null = null;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; durationMs: number }>(
    (resolve) => {
      proc.on('exit', (code, signal) => {
        exitMeta = { code, signal, durationMs: Date.now() - startedAt };
        resolve(exitMeta);
      });
    },
  );

  const handle: ServerHandle = {
    port,
    proc,
    exited,
    sigterm: () => proc.kill('SIGTERM'),
    forceKill: () => {
      if (!proc.killed) proc.kill('SIGKILL');
    },
    stderrTail: () => stderrLines.slice(-25).join('\n'),
    async waitReady(timeoutMs = 25_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (exitMeta) {
          throw new Error(
            `server exited before ready (code=${exitMeta.code} signal=${exitMeta.signal}):\n${stderrLines.slice(-25).join('\n')}`,
          );
        }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.status === 200) return;
        } catch {
          /* not up yet */
        }
        if (Date.now() > deadline) {
          throw new Error(`server not ready within ${timeoutMs}ms:\n${stderrLines.slice(-25).join('\n')}`);
        }
        await sleep(200);
      }
    },
  };
  return handle;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
