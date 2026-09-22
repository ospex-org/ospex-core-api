/**
 * A real PostgREST-shaped HTTP server, so a test can prove what the REAL
 * `@supabase/supabase-js` client actually puts on the wire.
 *
 * ## Why this exists alongside the builder mocks
 *
 * Every other handler test in this repo mocks `getSupabase()` with a hand-rolled
 * chainable object whose terminal is a `then`. That is fine for exercising
 * branches, and it cannot see the thing most likely to be wrong here: the URL.
 * The benchmark reads use embedded resources with an explicitly-named foreign
 * key (`benchmark_decision_reveals!fk_benchmark_reveal_decision` — the
 * unqualified spelling is a hard `PGRST201` against production), filters applied
 * to an embedded parent (`benchmark_decisions.cohort_id=in.(...)`, which only
 * works through `!inner`), and keyset paging. A builder mock returns the
 * fixture no matter what string was passed to `.select()`, so every one of those
 * could be wrong and every test would still be green.
 *
 * So these tests point the real client at a real socket and assert on the
 * REQUESTS RECEIVED — captured on the far side of the client, per
 * `.claude/rules/verification-discipline.md` 3i: probe the call, not the
 * argument you prepared for it.
 *
 * ## Two handle rules, both learned the hard way
 *
 * `unref()` on the server AND on every accepted socket. A fake server hosted
 * in-process holds the event loop open by itself, and a suite that then hangs
 * reads exactly like the code under test failing to finish (rule 3f-handles).
 *
 * And `reachedServer` is asserted, not assumed: a setup failure and a fast
 * success look identical from the caller's side (rule 3b-reach). If the client
 * never connected, `requests` is empty and the assertion says so instead of the
 * test passing on a fixture nobody fetched.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface CapturedRequest {
  method: string;
  /** Path only, e.g. `/rest/v1/benchmark_scores`. */
  path: string;
  /** The raw query string, verbatim and un-decoded — this is the thing under test. */
  rawQuery: string;
  /** Parsed query params. Repeated keys keep every value. */
  params: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
}

/** What to answer for one request. */
export interface FakeReply {
  status?: number;
  body?: unknown;
  /** `Content-Range` value, e.g. `0-999/1299`. Needed for `count: 'exact'`. */
  contentRange?: string;
}

export type Responder = (req: CapturedRequest, index: number) => FakeReply;

export interface FakePostgrest {
  url: string;
  requests: CapturedRequest[];
  /** Table name (first path segment after `/rest/v1/`) of each request, in order. */
  tables: () => string[];
  close: () => Promise<void>;
}

/**
 * Apply the subset of PostgREST filters these tests rely on: `eq`, `gte`, `lte`
 * and `in` on TOP-LEVEL columns.
 *
 * Without this a fixture comes back whatever the query said, and a test for
 * "the gate excludes an out-of-range cohort" passes on a handler that never
 * filtered — the exact shape of a test that is green for the wrong reason. With
 * it, a pushed-down filter is actually exercised.
 *
 * Filters on an EMBEDDED column (`benchmark_decisions.cohort_id=in.(…)`) are
 * deliberately NOT applied: reproducing PostgREST's inner-join semantics here
 * would be a second implementation of the thing under test, and getting it
 * subtly wrong would hide the very `!inner` defect these tests exist to catch.
 * Those are asserted on the query STRING instead — see the handler tests.
 */
export function applyFilters(rows: readonly unknown[], params: URLSearchParams): unknown[] {
  const RESERVED = new Set(['select', 'order', 'limit', 'offset']);
  let out = [...rows];
  for (const [key, raw] of params.entries()) {
    if (RESERVED.has(key) || key.includes('.')) continue;
    const eq = raw.indexOf('.');
    if (eq === -1) continue;
    const op = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    const read = (row: unknown): unknown => (row as Record<string, unknown>)[key];
    if (op === 'eq') {
      out = out.filter((r) => String(read(r)) === value);
    } else if (op === 'gte') {
      out = out.filter((r) => compare(read(r), value) >= 0);
    } else if (op === 'lte') {
      out = out.filter((r) => compare(read(r), value) <= 0);
    } else if (op === 'gt') {
      out = out.filter((r) => compare(read(r), value) > 0);
    } else if (op === 'lt') {
      out = out.filter((r) => compare(read(r), value) < 0);
    } else if (op === 'in') {
      const set = new Set(value.replace(/^\(|\)$/g, '').split(','));
      out = out.filter((r) => set.has(String(read(r))));
    } else if (op === 'is') {
      out = out.filter((r) => (value === 'null' ? read(r) === null : String(read(r)) === value));
    }
  }
  return out;
}

