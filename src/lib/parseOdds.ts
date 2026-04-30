/**
 * Parse string odds values into numbers. Used when reading consensus
 * odds from upstream feeds where every field arrives as a string.
 */

/**
 * Parse an American odds string into a number or null.
 * Handles: "-110", "+150", "120", "", "N/A", "OFF", "Even", undefined, null.
 */
export function parseAmericanOdds(raw: unknown): number | null {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str || str === 'N/A' || str === 'OFF') return null;
  if (str === 'Even' || str === 'even' || str === 'EVEN') return 100;
  const num = parseInt(str, 10);
  return isNaN(num) ? null : num;
}

/**
 * Parse a line value (spread or total) string into a number or null.
 * Handles: "-2.5", "141.5", "0", "", "N/A", undefined, null.
 */
export function parseLine(raw: unknown): number | null {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str || str === 'N/A' || str === 'OFF') return null;
  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}
