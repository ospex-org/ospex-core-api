/**
 * The arithmetic of taking a posted quote.
 *
 * A taker calls `MatchingModule.matchCommitment(commitment, signature,
 * takerDesiredRisk)`. This module mirrors what that function does with
 * `takerDesiredRisk`, so a preview built here states the amounts the chain
 * would move rather than an approximation of them.
 *
 * Pure: no I/O, no clock, no module state. Every amount is USDC base units
 * (6 decimals) as a `bigint`; nothing here passes money through a float.
 *
 * ## The contract's rule, restated
 *
 *     profitTicks   = oddsTick - 100
 *     rawFill       = ceil(takerDesiredRisk * 100 / profitTicks)
 *     fillMakerRisk = rawFill rounded DOWN to a multiple of 100
 *     refuse when fillMakerRisk == 0 or fillMakerRisk > remaining maker risk
 *     takerRisk     = floor(fillMakerRisk * profitTicks / 100), capped at takerDesiredRisk
 *
 * The taker pays `takerRisk` and stands to win `fillMakerRisk`. Two
 * consequences a preview has to carry:
 *
 *   - The taker can pay slightly LESS than they asked to risk, never more.
 *   - A request larger than the quote can absorb is REFUSED, not clamped. A
 *     caller that wants "as much as is left" must ask for exactly that.
 *
 * `oddsTick` is the MAKER's price. The taker's price is its complement, and a
 * LOWER maker tick is a BETTER price for the taker.
 */

/** `MatchingModule.ODDS_SCALE`. Also the lot size of a maker's risk. */
export const ODDS_SCALE = 100n;
/** `MatchingModule.MIN_ODDS` — decimal 1.01. */
export const MIN_ODDS_TICK = 101;
/** `MatchingModule.MAX_ODDS` — decimal 101.00. */
export const MAX_ODDS_TICK = 10_100;

const USDC_DECIMALS = 6;
const USDC_UNIT = 1_000_000n;

export function isValidOddsTick(oddsTick: number): boolean {
  return Number.isInteger(oddsTick) && oddsTick >= MIN_ODDS_TICK && oddsTick <= MAX_ODDS_TICK;
}

export type MatchRefusal =
  /** `oddsTick` is outside the protocol range. */
  | 'odds_out_of_range'
  /** `takerDesiredRisk` is zero or negative. */
  | 'zero_desired'
  /** The quote has no maker risk left. */
  | 'nothing_left'
  /** The request is too small to fill one lot of maker risk. */
  | 'zero_fill'
  /** The request needs more maker risk than the quote has left. */
  | 'exceeds_remaining';

export type MatchOutcome =
  | { accepted: true; fillMakerRisk: bigint; takerRisk: bigint }
  | { accepted: false; reason: MatchRefusal };

export interface MatchInput {
  /** The maker's posted price, in ticks. */
  oddsTick: number;
  /** Maker risk not yet filled. */
  remainingMakerRisk: bigint;
  /** What the taker would pass as `takerDesiredRisk`. */
  takerDesiredRisk: bigint;
}

/**
 * What `matchCommitment` would do with this request: the amounts it would
 * move, or the reason it would revert. Covers the arithmetic only — signature,
 * expiry, nonce and contest state are separate checks.
 */
export function simulateMatch(input: MatchInput): MatchOutcome {
  const { oddsTick, remainingMakerRisk, takerDesiredRisk } = input;
  if (!isValidOddsTick(oddsTick)) return { accepted: false, reason: 'odds_out_of_range' };
  if (takerDesiredRisk <= 0n) return { accepted: false, reason: 'zero_desired' };
  if (remainingMakerRisk <= 0n) return { accepted: false, reason: 'nothing_left' };

  const profitTicks = BigInt(oddsTick) - ODDS_SCALE;
  const rawFill = (takerDesiredRisk * ODDS_SCALE + profitTicks - 1n) / profitTicks;
  const fillMakerRisk = rawFill - (rawFill % ODDS_SCALE);
  if (fillMakerRisk === 0n) return { accepted: false, reason: 'zero_fill' };
  if (fillMakerRisk > remainingMakerRisk) return { accepted: false, reason: 'exceeds_remaining' };

  const uncapped = (fillMakerRisk * profitTicks) / ODDS_SCALE;
  const takerRisk = uncapped > takerDesiredRisk ? takerDesiredRisk : uncapped;
  return { accepted: true, fillMakerRisk, takerRisk };
}

