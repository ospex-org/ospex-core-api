/**
 * `get_order_status`, run against a database it can actually reach.
 *
 * The harness, the fixture and the clock are in `helpers/mcpTools.ts`.
 *
 * Two things are held to throughout. The answer never reads as saying the
 * reader's order was placed when the fills listed are somebody else's. And it
 * never says a quote is left to take when the contest, the start or the quote
 * itself fails a check `prepare_order` makes: the cases that pin what is left
 * of a quote call both tools on one database and compare. Whether the line is
 * open on-chain and whether the maker is funded are `prepare_order`'s alone,
 * and the answer says that `prepare_order` chooses the quote, not that it would
 * take this one.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectReached, requestTo } from './helpers/fakePostgrest.js';
import {
  KEYS,
  MAKER_B,
  SCORERS,
  SIGNATURE,
  TAKER,
  contestRow,
  fillRow,
  fundingRow,
  hash,
  quoteRow,
  speculationRow,
  tableOf,
  type Row,
  type Tables,
} from './helpers/mcpBook.js';
import {
  BOOK,
  GAME,
  HOME_QUOTE,
  PLACED_NOTHING,
  READ_FAILED,
  UNDER_2,
  closeHarnesses,
  harness,
  lines,
  warmTools,
} from './helpers/mcpTools.js';

beforeAll(warmTools, 60_000);
afterEach(closeHarnesses);

const STATUS_ARGS = { commitmentHash: hash('a1'), takerAddress: undefined };
const LAG = 'A fill is listed once its block is final, usually within about 15 seconds of the transaction confirming.';
const EVERY_WALLET =
  "These may be anyone's. Whether one person's order went through shows only with their wallet address as taker_address.";
const ADDRESS_REFUSED = 'taker_address must be a wallet address: 0x followed by 40 hex characters.';

/** The line a prepared order's answer ends its instructions with, at the fixture's clock. */
const PREPARED_AT = 'Prepared Sun Sep 27, 8:00:00 am ET. A fill made at or before then is not this order.';
const CANNOT_OFFER = 'It cannot be offered as it stands, so no order can be prepared against it.';

const OTHER = '0xdddddddddddddddddddddddddddddddddddddddd';
const STRANGER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** The fixture's fill: 1.9047 USDC of maker risk taken for 1.999935, at the quote's price. */
const FILL_LINE = `1. ${TAKER} risked 1.999935 USDC to win 1.9047 USDC at 1.95, Sun Sep 27, 9:00:00 am ET. Transaction ${hash('f1')}`;

/**
 * One quote on one game. `prepare_order` chooses among the quotes of a side,
 * so a book holding this quote alone is what makes its answer an answer about
 * this quote.
 */
function oneQuote(quote: Row = {}, contest: Row = {}): Tables {
  return { ...BOOK, contests_effective: [contestRow(contest)], commitments: [quoteRow(quote)] };
}

