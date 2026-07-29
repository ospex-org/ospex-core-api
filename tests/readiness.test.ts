/**
 * `/readyz` dependency probe.
 *
 * The property under test: when the `contests_effective` view is absent, the
 * probe must report NOT ready. Deploying ahead of the indexer migration that
 * creates the view produces a dyno that boots, answers `/readyz` with 200, and
 * fails every contest query at the DB layer.
 *
 * ## Why these tests drive a REAL Supabase client
 *
 * An earlier version of this suite mocked the query BUILDER and handed
 * `checkDependencies` a fabricated `{ code: 'PGRST205' }` error object. That is
 * a cooperating fake: the defect lived one layer down, in the TRANSPORT. The
 * probe used `{ head: true }`, which sends an HTTP HEAD; a HEAD response has no
 * body; postgrest-js fails to parse the empty body and rewrites a bodyless 404
 * to `status: 204, error: null`. The real client would therefore have DISCARDED
 * the very error object the mock injected, and `/readyz` reported the view
 * present while it did not exist — through a full suite that was green.
 *
 * So every probe test below constructs a real `SupabaseClient` over an injected
 * `fetch` and asserts on what `checkDependencies` makes of an actual `Response`.
 * `processResponse` runs for real; the HEAD-vs-GET distinction is observable;
 * and re-adding `{ head: true }` turns these red.
 *
 * Paired negative control throughout: a healthy probe must still report ready,
 * otherwise these assertions would pass against a probe broken to fail always.
 */
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
vi.mock('../src/lib/supabase.js', () => supabaseMock);

const { checkDependencies, isReady, CONTESTS_VIEW } = await import('../src/lib/readiness.js');

// ── real-transport harness ──────────────────────────────────────────────

interface SeenRequest {
  url: string;
  method: string;
  /** `Prefer` request header — where postgrest-js puts `count`, NOT the URL. */
  prefer: string;
}

/**
 * A real `SupabaseClient` whose only fake is `fetch`. Everything downstream of
 * the HTTP boundary — URL building, header negotiation, `processResponse` —
 * is the production code path.
 */
function realClientOver(handler: (method: string, url: string) => Response): {
  client: unknown;
  requests: SeenRequest[];
} {
  const requests: SeenRequest[] = [];
  const fetchImpl = async (
    input: unknown,
    init?: { method?: string; headers?: HeadersInit },
  ): Promise<Response> => {
    const url = String(typeof input === 'string' ? input : (input as Request).url);
    const method = init?.method ?? (input as Request).method ?? 'GET';
    const prefer = new Headers(init?.headers ?? {}).get('prefer') ?? '';
    requests.push({ url, method, prefer });
    return handler(method, url);
  };
  const client = createClient('http://readiness.test.invalid', 'test-service-role-key', {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: fetchImpl as unknown as typeof fetch },
  });
  return { client, requests };
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What PostgREST really answers a GET for a relation it cannot find. */
const PGRST205_BODY = {
  code: 'PGRST205',
  details: null,
  hint: "Perhaps you meant the table 'public.contests'",
  message: `Could not find the table 'public.${'contests_effective'}' in the schema cache`,
};
/** The raw Postgres undefined_table code, as PostgREST relays it. */
const UNDEFINED_TABLE_BODY = {
  code: '42P01',
  details: null,
  hint: null,
  message: 'relation "public.contests_effective" does not exist',
};

/** A server with the view in place: `.limit(0)` yields an empty rows array. */
const healthy = (): Response => json([], 200);

/**
 * A server WITHOUT the view. Answers a HEAD with no body (HTTP requires it)
 * and a GET with the real PostgREST error body — the asymmetry that made the
 * HEAD probe fail open.
 */
const relationMissing = (method: string): Response =>
  method === 'HEAD' ? new Response(null, { status: 404 }) : json(PGRST205_BODY, 404);