/**
 * The taker amount that takes everything a quote has left, or `0n` when
 * nothing can be taken.
 *
 * Remaining maker risk is floored to a whole lot first. On chain it always is
 * one already (a signed risk amount and every fill are multiples of the lot),
 * so this only matters for a row that is wrong, where it keeps the answer
 * inside what the quote can absorb.
 */
export function maxTakerRisk(oddsTick: number, remainingMakerRisk: bigint): bigint {
  if (!isValidOddsTick(oddsTick) || remainingMakerRisk <= 0n) return 0n;
  const lots = remainingMakerRisk - (remainingMakerRisk % ODDS_SCALE);
  return (lots * (BigInt(oddsTick) - ODDS_SCALE)) / ODDS_SCALE;
}

/** The smallest taker amount that fills one lot at this price. */
export function minTakerRisk(oddsTick: number): bigint {
  if (!isValidOddsTick(oddsTick)) return 0n;
  // One lot fills once ceil(t * 100 / p) reaches 100, i.e. once t * 100 > 99 * p.
  return (99n * (BigInt(oddsTick) - ODDS_SCALE)) / ODDS_SCALE + 1n;
}

/**
 * The taker's price for a quote posted at `oddsTick`, in ticks, rounded half
 * up to the protocol's two decimals.
 *
 * If the maker's decimal price is D, the taker's is D / (D - 1). This is a
 * DISPLAY value: the amounts come from {@link simulateMatch}, which never
 * uses it, so its rounding cannot move money.
 */
export function takerOddsTick(oddsTick: number): number {
  if (!isValidOddsTick(oddsTick)) {
    throw new RangeError(`oddsTick ${String(oddsTick)} is outside ${String(MIN_ODDS_TICK)}..${String(MAX_ODDS_TICK)}`);
  }
  const profitTicks = BigInt(oddsTick) - ODDS_SCALE;
  return Number((2n * ODDS_SCALE * BigInt(oddsTick) + profitTicks) / (2n * profitTicks));
}

export interface TakePlan {
  /** What the taker asked to risk. */
  requestedTakerRisk: bigint;
  /** The amount to pass on chain. Equals the request unless the quote could not absorb it. */
  takerDesiredRisk: bigint;
  /** Maker risk this take consumes. */
  fillMakerRisk: bigint;
  /** What the taker pays. At most `takerDesiredRisk`. */
  takerRisk: bigint;
  /** What the taker wins. Equals `fillMakerRisk`. */
  takerProfit: bigint;
  /** True when the request was cut down to what the quote has left. */
  reduced: boolean;
  /** The taker's price, in ticks. Display only. */
  takerOddsTick: number;
}

export type TakePlanResult =
  | { ok: true; plan: TakePlan }
  | { ok: false; reason: 'odds_out_of_range' | 'zero_desired' | 'nothing_left' }
  | { ok: false; reason: 'too_small'; minTakerRisk: bigint };

/**
 * Size a take against one quote.
 *
 * A request the quote can absorb is planned as asked. A request that is too
 * large is planned for everything the quote has left and marked `reduced`,
 * because the contract would revert the original rather than fill part of it.
 */
export function planTake(args: {
  oddsTick: number;
  remainingMakerRisk: bigint;
  requestedTakerRisk: bigint;
}): TakePlanResult {
  const { oddsTick, remainingMakerRisk, requestedTakerRisk } = args;
  const plan = (
    takerDesiredRisk: bigint,
    moved: { fillMakerRisk: bigint; takerRisk: bigint },
    reduced: boolean,
  ): TakePlan => ({
    requestedTakerRisk,
    takerDesiredRisk,
    fillMakerRisk: moved.fillMakerRisk,
    takerRisk: moved.takerRisk,
    takerProfit: moved.fillMakerRisk,
    reduced,
    takerOddsTick: takerOddsTick(oddsTick),
  });

  const asked = simulateMatch({ oddsTick, remainingMakerRisk, takerDesiredRisk: requestedTakerRisk });
  if (asked.accepted) return { ok: true, plan: plan(requestedTakerRisk, asked, false) };
  if (asked.reason === 'zero_fill') {
    return { ok: false, reason: 'too_small', minTakerRisk: minTakerRisk(oddsTick) };
  }
  if (asked.reason !== 'exceeds_remaining') return { ok: false, reason: asked.reason };

  const everything = maxTakerRisk(oddsTick, remainingMakerRisk);
  // Under one whole lot left. Not reachable from chain state, where remaining
  // risk is always on the lot grid; a row that is off it has nothing takeable.
  if (everything === 0n) return { ok: false, reason: 'nothing_left' };
  const full = simulateMatch({ oddsTick, remainingMakerRisk, takerDesiredRisk: everything });
  if (!full.accepted) {
    // `everything` is whole lots times the profit ratio, which the rule above
    // fills exactly. Reaching here means this file's arithmetic is wrong.
    throw new Error(`a full take of ${everything.toString()} was refused: ${full.reason}`);
  }
  return { ok: true, plan: plan(everything, full, true) };
}

