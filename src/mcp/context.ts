/**
 * What every connector tool is handed, and what it hands back.
 *
 * A tool is a plain async function of its arguments and a {@link ToolContext}.
 * It reads, it never writes, and it keeps nothing between calls: whatever a
 * later call needs is in the text the earlier one returned.
 */

import type { getSupabase } from '../lib/supabase.js';
import type { ScorerAddresses } from '../lib/speculation.js';

export interface ToolContext {
  sb: ReturnType<typeof getSupabase>;
  network: string;
  /** Absent when the service was started without its scorer addresses. */
  scorers: ScorerAddresses | undefined;
  /** Origin the take links point at, no trailing slash. */
  takeLinkBaseUrl: string;
  /** The call's one clock reading. Every comparison against time in a call uses it. */
  nowMs: number;
}

export interface ToolAnswer {
  text: string;
  /**
   * True when the call could not be served: bad arguments, or a read that
   * failed. A served call that has nothing to offer — no games, no quote, a
   * game already under way — is an answer, not an error.
   */
  isError: boolean;
}

export function answer(lines: readonly string[]): ToolAnswer {
  return { text: lines.join('\n'), isError: false };
}

export function refusal(lines: readonly string[]): ToolAnswer {
  return { text: lines.join('\n'), isError: true };
}

/** Said when a read failed. The cause goes to the log, never to the caller. */
export const READ_FAILED =
  'Ospex could not read its order book just now. Nothing was placed. Try again in a moment.';

/** Said when the service has no scorer addresses configured. */
export const NOT_CONFIGURED =
  'This Ospex service is not configured to read markets. Nothing was placed.';

/** Microseconds since the epoch for a clock reading in milliseconds. */
export function microsOf(nowMs: number): bigint {
  return BigInt(Math.trunc(nowMs)) * 1000n;
}