/** A 404 carrying NO body at all, whatever the method (a proxy, not PostgREST). */
const bodylessNotFound = (): Response => new Response('', { status: 404 });

async function probeOver(handler: (method: string, url: string) => Response): Promise<{
  result: Awaited<ReturnType<typeof checkDependencies>>;
  requests: SeenRequest[];
}> {
  const { client, requests } = realClientOver(handler);
  supabaseMock.getSupabase.mockReturnValue(client);
  return { result: await checkDependencies(), requests };
}

// ── the probe's request shape ───────────────────────────────────────────

describe('checkDependencies — the request it issues', () => {
  it('probes contests_effective, not the base contests table', async () => {
    const { requests } = await probeOver(healthy);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain(`/rest/v1/${CONTESTS_VIEW}`);
    // The base table would be `/rest/v1/contests?…` — the view's name is a
    // prefix-superset, so match on the delimiter to keep this non-vacuous.
    expect(requests[0]!.url).not.toMatch(/\/rest\/v1\/contests\?/);
  });

  it('uses a body-preserving GET, never a HEAD', async () => {
    // The guard on the actual defect. A HEAD 404 has no body, and postgrest-js
    // rewrites a bodyless 404 to `204 / error: null` — so a HEAD probe cannot
    // see a missing relation at all. Re-adding `{ head: true }` fails here and
    // in the missing-view cases below.
    const { requests } = await probeOver(healthy);
    expect(requests[0]!.method).toBe('GET');
    expect(requests.map((r) => r.method)).not.toContain('HEAD');
  });

  it('asks for no rows and no count', async () => {
    // `limit=0` keeps it row-less; an exact count would make the probe scan
    // the view on every readiness poll.
    //
    // NOTE `count` is negotiated in the `Prefer` REQUEST HEADER, not the query
    // string — asserting `url` does not contain "count" is vacuous and stays
    // green with `{ count: 'exact' }` restored. Assert the header.
    const { requests } = await probeOver(healthy);
    expect(requests[0]!.url).toContain('limit=0');
    expect(requests[0]!.prefer).not.toContain('count=');
  });
});

// ── the verdicts ────────────────────────────────────────────────────────

