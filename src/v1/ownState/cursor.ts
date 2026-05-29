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
export const OWN_STATE_CURSOR_VERSION = 3;

/**
 * Per-resource overlap window for `k='live'` initial recovery. Mirrors
 * `RECOVERY_OVERLAP_MS` in `src/lib/recovery.ts` — Postgres `now()` is the
 * transaction's start time, so a slow tx can commit with `row_updated_at`
 * predating a freshly-issued cursor. A strict `>` keyset would skip those
 * rows forever; the 30s floor catches them on the next read.
 */
export const RECOVERY_OVERLAP_MS = 30_000;

/**
 * Maximum bigint id permitted in a cursor — matches Postgres `bigint`
 * (signed int64). Anything larger overflows the column type and PostgREST
 * returns a 500 instead of a clean 400.
 */
const MAX_INT64 = 9_223_372_036_854_775_807n;

/**
 * Cursor `k` discriminant — the snapshot recovery state machine.
 *
 * Hermes review-31 round 2 forced the explicit-phase split: the previous
 * round-1 merge approach interleaved active + terminal rows by
 * `(row_updated_at, id)`, which allowed a long-lived active row to be
 * starved by older terminals on page 1 and then permanently excluded by
 * page 2's strict keyset advance. The two-phase model drains the entire
 * active set BEFORE any terminal row is delivered, so the `(row, id)`
 * watermark on each phase only ever advances past rows already on the
 * wire for THAT phase.
 *
 *   `live`                   — stream-ready; SDK passes this to
 *                              `/v1/stream/own-state` as `Last-Event-ID`.
 *                              As INPUT, signals initial state-loss
 *                              recovery: server applies the overlap floor
 *                              to compute `cAnchor` and starts phase 1.
 *   `page-active`            — cold-start active-set paging. No recovery,
 *                              no terminal phase.
 *   `page-recovery-active`   — phase 1 of recovery — active-set paging
 *                              with `cAnchor` preserved on the cursor for
 *                              the phase-2 handoff once active drains.
 *   `page-recovery-terminal` — phase 2 of recovery — terminal-set paging.
 *                              Started either when phase 1 active drains
 *                              on the same page (and any remaining budget
 *                              is spent on terminals) or on the next call
 *                              after a page-recovery-active page that
 *                              exactly fills its budget.
 */
export type OwnStateCursorKind =
  | 'live'
  | 'page-active'
  | 'page-recovery-active'
  | 'page-recovery-terminal';

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
  /**
   * Commitments progress watermark — advances through delivered rows only.
   * Per spec §6.1 / Hermes review-31 round 2: NEVER advances past an
   * undelivered row of either phase. Phase 1 advances `c` through active
   * rows in `(row, id)` order; phase 2 advances `c` through terminal rows
   * in `(row, id)` order. The two phases never compete for the watermark.
   */
  c: ResourceWatermark;
  /**
   * Recovery floor — present iff k ∈ {page-recovery-active, page-recovery-
   * terminal}. Preserved verbatim across every page of the recovery so the
   * server knows where the original recovery scope started, no matter how
   * far `c` has advanced through active rows. Set to `floor(input.c)` (by
   * `RECOVERY_OVERLAP_MS`) on the very first recovery call (input k='live').
   */
  cAnchor?: ResourceWatermark;
  /** Position-fills watermark. */
  f: ResourceWatermark;
  /** Positions watermark. */
  p: ResourceWatermark;
  /** Phase indicator — see {@link OwnStateCursorKind}. */
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

// UTC ISO 8601 with capture groups for component-wise validation. Hermes
// review-31 round 3 caught the wire-contract self-compat gap: Supabase /
// PostgREST emits timestamptz as `2026-05-29T15:00:00.123456+00:00`
// (microsecond precision, `+00:00` form) while the round-2 regex was
// Z-only — the snapshot was minting cursors it then rejected on the very
// next call, breaking paging. Accept both `Z` and `+00:00` (the only forms
// the server-side write paths produce); both encode UTC so the component
// comparison below works against `Date.getUTC*()` either way.
// Non-zero offsets are still rejected — the server never emits them, and
// accepting them would break the component-comparison invariant (the
// input components are LOCAL to the offset, not UTC).
// Fractional seconds: up to 9 digits to cover Postgres's microseconds and
// any future nanosecond extension. The raw string is preserved verbatim
// (no `toISOString` round-trip) — that path would truncate microseconds
// to milliseconds and weaken keyset pagination.
const ISO_TIMESTAMP_UTC =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|\+00:00)$/;

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
  // `cAnchor` is omitted from the JSON when undefined — the decode side
  // validates it iff `k` is a recovery-paging kind. Stable key order.
  const obj: Record<string, unknown> = { t: c.t, v: c.v, c: c.c };
  if (c.cAnchor !== undefined) obj['cAnchor'] = c.cAnchor;
  obj['f'] = c.f;
  obj['p'] = c.p;
  obj['k'] = c.k;
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
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
  if (
    k !== 'live' &&
    k !== 'page-active' &&
    k !== 'page-recovery-active' &&
    k !== 'page-recovery-terminal'
  ) {
    throw new OwnStateCursorError(
      'Malformed cursor: k must be "live", "page-active", "page-recovery-active", or "page-recovery-terminal".',
    );
  }
  // cAnchor: required iff k is a recovery-paging kind; forbidden otherwise.
  const isRecoveryPaging = k === 'page-recovery-active' || k === 'page-recovery-terminal';
  let cAnchor: ResourceWatermark | undefined;
  if ('cAnchor' in obj && obj['cAnchor'] !== undefined) {
    if (!isRecoveryPaging) {
      throw new OwnStateCursorError(
        `Malformed cursor: cAnchor is only valid when k is a recovery-paging kind, not "${k}".`,
      );
    }
    cAnchor = validateWatermark(obj['cAnchor'], 'cAnchor');
  } else if (isRecoveryPaging) {
    throw new OwnStateCursorError(
      `Malformed cursor: cAnchor is required when k is "${k}".`,
    );
  }
  return cAnchor !== undefined
    ? { t: 'own-state', v: OWN_STATE_CURSOR_VERSION, c, cAnchor, f, p, k }
    : { t: 'own-state', v: OWN_STATE_CURSOR_VERSION, c, f, p, k };
}

