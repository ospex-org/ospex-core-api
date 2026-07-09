/**
 * `GET /v1/stream/own-state` — owner-auth composite SSE stream.
 *
 *   Authorization: Bearer <stream-token>   (verifyStreamToken middleware)
 *   Last-Event-ID: <opaque-cursor>         (on reconnect; optional first connect)
 *   ?cursor=<opaque-cursor>                (first-connect fallback for fetch SSE)
 *
 * Two modes:
 *
 *   COLD START (no cursor) — server emits an inline `event: snapshot` carrying
 *   the maker's complete current state via the shared `loadOwnStateSnapshot`
 *   helper. If commitments are truncated (`truncated: true`), NO `ready` is
 *   emitted and the connection ends — the SDK pages REST
 *   `/v1/own-state/snapshot?cursor=` until untruncated, then reconnects to
 *   this stream with the final cursor. Otherwise:
 *   - Server seeds the hub's positionStatus cache from `result.seedRows`
 *     produced by the SAME `loadOwnStateSnapshot()` read that built the
 *     wire body — NOT a fresh post-snapshot derivation. The seed and
 *     the wire body are equal by construction, so a derived-state
 *     transition cannot land between the two reads and silently
 *     populate the cache with a status the SDK never received.
 *   - If `positionsTruncated:true`, emit `event: degraded` first so
 *     SDK / market maker enters quote-hold.
 *   - Start the per-wallet poll timer (`hub.beginLive(sub)`).
 *   - Emit `event: ready` and transition to live.
 *
 *   RESUME (cursor present) — server runs per-resource catch-up replay from
 *   the cursor's watermarks (commitments, position_fills, positions). The
 *   positions catch-up is a derived event over (positions, speculations,
 *   contests) and emits the subset past `cursor.p`; saturation surfaces as
 *   `event: degraded` followed by `ready` (not `resync`), giving the SDK a
 *   defined terminal state instead of an infinite reconnect loop for
 *   wallets at the actionable-position cap. The catch-up's full derivation
 *   also seeds the hub cache before `beginLive` for the same race-
 *   protection rationale as cold-start. On race with a live delta or
 *   upstream resync during catch-up, `event: resync` is emitted and the
 *   connection ends.
 *
 * Only `k='live'` cursors are valid input. A `page-*` cursor indicates the SDK
 * hasn't finished paging through a truncated snapshot — we 400 with
 * `INVALID_CURSOR` pointing them back to the snapshot endpoint.
 *
 * Live phase: hub callbacks write `commitment`, `fill`, `positionStatus`
 * events. Per-subscriber composite cursor advances per delivered resource;
 * the wire `id:` is always the freshly-encoded composite. Heartbeat comments
 * keep the connection under the platform idle timeout. Slow-client shedding
 * matches `stream/handler.ts` (forces reconnect on a stuck socket).
 */

import type { Request, Response } from 'express';
import { logger } from '../../lib/logger.js';
import { loadConfig } from '../../lib/env.js';
import { getSupabase } from '../../lib/supabase.js';
import type { ApiError } from '../../middleware/errorHandler.js';
import type { StreamAuthRequest } from '../../middleware/verifyStreamToken.js';
import {
  COMMITMENT_RECOVERY_COLUMNS,
  type CommitmentRecoveryRow,
} from '../commitments.js';
import {
  fetchCommitmentEnrichment,
  toOwnerCommitmentBody,
  type OwnerCommitmentBody,
} from './enrich.js';
import {
  rowToBody as fillRowToBody,
  FILL_COLUMNS,
  type FillBody,
  type FillRow,
} from '../fills.js';
import { registerStream, release } from '../stream/connections.js';
import { HEARTBEAT_MS, acquireStreamSlot, makeShedIfSlow } from '../stream/common.js';
import { initSse, writeComment, writeEvent } from '../stream/sse.js';
import {
  OwnStateCursorError,
  decodeOwnStateCursor,
  encodeOwnStateCursor,
  watermarkKeysetOr,
  watermarkLiveKeysetOr,
  type OwnStateCursor,
  type ResourceWatermark,
} from './cursor.js';
import {
  derivePositionStatus,
  type ContestInput,
  type PositionStatusEventBody,
  type SpeculationInput,
} from './positionStatus.js';
import {
  compareIsoTimestamptz,
  maxIsoTimestamptz,
} from './timestamps.js';
import { loadOwnStateSnapshot } from './snapshot.js';
import { getOwnStateHub, type OwnStateSubscriber } from './hub.js';
import type { MarketType } from '../../lib/speculation.js';

const CATCHUP_PAGE = 500;
const CATCHUP_MAX_PAGES = 50;

// SSE event names. The wire grammar treats these as a closed set.
type OwnStateSseEvent =
  | 'snapshot'
  | 'ready'
  | 'commitment'
  | 'fill'
  | 'positionStatus'
  | 'resync'
  | 'degraded';

type Phase = 'preReady' | 'live';
type CatchupStatus = 'complete' | 'resync' | 'closed';

// Cumulative per-handler counters. `started - completed - resynced` are
// still-in-pre-ready connections; useful as a hung-snapshot signal.
let preReadyStartedTotal = 0;
let preReadyCompletedTotal = 0;
let preReadyResyncedTotal = 0;

