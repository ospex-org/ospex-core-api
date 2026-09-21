/**
 * `GET /v1/positions/:address` — the wallet history list.
 *
 * This endpoint had no tests at all before `ospex-core-api#76`. These run the
 * real `@supabase/supabase-js` client against a real socket (`fakePostgrest`)
 * rather than a chainable builder mock, for the reason that helper's header
 * gives: the things most likely to be wrong here are the paging window, the
 * `Prefer: count=exact` that makes the wallet count exact rather than absent,
 * and the order clause — none of which a builder mock can see. (Measured here
 * rather than assumed: `.range()` travels as `offset`/`limit` query params, not
 * as a `Range` header. The fake was written the other way round first.)
 *
 * ## The contract under test
 *
 * `totals.totalCount` is the whole WALLET. `totals.totalRiskUSDC`,
 * `totals.totalProfitUSDC` and `totals.activeCount` are the returned PAGE. They
 * sit under one key whose name implies otherwise, which is what #76 is about,
 * and the fix is `page` — the same three numbers under names that carry their
 * own scope. Both shapes are asserted together, because the old names are
 * retained for installed clients and a reader has to be able to trust that they
 * are the same numbers rather than a second derivation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  applyFilters,
  expectReached,
  startFakePostgrest,
  type CapturedRequest,
  type FakePostgrest,
  type FakeReply,
} from './helpers/fakePostgrest.js';

const ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';

/**
 * Three fixture properties, each chosen to kill a specific wrong implementation.
 *
 * 1. **Every page figure differs from every other page's.** A page sum that
 *    repeats cannot be told from a wallet sum that happened to agree, and an
 *    unclaimed count identical on each page would pass on a handler that counted
 *    the whole wallet. Per page the unclaimed counts are 1, 2, 0.
 *
 * 2. **Risk and profit differ on every page**, so swapping the two columns is
 *    visible rather than symmetric.
 *
 * 3. **The sums are ones float64 gets wrong**, which the obvious fixture is not.
 *    The first draft used values like 10.11 + 20.22, and that sum is exact in
 *    binary — so a build that dropped `Math.round(x * 100) / 100` served the
 *    identical number and the whole rounding rule was untested. Here
 *    0.1 + 0.2 is 0.30000000000000004 and 0.7 + 0.1 is 0.7999999999999999, so
 *    the rounding is load-bearing on pages 1 and 2. Page 3 is a single value and
 *    deliberately cannot discriminate it; it is here for the short-terminal-page
 *    case instead.
 *
 * Row 3 is shaped like a settled loss: unclaimed forever with positive
 * historical risk, which is why the count is named for what it counts.
 */
const ROWS = [
  { id: 1, risk: '100000', profit: '300000', claimed: false },
  { id: 2, risk: '200000', profit: '600000', claimed: true },
  { id: 3, risk: '700000', profit: '100000', claimed: false },
  { id: 4, risk: '100000', profit: '200000', claimed: false },
  { id: 5, risk: '550000', profit: '700000', claimed: true },
].map((r, i) => ({
  speculation_id: r.id,
  user_address: ADDR,
  network: 'polygon',
  position_type: 'upper',
  risk_amount: r.risk,
  profit_amount: r.profit,
  claimed: r.claimed,
  // Descending order is what the handler asks for; the fixture is pre-sorted so
  // a page slice matches, and the order CLAUSE is asserted separately.
  position_created_at: `2026-09-${String(20 - i).padStart(2, '0')}T00:00:00+00:00`,
}));

function scaleRows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    ...ROWS[i % ROWS.length]!,
    speculation_id: i + 1,
    position_created_at: `2026-09-20T00:00:${String(i % 60).padStart(2, '0')}+00:00`,
  }));
}

const open: FakePostgrest[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
  vi.useRealTimers();
  vi.resetModules();
});

