/**
 * `fetchOpenBook`, the drained open-book read, and `fetchMakerBacking`, the
 * funding read beside it, on the wire.
 *
 * The REAL database client against a fake PostgREST socket, so what is
 * asserted is the request the database received and what the reader made of
 * the answer.
 *
 * The page size and page budget are the shipped ones. Nothing here patches
 * them down to make a boundary easier to reach: the fixtures are simply large
 * enough to cross it.
 *
 * Timeouts. The first case of the file pays the cold import of the modules
 * under test, and the cases that serve thousands of rows do real work, so each
 * of those carries its own timeout. Every other case runs at the default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectReached, type CapturedRequest, type FakePostgrest, type FakeReply } from './helpers/fakePostgrest.js';
import {
  MAKER_A,
  MAKER_B,
  NETWORK,
  NOW_MS,
  configFor,
  fundingRow,
  hash,
  quoteRow,
  startBook,
  type Row,
} from './helpers/mcpBook.js';

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
    // Measured between 0.3 s and 1.1 s on a laptop, nearly all of it the cold import.
  }, 15_000);

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
    // Eight requests and 7,993 rows. Measured between 140 and 350 ms on a laptop.
  }, 20_000);

  it('is complete at the last row the budget can hold', async () => {
    const r = await reader(quotes(8 * 999 - 1));
    const result = await r.read(['481']);
    expect(result.ok && result.complete).toBe(true);
    expect(result.ok && result.commitments).toHaveLength(7991);
    expect(r.fake.requests).toHaveLength(8);
    // Eight requests and 7,991 rows. Measured between 140 and 350 ms on a laptop.
  }, 20_000);

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

  for (const missing of [{ name: 'null', hash: null }, { name: 'an empty string', hash: '' }]) {
    it(`refuses a row whose hash is ${missing.name}`, async () => {
      const r = await reader([], () => ({ body: [quoteRow({ commitment_hash: missing.hash })] }));
      expect(await r.read(['481'])).toEqual({ ok: false, error: 'open book read answered a row with no hash' });
    });
  }

  it('labels a quote by the clock it was given, not by the wall clock', async () => {
    // The quote expires one second after the fixture's "now", and the wall
    // clock is set a day past that. Read against the fixture's clock it is
    // open; read against the wall clock it would be expired.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS + 86_400_000);
    try {
      const r = await reader([quoteRow({ commitment_hash: nth(1), expiry: '2026-09-27T12:00:01+00:00' })]);
      const result = await r.read(['481']);
      expectReached(r.fake);
      expect(r.fake.requests[0]!.params.get('expiry')).toBe('gt.2026-09-27T12:00:00.000Z');
      expect(result.ok && result.commitments.map((quote) => [quote.commitmentHash, quote.status])).toEqual([
        [nth(1), 'open'],
      ]);
    } finally {
      vi.useRealTimers();
    }
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

/**
 * What a quote's three exact columns can arrive as.
 *
 * The database answers `risk_amount`, `filled_risk_amount` and `nonce` as JSON
 * numbers, and the fake sends whatever the fixture holds through
 * `JSON.stringify`, so a number here is a number on the wire and a string is a
 * string. The other two columns of each swept row keep the fixture's defaults:
 * risk `5000000`, filled `0`, nonce `1790000000`.
 */
const COLUMNS = ['risk_amount', 'filled_risk_amount', 'nonce'] as const;
type Column = (typeof COLUMNS)[number];

const DROPPED_MESSAGE = 'commitments: open book row carries a number that did not arrive exact — dropped';

/** Shapes that did not arrive exact. Each is refused in any of the three columns. */
const INEXACT: Array<{ name: string; value: unknown }> = [
  { name: 'the number 1e21', value: 1e21 },
  { name: 'the number 2^53', value: 9007199254740992 },
  { name: 'a negative number', value: -5 },
  { name: 'a number with a fraction', value: 12.5 },
  { name: 'the string 1e+21', value: '1e+21' },
  { name: 'the string 12.5', value: '12.5' },
  { name: 'the string -5', value: '-5' },
  { name: 'an empty string', value: '' },
  // Not a number and not a string. `String([5])` is `5`, so a reader that
  // tested the digits of whatever it was given, rather than of a string, would
  // read a list as an exact amount.
  { name: 'a list holding the number 5', value: [5] },
];