// ── amounts as text ────────────────────────────────────────────────────

const DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const NEGATIVE_DECIMAL_RE = /^-\d+(?:\.\d+)?$/;

/** The largest amount a request may name: 1,000,000 USDC. */
export const MAX_REQUEST_USDC = 1_000_000n * USDC_UNIT;

export type ParsedAmount =
  | { ok: true; baseUnits: bigint }
  | { ok: false; reason: 'not_a_decimal' | 'too_many_decimals' | 'not_positive' | 'too_large' };

/**
 * Parse a USDC amount into base units without going through a float.
 *
 * A JSON number is accepted because that is what a model usually sends. It is
 * read through its shortest decimal form, so `10.1` is "10.1" and not the
 * binary value nearest to it. A number written in exponent form, or one too
 * large to be an exact integer, is refused.
 */
export function parseUsdc(input: string | number): ParsedAmount {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, reason: 'not_a_decimal' };
    if (Math.abs(input) > Number.MAX_SAFE_INTEGER) return { ok: false, reason: 'too_large' };
    text = String(input);
  } else {
    text = input;
  }
  if (NEGATIVE_DECIMAL_RE.test(text)) return { ok: false, reason: 'not_positive' };
  if (!DECIMAL_RE.test(text)) return { ok: false, reason: 'not_a_decimal' };

  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  if (fraction.length > USDC_DECIMALS) return { ok: false, reason: 'too_many_decimals' };
  // Bound the digit count before BigInt sees it: the pattern admits a number
  // of any length. Thirteen whole digits is generous, since the cap below has
  // seven, and that cap is what does the refusing.
  if (whole.replace(/^0+/, '').length > 13) return { ok: false, reason: 'too_large' };

  const baseUnits = BigInt(whole) * USDC_UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, '0'));
  if (baseUnits <= 0n) return { ok: false, reason: 'not_positive' };
  if (baseUnits > MAX_REQUEST_USDC) return { ok: false, reason: 'too_large' };
  return { ok: true, baseUnits };
}

/** Base units as a decimal with all six places, e.g. `9.999990`. */
export function formatUsdcExact(baseUnits: bigint): string {
  const negative = baseUnits < 0n;
  const magnitude = negative ? -baseUnits : baseUnits;
  const whole = magnitude / USDC_UNIT;
  const fraction = (magnitude % USDC_UNIT).toString().padStart(USDC_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Base units as the shortest decimal that loses nothing, e.g. `10`, `5.25`. */
export function formatUsdcShort(baseUnits: bigint): string {
  const exact = formatUsdcExact(baseUnits);
  const trimmed = exact.replace(/0+$/, '');
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/** Base units rounded half up to cents, e.g. `9.52`. For reading, not for arithmetic. */
export function formatUsdcCents(baseUnits: bigint): string {
  const negative = baseUnits < 0n;
  const magnitude = negative ? -baseUnits : baseUnits;
  const cents = (magnitude + 5_000n) / 10_000n;
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/**
 * Base units rounded DOWN to cents, for an "up to" amount: a most that is
 * rounded up names an amount that does not fit. Never below zero.
 */
export function formatUsdcCentsDown(baseUnits: bigint): string {
  const magnitude = baseUnits < 0n ? 0n : baseUnits;
  return formatUsdcCents(magnitude - (magnitude % 10_000n));
}

/** True when the cents form says exactly what the base-unit amount is. */
export function isWholeCents(baseUnits: bigint): boolean {
  return baseUnits % 10_000n === 0n;
}

/** An odds tick as a decimal price, e.g. `195` → `1.95`. */
export function formatOddsTick(oddsTick: number): string {
  if (!Number.isInteger(oddsTick) || oddsTick < 0) {
    throw new RangeError(`oddsTick ${String(oddsTick)} is not a non-negative integer`);
  }
  const whole = Math.trunc(oddsTick / 100);
  const fraction = (oddsTick % 100).toString().padStart(2, '0');
  return `${String(whole)}.${fraction}`;
}
