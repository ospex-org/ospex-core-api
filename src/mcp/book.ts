/**
 * The takeable book: which posted quotes a reader could take right now, on
 * which lines, from which side, and which one to take for a given amount.
 *
 * Pure: no I/O, no clock. The caller reads the rows and passes "now" in.
 *
 * ## What "takeable" adds to "open"
 *
 * The open-book read already filters to quotes that are open, visible, not
 * nonce-invalidated and unexpired. {@link takeableQuote} checks the mapped
 * body again and asks for more, because a quote that is merely open is not
 * yet one a link can be handed out for:
 *
 *   - its signature and all nine signed fields are present, since the taker's
 *     transaction carries every one of them;
 *   - at least one whole lot of maker risk is left;
 *   - it does not expire within {@link TAKE_MARGIN_MICROS}, since a reader
 *     needs time to open the link, confirm, and be mined.
 *
 * Each check is stricter than the read, never looser.
 *
 * ## Only lines that exist
 *
 * Quotes are attached to lines, not the other way round: a quote on a
 * `(contest, scorer, line)` with no open speculation finds nothing to attach
 * to and is left out. Taking such a quote would CREATE the line, and both
 * sides pay a fee for that.
 */

import { deriveSpeculationKey } from '../lib/eip712.js';
import { typeToScorer, type MarketType, type ScorerAddresses } from '../lib/speculation.js';
import type { CommitmentBody } from '../v1/commitments.js';
import type { Speculation } from '../v1/utils/speculations.js';
import { parseTimestampMicros } from '../v1/utils/gameTime.js';
import { ODDS_SCALE, isValidOddsTick, maxTakerRisk, planTake, type TakePlan } from './takeMath.js';
import { sideOf, sidesOf, type Side } from './words.js';

/** How long before its expiry a quote stops being offered: two minutes. */
export const TAKE_MARGIN_MICROS = 120_000_000n;

const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

export interface TakeableQuote {
  commitmentHash: string;
  /** Lowercased. */
  maker: string;
  /** The side the MAKER holds. */
  makerPositionType: 0 | 1;
  /** The maker's posted price. Lower is better for the taker. */
  makerOddsTick: number;
  /** Maker risk not yet filled, whole lots. */
  remainingMakerRisk: bigint;
  /** As the database wrote it. */
  expiry: string;
  expiryMicros: bigint;
  speculationKey: string;
}

/**
 * A quote as something a reader could take at `nowMicros`, or `null` when it
 * is not one.
 */
export function takeableQuote(quote: CommitmentBody, nowMicros: bigint): TakeableQuote | null {
  if (quote.bookVisible !== true) return null;
  if (quote.nonceInvalidated) return null;
  if (quote.status !== 'open' && quote.status !== 'partially_filled') return null;
  if (quote.signature === null || !SIGNATURE_PATTERN.test(quote.signature)) return null;
  if (quote.contestId === null || quote.scorer === null || quote.lineTicks === null) return null;
  if (quote.positionType === null || quote.oddsTick === null) return null;
  if (quote.expiry === null || quote.speculationKey === null) return null;
  if (!isValidOddsTick(quote.oddsTick)) return null;
  if (!/^\d+$/.test(quote.riskAmount) || !/^\d+$/.test(quote.nonce)) return null;
  if (!/^\d+$/.test(quote.remainingRiskAmount)) return null;

  const remaining = BigInt(quote.remainingRiskAmount);
  const lots = remaining - (remaining % ODDS_SCALE);
  if (lots <= 0n) return null;

  const expiryMicros = parseTimestampMicros(quote.expiry);
  if (expiryMicros === null) return null;
  if (expiryMicros - nowMicros <= TAKE_MARGIN_MICROS) return null;

  return {
    commitmentHash: quote.commitmentHash,
    maker: quote.maker.toLowerCase(),
    makerPositionType: quote.positionType,
    makerOddsTick: quote.oddsTick,
    remainingMakerRisk: lots,
    expiry: quote.expiry,
    expiryMicros,
    speculationKey: quote.speculationKey.toLowerCase(),
  };
}

/** Best price first; at one price, the larger quote; then by hash, so the order never depends on the read. */
function byPriceThenSize(a: TakeableQuote, b: TakeableQuote): number {
  if (a.makerOddsTick !== b.makerOddsTick) return a.makerOddsTick - b.makerOddsTick;
  if (a.remainingMakerRisk !== b.remainingMakerRisk) return a.remainingMakerRisk > b.remainingMakerRisk ? -1 : 1;
  return a.commitmentHash < b.commitmentHash ? -1 : a.commitmentHash > b.commitmentHash ? 1 : 0;
}

export interface BookLine {
  speculationId: string;
  market: MarketType;
  lineTicks: number;
  /** Quotes a reader could take to be on each side, best first. Keyed by the side the READER gets. */
  quotes: Record<Side, TakeableQuote[]>;
}

/**
 * The open lines of one contest, each with the quotes that can be taken on it.
 *
 * `speculations` are the contest's lines as the contest listing serves them;
 * `quotes` are its open quotes. A line that is settled, or carries no line
 * value, is left out.
 */