interface Amounts {
  riskAmount: string;
  filledRiskAmount: string;
  remainingRiskAmount: string;
  nonce: string;
}

/**
 * Shapes that are taken, and the body each gives in each column, written out.
 * Remaining risk is risk less filled and never below zero, so a filled amount
 * above the default risk of 5000000 leaves `0`.
 */
const EXACT: Array<{ name: string; value: unknown; body: Record<Column, Amounts> }> = [
  {
    name: 'the number 2^53 - 1',
    value: 9007199254740991,
    body: {
      risk_amount: {
        riskAmount: '9007199254740991',
        filledRiskAmount: '0',
        remainingRiskAmount: '9007199254740991',
        nonce: '1790000000',
      },
      filled_risk_amount: {
        riskAmount: '5000000',
        filledRiskAmount: '9007199254740991',
        remainingRiskAmount: '0',
        nonce: '1790000000',
      },
      nonce: {
        riskAmount: '5000000',
        filledRiskAmount: '0',
        remainingRiskAmount: '5000000',
        nonce: '9007199254740991',
      },
    },
  },
  {
    name: 'the number 0',
    value: 0,
    body: {
      risk_amount: { riskAmount: '0', filledRiskAmount: '0', remainingRiskAmount: '0', nonce: '1790000000' },
      filled_risk_amount: {
        riskAmount: '5000000',
        filledRiskAmount: '0',
        remainingRiskAmount: '5000000',
        nonce: '1790000000',
      },
      nonce: { riskAmount: '5000000', filledRiskAmount: '0', remainingRiskAmount: '5000000', nonce: '0' },
    },
  },
  {
    name: 'a string of 30 digits',
    value: '123456789012345678901234567890',
    body: {
      risk_amount: {
        riskAmount: '123456789012345678901234567890',
        filledRiskAmount: '0',
        remainingRiskAmount: '123456789012345678901234567890',
        nonce: '1790000000',
      },
      filled_risk_amount: {
        riskAmount: '5000000',
        filledRiskAmount: '123456789012345678901234567890',
        remainingRiskAmount: '0',
        nonce: '1790000000',
      },
      nonce: {
        riskAmount: '5000000',
        filledRiskAmount: '0',
        remainingRiskAmount: '5000000',
        nonce: '123456789012345678901234567890',
      },
    },
  },
  {
    name: 'null',
    value: null,
    body: {
      risk_amount: { riskAmount: '0', filledRiskAmount: '0', remainingRiskAmount: '0', nonce: '1790000000' },
      filled_risk_amount: {
        riskAmount: '5000000',
        filledRiskAmount: '0',
        remainingRiskAmount: '5000000',
        nonce: '1790000000',
      },
      nonce: { riskAmount: '5000000', filledRiskAmount: '0', remainingRiskAmount: '5000000', nonce: '0' },
    },
  },
  {
    // The key is left off the row: `JSON.stringify` drops a property holding
    // `undefined`, so the wire carries no such column. Read as null is.
    name: 'absent from the row',
    value: undefined,
    body: {
      risk_amount: { riskAmount: '0', filledRiskAmount: '0', remainingRiskAmount: '0', nonce: '1790000000' },
      filled_risk_amount: {
        riskAmount: '5000000',
        filledRiskAmount: '0',
        remainingRiskAmount: '5000000',
        nonce: '1790000000',
      },
      nonce: { riskAmount: '5000000', filledRiskAmount: '0', remainingRiskAmount: '5000000', nonce: '0' },
    },
  },
];

/** The four amount fields of a body, and its hash. */
function amountsOf(quote: {
  commitmentHash: string;
  riskAmount: string;
  filledRiskAmount: string;
  remainingRiskAmount: string;
  nonce: string;
}): Amounts & { commitmentHash: string } {
  return {
    commitmentHash: quote.commitmentHash,
    riskAmount: quote.riskAmount,
    filledRiskAmount: quote.filledRiskAmount,
    remainingRiskAmount: quote.remainingRiskAmount,
    nonce: quote.nonce,
  };
}

