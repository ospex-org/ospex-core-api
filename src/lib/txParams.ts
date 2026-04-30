/**
 * Numeric helpers for building on-chain transaction parameters.
 *
 * The R3 builders from ospex-agent-server (`createUnmatchedPair`,
 * `createUnmatchedPairWithSpeculation`) are intentionally NOT ported —
 * R4 superseded those methods with `matchCommitment`, which takes the
 * signed commitment + signature directly. R4 builders will land when a
 * future endpoint needs to return frontend-ready txParams for matching.
 *
 * The numeric primitives below are R4-compatible and reusable.
 */

import type { ScorerAddresses } from './speculation.js';

/** USDC has 6 decimals. */
export function usdcToOnChain(usdc: number): string {
  return String(Math.round(usdc * 1_000_000));
}

/** Odds tick scale used by the contracts. */
const ODDS_TICK_SCALE = 10_000_000;

export function decimalOddsToScaled(decimalOdds: number): string {
  return String(Math.round(decimalOdds * ODDS_TICK_SCALE));
}

/**
 * Map a side label to the on-chain `positionType` enum value.
 *   away / over  → 0 (Upper)
 *   home / under → 1 (Lower)
 */
export type Side = 'away' | 'home' | 'over' | 'under';

export function sideToPositionType(side: Side): 0 | 1 {
  return side === 'away' || side === 'over' ? 0 : 1;
}

/**
 * Convert a Date / ISO / unix-millis value to a unix-seconds string.
 * Returns undefined on unparseable input.
 */
export function toUnixSecondsString(value: Date | string | number | null | undefined): string | undefined {
  if (value == null) return undefined;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return String(Math.floor(ms / 1000));
}

// Re-export for convenience — handlers building any tx that targets a
// specific market typically pull both the scorer address and the type.
export type { ScorerAddresses };
