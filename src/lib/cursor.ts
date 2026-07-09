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
 * trigger-maintained on every UPDATE (and backed by a `(network,
 * row_updated_at, id)` index), so it advances on both insert and mutation.
 *
 * The cursor is OPAQUE to clients: minted and parsed only here, never on
 * the client side. The five recovery resources share this codec.
 */

import type { ApiError } from '../middleware/errorHandler.js';

export type CursorTable = 'commitments' | 'positions' | 'fills' | 'speculations' | 'contests';

/**
 * `live`  — minted at the live tail (stream event / snapshot tip). Resuming
 *           from it re-scans the recovery overlap window, because `now()` is
 *           transaction-start time and a slow writer tx can land a row whose
 *           `row_updated_at` predates this cursor.
 * `page`  — a recovery continuation cursor. Strict keyset, no overlap, so
 *           paging through a backlog terminates regardless of overlap size.
 */
export type CursorKind = 'live' | 'page';

export interface StreamCursor {
  /** Resource table this cursor was minted for. */
  t: CursorTable;
  /** `row_updated_at`, verbatim from the source row (full precision ISO). */
  s: string;
  /** `id` (bigint identity) as a decimal string. */
  i: string;
  /** Whether resuming from this cursor re-scans the overlap window. */
  k: CursorKind;
}

// The exact ISO-8601 timestamptz shapes PostgREST/supabase-js mint for a
// `timestamptz` column (`...Z` or `...+00:00`, optional fractional seconds).
// Validating against this — not the permissive Date.parse — keeps a crafted
// timestamp (e.g. one containing a comma, which is the PostgREST `.or()`
// delimiter) from reaching the filter grammar and 500-ing instead of a clean
// 400 INVALID_CURSOR.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

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
  return Buffer.from(JSON.stringify({ t: c.t, s: c.s, i: c.i, k: c.k }), 'utf8').toString('base64url');
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
  const { t, s, i, k } = obj;
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
  if (!ISO_TIMESTAMP.test(s)) {
    throw new CursorError('Malformed cursor: timestamp is not an ISO-8601 timestamptz.');
  }
  // Absent kind defaults to `live` — the conservative choice (applies the
  // overlap re-scan). Present-but-unrecognized is rejected.
  let kind: CursorKind;
  if (k === undefined) {
    kind = 'live';
  } else if (k === 'live' || k === 'page') {
    kind = k;
  } else {
    throw new CursorError('Malformed cursor: kind must be "live" or "page".');
  }
  return { t: expectedTable, s, i, k: kind };
}

/** A row carrying the two columns every cursor needs. */
export interface CursorableRow {
  row_updated_at: string;
  id: string | number;
}

export function cursorFromRow(table: CursorTable, row: CursorableRow, kind: CursorKind): string {
  return encodeCursor({ t: table, s: row.row_updated_at, i: String(row.id), k: kind });
}

/**
 * PostgREST `or=(...)` expression for keyset pagination strictly after a
 * comparison point `(s, i)`: `(row_updated_at, id) > (s, i)`, expanded to
 *   row_updated_at > s  OR  (row_updated_at = s AND id > i)
 *
 * Takes the comparison point explicitly because recovery's resume mode
 * compares against a floored timestamp (`s - overlap`, `i = '0'`), not the
 * cursor's own `(s, i)` — see recovery.ts `recoveryKeysetExpr`.
 *
 * Pass to supabase-js `.or(expr)`. supabase-js URL-encodes the value, so
 * the timestamp's `:` / `+` / `.` survive transport, and PostgREST compares
 * timestamptz semantically — the `eq` half matches the stored instant
 * regardless of textual formatting. Strict `>` plus the id tie-breaker means
 * a page boundary inside a same-`row_updated_at` batch resumes mid-batch
 * without re-emitting or skipping rows.
 */
export function keysetOrExpr(s: string, i: string): string {
  return `row_updated_at.gt.${s},and(row_updated_at.eq.${s},id.gt.${i})`;
}
