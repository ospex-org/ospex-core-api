/**
 * Numeric / value sanitization helpers.
 *
 * Ported from the legacy agent server with the Firebase-Timestamp branches
 * removed. Supabase returns timestamps as ISO strings, so the legacy
 * `.toDate()` / `._seconds` handling is gone. The contest-doc helpers
 * (`sanitizeContestDoc`, `extractContestFields`) depended on Firebase
 * row shapes and are intentionally not ported — they'll be rebuilt
 * against Supabase types when contest read endpoints land.
 */

/**
 * Convert a wei6 string (USDC with 6 decimals) to a number.
 * Example: "5000000" → 5.0
 */
export function wei6ToUSDC(raw: string | number | bigint | undefined | null): number {
  if (raw == null) return 0;
  return Number(BigInt(String(raw))) / 1_000_000;
}

/**
 * Convert a Date / ISO string / unix-millis number to an ISO 8601 string.
 * Returns null on unparseable input.
 */
export function toISOString(value: Date | string | number | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
