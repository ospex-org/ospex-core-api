/**
 * Stream resource registry — the single per-resource config that powers both
 * the live poller and the per-connection catch-up. Each entry says what to
 * SELECT, how to map a row to the public body (reusing the exact A1 recovery
 * mappers, so stream deltas and REST recovery agree shape-for-shape), how to
 * validate query filters, and which columns those filters constrain.
 *
 * Filters are identity/scope only (not lifecycle-status). `parseFilters`
 * returns a column→value map (snake_case columns, validated values); the same
 * map is applied as `.eq()` on the catch-up query and matched in-memory for
 * live fan-out — see `matchesRow`. All stream filters map to direct, indexed
 * columns so parsing stays synchronous (no speculationId→key DB lookup; use
 * the A1 REST recovery endpoint for that).
 */

import type { Request } from 'express';
import { isAddress } from 'ethers';
import type { ApiError } from '../../middleware/errorHandler.js';
import type { CursorableRow, CursorTable } from '../../lib/cursor.js';
import { CONTESTS_VIEW } from '../../lib/tables.js';

import {
  commitmentRowToPublicBody,
  COMMITMENT_RECOVERY_COLUMNS,
  type CommitmentRow,
} from '../commitments.js';
import { rowToBody as fillRowToBody, FILL_COLUMNS, type FillRow } from '../fills.js';
import {
  positionRecoveryRowToBody,
  POSITION_RECOVERY_COLUMNS,
  type PositionRecoveryRow,
} from '../positions.js';
import {
  contestRecoveryRowToBody,
  CONTEST_RECOVERY_COLUMNS,
  type ContestRecoveryRow,
} from '../contests.js';
import { specRowToSpeculation, SPECULATION_COLUMNS, type SpeculationRow } from '../utils/speculations.js';

export type StreamResourceName = 'commitments' | 'positions' | 'fills' | 'speculations' | 'contests';

/** A raw delta row — always carries the cursor columns plus the resource's selected columns. */
export type StreamRow = CursorableRow & Record<string, unknown>;

/** Validated filter map: snake_case column → string value to compare. */
export type StreamFilters = Record<string, string>;

export interface StreamResource {
  name: StreamResourceName;
  /** Cursor resource tag (matches CursorTable). */
  cursorTable: CursorTable;
  /** Supabase table to poll / catch up from. */
  table: string;
  /** SELECT list — includes id + row_updated_at and every filterable column. */
  columns: string;
  /** Map a raw row to the public body. `null` drops the row (e.g. an unenriched speculation). */
  toBody(row: StreamRow): unknown | null;
  /** Validate query params into a column→value filter map, or a 400 body. */
  parseFilters(req: Request): StreamFilters | { errorBody: ApiError };
}

/** In-memory fan-out match: a row matches when every filtered column equals its value. */
export function matchesRow(filters: StreamFilters, row: StreamRow): boolean {
  for (const [col, val] of Object.entries(filters)) {
    if (String(row[col] ?? '') !== val) return false;
  }
  return true;
}

// ── filter validators ───────────────────────────────────────────────────
// Return null when the param is absent, { value } when valid, { error } when not.
type Check = { value: string } | { error: string } | null;