export function buildBookLines(
  contestId: string,
  speculations: readonly Speculation[],
  quotes: readonly CommitmentBody[],
  scorers: ScorerAddresses,
  nowMicros: bigint,
): BookLine[] {
  const byKey = new Map<string, TakeableQuote[]>();
  for (const quote of quotes) {
    if (quote.contestId !== contestId) continue;
    const takeable = takeableQuote(quote, nowMicros);
    if (takeable === null) continue;
    const list = byKey.get(takeable.speculationKey) ?? [];
    list.push(takeable);
    byKey.set(takeable.speculationKey, list);
  }

  const lines: BookLine[] = [];
  for (const speculation of speculations) {
    if (speculation.contestId !== contestId) continue;
    if (speculation.speculationStatus !== 0) continue;
    if (speculation.lineTicks === null) continue;
    const key = deriveSpeculationKey(
      BigInt(contestId),
      typeToScorer(speculation.type, scorers).toLowerCase(),
      speculation.lineTicks,
    ).toLowerCase();

    const bySide: Record<Side, TakeableQuote[]> = { away: [], home: [], over: [], under: [] };
    for (const quote of byKey.get(key) ?? []) {
      // The reader gets the side the maker does not hold.
      const readerSide = sideOf(speculation.type, quote.makerPositionType === 0 ? 1 : 0);
      bySide[readerSide].push(quote);
    }
    for (const side of sidesOf(speculation.type)) bySide[side].sort(byPriceThenSize);

    lines.push({
      speculationId: speculation.speculationId,
      market: speculation.type,
      lineTicks: speculation.lineTicks,
      quotes: bySide,
    });
  }

  const marketOrder: Record<MarketType, number> = { moneyline: 0, spread: 1, total: 2 };
  lines.sort((a, b) => {
    if (a.market !== b.market) return marketOrder[a.market] - marketOrder[b.market];
    if (a.lineTicks !== b.lineTicks) return a.lineTicks - b.lineTicks;
    return a.speculationId < b.speculationId ? -1 : a.speculationId > b.speculationId ? 1 : 0;
  });
  return lines;
}

export interface PriceLevel {
  makerOddsTick: number;
  /** The most one order could risk at this price: the largest single quote, not the sum. */
  maxTakerRisk: bigint;
  quotes: number;
}

/**
 * A side's quotes as price levels, best first. One order takes one quote, so a
 * level's size is its LARGEST quote; adding quotes together would describe an
 * order nobody can place.
 */
export function priceLevels(quotes: readonly TakeableQuote[]): PriceLevel[] {
  const levels: PriceLevel[] = [];
  for (const quote of quotes) {
    const capacity = maxTakerRisk(quote.makerOddsTick, quote.remainingMakerRisk);
    const last = levels[levels.length - 1];
    if (last !== undefined && last.makerOddsTick === quote.makerOddsTick) {
      last.quotes += 1;
      if (capacity > last.maxTakerRisk) last.maxTakerRisk = capacity;
    } else {
      levels.push({ makerOddsTick: quote.makerOddsTick, maxTakerRisk: capacity, quotes: 1 });
    }
  }
  return levels;
}

/** What is known about a maker's funds. Absent from the map means nothing is known. */
export interface MakerBacking {
  /** The smaller of the maker's balance and its allowance. */
  backing: bigint;
  /** False when the snapshot is too old to act on. */
  fresh: boolean;
}

export type QuoteChoice =
  | {
      ok: true;
      quote: TakeableQuote;
      plan: TakePlan;
      /** True when a fresh snapshot shows the maker can cover this fill. */
      fundingConfirmed: boolean;
    }
  | { ok: false; reason: 'no_quotes' }
  | { ok: false; reason: 'maker_unfunded' }
  | { ok: false; reason: 'too_small'; minTakerRisk: bigint };

/**
 * Choose the quote to take for `requestedTakerRisk`.
 *
 *   1. Among quotes that can absorb the whole amount, the best price.
 *   2. If none can, the quote that absorbs the most of it.
 *
 * Rule 1 is why the best-priced quote is not always the one chosen: a few
 * cents left over at a better price would otherwise capture every order and
 * fill almost none of it.
 *
 * A quote whose maker is KNOWN to be short of the fill is passed over. One
 * whose funding is unknown is not: nothing is known against it.
 */
export function chooseQuote(
  quotes: readonly TakeableQuote[],
  requestedTakerRisk: bigint,
  backing: ReadonlyMap<string, MakerBacking>,
): QuoteChoice {
  if (quotes.length === 0) return { ok: false, reason: 'no_quotes' };

  const sorted = [...quotes].sort(byPriceThenSize);
  let whole: { quote: TakeableQuote; plan: TakePlan } | undefined;
  let part: { quote: TakeableQuote; plan: TakePlan } | undefined;
  let smallest: bigint | undefined;
  let unfunded = 0;

  for (const quote of sorted) {
    const planned = planTake({
      oddsTick: quote.makerOddsTick,
      remainingMakerRisk: quote.remainingMakerRisk,
      requestedTakerRisk,
    });
    if (!planned.ok) {
      if (planned.reason === 'too_small' && (smallest === undefined || planned.minTakerRisk < smallest)) {
        smallest = planned.minTakerRisk;
      }
      continue;
    }
    const known = backing.get(quote.maker);
    if (known !== undefined && known.fresh && known.backing < planned.plan.fillMakerRisk) {
      unfunded += 1;
      continue;
    }
    if (!planned.plan.reduced) {
      // Sorted best price first, so the first whole fill is the best one.
      whole = { quote, plan: planned.plan };
      break;
    }
    if (part === undefined || planned.plan.takerRisk > part.plan.takerRisk) {
      part = { quote, plan: planned.plan };
    }
  }

  const chosen = whole ?? part;
  if (chosen === undefined) {
    if (unfunded > 0) return { ok: false, reason: 'maker_unfunded' };
    if (smallest !== undefined) return { ok: false, reason: 'too_small', minTakerRisk: smallest };
    return { ok: false, reason: 'no_quotes' };
  }

  const known = backing.get(chosen.quote.maker);
  return {
    ok: true,
    quote: chosen.quote,
    plan: chosen.plan,
    fundingConfirmed: known !== undefined && known.fresh && known.backing >= chosen.plan.fillMakerRisk,
  };
}