describe('checkDependencies — verdicts over a real transport', () => {
  it('NEGATIVE CONTROL: the view present → connected AND present', async () => {
    const { result } = await probeOver(healthy);
    expect(result.supabase.connected).toBe(true);
    expect(result.contestsView.present).toBe(true);
    expect(result.contestsView.error).toBeUndefined();
  });

  it('the view missing (real PostgREST PGRST205 body) → connected, present FALSE', async () => {
    const { result } = await probeOver(relationMissing);
    // The round trip happened, so the transport is genuinely fine…
    expect(result.supabase.connected).toBe(true);
    // …but readiness must still fail, on this term.
    expect(result.contestsView.present).toBe(false);
    expect(result.contestsView.error).toContain(CONTESTS_VIEW);
    expect(result.contestsView.error).toContain('PGRST205');
  });

  it('the view missing (raw 42P01 body) → connected, present FALSE', async () => {
    const { result } = await probeOver(() => json(UNDEFINED_TABLE_BODY, 404));
    expect(result.supabase.connected).toBe(true);
    expect(result.contestsView.present).toBe(false);
    expect(result.contestsView.error).toContain('42P01');
  });

  it('a 404 with an EMPTY body → connected, present FALSE (the transport rewrite)', async () => {
    // THE REGRESSION TEST. postgrest-js turns a bodyless 404 into
    // `status: 204, data: null, error: null` — a shape identical to success
    // for anything that only checks `error`. This is what the HEAD probe saw
    // on EVERY missing-relation response, and it is still reachable on a GET
    // when something upstream of PostgREST answers the 404.
    //
    // Only a positive check — "a healthy probe returns a rows ARRAY" — can
    // tell the two apart. If `checkDependencies` goes back to trusting a null
    // `error`, this goes red.
    const { result } = await probeOver(bodylessNotFound);
    expect(result.supabase.connected).toBe(true);
    expect(result.contestsView.present).toBe(false);
    expect(result.contestsView.error).toContain(CONTESTS_VIEW);
  });

  it('any other PostgREST error reports NOT connected', async () => {
    const { result } = await probeOver(() =>
      json({ code: 'PGRST301', details: null, hint: null, message: 'JWT expired' }, 401),
    );
    expect(result.supabase.connected).toBe(false);
    expect(result.contestsView.present).toBe(false);
    expect(result.supabase.error).toBe('JWT expired');
  });

  it('a thrown transport failure reports NOT connected', async () => {
    const { client } = realClientOver(healthy);
    void client;
    supabaseMock.getSupabase.mockImplementation(() => {
      throw new Error('ECONNREFUSED');
    });
    const result = await checkDependencies();
    expect(result.supabase.connected).toBe(false);
    expect(result.contestsView.present).toBe(false);
    expect(result.supabase.error).toContain('ECONNREFUSED');
  });

  it(
    'a fetch that rejects mid-flight reports NOT connected (through the retry layer)',
    async () => {
      // Distinct from the case above: the client builds fine and the failure
      // comes from the network call itself, which is the realistic outage
      // shape. postgrest-js retries a rejected fetch on idempotent methods
      // (GET/HEAD/OPTIONS) up to 3 times with 1s/2s/4s backoff, so this takes
      // ~7s of wall clock and then surfaces `status: 0` with an error whose
      // `code` is the empty string — which must NOT be mistaken for either a
      // relation-missing code or a success.
      //
      // That latency is a property of the client library and applies equally
      // to the previous HEAD probe (both methods are retryable), so it is not
      // a regression introduced by the GET — but it does mean `/readyz` takes
      // ~7s to answer while Supabase is unreachable.
      const { client, requests } = realClientOver(() => {
        throw new Error('socket hang up');
      });
      supabaseMock.getSupabase.mockReturnValue(client);
      const result = await checkDependencies();
      expect(result.supabase.connected).toBe(false);
      expect(result.contestsView.present).toBe(false);
      // Pins the retry count so a library upgrade that changes it is visible
      // here rather than as a mysterious readiness-latency change.
      expect(requests).toHaveLength(4);
    },
    15_000,
  );
});

// ── the composed verdict ────────────────────────────────────────────────

describe('isReady — the /readyz verdict requires all three terms', () => {
  // `isReady` is the exact expression `/readyz` composes (server.ts calls
  // main() at module scope and starts a listener, so it cannot be imported;
  // the verdict lives in lib/readiness.ts precisely so it can be tested).
  const deps = (connected: boolean, present: boolean): Parameters<typeof isReady>[0] => ({
    supabase: { connected },
    contestsView: { present },
  });

  it('all three true → ready', () => {
    expect(isReady(deps(true, true), { configured: true })).toBe(true);
  });
  it('view missing → NOT ready even when everything else is fine', () => {
    expect(isReady(deps(true, false), { configured: true })).toBe(false);
  });
  it('supabase down → NOT ready', () => {
    expect(isReady(deps(false, true), { configured: true })).toBe(false);
  });
  it('commitments unconfigured → NOT ready', () => {
    expect(isReady(deps(true, true), { configured: false })).toBe(false);
  });
});

describe('end to end: a missing view makes the composed verdict NOT ready', () => {
  it('PostgREST relation-not-found → isReady is false', async () => {
    const { result } = await probeOver(relationMissing);
    expect(isReady(result, { configured: true })).toBe(false);
  });

  it('body-less 404 → isReady is false', async () => {
    const { result } = await probeOver(bodylessNotFound);
    expect(isReady(result, { configured: true })).toBe(false);
  });

  it('NEGATIVE CONTROL: a healthy probe → isReady is true', async () => {
    const { result } = await probeOver(healthy);
    expect(isReady(result, { configured: true })).toBe(true);
  });
});
