/**
 * Concurrent SSE connection caps + the open-stream registry.
 *
 * Caps: SSE connections are long-lived, so the request-rate limiter is the
 * wrong tool — a single connection is one request that stays open. These caps
 * bound how many streams a single IP (and the process overall) can hold open at
 * once, which is the real abuse/resource surface. The defaults are conservative
 * for the MVE; operators tune them at boot via MAX_STREAM_CONNECTIONS_TOTAL /
 * MAX_STREAM_CONNECTIONS_PER_IP / RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER
 * (parsed in lib/env.ts, applied through `configureConnectionCaps`) without a
 * code change.
 *
 * Reserved owner-auth slots: anonymous public streams (odds + protocol) and the
 * owner-authenticated own-state stream share the per-IP budget, so a burst of
 * anonymous connections from one IP could otherwise exhaust it and 429 a
 * market-maker's own-state reconnect — its most safety-critical stream. To
 * prevent that, `reservedPerIpOwner` of the per-IP slots are reserved for
 * `kind: 'owner'` acquisitions: anonymous streams may occupy at most
 * `(maxPerIp - reservedPerIpOwner)` slots per IP, while owner streams may use
 * the full `maxPerIp` (the reserve is a floor for owner, not a ceiling). With
 * `reservedPerIpOwner = 0` the behavior is the original single shared pool.
 *
 * Registry: each open SSE response registers a `closer` so a graceful shutdown
 * (SIGTERM) can proactively end every live stream — otherwise `server.close()`
 * blocks on long-lived connections until the force-exit timeout fires.
 */

/** Which budget an acquisition draws from. `owner` = the owner-authenticated own-state stream; `anon` = public odds/protocol streams. */
export type StreamKind = 'anon' | 'owner';

/** Default caps — the single source of truth; lib/env.ts overrides via configureConnectionCaps. */
export const DEFAULT_MAX_TOTAL = 200;
export const DEFAULT_MAX_PER_IP = 16;
/** Per-IP slots reserved for owner-auth (own-state) streams that anonymous streams cannot consume. */
export const DEFAULT_RESERVED_PER_IP_OWNER = 3;

let maxTotal = DEFAULT_MAX_TOTAL;
let maxPerIp = DEFAULT_MAX_PER_IP;
let reservedPerIpOwner = DEFAULT_RESERVED_PER_IP_OWNER;

let total = 0;
const perIp = new Map<string, number>();
/** Per-IP count of currently-held `owner` slots (a subset of `perIp`) — drives the anon-can't-touch-the-reserve check. */
const perIpOwner = new Map<string, number>();

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
export function configureConnectionCaps(caps: {
  maxTotal?: number | undefined;
  maxPerIp?: number | undefined;
  reservedPerIpOwner?: number | undefined;
}): void {
  if (caps.maxTotal !== undefined) maxTotal = caps.maxTotal;
  if (caps.maxPerIp !== undefined) maxPerIp = caps.maxPerIp;
  if (caps.reservedPerIpOwner !== undefined) reservedPerIpOwner = caps.reservedPerIpOwner;
}

/**
 * Reserve a per-IP connection slot. `kind` selects the budget: `owner` may use
 * the full per-IP cap; `anon` may use at most `(maxPerIp - reservedPerIpOwner)`
 * so the reserve stays available for the owner-auth own-state stream. Returns
 * ok:false (with the limiting scope) when full. `kind` defaults to `anon`.
 */
export function acquire(ip: string, kind: StreamKind = 'anon'): AcquireResult {
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
  if (kind === 'anon') {
    // Anonymous streams cannot consume the slots reserved for owner-auth.
    // `effectiveReserve` is clamped so a misconfigured reserve >= maxPerIp can
    // never make the anon cap negative (it just shrinks toward 0). With a 0
    // reserve this is the original single shared per-IP pool.
    const effectiveReserve = Math.min(reservedPerIpOwner, maxPerIp);
    const ownerHeld = perIpOwner.get(ip) ?? 0;
    const anonHeld = n - ownerHeld;
    if (anonHeld >= maxPerIp - effectiveReserve) {
      rejectedTotal += 1;
      rejectedByScopeIp += 1;
      return { ok: false, scope: 'ip' };
    }
  }
  total += 1;
  perIp.set(ip, n + 1);
  if (kind === 'owner') perIpOwner.set(ip, (perIpOwner.get(ip) ?? 0) + 1);
  return { ok: true };
}

/** Record a slow-client shed event (called from common.ts:makeShedIfSlow). Bumps the cumulative counter. */
export function recordSlowClientShed(): void {
  slowClientShedTotal += 1;
}

/**
 * Release a slot previously acquired for `ip`. `kind` MUST match the acquiring
 * call so the owner sub-count stays consistent (defaults to `anon`).
 * Idempotent-safe against double-release.
 */
export function release(ip: string, kind: StreamKind = 'anon'): void {
  const n = perIp.get(ip);
  if (n === undefined) return; // nothing held for this ip — don't touch the total
  if (total > 0) total -= 1;
  if (n <= 1) perIp.delete(ip);
  else perIp.set(ip, n - 1);
  if (kind === 'owner') {
    const o = perIpOwner.get(ip) ?? 0;
    if (o <= 1) perIpOwner.delete(ip);
    else perIpOwner.set(ip, o - 1);
  }
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
  reservedPerIpOwner: number;
  rejectedTotal: number;
  rejectedByScope: { ip: number; total: number };
  slowClientShedTotal: number;
} {
  return {
    total,
    ips: perIp.size,
    maxTotal,
    maxPerIp,
    reservedPerIpOwner,
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
  perIpOwner.clear();
  openStreams.clear();
  maxTotal = DEFAULT_MAX_TOTAL;
  maxPerIp = DEFAULT_MAX_PER_IP;
  reservedPerIpOwner = DEFAULT_RESERVED_PER_IP_OWNER;
  rejectedTotal = 0;
  rejectedByScopeIp = 0;
  rejectedByScopeTotal = 0;
  slowClientShedTotal = 0;
}
