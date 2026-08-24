/**
 * Single-flight + short-TTL memo for the benchmark read projection.
 *
 * **This is the first read cache in this service, and it is deliberate.** Every
 * other endpoint here answers from one or two PostgREST round trips and needs
 * nothing; these three fan out across several relations and then run a
 * projection over every score row in the window, and `readRateLimit` admits 600
 * requests a minute from a single IP against one Basic dyno.
 *
 * ## Single-flight is the part that matters
 *
 * A TTL alone does nothing on a cold-cache burst: a hundred simultaneous first
 * requests are a hundred simultaneous fan-outs. Sharing the in-flight promise
 * collapses them to one, which is the actual amplification bound. The TTL is
 * the cheaper second half, and it is short because the alternative failure is
 * ugly: the panel review flagged that a key omitting the resolved eligibility
 * would serve the previous policy version's numbers under the new one's label
 * for the whole TTL — precisely when the operator has just published and is
 * watching. So the key carries everything that can change the answer, and the
 * TTL is measured in seconds rather than minutes.
 *
 * ## What is NOT cached
 *
 * Failures. A 503 from an unapplied migration or a 500 from a query error is
 * not a value; caching one would extend a transient outage to everyone for the
 * whole TTL. Only a 200 is stored, and a rejected in-flight promise is removed
 * so the next caller retries rather than inheriting the rejection.
 *
 * ## Bounded, because part of the key is caller-supplied
 *
 * `sport` is a closed set but `date` is any well-formed calendar date, so the
 * key space is effectively open and an unbounded map is a slow memory leak
 * anyone can drive. Entries are capped and evicted oldest-first, the same
 * shape `lib/streamAuth.ts`'s challenge store uses for the same reason.
 */

import type { Request, Response } from 'express';
import { logger } from '../../lib/logger.js';

/** A finished response, as the handlers build it. */
export interface CachedResponse {
  status: number;
  body: unknown;
}

interface Entry {
  /** Resolves to the response. Present while in flight AND after settling. */
  promise: Promise<CachedResponse>;
  /** Epoch ms the value was stored, or null while still in flight. */
  storedAt: number | null;
}

/**
 * Freshness window. Short on purpose — see the header. The underlying data
 * changes at most once a cohort-day, so this is about bounding a burst rather
 * than about hit rate.
 */
export const BENCHMARK_CACHE_TTL_MS = 15_000;

/**
 * Distinct cached answers. Twelve sports x a few hundred dates is the realistic
 * ceiling; well past that and eviction starts, which costs a re-fetch and
 * nothing else.
 */
export const BENCHMARK_CACHE_MAX_ENTRIES = 500;

const entries = new Map<string, Entry>();

/** Test-only: drop everything, so one case cannot serve another's answer. */
export function __resetBenchmarkCache(): void {
  entries.clear();
}

/** Current size — for tests and for the metrics surface. */
export function benchmarkCacheSize(): number {
  return entries.size;
}

/**
 * Produce a response once per key per TTL, and once at a time.
 *
 * @param key      must include EVERY input that can change the answer
 * @param produce  called at most once per miss
 */
export async function withBenchmarkCache(
  key: string,
  produce: () => Promise<CachedResponse>,
  now: () => number = Date.now,
): Promise<CachedResponse> {
  const existing = entries.get(key);
  if (existing !== undefined) {
    // In flight (`storedAt === null`) → join it. Settled and fresh → serve it.
    if (existing.storedAt === null || now() - existing.storedAt < BENCHMARK_CACHE_TTL_MS) {
      return existing.promise;
    }
    entries.delete(key);
  }

  const entry: Entry = { promise: Promise.resolve({ status: 0, body: null }), storedAt: null };
  entry.promise = (async () => {
    const result = await produce();
    if (result.status !== 200) {
      // Not a value. Drop it so the next caller retries rather than inheriting
      // a transient 503 for the rest of the window.
      entries.delete(key);
      return result;
    }
    entry.storedAt = now();
    return result;
  })().catch((err: unknown) => {
    entries.delete(key);
    throw err;
  });

  entries.set(key, entry);

  // Evict oldest-first once over the cap. `Map` preserves insertion order, so
  // the first key is the oldest INSERTION — which is what bounds the map; it is
  // not an LRU and does not need to be.
  while (entries.size > BENCHMARK_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done === true) break;
    entries.delete(oldest.value);
    logger.debug({ evicted: oldest.value }, 'benchmark cache: evicted');
  }

  return entry.promise;
}