/**
 * Order an ordered comparison the way Postgres would, not the way `String` does.
 *
 * The four ordered operators used to string-compare, which is right for the ISO
 * timestamps and `YYYY-MM-DD` dates these tests mostly filter on and WRONG for a
 * numeric column: `String(950) < String(1000)` is false, because `'9' > '1'`. A
 * keyset cursor on an integer id is exactly that case, so a fake that
 * string-compared would have dropped the wrong half of every page and the paging
 * tests would have been measuring the fake.
 *
 * Numeric only when BOTH sides are finite numbers, so an ISO timestamp — which
 * `Number()` rejects — still compares lexicographically, which for ISO-8601 is
 * the same as chronologically.
 */
function compare(rowValue: unknown, filterValue: string): number {
  const a = typeof rowValue === 'number' ? rowValue : Number(rowValue);
  const b = Number(filterValue);
  if (Number.isFinite(a) && Number.isFinite(b) && String(rowValue).trim() !== '') {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const sa = String(rowValue);
  return sa === filterValue ? 0 : sa < filterValue ? -1 : 1;
}

/**
 * Apply `order` and `limit` — the TRANSFORMS, which `applyFilters` deliberately
 * skips.
 *
 * Opt-in and separate, because it changes what a fixture returns and the tests
 * written before it do not expect it. Where it matters, it matters a lot: a
 * handler that pages by asking for `limit + 1` and serving `limit` cannot be
 * tested against a fake that returns everything regardless — the extra-row probe
 * would appear to work no matter what number the handler actually requested, and
 * a build asking for plain `limit` would pass. Honouring both here is what makes
 * "there is another page" a real assertion instead of a property of the fixture
 * size.
 *
 * `order` is applied before `limit`, last key first, on a stable sort — so a
 * multi-key `order` composes the way PostgREST's does.
 */
export function applyPage(rows: readonly unknown[], params: URLSearchParams): unknown[] {
  let out = [...rows];
  const order = params.get('order');
  if (order !== null && order !== '') {
    for (const clause of order.split(',').reverse()) {
      const [column, ...rest] = clause.split('.');
      if (column === undefined || column === '') continue;
      const descending = rest.includes('desc');
      out.sort((l, r) => {
        const lv = (l as Record<string, unknown>)[column];
        const rv = (r as Record<string, unknown>)[column];
        const c = compare(lv, String(rv));
        return descending ? -c : c;
      });
    }
  }
  const limit = params.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (Number.isFinite(n) && n >= 0) out = out.slice(0, n);
  }
  return out;
}

/**
 * Start a fake PostgREST on an ephemeral port.
 *
 * `respond` is called per request with the captured request and its 0-based
 * index, so a test can hand out successive pages or fail a specific call.
 */
export async function startFakePostgrest(respond: Responder): Promise<FakePostgrest> {
  const requests: CapturedRequest[] = [];

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const raw = req.url ?? '/';
    const qIndex = raw.indexOf('?');
    const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
    const rawQuery = qIndex === -1 ? '' : raw.slice(qIndex + 1);
    const captured: CapturedRequest = {
      method: req.method ?? 'GET',
      path,
      rawQuery,
      params: new URLSearchParams(rawQuery),
      headers: req.headers,
    };
    const index = requests.length;
    requests.push(captured);

    let reply: FakeReply;
    try {
      reply = respond(captured, index);
    } catch (err) {
      // A throwing responder is a BUG IN THE TEST, and it must not present as
      // a PostgREST error the handler might have a branch for — that would let
      // a broken fixture pass as a covered failure path.
      res.writeHead(599, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `fake responder threw: ${String(err)}` }));
      return;
    }

    const status = reply.status ?? 200;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (reply.contentRange !== undefined) headers['content-range'] = reply.contentRange;
    res.writeHead(status, headers);
    res.end(JSON.stringify(reply.body ?? []));
  };

  const server: Server = createServer(handler);
  // Every accepted socket keeps the loop alive on its own — not just the
  // listener. Both must be unref'd or a passing suite still hangs at exit.
  server.on('connection', (socket) => socket.unref());

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  server.unref();

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    tables: () =>
      requests.map((r) => {
        const m = /^\/rest\/v1\/([^/?]+)/.exec(r.path);
        return m?.[1] ?? r.path;
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Assert the client actually reached the server.
 *
 * Call this before any assertion about WHAT was requested. Without it, a
 * connection failure (wrong URL, client not pointed here, a `vi.mock` that
 * replaced the client entirely) leaves `requests` empty and every
 * `expect(...).toContain(...)` over an empty list passes vacuously.
 */
export function expectReached(fake: FakePostgrest, atLeast = 1): void {
  if (fake.requests.length < atLeast) {
    throw new Error(
      `the client never reached the fake PostgREST (${String(fake.requests.length)} request(s), expected at least ${String(atLeast)}). ` +
        'A setup failure and a fast success look identical from the caller — this is the difference.',
    );
  }
}

/** The query params of the Nth request to a given table, or undefined. */
export function requestTo(
  fake: FakePostgrest,
  table: string,
  nth = 0,
): CapturedRequest | undefined {
  return fake.requests.filter((r) => r.path === `/rest/v1/${table}`)[nth];
}