describe('get_order_status', () => {
  it('reports a partly taken quote and the fill on it', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'partially_filled', filled_risk_amount: '1904700' })],
      position_fills: [fillRow()],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expectReached(h.fake, 3);
    // Left: 5 - 1.9047 = 3.0953 of maker risk, and at 2.05 a taker risks 1.05
    // for each 1 of it: 3.0953 x 1.05 = 3.250065.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: partially filled: part of it has been taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 1.9047 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 3.250065 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'Fills on this quote, by every wallet that took it: 1.',
        FILL_LINE,
        EVERY_WALLET,
        '',
        LAG,
      ),
    });
  });

  it('reads the quote, its fills, then its contest', async () => {
    const h = await harness({ ...BOOK, position_fills: [fillRow()] });
    await h.getOrderStatus(STATUS_ARGS, h.ctx);
    // The contest is read for its names, status and start, so its lines are not.
    expect(h.fake.tables()).toEqual(['commitments', 'position_fills', 'contests_effective']);
    expect(requestTo(h.fake, 'commitments')?.params.get('commitment_hash')).toBe(`eq.${hash('a1')}`);
    expect(requestTo(h.fake, 'commitments')?.params.get('network')).toBe('eq.polygon');
    const fills = requestTo(h.fake, 'position_fills');
    expect(fills?.params.get('commitment_hash')).toBe(`eq.${hash('a1')}`);
    expect(fills?.params.get('network')).toBe('eq.polygon');
    expect(fills?.params.get('order')).toBe('row_updated_at.asc,id.asc');
    expect(fills?.params.get('limit')).toBe('1000');
    expect(fills?.params.has('taker_address')).toBe(false);
    const contest = requestTo(h.fake, 'contests_effective');
    expect(contest?.params.get('contest_id')).toBe('eq.481');
    expect(contest?.params.get('network')).toBe('eq.polygon');
  });

  it('reads no contest when the service has no scorer addresses, and says nothing about the game', async () => {
    const h = await harness(BOOK, { context: { scorers: undefined } });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(h.fake.tables()).toEqual(['commitments', 'position_fills']);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Price for the taker: 1.95.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
  });

  it('reads no contest for a quote that names none, and says nothing about the game', async () => {
    const h = await harness(oneQuote({ contest_id: null }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(h.fake.tables()).toEqual(['commitments', 'position_fills']);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Price for the taker: 1.95.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
  });

  // ── the network ──────────────────────────────────────────────────────

  it('reads the quote, its fills and its contest on the network it serves and on no other', async () => {
    // Every table holds the same hash or the same contest on two networks, with
    // different values on each. A read that dropped its network filter finds
    // two rows where one is asked for, or lists the other network's fill.
    const h = await harness(
      {
        ...BOOK,
        contests_effective: [
          contestRow(),
          contestRow({ network: 'amoy', away_team: 'Boston Red Sox', home_team: 'New York Yankees' }),
        ],
        commitments: [
          quoteRow(),
          quoteRow({
            network: 'amoy',
            maker: MAKER_B,
            position_type: 'lower',
            odds_tick: 191,
            risk_amount: '10000000',
            filled_risk_amount: '1000000',
            status: 'partially_filled',
          }),
        ],
        position_fills: [
          fillRow(),
          fillRow({
            network: 'amoy',
            id: 2,
            taker_address: OTHER,
            maker_risk_amount: '1000000',
            taker_risk_amount: '910000',
            odds_tick: 191,
            filled_at: '2026-09-27T14:30:00+00:00',
            tx_hash: hash('f2'),
          }),
        ],
      },
      { context: { network: 'amoy' } },
    );
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(h.fake.tables()).toEqual(['commitments', 'position_fills', 'contests_effective']);
    for (const table of ['commitments', 'position_fills', 'contests_effective']) {
      expect(requestTo(h.fake, table)?.params.getAll('network'), table).toEqual(['eq.amoy']);
    }
    // At 1.91 a taker risks 0.91 for each 1 of maker risk: 9 left is 8.19.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: partially filled: part of it has been taken.',
        'Game: Boston Red Sox @ New York Yankees (contest_id 481).',
        'Taken so far: 1 of the 10 USDC the maker put up.',
        'Side for the taker: Over 7.0.',
        'Price for the taker: 2.10.',
        'Left to take: up to 8.19 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'Fills on this quote, by every wallet that took it: 1.',
        `1. ${OTHER} risked 0.91 USDC to win 1 USDC at 2.10, Sun Sep 27, 10:30:00 am ET. Transaction ${hash('f2')}`,
        EVERY_WALLET,
        '',
        LAG,
      ),
    });
  });

  // ── what is left of an open quote ────────────────────────────────────
  //
  // Each case below changes one thing about the fixture, and that one thing
  // is what only its own check can refuse: the game is otherwise verified and
  // hours away, the quote otherwise whole, signed and hours from its expiry.
  // The same tables are then handed to prepare_order, which has to refuse too.

  const GAME_REFUSALS: { name: string; contest: Row; left: string; prepared: string }[] = [
    {
      name: 'a scored contest',
      contest: { contest_status: 'scored' },
      left: 'Its contest is scored, so no order can be prepared against it.',
      prepared: `${GAME} is not open for betting: its contest is scored.`,
    },
    {
      name: 'a voided contest',
      contest: { contest_status: 'voided' },
      left: 'Its contest is voided, so no order can be prepared against it.',
      prepared: `${GAME} is not open for betting: its contest is voided.`,
    },
    {
      name: 'an unverified contest',
      contest: { contest_status: 'unverified' },
      left: 'Its contest is unverified, so no order can be prepared against it.',
      prepared: `${GAME} is not open for betting: its contest is unverified.`,
    },
    {
      name: 'a contest with no status',
      contest: { contest_status: null },
      left: 'Its contest is in an unknown state, so no order can be prepared against it.',
      prepared: `${GAME} is not open for betting: its contest is in an unknown state.`,
    },
    {
      // The view serves a start for this contest, but none was written
      // on-chain. Both tools refuse it and both say that is why.
      name: 'a verified contest with no start written on-chain',
      contest: { start_time: null },
      left: 'Its contest has no start time on-chain, so no order can be prepared against it.',
      prepared: `${GAME} is not open for betting: its contest has no start time on-chain.`,
    },
    {
      // No start on-chain either, but the contest is scored, and that is what
      // both tools name: the missing start is said only of a verified contest.
      name: 'a scored contest with no start written on-chain, by its state',
      contest: { contest_status: 'scored', start_time: null },
      left: 'Its contest is scored, so no order can be prepared against it.',
      prepared: `${GAME} is not open for betting: its contest is scored.`,
    },
    {
      // The contest's state is asked about before its start, as prepare_order
      // asks: a scored game is also one that has started.
      name: 'a scored contest whose game started an hour ago, by its state and not its start',
      contest: { contest_status: 'scored', effective_start_time: '2026-09-27T11:00:00+00:00' },
      left: 'Its contest is scored, so no order can be prepared against it.',
      prepared: `${GAME} is not open for betting: its contest is scored.`,
    },
    {
      name: 'a game with no start time',
      contest: { effective_start_time: null },
      left: 'Its game has no start time Ospex can read, so no order can be prepared against it.',
      prepared: `${GAME} has no start time Ospex can read, so it cannot be bet on.`,
    },
    {
      // The thirtieth of February. A lenient parser reads it as the second of
      // March, which is a start in the future.
      name: 'a game whose start is a day that does not exist',
      contest: { effective_start_time: '2026-02-30T19:05:00+00:00' },
      left: 'Its game has no start time Ospex can read, so no order can be prepared against it.',
      prepared: `${GAME} has no start time Ospex can read, so it cannot be bet on.`,
    },
    {
      name: 'a game that starts now',
      contest: { effective_start_time: '2026-09-27T12:00:00+00:00' },
      left: 'Its game started Sun Sep 27, 8:00 am ET, so no order can be prepared against it.',
      prepared: `${GAME} started Sun Sep 27, 8:00 am ET. No order is prepared on a game under way.`,
    },
    {
      name: 'a game that started an hour ago',
      contest: { effective_start_time: '2026-09-27T11:00:00+00:00' },
      left: 'Its game started Sun Sep 27, 7:00 am ET, so no order can be prepared against it.',
      prepared: `${GAME} started Sun Sep 27, 7:00 am ET. No order is prepared on a game under way.`,
    },
    {
      name: 'a game that starts in exactly two minutes',
      contest: { effective_start_time: '2026-09-27T12:02:00+00:00' },
      left: 'Its game starts Sun Sep 27, 8:02 am ET, less than two minutes from now, which is too close to prepare an order.',
      prepared: `${GAME} starts Sun Sep 27, 8:02 am ET, less than two minutes from now. That is too close to the start to prepare an order.`,
    },
  ];

  for (const { name, contest, left, prepared } of GAME_REFUSALS) {
    it(`says why nothing is on offer for ${name}, and prepare_order refuses the same tables`, async () => {
      const h = await harness(oneQuote({}, contest));
      const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
      expect(result).toEqual({
        isError: false,
        text: lines(
          `Quote ${hash('a1')}`,
          'Quote status: open.',
          `Game: ${GAME} (contest_id 481).`,
          'Taken so far: 0 of the 5 USDC the maker put up.',
          'Side for the taker: Under 7.0.',
          'Price for the taker: 1.95.',
          left,
          'Expires Sun Sep 27, 2:55 pm ET.',
          '',
          'No fills on this quote yet.',
          '',
          LAG,
        ),
      });
      expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
        isError: false,
        text: lines(prepared, PLACED_NOTHING),
      });
    });
  }

  it('says what is left of a quote whose game starts two minutes and one microsecond from now, and prepare_order prepares it', async () => {
    const h = await harness(oneQuote({}, { effective_start_time: '2026-09-27T12:02:00.000001+00:00' }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 5.25 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    const prepared = await h.prepareOrder(UNDER_2, h.ctx);
    expect(prepared.isError).toBe(false);
    expect(prepared.text).toContain(`Take link: https://ospex.org/take/${hash('a1')}?risk=2`);
    expect(prepared.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(prepared.text).toContain(PREPARED_AT);
  });

  it('says what is left of an open quote with nothing taken, and prepare_order prepares it', async () => {
    const h = await harness(oneQuote());
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    // 5 of maker risk at 2.05: a taker risks 1.05 for each 1 of it, 5.25 in all.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 5.25 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    // 2 USDC asked at 2.05: the fill is ceil(2,000,000 x 100 / 105) = 1,904,762,
    // down to the lot below, 1,904,700, which costs floor(1,904,700 x 1.05) = 1,999,935.
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `Under 7.0 — ${GAME}, Sun Sep 27, 3:05 pm ET.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        'A combined score of exactly 7 is a push: the stake is returned.',
        'Quote expires Sun Sep 27, 2:55 pm ET.',
        'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2`,
        'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.',
        PREPARED_AT,
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    });
  });

  it('names as left to take the amount prepare_order cuts a larger order down to', async () => {
    const h = await harness(oneQuote());
    const status = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(status.text).toContain('Left to take: up to 5.25 USDC of taker risk.');
    const whole = await h.prepareOrder({ ...UNDER_2, riskUsdc: 5.25 }, h.ctx);
    expect(whole.text).toContain(`Take link: https://ospex.org/take/${hash('a1')}?risk=5.25\n`);
    expect(whole.text).toContain('Risk 5.25 USDC to win 5.00 at 1.95.');
    expect(whole.text).not.toContain('This quote can take');
    const over = await h.prepareOrder({ ...UNDER_2, riskUsdc: 6 }, h.ctx);
    expect(over.text).toContain(`Take link: https://ospex.org/take/${hash('a1')}?risk=5.25\n`);
    expect(over.text).toContain('This quote can take 5.25 USDC, not the 6 asked for. The order is for 5.25.');
  });

  const NO_QUOTE = `No quote is posted for Under 7.0 on ${GAME} right now.`;
  const TOO_LITTLE = 'Too little of it is left, or too little time before it expires, to prepare an order against it.';

  it('says too little time is left on a quote that expires in exactly two minutes, and prepare_order refuses the same tables', async () => {
    const h = await harness(oneQuote({ expiry: '2026-09-27T12:02:00+00:00' }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        TOO_LITTLE,
        'Expires Sun Sep 27, 8:02 am ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: lines(NO_QUOTE, PLACED_NOTHING) });
  });

  it('says what is left of a quote that expires two minutes and one microsecond from now, and prepare_order prepares it', async () => {
    const h = await harness(oneQuote({ expiry: '2026-09-27T12:02:00.000001+00:00' }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 5.25 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 8:02 am ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    const prepared = await h.prepareOrder(UNDER_2, h.ctx);
    expect(prepared.isError).toBe(false);
    expect(prepared.text).toContain(`Take link: https://ospex.org/take/${hash('a1')}?risk=2`);
  });

  it('says too little is left of a quote one base unit short of a lot, and prepare_order refuses the same tables', async () => {
    // A lot is 100 base units. 5,000,000 - 4,999,901 leaves 99.
    const h = await harness(oneQuote({ status: 'partially_filled', filled_risk_amount: '4999901' }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: partially filled: part of it has been taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 4.999901 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        TOO_LITTLE,
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: lines(NO_QUOTE, PLACED_NOTHING) });
  });

  it('says what is left of a quote with exactly one lot left, and prepare_order prepares it', async () => {
    // 5,000,000 - 4,999,900 leaves 100 base units, which a taker takes with 105.
    const h = await harness(oneQuote({ status: 'partially_filled', filled_risk_amount: '4999900' }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: partially filled: part of it has been taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 4.9999 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 0.000105 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    const prepared = await h.prepareOrder(UNDER_2, h.ctx);
    expect(prepared.isError).toBe(false);
    expect(prepared.text).toContain(`Take link: https://ospex.org/take/${hash('a1')}?risk=0.000105`);
  });

  // Quotes whose signed fields cannot be taken as they stand. The game is open
  // and hours away, and the quote is otherwise the ordinary one: whole, and
  // hours from its expiry, so neither size nor time is the reason.
  const OPEN_BODY = ['Taken so far: 0 of the 5 USDC the maker put up.', 'Side for the taker: Under 7.0.', 'Price for the taker: 1.95.'];
  const QUOTE_REFUSALS: { name: string; quote: Row; status?: string; body: string[] }[] = [
    {
      name: 'with no signature',
      quote: { signature: null },
      body: OPEN_BODY,
    },
    {
      name: 'signed for an amount that is not a whole number of lots',
      quote: { risk_amount: '5000050' },
      body: ['Taken so far: 0 of the 5.00005 USDC the maker put up.', 'Side for the taker: Under 7.0.', 'Price for the taker: 1.95.'],
    },
    {
      // Filed under total 7.0, with the key of total 7.5.
      name: 'filed under one line and signed for another',
      quote: { speculation_key: KEYS['c481-total-75'] },
      body: OPEN_BODY,
    },
    {
      // Filed under total 7.0 with that line's key, but signed by the
      // moneyline scorer: the key its signed fields hash to is another one.
      name: 'filed under a line and signed for another scorer',
      quote: { scorer: SCORERS.moneyline },
      body: OPEN_BODY,
    },
    {
      name: 'filed under no key at all',
      quote: { speculation_key: null },
      body: OPEN_BODY,
    },
    {
      // 1.00 is below the protocol's lowest price, so no taker price is shown.
      name: 'posted at a price below the protocol\'s lowest',
      quote: { odds_tick: 100 },
      body: ['Taken so far: 0 of the 5 USDC the maker put up.', 'Side for the taker: Under 7.0.'],
    },
    {
      // 101.01 is above the protocol's highest price.
      name: 'posted at a price above the protocol\'s highest',
      quote: { odds_tick: 10101 },
      body: ['Taken so far: 0 of the 5 USDC the maker put up.', 'Side for the taker: Under 7.0.'],
    },
    {
      // A filled amount below zero leaves more to take than was signed for.
      name: 'with a filled amount below zero',
      quote: { filled_risk_amount: '-100' },
      body: OPEN_BODY,
    },
    {
      // Exactly one lot is left, which is enough to take, so size is not the
      // reason this one is refused: the missing signature is.
      name: 'with one lot left and no signature',
      quote: { status: 'partially_filled', filled_risk_amount: '4999900', signature: null },
      status: 'Quote status: partially filled: part of it has been taken.',
      body: ['Taken so far: 4.9999 of the 5 USDC the maker put up.', 'Side for the taker: Under 7.0.', 'Price for the taker: 1.95.'],
    },
  ];

  for (const { name, quote, status, body } of QUOTE_REFUSALS) {
    it(`says a quote ${name} cannot be offered as it stands, and prepare_order refuses the same tables`, async () => {
      const h = await harness(oneQuote(quote));
      const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
      expect(result).toEqual({
        isError: false,
        text: lines(
          `Quote ${hash('a1')}`,
          status ?? 'Quote status: open.',
          `Game: ${GAME} (contest_id 481).`,
          ...body,
          'It cannot be offered as it stands, so no order can be prepared against it.',
          'Expires Sun Sep 27, 2:55 pm ET.',
          '',
          'No fills on this quote yet.',
          '',
          LAG,
        ),
      });
      expect(result.text).not.toContain('Left to take');
      expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({ isError: false, text: lines(NO_QUOTE, PLACED_NOTHING) });
    });
  }

  it('says too little is left of a quote one base unit short of a lot even when it also has no signature', async () => {
    // Too little is said whenever size or time would refuse the quote,
    // whatever else would refuse it too.
    const h = await harness(oneQuote({ status: 'partially_filled', filled_risk_amount: '4999901', signature: null }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain(`\n${TOO_LITTLE}\n`);
    expect(result.text).not.toContain(CANNOT_OFFER);
  });

  it('names the game before the quote when both would refuse, as prepare_order does', async () => {
    // The game started an hour ago and the quote carries no signature. Either
    // alone refuses; the game is asked about first, by both tools.
    const h = await harness(oneQuote({ signature: null }, { effective_start_time: '2026-09-27T11:00:00+00:00' }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Its game started Sun Sep 27, 7:00 am ET, so no order can be prepared against it.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} started Sun Sep 27, 7:00 am ET. No order is prepared on a game under way.`, PLACED_NOTHING),
    });
  });

  // The line on-chain and the maker's funds are prepare_order's to look at.
  // For a quote whose line is closed, or whose maker is known to be short,
  // the answer says what is left of the quote and that prepare_order chooses
  // the quote for an order, and does not say prepare_order would take this one.

  it('does not say prepare_order would take a quote whose line is not open on-chain', async () => {
    const h = await harness({
      ...oneQuote(),
      speculations: [speculationRow({ speculation_status: 'closed', win_side: 'upper' })],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    // The line is not read, so nothing about it can be said.
    expect(h.fake.tables()).toEqual(['commitments', 'position_fills', 'contests_effective']);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 5.25 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    expect(result.text).not.toContain('prepare_order prepares an order against it');
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no total line on-chain yet.`, PLACED_NOTHING),
    });
  });

  it('does not say prepare_order would take a quote whose maker is known to have no funds behind it', async () => {
    // A fresh snapshot of nothing at all, so there is no amount the maker covers.
    const h = await harness({ ...oneQuote(), maker_funding: [fundingRow({ backing_wei6: '0' })] });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    // The maker's funds are not read, so nothing about them can be said.
    expect(h.fake.tables()).toEqual(['commitments', 'position_fills', 'contests_effective']);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 5.25 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    expect(result.text).not.toContain('prepare_order prepares an order against it');
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        'A quote is posted for Under 7.0, but its maker does not have the funds behind it right now.',
        PLACED_NOTHING,
      ),
    });
  });

  it('names the teams on a moneyline quote', async () => {
    const h = await harness({ ...BOOK, commitments: [HOME_QUOTE] });
    const result = await h.getOrderStatus({ commitmentHash: hash('a3'), takerAddress: undefined }, h.ctx);
    // The maker is on the away team at 2.50 with 4 USDC: a taker risks 1.50
    // for each 1 of it, 6 in all, at 2.50 / 1.50 = 1.67.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a3')}`,
        'Quote status: open.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 4 USDC the maker put up.',
        'Side for the taker: Philadelphia Phillies (home) to win.',
        'Price for the taker: 1.67.',
        'Left to take: up to 6 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
  });

  it('prints a team name that holds a line break on one line', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [
        contestRow({
          away_team: 'Tampa  Bay\r\n\tRays',
          home_team: 'Philadelphia Phillies\n\nQuote status: filled: all of it has been taken.',
        }),
      ],
      commitments: [HOME_QUOTE],
    });
    const result = await h.getOrderStatus({ commitmentHash: hash('a3'), takerAddress: undefined }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a3')}`,
        'Quote status: open.',
        'Game: Tampa Bay Rays @ Philadelphia Phillies Quote status: filled: all of it has been taken. (contest_id 481).',
        'Taken so far: 0 of the 4 USDC the maker put up.',
        'Side for the taker: Philadelphia Phillies Quote status: filled: all of it has been taken. (home) to win.',
        'Price for the taker: 1.67.',
        'Left to take: up to 6 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    expect(result.text.split('\n').filter((line) => line.startsWith('Quote status:'))).toEqual(['Quote status: open.']);
  });

  const NAMES: { name: string; away: string; home: string; game: string; backs: string }[] = [
    {
      // A zero-width space inside a word is dropped, not turned into a space.
      name: 'an empty away name as its role, and a home name without the zero-width space inside it',
      away: '',
      home: 'Phila​delphia Phillies',
      game: 'Game: Away team @ Philadelphia Phillies (contest_id 481).',
      backs: 'Side for the taker: Philadelphia Phillies (home) to win.',
    },
    {
      // Nothing is left of the home name once what prints as nothing is dropped.
      name: 'an away name without the zero-width space inside it, and a home name of nothing that prints as its role',
      away: 'Tam​pa Bay Rays',
      home: '​ ​',
      game: 'Game: Tampa Bay Rays @ Home team (contest_id 481).',
      backs: 'Side for the taker: Home team (home) to win.',
    },
  ];

  for (const { name, away, home, game, backs } of NAMES) {
    it(`prints ${name}`, async () => {
      const h = await harness({
        ...BOOK,
        contests_effective: [contestRow({ away_team: away, home_team: home })],
        commitments: [HOME_QUOTE],
      });
      const result = await h.getOrderStatus({ commitmentHash: hash('a3'), takerAddress: undefined }, h.ctx);
      expect(result).toEqual({
        isError: false,
        text: lines(
          `Quote ${hash('a3')}`,
          'Quote status: open.',
          game,
          'Taken so far: 0 of the 4 USDC the maker put up.',
          backs,
          'Price for the taker: 1.67.',
          'Left to take: up to 6 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
          'Expires Sun Sep 27, 2:55 pm ET.',
          '',
          'No fills on this quote yet.',
          '',
          LAG,
        ),
      });
      expect(result.text).not.toContain('​');
    });
  }

  // ── a quote that takes no more orders ────────────────────────────────
  //
  // An expiry is said while a quote can take an order, and as the reason it
  // no longer can. A filled or cancelled quote has no expiry line at all.

  const NO_EXPIRY_LINE = ['Expires', 'Expired', 'expiry'];

  it('reports a filled quote with no line about what is left and no expiry', async () => {
    const h = await harness(oneQuote({ status: 'filled', filled_risk_amount: '5000000' }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: filled: all of it has been taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 5 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        '',
        'No fills on this quote. The quote is filled and takes no more orders.',
        '',
        LAG,
      ),
    });
    for (const word of NO_EXPIRY_LINE) expect(result.text, word).not.toContain(word);
  });

  it('reports a cancelled quote with no line about what is left and no expiry', async () => {
    const h = await harness(oneQuote({ status: 'cancelled' }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: cancelled: it can no longer be taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        '',
        'No fills on this quote. The quote is cancelled and takes no more orders.',
        '',
        LAG,
      ),
    });
    for (const word of NO_EXPIRY_LINE) expect(result.text, word).not.toContain(word);
  });

  it('reports a quote its maker invalidated by nonce as cancelled, with no expiry', async () => {
    const h = await harness(oneQuote({ nonce_invalidated: true }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: cancelled: it can no longer be taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        '',
        'No fills on this quote. The quote is cancelled and takes no more orders.',
        '',
        LAG,
      ),
    });
    for (const word of NO_EXPIRY_LINE) expect(result.text, word).not.toContain(word);
  });

  it('reports an expired quote with no fills as taking no more orders, with no line about what is left', async () => {
    const h = await harness(oneQuote({ expiry: '2026-09-27T11:00:00+00:00' }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: expired: it can no longer be taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Expired Sun Sep 27, 7:00 am ET.',
        '',
        'No fills on this quote. The quote is expired and takes no more orders.',
        '',
        LAG,
      ),
    });
  });

  // A status the database is not meant to hold. The shared read passes it
  // through as it is, and the answer says it is not one this tool knows.
  const UNKNOWN_STATUS: { name: string; taker: string | undefined; fills: string }[] = [
    { name: 'with no wallet named', taker: undefined, fills: 'No fills on this quote.' },
    { name: 'for a named wallet', taker: STRANGER, fills: `No fills on this quote by ${STRANGER}.` },
  ];

  for (const { name, taker, fills } of UNKNOWN_STATUS) {
    it(`reports a quote whose status is not one of the five, ${name}, without waiting on it or naming an expiry`, async () => {
      const h = await harness(oneQuote({ status: 'pending' }));
      const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: taker }, h.ctx);
      expect(result).toEqual({
        isError: false,
        text: lines(
          `Quote ${hash('a1')}`,
          'Quote status: pending, which is not a status this tool knows.',
          `Game: ${GAME} (contest_id 481).`,
          'Taken so far: 0 of the 5 USDC the maker put up.',
          'Side for the taker: Under 7.0.',
          'Price for the taker: 1.95.',
          '',
          fills,
          '',
          LAG,
        ),
      });
      for (const word of ['yet', 'Left to take', 'takes no more orders', ...NO_EXPIRY_LINE]) {
        expect(result.text, word).not.toContain(word);
      }
    });
  }

  it('shows what was taken from a quote that then expired', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [
        quoteRow({ status: 'partially_filled', filled_risk_amount: '1904700', expiry: '2026-09-27T11:00:00+00:00' }),
      ],
      position_fills: [fillRow({ filled_at: '2026-09-27T10:00:00+00:00' })],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: expired: it can no longer be taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 1.9047 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Expired Sun Sep 27, 7:00 am ET.',
        '',
        'Fills on this quote, by every wallet that took it: 1.',
        `1. ${TAKER} risked 1.999935 USDC to win 1.9047 USDC at 1.95, Sun Sep 27, 6:00:00 am ET. Transaction ${hash('f1')}`,
        EVERY_WALLET,
        '',
        LAG,
      ),
    });
  });

  it('answers without the game, and without a line about what is left, when the contest read fails', async () => {
    const h = await harness(
      { ...BOOK, position_fills: [fillRow()] },
      {
        override: (request) =>
          tableOf(request) === 'contests_effective' ? { status: 500, body: { message: 'names unavailable' } } : undefined,
      },
    );
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(h.fake.tables()).toEqual(['commitments', 'position_fills', 'contests_effective']);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Price for the taker: 1.95.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'Fills on this quote, by every wallet that took it: 1.',
        FILL_LINE,
        EVERY_WALLET,
        '',
        LAG,
      ),
    });
    expect(h.log.warn).toHaveBeenCalledWith(
      { err: 'names unavailable' },
      'mcp: get_order_status contest read failed, game omitted',
    );
  });

  it('answers without the game, and without a line about what is left, when the contest is not in the database', async () => {
    const h = await harness({ ...BOOK, contests_effective: [contestRow({ contest_id: 482 })] });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(requestTo(h.fake, 'contests_effective')?.params.get('contest_id')).toBe('eq.481');
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Price for the taker: 1.95.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
  });

  // ── whose fills ──────────────────────────────────────────────────────

  it('says the fills are every wallet\'s when no wallet is named, on a quote another wallet took whole', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'filled', filled_risk_amount: '5000000' })],
      position_fills: [fillRow({ maker_risk_amount: '5000000', taker_risk_amount: '5250000' })],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: filled: all of it has been taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 5 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        '',
        'Fills on this quote, by every wallet that took it: 1.',
        `1. ${TAKER} risked 5.25 USDC to win 5 USDC at 1.95, Sun Sep 27, 9:00:00 am ET. Transaction ${hash('f1')}`,
        EVERY_WALLET,
        '',
        LAG,
      ),
    });
    // Nothing here is the reader's order, so nothing here may say one was placed.
    expect(result.text.toLowerCase()).not.toContain('placed');
  });

  it('lists only one wallet\'s fills when given its address, and does not ask for an address again', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'partially_filled', filled_risk_amount: '2857000' })],
      position_fills: [
        fillRow(),
        fillRow({ id: 2, taker_address: OTHER, tx_hash: hash('f2'), taker_risk_amount: '1000000', maker_risk_amount: '952300' }),
      ],
    });
    const result = await h.getOrderStatus(
      { commitmentHash: hash('a1').toUpperCase().replace('0X', '0x'), takerAddress: OTHER },
      h.ctx,
    );
    expect(requestTo(h.fake, 'position_fills')?.params.get('taker_address')).toBe(`eq.${OTHER}`);
    expect(requestTo(h.fake, 'commitments')?.params.get('commitment_hash')).toBe(`eq.${hash('a1')}`);
    // Left: 5 - 2.857 = 2.143 of maker risk, x 1.05 = 2.25015.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: partially filled: part of it has been taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 2.857 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 2.25015 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        `Fills on this quote by ${OTHER}: 1.`,
        `1. ${OTHER} risked 1 USDC to win 0.9523 USDC at 1.95, Sun Sep 27, 9:00:00 am ET. Transaction ${hash('f2')}`,
        '',
        LAG,
      ),
    });
  });

  it('lists two fills by two wallets oldest first, each with its own amounts, price, time and transaction', async () => {
    // One quote fills at one price on-chain. The second fill here carries
    // another, and every other field differs too, so a field printed from the
    // wrong fill or the wrong column shows. The rows are stored newest first.
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'partially_filled', filled_risk_amount: '3104700' })],
      position_fills: [
        fillRow({
          id: 2,
          row_updated_at: '2026-09-27T14:30:05.000001+00:00',
          taker_address: OTHER,
          maker_risk_amount: '1200000',
          taker_risk_amount: '1800000',
          odds_tick: 250,
          filled_at: '2026-09-27T14:30:00+00:00',
          tx_hash: hash('f2'),
          log_index: 3,
        }),
        fillRow(),
      ],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    // Left: 5 - 3.1047 = 1.8953 of maker risk, x 1.05 = 1.990065.
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: partially filled: part of it has been taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 3.1047 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 1.990065 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'Fills on this quote, by every wallet that took it: 2.',
        FILL_LINE,
        `2. ${OTHER} risked 1.8 USDC to win 1.2 USDC at 1.67, Sun Sep 27, 10:30:00 am ET. Transaction ${hash('f2')}`,
        EVERY_WALLET,
        '',
        LAG,
      ),
    });
  });

  it('prints a fill with no price when its price is not one the protocol has', async () => {
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'partially_filled', filled_risk_amount: '1904700' })],
      position_fills: [fillRow({ odds_tick: 100 })],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain(
      `1. ${TAKER} risked 1.999935 USDC to win 1.9047 USDC, Sun Sep 27, 9:00:00 am ET. Transaction ${hash('f1')}`,
    );
  });

  it('prints each fill\'s time to the second, with the seconds it was made at', async () => {
    // Seven seconds past the minute in the morning, forty-two in the afternoon:
    // a clock that drops the seconds, or writes them as zero, shows here.
    const h = await harness({
      ...BOOK,
      commitments: [quoteRow({ status: 'partially_filled', filled_risk_amount: '3104700' })],
      position_fills: [
        fillRow({ filled_at: '2026-09-27T13:00:07+00:00' }),
        fillRow({
          id: 2,
          row_updated_at: '2026-09-27T16:45:50.000001+00:00',
          taker_address: OTHER,
          maker_risk_amount: '1200000',
          taker_risk_amount: '1260000',
          filled_at: '2026-09-27T16:45:42+00:00',
          tx_hash: hash('f2'),
        }),
      ],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain(
      lines(
        'Fills on this quote, by every wallet that took it: 2.',
        `1. ${TAKER} risked 1.999935 USDC to win 1.9047 USDC at 1.95, Sun Sep 27, 9:00:07 am ET. Transaction ${hash('f1')}`,
        `2. ${OTHER} risked 1.26 USDC to win 1.2 USDC at 1.95, Sun Sep 27, 12:45:42 pm ET. Transaction ${hash('f2')}`,
        EVERY_WALLET,
        '',
        LAG,
      ),
    );
  });

  it('tells a wallet\'s fill from an order it prepared later in the same minute', async () => {
    // The wallet took this quote at 8:00:40 and prepares another order on it at
    // 8:00:50. To the minute both read 8:00 am; to the second they differ, and
    // the fill is before the order, so it is not the order.
    const h = await harness(
      {
        ...oneQuote({ status: 'partially_filled', filled_risk_amount: '1904700' }),
        position_fills: [
          fillRow({ filled_at: '2026-09-27T12:00:40+00:00', row_updated_at: '2026-09-27T12:00:45.000001+00:00' }),
        ],
      },
      { context: { nowMs: Date.UTC(2026, 8, 27, 12, 0, 50) } },
    );
    const status = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: TAKER }, h.ctx);
    expect(requestTo(h.fake, 'position_fills')?.params.get('taker_address')).toBe(`eq.${TAKER}`);
    expect(status).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: partially filled: part of it has been taken.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 1.9047 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 3.250065 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        `Fills on this quote by ${TAKER}: 1.`,
        `1. ${TAKER} risked 1.999935 USDC to win 1.9047 USDC at 1.95, Sun Sep 27, 8:00:40 am ET. Transaction ${hash('f1')}`,
        '',
        LAG,
      ),
    });
    const prepared = await h.prepareOrder(UNDER_2, h.ctx);
    expect(prepared.isError).toBe(false);
    expect(prepared.text.split('\n')).toContain(
      'Prepared Sun Sep 27, 8:00:50 am ET. A fill made at or before then is not this order.',
    );
    expect(prepared.text).not.toContain('8:00:40');
  });

  it('closes a list of every wallet\'s fills with the line about whose they may be, in straight quotes', async () => {
    const h = await harness({ ...oneQuote(), position_fills: [fillRow()] });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    const text = result.text.split('\n');
    expect(text.slice(-4)).toEqual([
      FILL_LINE,
      "These may be anyone's. Whether one person's order went through shows only with their wallet address as taker_address.",
      '',
      LAG,
    ]);
    expect(result.text).not.toMatch(/[‘’]/);
    expect(result.text).not.toContain('Pass a wallet address');
  });

  it('does not close one wallet\'s fills with the line about whose they may be', async () => {
    const h = await harness({ ...oneQuote(), position_fills: [fillRow()] });
    const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: TAKER }, h.ctx);
    expect(result.text.split('\n').slice(-4)).toEqual([`Fills on this quote by ${TAKER}: 1.`, FILL_LINE, '', LAG]);
    expect(result.text).not.toContain('anyone');
    expect(result.text).not.toContain('taker_address');
  });

  it('says a wallet has no fill yet on a quote that is still open', async () => {
    const h = await harness({ ...oneQuote(), position_fills: [fillRow()] });
    const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: STRANGER }, h.ctx);
    expect(requestTo(h.fake, 'position_fills')?.params.get('taker_address')).toBe(`eq.${STRANGER}`);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Side for the taker: Under 7.0.',
        'Price for the taker: 1.95.',
        'Left to take: up to 5.25 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        `No fills on this quote by ${STRANGER} yet.`,
        '',
        LAG,
      ),
    });
  });

  // A filled or cancelled quote has no expiry line; an expired one says when.
  const NO_MORE_ORDERS: { word: string; quote: Row; fill: Row; status: string; taken: string; expiry: string[] }[] = [
    {
      word: 'filled',
      quote: { status: 'filled', filled_risk_amount: '5000000' },
      fill: { maker_risk_amount: '5000000', taker_risk_amount: '5250000' },
      status: 'Quote status: filled: all of it has been taken.',
      taken: 'Taken so far: 5 of the 5 USDC the maker put up.',
      expiry: [],
    },
    {
      word: 'cancelled',
      quote: { status: 'cancelled', filled_risk_amount: '1904700' },
      fill: {},
      status: 'Quote status: cancelled: it can no longer be taken.',
      taken: 'Taken so far: 1.9047 of the 5 USDC the maker put up.',
      expiry: [],
    },
    {
      word: 'expired',
      quote: { status: 'partially_filled', filled_risk_amount: '1904700', expiry: '2026-09-27T11:00:00+00:00' },
      fill: { filled_at: '2026-09-27T10:00:00+00:00' },
      status: 'Quote status: expired: it can no longer be taken.',
      taken: 'Taken so far: 1.9047 of the 5 USDC the maker put up.',
      expiry: ['Expired Sun Sep 27, 7:00 am ET.'],
    },
  ];

  for (const { word, quote, fill, status, taken, expiry } of NO_MORE_ORDERS) {
    it(`does not tell a wallet with no fill to wait on a quote that is ${word}`, async () => {
      // What was taken from the quote was taken by another wallet, so the
      // fills read has a row to leave out.
      const h = await harness({ ...oneQuote(quote), position_fills: [fillRow(fill)] });
      const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: STRANGER }, h.ctx);
      expect(requestTo(h.fake, 'position_fills')?.params.get('taker_address')).toBe(`eq.${STRANGER}`);
      expect(result).toEqual({
        isError: false,
        text: lines(
          `Quote ${hash('a1')}`,
          status,
          `Game: ${GAME} (contest_id 481).`,
          taken,
          'Side for the taker: Under 7.0.',
          'Price for the taker: 1.95.',
          ...expiry,
          '',
          `No fills on this quote by ${STRANGER}. The quote is ${word} and takes no more orders.`,
          '',
          LAG,
        ),
      });
      expect(result.text).not.toContain('yet');
    });
  }

  // ── a quote its maker withdrew ───────────────────────────────────────

  it('shows nothing a withdrawn quote was signed with', async () => {
    // Every signed field has a value found nowhere else in the answer: 7.31
    // USDC at 2.35 (1.74 for a taker) on the spread at -1.5.
    const h = await harness({
      ...BOOK,
      commitments: [
        quoteRow({
          book_visible: false,
          scorer: SCORERS.spread,
          market_type: 'spread',
          line_ticks: -15,
          odds_tick: 235,
          risk_amount: '7310000',
          nonce: '1790000123',
          speculation_key: KEYS['c481-spread--15'],
        }),
      ],
    });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: withdrawn from the book by its maker.',
        `Game: ${GAME} (contest_id 481).`,
        'Its maker withdrew it from the book, so its posted price and size are not shown.',
        'Taken from it so far: 0 USDC of what the maker put up.',
        // The expiry is one of the fields a hidden row keeps in public.
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    for (const signed of [
      '7.31',
      '7310000',
      '2.35',
      '1.74',
      '235',
      '1.5',
      'Tampa Bay Rays -',
      'Philadelphia Phillies +',
      SIGNATURE,
      '5a5a',
      '1790000123',
      KEYS['c481-spread--15'],
      SCORERS.spread,
      'Price for the taker',
      'Side for the taker',
      'Taking it backs',
      'Left to take',
    ]) {
      expect(result.text, signed).not.toContain(signed);
    }
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
        'Quote status: withdrawn from the book by its maker.',
        `Game: ${GAME} (contest_id 481).`,
        'Its maker withdrew it from the book, so its posted price and size are not shown.',
        'Taken from it so far: 1.9047 USDC of what the maker put up.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'Fills on this quote, by every wallet that took it: 1.',
        FILL_LINE,
        EVERY_WALLET,
        '',
        LAG,
      ),
    });
  });

  // The expiry is public for a hidden row, so it is said of a withdrawn quote
  // as of any other: while the quote can still take an order, and as the
  // reason it no longer can. A quote that was filled or cancelled has none.
  const WITHDRAWN_THEN: { name: string; quote: Row; status: string; expiry: string[]; fills: string; taken?: string }[] = [
    {
      name: 'expires now as expired',
      quote: { expiry: '2026-09-27T12:00:00+00:00' },
      status: 'Quote status: expired: it can no longer be taken.',
      expiry: ['Expired Sun Sep 27, 8:00 am ET.'],
      fills: 'No fills on this quote. The quote is expired and takes no more orders.',
    },
    {
      name: 'expired an hour ago as expired',
      quote: { expiry: '2026-09-27T11:00:00+00:00' },
      status: 'Quote status: expired: it can no longer be taken.',
      expiry: ['Expired Sun Sep 27, 7:00 am ET.'],
      fills: 'No fills on this quote. The quote is expired and takes no more orders.',
    },
    {
      name: 'has no expiry as expired',
      quote: { expiry: null },
      status: 'Quote status: expired: it can no longer be taken.',
      expiry: [],
      fills: 'No fills on this quote. The quote is expired and takes no more orders.',
    },
    {
      name: 'expires one microsecond from now as withdrawn',
      quote: { expiry: '2026-09-27T12:00:00.000001+00:00' },
      status: 'Quote status: withdrawn from the book by its maker.',
      expiry: ['Expires Sun Sep 27, 8:00 am ET.'],
      fills: 'No fills on this quote yet.',
    },
    {
      name: 'was partly taken and expires later as withdrawn',
      quote: { status: 'partially_filled', filled_risk_amount: '1904700', expiry: '2026-09-27T16:20:00+00:00' },
      status: 'Quote status: withdrawn from the book by its maker.',
      expiry: ['Expires Sun Sep 27, 12:20 pm ET.'],
      fills: 'No fills on this quote yet.',
      taken: '1.9047',
    },
    {
      name: 'was invalidated by its maker\'s nonce floor as cancelled',
      quote: { nonce_invalidated: true },
      status: 'Quote status: cancelled: it can no longer be taken.',
      expiry: [],
      fills: 'No fills on this quote. The quote is cancelled and takes no more orders.',
    },
    {
      // Both are true of it. The nonce floor is the maker's own act and is said first.
      name: 'was invalidated and has also expired as cancelled',
      quote: { nonce_invalidated: true, expiry: '2026-09-27T11:00:00+00:00' },
      status: 'Quote status: cancelled: it can no longer be taken.',
      expiry: [],
      fills: 'No fills on this quote. The quote is cancelled and takes no more orders.',
    },
    {
      // Withdrawing is not what ended this one: it was taken whole.
      name: 'was filled as filled',
      quote: { status: 'filled', filled_risk_amount: '5000000' },
      status: 'Quote status: filled: all of it has been taken.',
      expiry: [],
      fills: 'No fills on this quote. The quote is filled and takes no more orders.',
      taken: '5',
    },
    {
      // Its expiry has passed as well, and the quote still reads filled, with
      // no expiry line: it was taken whole before that.
      name: 'was filled and has since passed its expiry as filled',
      quote: { status: 'filled', filled_risk_amount: '5000000', expiry: '2026-09-27T11:00:00+00:00' },
      status: 'Quote status: filled: all of it has been taken.',
      expiry: [],
      fills: 'No fills on this quote. The quote is filled and takes no more orders.',
      taken: '5',
    },
    {
      // Cancelled on-chain, which withdrawing it from the book is not.
      name: 'was cancelled on-chain as cancelled',
      quote: { status: 'cancelled' },
      status: 'Quote status: cancelled: it can no longer be taken.',
      expiry: [],
      fills: 'No fills on this quote. The quote is cancelled and takes no more orders.',
    },
    {
      name: 'was cancelled on-chain and has since passed its expiry as cancelled',
      quote: { status: 'cancelled', expiry: '2026-09-27T11:00:00+00:00' },
      status: 'Quote status: cancelled: it can no longer be taken.',
      expiry: [],
      fills: 'No fills on this quote. The quote is cancelled and takes no more orders.',
    },
    {
      // Withdrawn is said only of a quote stored as open or partly filled.
      name: 'is stored with a status that is not one of the five as that status',
      quote: { status: 'pending' },
      status: 'Quote status: pending, which is not a status this tool knows.',
      expiry: [],
      fills: 'No fills on this quote.',
    },
  ];

  for (const { name, quote, status, expiry, fills, taken } of WITHDRAWN_THEN) {
    it(`reports a withdrawn quote that ${name}`, async () => {
      const h = await harness(oneQuote({ book_visible: false, ...quote }));
      const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
      expect(result).toEqual({
        isError: false,
        text: lines(
          `Quote ${hash('a1')}`,
          status,
          `Game: ${GAME} (contest_id 481).`,
          'Its maker withdrew it from the book, so its posted price and size are not shown.',
          `Taken from it so far: ${taken ?? '0'} USDC of what the maker put up.`,
          ...expiry,
          '',
          fills,
          '',
          LAG,
        ),
      });
      // The body is redacted under every one of these, so nothing it was
      // signed with is printed, the expiry line or not.
      for (const signed of ['Price for the taker', 'Side for the taker', 'Taken so far', 'Left to take', '1.95', SIGNATURE, '1790000000']) {
        expect(result.text, signed).not.toContain(signed);
      }
    });
  }

  it('says a withdrawn quote has no fills yet by the wallet named', async () => {
    const h = await harness({ ...oneQuote({ book_visible: false }), position_fills: [fillRow()] });
    const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: STRANGER }, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: withdrawn from the book by its maker.',
        `Game: ${GAME} (contest_id 481).`,
        'Its maker withdrew it from the book, so its posted price and size are not shown.',
        'Taken from it so far: 0 USDC of what the maker put up.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        `No fills on this quote by ${STRANGER} yet.`,
        '',
        LAG,
      ),
    });
  });

  // With `redactHiddenPublic` false the quote read answers with the whole
  // body for a hidden row, as the REST API does under that setting, and with
  // the status the API gives such a row: cancelled. Withdrawn is decided by
  // the row's visibility and its stored status, so the answer reads the same
  // as with redaction on, and shows the price, the size and the line besides.
  // The signature and the nonce are printed under neither setting.
  const UNREDACTED: { name: string; quote: Row; status: string; expiry: string[]; fills: string }[] = [
    {
      name: 'as withdrawn, with its price and size',
      quote: {},
      status: 'Quote status: withdrawn from the book by its maker.',
      expiry: ['Expires Sun Sep 27, 2:55 pm ET.'],
      fills: 'No fills on this quote yet.',
    },
    {
      name: 'partly taken as withdrawn, with its price and size',
      quote: { status: 'partially_filled', filled_risk_amount: '1904700' },
      status: 'Quote status: withdrawn from the book by its maker.',
      expiry: ['Expires Sun Sep 27, 2:55 pm ET.'],
      fills: 'No fills on this quote yet.',
    },
    {
      name: 'that has expired as expired',
      quote: { expiry: '2026-09-27T11:00:00+00:00' },
      status: 'Quote status: expired: it can no longer be taken.',
      expiry: ['Expired Sun Sep 27, 7:00 am ET.'],
      fills: 'No fills on this quote. The quote is expired and takes no more orders.',
    },
    {
      name: 'invalidated by its maker\'s nonce floor as cancelled',
      quote: { nonce_invalidated: true },
      status: 'Quote status: cancelled: it can no longer be taken.',
      expiry: [],
      fills: 'No fills on this quote. The quote is cancelled and takes no more orders.',
    },
  ];

  for (const { name, quote, status, expiry, fills } of UNREDACTED) {
    it(`reports a withdrawn quote ${name} when hidden quotes are not redacted`, async () => {
      const h = await harness(oneQuote({ book_visible: false, nonce: '1790000123', ...quote }), {
        config: { redactHiddenPublic: false },
      });
      const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
      const taken = quote.filled_risk_amount === undefined ? '0' : '1.9047';
      expect(result).toEqual({
        isError: false,
        text: lines(
          `Quote ${hash('a1')}`,
          status,
          `Game: ${GAME} (contest_id 481).`,
          `Taken so far: ${taken} of the 5 USDC the maker put up.`,
          'Side for the taker: Under 7.0.',
          'Price for the taker: 1.95.',
          ...expiry,
          '',
          fills,
          '',
          LAG,
        ),
      });
      // The body was not redacted, so the line saying it was is not there,
      // and nothing is said about what is left of a quote off the book.
      for (const absent of ['withdrew it from the book', 'Left to take', CANNOT_OFFER, TOO_LITTLE]) {
        expect(result.text, absent).not.toContain(absent);
      }
      for (const signed of [SIGNATURE, '5a5a', '1790000123', KEYS['c481-total-70'], SCORERS.total]) {
        expect(result.text, signed).not.toContain(signed);
      }
    });
  }

  // ── the arguments ────────────────────────────────────────────────────

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
        text: ADDRESS_REFUSED,
      });
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  it('refuses an address written without 0x, one character short or one too long, before reading anything', async () => {
    // The fill in the database is by the wallet these are written after, so an
    // address that was let through would be answered about.
    const h = await harness({ ...BOOK, position_fills: [fillRow()] });
    const bare = TAKER.slice(2);
    expect(bare).toBe('cccccccccccccccccccccccccccccccccccccccc');
    for (const takerAddress of [bare, bare.toUpperCase(), `0x${'c'.repeat(39)}`, `0x${'c'.repeat(41)}`, `x${bare}`, `00${bare}`]) {
      expect(await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress }, h.ctx), takerAddress).toEqual({
        isError: true,
        text: ADDRESS_REFUSED,
      });
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  const MIXED = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const ANY_CASE: [string, string][] = [
    ['in lower case', MIXED],
    ['with its digits in upper case', '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD'],
    ['all in upper case, the 0X too', '0XABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD'],
    ['in mixed case that is no checksum', '0xAbCdEfabcdefABCDEFabcdefabcdefabcdefABCD'],
    ['with spaces on either side', `  ${MIXED}  `],
  ];

  for (const [how, takerAddress] of ANY_CASE) {
    it(`takes an address written ${how}, and reads its fills in lower case`, async () => {
      const h = await harness({
        ...oneQuote({ status: 'partially_filled', filled_risk_amount: '2857000' }),
        position_fills: [
          fillRow(),
          fillRow({ id: 2, taker_address: MIXED, tx_hash: hash('f2'), taker_risk_amount: '1000000', maker_risk_amount: '952300' }),
        ],
      });
      const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress }, h.ctx);
      expect(requestTo(h.fake, 'position_fills')?.params.getAll('taker_address')).toEqual([`eq.${MIXED}`]);
      expect(result.isError).toBe(false);
      expect(result.text).toContain(
        lines(
          `Fills on this quote by ${MIXED}: 1.`,
          `1. ${MIXED} risked 1 USDC to win 0.9523 USDC at 1.95, Sun Sep 27, 9:00:00 am ET. Transaction ${hash('f2')}`,
          '',
          LAG,
        ),
      );
    });
  }

  it('takes a hash with spaces on either side', async () => {
    const h = await harness(BOOK);
    const result = await h.getOrderStatus({ commitmentHash: `  ${hash('a1')}  `, takerAddress: undefined }, h.ctx);
    expect(requestTo(h.fake, 'commitments')?.params.get('commitment_hash')).toBe(`eq.${hash('a1')}`);
    expect(result.isError).toBe(false);
    expect(result.text.startsWith(`Quote ${hash('a1')}\nQuote status: open.\n`)).toBe(true);
  });

  it('treats a blank address as no address', async () => {
    const h = await harness(BOOK);
    const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: '  ' }, h.ctx);
    expect(result.isError).toBe(false);
    expect(requestTo(h.fake, 'position_fills')?.params.has('taker_address')).toBe(false);
    expect(result.text).toContain('No fills on this quote yet.');
  });

  // ── the most one call reads ──────────────────────────────────────────

  // A thousand rows through the fake are read in about 0.1 s on a laptop; the
  // limit leaves room for a machine many times slower.
  it('says the list may be cut short when it reaches the most one call reads', async () => {
    const many: Row[] = [];
    for (let index = 0; index < 1000; index += 1) {
      many.push(fillRow({ id: index + 1, log_index: index, row_updated_at: `2026-09-27T13:00:05.${String(index).padStart(6, '0')}+00:00` }));
    }
    const h = await harness({ ...BOOK, position_fills: many });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain(
      'Fills on this quote, by every wallet that took it: 1000 (the first 1000; there may be more).',
    );
  }, 15_000);

  it('does not say the list is cut short one fill below that', async () => {
    const many: Row[] = [];
    for (let index = 0; index < 999; index += 1) many.push(fillRow({ id: index + 1, log_index: index }));
    const h = await harness({ ...BOOK, position_fills: many });
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text).toContain('Fills on this quote, by every wallet that took it: 999.');
    expect(result.text).not.toContain('there may be more');
  }, 15_000);

  it('says one wallet\'s list may be cut short too', async () => {
    const many: Row[] = [];
    for (let index = 0; index < 1000; index += 1) many.push(fillRow({ id: index + 1, log_index: index }));
    const h = await harness({ ...BOOK, position_fills: many });
    const result = await h.getOrderStatus({ commitmentHash: hash('a1'), takerAddress: TAKER }, h.ctx);
    expect(result.text).toContain(`Fills on this quote by ${TAKER}: 1000 (the first 1000; there may be more).`);
    expect(result.text).not.toContain(EVERY_WALLET);
  }, 15_000);

  // ── reads that fail ──────────────────────────────────────────────────

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

  const READ_LOGS: [string, string][] = [
    ['commitments', 'mcp: get_order_status quote read failed'],
    ['position_fills', 'mcp: get_order_status fills read failed'],
  ];

  for (const [table, message] of READ_LOGS) {
    it(`logs a failed ${table} read once, under words that name that read`, async () => {
      const h = await harness(
        { ...BOOK, position_fills: [fillRow()] },
        {
          override: (request) =>
            tableOf(request) === table ? { status: 500, body: { message: `secret detail about ${table}` } } : undefined,
        },
      );
      await h.getOrderStatus(STATUS_ARGS, h.ctx);
      expect(h.log.error.mock.calls).toEqual([[{ err: `secret detail about ${table}` }, message]]);
    });
  }

  // ── a quote with no market recorded ─────────────────────────────────

  it('says nothing about the side a taker would back on a quote whose market is not recorded', async () => {
    // Without the market, the side the maker holds does not say which side of
    // which market a taker gets, so the answer leaves that line out.
    const h = await harness(oneQuote({ market_type: null }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result).toEqual({
      isError: false,
      text: lines(
        `Quote ${hash('a1')}`,
        'Quote status: open.',
        `Game: ${GAME} (contest_id 481).`,
        'Taken so far: 0 of the 5 USDC the maker put up.',
        'Price for the taker: 1.95.',
        'Left to take: up to 5.25 USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.',
        'Expires Sun Sep 27, 2:55 pm ET.',
        '',
        'No fills on this quote yet.',
        '',
        LAG,
      ),
    });
    expect(result.text).not.toContain('Side for the taker');
  });

  it('names the side a taker backs on the same quote with its market recorded', async () => {
    const h = await harness(oneQuote({ market_type: 'total' }));
    const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
    expect(result.text.split('\n')).toContain('Side for the taker: Under 7.0.');
  });

  // The side line is labelled as the price line is: for the taker.
  const SIDE_LINES: { name: string; quote: Row; side: string; price: string; left: string }[] = [
    {
      name: 'a total',
      quote: {},
      side: 'Side for the taker: Under 7.0.',
      price: 'Price for the taker: 1.95.',
      left: '5.25',
    },
    {
      // The maker holds the away team at -1.5, so the taker holds the home team at +1.5.
      name: 'a spread',
      quote: { scorer: SCORERS.spread, market_type: 'spread', line_ticks: -15, speculation_key: KEYS['c481-spread--15'] },
      side: 'Side for the taker: Philadelphia Phillies (home) +1.5.',
      price: 'Price for the taker: 1.95.',
      left: '5.25',
    },
    {
      name: 'a moneyline',
      quote: {
        scorer: SCORERS.moneyline,
        market_type: 'moneyline',
        line_ticks: 0,
        position_type: 'lower',
        odds_tick: 160,
        risk_amount: '3000000',
        speculation_key: KEYS['c481-moneyline'],
      },
      side: 'Side for the taker: Tampa Bay Rays (away) to win.',
      price: 'Price for the taker: 2.67.',
      left: '1.8',
    },
  ];

  for (const { name, quote, side, price, left } of SIDE_LINES) {
    it(`names the taker's side on ${name} as the side for the taker, and nowhere as what taking it backs`, async () => {
      const h = await harness(oneQuote(quote));
      const result = await h.getOrderStatus(STATUS_ARGS, h.ctx);
      const text = result.text.split('\n');
      expect(text.slice(4, 7)).toEqual([
        side,
        price,
        `Left to take: up to ${left} USDC of taker risk. prepare_order chooses the quote for an order itself, and may choose another one or none.`,
      ]);
      expect(result.text).not.toContain('Taking it backs');
      expect(result.text).not.toContain('backs:');
    });
  }
});