/** What an untouched fixture quote reads as. */
const DEFAULT_AMOUNTS: Amounts = {
  riskAmount: '5000000',
  filledRiskAmount: '0',
  remainingRiskAmount: '5000000',
  nonce: '1790000000',
};

describe('fetchOpenBook: a column that did not arrive exact', () => {
  it('the swept values are what their names say, and cross the wire as they are', () => {
    expect(9007199254740992).toBe(2 ** 53);
    expect(9007199254740991).toBe(2 ** 53 - 1);
    expect(1e21).toBe(10 ** 21);
    expect('123456789012345678901234567890').toHaveLength(30);
    // The fake answers with JSON.stringify, and the client reads with JSON.parse.
    expect(JSON.stringify([1e21, 9007199254740992, 9007199254740991, -5, 12.5, 0])).toBe(
      '[1e+21,9007199254740992,9007199254740991,-5,12.5,0]',
    );
    expect(JSON.parse('[1e+21,9007199254740992]')).toEqual([1e21, 9007199254740992]);
    expect(JSON.stringify({ risk_amount: undefined, nonce: null })).toBe('{"nonce":null}');
    expect(String([5])).toBe('5');
  });

  for (const column of COLUMNS) {
    for (const shape of INEXACT) {
      it(`drops a quote whose ${column} is ${shape.name}, and serves the quotes either side of it`, async () => {
        const r = await reader([
          quoteRow({ commitment_hash: nth(1) }),
          quoteRow({ commitment_hash: nth(2), [column]: shape.value }),
          quoteRow({ commitment_hash: nth(3) }),
        ]);
        const result = await r.read(['481']);
        expectReached(r.fake);
        expect(result.ok && result.complete).toBe(true);
        expect(result.ok && result.commitments.map(amountsOf)).toEqual([
          { commitmentHash: nth(1), ...DEFAULT_AMOUNTS },
          { commitmentHash: nth(3), ...DEFAULT_AMOUNTS },
        ]);
        expect(r.log.warn.mock.calls).toEqual([[{ commitmentHash: nth(2) }, DROPPED_MESSAGE]]);
        expect(r.log.error).not.toHaveBeenCalled();
        expect(r.fake.requests).toHaveLength(1);
      });
    }

    for (const shape of EXACT) {
      it(`keeps a quote whose ${column} is ${shape.name}, with every digit`, async () => {
        const r = await reader([
          quoteRow({ commitment_hash: nth(1) }),
          quoteRow({ commitment_hash: nth(2), [column]: shape.value }),
          quoteRow({ commitment_hash: nth(3) }),
        ]);
        const result = await r.read(['481']);
        expectReached(r.fake);
        expect(result.ok && result.commitments.map(amountsOf)).toEqual([
          { commitmentHash: nth(1), ...DEFAULT_AMOUNTS },
          { commitmentHash: nth(2), ...shape.body[column] },
          { commitmentHash: nth(3), ...DEFAULT_AMOUNTS },
        ]);
        expect(r.log.warn).not.toHaveBeenCalled();
      });
    }
  }

  it('keeps the amounts the database sends as plain numbers', async () => {
    // The shape a real answer has: all three columns as JSON numbers.
    const r = await reader([
      quoteRow({ commitment_hash: nth(1), risk_amount: 5000000, filled_risk_amount: 1904700, nonce: 1790000000 }),
    ]);
    const result = await r.read(['481']);
    expect(result.ok && result.commitments.map(amountsOf)).toEqual([
      {
        commitmentHash: nth(1),
        riskAmount: '5000000',
        filledRiskAmount: '1904700',
        remainingRiskAmount: '3095300',
        nonce: '1790000000',
      },
    ]);
    expect(r.log.warn).not.toHaveBeenCalled();
  });

  // The place of the dropped row in the page. The rows before it are served as
  // well as the rows after it, so neither a reader that stops at the row nor
  // one that discards what it had can pass all three.
  for (const place of [
    { name: 'first', dropped: 1, served: [2, 3, 4] },
    { name: 'in the middle', dropped: 3, served: [1, 2, 4] },
    { name: 'last', dropped: 4, served: [1, 2, 3] },
  ]) {
    it(`serves the rest of a page whose dropped row is ${place.name}`, async () => {
      const r = await reader(
        [1, 2, 3, 4].map((index) =>
          quoteRow({ commitment_hash: nth(index), ...(index === place.dropped ? { risk_amount: 1e21 } : {}) }),
        ),
      );
      const result = await r.read(['481']);
      expectReached(r.fake);
      expect(result.ok && result.complete).toBe(true);
      expect(result.ok && result.commitments.map((quote) => quote.commitmentHash)).toEqual(place.served.map(nth));
      expect(r.log.warn.mock.calls).toEqual([[{ commitmentHash: nth(place.dropped) }, DROPPED_MESSAGE]]);
      expect(r.fake.requests).toHaveLength(1);
    });
  }

  it('drops each of several rows on one page by its own hash', async () => {
    const r = await reader([
      quoteRow({ commitment_hash: nth(1), nonce: 9007199254740992 }),
      quoteRow({ commitment_hash: nth(2) }),
      quoteRow({ commitment_hash: nth(3), filled_risk_amount: '12.5' }),
    ]);
    const result = await r.read(['481']);
    expect(result.ok && result.commitments.map((quote) => quote.commitmentHash)).toEqual([nth(2)]);
    expect(r.log.warn.mock.calls).toEqual([
      [{ commitmentHash: nth(1) }, DROPPED_MESSAGE],
      [{ commitmentHash: nth(3) }, DROPPED_MESSAGE],
    ]);
  });

  it('says the same sentence for a number too large, a negative, a fraction and a string that is not digits', async () => {
    // One sentence for every shape: it names what the rows have in common, not
    // which rule each one broke.
    const r = await reader([
      quoteRow({ commitment_hash: nth(1), risk_amount: 1e21 }),
      quoteRow({ commitment_hash: nth(2), filled_risk_amount: -5 }),
      quoteRow({ commitment_hash: nth(3) }),
      quoteRow({ commitment_hash: nth(4), nonce: 12.5 }),
      quoteRow({ commitment_hash: nth(5), risk_amount: 'ten' }),
    ]);
    const result = await r.read(['481']);
    expectReached(r.fake);
    expect(result.ok && result.commitments.map(amountsOf)).toEqual([{ commitmentHash: nth(3), ...DEFAULT_AMOUNTS }]);
    expect(r.log.warn.mock.calls).toEqual([
      [{ commitmentHash: nth(1) }, 'commitments: open book row carries a number that did not arrive exact — dropped'],
      [{ commitmentHash: nth(2) }, 'commitments: open book row carries a number that did not arrive exact — dropped'],
      [{ commitmentHash: nth(4) }, 'commitments: open book row carries a number that did not arrive exact — dropped'],
      [{ commitmentHash: nth(5) }, 'commitments: open book row carries a number that did not arrive exact — dropped'],
    ]);
    expect(r.log.error).not.toHaveBeenCalled();
  });

  it(
    'moves the cursor past a dropped row that ends a full page, and serves the rows after it',
    async () => {
      // 1002 quotes. The 999th, the last row of the first page, did not arrive
      // exact. Were the cursor left on the row before it, the second request
      // would ask after the 998th hash and be served the dropped row again.
      const rows = quotes(1002);
      rows[998] = quoteRow({ commitment_hash: nth(999), risk_amount: 1e21 });
      expect(rows[998]!['commitment_hash']).toBe(
        '0x00000000000000000000000000000000000000000000000000000000000003e7',
      );
      const r = await reader(rows);
      const result = await r.read(['481']);

      expect(result.ok && result.complete).toBe(true);
      expect(result.ok && result.commitments).toHaveLength(1001);
      const served = result.ok ? result.commitments.map((quote) => quote.commitmentHash) : [];
      expect(served).not.toContain(nth(999));
      expect(served.slice(997)).toEqual([nth(998), nth(1000), nth(1001), nth(1002)]);

      expect(r.fake.requests).toHaveLength(2);
      expect(r.fake.requests[0]!.params.has('commitment_hash')).toBe(false);
      expect(r.fake.requests[1]!.params.get('commitment_hash')).toBe(
        'gt.0x00000000000000000000000000000000000000000000000000000000000003e7',
      );
      // Dropped once: it was served on one page only.
      expect(r.log.warn.mock.calls).toEqual([[{ commitmentHash: nth(999) }, DROPPED_MESSAGE]]);
    },
    // Two requests and 1002 rows. Measured at about 40 ms on a laptop.
    20_000,
  );
});