function validateWatermark(raw: unknown, label: string): ResourceWatermark {
  if (typeof raw !== 'object' || raw === null) {
    throw new OwnStateCursorError(`Malformed cursor: ${label} must be an object.`);
  }
  const o = raw as Record<string, unknown>;
  const s = o['s'];
  const i = o['i'];
  // Shape gate — the UTC-only regex keeps a crafted timestamp from reaching
  // the PostgREST filter grammar while still admitting both wire shapes the
  // server can emit (`...Z` and `...+00:00`).
  if (typeof s !== 'string') {
    throw new OwnStateCursorError(
      `Malformed cursor: ${label}.s must be an ISO-8601 timestamptz (Z or +00:00 form).`,
    );
  }
  const m = s.match(ISO_TIMESTAMP_UTC);
  if (!m) {
    throw new OwnStateCursorError(
      `Malformed cursor: ${label}.s must be an ISO-8601 timestamptz (Z or +00:00 form).`,
    );
  }
  // Canonical-calendar gate (Hermes review-31 round 2). `Date.parse` silently
  // normalizes `2026-02-30` → March 2, `Apr 31` → May 1, `24:00:00` → next
  // day 00:00:00. Component-comparing the parsed date back against the
  // input strings catches every normalization — only inputs that
  // round-trip exactly are accepted. Equivalent to the canonical-encoding
  // pattern in `[[feedback_bind_minted_fields_on_resubmit]]`.
  const [, Y, M, D, h, mi, sec] = m;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) {
    throw new OwnStateCursorError(
      `Malformed cursor: ${label}.s is not a parseable timestamp.`,
    );
  }
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== Number(Y) ||
    d.getUTCMonth() + 1 !== Number(M) ||
    d.getUTCDate() !== Number(D) ||
    d.getUTCHours() !== Number(h) ||
    d.getUTCMinutes() !== Number(mi) ||
    d.getUTCSeconds() !== Number(sec)
  ) {
    throw new OwnStateCursorError(
      `Malformed cursor: ${label}.s is not a real calendar timestamp (Date.parse normalized it).`,
    );
  }
  if (typeof i !== 'string' || !/^\d+$/.test(i)) {
    throw new OwnStateCursorError(
      `Malformed cursor: ${label}.i must be a non-negative integer string.`,
    );
  }
  // Range gate — Postgres `bigint` is signed int64; an id beyond 2^63-1
  // overflows the column type and PostgREST 500s on the cast.
  let big: bigint;
  try {
    big = BigInt(i);
  } catch {
    throw new OwnStateCursorError(`Malformed cursor: ${label}.i is not parseable as bigint.`);
  }
  if (big > MAX_INT64) {
    throw new OwnStateCursorError(
      `Malformed cursor: ${label}.i exceeds Postgres bigint range (2^63 - 1).`,
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

/**
 * Initial-recovery keyset that applies the {@link RECOVERY_OVERLAP_MS}
 * floor. Use ONLY when the input cursor's `k === 'live'` — that's the
 * first server call after the SDK reconnects with a stream-tail cursor.
 * Subsequent paging continuations (`k='page-recovery'`) use the strict
 * `watermarkKeysetOr` against the previous page's last delivered row.
 *
 * The floor returns rows `> (cursor.s − overlap, 0)`. Effectively this is
 * `row_updated_at >= cursor.s − overlap`, catching any tx that committed
 * late relative to its `row_updated_at`. Hermes review-31 round 1 blocker.
 */
export function watermarkLiveKeysetOr(w: ResourceWatermark): string {
  const flooredMs = Date.parse(w.s) - RECOVERY_OVERLAP_MS;
  return watermarkKeysetOr({ s: new Date(flooredMs).toISOString(), i: '0' });
}

/**
 * Floor a watermark by the overlap window — for cases where the caller
 * wants the floored values as a {@link ResourceWatermark} rather than as
 * a PostgREST expression (e.g. when paging continuation needs to know the
 * recovery start point). Date.parse returns finite ms because the
 * cursor decoder rejected anything else.
 */
export function floorWatermarkByOverlap(w: ResourceWatermark): ResourceWatermark {
  const flooredMs = Date.parse(w.s) - RECOVERY_OVERLAP_MS;
  return { s: new Date(flooredMs).toISOString(), i: '0' };
}
