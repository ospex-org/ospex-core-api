/**
 * `GET /v1/stream/own-state` — owner-auth composite SSE stream (M4b, spec §2.1).
 *
 *   Authorization: Bearer <stream-token>   (verifyStreamToken middleware)
 *   Last-Event-ID: <opaque-cursor>         (on reconnect; optional first connect)
 *   ?cursor=<opaque-cursor>                (first-connect fallback for fetch SSE)
 *
 * Two modes:
 *
 *   COLD START (no cursor) — server emits an inline `event: snapshot` carrying
 *   the maker's complete current state via the shared `loadOwnStateSnapshot`
 *   helper. If the snapshot was complete (`truncated: false` AND
 *   `positionsTruncated: false`), the server immediately emits `event: ready`
 *   and transitions to live. If EITHER `truncated` or `positionsTruncated` is
 *   true, NO `ready` is emitted and the connection ends:
 *     - `truncated` (commitments): per spec §6.2 the SDK pages REST
 *       `/v1/own-state/snapshot?cursor=` until untruncated, then reconnects
 *       to this stream with the final cursor.
 *     - `positionsTruncated`: the snapshot preserves `cursor.p` as sentinel
 *       (cold start) or input value, so the SDK reconnects to this stream
 *       with the emitted cursor and resume catch-up replays every position
 *       transition from the preserved tail before `ready`.
 *
 *   RESUME (cursor present) — server runs per-resource catch-up replay from the
 *   cursor's watermarks (commitments, position_fills, positions). Each replayed
 *   row is emitted as a typed delta with the running composite cursor in `id:`.
 *   On clean catch-up: `ready` and live. On race with a live delta or upstream
 *   resync: `event: resync` and end (forcing client reconnect/re-snapshot).
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
  rowToBody as commitmentRowToBody,
  COMMITMENT_RECOVERY_COLUMNS,
  type CommitmentBody,
  type CommitmentRecoveryRow,
  type CommitmentRow,
} from '../commitments.js';
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
import { loadOwnStateSnapshot } from './snapshot.js';
import { getOwnStateHub, type OwnStateSubscriber } from './hub.js';
import type { MarketType } from '../../lib/speculation.js';

const CATCHUP_PAGE = 500;
const CATCHUP_MAX_PAGES = 50;

// SSE event names. The spec grammar (§2.1) treats these as a closed set.
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

  const ip = acquireStreamSlot(req, res);
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
    release(ip);
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
        if (result.body.truncated || result.body.positionsTruncated) {
          // Snapshot incomplete on at least one resource — must NOT emit
          // `ready`. The two truncation kinds end on different paths:
          //
          //   - `truncated` (commitments): SDK pages REST
          //     `/v1/own-state/snapshot?cursor=` until untruncated, then
          //     reconnects to this stream with the final cursor.
          //
          //   - `positionsTruncated`: the snapshot helper preserves
          //     `cursor.p` as sentinel (cold start) or the input cursor's
          //     value, so the SDK reconnects to this stream WITH the
          //     emitted cursor, and resume catch-up replays every position
          //     transition from the preserved tail before `ready`.
          //
          // Either way we end this connection so the SDK doesn't hold a
          // slot while it transitions to the recovery path.
          preReadyCompletedTotal += 1;
          res.end();
          return;
        }
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
      const status = await runCatchUpWithCursor(
        res,
        address,
        cursor,
        () => closed,
        shedIfSlow,
        (next) => {
          running = next;
        },
      );
      if (closed || status === 'closed' || res.writableEnded) return;

      if (aborted || status === 'resync') {
        if (status !== 'resync') {
          writeOwnStateEvent(res, 'resync', { reason: 'handoff_raced' });
        }
        preReadyResyncedTotal += 1;
        res.end();
        return;
      }

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

function advancePositions(
  cur: OwnStateCursor | null,
  ts: string,
  id: string,
): OwnStateCursor | null {
  if (cur === null) return null;
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
 * per-resource (spec §2.1.2), so ordering across resources is immaterial.
 */
