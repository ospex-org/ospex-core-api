/**
 * `get_order_status`, run against a database it can actually reach.
 *
 * The harness, the fixture and the clock are in `helpers/mcpTools.ts`.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectReached, requestTo } from './helpers/fakePostgrest.js';
import {
  TAKER,
  fillRow,
  hash,
  quoteRow,
  tableOf,
  type Row,
} from './helpers/mcpBook.js';
import {
  BOOK,
  GAME,
  HOME_QUOTE,
  READ_FAILED,
  closeHarnesses,
  harness,
  lines,
  warmTools,
} from './helpers/mcpTools.js';

beforeAll(warmTools, 60_000);
afterEach(closeHarnesses);


const STATUS_ARGS = { commitmentHash: hash('a1'), takerAddress: undefined };
const LAG = 'A fill is listed once its block is final, usually within about 15 seconds of the transaction confirming.';

describe('get_order_status', () => {
  it('reports a partly taken quote and the fill on it', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'partially_filled', filled_risk_amount: '1904700' })],
      position_fills: [fillRow()],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expectReached(h.fake, 3);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Status: partially filled: part has been taken and the rest can be.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 1.9047 of the 5 USDC the maker put up.',
        'Taking it backs: Under 7.0.',
        'Price for the taker: 1.95.',
        'Still takeable: up to 3.250065 USDC of risk.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'Fills on this quote: 1.',
        `1. ${TAKER} risked 1.999935 USDC to win 1.9047 at 1.95, Sun Sep 27, 9:00 am ET. Transaction ${hash('f1')}`,
        '',
        LAG,
      ),
    });
  });

  it('reads the quote, its fills, then its contest', async () => {
    const h = await harness({ ...BOOK, position_fills: [fillRow()] });
    await h.getOrderStatus(STATUS_ARGS, h.ctx);
    // The contest is read for its names, so its lines are not.
    expect(h.fake.tables()).toEqual(['commitments', 'position_fills', 'contests_effective']);
    expect(requestTo(h.fake, 'commitments')?.params.get('commitment_hash')).toBe(`eq.${hash('a1')}`);
    expect(requestTo(h.fake, 'commitments')?.params.get('network')).toBe('eq.polygon');
    const fills = requestTo(h.fake, 'position_fills');
    expect(fills?.params.get('commitment_hash')).toBe(`eq.${hash('a1')}`);
    expect(fills?.params.get('network')).toBe('eq.polygon');
    expect(fills?.params.get('order')).toBe('row_updated_at.asc,id.asc');
    expect(fills?.params.get('limit')).toBe('1000');
    expect(fills?.params.has('taker_address')).toBe(false);
  });

  it('reports an open quote with nothing taken', async () => {
    const h = await harness(BOOK);
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toBe(
      lines(
        `Quote ${hash('a1')}`,
        'Status: open: it can be taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Taking it backs: Under 7.0.',
        'Price for the taker: 1.95.',
        'Still takeable: up to 5.25 USDC of risk.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    );
  });

  it('lists only one wallet\'s fills when given its address, in any case', async () => {
    const other = '0xdddddddddddddddddddddddddddddddddddddddd';
    const h = await harness({
      ...BOOK,
      position_fills: [
        fillRow(),
        fillRow({ id: 2, taker_address: other, tx_hash: hash('f2'), taker_risk_amount: '1000000', maker_risk_amount: '952300' }),
      ],
    });
    const result = await h.getOrderStatus(
      { commitmentHash: hash('a1').toUpperCase().replace('0X', '0x'), takerAddress: other.toUpperCase().replace('0X', '0x') },
      h.ctx,
    );
    expect(requestTo(h.fake, 'position_fills')?.params.get('taker_address')).toBe(`eq.${other}`);
    expect(requestTo(h.fake, 'commitments')?.params.get('commitment_hash')).toBe(`eq.${hash('a1')}`);
    expect(result.text).toContain(`Fills on this quote by ${other}: 1.`);
    expect(result.text).toContain(`1. ${other} risked 1 USDC to win 0.9523 at 1.95`);
    expect(result.text).not.toContain(TAKER);
  });

  it('says so when that wallet has no fill on the quote', async () => {
    const h = await harness({ ...BOOK, position_fills: [fillRow()] });
    const stranger = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: stranger }, h.ctx);
    expect(result.text).toContain(`No fills on this quote by ${stranger} yet.`);
    expect(result.text).toContain(LAG);
  });

  it('shows what was taken from a quote that then expired', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [
        quoteRow({ status: 'partially_filled', filled_risk_amount: '1904700', expiry: '2026-09-27T11:00:00+00:00' }),
      ],
      position_fills: [fillRow()],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain('Status: expired: it can no longer be taken.');
    expect(result.text).toContain('Taken so far: 1.9047 of the 5 USDC the maker put up.');
    expect(result.text).toContain('Expired Sun Sep 27, 7:00 am ET.');
    expect(result.text).toContain('Fills on this quote: 1.');
    expect(result.text).not.toContain('Still takeable');
  });

  it('reports a filled quote', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'filled', filled_risk_amount: '5000000' })],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain('Status: filled: all of it has been taken.');
    expect(result.text).toContain('Taken so far: 5 of the 5 USDC the maker put up.');
    expect(result.text).not.toContain('Still takeable');
  });

  it('shows no price or size for a quote its maker withdrew, and still lists its fills', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'partially_filled', filled_risk_amount: '1904700', book_visible: false })],
      position_fills: [fillRow()],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Status: cancelled: it can no longer be taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Its maker withdrew it from the book, so its price and size are not shown.',
        'Taken from it before that: 1.9047 USDC of what the maker put up.',
        '',
        'Fills on this quote: 1.',
        `1. ${TAKER} risked 1.999935 USDC to win 1.9047 at 1.95, Sun Sep 27, 9:00 am ET. Transaction ${hash('f1')}`,
        '',
        LAG,
      ),
    });
    expect(result.text).not.toContain('Still takeable');
    expect(result.text).not.toContain('Price for the taker');
    expect(result.text).not.toContain('Expires');
  });

  it('names the teams on a moneyline quote', async () => {
    const h = await harness({ ...BOOK, commitments: [HOME_QUOTE] });
    const result = await h.getOrderStatus({ commitmentHash: hash('a3'), takerAddress: undefined }, h.ctx);
    expect(result.text).toContain('Taking it backs: Philadelphia Phillies (home) to win.');
    expect(result.text).toContain('Price for the taker: 1.67.');
    expect(result.text).toContain('Still takeable: up to 6 USDC of risk.');
  });

  it('says a hash is unknown', async () => {
    const h = await harness(BOOK);
    const result = await h.getOrderStatus({ commitmentHash: hash('ee'), takerAddress: undefined }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(`Ospex has no quote with the hash ${hash('ee')}.`, 'Check that the whole hash was copied.'),
    });
    expect(h.fake.tables()).toEqual(['commitments']);
  });

  it('refuses a hash or an address of the wrong shape, before reading anything', async () => {
    const h = await harness(BOOK);
    for (const commitmentHash of ['', '0x1234', hash('a1').slice(0, -1), `${hash('a1')}0`, hash('a1').replace('0x', ''), `0x${'zz'.repeat(32)}`]) {
      expect(await h.getOrderStatus({ commitmentHash, takerAddress: undefined }, h.ctx)).toEqual({
        isError: true,
        text: 'commitment_hash must be 0x followed by 64 hex characters, as prepare_order gave it.',
      });
    }
    for (const takerAddress of ['0x1234', 'vitalik.eth', `0x${'zz'.repeat(20)}`]) {
      expect(await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress }, h.ctx)).toEqual({
        isError: true,
        text: 'taker_address must be a wallet address: 0x followed by 40 hex characters.',
      });
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  it('treats a blank address as no address', async () => {
    const h = await harness(BOOK);
    const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: '  ' }, h.ctx);
    expect(result.isError).toBe(false);
    expect(requestTo(h.fake, 'position_fills')?.params.has('taker_address')).toBe(false);
  });

  it('says the list may be cut short when it reaches the most one call reads', async () => {
    const many: Row[] = [];
    for (let index = 0; index < 1000; index += 1) {
      many.push(fillRow({ id: index + 1, log_index: index, row_updated_at: `2026-09-27T13:00:05.${String(index).padStart(6, '0')}+00:00` }));
    }
    const h = await harness({ ...BOOK, position_fills: many });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain('Fills on this quote: 1000 (the first 1000; there may be more).');
  });

  it('does not say the list is cut short one fill below that', async () => {
    const many: Row[] = [];
    for (let index = 0; index < 999; index += 1) many.push(fillRow({ id: index + 1, log_index: index }));
    const h = await harness({ ...BOOK, position_fills: many });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain('Fills on this quote: 999.');
    expect(result.text).not.toContain('there may be more');
  });

  it('answers without the names when the contest read fails', async () => {
    const h = await harness(
      { ...BOOK, position_fills: [fillRow()] },
      {
        override: (request) =>
          tableOf(request) === 'contests_effective' ? { status: 500, body: { message: 'names unavailable' } } : undefined,
      },
    );
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Status: open: it can be taken.');
    expect(result.text).toContain('Price for the taker: 1.95.');
    expect(result.text).toContain('Fills on this quote: 1.');
    expect(result.text).not.toContain('Game:');
    expect(result.text).not.toContain('Taking it backs');
    expect(h.log.warn).toHaveBeenCalledWith(
      { err: 'names unavailable' },
      'mcp: get_order_status contest read failed, names omitted',
    );
  });

  for (const table of ['commitments', 'position_fills']) {
    it(`answers with fixed words when the ${table} read fails`, async () => {
      const h = await harness(
        { ...BOOK, position_fills: [fillRow()] },
        {
          override: (request) =>
            tableOf(request) === table ? { status: 500, body: { message: `secret detail about ${table}` } } : undefined,
        },
      );
      const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
      expectReached(h.fake);
      expect(result).toEqual({ isError: true, text: READ_FAILED });
      expect(JSON.stringify(h.log.error.mock.calls)).toContain(`secret detail about ${table}`);
    });
  }
});