describe('fetchOpenBook: a page that starts on the cursor row', () => {
  it(
    'refuses a second page whose first row is the row the request asked to be after',
    async () => {
      // The second request asks for hashes after the 999th. An answer that
      // begins with the 999th itself and then goes on upward is ascending, and
      // every row of it is at or above the cursor, so only the comparison with
      // the cursor row itself can refuse it.
      const first = quotes(999);
      const second = [quoteRow({ commitment_hash: nth(999) }), quoteRow({ commitment_hash: nth(1000) })];
      const r = await reader([], (_request, index) => ({ body: index === 0 ? first : second }));

      expect(await r.read(['481'])).toEqual({
        ok: false,
        error: 'open book read answered a page that does not advance',
      });
      expect(r.fake.requests).toHaveLength(2);
      expect(r.fake.requests[1]!.params.get('commitment_hash')).toBe(
        'gt.0x00000000000000000000000000000000000000000000000000000000000003e7',
      );
    },
    // Two requests and 1001 rows. Measured at about 40 ms on a laptop.
    20_000,
  );

  it(
    'takes a second page whose first row is the next hash after the cursor row',
    async () => {
      const first = quotes(999);
      const second = [quoteRow({ commitment_hash: nth(1000) }), quoteRow({ commitment_hash: nth(1001) })];
      const r = await reader([], (_request, index) => ({ body: index === 0 ? first : second }));

      const result = await r.read(['481']);
      expect(result.ok && result.complete).toBe(true);
      expect(result.ok && result.commitments).toHaveLength(1001);
      expect(result.ok && result.commitments.slice(998).map((quote) => quote.commitmentHash)).toEqual([
        nth(999),
        nth(1000),
        nth(1001),
      ]);
      expect(r.fake.requests).toHaveLength(2);
    },
    // Two requests and 1001 rows. Measured at about 40 ms on a laptop.
    20_000,
  );
});

