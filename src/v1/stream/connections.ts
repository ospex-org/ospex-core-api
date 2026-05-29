/**
 * Concurrent SSE connection caps + the open-stream registry.
 *
 * Caps: SSE connections are long-lived, so the request-rate limiter is the
 * wrong tool — a single connection is one request that stays open. These caps
 * bound how many streams a single IP (and the process overall) can hold open at
 * once, which is the real abuse/resource surface. The defaults are conservative
 * for the MVE; operators tune them at boot via MAX_STREAM_CONNECTIONS_TOTAL /
 * MAX_STREAM_CONNECTIONS_PER_IP (parsed in lib/env.ts, applied through
 * `configureConnectionCaps`) without a code change.
 *
 * Registry: each open SSE response registers a `closer` so a graceful shutdown
 * (SIGTERM) can proactively end every live stream — otherwise `server.close()`
 * blocks on long-lived connections until the force-exit timeout fires.
 */

/** Default caps — the single source of truth; lib/env.ts overrides via configureConnectionCaps. */
export const DEFAULT_MAX_TOTAL = 200;
export const DEFAULT_MAX_PER_IP = 10;

let maxTotal = DEFAULT_MAX_TOTAL;
let maxPerIp = DEFAULT_MAX_PER_IP;

let total = 0;
const perIp = new Map<string, number>();

/** Closers for currently-open SSE responses (one per connection). */
const openStreams = new Set<() => void>();

// Cumulative operational counters — reset only on process restart (process-local
// metrics; see metrics.ts). Surfaced via connectionStats() for /v1/metrics.
let rejectedTotal = 0;
let rejectedByScopeIp = 0;
let rejectedByScopeTotal = 0;
let slowClientShedTotal = 0;

export interface AcquireResult {
  ok: boolean;
  scope?: 'total' | 'ip';
}

/**
 * Override the connection caps. Only the keys provided are changed, so an unset
 * env var leaves that cap at its default. Called once at boot from server.ts.
 */
export function configureConnectionCaps(caps: { maxTotal?: number | undefined; maxPerIp?: number | undefined }): void {
  if (caps.maxTotal !== undefined) maxTotal = caps.maxTotal;
  if (caps.maxPerIp !== undefined) maxPerIp = caps.maxPerIp;
}

/** Reserve a connection slot for `ip`. Returns ok:false (with the limiting scope) when full. */
export function acquire(ip: string): AcquireResult {
  if (total >= maxTotal) {
    rejectedTotal += 1;
    rejectedByScopeTotal += 1;
    return { ok: false, scope: 'total' };
  }
  const n = perIp.get(ip) ?? 0;
  if (n >= maxPerIp) {
    rejectedTotal += 1;
    rejectedByScopeIp += 1;
    return { ok: false, scope: 'ip' };
  }
  total += 1;
  perIp.set(ip, n + 1);
  return { ok: true };
}

/** Record a slow-client shed event (called from common.ts:makeShedIfSlow). Bumps the cumulative counter. */
export function recordSlowClientShed(): void {
  slowClientShedTotal += 1;
}

/** Release a slot previously acquired for `ip`. Idempotent-safe against double-release. */
export function release(ip: string): void {
  const n = perIp.get(ip);
  if (n === undefined) return; // nothing held for this ip — don't touch the total
  if (total > 0) total -= 1;
  if (n <= 1) perIp.delete(ip);
  else perIp.set(ip, n - 1);
}

/**
 * Register an open SSE response's `closer` (emits a final frame and ends the
 * response). Returns a deregister fn the handler MUST call on cleanup so the
 * registry doesn't leak entries for closed connections.
 */
export function registerStream(closer: () => void): () => void {
  openStreams.add(closer);
  return () => {
    openStreams.delete(closer);
  };
}

/** Proactively close every open SSE response (graceful shutdown). Best-effort. */
export function closeAllStreams(): void {
  // Snapshot first: a closer ends its response → 'close' → cleanup → deregister,
  // which mutates `openStreams` while we'd otherwise be iterating it.
  for (const closer of [...openStreams]) {
    try {
      closer();
    } catch {
      /* a closer that throws must not block the rest of the shutdown */
    }
  }
  openStreams.clear();
}

export function connectionStats(): {
  total: number;
  ips: number;
  maxTotal: number;
  maxPerIp: number;
  rejectedTotal: number;
  rejectedByScope: { ip: number; total: number };
  slowClientShedTotal: number;
} {
  return {
    total,
    ips: perIp.size,
    maxTotal,
    maxPerIp,
    rejectedTotal,
    rejectedByScope: { ip: rejectedByScopeIp, total: rejectedByScopeTotal },
    slowClientShedTotal,
  };
}

// Test-only reset — clears live state and restores the default caps.
// Also zeros the cumulative counters so tests can assert exact values.
export function __resetConnections(): void {
  total = 0;
  perIp.clear();
  openStreams.clear();
  maxTotal = DEFAULT_MAX_TOTAL;
  maxPerIp = DEFAULT_MAX_PER_IP;
  rejectedTotal = 0;
  rejectedByScopeIp = 0;
  rejectedByScopeTotal = 0;
  slowClientShedTotal = 0;
}
