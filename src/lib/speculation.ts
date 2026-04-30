/**
 * Scorer-address ↔ market-type mapping. Pure functions — the caller
 * supplies the configured scorer addresses (so this module isn't
 * coupled to the env layer and works for any network).
 *
 * On the contracts side: each market type has a dedicated scorer
 * contract (Moneyline / Spread / Total). A speculation row's
 * `speculation_scorer` column stores one of those three addresses;
 * this maps it back to a human-readable market type.
 */

export type MarketType = 'moneyline' | 'spread' | 'total';

export interface ScorerAddresses {
  moneyline: string;
  spread: string;
  total: string;
}

/**
 * Map a speculationScorer address to a market type. Case-insensitive.
 */
export function scorerToType(
  scorerAddress: string,
  scorers: ScorerAddresses,
): MarketType | null {
  const addr = scorerAddress.toLowerCase();
  if (addr === scorers.moneyline.toLowerCase()) return 'moneyline';
  if (addr === scorers.spread.toLowerCase()) return 'spread';
  if (addr === scorers.total.toLowerCase()) return 'total';
  return null;
}

/**
 * Inverse of `scorerToType`.
 */
export function typeToScorer(marketType: MarketType, scorers: ScorerAddresses): string {
  if (marketType === 'moneyline') return scorers.moneyline;
  if (marketType === 'spread') return scorers.spread;
  return scorers.total;
}

/**
 * Convert a contract `theNumber` (or `line_ticks`) value to a
 * human-readable line.
 *   spread: theNumber + 0.5
 *   total:  theNumber - 0.5
 *   moneyline: null
 */
export function theNumberToLine(type: MarketType, theNumber: number | null): number | null {
  if (theNumber === null) return null;
  if (type === 'spread') return theNumber + 0.5;
  if (type === 'total') return theNumber - 0.5;
  return null;
}