async function call(
  query: Record<string, string> = {},
  rows: Array<Record<string, unknown>> = ROWS,
  override?: (req: CapturedRequest, index: number) => FakeReply | undefined,
): Promise<{ fake: FakePostgrest; body: Record<string, unknown>; status: number }> {
  const fake = await startFakePostgrest((req, index) => {
    const forced = override?.(req, index);
    if (forced !== undefined) return forced;
    const matched = applyFilters(rows, req.params);
    // Honour the window the way PostgREST does, so a handler that asked for the
    // wrong one gets the wrong one rather than the whole set. `applyFilters`
    // treats `limit`/`offset` as reserved, so the slice is ours to apply.
    //
    // Measured against the real client rather than assumed: `.range(from, to)`
    // travels as `offset=` and `limit=` QUERY PARAMS, not as a `Range` header.
    // The first draft of this fake read `req.headers.range`, found nothing, and
    // returned every row to every page — which made the page figures identical
    // on all three pages and would have passed a handler that ignored paging
    // entirely.
    const from = Number(req.params.get('offset') ?? '0');
    const limit = req.params.get('limit');
    const slice = matched.slice(from, limit === null ? undefined : from + Number(limit));
    return {
      status: 206,
      body: slice,
      contentRange:
        slice.length === 0
          ? `*/${String(matched.length)}`
          : `${String(from)}-${String(from + slice.length - 1)}/${String(matched.length)}`,
    };
  });
  open.push(fake);

  vi.resetModules();
  vi.doMock('../src/lib/env.js', () => ({
    loadConfig: () => ({
      supabaseUrl: fake.url,
      supabaseServiceRoleKey: 'test-key',
      network: 'polygon',
    }),
  }));
  vi.doMock('../src/lib/logger.js', () => ({ logger: { error: vi.fn() }, formatError: String }));

  const { getPositionsByAddressHandler } = await import('../src/v1/positions.js');
  const res = {
    statusCode: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; return this; },
  };
  await getPositionsByAddressHandler(
    { params: { address: ADDR }, query } as unknown as Request,
    res as unknown as Response,
  );
  return { fake, body: res.body, status: res.statusCode };
}

