/**
 * The benchmark single-flight memo.
 *
 * The property that actually bounds amplification is SINGLE FLIGHT, not the
 * TTL: a TTL alone does nothing against a hundred simultaneous first requests,
 * which is the shape of a cold-cache burst. So the first case here is
 * concurrency, and the counter it asserts on is how many times `produce` ran.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  BENCHMARK_CACHE_MAX_ENTRIES,
  BENCHMARK_CACHE_TTL_MS,
  __resetBenchmarkCache,
  benchmarkCacheKey,
  benchmarkCacheSize,
  withBenchmarkCache,
} from '../src/v1/benchmark/cache.js';

afterEach(() => {
  __resetBenchmarkCache();
});

const ok = (body: unknown = { ok: true }): { status: number; body: unknown } => ({
  status: 200,
  body,
});

describe('single flight', () => {
  it('runs the producer once for concurrent identical requests', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const produce = async (): Promise<{ status: number; body: unknown }> => {
      calls += 1;
      await gate;
      return ok({ n: calls });
    };

    const inFlight = Array.from({ length: 25 }, () => withBenchmarkCache('k', produce));
    release?.();
    const results = await Promise.all(inFlight);

    expect(calls).toBe(1);
    for (const r of results) expect(r.body).toEqual({ n: 1 });
  });

  /**
   * Negative control for the case above. Without it, a producer that is simply
   * never called twice for any reason would pass — this proves the counter
   * moves when the key differs, so `calls === 1` above is about sharing.
   */
  it('runs it per distinct key', async () => {
    let calls = 0;
    const produce = (): Promise<{ status: number; body: unknown }> => {
      calls += 1;
      return Promise.resolve(ok());
    };
    await Promise.all([withBenchmarkCache('a', produce), withBenchmarkCache('b', produce)]);
    expect(calls).toBe(2);
  });
});

describe('the freshness window', () => {
  it('serves a stored value inside the TTL and re-produces after it', async () => {
    let calls = 0;
    let now = 1_000_000;
    const clock = (): number => now;
    const produce = (): Promise<{ status: number; body: unknown }> => {
      calls += 1;
      return Promise.resolve(ok({ n: calls }));
    };

    await withBenchmarkCache('k', produce, clock);
    now += BENCHMARK_CACHE_TTL_MS - 1;
    const fresh = await withBenchmarkCache('k', produce, clock);
    expect(calls).toBe(1);
    expect(fresh.body).toEqual({ n: 1 });

    now += 2;
    const stale = await withBenchmarkCache('k', produce, clock);
    expect(calls).toBe(2);
    expect(stale.body).toEqual({ n: 2 });
  });
});

describe('what is not cached', () => {
  /**
   * A 503 from an unapplied migration is not a value. Caching one would extend
   * a transient outage to every caller for the whole window — the opposite of
   * what a cache is for.
   */
  it('does not store a non-200', async () => {
    let calls = 0;
    const produce = (): Promise<{ status: number; body: unknown }> => {
      calls += 1;
      return Promise.resolve({ status: 503, body: { code: 'NOT_READY' } });
    };
    await withBenchmarkCache('k', produce);
    await withBenchmarkCache('k', produce);
    expect(calls).toBe(2);
    expect(benchmarkCacheSize()).toBe(0);
  });

  it('does not store a rejection, and does not poison the next caller', async () => {
    let calls = 0;
    const produce = (): Promise<{ status: number; body: unknown }> => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(ok({ n: calls }));
    };
    await expect(withBenchmarkCache('k', produce)).rejects.toThrow('boom');
    const second = await withBenchmarkCache('k', produce);
    expect(calls).toBe(2);
    expect(second.body).toEqual({ n: 2 });
  });
});

