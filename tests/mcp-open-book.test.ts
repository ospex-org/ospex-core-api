/**
 * `fetchOpenBook` — the drained open-book read — on the wire.
 *
 * The REAL database client against a fake PostgREST socket, so what is
 * asserted is the request the database received and what the reader made of
 * the answer.
 *
 * The page size and page budget are the shipped ones. Nothing here patches
 * them down to make a boundary easier to reach: the fixtures are simply large
 * enough to cross it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectReached, type CapturedRequest, type FakePostgrest, type FakeReply } from './helpers/fakePostgrest.js';
import { NETWORK, NOW_MS, configFor, hash, quoteRow, startBook, type Row } from './helpers/mcpBook.js';

const open: FakePostgrest[] = [];

afterEach(async () => {
  for (const fake of open.splice(0)) await fake.close();
  vi.doUnmock('../src/lib/env.js');
  vi.doUnmock('../src/lib/logger.js');
  vi.resetModules();
});

async function reader(
  rows: Row[],
  override?: (request: CapturedRequest, index: number) => FakeReply | undefined,
): Promise<{
  fake: FakePostgrest;
  log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  read: (contestIds: string[]) => Promise<import('../src/v1/commitments.js').OpenBookRead>;
  limits: { pageRows: number; maxPages: number; maxContests: number };
}> {
  const fake = await startBook({ commitments: rows }, override);
  open.push(fake);
  const config = configFor(fake);
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  vi.resetModules();
  vi.doMock('../src/lib/env.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/lib/env.js')>()),
    loadConfig: () => config,
  }));
  vi.doMock('../src/lib/logger.js', () => ({ logger: log, formatError: String }));
  const { getSupabase } = await import('../src/lib/supabase.js');
  const commitments = await import('../src/v1/commitments.js');
  return {
    fake,
    log,
    read: (contestIds) => commitments.fetchOpenBook(getSupabase(), NETWORK, contestIds, NOW_MS),
    limits: {
      pageRows: commitments.OPEN_BOOK_PAGE_ROWS,
      maxPages: commitments.OPEN_BOOK_MAX_PAGES,
      maxContests: commitments.OPEN_BOOK_MAX_CONTESTS,
    },
  };
}

/** The `index`-th hash in ascending order. */
function nth(index: number): string {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

function quotes(count: number, over: Row = {}): Row[] {
  const rows: Row[] = [];
  for (let index = 1; index <= count; index += 1) rows.push(quoteRow({ commitment_hash: nth(index), ...over }));
  return rows;
}

describe('fetchOpenBook', () => {
  it('ships a page of 999, a budget of 8 pages, and at most 100 contests', async () => {
    const r = await reader([]);
    expect(r.limits).toEqual({ pageRows: 999, maxPages: 8, maxContests: 100 });
  });

  it('asks for open, visible, valid, unexpired quotes on the contests named, by hash', async () => {
    const r = await reader(quotes(3));
    const result = await r.read(['481', '482']);
    expectReached(r.fake);
    expect(result.ok && result.complete).toBe(true);
    expect(result.ok && result.commitments.map((quote) => quote.commitmentHash)).toEqual([nth(1), nth(2), nth(3)]);

    expect(r.fake.requests).toHaveLength(1);
    const params = r.fake.requests[0]!.params;
    expect(r.fake.requests[0]!.path).toBe('/rest/v1/commitments');
    expect(params.get('network')).toBe('eq.polygon');
    expect(params.get('contest_id')).toBe('in.(481,482)');
    expect(params.get('status')).toBe('in.(open,partially_filled)');
    expect(params.get('book_visible')).toBe('eq.true');
    expect(params.get('nonce_invalidated')).toBe('eq.false');
    expect(params.get('expiry')).toBe('gt.2026-09-27T12:00:00.000Z');
    expect(params.get('order')).toBe('commitment_hash.asc');
    expect(params.get('limit')).toBe('999');
    expect(params.has('commitment_hash')).toBe(false);
    // Named columns, the signature among them, and never everything.
    expect(params.get('select')).toContain('signature');
    expect(params.get('select')).toContain('book_visible');
    expect(params.get('select')).not.toContain('*');
  });

  it('leaves out what the filters exclude', async () => {
    const r = await reader([
      quoteRow({ commitment_hash: nth(1) }),
      quoteRow({ commitment_hash: nth(2), book_visible: false }),
      quoteRow({ commitment_hash: nth(3), nonce_invalidated: true }),
      quoteRow({ commitment_hash: nth(4), status: 'filled' }),
      quoteRow({ commitment_hash: nth(5), status: 'cancelled' }),
      quoteRow({ commitment_hash: nth(6), expiry: '2026-09-27T11:59:59+00:00' }),
      quoteRow({ commitment_hash: nth(7), contest_id: 999 }),
      quoteRow({ commitment_hash: nth(8), network: 'amoy' }),
      quoteRow({ commitment_hash: nth(9), status: 'partially_filled', filled_risk_amount: '100' }),
    ]);
    const result = await r.read(['481']);
    expect(result.ok && result.commitments.map((quote) => quote.commitmentHash)).toEqual([nth(1), nth(9)]);
  });

  it('reads nothing for no contests', async () => {
    const r = await reader(quotes(3));
    expect(await r.read([])).toEqual({ ok: true, commitments: [], complete: true });
    expect(r.fake.requests).toHaveLength(0);
  });

  it('refuses more contests than one read takes, without reading', async () => {
    const r = await reader(quotes(3));
    const ids = Array.from({ length: 101 }, (_, index) => String(index + 1));
    expect(await r.read(ids)).toEqual({ ok: false, error: 'open book read refused: 101 contests in one call' });
    expect(r.fake.requests).toHaveLength(0);
    // One hundred is taken.
    expect((await r.read(ids.slice(0, 100))).ok).toBe(true);
  });

  it('stops after one request when the page comes back short', async () => {
    const r = await reader(quotes(998));
    const result = await r.read(['481']);
    expect(result.ok && result.commitments).toHaveLength(998);
    expect(result.ok && result.complete).toBe(true);
    expect(r.fake.requests).toHaveLength(1);
  });

  it('asks again after a full page, from the last hash it was given', async () => {
    const r = await reader(quotes(1000));
    const result = await r.read(['481']);
    expect(result.ok && result.complete).toBe(true);
    expect(result.ok && result.commitments).toHaveLength(1000);
    expect(result.ok && new Set(result.commitments.map((quote) => quote.commitmentHash)).size).toBe(1000);

    expect(r.fake.requests).toHaveLength(2);
    expect(r.fake.requests[0]!.params.has('commitment_hash')).toBe(false);
    expect(r.fake.requests[1]!.params.get('commitment_hash')).toBe(`gt.${nth(999)}`);
    // The second request carries every filter the first did.
    for (const key of ['network', 'contest_id', 'status', 'book_visible', 'nonce_invalidated', 'expiry', 'order', 'limit']) {
      expect(r.fake.requests[1]!.params.get(key)).toBe(r.fake.requests[0]!.params.get(key));
    }
  });

  it('a book of exactly one page costs a second, empty request to know it ended', async () => {
    const r = await reader(quotes(999));
    const result = await r.read(['481']);
    expect(result.ok && result.complete).toBe(true);
    expect(result.ok && result.commitments).toHaveLength(999);
    expect(r.fake.requests).toHaveLength(2);
  });

  it('says the book is incomplete when the page budget runs out, and keeps what it read', async () => {
    const r = await reader(quotes(8 * 999 + 1));
    const result = await r.read(['481']);
    expect(result.ok && result.complete).toBe(false);
    expect(result.ok && result.commitments).toHaveLength(7992);
    // Eight requests, not nine: the budget bounds what is asked.
    expect(r.fake.requests).toHaveLength(8);
    expect(r.log.warn).toHaveBeenCalledWith(
      { network: 'polygon', contests: 1, rows: 7992 },
      'commitments: open book drain ran out of pages, book is incomplete',
    );
  });

  it('is complete at the last row the budget can hold', async () => {
    const r = await reader(quotes(8 * 999 - 1));
    const result = await r.read(['481']);
    expect(result.ok && result.complete).toBe(true);
    expect(result.ok && result.commitments).toHaveLength(7991);
    expect(r.fake.requests).toHaveLength(8);
  });

  it('does not read an answer that is not a list as an empty book', async () => {
    // An object where a list belongs. (A null body would not do: the fake sends `[]` for one.)
    const r = await reader(quotes(3), () => ({ body: { rows: [] } }));
    expect(await r.read(['481'])).toEqual({ ok: false, error: 'open book read did not answer a list' });
    expectReached(r.fake);
  });

  it('refuses a page that comes back out of order', async () => {
    const r = await reader([], () => ({
      body: [quoteRow({ commitment_hash: nth(2) }), quoteRow({ commitment_hash: nth(1) })],
    }));
    expect(await r.read(['481'])).toEqual({
      ok: false,
      error: 'open book read answered a page that does not advance',
    });
  });

  it('refuses a second page that repeats the first instead of looping', async () => {
    const page = quotes(999);
    const r = await reader([], () => ({ body: page }));
    expect(await r.read(['481'])).toEqual({
      ok: false,
      error: 'open book read answered a page that does not advance',
    });
    expect(r.fake.requests).toHaveLength(2);
  });

  it('refuses a page larger than it asked for', async () => {
    const r = await reader([], () => ({ body: quotes(1000) }));
    expect(await r.read(['481'])).toEqual({ ok: false, error: 'open book read answered an oversized page' });
  });

  it('refuses a row with no hash', async () => {
    const r = await reader([], () => ({ body: [quoteRow({ commitment_hash: null })] }));
    expect(await r.read(['481'])).toEqual({ ok: false, error: 'open book read answered a row with no hash' });
  });

  it('drops a hidden row that reaches it, and says so', async () => {
    const r = await reader([], () => ({
      body: [quoteRow({ commitment_hash: nth(1) }), quoteRow({ commitment_hash: nth(2), book_visible: false })],
    }));
    const result = await r.read(['481']);
    expect(result.ok && result.commitments.map((quote) => quote.commitmentHash)).toEqual([nth(1)]);
    expect(r.log.warn).toHaveBeenCalledWith(
      { commitmentHash: nth(2) },
      'commitments: hidden row reached the open book drain — dropped',
    );
  });

  it('passes a failed read on as a failure', async () => {
    // 500, not 503: the database client retries a 503 itself, with a backoff, before reporting it.
    const r = await reader(quotes(3), () => ({ status: 500, body: { message: 'upstream went away' } }));
    expect(await r.read(['481'])).toEqual({ ok: false, error: 'upstream went away' });
  });

  it('fails the whole read when a later page fails, rather than answering with part of it', async () => {
    const r = await reader(quotes(1500), (_request, index) =>
      index === 1 ? { status: 500, body: { message: 'second page failed' } } : undefined,
    );
    expect(await r.read(['481'])).toEqual({ ok: false, error: 'second page failed' });
  });

  it('maps a quote to the public body, remaining risk included', async () => {
    const r = await reader([
      quoteRow({ commitment_hash: hash('a1'), status: 'partially_filled', filled_risk_amount: '1904700' }),
    ]);
    const result = await r.read(['481']);
    expect(result.ok && result.commitments[0]).toMatchObject({
      commitmentHash: hash('a1'),
      contestId: '481',
      positionType: 0,
      oddsTick: 205,
      riskAmount: '5000000',
      filledRiskAmount: '1904700',
      remainingRiskAmount: '3095300',
      status: 'partially_filled',
      bookVisible: true,
    });
  });
});
