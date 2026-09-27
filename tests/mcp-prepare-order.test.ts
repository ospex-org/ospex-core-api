/**
 * `prepare_order`, run against a database it can actually reach.
 *
 * The harness, the fixture and the clock are in `helpers/mcpTools.ts`.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectReached, requestTo } from './helpers/fakePostgrest.js';
import {
  EXPIRY,
  KEYS,
  MAKER_A,
  MAKER_B,
  SCORERS,
  contestRow,
  fundingRow,
  hash,
  quoteRow,
  speculationRow,
  tableOf,
  type Row,
} from './helpers/mcpBook.js';
import {
  BOOK,
  GAME,
  MONEYLINE,
  OVER_QUOTE,
  PLACED_NOTHING,
  READ_FAILED,
  TOTAL_7,
  UNDER_2,
  UNDER_QUOTE,
  closeHarnesses,
  harness,
  lines,
  warmTools,
} from './helpers/mcpTools.js';

beforeAll(warmTools, 60_000);
afterEach(closeHarnesses);

describe('prepare_order', () => {
  it('prepares the Under at the posted price, with the amounts the chain will move', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expectReached(h.fake, 4);

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      lines(
        `Under 7.0 — ${GAME}, Sun Sep 27, 3:05 pm ET.`,
        'Risk 2.00 USDC to win 1.90 at 1.95.',
        'Exactly 7 is a push.',
        'Quote expires Sun Sep 27, 2:55 pm ET.',
        'Exact amounts: you pay 1.999935 USDC and win 1.904700 USDC.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=2`,
        'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.',
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 2',
      ),
    );
  });

  it('reads the contest, its lines, its quotes and the makers\' funding, in that order', async () => {
    const h = await harness(BOOK);
    await h.prepareOrder(UNDER_2, h.ctx);
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments', 'maker_funding']);
    expect(requestTo(h.fake, 'contests_effective')?.params.get('contest_id')).toBe('eq.481');
    expect(requestTo(h.fake, 'commitments')?.params.get('contest_id')).toBe('in.(481)');
    expect(requestTo(h.fake, 'commitments')?.params.get('book_visible')).toBe('eq.true');
    expect(requestTo(h.fake, 'commitments')?.params.get('nonce_invalidated')).toBe('eq.false');
    expect(requestTo(h.fake, 'commitments')?.params.get('status')).toBe('in.(open,partially_filled)');
    expect(requestTo(h.fake, 'commitments')?.params.get('expiry')).toBe('gt.2026-09-27T12:00:00.000Z');
    // Only the makers on the side being taken.
    expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).toBe(`in.(${MAKER_A})`);
  });

  it('prepares for everything the quote has left when it cannot absorb the amount, and says so', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 10 }, h.ctx);
    expect(result.text).toBe(
      lines(
        `Under 7.0 — ${GAME}, Sun Sep 27, 3:05 pm ET.`,
        'Risk 5.25 USDC to win 5.00 at 1.95.',
        'Exactly 7 is a push.',
        'Quote expires Sun Sep 27, 2:55 pm ET.',
        'This quote can take 5.25 USDC, not the 10 asked for. The order is for 5.25.',
        '',
        `Take link: https://ospex.org/take/${hash('a1')}?risk=5.25`,
        'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.',
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a1')}`,
        'market: total',
        'line: 7.0',
        'side: under',
        'risk_usdc: 5.25',
      ),
    );
  });

  it('takes the Over from the quote whose maker holds the Under', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, side: 'Over', riskUsdc: 3 }, h.ctx);
    // At 1.91 the taker's price is 191/91. 3_000_000 asked fills 3_296_700 and costs 2_999_997.
    expect(result.text).toContain(`Over 7.0 — ${GAME}, Sun Sep 27, 3:05 pm ET.`);
    expect(result.text).toContain('Risk 3.00 USDC to win 3.30 at 2.10.');
    expect(result.text).toContain('Exact amounts: you pay 2.999997 USDC and win 3.296700 USDC.');
    expect(result.text).toContain(`commitment_hash: ${hash('a2')}`);
    expect(result.text).toContain('side: over');
    expect(requestTo(h.fake, 'maker_funding')?.params.get('maker_address')).toBe(`in.(${MAKER_B})`);
  });

  it('takes a team by name, and names it with its role in the preview', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder(
      { contestId: '481', market: 'moneyline', side: 'Phillies', riskUsdc: 3, line: undefined },
      h.ctx,
    );
    expect(result.text).toBe(
      lines(
        `Philadelphia Phillies (home) to win — ${GAME}, Sun Sep 27, 3:05 pm ET.`,
        'Risk 3.00 USDC to win 2.00 at 1.67.',
        'A tie is a push.',
        'Quote expires Sun Sep 27, 2:55 pm ET.',
        '',
        `Take link: https://ospex.org/take/${hash('a3')}?risk=3`,
        'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.',
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a3')}`,
        'market: moneyline',
        'side: home',
        'risk_usdc: 3',
      ),
    );
  });

  it('the other team is the other quote', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder(
      { contestId: '481', market: 'moneyline', side: 'away', riskUsdc: 1, line: undefined },
      h.ctx,
    );
    // Posted 1.60: the taker's price is 160/60. 1_000_000 asked fills 1_666_600 and costs 999_960.
    expect(result.text).toContain(`Tampa Bay Rays (away) to win — ${GAME}`);
    expect(result.text).toContain('Risk 1.00 USDC to win 1.67 at 2.67.');
    expect(result.text).toContain('Exact amounts: you pay 0.999960 USDC and win 1.666600 USDC.');
    expect(result.text).toContain(`commitment_hash: ${hash('a4')}`);
  });

  it('names a spread from the side being backed', async () => {
    const onHome = quoteRow({
      commitment_hash: hash('a5'),
      scorer: SCORERS.spread,
      market_type: 'spread',
      line_ticks: -15,
      position_type: 'lower',
      odds_tick: 200,
      risk_amount: '4000000',
      speculation_key: KEYS['c481-spread--15'],
    });
    const h = await harness({ ...BOOK, commitments: [onHome] });
    const result = await h.prepareOrder(
      { contestId: '481', market: 'spread', side: 'Rays', riskUsdc: 1, line: -1.5 },
      h.ctx,
    );
    expect(result.text).toBe(
      lines(
        `Tampa Bay Rays (away) -1.5 — ${GAME}, Sun Sep 27, 3:05 pm ET.`,
        'Risk 1.00 USDC to win 1.00 at 2.00.',
        'Quote expires Sun Sep 27, 2:55 pm ET.',
        '',
        `Take link: https://ospex.org/take/${hash('a5')}?risk=1`,
        'Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.',
        '',
        'contest_id: 481',
        `commitment_hash: ${hash('a5')}`,
        'market: spread',
        'line: -1.5',
        'side: away',
        'risk_usdc: 1',
      ),
    );
  });

  it('the home team\'s +1.5 is the same line as the away team\'s -1.5', async () => {
    const onAway = quoteRow({
      commitment_hash: hash('a6'),
      scorer: SCORERS.spread,
      market_type: 'spread',
      line_ticks: -15,
      position_type: 'upper',
      odds_tick: 200,
      risk_amount: '4000000',
      speculation_key: KEYS['c481-spread--15'],
    });
    const h = await harness({ ...BOOK, commitments: [onAway] });
    const result = await h.prepareOrder(
      { contestId: '481', market: 'spread', side: 'home', riskUsdc: 1, line: 1.5 },
      h.ctx,
    );
    expect(result.text).toContain(`Philadelphia Phillies (home) +1.5 — ${GAME}`);
    expect(result.text).toContain('line: +1.5');
    expect(result.text).toContain(`commitment_hash: ${hash('a6')}`);

    // Named with the wrong sign, it is a line this game does not have.
    const wrong = await h.prepareOrder(
      { contestId: '481', market: 'spread', side: 'home', riskUsdc: 1, line: -1.5 },
      h.ctx,
    );
    expect(wrong).toEqual({
      isError: false,
      text: lines(`${GAME} has no spread line at -1.5. Lines on-chain: +1.5.`, PLACED_NOTHING),
    });
  });

  it('chooses the better price among quotes that can fill the amount', async () => {
    const worse = quoteRow({ commitment_hash: hash('b1'), odds_tick: 215, risk_amount: '50000000' });
    const h = await harness({ ...BOOK, commitments: [worse, UNDER_QUOTE] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
  });

  it('passes over a better price with only dust left for one that fills the order', async () => {
    const dust = quoteRow({
      commitment_hash: hash('b2'),
      odds_tick: 200,
      risk_amount: '5000000',
      filled_risk_amount: '4950000',
      status: 'partially_filled',
    });
    const h = await harness({ ...BOOK, commitments: [dust, UNDER_QUOTE] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).toContain('Risk 2.00 USDC to win 1.90 at 1.95.');
  });

  it('never hands out a quote that is hidden, invalidated, expired or filled, even if the read returned it', async () => {
    // The read is made to return every row whatever its filters said, so the
    // tool's own checks are all that stands between these rows and a link.
    const bad: Row[] = [
      quoteRow({ commitment_hash: hash('d1'), odds_tick: 150, book_visible: false }),
      quoteRow({ commitment_hash: hash('d2'), odds_tick: 151, nonce_invalidated: true }),
      quoteRow({ commitment_hash: hash('d3'), odds_tick: 152, expiry: '2026-09-27T11:00:00+00:00' }),
      quoteRow({ commitment_hash: hash('d4'), odds_tick: 153, status: 'filled', filled_risk_amount: '5000000' }),
      quoteRow({ commitment_hash: hash('d5'), odds_tick: 154, status: 'cancelled' }),
      quoteRow({ commitment_hash: hash('d6'), odds_tick: 155, signature: null }),
    ];
    const h = await harness(BOOK, {
      // In hash order, as the read asks for them: a1, then d1 to d6.
      override: (request) =>
        tableOf(request) === 'commitments' ? { body: [UNDER_QUOTE, ...bad] } : undefined,
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).toContain('at 1.95.');
    for (const row of bad) expect(result.text).not.toContain(String(row['commitment_hash']));
    // The hidden row was seen, and dropped out loud.
    expect(h.log.warn).toHaveBeenCalledWith(
      { commitmentHash: hash('d1') },
      'commitments: hidden row reached the open book drain — dropped',
    );
  });

  it('does not offer a quote with under two minutes to run', async () => {
    const closing = quoteRow({ expiry: '2026-09-27T12:01:59+00:00' });
    const h = await harness({ ...BOOK, commitments: [closing] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`No quote is posted for Under 7.0 on ${GAME} right now.`, PLACED_NOTHING),
    });
  });

  it('says funding was not confirmed when nothing is known about the maker', async () => {
    const h = await harness({ ...BOOK, maker_funding: [] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).toContain(
      "The maker's funds could not be confirmed just now. If they are short the transaction fails and only gas is spent.",
    );
  });

  it('says funding was not confirmed when the snapshot is older than two minutes', async () => {
    const h = await harness({
      ...BOOK,
      maker_funding: [fundingRow({ updated_at: '2026-09-27T11:57:59+00:00' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain("The maker's funds could not be confirmed just now.");
  });

  it('says nothing about funding when a fresh snapshot covers the fill', async () => {
    const h = await harness({
      ...BOOK,
      // Exactly two minutes old, and exactly the fill.
      maker_funding: [fundingRow({ updated_at: '2026-09-27T11:58:00+00:00', backing_wei6: '1904700' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).not.toContain('could not be confirmed');
  });

  it('prepares nothing on a quote whose maker is known to be short', async () => {
    const h = await harness({ ...BOOK, maker_funding: [fundingRow({ backing_wei6: '1904699' })] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        'A quote is posted for Under 7.0, but its maker does not have the funds behind it right now.',
        PLACED_NOTHING,
      ),
    });
  });

  it('still prepares when the funding read fails, and says funding was not confirmed', async () => {
    const h = await harness(BOOK, {
      override: (request) =>
        tableOf(request) === 'maker_funding' ? { status: 500, body: { message: 'funding unavailable' } } : undefined,
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
    expect(result.text).toContain("The maker's funds could not be confirmed just now.");
  });

  it('points the link where it is told to', async () => {
    const h = await harness(BOOK, { context: { takeLinkBaseUrl: 'http://localhost:5173' } });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`Take link: http://localhost:5173/take/${hash('a1')}?risk=2`);
  });

  it('carries an amount with decimals into the link without changing it', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, riskUsdc: 2.123456 }, h.ctx);
    expect(result.text).toContain(`?risk=2.123456`);
    expect(result.text).toContain('risk_usdc: 2.123456');
  });

  // ── the game ─────────────────────────────────────────────────────────

  it('refuses a game that has started: a start equal to now has started', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:00:00+00:00' })],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(
        `${GAME} started Sun Sep 27, 8:00 am ET. Ospex takes no bets on a game under way.`,
        PLACED_NOTHING,
      ),
    });
    // Decided from the contest alone.
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations']);
  });

  it('takes a game that starts one microsecond from now', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ effective_start_time: '2026-09-27T12:00:00.000001+00:00' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`commitment_hash: ${hash('a1')}`);
  });

  it('gates on the conservative start, not the start written on-chain', async () => {
    // The chain still says 3:05 pm. The game was moved up and is under way.
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ start_time: EXPIRY, effective_start_time: '2026-09-27T11:05:00+00:00' })],
    });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`${GAME} started Sun Sep 27, 7:05 am ET.`);
    expect(result.text).not.toContain('Take link');
  });

  it('refuses a game with no readable start instead of treating it as not started', async () => {
    const h = await harness({ ...BOOK, contests_effective: [contestRow({ effective_start_time: null })] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no start time Ospex can read, so it cannot be bet on.`, PLACED_NOTHING),
    });
  });

  for (const status of ['unverified', 'scored', 'voided']) {
    it(`refuses a contest that is ${status}`, async () => {
      const h = await harness({ ...BOOK, contests_effective: [contestRow({ contest_status: status })] });
      expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
        isError: false,
        text: lines(`${GAME} is not open for betting: its contest is ${status}.`, PLACED_NOTHING),
      });
    });
  }

  it('refuses a contest with no start written on-chain, whatever its status says', async () => {
    const h = await harness({ ...BOOK, contests_effective: [contestRow({ start_time: null })] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain('is not open for betting');
    expect(result.text).not.toContain('Take link');
  });

  it('says a contest does not exist', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, contestId: '999' }, h.ctx)).toEqual({
      isError: true,
      text: lines('There is no contest 999 on Ospex.', PLACED_NOTHING),
    });
  });

  it('reads a contest id written with leading zeros as the number it is', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder({ ...UNDER_2, contestId: ' 0481 ' }, h.ctx);
    expect(requestTo(h.fake, 'contests_effective')?.params.get('contest_id')).toBe('eq.481');
    expect(result.text).toContain('contest_id: 481');
  });

  // ── the arguments ────────────────────────────────────────────────────

  it('refuses an amount it cannot read exactly, before reading anything', async () => {
    const h = await harness(BOOK);
    const cases: Array<[number, string]> = [
      [0, 'risk_usdc must be more than zero.'],
      [-5, 'risk_usdc must be more than zero.'],
      [1.0000001, 'risk_usdc has more than six decimal places. USDC has six.'],
      [0.1 + 0.2, 'risk_usdc has more than six decimal places. USDC has six.'],
      [1_000_000.5, 'risk_usdc is more than one order may carry (1,000,000 USDC).'],
      [Number.NaN, 'risk_usdc must be a plain number of USDC, such as 10 or 2.5.'],
      [1e-7, 'risk_usdc must be a plain number of USDC, such as 10 or 2.5.'],
    ];
    for (const [riskUsdc, problem] of cases) {
      expect(await h.prepareOrder({ ...UNDER_2, riskUsdc }, h.ctx)).toEqual({
        isError: true,
        text: lines(problem, PLACED_NOTHING),
      });
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  it('refuses a contest id that is not a number, before reading anything', async () => {
    const h = await harness(BOOK);
    for (const contestId of ['', 'abc', '48.1', '-481', '4 81', '9'.repeat(21)]) {
      expect(await h.prepareOrder({ ...UNDER_2, contestId }, h.ctx)).toEqual({
        isError: true,
        text: lines('contest_id must be the number list_markets shows for the game.', PLACED_NOTHING),
      });
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  it('says what the sides of the market are when the side is not one of them', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, side: 'Phillies' }, h.ctx)).toEqual({
      isError: true,
      text: lines('For a total, side is over or under.', PLACED_NOTHING),
    });
    expect(
      await h.prepareOrder({ contestId: '481', market: 'moneyline', side: 'under', riskUsdc: 2, line: undefined }, h.ctx),
    ).toEqual({
      isError: true,
      text: lines(
        'Over and under are sides of a total. For a moneyline, side is Tampa Bay Rays (away) or Philadelphia Phillies (home).',
        PLACED_NOTHING,
      ),
    });
    expect(
      await h.prepareOrder({ contestId: '481', market: 'moneyline', side: 'Yankees', riskUsdc: 2, line: undefined }, h.ctx),
    ).toEqual({
      isError: true,
      text: lines(
        'That is not one of the teams in this game. Side is Tampa Bay Rays (away) or Philadelphia Phillies (home).',
        PLACED_NOTHING,
      ),
    });
  });

  it('refuses a name both teams answer to', async () => {
    const h = await harness({
      ...BOOK,
      contests_effective: [contestRow({ away_team: 'New York Mets', home_team: 'New York Yankees' })],
    });
    expect(
      await h.prepareOrder({ contestId: '481', market: 'moneyline', side: 'New York', riskUsdc: 2, line: undefined }, h.ctx),
    ).toEqual({
      isError: true,
      text: lines('That name fits both teams. Say New York Mets (away) or New York Yankees (home).', PLACED_NOTHING),
    });
  });

  // ── the line ─────────────────────────────────────────────────────────

  it('says the market has no line when it has none', async () => {
    const h = await harness({ ...BOOK, speculations: [MONEYLINE] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no total line on-chain yet.`, PLACED_NOTHING),
    });
  });

  it('asks which line when more than one has a quote on that side', async () => {
    const total75 = speculationRow({ speculation_id: 1005, line_ticks: 75 });
    const under75 = quoteRow({
      commitment_hash: hash('b5'),
      line_ticks: 75,
      odds_tick: 190,
      speculation_key: KEYS['c481-total-75'],
    });
    const h = await harness({
      ...BOOK,
      speculations: [TOTAL_7, total75],
      commitments: [UNDER_QUOTE, under75],
    });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: true,
      text: lines('More than one line has a quote: Under 7.0; Under 7.5. Say which with line.', PLACED_NOTHING),
    });

    const chosen = await h.prepareOrder({ ...UNDER_2, line: 7.5 }, h.ctx);
    expect(chosen.text).toContain(`Under 7.5 — ${GAME}`);
    expect(chosen.text).toContain(`commitment_hash: ${hash('b5')}`);
    expect(chosen.text).toContain('line: 7.5');
    // A half-point total has no push.
    expect(chosen.text).not.toContain('push');
  });

  it('uses the one line that has a quote when two lines exist', async () => {
    const total75 = speculationRow({ speculation_id: 1005, line_ticks: 75 });
    const h = await harness({ ...BOOK, speculations: [total75, TOTAL_7], commitments: [UNDER_QUOTE] });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.text).toContain(`Under 7.0 — ${GAME}`);
  });

  it('says which lines exist when the one named does not', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, line: 8.5 }, h.ctx)).toEqual({
      isError: false,
      text: lines(`${GAME} has no total line at 8.5. Lines on-chain: 7.0.`, PLACED_NOTHING),
    });
  });

  it('refuses a line with more than one decimal place', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, line: 7.25 }, h.ctx)).toEqual({
      isError: true,
      text: lines('line must be a number with at most one decimal place, such as 7.5 or -1.5.', PLACED_NOTHING),
    });
  });

  it('ignores a line given for a moneyline', async () => {
    const h = await harness(BOOK);
    const result = await h.prepareOrder(
      { contestId: '481', market: 'moneyline', side: 'home', riskUsdc: 3, line: 7.5 },
      h.ctx,
    );
    expect(result.text).toContain(`commitment_hash: ${hash('a3')}`);
    expect(result.text).not.toContain('line:');
  });

  // ── the quote ────────────────────────────────────────────────────────

  it('says so when nothing is posted on that side', async () => {
    const h = await harness({ ...BOOK, commitments: [OVER_QUOTE] });
    expect(await h.prepareOrder(UNDER_2, h.ctx)).toEqual({
      isError: false,
      text: lines(`No quote is posted for Under 7.0 on ${GAME} right now.`, PLACED_NOTHING),
    });
    // No quote, so no maker to look up.
    expect(h.fake.tables()).toEqual(['contests_effective', 'speculations', 'commitments']);
  });

  it('says an amount is too small, and what the smallest is', async () => {
    const h = await harness(BOOK);
    expect(await h.prepareOrder({ ...UNDER_2, riskUsdc: 0.000103 }, h.ctx)).toEqual({
      isError: false,
      text: lines(
        '0.000103 USDC is too small to take any quote for Under 7.0. The smallest is 0.000104 USDC.',
        PLACED_NOTHING,
      ),
    });
    const smallest = await h.prepareOrder({ ...UNDER_2, riskUsdc: 0.000104 }, h.ctx);
    expect(smallest.text).toContain('Exact amounts: you pay 0.000104 USDC and win 0.000100 USDC.');
  });

  // ── reads that fail ──────────────────────────────────────────────────

  for (const table of ['contests_effective', 'speculations', 'commitments']) {
    it(`answers with fixed words when the ${table} read fails`, async () => {
      const h = await harness(BOOK, {
        override: (request) =>
          tableOf(request) === table ? { status: 500, body: { message: `secret detail about ${table}` } } : undefined,
      });
      const result = await h.prepareOrder(UNDER_2, h.ctx);
      expectReached(h.fake);
      expect(result).toEqual({ isError: true, text: READ_FAILED });
      expect(h.log.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.log.error.mock.calls[0])).toContain(`secret detail about ${table}`);
    });
  }

  it('refuses when the service has no scorer addresses, before reading anything', async () => {
    const h = await harness(BOOK, { context: { scorers: undefined } });
    const result = await h.prepareOrder(UNDER_2, h.ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not configured');
    expect(h.fake.requests).toHaveLength(0);
  });
});