describe('history list — parameter handling', () => {
  it('refuses a malformed address before touching the database', async () => {
    const fake = await startFakePostgrest(() => ({ body: [] }));
    open.push(fake);
    vi.resetModules();
    vi.doMock('../src/lib/env.js', () => ({
      loadConfig: () => ({ supabaseUrl: fake.url, supabaseServiceRoleKey: 'k', network: 'polygon' }),
    }));
    const { getPositionsByAddressHandler } = await import('../src/v1/positions.js');
    const res = {
      statusCode: 0, body: {} as Record<string, unknown>,
      status(c: number) { this.statusCode = c; return this; },
      json(b: Record<string, unknown>) { this.body = b; return this; },
    };
    await getPositionsByAddressHandler(
      { params: { address: 'nope' }, query: {} } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
    // The refusal is BEFORE the query, not after it — otherwise a bad address
    // still costs a statement.
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ['limit above the cap', { limit: '201' }],
    ['limit of zero', { limit: '0' }],
    ['a fractional limit', { limit: '1.5' }],
    ['a negative offset', { offset: '-1' }],
  ])('refuses %s', async (_why, query) => {
    const { status, body } = await call(query);
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('asks for exactly the window, the exact count, and the documented order', async () => {
    const { fake } = await call({ limit: '2', offset: '2' });
    expectReached(fake);
    const req = fake.requests[0]!;
    expect(req.path).toBe('/rest/v1/positions');
    // The window travels as query params, and the exact count as a Prefer
    // header — without that header PostgREST omits Content-Range and
    // `totals.totalCount` silently becomes 0 rather than the wallet's size.
    expect(req.params.get('offset')).toBe('2');
    expect(req.params.get('limit')).toBe('2');
    expect(String(req.headers.prefer)).toContain('count=exact');
    expect(req.params.get('order')).toBe('position_created_at.desc.nullslast');
    expect(req.params.get('network')).toBe('eq.polygon');
    expect(req.params.get('user_address')).toBe(`eq.${ADDR}`);
    // Scoped to the wallet at the DATABASE, not filtered in the handler.
    expect(req.rawQuery).toContain('user_address=eq.');
  });
});

describe('history list — page scope versus wallet scope (#76)', () => {
  /**
   * The discriminating table. `totalCount` is identical on all three pages while
   * every page figure differs, so a handler that computed either one from the
   * wrong population fails here. Expectations are literals; deriving them from
   * the fixture with the same loop the handler uses would move with a broken
   * handler instead of catching it.
   */
  const PAGES: Array<{
    query: Record<string, string>;
    count: number;
    riskUSDC: number;
    profitUSDC: number;
    unclaimedCount: number;
    hasMore: boolean;
  }> = [
    { query: { limit: '2', offset: '0' }, count: 2, riskUSDC: 0.3, profitUSDC: 0.9, unclaimedCount: 1, hasMore: true },
    { query: { limit: '2', offset: '2' }, count: 2, riskUSDC: 0.8, profitUSDC: 0.3, unclaimedCount: 2, hasMore: true },
    { query: { limit: '2', offset: '4' }, count: 1, riskUSDC: 0.55, profitUSDC: 0.7, unclaimedCount: 0, hasMore: false },
  ];

  it.each(PAGES)('page at offset $query.offset carries its own figures', async (page) => {
    const { status, body } = await call(page.query);
    expect(status).toBe(200);
    expect(body.page).toEqual({
      count: page.count,
      riskUSDC: page.riskUSDC,
      profitUSDC: page.profitUSDC,
      unclaimedCount: page.unclaimedCount,
    });
    expect(body.pagination).toEqual({
      limit: Number(page.query.limit),
      offset: Number(page.query.offset),
      total: 5,
      hasMore: page.hasMore,
    });
  });

  it('the wallet count is invariant across every page, and the money figures are not', async () => {
    const bodies = await Promise.all(PAGES.map((p) => call(p.query)));
    const totals = bodies.map((b) => b.body.totals as Record<string, number>);
    // One number is the wallet's …
    expect(totals.map((t) => t.totalCount)).toEqual([5, 5, 5]);
    // … and the other three are not, which is the whole finding.
    expect(totals.map((t) => t.totalRiskUSDC)).toEqual([0.3, 0.8, 0.55]);
    expect(totals.map((t) => t.totalProfitUSDC)).toEqual([0.9, 0.3, 0.7]);
    expect(totals.map((t) => t.activeCount)).toEqual([1, 2, 0]);
  });

  it.each(PAGES)('the retained names carry the same numbers as the scoped ones', async (page) => {
    // Not decoration: `totals.*` and `page.*` must be ONE derivation. If they
    // were computed twice they would eventually disagree, and a consumer
    // migrating between the two names would see the endpoint change under it.
    const { body } = await call(page.query);
    const totals = body.totals as Record<string, number>;
    const scoped = body.page as Record<string, number>;
    expect(totals.totalRiskUSDC).toBe(scoped.riskUSDC);
    expect(totals.totalProfitUSDC).toBe(scoped.profitUSDC);
    expect(totals.activeCount).toBe(scoped.unclaimedCount);
    expect(scoped.count).toBe((body.positions as unknown[]).length);
  });

  it('counts an unclaimed settled-loss-shaped row, which is why it is not called active', async () => {
    // Every row on this page is claimed=false with positive historical risk —
    // the shape a settled loss keeps forever, because claimPosition reverts
    // NoPayout and nothing clears the row. This endpoint does not join the
    // speculation, so it cannot tell that from live exposure and must not
    // claim to: /status is the surface that classifies.
    const unclaimed = ROWS.filter((r) => !r.claimed);
    const { body } = await call({ limit: '10' }, unclaimed);
    expect((body.page as Record<string, number>).unclaimedCount).toBe(3);
    expect((body.page as Record<string, number>).count).toBe(3);
  });
});

describe('history list — cost', () => {
  it('costs the same number of statements at two wallet sizes', async () => {
    // production-cost-review.md: the figure that matters is per-request cost and
    // how it grows. A wallet-scoped money total computed by walking pages would
    // fail this, which is why none is served.
    const small = await call({ limit: '50' }, scaleRows(5));
    const large = await call({ limit: '50' }, scaleRows(500));
    expectReached(small.fake);
    expectReached(large.fake);
    expect(small.fake.requests).toHaveLength(1);
    expect(large.fake.requests).toHaveLength(1);
    // And the page itself stays bounded by `limit`, not by the wallet.
    expect((small.body.page as Record<string, number>).count).toBe(5);
    expect((large.body.page as Record<string, number>).count).toBe(50);
    expect((large.body.totals as Record<string, number>).totalCount).toBe(500);
  });
});

describe('history list — failure', () => {
  it('fails closed on a query error rather than serving an empty page', async () => {
    const { status, body } = await call({}, ROWS, () => ({
      status: 500,
      body: { message: 'injected read failure' },
    }));
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR' });
    // No partial shape escapes alongside the error.
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);
  });
});