/**
 * Serve a benchmark handler through the cache.
 *
 * The handler is unchanged and still writes with `res.status(...).json(...)`;
 * a recording shim captures what it wrote so the result can be shared. The
 * shim implements ONLY those two methods, deliberately: a future handler that
 * set a header or streamed would hit a `TypeError` here rather than silently
 * losing it, which is the failure mode a permissive shim would hide.
 */
export async function serveCachedBenchmark(
  key: string,
  req: Request,
  res: Response,
  handler: (req: Request, res: Response) => Promise<void>,
): Promise<void> {
  const result = await withBenchmarkCache(key, async () => {
    let status = 200;
    let body: unknown = null;
    const recorder = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Response;
    await handler(req, recorder);
    return { status, body };
  });
  res.status(result.status).json(result.body);
}

/**
 * The cache key.
 *
 * Every input that can change the answer, and nothing that cannot. The
 * config values are in it because they can change under a running process
 * (a Heroku config change restarts the dyno, but a test can rebind them, and
 * a key that ignored them would be wrong in exactly the way that is hardest
 * to notice). Unknown query params are ignored rather than keyed, so a
 * cache-busting suffix cannot be used to force a fan-out per request.
 *
 * ## Values are keyed EXACTLY as the handlers read them
 *
 * No normalisation here that the handler does not also perform. The first cut
 * lower-cased every value on the reasoning that `sport` is case-folded by its
 * parser — true — and the same fold silently aliased `scoringPolicyVersion`,
 * which the standings handler compares to the stored string byte for byte.
 * Review showed `Scoring-V0.6.2` and `scoring-v0.6.2` sharing a key: the
 * second request served the first request's answer under the other label for
 * the whole window. A key that fragments on a casing the handler treats as
 * identical costs one extra fan-out; a key that merges two inputs the handler
 * treats as different serves a wrong answer. Only one of those is acceptable.
 *
 * The same rule, one input over: an ABSENT param and an EMPTY one are two
 * different inputs to the handler (`undefined` selects the default version;
 * `''` is a literal), so the key encodes presence — `null` for absent — and
 * is JSON rather than a joined string, because a joined string lets a value
 * that happens to contain the separator (Express passes `%01` through) move a
 * character from one field to the next and collide. Found by an adversarial
 * pass on the first fix.
 */
export function benchmarkCacheKey(
  endpoint: 'standings' | 'picks' | 'stats',
  req: Request,
  config: {
    network: string;
    benchmarkPublicMinSlateDate?: string | undefined;
    benchmarkStandingsWindowDays: number;
    benchmarkStatsMaxAgeSeconds: number;
    benchmarkHeadlineBasis: string;
  },
): string {
  // `String(...)` is exactly the read every handler performs on a present
  // value; `null` marks absence, which `String` cannot.
  const q = (name: string): string | null =>
    req.query[name] === undefined ? null : String(req.query[name]);
  return JSON.stringify([
    endpoint,
    config.network,
    config.benchmarkPublicMinSlateDate ?? null,
    config.benchmarkStandingsWindowDays,
    config.benchmarkStatsMaxAgeSeconds,
    config.benchmarkHeadlineBasis,
    q('sport'),
    q('date'),
    q('scoringPolicyVersion'),
  ]);
}