export function ownStateStreamHandlerStats(): {
  preReadyStartedTotal: number;
  preReadyCompletedTotal: number;
  preReadyResyncedTotal: number;
} {
  return { preReadyStartedTotal, preReadyCompletedTotal, preReadyResyncedTotal };
}

export function __resetOwnStateStreamMetrics(): void {
  preReadyStartedTotal = 0;
  preReadyCompletedTotal = 0;
  preReadyResyncedTotal = 0;
}

// ── helper: typed writeEvent for own-state event names ──────────────────
function writeOwnStateEvent(
  res: Response,
  event: OwnStateSseEvent,
  data: unknown,
  id?: string,
): void {
  // sse.ts's writeEvent restricts event name to a union — we cast at the
  // boundary because own-state has its own typed grammar and adding it to
  // sse.ts would couple every SSE handler. The narrow cast keeps the rest
  // of the module's type safety.
  writeEvent(res, event as unknown as Parameters<typeof writeEvent>[1], data, id);
}

// ── handler ─────────────────────────────────────────────────────────────

export function getOwnStateStreamHandler(req: Request, res: Response): void {
  const address = (req as StreamAuthRequest).streamAuth.address;

  // Parse cursor: Last-Event-ID wins (native EventSource auto-reconnect
  // uses it), then ?cursor= fallback for first-connect fetch SSE.
  const cursorRaw =
    req.header('Last-Event-ID') ??
    (req.query.cursor !== undefined ? String(req.query.cursor) : undefined);
  let cursor: OwnStateCursor | null = null;
  if (cursorRaw !== undefined && cursorRaw !== '') {
    try {
      cursor = decodeOwnStateCursor(cursorRaw);
    } catch (err) {
      if (err instanceof OwnStateCursorError) {
        res.status(400).json(err.apiError);
        return;
      }
      res
        .status(400)
        .json({ error: 'Invalid cursor.', code: 'INVALID_CURSOR' } satisfies ApiError);
      return;
    }
    // Only `live` cursors are valid stream input. A page-* cursor indicates
    // the SDK is mid-snapshot-paging; tell it to finish at the REST endpoint.
    if (cursor.k !== 'live') {
      res.status(400).json({
        error:
          'Stream cursor must be a `k="live"` cursor minted by /v1/own-state/snapshot; ' +
          `received \`k="${cursor.k}"\`. Page snapshots to completion before connecting.`,
        code: 'INVALID_CURSOR',
      } satisfies ApiError);
      return;
    }
  }

  // 'owner': this owner-authenticated own-state stream may draw from the per-IP
  // reserve, so anonymous public-stream saturation from the same IP cannot 429
  // a market-maker's safety-critical own-state reconnect.
  const ip = acquireStreamSlot(req, res, 'owner');
  if (ip === null) return;

  // From here a slot is held — every early return must release it.

  // ── Open the stream ──────────────────────────────────────────────────
  initSse(res);
  writeComment(res, 'connected');

  const shedIfSlow = makeShedIfSlow(res, (pending) =>
    logger.warn({ address, pending }, 'ownState/stream: shedding slow client'),
  );

  // Per-subscriber running cursor. Initialized in the catchup or snapshot
  // phase, then updated on every live delta.
  let running: OwnStateCursor | null = cursor;

  // Subscribe BEFORE catchup/snapshot so a live delta can't slip past the
  // hub's per-tick dedupe. During preReady, a hub delivery latches `aborted`.
  let phase: Phase = 'preReady';
  let aborted = false;

  const sub: OwnStateSubscriber = getOwnStateHub().subscribe(address, {
    onCommitment: (body, ts, id) => {
      if (phase === 'live') {
        running = advanceCommitments(running, ts, id);
        if (running) {
          writeOwnStateEvent(res, 'commitment', body, encodeOwnStateCursor(running));
          shedIfSlow();
        }
      } else {
        aborted = true;
      }
    },
    onFill: (body, ts, id) => {
      if (phase === 'live') {
        running = advanceFills(running, ts, id);
        if (running) {
          writeOwnStateEvent(res, 'fill', body, encodeOwnStateCursor(running));
          shedIfSlow();
        }
      } else {
        aborted = true;
      }
    },
    onPositionStatus: (body, ts, id) => {
      if (phase === 'live') {
        running = advancePositions(running, ts, id);
        if (running) {
          writeOwnStateEvent(res, 'positionStatus', body, encodeOwnStateCursor(running));
          shedIfSlow();
        }
      } else {
        aborted = true;
      }
    },
    onResync: (reason) => {
      if (phase === 'live') {
        writeOwnStateEvent(res, 'resync', { reason });
      } else {
        aborted = true;
      }
    },
  });

  let closed = false;
  const deregisterStream = registerStream(() => {
    if (closed) return;
    writeOwnStateEvent(res, 'resync', { reason: 'server_shutdown' });
    res.end();
  });
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    getOwnStateHub().unsubscribe(sub);
    release(ip, 'owner');
    deregisterStream();
  };
  const heartbeat = setInterval(() => writeComment(res, 'hb'), HEARTBEAT_MS);
  heartbeat.unref?.();
  res.on('close', cleanup);
  res.on('error', cleanup);

  void (async () => {
    preReadyStartedTotal += 1;
    try {
      if (cursor === null) {
        // COLD START — inline snapshot delivery.
        const nowMs = Date.now();
        const result = await loadOwnStateSnapshot(address, null, nowMs);
        if (closed || res.writableEnded) return;
        if (!result.ok) {
          logger.error(
            { address, err: result.error.error },
            'ownState/stream: cold-start snapshot failed',
          );
          writeOwnStateEvent(res, 'resync', { reason: 'snapshot_failed' });
          preReadyResyncedTotal += 1;
          res.end();
          return;
        }
        // Decode the response cursor so the live phase can advance it
        // per-resource without re-parsing every delta.
        running = decodeOwnStateCursor(result.body.cursor);
        // Wire the snapshot event with cursor + body. Don't include the
        // inner cursor twice — the SSE `id:` is the same value as
        // `body.cursor`, which the SDK treats as authoritative.
        writeOwnStateEvent(
          res,
          'snapshot',
          {
            cursor: result.body.cursor,
            commitments: result.body.commitments,
            positions: result.body.positions,
            truncated: result.body.truncated,
            positionsTruncated: result.body.positionsTruncated,
          },
          result.body.cursor,
        );

        if (aborted) {
          // A live row landed during snapshot delivery — can't safely order.
          writeOwnStateEvent(res, 'resync', { reason: 'handoff_raced' });
          preReadyResyncedTotal += 1;
          res.end();
          return;
        }
        if (result.body.truncated) {
          // Commitments truncated — SDK pages REST
          // `/v1/own-state/snapshot?cursor=` until untruncated, then
          // reconnects to this stream with the final cursor. End the
          // connection so the SDK doesn't hold a slot during paging.
          preReadyCompletedTotal += 1;
          res.end();
          return;
        }

        // Seed the hub's positionStatus cache from THE SAME read that
        // produced the snapshot's wire body. Using a fresh post-snapshot
        // derivation would re-introduce the race where a transition
        // between the snapshot's read and the seed's read silently
        // populates the cache with the post-transition status, and the
        // first live tick suppresses the transition. By construction
        // the seed cannot disagree with the snapshot.
        getOwnStateHub().seedStatusCache(address, result.seedRows);
        if (result.body.positionsTruncated) {
          // Snapshot exposed `positionsTruncated:true` — actionable
          // population exceeded the snapshot helper's cap. Emit
          // `degraded` so the SDK / market maker enters quote-hold,
          // then proceed to `ready` — connection has delivered every
          // row we could observe. This breaks the earlier
          // `positionsTruncated → reconnect → resync → reconnect` loop
          // for wallets at the cap.
          writeOwnStateEvent(res, 'degraded', { reason: 'positionsTruncated' });
        }
        getOwnStateHub().beginLive(sub);
        phase = 'live';
        writeOwnStateEvent(res, 'ready', {});
        preReadyCompletedTotal += 1;
        return;
      }

      // RESUME — composite catchup from cursor.
      // `cursor.k === 'live'` already validated. Per-resource catchup
      // applies the overlap floor on the first page (live cursor); strict
      // forward on subsequent pages. `running` is mutated per delta.
      running = cursor;
      const catchupResult = await runCatchUpWithCursor(
        res,
        address,
        cursor,
        () => closed,
        shedIfSlow,
        (next) => {
          running = next;
        },
      );
      if (closed || catchupResult.status === 'closed' || res.writableEnded) return;

      if (aborted || catchupResult.status === 'resync') {
        if (catchupResult.status !== 'resync') {
          writeOwnStateEvent(res, 'resync', { reason: 'handoff_raced' });
        }
        preReadyResyncedTotal += 1;
        res.end();
        return;
      }

      // Seed hub cache from the catch-up's derivation BEFORE starting the
      // poll timer (same race-protection rationale as cold-start above).
      // Include `result` + `claimableAmount` so the hub's payload-level
      // dedup has a complete baseline — a same-status / different-payload
      // change on the next tick (e.g. score-correction-driven prediction
      // flip) then surfaces instead of being suppressed.
      getOwnStateHub().seedStatusCache(
        address,
        catchupResult.seedRows.map((r) => ({
          key: r.key,
          status: r.body.status,
          sourceUpdatedAt: r.sourceUpdatedAt,
          result: r.body.result,
          claimableAmount: r.body.claimableAmount,
        })),
      );
      if (catchupResult.degraded) {
        // Actionable population saturated during catch-up — same defined
        // terminal state as cold-start positionsTruncated. Emit
        // `degraded` so the SDK reaches `ready` without looping back
        // through resync.
        writeOwnStateEvent(res, 'degraded', { reason: 'positionsTruncated' });
      }
      getOwnStateHub().beginLive(sub);
      phase = 'live';
      writeOwnStateEvent(res, 'ready', {});
      preReadyCompletedTotal += 1;
    } catch (err) {
      logger.error(
        { address, err: err instanceof Error ? err.message : String(err) },
        'ownState/stream: pre-ready phase failed',
      );
      writeOwnStateEvent(res, 'resync', { reason: 'internal_error' });
      preReadyResyncedTotal += 1;
      res.end();
    }
  })();
}

