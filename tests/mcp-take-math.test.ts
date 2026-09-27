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

  it('minTakerRisk is the first amount that fills a lot, and one less does not', () => {
    const cases: Array<[number, bigint]> = [
      [101, 1n],
      [150, 50n],
      [191, 91n],
      [200, 100n],
      [205, 104n],
      [250, 149n],
      [10_100, 9_901n],
    ];
    for (const [oddsTick, smallest] of cases) {
      expect(minTakerRisk(oddsTick)).toBe(smallest);
      const base = { oddsTick, remainingMakerRisk: 1_000_000n };
      expect(simulateMatch({ ...base, takerDesiredRisk: smallest })).toMatchObject({
        accepted: true,
        fillMakerRisk: 100n,
      });
      if (smallest > 1n) {
        expect(simulateMatch({ ...base, takerDesiredRisk: smallest - 1n })).toEqual({
          accepted: false,
          reason: 'zero_fill',
        });
      }
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
        remainingAfter: 3_095_300n,
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
        remainingAfter: 0n,
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
        expect(result.plan.remainingAfter).toBe(0n);
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

  it('isWholeCents says when the cents form is the whole truth', () => {
    expect(isWholeCents(10_000_000n)).toBe(true);
    expect(isWholeCents(5_250_000n)).toBe(true);
    expect(isWholeCents(9_999_990n)).toBe(false);
    expect(isWholeCents(9_523_800n)).toBe(false);
  });

  it('formatOddsTick writes a price with two places', () => {
    expect(formatOddsTick(195)).toBe('1.95');
    expect(formatOddsTick(200)).toBe('2.00');
    expect(formatOddsTick(205)).toBe('2.05');
    expect(formatOddsTick(10_100)).toBe('101.00');
    expect(formatOddsTick(101)).toBe('1.01');
  });
});