async function runCatchUpWithCursor(
  res: Response,
  address: string,
  initial: OwnStateCursor,
  isClosed: () => boolean,
  shed: () => void,
  updateRunning: (next: OwnStateCursor) => void,
): Promise<CatchupStatus> {
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
    if (status !== 'complete') return status;
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
    if (status !== 'complete') return status;
  }

  // ── positions (with speculation/contest join for status derivation) ──
  {
    const status = await catchUpPositions(
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
    if (status !== 'complete') return status;
  }

  return 'complete';
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
  emit: (body: CommitmentBody, ts: string, id: string) => void,
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
    for (const row of rows) {
      const body = commitmentRowToBody(row as unknown as CommitmentRow, nowMs);
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
 * Catch up `positionStatus` since `cursorWatermark` (cursor `p`).
 *
 * `positionStatus` is a DERIVED event over (positions, speculations,
 * contests) — a transition can be caused by any of the three source rows
 * (position claim/transfer, speculation settling, contest scoring).
 * Keyset-paging on `positions.row_updated_at` alone would miss every
 * speculation/contest-driven transition since the position row doesn't
 * move. The catch-up mirrors `OwnStateHub.reDerivePositionStatuses`:
 *
 *   1. Query the wallet's positions (capped 200, ORDER BY row_updated_at DESC).
 *   2. Batch-join speculations + contests.
 *   3. Compute `sourceUpdatedAt = max(pos.row, spec.row, contest.row)` per row.
 *   4. Emit current derived status for every row whose
 *      `(sourceUpdatedAt, position.id) > (cursor.p, cursor.p.i)`, with an
 *      overlap floor on the first call (`watermarkLiveKeysetOr` semantics).
 *
 * Cursor `p` then carries the highest-effective `sourceUpdatedAt` covered
 * (advanced by `emit`). The SDK reducer dedupes the catch-up against its
 * own snapshot state via the semantic event key
 * `(addr, specId, positionType, status, sourceUpdatedAt)`; over-emission
 * (e.g. unchanged statuses) is benign.
 *
 * Saturation: when the position query returns the full 200-row cap, the
 * wallet may have more positions whose effective timestamps we couldn't
 * inspect. Emit `resync` so the SDK re-snapshots — the snapshot helper
 * will hit `positionsTruncated: true` and the SDK's recovery flow takes
 * over (see snapshot.ts `positionsTruncated` contract).
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
): Promise<CatchupStatus> {
  if (isClosed() || res.writableEnded) return 'closed';

  // Step 1: positions (the full snapshot-equivalent population).
  const positionsRes = await sb
    .from('positions')
    .select(
      'speculation_id, user_address, position_type, risk_amount, profit_amount, ' +
        'claimed, row_updated_at, id',
    )
    .eq('network', net)
    .eq('user_address', address)
    .order('row_updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(CATCHUP_POSITIONS_LIMIT);
  if (positionsRes.error) {
    logger.error(
      { err: positionsRes.error.message, address },
      'ownState/stream catchup: positions query failed',
    );
    writeOwnStateEvent(res, 'resync', { reason: 'catchup_failed' });
    return 'resync';
  }
  const positions = (positionsRes.data ?? []) as unknown as Array<{
    speculation_id: string | number;
    user_address: string;
    position_type: 'upper' | 'lower';
    risk_amount: string | number | null;
    profit_amount: string | number | null;
    claimed: boolean;
    row_updated_at: string;
    id: string | number;
  }>;
  if (positions.length === 0) return 'complete';

  // Step 2a: batch speculation join (carries row_updated_at for the
  // source-timestamp derivation).
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
      writeOwnStateEvent(res, 'resync', { reason: 'catchup_failed' });
      return 'resync';
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

  // Step 2b: batch contest join (carries row_updated_at).
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
      writeOwnStateEvent(res, 'resync', { reason: 'catchup_failed' });
      return 'resync';
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

  // Step 3: cursor floor for the "deliver if newer" filter. The input
  // cursor is `k='live'` (validated upstream), so the first call applies
  // the overlap floor — a late-committing tx whose effective timestamp
  // predates the cursor still surfaces.
  const flooredCursor = floorBaseWatermark(cursorWatermark);
  const flooredMs = Date.parse(flooredCursor.s);
  const flooredId = (() => {
    try {
      return BigInt(flooredCursor.i);
    } catch {
      return 0n;
    }
  })();

  // Step 4: derive, filter, emit. Sort by (sourceUpdatedAt, id) ASC so
  // the cursor advances monotonically for the SDK's reducer.
  type DerivedRow = {
    body: PositionStatusEventBody;
    sourceUpdatedAt: string;
    sourceMs: number;
    id: string;
  };
  const derived: DerivedRow[] = [];
  for (const row of positions) {
    const spec = specsById.get(Number(row.speculation_id));
    if (!spec) continue; // orphan — defensive skip
    const contest = spec.contest_id != null ? contestsById.get(spec.contest_id) ?? null : null;
    const sourceUpdatedAt = maxIsoTimestampStream(
      row.row_updated_at,
      spec.row_updated_at,
      contest?.row_updated_at,
    );
    const body = derivePositionStatus(
      {
        speculationId: String(row.speculation_id),
        address: row.user_address.toLowerCase(),
        positionType: row.position_type === 'upper' ? 0 : 1,
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
    const sourceMs = Date.parse(sourceUpdatedAt);
    if (!Number.isFinite(sourceMs)) continue;
    // (sourceMs, id) > (flooredMs, flooredId) — strict greater-than for the
    // semantic keyset advance. Equal-source AND equal-id can't happen for
    // distinct positions but the comparison is still well-defined.
    let idBig: bigint;
    try {
      idBig = BigInt(String(row.id));
    } catch {
      idBig = 0n;
    }
    if (sourceMs < flooredMs) continue;
    if (sourceMs === flooredMs && idBig <= flooredId) continue;
    derived.push({ body, sourceUpdatedAt, sourceMs, id: String(row.id) });
  }
  derived.sort((a, b) => {
    if (a.sourceMs !== b.sourceMs) return a.sourceMs - b.sourceMs;
    return Number(BigInt(a.id) - BigInt(b.id));
  });
  for (const d of derived) {
    if (isClosed() || res.writableEnded) return 'closed';
    emit(d.body, d.sourceUpdatedAt, d.id);
    shed();
  }
  if (res.writableEnded) return 'closed';

  // Saturation: hit the cap; more positions may exist whose status we
  // couldn't inspect → re-snapshot is the safe path.
  if (positions.length >= CATCHUP_POSITIONS_LIMIT) {
    writeOwnStateEvent(res, 'resync', { reason: 'positions_cap_exceeded' });
    return 'resync';
  }
  return 'complete';
}

/**
 * Local `max` for ISO-8601 timestamps. Same parse-and-compare approach as
 * `hub.ts:maxIsoTimestamp` — the wire format admits `Z` and `+00:00`
 * shapes (PostgREST quirk), so lexicographic comparison is unsafe.
 */
function maxIsoTimestampStream(
  ...values: Array<string | null | undefined>
): string {
  let best: { s: string; ms: number } | null = null;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms > best.ms) best = { s: v, ms };
  }
  return best ? best.s : new Date(0).toISOString();
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