describe('the bound', () => {
  /**
   * `date` is caller-supplied and effectively open, so an unbounded map is a
   * slow memory leak anyone can drive.
   */
  it('evicts oldest-first past the cap', async () => {
    for (let i = 0; i < BENCHMARK_CACHE_MAX_ENTRIES + 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose
      await withBenchmarkCache(`k${String(i)}`, () => Promise.resolve(ok()));
    }
    expect(benchmarkCacheSize()).toBe(BENCHMARK_CACHE_MAX_ENTRIES);
  });
});

describe('the key', () => {
  const req = (query: Record<string, string> = {}): Request => ({ query }) as unknown as Request;
  const config = {
    network: 'polygon',
    benchmarkPublicMinSlateDate: '2026-08-15',
    benchmarkStandingsWindowDays: 60,
    benchmarkStatsMaxAgeSeconds: 172_800,
    benchmarkHeadlineBasis: 'marginAdjusted.gameLevel',
  };

  /**
   * Every input that can change the answer must change the key. A key that
   * omitted the publication date or the policy version would serve one
   * configuration's numbers under another's label for the whole window —
   * exactly when an operator has just changed it and is watching.
   */
  it('changes with every input that changes the answer', () => {
    const base = benchmarkCacheKey('standings', req(), config);
    const variants = [
      benchmarkCacheKey('picks', req(), config),
      benchmarkCacheKey('standings', req({ sport: 'mlb' }), config),
      benchmarkCacheKey('standings', req({ date: '2026-08-15' }), config),
      benchmarkCacheKey('standings', req({ scoringPolicyVersion: 'scoring-v0.6.2' }), config),
      benchmarkCacheKey('standings', req(), { ...config, network: 'amoy' }),
      benchmarkCacheKey('standings', req(), { ...config, benchmarkPublicMinSlateDate: '2026-08-16' }),
      benchmarkCacheKey('standings', req(), { ...config, benchmarkPublicMinSlateDate: undefined }),
      benchmarkCacheKey('standings', req(), { ...config, benchmarkStandingsWindowDays: 30 }),
      benchmarkCacheKey('standings', req(), { ...config, benchmarkStatsMaxAgeSeconds: 3600 }),
      benchmarkCacheKey('standings', req(), { ...config, benchmarkHeadlineBasis: 'economic.perPick' }),
    ];
    for (const v of variants) expect(v).not.toBe(base);
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  /** A param the handlers ignore must not fragment the cache. */
  it('ignores query params nothing reads', () => {
    expect(benchmarkCacheKey('standings', req({ cacheBust: '1' }), config)).toBe(
      benchmarkCacheKey('standings', req(), config),
    );
  });

  /**
   * REVIEW ROUND 2. The key must not normalise a value the handler does not.
   * `scoringPolicyVersion` is compared byte for byte against the stored
   * string, so `Scoring-V0.6.2` and `scoring-v0.6.2` are two different
   * requests — the first cut lower-cased the key and served one request's
   * answer under the other's label for the whole window.
   */
  it('keys scoringPolicyVersion on its exact spelling', () => {
    expect(benchmarkCacheKey('standings', req({ scoringPolicyVersion: 'Scoring-V0.6.2' }), config)).not.toBe(
      benchmarkCacheKey('standings', req({ scoringPolicyVersion: 'scoring-v0.6.2' }), config),
    );
  });

  /**
   * `sport` IS case-folded by its parser, so `MLB` and `mlb` behave
   * identically and keying them apart costs one extra fan-out. That is the
   * acceptable direction: a key that fragments on a casing the handler treats
   * as the same is a cache miss; a key that merges two inputs the handler
   * treats as different is a wrong answer. The rule is one rule — no
   * normalisation in the key — rather than a per-parameter exception.
   */
  it('keys sport on its exact spelling too, accepting the extra miss', () => {
    expect(benchmarkCacheKey('standings', req({ sport: 'MLB' }), config)).not.toBe(
      benchmarkCacheKey('standings', req({ sport: 'mlb' }), config),
    );
  });
});
