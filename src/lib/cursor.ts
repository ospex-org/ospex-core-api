/**
 * Opaque stream/recovery cursor.
 *
 * Encodes `{ t, s, i }` as base64url JSON:
 *   t — resource table the cursor belongs to. Guards against reusing a
 *       cursor minted by one stream on a different one.
 *   s — `row_updated_at`, verbatim as the DB returned it (full precision).
 *   i — `id` (bigint identity) as a decimal string. Same-timestamp
 *       tie-breaker so two rows sharing `row_updated_at` are never skipped.
 *
 * Ordering is keyset `(row_updated_at, id)` ascending — not offset — so
 * paging is stable under concurrent writes. `row_updated_at` is
 * trigger-maintained on every UPDATE (see indexer migration 048's backing
 * index), so it advances on both insert and mutation.
 *
 * The cursor is OPAQUE to clients: minted and parsed only here, never on
 * the client side. The five recovery resources share this codec.
 */

import type { ApiError } from '../middleware/errorHandler.js';

export type CursorTable = 'commitments' | 'positions' | 'fills' | 'speculations' | 'contests';

export interface StreamCursor {
  /** Resource table this cursor was minted for. */
  t: CursorTable;
  /** `row_updated_at`, verbatim from the source row (full precision ISO). */
  s: string;
  /** `id` (bigint identity) as a decimal string. */
  i: string;
}

/**
 * Thrown when a client-supplied `?since=` value can't be decoded or is
 * for the wrong resource. Carries a ready-to-send `ApiError` so handlers
 * map it to a 400 without re-deriving the message.
 */
export class CursorError extends Error {
  readonly apiError: ApiError;
  constructor(message: string) {
    super(message);
    this.name = 'CursorError';
    this.apiError = { error: message, code: 'INVALID_CURSOR' };
  }
}

export function encodeCursor(c: StreamCursor): string {
  return Buffer.from(JSON.stringify({ t: c.t, s: c.s, i: c.i }), 'utf8').toString('base64url');
}

/**
 * Decode a client cursor, asserting it belongs to `expectedTable`.
 * Throws {@link CursorError} on any malformation — never returns a
 * partially-valid cursor.
 */
export function decodeCursor(raw: string, expectedTable: CursorTable): StreamCursor {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('Malformed cursor: not valid base64url-encoded JSON.');
  }
  if (typeof json !== 'object' || json === null) {
    throw new CursorError('Malformed cursor: expected a JSON object.');
  }
  const obj = json as Record<string, unknown>;
  const { t, s, i } = obj;
  if (typeof t !== 'string' || typeof s !== 'string' || typeof i !== 'string') {
    throw new CursorError('Malformed cursor: missing string fields t, s, i.');
  }
  if (t !== expectedTable) {
    throw new CursorError(
      `Cursor belongs to "${t}", not "${expectedTable}". Use a cursor minted by this resource.`,
    );
  }
  if (!/^\d+$/.test(i)) {
    throw new CursorError('Malformed cursor: id must be a non-negative integer.');
  }
  if (Number.isNaN(Date.parse(s))) {
    throw new CursorError('Malformed cursor: timestamp is not a valid date.');
  }
  return { t: expectedTable, s, i };
}

/** A row carrying the two columns every cursor needs. */
export interface CursorableRow {
  row_updated_at: string;
  id: string | number;
}

export function cursorFromRow(table: CursorTable, row: CursorableRow): string {
  return encodeCursor({ t: table, s: row.row_updated_at, i: String(row.id) });
}

/**
 * PostgREST `or=(...)` expression for keyset pagination strictly after a
 * cursor: `(row_updated_at, id) > (cursor.s, cursor.i)`, expanded to
 *   row_updated_at > s  OR  (row_updated_at = s AND id > i)
 *
 * Pass to supabase-js `.or(expr)`. supabase-js URL-encodes the value, so
 * the timestamp's `:` / `+` / `.` survive transport, and PostgREST compares
 * timestamptz semantically — the `eq` half matches the stored instant the
 * cursor was minted from regardless of textual formatting.
 *
 * Strict `>` (not `>=`) plus the id tie-breaker means a page boundary that
 * lands inside a same-`row_updated_at` batch resumes mid-batch without
 * re-emitting or skipping rows.
 */
export function keysetOrExpr(c: StreamCursor): string {
  return `row_updated_at.gt.${c.s},and(row_updated_at.eq.${c.s},id.gt.${c.i})`;
}
