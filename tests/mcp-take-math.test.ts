/**
 * The arithmetic of taking a posted quote — `src/mcp/takeMath.ts`.
 *
 * Two kinds of evidence, kept apart on purpose:
 *
 *   1. VECTORS from an independent implementation (`fixtures/take-math-vectors.json`,
 *      produced by the SDK's match preview builder). Nothing in that file was
 *      computed by the code under test, so agreement is evidence and not an echo.
 *   2. LITERALS worked by hand from the contract's rule, for the branches a
 *      preview's wording depends on: the reduced take, the too-small request,
 *      the amount parser and the formatters.
 *
 * Every expected value below is a literal. None is derived from the function
 * it checks.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_ODDS_TICK,
  MAX_REQUEST_USDC,
  MIN_ODDS_TICK,
  formatOddsTick,
  formatUsdcCents,
  formatUsdcCentsDown,
  formatUsdcExact,
  formatUsdcShort,
  isValidOddsTick,
  isWholeCents,
  maxTakerRisk,
  minTakerRisk,
  parseUsdc,
  planTake,
  simulateMatch,
  takerOddsTick,
} from '../src/mcp/takeMath.js';

interface VectorFile {
  columns: string[];
  rows: Array<Array<string | number>>;
}

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/take-math-vectors.json', import.meta.url), 'utf8'),
) as VectorFile;

describe('vectors from the SDK preview builder', () => {
  it('the fixture is the one this suite was written against', () => {
    // A fixture that silently lost rows would leave every case below passing on
    // less evidence than it claims.
    expect(vectors.columns).toEqual([
      'oddsTick',
      'remainingMakerRisk',
      'takerDesiredRisk',
      'accepted',
      'fillMakerRisk',
      'takerRisk',
      'takerOddsTick',
      'partialFill',
    ]);
    expect(vectors.rows).toHaveLength(367);
    expect(vectors.rows.filter((row) => row[3] === 1)).toHaveLength(178);
    expect(vectors.rows.filter((row) => row[3] === 0)).toHaveLength(189);
  });

  it('accepts and refuses exactly the requests the SDK does', () => {
    const disagreements: string[] = [];
    for (const row of vectors.rows) {
      const outcome = simulateMatch({
        oddsTick: Number(row[0]),
        remainingMakerRisk: BigInt(row[1] as string),
        takerDesiredRisk: BigInt(row[2] as string),
      });
      if (outcome.accepted !== (row[3] === 1)) disagreements.push(row.join(','));
    }
    expect(disagreements).toEqual([]);
  });

  it('moves the same amounts as the SDK on every accepted request', () => {
    const disagreements: string[] = [];
    let compared = 0;
    for (const row of vectors.rows) {
      if (row[3] !== 1) continue;
      const remaining = BigInt(row[1] as string);
      const outcome = simulateMatch({
        oddsTick: Number(row[0]),
        remainingMakerRisk: remaining,
        takerDesiredRisk: BigInt(row[2] as string),
      });
      if (!outcome.accepted) {
        disagreements.push(`refused: ${row.join(',')}`);
        continue;
      }
      compared += 1;
      if (outcome.fillMakerRisk.toString() !== row[4]) disagreements.push(`fill: ${row.join(',')}`);
      if (outcome.takerRisk.toString() !== row[5]) disagreements.push(`takerRisk: ${row.join(',')}`);
      if (takerOddsTick(Number(row[0])) !== row[6]) disagreements.push(`takerTick: ${row.join(',')}`);
      if (outcome.fillMakerRisk < remaining !== (row[7] === 1)) disagreements.push(`partial: ${row.join(',')}`);
    }
    expect(compared).toBe(178);
    expect(disagreements).toEqual([]);
  });

  it('refuses for the reason the request actually has', () => {
    // The SDK reports one refusal for both causes, so the vectors cannot tell
    // them apart. These two literals do.
    expect(simulateMatch({ oddsTick: 205, remainingMakerRisk: 5_000_000n, takerDesiredRisk: 103n })).toEqual({
      accepted: false,
      reason: 'zero_fill',
    });
    expect(simulateMatch({ oddsTick: 205, remainingMakerRisk: 5_000_000n, takerDesiredRisk: 6_000_000n })).toEqual({
      accepted: false,
      reason: 'exceeds_remaining',
    });
  });
});

describe('simulateMatch — worked from the contract rule', () => {
  it('a quote at 2.05 asked for 2.000000 fills 1.904700 and charges 1.999935', () => {
    expect(simulateMatch({ oddsTick: 205, remainingMakerRisk: 5_000_000n, takerDesiredRisk: 2_000_000n })).toEqual({
      accepted: true,
      fillMakerRisk: 1_904_700n,
      takerRisk: 1_999_935n,
    });
  });

  it('never charges more than was asked: the cap binds at 2.01', () => {
    // Uncapped this would charge 10_100_000.
    expect(
      simulateMatch({ oddsTick: 201, remainingMakerRisk: 100_000_000n, takerDesiredRisk: 10_099_999n }),
    ).toEqual({ accepted: true, fillMakerRisk: 10_000_000n, takerRisk: 10_099_999n });
  });

  it('absorbs a request just over a full take, and refuses one unit beyond that', () => {
    expect(simulateMatch({ oddsTick: 205, remainingMakerRisk: 5_000_000n, takerDesiredRisk: 5_250_103n })).toEqual({
      accepted: true,
      fillMakerRisk: 5_000_000n,
      takerRisk: 5_250_000n,
    });
    expect(simulateMatch({ oddsTick: 205, remainingMakerRisk: 5_000_000n, takerDesiredRisk: 5_250_104n })).toEqual({
      accepted: false,
      reason: 'exceeds_remaining',
    });
  });

  it('refuses a price outside the protocol range, on both sides', () => {
    const base = { remainingMakerRisk: 1_000_000n, takerDesiredRisk: 1_000n };
    expect(simulateMatch({ ...base, oddsTick: 100 })).toEqual({ accepted: false, reason: 'odds_out_of_range' });
    expect(simulateMatch({ ...base, oddsTick: 10_101 })).toEqual({ accepted: false, reason: 'odds_out_of_range' });
    expect(simulateMatch({ ...base, oddsTick: 150.5 })).toEqual({ accepted: false, reason: 'odds_out_of_range' });
    // The two ends of the range are prices, not refusals.
    expect(simulateMatch({ ...base, oddsTick: 101 }).accepted).toBe(true);
    expect(
      simulateMatch({ oddsTick: 10_100, remainingMakerRisk: 1_000_000n, takerDesiredRisk: 10_000n }).accepted,
    ).toBe(true);
  });

  it('refuses a request of nothing, and a quote with nothing left', () => {
    expect(simulateMatch({ oddsTick: 205, remainingMakerRisk: 5_000_000n, takerDesiredRisk: 0n })).toEqual({
      accepted: false,
      reason: 'zero_desired',
    });
    expect(simulateMatch({ oddsTick: 205, remainingMakerRisk: 0n, takerDesiredRisk: 1_000_000n })).toEqual({
      accepted: false,
      reason: 'nothing_left',
    });
  });
});

describe('the range of a take on one quote', () => {
  it('maxTakerRisk is what takes everything left', () => {
    expect(maxTakerRisk(205, 5_000_000n)).toBe(5_250_000n);
    expect(maxTakerRisk(180, 5_000_000n)).toBe(4_000_000n);
    expect(maxTakerRisk(101, 5_000_000n)).toBe(50_000n);
    expect(maxTakerRisk(10_100, 100n)).toBe(10_000n);
  });

  it('maxTakerRisk floors remaining risk that is off the lot grid', () => {
    // 5_000_050 can absorb no more than 5_000_000 can.
    expect(maxTakerRisk(205, 5_000_050n)).toBe(5_250_000n);
    expect(maxTakerRisk(205, 99n)).toBe(0n);
  });

  it('maxTakerRisk is zero when there is nothing to take or no valid price', () => {
    expect(maxTakerRisk(205, 0n)).toBe(0n);
    expect(maxTakerRisk(100, 5_000_000n)).toBe(0n);
  });

  it('maxTakerRisk is zero for a negative remaining amount, which only a row that is wrong can carry', () => {
    // Zero cannot tell a checked amount from an unchecked one: the formula
    // gives zero for it anyway. A whole negative lot can: unchecked, -100 gives
    // -100 * 105 / 100 = -105.
    expect(maxTakerRisk(205, -100n)).toBe(0n);
    expect(maxTakerRisk(205, -1n)).toBe(0n);
  });

  it('maxTakerRisk is zero for a price outside the range, where the formula alone would not be', () => {
    // At 100 the formula multiplies by zero, so that fixture cannot tell a
    // checked price from an unchecked one. These can: unchecked, 50 gives
    // 5_000_000 * -50 / 100 = -2_500_000, and 10_101 gives
    // 5_000_000 * 10_001 / 100 = 500_050_000.
    expect(maxTakerRisk(50, 5_000_000n)).toBe(0n);
    expect(maxTakerRisk(10_101, 5_000_000n)).toBe(0n);
    // The nearest prices that are taken, on each side.
    expect(maxTakerRisk(101, 5_000_000n)).toBe(50_000n);
    expect(maxTakerRisk(10_100, 5_000_000n)).toBe(500_000_000n);
  });

  it('minTakerRisk is zero for a price outside the range, where the formula alone would not be', () => {
    // Unchecked, 100 gives 99 * 0 / 100 + 1 = 1, and 10_101 gives
    // floor(99 * 10_001 / 100) + 1 = 9_901.
    expect(minTakerRisk(100)).toBe(0n);
    expect(minTakerRisk(10_101)).toBe(0n);
    // The nearest prices that are taken, on each side.
    expect(minTakerRisk(101)).toBe(1n);
    expect(minTakerRisk(10_100)).toBe(9_901n);
  });

  it('both are zero for a price that is not a whole number of ticks', () => {
    // 150.5 is inside the range, so only the whole-number half of the price
    // check answers for it. The formula has no answer of its own: a fraction
    // does not convert to the integer type the amounts are worked in.
    expect(maxTakerRisk(150.5, 5_000_000n)).toBe(0n);
    expect(minTakerRisk(150.5)).toBe(0n);
    // The whole prices either side of it.
    expect(maxTakerRisk(150, 5_000_000n)).toBe(2_500_000n);
    expect(maxTakerRisk(151, 5_000_000n)).toBe(2_550_000n);
    expect(minTakerRisk(150)).toBe(50n);
    expect(minTakerRisk(151)).toBe(51n);
  });

  it('minTakerRisk is the first amount that fills a lot, and one less does not', () => {
    // At 1.01 the smallest is one base unit, so one less is a request of
    // nothing, refused for that; at every other price one less fills no lot.
    const cases: Array<[number, bigint, 'zero_desired' | 'zero_fill']> = [
      [101, 1n, 'zero_desired'],
      [150, 50n, 'zero_fill'],
      [191, 91n, 'zero_fill'],
      [200, 100n, 'zero_fill'],
      [205, 104n, 'zero_fill'],
      [250, 149n, 'zero_fill'],
      [10_100, 9_901n, 'zero_fill'],
    ];
    expect(cases).toHaveLength(7);
    for (const [oddsTick, smallest, oneLess] of cases) {
      expect(minTakerRisk(oddsTick)).toBe(smallest);
      const base = { oddsTick, remainingMakerRisk: 1_000_000n };
      expect(simulateMatch({ ...base, takerDesiredRisk: smallest })).toMatchObject({
        accepted: true,
        fillMakerRisk: 100n,
      });
      expect(simulateMatch({ ...base, takerDesiredRisk: smallest - 1n })).toEqual({
        accepted: false,
        reason: oneLess,
      });
    }
  });
});

describe('takerOddsTick', () => {
  it('is the complement of the posted price, rounded half up', () => {
    expect(takerOddsTick(205)).toBe(195);
    expect(takerOddsTick(180)).toBe(225);
    expect(takerOddsTick(191)).toBe(210);
    expect(takerOddsTick(250)).toBe(167);
    expect(takerOddsTick(200)).toBe(200);
    // 260 inverts to exactly 162.5.
    expect(takerOddsTick(260)).toBe(163);
    expect(takerOddsTick(MIN_ODDS_TICK)).toBe(10_100);
    expect(takerOddsTick(MAX_ODDS_TICK)).toBe(101);
  });

  it('a lower posted price is a better price for the taker', () => {
    expect(takerOddsTick(180)).toBeGreaterThan(takerOddsTick(205));
    expect(takerOddsTick(205)).toBeGreaterThan(takerOddsTick(250));
  });

  it('throws on a price the protocol does not allow', () => {
    expect(() => takerOddsTick(100)).toThrow(RangeError);
    expect(() => takerOddsTick(10_101)).toThrow(RangeError);
  });
});

describe('isValidOddsTick', () => {
  it('admits the range and nothing else', () => {
    expect(isValidOddsTick(101)).toBe(true);
    expect(isValidOddsTick(10_100)).toBe(true);
    expect(isValidOddsTick(100)).toBe(false);
    expect(isValidOddsTick(10_101)).toBe(false);
    expect(isValidOddsTick(205.5)).toBe(false);
    expect(isValidOddsTick(Number.NaN)).toBe(false);
  });
});

describe('planTake', () => {
  it('plans a request the quote can absorb exactly as asked', () => {
    expect(planTake({ oddsTick: 205, remainingMakerRisk: 5_000_000n, requestedTakerRisk: 2_000_000n })).toEqual({
      ok: true,
      plan: {
        requestedTakerRisk: 2_000_000n,
        takerDesiredRisk: 2_000_000n,
        fillMakerRisk: 1_904_700n,
        takerRisk: 1_999_935n,
        takerProfit: 1_904_700n,
        reduced: false,
        takerOddsTick: 195,
      },
    });
  });

  it('cuts a request the quote cannot absorb down to everything it has left', () => {
    expect(planTake({ oddsTick: 205, remainingMakerRisk: 5_000_000n, requestedTakerRisk: 6_000_000n })).toEqual({
      ok: true,
      plan: {
        requestedTakerRisk: 6_000_000n,
        takerDesiredRisk: 5_250_000n,
        fillMakerRisk: 5_000_000n,
        takerRisk: 5_250_000n,
        takerProfit: 5_000_000n,
        reduced: true,
        takerOddsTick: 195,
      },
    });
  });

  it('a reduced plan is one the contract accepts', () => {
    // The point of reducing: the amount handed on must not revert.
    for (const oddsTick of [101, 150, 191, 205, 250, 1_000, 10_100]) {
      for (const remainingMakerRisk of [100n, 12_300n, 5_000_000n]) {
        const result = planTake({ oddsTick, remainingMakerRisk, requestedTakerRisk: 1_000_000_000_000n });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.plan.reduced).toBe(true);
        // Every remaining amount above is whole lots, so a full take consumes all of it.
        expect(result.plan.fillMakerRisk).toBe(remainingMakerRisk);
        expect(
          simulateMatch({ oddsTick, remainingMakerRisk, takerDesiredRisk: result.plan.takerDesiredRisk }),
        ).toEqual({
          accepted: true,
          fillMakerRisk: result.plan.fillMakerRisk,
          takerRisk: result.plan.takerRisk,
        });
      }
    }
  });

  it('does not mark a request as reduced when it is only just absorbed', () => {
    const result = planTake({ oddsTick: 205, remainingMakerRisk: 5_000_000n, requestedTakerRisk: 5_250_103n });
    expect(result).toMatchObject({
      ok: true,
      plan: { reduced: false, takerDesiredRisk: 5_250_103n, takerRisk: 5_250_000n, fillMakerRisk: 5_000_000n },
    });
  });

  it('says a request is too small, and what the smallest is', () => {
    expect(planTake({ oddsTick: 205, remainingMakerRisk: 5_000_000n, requestedTakerRisk: 103n })).toEqual({
      ok: false,
      reason: 'too_small',
      minTakerRisk: 104n,
    });
  });

  it('passes through the refusals that are not about size', () => {
    expect(planTake({ oddsTick: 100, remainingMakerRisk: 5_000_000n, requestedTakerRisk: 1_000_000n })).toEqual({
      ok: false,
      reason: 'odds_out_of_range',
    });
    expect(planTake({ oddsTick: 205, remainingMakerRisk: 5_000_000n, requestedTakerRisk: 0n })).toEqual({
      ok: false,
      reason: 'zero_desired',
    });
    expect(planTake({ oddsTick: 205, remainingMakerRisk: 0n, requestedTakerRisk: 1_000_000n })).toEqual({
      ok: false,
      reason: 'nothing_left',
    });
  });

  it('finds nothing to take when less than one lot is left', () => {
    expect(planTake({ oddsTick: 205, remainingMakerRisk: 99n, requestedTakerRisk: 1_000_000n })).toEqual({
      ok: false,
      reason: 'nothing_left',
    });
  });
});

describe('parseUsdc', () => {
  it('reads a decimal string into base units', () => {
    expect(parseUsdc('10')).toEqual({ ok: true, baseUnits: 10_000_000n });
    expect(parseUsdc('10.00')).toEqual({ ok: true, baseUnits: 10_000_000n });
    expect(parseUsdc('0.000001')).toEqual({ ok: true, baseUnits: 1n });
    expect(parseUsdc('9.99999')).toEqual({ ok: true, baseUnits: 9_999_990n });
    expect(parseUsdc('007.5')).toEqual({ ok: true, baseUnits: 7_500_000n });
  });

  it('reads a JSON number through its shortest decimal form', () => {
    expect(parseUsdc(10)).toEqual({ ok: true, baseUnits: 10_000_000n });
    expect(parseUsdc(10.1)).toEqual({ ok: true, baseUnits: 10_100_000n });
    expect(parseUsdc(0.29)).toEqual({ ok: true, baseUnits: 290_000n });
    // 0.1 + 0.2 is not 0.3, and is not quietly rounded to it.
    expect(parseUsdc(0.1 + 0.2)).toEqual({ ok: false, reason: 'too_many_decimals' });
  });

  it('refuses more precision than USDC has rather than rounding it', () => {
    expect(parseUsdc('1.0000001')).toEqual({ ok: false, reason: 'too_many_decimals' });
    expect(parseUsdc('1.0000000')).toEqual({ ok: false, reason: 'too_many_decimals' });
  });

  it('refuses anything that is not a plain decimal', () => {
    for (const input of ['', ' ', '10 ', ' 10', '1e3', '1,000', '+5', '.5', '5.', '0x10', 'ten', 'NaN', '10\n']) {
      expect(parseUsdc(input)).toEqual({ ok: false, reason: 'not_a_decimal' });
    }
    expect(parseUsdc(Number.NaN)).toEqual({ ok: false, reason: 'not_a_decimal' });
    expect(parseUsdc(Number.POSITIVE_INFINITY)).toEqual({ ok: false, reason: 'not_a_decimal' });
    expect(parseUsdc(1e-7)).toEqual({ ok: false, reason: 'not_a_decimal' });
  });

  it('refuses zero and negative amounts', () => {
    expect(parseUsdc('0')).toEqual({ ok: false, reason: 'not_positive' });
    expect(parseUsdc('0.000000')).toEqual({ ok: false, reason: 'not_positive' });
    expect(parseUsdc('-5')).toEqual({ ok: false, reason: 'not_positive' });
    expect(parseUsdc(-5)).toEqual({ ok: false, reason: 'not_positive' });
    expect(parseUsdc(0)).toEqual({ ok: false, reason: 'not_positive' });
  });

  it('refuses a negative amount with a fraction as negative, not as malformed', () => {
    expect(parseUsdc('-5.5')).toEqual({ ok: false, reason: 'not_positive' });
    expect(parseUsdc(-0.25)).toEqual({ ok: false, reason: 'not_positive' });
    // The same digits without the sign are an amount.
    expect(parseUsdc('5.5')).toEqual({ ok: true, baseUnits: 5_500_000n });
  });

  it('does not count leading zeros towards the size of an amount', () => {
    // Fifteen zeros in front of a whole part of one digit: the digits that
    // carry a value are one, well inside the bound on their count.
    expect(parseUsdc('0000000000000001.5')).toEqual({ ok: true, baseUnits: 1_500_000n });
    expect(parseUsdc('000000000000000010')).toEqual({ ok: true, baseUnits: 10_000_000n });
    // Zeros alone carry no value, and are refused for that and not for their count.
    expect(parseUsdc('000000000000000000')).toEqual({ ok: false, reason: 'not_positive' });
  });

  it('admits the largest request and refuses one base unit more', () => {
    expect(MAX_REQUEST_USDC).toBe(1_000_000_000_000n);
    expect(parseUsdc('1000000')).toEqual({ ok: true, baseUnits: 1_000_000_000_000n });
    expect(parseUsdc('1000000.000001')).toEqual({ ok: false, reason: 'too_large' });
    expect(parseUsdc('9'.repeat(400))).toEqual({ ok: false, reason: 'too_large' });
    expect(parseUsdc(1e21)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('amounts as text', () => {
  it('formatUsdcExact always carries six places', () => {
    expect(formatUsdcExact(9_999_990n)).toBe('9.999990');
    expect(formatUsdcExact(10_000_000n)).toBe('10.000000');
    expect(formatUsdcExact(1n)).toBe('0.000001');
    expect(formatUsdcExact(0n)).toBe('0.000000');
  });

  it('formatUsdcShort drops only zeros that carry nothing', () => {
    expect(formatUsdcShort(10_000_000n)).toBe('10');
    expect(formatUsdcShort(5_250_000n)).toBe('5.25');
    expect(formatUsdcShort(9_999_990n)).toBe('9.99999');
    expect(formatUsdcShort(100_000_000n)).toBe('100');
    expect(formatUsdcShort(1n)).toBe('0.000001');
  });

  it('formatUsdcShort reads back as the amount it was given', () => {
    for (const baseUnits of [1n, 104n, 9_999_990n, 5_250_000n, 10_000_000n, 1_000_000_000_000n]) {
      expect(parseUsdc(formatUsdcShort(baseUnits))).toEqual({ ok: true, baseUnits });
    }
  });

  it('formatUsdcCents rounds half up to cents', () => {
    expect(formatUsdcCents(9_999_990n)).toBe('10.00');
    expect(formatUsdcCents(9_523_800n)).toBe('9.52');
    expect(formatUsdcCents(9_525_000n)).toBe('9.53');
    expect(formatUsdcCents(9_524_999n)).toBe('9.52');
    expect(formatUsdcCents(4_999n)).toBe('0.00');
    expect(formatUsdcCents(5_000n)).toBe('0.01');
  });

  it('formatUsdcCentsDown rounds down to the cent', () => {
    expect(formatUsdcCentsDown(4_995_300n)).toBe('4.99');
    expect(formatUsdcCentsDown(5_250_000n)).toBe('5.25');
    expect(formatUsdcCentsDown(9_999n)).toBe('0.00');
    expect(formatUsdcCentsDown(10_000n)).toBe('0.01');
    expect(formatUsdcCentsDown(19_999n)).toBe('0.01');
    expect(formatUsdcCentsDown(0n)).toBe('0.00');
    expect(formatUsdcCentsDown(9_999_990n)).toBe('9.99');
  });

  it('formatUsdcCentsDown never goes below zero', () => {
    expect(formatUsdcCentsDown(-1n)).toBe('0.00');
    expect(formatUsdcCentsDown(-10_000n)).toBe('0.00');
    // A magnitude taken without its sign would read 1.50 here.
    expect(formatUsdcCentsDown(-1_500_000n)).toBe('0.00');
  });

  it('formatUsdcCentsDown writes a large amount in full, past what a float holds exactly', () => {
    expect(formatUsdcCentsDown(1_000_000_000_000n)).toBe('1000000.00');
    expect(formatUsdcCentsDown(123_456_789_999_999n)).toBe('123456789.99');
    // 9007199254740.993999 USDC: its base units are past 2^53.
    expect(formatUsdcCentsDown(9_007_199_254_740_993_999n)).toBe('9007199254740.99');
    // One base unit under a whole cent, past 2^53: the nearest float is over
    // the cent, so an amount that passed through one would read 9007199254741.00.
    expect(formatUsdcCentsDown(9_007_199_254_740_999_999n)).toBe('9007199254740.99');
    expect(formatUsdcCents(9_007_199_254_740_999_999n)).toBe('9007199254741.00');
  });

  it('formatUsdcCentsDown is a cent lower than formatUsdcCents where that one rounds up, and the same where it does not', () => {
    // Half a cent and more rounds up in the other; here it does not.
    expect(formatUsdcCents(4_995_300n)).toBe('5.00');
    expect(formatUsdcCents(9_999n)).toBe('0.01');
    expect(formatUsdcCents(9_525_000n)).toBe('9.53');
    expect(formatUsdcCentsDown(9_525_000n)).toBe('9.52');
    // Under half a cent both give the lower cent, the same text.
    expect(formatUsdcCents(9_524_999n)).toBe('9.52');
    expect(formatUsdcCentsDown(9_524_999n)).toBe('9.52');
  });

  it('formatUsdcCentsDown names at most the amount and less than a cent under it, over a sweep', () => {
    // Every amount from 0 to 3 cents in steps of 7 base units, and a spread of
    // larger ones. The text is read back as a count of cents here, by hand.
    const amounts: bigint[] = [];
    for (let units = 0n; units <= 30_000n; units += 7n) amounts.push(units);
    for (const units of [4_995_300n, 5_249_999n, 5_250_000n, 5_250_001n, 999_999_999n, 1_000_000_009_999n]) amounts.push(units);
    for (const units of amounts) {
      const text = formatUsdcCentsDown(units);
      expect(text).toMatch(/^\d+\.\d{2}$/);
      const cents = BigInt(text.replace('.', ''));
      expect(cents * 10_000n <= units && units < (cents + 1n) * 10_000n).toBe(true);
    }
    expect(amounts.length).toBe(4_292);
  });

  it('isWholeCents says when the cents form is the whole truth', () => {
    expect(isWholeCents(10_000_000n)).toBe(true);
    expect(isWholeCents(5_250_000n)).toBe(true);
    expect(isWholeCents(9_999_990n)).toBe(false);
    expect(isWholeCents(9_523_800n)).toBe(false);
  });

  it('isWholeCents refuses an amount on the tenth-of-a-cent grid', () => {
    // A cent is 10_000 base units. These two are multiples of 1_000 and not of
    // 10_000, so they separate the cent grid from the next finer one, which
    // the amounts above cannot: none of those is a multiple of 1_000 either.
    expect(isWholeCents(1_905_000n)).toBe(false);
    expect(isWholeCents(9_525_000n)).toBe(false);
    // Half a cent less is a whole number of cents.
    expect(isWholeCents(1_900_000n)).toBe(true);
    expect(isWholeCents(9_520_000n)).toBe(true);
  });

  it('writes a negative amount with one sign, in front', () => {
    // Without the sign handling the remainder carries a sign of its own and
    // lands in the middle of the text.
    expect(formatUsdcExact(-1_500_000n)).toBe('-1.500000');
    expect(formatUsdcExact(-1n)).toBe('-0.000001');
    expect(formatUsdcShort(-5_250_000n)).toBe('-5.25');
    expect(formatUsdcCents(-1_500_000n)).toBe('-1.50');
    expect(formatUsdcCents(-9_525_000n)).toBe('-9.53');
    // The same magnitudes without the sign.
    expect(formatUsdcExact(1_500_000n)).toBe('1.500000');
    expect(formatUsdcShort(5_250_000n)).toBe('5.25');
    expect(formatUsdcCents(1_500_000n)).toBe('1.50');
  });

  it('formatOddsTick writes a price with two places', () => {
    expect(formatOddsTick(195)).toBe('1.95');
    expect(formatOddsTick(200)).toBe('2.00');
    expect(formatOddsTick(205)).toBe('2.05');
    expect(formatOddsTick(10_100)).toBe('101.00');
    expect(formatOddsTick(101)).toBe('1.01');
  });

  it('formatOddsTick throws on a negative tick and on a fraction, and takes zero', () => {
    expect(() => formatOddsTick(-5)).toThrow(RangeError);
    expect(() => formatOddsTick(-1)).toThrow(RangeError);
    expect(() => formatOddsTick(1.5)).toThrow(RangeError);
    expect(() => formatOddsTick(195.5)).toThrow(RangeError);
    expect(() => formatOddsTick(Number.NaN)).toThrow(RangeError);
    // Zero is the smallest tick that is written, and 1 the next.
    expect(formatOddsTick(0)).toBe('0.00');
    expect(formatOddsTick(1)).toBe('0.01');
  });
});
