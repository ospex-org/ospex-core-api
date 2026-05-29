/**
 * Own-state composite cursor (M4 / spec §2.1, §6.1).
 *
 * The single-resource cursor in `src/lib/cursor.ts` encodes a watermark for
 * ONE resource table. The own-state composite cursor encodes per-resource
 * watermarks for THREE resources (commitments + position_fills + positions)
 * because `/v1/own-state/snapshot` + `/v1/stream/own-state` deliver a unified
 * wallet-scoped view across all three.
 *
 * Wire format: base64url(JSON({t, v, c, f, p, k})). The codec is independent
 * of `src/lib/cursor.ts` — different shape, different invariants. Server +
 * SDK are the only authors/readers; cursors are opaque to client code.
 *
 * Per-resource watermark `(s, i)` mirrors the single-resource cursor shape:
 *   s — `row_updated_at` as ISO 8601 timestamptz (`...Z` or `...+00:00`,
 *       optional fractional seconds).
 *   i — `id` as a decimal-integer string.
 *
 * The `k` discriminator tells the SDK what to do next:
 *   `page` — snapshot was truncated; call `/v1/own-state/snapshot?cursor=…`
 *            again until `k === 'live'`. MUST NOT emit `ready` for trading
 *            purposes (spec §6.2).
 *   `live` — snapshot complete; pass cursor to `/v1/stream/own-state` as
 *            `Last-Event-ID`.
 *
 * Validation rules (mirrors cursor.ts safety net): the ISO regex rejects
 * crafted timestamps (e.g. commas — the PostgREST `.or()` delimiter) so a
 * malformed cursor surfaces as `400 INVALID_CURSOR` rather than a 500 from
 * the keyset filter grammar.
 */

import type { ApiError } from '../../middleware/errorHandler.js';

/** Composite cursor version. Bumped on any wire-shape change. */
export const OWN_STATE_CURSOR_VERSION = 1;

export type OwnStateCursorKind = 'live' | 'page';

export interface ResourceWatermark {
  /** `row_updated_at` verbatim from the source row, full precision. */
  s: string;
  /** `id` (bigint identity) as a decimal string. */
  i: string;
}

export interface OwnStateCursor {
  /** Resource tag — guards against feeding a public stream cursor into the own-state endpoint. */
  t: 'own-state';
  /** Schema version. */
  v: typeof OWN_STATE_CURSOR_VERSION;
  /** Commitments watermark. */
  c: ResourceWatermark;
  /** Position-fills watermark. */
  f: ResourceWatermark;
  /** Positions watermark. */
  p: ResourceWatermark;
  /** `page` = snapshot truncated, continue paging; `live` = ready for stream `Last-Event-ID`. */
  k: OwnStateCursorKind;
}

/**
 * Sentinel watermark for "no observed rows yet" — minimum possible
 * timestamptz + id zero. Catch-up queries that key off `(s, i) > sentinel`
 * return every row, which is the desired cold-start behavior.
 */
export const SENTINEL_WATERMARK: ResourceWatermark = {
  s: '1970-01-01T00:00:00.000Z',
  i: '0',
};

// The exact ISO-8601 timestamptz shapes PostgREST/supabase-js mint (mirrors
// `src/lib/cursor.ts`). Validating against this — not the permissive
// `Date.parse` — keeps a crafted timestamp from reaching the filter grammar.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Thrown when a client-supplied `?cursor=` value can't be decoded or fails
 * any structural / range check. Carries a ready-to-send `ApiError` with code
 * `INVALID_CURSOR`.
 */
export class OwnStateCursorError extends Error {
  readonly apiError: ApiError;
  constructor(message: string) {
    super(message);
    this.name = 'OwnStateCursorError';
    this.apiError = { error: message, code: 'INVALID_CURSOR' };
  }
}

export function encodeOwnStateCursor(c: OwnStateCursor): string {
  return Buffer.from(
    JSON.stringify({ t: c.t, v: c.v, c: c.c, f: c.f, p: c.p, k: c.k }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decode a client cursor. Throws {@link OwnStateCursorError} on any
 * malformation. NEVER returns a partially-valid cursor.
 */
export function decodeOwnStateCursor(raw: string): OwnStateCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new OwnStateCursorError('Malformed cursor: not valid base64url-encoded JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new OwnStateCursorError('Malformed cursor: expected a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['t'] !== 'own-state') {
    throw new OwnStateCursorError(
      `Cursor belongs to "${String(obj['t'])}", not "own-state". Use a cursor minted by /v1/own-state/snapshot.`,
    );
  }
  if (obj['v'] !== OWN_STATE_CURSOR_VERSION) {
    throw new OwnStateCursorError(
      `Cursor schema version ${String(obj['v'])} is not supported; expected ${OWN_STATE_CURSOR_VERSION}.`,
    );
  }
  const c = validateWatermark(obj['c'], 'c');
  const f = validateWatermark(obj['f'], 'f');
  const p = validateWatermark(obj['p'], 'p');
  const k = obj['k'];
  if (k !== 'live' && k !== 'page') {
    throw new OwnStateCursorError('Malformed cursor: k must be "live" or "page".');
  }
  return { t: 'own-state', v: OWN_STATE_CURSOR_VERSION, c, f, p, k };
}

function validateWatermark(raw: unknown, label: string): ResourceWatermark {
  if (typeof raw !== 'object' || raw === null) {
    throw new OwnStateCursorError(`Malformed cursor: ${label} must be an object.`);
  }
  const o = raw as Record<string, unknown>;
  const s = o['s'];
  const i = o['i'];
  if (typeof s !== 'string' || !ISO_TIMESTAMP.test(s)) {
    throw new OwnStateCursorError(
      `Malformed cursor: ${label}.s must be an ISO-8601 timestamptz.`,
    );
  }
  if (typeof i !== 'string' || !/^\d+$/.test(i)) {
    throw new OwnStateCursorError(
      `Malformed cursor: ${label}.i must be a non-negative integer string.`,
    );
  }
  return { s, i };
}

/**
 * PostgREST `or=(...)` expression for strictly-after keyset pagination:
 *   `(row_updated_at, id) > (s, i)` →
 *   `row_updated_at.gt.{s},and(row_updated_at.eq.{s},id.gt.{i})`
 *
 * Identical to `keysetOrExpr` in `src/lib/cursor.ts`; duplicated here to keep
 * the own-state module self-contained (no cross-file coupling beyond the
 * shared `ApiError` type).
 */
export function watermarkKeysetOr(w: ResourceWatermark): string {
  return `row_updated_at.gt.${w.s},and(row_updated_at.eq.${w.s},id.gt.${w.i})`;
}
