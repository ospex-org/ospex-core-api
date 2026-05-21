/**
 * Pure classifier for `current_odds` Realtime payloads. Splits updates into
 * "real price moves" vs "writer re-polled but nothing changed." This logic
 * runs server-side (core-api) so the SDK never touches Supabase Realtime — it
 * consumes the already-classified `change` / `refresh` events off the SSE
 * stream (see `v1/stream/oddsHub.ts`).
 *
 * Decision rules (require REPLICA IDENTITY FULL on the table so the OLD row is
 * in the Realtime payload — confirmed in the indexer schema):
 *
 *   - INSERT (no oldRow)                                      → 'change'
 *   - any tracked price column differs                        → 'change'
 *   - changed_at advances                                     → 'change'
 *   - else upstream_last_updated || poll_captured_at advances → 'refresh'
 *   - else                                                    → 'none'
 *
 * Tracked price columns: line, away_odds_american, home_odds_american.
 *
 * Timestamps are compared via Date.parse, which handles the tz-aware ISO
 * strings PostgREST/Realtime emit. NaN comparisons fall through to false, so a
 * malformed timestamp just suppresses that signal — the function never throws.
 */

/** A row of `current_odds`, snake_case as it arrives from Supabase. */
export interface CurrentOddsRow {
  network: string;
  jsonodds_id: string;
  market: string;
  line: number | null;
  away_odds_american: number | null;
  home_odds_american: number | null;
  upstream_last_updated: string;
  poll_captured_at: string;
  changed_at: string;
}

export type OddsUpdateClass = 'change' | 'refresh' | 'none';

export function classifyOddsUpdate(
  oldRow: CurrentOddsRow | null | undefined,
  newRow: CurrentOddsRow,
): OddsUpdateClass {
  if (!oldRow) return 'change';

  const priceChanged =
    oldRow.line !== newRow.line ||
    oldRow.away_odds_american !== newRow.away_odds_american ||
    oldRow.home_odds_american !== newRow.home_odds_american;

  if (priceChanged) return 'change';

  if (advanced(oldRow.changed_at, newRow.changed_at)) return 'change';

  if (
    advanced(oldRow.upstream_last_updated, newRow.upstream_last_updated) ||
    advanced(oldRow.poll_captured_at, newRow.poll_captured_at)
  ) {
    return 'refresh';
  }

  return 'none';
}

function advanced(prev: string, next: string): boolean {
  const a = Date.parse(prev);
  const b = Date.parse(next);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return b > a;
}