// ── fetchMakerBacking ───────────────────────────────────────────────────

const SNAPSHOT_UNREADABLE = 'commitments: maker_funding snapshot could not be read — funding unknown';
const LOOKUP_FAILED = 'commitments: maker_funding lookup failed — fillability degraded to unknown';

async function backingReader(
  rows: Row[],
  override?: (request: CapturedRequest, index: number) => FakeReply | undefined,
): Promise<{
  fake: FakePostgrest;
  log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  read: (makers: string[]) => Promise<Map<string, { backing: bigint; fresh: boolean }>>;
  staleMs: number;
}> {
  const fake = await startBook({ maker_funding: rows }, override);
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
    read: (makers) => commitments.fetchMakerBacking(getSupabase(), NETWORK, makers, NOW_MS),
    staleMs: commitments.FILLABILITY_STALE_MS,
  };
}

describe('fetchMakerBacking', () => {
  it('asks for the snapshots of the makers named, lowercased and once each, on the network named', async () => {
    const r = await backingReader([
      fundingRow(),
      fundingRow({ maker_address: MAKER_B, backing_wei6: '2500000' }),
      // The same maker on the other network, with a different backing.
      fundingRow({ network: 'amoy', backing_wei6: '900000000000' }),
    ]);
    // One maker, named twice in two spellings.
    const result = await r.read(['0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', MAKER_A]);
    expectReached(r.fake);

    expect(r.fake.requests).toHaveLength(1);
    expect(r.fake.requests[0]!.path).toBe('/rest/v1/maker_funding');
    expect(r.fake.requests[0]!.params.get('network')).toBe('eq.polygon');
    expect(r.fake.requests[0]!.params.get('maker_address')).toBe('in.(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)');
    expect([...result]).toEqual([[MAKER_A, { backing: 1000000000n, fresh: true }]]);
    expect(r.log.error).not.toHaveBeenCalled();
  });

  it('answers each maker its own backing, whether it arrives as digits or as a number', async () => {
    const r = await backingReader([
      fundingRow({ backing_wei6: 1000000000, visible_committed_wei6: 10000000 }),
      fundingRow({ maker_address: MAKER_B, backing_wei6: '123456789012345678901234567890' }),
    ]);
    const result = await r.read([MAKER_A, MAKER_B]);
    expect(result.size).toBe(2);
    expect(result.get(MAKER_A)).toEqual({ backing: 1000000000n, fresh: true });
    expect(result.get(MAKER_B)).toEqual({ backing: 123456789012345678901234567890n, fresh: true });
  });

  it('keys the answer by the lowercased address, however the snapshot spells it', async () => {
    const r = await backingReader([], () => ({
      body: [fundingRow({ maker_address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })],
    }));
    const result = await r.read([MAKER_A]);
    expectReached(r.fake);
    expect([...result.keys()]).toEqual([MAKER_A]);
  });

  it('reads nothing for no makers', async () => {
    const r = await backingReader([fundingRow()]);
    expect((await r.read([])).size).toBe(0);
    expect(r.fake.requests).toHaveLength(0);
  });

  for (const column of ['visible_committed_wei6', 'backing_wei6']) {
    it(`answers no funding at all when a snapshot's ${column} is the number 1e21, and says so`, async () => {
      const r = await backingReader([
        fundingRow({ [column]: 1e21 }),
        fundingRow({ maker_address: MAKER_B, backing_wei6: '2500000' }),
      ]);

      // Both makers in one call: the snapshot that cannot be read takes the
      // well-formed one beside it, so funding is unknown for both.
      const both = await r.read([MAKER_A, MAKER_B]);
      expect(r.fake.requests).toHaveLength(1);
      expect(both.size).toBe(0);
      // The engine's own wording of the conversion error is not pinned: the
      // line carries some text under `err`, and the fixed sentence.
      expect(r.log.error.mock.calls).toEqual([[{ err: expect.stringMatching(/\S/) }, SNAPSHOT_UNREADABLE]]);

      // The well-formed maker in a call of its own is answered.
      const alone = await r.read([MAKER_B]);
      expect(r.fake.requests).toHaveLength(2);
      expect(r.fake.requests[1]!.params.get('maker_address')).toBe('in.(0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)');
      expect([...alone]).toEqual([[MAKER_B, { backing: 2500000n, fresh: true }]]);
      expect(r.log.error).toHaveBeenCalledTimes(1);
    });
  }

  it('ships a staleness bound of two minutes', async () => {
    const r = await backingReader([]);
    expect(r.staleMs).toBe(120_000);
  });

  // "Now" is 12:00:00.000Z. A snapshot is fresh up to and including two
  // minutes old, which is 11:58:00.000Z.
  for (const age of [
    { name: 'thirty seconds old', updatedAt: '2026-09-27T11:59:30+00:00', fresh: true },
    { name: 'one millisecond short of two minutes old', updatedAt: '2026-09-27T11:58:00.001+00:00', fresh: true },
    { name: 'exactly two minutes old', updatedAt: '2026-09-27T11:58:00.000+00:00', fresh: true },
    { name: 'two minutes and one millisecond old', updatedAt: '2026-09-27T11:57:59.999+00:00', fresh: false },
    { name: 'an hour old', updatedAt: '2026-09-27T11:00:00+00:00', fresh: false },
    { name: 'dated with something that is not a time', updatedAt: 'not a time', fresh: false },
  ]) {
    it(`calls a snapshot ${age.name} ${age.fresh ? 'fresh' : 'stale'}, and answers its backing either way`, async () => {
      const r = await backingReader([fundingRow({ updated_at: age.updatedAt })]);
      const result = await r.read([MAKER_A]);
      expectReached(r.fake);
      expect([...result]).toEqual([[MAKER_A, { backing: 1000000000n, fresh: age.fresh }]]);
      expect(r.log.error).not.toHaveBeenCalled();
    });
  }

  it('answers no funding when the read fails, and says so', async () => {
    // 500, not 503: the database client retries a 503 itself, with a backoff, before reporting it.
    const r = await backingReader([fundingRow()], () => ({ status: 500, body: { message: 'upstream went away' } }));
    const result = await r.read([MAKER_A]);
    expectReached(r.fake);
    expect(result.size).toBe(0);
    expect(r.log.error.mock.calls).toEqual([[{ err: 'upstream went away' }, LOOKUP_FAILED]]);
  });
});
