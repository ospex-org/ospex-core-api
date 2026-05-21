/**
 * Concurrent SSE connection caps. SSE connections are long-lived, so the
 * request-rate limiter is the wrong tool — a single connection is one request
 * that stays open. These caps bound how many streams a single IP (and the
 * process overall) can hold open at once, which is the real abuse/resource
 * surface. Conservative defaults for the MVE; revisit with load evidence.
 */

const MAX_TOTAL = 200;
const MAX_PER_IP = 10;

let total = 0;
const perIp = new Map<string, number>();

export interface AcquireResult {
  ok: boolean;
  scope?: 'total' | 'ip';
}

/** Reserve a connection slot for `ip`. Returns ok:false (with the limiting scope) when full. */
export function acquire(ip: string): AcquireResult {
  if (total >= MAX_TOTAL) return { ok: false, scope: 'total' };
  const n = perIp.get(ip) ?? 0;
  if (n >= MAX_PER_IP) return { ok: false, scope: 'ip' };
  total += 1;
  perIp.set(ip, n + 1);
  return { ok: true };
}

/** Release a slot previously acquired for `ip`. Idempotent-safe against double-release. */
export function release(ip: string): void {
  if (total > 0) total -= 1;
  const n = perIp.get(ip);
  if (n === undefined) return;
  if (n <= 1) perIp.delete(ip);
  else perIp.set(ip, n - 1);
}

export function connectionStats(): { total: number; ips: number; maxTotal: number; maxPerIp: number } {
  return { total, ips: perIp.size, maxTotal: MAX_TOTAL, maxPerIp: MAX_PER_IP };
}

// Test-only reset.
export function __resetConnections(): void {
  total = 0;
  perIp.clear();
}