// ── cursor advance helpers ──────────────────────────────────────────────

function advanceCommitments(
  cur: OwnStateCursor | null,
  ts: string,
  id: string,
): OwnStateCursor | null {
  if (cur === null) return null;
  return { ...cur, c: { s: ts, i: id } };
}

function advanceFills(
  cur: OwnStateCursor | null,
  ts: string,
  id: string,
): OwnStateCursor | null {
  if (cur === null) return null;
  return { ...cur, f: { s: ts, i: id } };
}

/**
 * Advance the running cursor's `p` watermark for a delivered
 * positionStatus event. Exported for direct unit testing of the
 * monotonic guard.
 */
export function advancePositions(
  cur: OwnStateCursor | null,
  ts: string,
  id: string,
): OwnStateCursor | null {
  if (cur === null) return null;
  // Monotonic guard: never move `p` backwards. The hub emits sorted by
  // (sourceUpdatedAt, id) ASC so we shouldn't reach a backwards advance
  // in practice — this is belt-and-braces against accidental future
  // out-of-order callbacks. We still emit the event body (the caller
  // wraps this in writeOwnStateEvent unconditionally); we only pin
  // `id:` to the existing higher cursor. The SDK reducer dedupes the
  // event by its semantic key.
  const byTs = compareIsoTimestamptz(ts, cur.p.s);
  if (byTs < 0) return cur;
  if (byTs === 0) {
    let curBig: bigint;
    let newBig: bigint;
    try {
      curBig = BigInt(cur.p.i);
    } catch {
      curBig = 0n;
    }
    try {
      newBig = BigInt(id);
    } catch {
      newBig = 0n;
    }
    if (newBig <= curBig) return cur;
  }
  return { ...cur, p: { s: ts, i: id } };
}

