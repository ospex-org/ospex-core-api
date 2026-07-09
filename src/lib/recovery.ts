/**
 * Shared helpers for cursor-based recovery reads (`?since=<cursor>`).
 *
 * Recovery mode is the catch-up side of the push contract: a
 * client streams live deltas, and after a disconnect asks for everything
 * after its last cursor. It is intentionally distinct from the existing
 * open-book list endpoints — recovery orders by `(row_updated_at, id)` and
 * includes terminal lifecycle rows (filled / cancelled / settled / claimed)
 * so a client converges its local state; it must NOT inherit the open-book
 * default filters that hide those terminal rows.
 *
 * For mutable tables (commitments, positions, speculations, contests) this
 * is ordered state-delta *convergence* — a row that changed several times
 * while the client was away may surface only at its latest state. The only
 * append-only, event-like stream is `position_fills` (`/v1/fills`), where
 * every row is delivered.
 */

import type { Request } from 'express';
import type { ApiError } from '../middleware/errorHandler.js';
import {
  CursorError,
  cursorFromRow,
  decodeCursor,
  keysetOrExpr,
  type CursorableRow,
  type CursorTable,
  type StreamCursor,
} from './cursor.js';

export const RECOVERY_DEFAULT_LIMIT = 100;
// PostgREST caps any single response at 1000 rows; recovery never pages
// beyond that in one request.
export const RECOVERY_MAX_LIMIT = 1000;

// How far before a `live` cursor's timestamp recovery re-scans, to catch rows
// committed late under the `now()`-is-transaction-start schema. Must exceed the
// longest writer transaction (the indexer's RPC writes are sub-second, so 30s
// is a wide margin). Only the first (resume) request pays this; pagination uses
// `page` cursors and is strict, so termination holds for any overlap size.
export const RECOVERY_OVERLAP_MS = 30_000;

export interface ParsedRecovery {
  /** Decoded `?since=` cursor, or null when the client is starting fresh. */
  cursor: StreamCursor | null;
  /** Raw `?since=` string, echoed back as `nextCursor` when a page is empty. */
  sinceRaw: string | null;
  limit: number;
}

/**
 * Parse + validate `?since=` and `?limit=` for a recovery endpoint. The
 * cursor's embedded table must match `table` or it's a 400.
 */
export function parseRecovery(
  req: Request,
  table: CursorTable,
): ParsedRecovery | { errorBody: ApiError } {
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : RECOVERY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > RECOVERY_MAX_LIMIT) {
    return {
      errorBody: {
        error: `limit must be an integer between 1 and ${RECOVERY_MAX_LIMIT}.`,
        code: 'INVALID_PARAM',
      },
    };
  }

  if (req.query.since === undefined) {
    return { cursor: null, sinceRaw: null, limit };
  }

  const sinceRaw = String(req.query.since);
  try {
    return { cursor: decodeCursor(sinceRaw, table), sinceRaw, limit };
  } catch (err) {
    if (err instanceof CursorError) return { errorBody: err.apiError };
    return { errorBody: { error: 'Invalid cursor.', code: 'INVALID_CURSOR' } };
  }
}

/**
 * PostgREST `.or(...)` keyset expression for a recovery cursor.
 *
 *   - `page` cursor → strict `(row_updated_at, id) > (s, i)`. Forward-only,
 *     terminating — used for pagination through a backlog.
 *   - `live` cursor → re-scan an overlap window: `(row_updated_at, id) >
 *     (s - overlap, 0)`, i.e. effectively `row_updated_at >= s - overlap`.
 *     This catches a row committed late with `row_updated_at` predating the
 *     cursor (now() is transaction-start time). `nextCursor` always returns a
 *     `page` cursor, so the very next page is strict and paging terminates
 *     regardless of how large the overlap window is.
 */
export function recoveryKeysetExpr(cursor: StreamCursor): string {
  if (cursor.k === 'page') {
    return keysetOrExpr(cursor.s, cursor.i);
  }
  const flooredMs = Date.parse(cursor.s) - RECOVERY_OVERLAP_MS;
  return keysetOrExpr(new Date(flooredMs).toISOString(), '0');
}

/**
 * Cursor to hand back for the next poll. Always a `page` cursor on a non-empty
 * result so the client pages strictly forward (no repeated overlap re-scan):
 *   - rows returned → the last row's `page` cursor (advance forward);
 *   - empty page    → echo the input cursor so the client holds position and,
 *                     if it was a `live` cursor, keeps re-scanning the overlap
 *                     for future late commits (or null when it started fresh).
 */
export function nextCursor(
  table: CursorTable,
  lastRow: CursorableRow | undefined,
  sinceRaw: string | null,
): string | null {
  if (lastRow !== undefined) return cursorFromRow(table, lastRow, 'page');
  return sinceRaw;
}