function vAddress(raw: unknown): Check {
  if (raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  return isAddress(s) ? { value: s } : { error: 'must be a valid Ethereum address.' };
}
function vUint(raw: unknown): Check {
  if (raw === undefined) return null;
  try {
    const n = BigInt(String(raw));
    if (n < 0n) throw new Error();
    return { value: n.toString() };
  } catch {
    return { error: 'must be a non-negative integer.' };
  }
}
function vHash(raw: unknown): Check {
  if (raw === undefined) return null;
  const s = String(raw).trim();
  return /^0x[0-9a-f]{64}$/i.test(s) ? { value: s.toLowerCase() } : { error: 'must be a 0x-prefixed 32-byte hex string.' };
}

/** Run a set of [param, column, check] tuples into a filter map or a 400. */
function collect(
  specs: Array<readonly [param: string, column: string, check: Check]>,
): StreamFilters | { errorBody: ApiError } {
  const out: StreamFilters = {};
  for (const [param, column, check] of specs) {
    if (check === null) continue;
    if ('error' in check) {
      return { errorBody: { error: `${param} ${check.error}`, code: 'INVALID_PARAM' } };
    }
    out[column] = check.value;
  }
  return out;
}

// ── registry ──────────────────────────────────────────────────────────────

export const STREAM_RESOURCES: Record<StreamResourceName, StreamResource> = {
  commitments: {
    name: 'commitments',
    cursorTable: 'commitments',
    table: 'commitments',
    columns: COMMITMENT_RECOVERY_COLUMNS,
    // Anonymous SSE catchup + live deltas route through the public-body router
    // so hidden rows emit the redacted allow-list projection.
    toBody: (row) => commitmentRowToPublicBody(row as unknown as CommitmentRow, Date.now()),
    parseFilters: (req) =>
      collect([
        ['maker', 'maker', vAddress(req.query.maker)],
        ['scorer', 'scorer', vAddress(req.query.scorer)],
        ['contestId', 'contest_id', vUint(req.query.contestId)],
      ]),
  },
  positions: {
    name: 'positions',
    cursorTable: 'positions',
    table: 'positions',
    columns: POSITION_RECOVERY_COLUMNS,
    toBody: (row) => positionRecoveryRowToBody(row as unknown as PositionRecoveryRow),
    parseFilters: (req) =>
      collect([
        ['address', 'user_address', vAddress(req.query.address)],
        ['speculationId', 'speculation_id', vUint(req.query.speculationId)],
      ]),
  },
  fills: {
    name: 'fills',
    cursorTable: 'fills',
    table: 'position_fills',
    columns: FILL_COLUMNS,
    toBody: (row) => fillRowToBody(row as unknown as FillRow),
    parseFilters: (req) =>
      collect([
        ['maker', 'maker_address', vAddress(req.query.maker)],
        ['taker', 'taker_address', vAddress(req.query.taker)],
        ['speculationId', 'speculation_id', vUint(req.query.speculationId)],
        ['contestId', 'contest_id', vUint(req.query.contestId)],
        ['commitmentHash', 'commitment_hash', vHash(req.query.commitmentHash)],
      ]),
  },
  speculations: {
    name: 'speculations',
    cursorTable: 'speculations',
    table: 'speculations',
    columns: `${SPECULATION_COLUMNS}, id, row_updated_at`,
    toBody: (row) => specRowToSpeculation(row as unknown as SpeculationRow),
    parseFilters: (req) => collect([['contestId', 'contest_id', vUint(req.query.contestId)]]),
  },
  contests: {
    name: 'contests',
    cursorTable: 'contests',
    // The `contests_effective` view (contests LEFT JOIN games on
    // `(network, jsonodds_id)`) — `CONTEST_RECOVERY_COLUMNS` selects
    // `effective_start_time` / `game_match_time` / `game_earliest_match_time`
    // / `game_rundown_match_time` / `game_sportspage_match_time`,
    // which exist only there, and
    // `toBody` is a SYNCHRONOUS interface so the value has to arrive in the
    // polled row rather than from a second lookup. The view passes `contests.*`
    // through, so `id` / `row_updated_at` (and therefore the cursor, whose
    // `cursorTable` stays `contests`) are unchanged.
    //
    // Cursor visibility of a game-only reschedule — a cross-repo dependency.
    //
    // The poller and the `?since=` catch-up are keyset-cursored on
    // `contests.row_updated_at` (hence `cursorTable: 'contests'`). The view
    // passes that column through unchanged, so on its own a write to
    // `games.match_time` would change the SERVED `effective_start_time`
    // without advancing the cursor: no delta on this stream, and a
    // cursor-based reconnect would not see it either — a subscriber would
    // hold the LATER start time indefinitely, which fails OPEN.
    //
    // The close is on the WRITE side and lives in ANOTHER repo: triggers in
    // the protocol indexer's schema advance the linked contest's
    // `row_updated_at` when `games.match_time` or `games.earliest_match_time`
    // changes, so the change
    // becomes cursor-visible here with no change to this service. Nothing in
    // this repo can enforce or detect that, and no test here can turn red if it
    // is absent — so state it conditionally: WHERE those triggers are applied, a
    // game-only reschedule surfaces as an ordinary contest delta; where they are
    // not, reads stay correct (every response recomputes from the view) but a
    // cursor-based subscriber silently misses the reschedule until an unrelated
    // contest-row write or a cold snapshot.
    //
    // What this service owes, and what IS tested here, is the other half: once
    // the cursor does advance, the recovery/stream body carries the new earlier
    // `matchTime` — including for a row that lands just behind a `live` cursor
    // and is recovered by the overlap re-scan.
    //
    // The triggers key on the projected columns specifically rather than on
    // `games.row_updated_at`, because that column is bumped by many writes
    // that change nothing contest-visible (odds flags, probable pitchers,
    // external-id claims, final scores) — every one of which would otherwise
    // re-deliver the contest row. `match_time`, `earliest_match_time`,
    // `rundown_match_time`, and `sportspage_match_time` are the `games`
    // columns feeding a contest body: between them they produce the four raw
    // `game*` fields and every games-side input to `matchTime`. The
    // `match_time` trigger covers ordinary schedule writes; the
    // `earliest_match_time` companion covers a floor-only update — the
    // operator remedy — and the snapshot-column trigger covers the writer's
    // claim/release/recheck snapshot writes, which name no other projected
    // column.
    table: CONTESTS_VIEW,
    columns: CONTEST_RECOVERY_COLUMNS,
    toBody: (row) => contestRecoveryRowToBody(row as unknown as ContestRecoveryRow),
    parseFilters: (req) => collect([['contestId', 'contest_id', vUint(req.query.contestId)]]),
  },
};

export function isStreamResource(name: string): name is StreamResourceName {
  return Object.prototype.hasOwnProperty.call(STREAM_RESOURCES, name);
}