// ── catchup replay (composite, per resource) ────────────────────────────

/**
 * Composite catchup with explicit initial cursor. Drains commitments,
 * fills, and positions in turn, emitting deltas with the running composite
 * cursor as SSE `id:`. The caller's `updateRunning` is invoked on every
 * advance so the surrounding handler sees the latest cursor for live-phase
 * handoff. Returns `'closed'` if the response was ended mid-page,
 * `'resync'` on backlog overflow or query error, `'complete'` otherwise.
 *
 * Order: commitments → fills → positions. The SDK reducer's dedup keys are
 * per-resource, so ordering across resources is immaterial.
 */
async function runCatchUpWithCursor(
  res: Response,
  address: string,
  initial: OwnStateCursor,
  isClosed: () => boolean,
  shed: () => void,
  updateRunning: (next: OwnStateCursor) => void,
): Promise<{ status: CatchupStatus; seedRows: DerivedPositionRow[]; degraded: boolean }> {
  let running: OwnStateCursor = initial;
  const sb = getSupabase();
  const net = loadConfig().network;
  const nowMs = Date.now();

  // ── commitments ──
  {
    const status = await catchUpCommitments(
      res,
      sb,
      net,
      address,
      running.c,
      nowMs,
      isClosed,
      shed,
      (body, ts, id) => {
        running = { ...running, c: { s: ts, i: id } };
        updateRunning(running);
        writeOwnStateEvent(res, 'commitment', body, encodeOwnStateCursor(running));
      },
    );
    if (status !== 'complete') return { status, seedRows: [], degraded: false };
  }

  // ── fills ──
  {
    const status = await catchUpFills(
      res,
      sb,
      net,
      address,
      running.f,
      isClosed,
      shed,
      (body, ts, id) => {
        running = { ...running, f: { s: ts, i: id } };
        updateRunning(running);
        writeOwnStateEvent(res, 'fill', body, encodeOwnStateCursor(running));
      },
    );
    if (status !== 'complete') return { status, seedRows: [], degraded: false };
  }

  // ── positions (derived event over positions + speculations + contests) ──
  const positionsResult = await catchUpPositions(
    res,
    sb,
    net,
    address,
    running.p,
    isClosed,
    shed,
    (body, ts, id) => {
      running = { ...running, p: { s: ts, i: id } };
      updateRunning(running);
      writeOwnStateEvent(res, 'positionStatus', body, encodeOwnStateCursor(running));
    },
  );
  return positionsResult;
}

async function catchUpCommitments(
  res: Response,
  sb: ReturnType<typeof getSupabase>,
  net: string,
  address: string,
  cursorWatermark: ResourceWatermark,
  nowMs: number,
  isClosed: () => boolean,
  shed: () => void,
  emit: (body: OwnerCommitmentBody, ts: string, id: string) => void,
): Promise<CatchupStatus> {
  // First page: overlap floor (input cursor is `live`).
  let orExpr = watermarkLiveKeysetOr(cursorWatermark);
  for (let page = 0; page < CATCHUP_MAX_PAGES; page += 1) {
    if (isClosed() || res.writableEnded) return 'closed';
    const { data, error } = await sb
      .from('commitments')
      .select(COMMITMENT_RECOVERY_COLUMNS)
      .eq('network', net)
      .eq('maker', address)
      .or(orExpr)
      .order('row_updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(CATCHUP_PAGE);
    if (error) {
      logger.error({ err: error.message, address }, 'ownState/stream catchup: commitments query failed');
      writeOwnStateEvent(res, 'resync', { reason: 'catchup_failed' });
      return 'resync';
    }
    const rows = (data ?? []) as unknown as CommitmentRecoveryRow[];
    let enrichment;
    try {
      enrichment = await fetchCommitmentEnrichment(sb, net, rows);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), address },
        'ownState/stream catchup: commitment enrichment failed',
      );
      writeOwnStateEvent(res, 'resync', { reason: 'catchup_failed' });
      return 'resync';
    }
    for (const row of rows) {
      const body = toOwnerCommitmentBody(row, nowMs, enrichment);
      emit(body, row.row_updated_at, String(row.id));
    }
    shed();
    if (res.writableEnded) return 'closed';
    if (rows.length < CATCHUP_PAGE) return 'complete';
    const last = rows[rows.length - 1]!;
    orExpr = watermarkKeysetOr({ s: last.row_updated_at, i: String(last.id) });
  }
  writeOwnStateEvent(res, 'resync', { reason: 'backlog_too_large' });
  return 'resync';
}

async function catchUpFills(
  res: Response,
  sb: ReturnType<typeof getSupabase>,
  net: string,
  address: string,
  cursorWatermark: ResourceWatermark,
  isClosed: () => boolean,
  shed: () => void,
  emit: (body: FillBody, ts: string, id: string) => void,
): Promise<CatchupStatus> {
  let firstPage = true;
  let cmp: ResourceWatermark = cursorWatermark;
  for (let page = 0; page < CATCHUP_MAX_PAGES; page += 1) {
    if (isClosed() || res.writableEnded) return 'closed';
    // Maker-OR-taker side; first page applies the overlap floor.
    const flooredOnFirst = firstPage
      ? floorBaseWatermark(cursorWatermark)
      : cmp;
    const keyset = `row_updated_at.gt.${flooredOnFirst.s},and(row_updated_at.eq.${flooredOnFirst.s},id.gt.${flooredOnFirst.i})`;
    const sidedKeyset =
      `and(maker_address.eq.${address},or(${keyset}))` +
      `,and(taker_address.eq.${address},or(${keyset}))`;
    const { data, error } = await sb
      .from('position_fills')
      .select(FILL_COLUMNS)
      .eq('network', net)
      .or(sidedKeyset)
      .order('row_updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(CATCHUP_PAGE);
    if (error) {
      logger.error({ err: error.message, address }, 'ownState/stream catchup: fills query failed');
      writeOwnStateEvent(res, 'resync', { reason: 'catchup_failed' });
      return 'resync';
    }
    const rows = (data ?? []) as unknown as FillRow[];
    for (const row of rows) {
      const body = fillRowToBody(row);
      emit(body, row.row_updated_at, String(row.id));
    }
    shed();
    if (res.writableEnded) return 'closed';
    if (rows.length < CATCHUP_PAGE) return 'complete';
    const last = rows[rows.length - 1]!;
    cmp = { s: last.row_updated_at, i: String(last.id) };
    firstPage = false;
  }
  writeOwnStateEvent(res, 'resync', { reason: 'backlog_too_large' });
  return 'resync';
}

/**
 * One derived `positionStatus` row produced by {@link derivePositionsForWallet}.
 *
 * Used by both the resume catch-up (which emits a subset filtered by
 * cursor.p) and the cold-start seed pass (which emits nothing, just hands
 * the entries to {@link OwnStateHub.seedStatusCache}).
 */
export interface DerivedPositionRow {
  /** `${speculationId}_${positionType}` — the hub-cache key. */
  key: string;
  body: PositionStatusEventBody;
  /**
   * `max(positions.row_updated_at, speculations.row_updated_at,
   * contests.row_updated_at)` preserved verbatim — microseconds
   * intact. Comparisons go through `compareIsoTimestamptz` so the
   * wire-contract precision is honored end-to-end (Date.parse would
   * truncate to milliseconds, causing same-ms parent transitions to
   * mis-sort / mis-filter).
   */
  sourceUpdatedAt: string;
  id: string;
  idBig: bigint;
}

export interface DerivedPositionStateResult {
  rows: DerivedPositionRow[];
  /**
   * `true` when the actionable-set query saturated the 200-row cap. The
   * stream still has VALID data for the rows it has; we just can't
   * guarantee complete coverage. Surfaced to the SDK via an `event:
   * degraded` so the market maker holds quoting instead of looping
   * the SDK through endless reconnects.
   */
  saturated: boolean;
  /**
   * `true` when the resume-only `recentTerminalSince` query saturated.
   * Always `false` when `recentTerminalSince` wasn't provided (cold start).
   * Same degraded-state semantics as `saturated`.
   */
  terminalSaturated: boolean;
  /** Set when an upstream query failed; caller emits `resync`. */
  queryFailed: boolean;
}
type DerivePositionStateResultWithFlags = DerivedPositionStateResult;

/**
 * Derive current `positionStatus` for every actionable + recently-cached
 * position in the wallet. Position population matches
 * `loadOwnStateSnapshot` (via `fetchCategorizedPositions` filter) PLUS
 * recently-changed cached keys — so the snapshot and the stream always
 * cover the same population:
 *
 *   1. Query actionable: `claimed=false AND risk_amount>0`, cap 200,
 *      ORDER BY row_updated_at DESC.
 *   2. Query cached keys that are NOT in the actionable result (the
 *      hub may already track positions that have just transitioned out
 *      of the actionable filter — claimed flip, transfer-out).
 *   3. Batch-join speculations + contests (both carry `row_updated_at`
 *      so the derivation's `sourceUpdatedAt = max(...)` reflects every
 *      transition source).
 *   4. Derive status per position; assemble {@link DerivedPositionRow}
 *      entries sorted by (sourceUpdatedAt, id) ASC so any caller emitting
 *      a subset still advances the cursor monotonically.
 *
 * Saturation: `saturated=true` when the actionable query returned a full
 * 200-row page. The stream emits `event: degraded` and proceeds with
 * `ready`; the SDK / MM treats the wallet as quote-held per the stream-
 * health gate. This breaks the infinite-resync loop the
 * earlier `positions_cap_exceeded` path produced for wallets at the cap.
 */
export interface DerivePositionsOptions {
  /**
   * Hub-cache keys (`${specId}_${positionType}`) currently tracked. The
   * helper queries any whose row is missing from the actionable result
   * (e.g. a position whose claim/transfer-out flipped it out of the
   * actionable filter) so the next derivation can emit the terminal
   * transition before the cache entry falls out of tracking.
   */
  cachedKeys?: Iterable<string>;
  /**
   * When set, the helper ALSO queries positions whose row_updated_at
   * advanced past this watermark AND that match the terminal filter
   * (`claimed=true OR risk_amount=0`). Used by RESUME catch-up so a
   * claim or transfer-out that happened while the client was offline
   * surfaces as a `positionStatus` event past the cursor — neither
   * the actionable query nor cached-key refresh (cache is empty on a
   * fresh reconnect) would otherwise see it.
   */
  recentTerminalSince?: ResourceWatermark;
}

export async function derivePositionsForWallet(
  sb: ReturnType<typeof getSupabase>,
  net: string,
  address: string,
  options: DerivePositionsOptions = {},
): Promise<DerivePositionStateResultWithFlags> {
  const cachedKeys: Iterable<string> = options.cachedKeys ?? [];
  // Phase 1: actionable population.
  const actionableRes = await sb
    .from('positions')
    .select(
      'speculation_id, user_address, position_type, risk_amount, profit_amount, ' +
        'claimed, row_updated_at, id',
    )
    .eq('network', net)
    .eq('user_address', address)
    .eq('claimed', false)
    .gt('risk_amount', 0)
    .order('row_updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(CATCHUP_POSITIONS_LIMIT);
  if (actionableRes.error) {
    logger.error(
      { err: actionableRes.error.message, address },
      'ownState/stream catchup: actionable positions query failed',
    );
    return { rows: [], saturated: false, queryFailed: true, terminalSaturated: false };
  }
  const actionable = (actionableRes.data ?? []) as unknown as Array<{
    speculation_id: string | number;
    user_address: string;
    position_type: 'upper' | 'lower';
    risk_amount: string | number | null;
    profit_amount: string | number | null;
    claimed: boolean;
    row_updated_at: string;
    id: string | number;
  }>;
  const saturated = actionable.length >= CATCHUP_POSITIONS_LIMIT;

  // Phase 2: cached keys NOT in the actionable result — re-fetch their
  // current row so a just-claimed / just-transferred-out transition shows
  // up before the cache entry falls out of tracking.
  const actionableKeys = new Set(
    actionable.map(
      (p) =>
        `${String(p.speculation_id)}_${p.position_type === 'upper' ? 0 : 1}`,
    ),
  );
  const staleSpecIds: number[] = [];
  for (const key of cachedKeys) {
    if (actionableKeys.has(key)) continue;
    const specPart = key.slice(0, key.lastIndexOf('_'));
    const id = Number(specPart);
    if (Number.isFinite(id)) staleSpecIds.push(id);
  }
  let stale: typeof actionable = [];
  if (staleSpecIds.length > 0) {
    const staleRes = await sb
      .from('positions')
      .select(
        'speculation_id, user_address, position_type, risk_amount, profit_amount, ' +
          'claimed, row_updated_at, id',
      )
      .eq('network', net)
      .eq('user_address', address)
      .in('speculation_id', staleSpecIds)
      .limit(CATCHUP_POSITIONS_LIMIT);
    if (staleRes.error) {
      logger.error(
        { err: staleRes.error.message, address },
        'ownState/stream catchup: cached-key refresh query failed',
      );
      return { rows: [], saturated, queryFailed: true, terminalSaturated: false };
    }
    stale = (staleRes.data ?? []) as unknown as typeof actionable;
  }

  // Phase 3: terminal-since-cursor — recently-claimed or transferred-out
  // rows that left the actionable filter while the client was offline.
  // Only meaningful for resume catch-up; cold-start passes
  // `recentTerminalSince=undefined` because the snapshot already delivered
  // the wallet's actionable view and there's no prior cursor to compare
  // against.
  let terminalRows: typeof actionable = [];
  let terminalSaturated = false;
  if (options.recentTerminalSince) {
    // Apply the same `(row_updated_at, id) > floor(cursor.p)` keyset +
    // 30s overlap floor the rest of the recovery paths use. A naive
    // `.gt('row_updated_at', since.s)` would miss:
    //   - same-timestamp rows with higher id (id tie-breaker);
    //   - rows whose row_updated_at landed in the 30s overlap window
    //     (a writer-tx that committed late vs. `now()` semantics).
    // Combine `(claimed=true OR risk_amount=0) AND keyset` as ONE
    // PostgREST `.or()` expression — supabase-js chains, but using a
    // single DNF expression with nested `or(...)` inside `and(...)` is
    // the same pattern the fills catch-up uses for sided keyset.
    const floored = floorBaseWatermark(options.recentTerminalSince);
    const keyset = `row_updated_at.gt.${floored.s},and(row_updated_at.eq.${floored.s},id.gt.${floored.i})`;
    const terminalExpr =
      `and(claimed.eq.true,or(${keyset})),and(risk_amount.eq.0,or(${keyset}))`;
    const terminalRes = await sb
      .from('positions')
      .select(
        'speculation_id, user_address, position_type, risk_amount, profit_amount, ' +
          'claimed, row_updated_at, id',
      )
      .eq('network', net)
      .eq('user_address', address)
      .or(terminalExpr)
      .order('row_updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(CATCHUP_POSITIONS_LIMIT);
    if (terminalRes.error) {
      logger.error(
        { err: terminalRes.error.message, address },
        'ownState/stream catchup: terminal-since-cursor query failed',
      );
      return { rows: [], saturated, queryFailed: true, terminalSaturated: false };
    }
    terminalRows = (terminalRes.data ?? []) as unknown as typeof actionable;
    terminalSaturated = terminalRows.length >= CATCHUP_POSITIONS_LIMIT;
  }

  // Merge into a unique-per-key list (actionable wins on conflict for
  // its current state, then stale-cache refresh, then terminal-since).
  const positionsByKey = new Map<string, (typeof actionable)[number]>();
  for (const row of [...actionable, ...stale, ...terminalRows]) {
    const key = `${String(row.speculation_id)}_${row.position_type === 'upper' ? 0 : 1}`;
    if (!positionsByKey.has(key)) positionsByKey.set(key, row);
  }
  const positions = [...positionsByKey.values()];
  if (positions.length === 0) {
    return { rows: [], saturated, queryFailed: false, terminalSaturated };
  }

  // Speculation join.
  const specIds = [...new Set(positions.map((p) => Number(p.speculation_id)))];
  const specsById = new Map<
    number,
    {
      speculation_id: number;
      contest_id: number | null;
      market_type: MarketType | null;
      line_ticks: number | null;
      speculation_status: 'open' | 'closed';
      win_side: SpeculationInput['winSide'];
      row_updated_at: string;
    }
  >();
  if (specIds.length > 0) {
    const specRes = await sb
      .from('speculations')
      .select(
        'speculation_id, contest_id, market_type, line_ticks, speculation_status, ' +
          'win_side, row_updated_at',
      )
      .eq('network', net)
      .in('speculation_id', specIds);
    if (specRes.error) {
      logger.error(
        { err: specRes.error.message, address },
        'ownState/stream catchup: speculations join failed',
      );
      return { rows: [], saturated, queryFailed: true, terminalSaturated };
    }
    for (const s of (specRes.data ?? []) as unknown as Array<{
      speculation_id: number;
      contest_id: number | null;
      market_type: MarketType | null;
      line_ticks: number | null;
      speculation_status: 'open' | 'closed';
      win_side: SpeculationInput['winSide'];
      row_updated_at: string;
    }>) {
      specsById.set(s.speculation_id, s);
    }
  }

  // Contest join.
  const contestIds = [
    ...new Set(
      [...specsById.values()]
        .map((s) => s.contest_id)
        .filter((id): id is number => id != null),
    ),
  ];
  const contestsById = new Map<
    number,
    {
      contest_id: number;
      contest_status: ContestInput['contestStatus'];
      away_score: number | null;
      home_score: number | null;
      row_updated_at: string;
    }
  >();
  if (contestIds.length > 0) {
    const contestRes = await sb
      .from('contests')
      .select('contest_id, contest_status, away_score, home_score, row_updated_at')
      .eq('network', net)
      .in('contest_id', contestIds);
    if (contestRes.error) {
      logger.error(
        { err: contestRes.error.message, address },
        'ownState/stream catchup: contests join failed',
      );
      return { rows: [], saturated, queryFailed: true, terminalSaturated };
    }
    for (const c of (contestRes.data ?? []) as unknown as Array<{
      contest_id: number;
      contest_status: ContestInput['contestStatus'];
      away_score: number | null;
      home_score: number | null;
      row_updated_at: string;
    }>) {
      contestsById.set(c.contest_id, c);
    }
  }

  // Derivation + assembly. Sorted by (sourceUpdatedAt, id) ASC via the
  // microsecond-safe `compareIsoTimestamptz` so same-ms parent
  // transitions order correctly — `Date.parse`-based sort would
  // collapse them and let cursor.p re-emit drift.
  const rows: DerivedPositionRow[] = [];
  for (const row of positions) {
    const spec = specsById.get(Number(row.speculation_id));
    if (!spec) continue; // orphan — defensive skip
    const contest = spec.contest_id != null ? contestsById.get(spec.contest_id) ?? null : null;
    const positionType: 0 | 1 = row.position_type === 'upper' ? 0 : 1;
    const sourceUpdatedAt = maxIsoTimestamptz(
      row.row_updated_at,
      spec.row_updated_at,
      contest?.row_updated_at,
    );
    let idBig: bigint;
    try {
      idBig = BigInt(String(row.id));
    } catch {
      idBig = 0n;
    }
    const body = derivePositionStatus(
      {
        speculationId: String(row.speculation_id),
        address: row.user_address.toLowerCase(),
        positionType,
        riskAmount: row.risk_amount as string | null,
        profitAmount: row.profit_amount as string | null,
        claimed: row.claimed,
      },
      {
        speculationStatus: spec.speculation_status,
        winSide: spec.win_side,
        marketType: spec.market_type ?? 'moneyline',
        lineTicks: spec.line_ticks,
      },
      contest
        ? {
            contestStatus: contest.contest_status,
            awayScore: contest.away_score,
            homeScore: contest.home_score,
          }
        : null,
      sourceUpdatedAt,
    );
    rows.push({
      key: `${String(row.speculation_id)}_${positionType}`,
      body,
      sourceUpdatedAt,
      id: String(row.id),
      idBig,
    });
  }
  rows.sort((a, b) => {
    const byTs = compareIsoTimestamptz(a.sourceUpdatedAt, b.sourceUpdatedAt);
    if (byTs !== 0) return byTs;
    if (a.idBig === b.idBig) return 0;
    return a.idBig < b.idBig ? -1 : 1;
  });
  return { rows, saturated, queryFailed: false, terminalSaturated };
}

/**
 * Resume catch-up for `positionStatus`: derives current state for the
 * wallet, emits the subset past `cursorWatermark` (with overlap floor on
 * the first page since the input cursor is always `k='live'`), and
 * returns the full row list so the handler can seed
 * {@link OwnStateHub.seedStatusCache}.
 *
 * Returns a `degraded` outcome (status='complete') when the actionable
 * query saturated — the handler emits `event: degraded` then `ready` so
 * the SDK has a defined terminal state instead of an endless resync
 * loop. The market maker's quote-hold rules handle the operational
 * consequence.
 */
async function catchUpPositions(
  res: Response,
  sb: ReturnType<typeof getSupabase>,
  net: string,
  address: string,
  cursorWatermark: ResourceWatermark,
  isClosed: () => boolean,
  shed: () => void,
  emit: (body: PositionStatusEventBody, ts: string, id: string) => void,
): Promise<{ status: CatchupStatus; seedRows: DerivedPositionRow[]; degraded: boolean }> {
  if (isClosed() || res.writableEnded) {
    return { status: 'closed', seedRows: [], degraded: false };
  }
  // RESUME-only: also query terminal-since-cursor so a claim or
  // transfer-out that happened while the client was offline surfaces as
  // a `positionStatus` event past the cursor. Cold-start uses the
  // snapshot helper instead (which delivers actionable state); resume
  // catch-up has no such snapshot, so we must catch terminals here.
  const derivation = await derivePositionsForWallet(sb, net, address, {
    recentTerminalSince: cursorWatermark,
  });
  if (derivation.queryFailed) {
    writeOwnStateEvent(res, 'resync', { reason: 'catchup_failed' });
    return { status: 'resync', seedRows: [], degraded: false };
  }
  // Overlap floor on the first call (input cursor.k='live' is validated
  // upstream) — catches a late-committing source row whose effective
  // timestamp predates the cursor by < RECOVERY_OVERLAP_MS.
  // `compareIsoTimestamptz` preserves the microseconds the wire
  // contract honors; a `Date.parse`-based comparison would let a
  // same-ms-but-micros-newer row be filtered out as equal.
  const flooredCursor = floorBaseWatermark(cursorWatermark);
  const flooredId = (() => {
    try {
      return BigInt(flooredCursor.i);
    } catch {
      return 0n;
    }
  })();
  for (const r of derivation.rows) {
    if (isClosed() || res.writableEnded) {
      return {
        status: 'closed',
        seedRows: derivation.rows,
        degraded: derivation.saturated || derivation.terminalSaturated,
      };
    }
    // (sourceUpdatedAt, id) > (flooredCursor.s, flooredId) — strict
    // microsecond-aware keyset advance.
    const byTs = compareIsoTimestamptz(r.sourceUpdatedAt, flooredCursor.s);
    if (byTs < 0) continue;
    if (byTs === 0 && r.idBig <= flooredId) continue;
    emit(r.body, r.sourceUpdatedAt, r.id);
    shed();
  }
  if (res.writableEnded) {
    return {
      status: 'closed',
      seedRows: derivation.rows,
      degraded: derivation.saturated || derivation.terminalSaturated,
    };
  }
  return {
    status: 'complete',
    seedRows: derivation.rows,
    degraded: derivation.saturated || derivation.terminalSaturated,
  };
}

/** Mirrors `STATUS_DERIVATION_LIMIT` in hub.ts + `POSITION_QUERY_LIMIT` in positionFetch.ts. */
const CATCHUP_POSITIONS_LIMIT = 200;

// Floor `(s, i)` by the recovery overlap window — used to catch a slow
// writer tx whose row_updated_at predates the cursor's timestamp. Mirrors
// `watermarkLiveKeysetOr`'s floor in shape form. Suppresses negative ms.
function floorBaseWatermark(w: ResourceWatermark): ResourceWatermark {
  // Inline the offset so this module doesn't need to re-export cursor.ts
  // constants. 30_000 mirrors RECOVERY_OVERLAP_MS in cursor.ts.
  const ms = Date.parse(w.s);
  if (!Number.isFinite(ms)) return w;
  return { s: new Date(Math.max(0, ms - 30_000)).toISOString(), i: '0' };
}
