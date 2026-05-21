/**
 * StreamHub — one internal poller per resource, fanning live deltas out to all
 * matching SSE subscribers. This is the N→1 collapse: many agents subscribe,
 * but each resource is polled once per tick regardless of subscriber count.
 *
 * Each tick has two phases:
 *
 *   1. Forward drain — strict keyset `(row_updated_at, id) > tip`, paged,
 *      advancing `tip` per row. Always makes forward progress, so it can never
 *      starve: a per-tick page budget just spreads a large backlog across ticks.
 *
 *   2. Overlap re-scan — the recent window `row_updated_at ∈ [tip − overlap,
 *      tip]`, drained fully and deduped by event-cursor `(row_updated_at, id)`.
 *      `now()` is transaction-START time, so a slow writer tx can commit a row
 *      whose `row_updated_at` predates `tip` (and even predates a value already
 *      emitted for that row). The forward drain (strictly `> tip`) misses it;
 *      this re-scan re-reads the window every tick and emits the row again with
 *      its new event-cursor. The window MUST be drained fully — a low page cap
 *      could leave a late row permanently unread — so if it ever exceeds the
 *      (high) safety budget we broadcast `resync` instead of risking a miss.
 *
 * Because a late row is re-emitted after newer rows, the client contract is
 * **last-received-wins**, NOT cursor ordering: clients apply each delta in the
 * order received, overwriting per natural key. The poller reads current DB
 * state every tick, so the most recently received delta for an entity reflects
 * the most recent read. The cursor is opaque and used only to resume.
 *
 * Reorg safety: a watcher polls `recovery_runs` and broadcasts `resync` to all
 * subscribers when a recovery completes (recovery hard-deletes rows, which
 * polling can't observe). Additionally each subscriber, on connect, checks for
 * a recovery completed within a grace window and re-snapshots if so — this
 * closes the race between a subscriber's REST snapshot and the shared baseline.
 *
 * Dependency-injected (client/network/intervals) so it unit-tests without
 * timers or a live DB.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { cursorFromRow, keysetOrExpr } from '../../lib/cursor.js';
import { loadConfig } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { getSupabase } from '../../lib/supabase.js';
import {
  STREAM_RESOURCES,
  matchesRow,
  type StreamFilters,
  type StreamResourceName,
  type StreamRow,
} from './resources.js';

export interface SubscriberCallbacks {
  /** A matching live delta. `cursorId` is the opaque (live-kind) cursor for SSE `id:`. */
  onDelta: (body: unknown, cursorId: string) => void;
  /** A recovery completed upstream; the client should re-snapshot. */
  onResync: (reason: string) => void;
}

export interface Subscriber extends SubscriberCallbacks {
  readonly resource: StreamResourceName;
  readonly filters: StreamFilters;
}

export interface StreamHubDeps {
  getClient: () => SupabaseClient;
  getNetwork: () => string;
  /** Overlap re-scan window (ms). Mirrors recovery's RECOVERY_OVERLAP_MS. */
  overlapMs?: number;
  /** Per-resource poll interval (ms). */
  pollMs?: number;
  /** recovery_runs watcher interval (ms). Reorgs are rare, so this is slower. */
  resyncMs?: number;
  /** On connect, a recovery completed within this window triggers a re-snapshot. */
  resyncGraceMs?: number;
  /** Max rows fetched per page; PostgREST caps at 1000. */
  pollLimit?: number;
  /** Max forward pages per tick (a large backlog spreads across ticks — no starvation). */
  maxForwardPages?: number;
  /** Safety cap on overlap-rescan pages. The window is bounded; exceeding this means a pathological change rate → resync. */
  maxOverlapPages?: number;
}

interface Cmp {
  s: string;
  i: string;
}

interface ScanResult {
  cmp: Cmp;
  /** True if the scan reached the end of its range (a short page); false if it hit the page cap. */
  exhausted: boolean;
}

interface PollerState {
  subs: Set<Subscriber>;
  timer: ReturnType<typeof setInterval>;
  /** Strict forward high-water — the furthest `(row_updated_at, id)` drained. */
  tip: Cmp;
  /** event-key (`ts|id`) → row_updated_at ms, for dedupe + eviction. */
  emitted: Map<string, number>;
  polling: boolean;
}

export class StreamHub {
  private readonly deps: Required<StreamHubDeps>;
  private readonly pollers = new Map<StreamResourceName, PollerState>();
  private totalSubs = 0;
  private resyncTimer: ReturnType<typeof setInterval> | undefined;
  // Watermark by completion TIME, not id: recovery_runs.id is assigned at run
  // start, so a long-running lower-id recovery can complete after a higher-id
  // one — an id cursor would skip it.
  private resyncCompletedAt: string | null = null;
  private resyncPolling = false;

  constructor(deps: StreamHubDeps) {
    this.deps = {
      overlapMs: 30_000,
      pollMs: 1_500,
      resyncMs: 5_000,
      resyncGraceMs: 60_000,
      pollLimit: 500,
      maxForwardPages: 20,
      maxOverlapPages: 200,
      ...deps,
    };
  }

  subscribe(resource: StreamResourceName, filters: StreamFilters, cb: SubscriberCallbacks): Subscriber {
    const sub: Subscriber = { resource, filters, onDelta: cb.onDelta, onResync: cb.onResync };

    let state = this.pollers.get(resource);
    if (!state) {
      state = {
        subs: new Set(),
        tip: { s: new Date().toISOString(), i: '0' },
        emitted: new Map(),
        polling: false,
        timer: setInterval(() => {
          void this.pollResource(resource);
        }, this.deps.pollMs),
      };
      state.timer.unref?.();
      this.pollers.set(resource, state);
    }
    state.subs.add(sub);

    this.totalSubs += 1;
    if (this.totalSubs === 1 && this.resyncTimer === undefined) {
      this.resyncCompletedAt = null;
      void this.pollResync();
      this.resyncTimer = setInterval(() => {
        void this.pollResync();
      }, this.deps.resyncMs);
      this.resyncTimer.unref?.();
    }

    // Per-subscriber: if a recovery completed in the grace window, this
    // subscriber's REST snapshot may predate it — tell it to re-snapshot.
    // Independent of the shared baseline, so it can't be swallowed by it.
    void this.checkRecentRecovery(sub);
    return sub;
  }

  unsubscribe(sub: Subscriber): void {
    const state = this.pollers.get(sub.resource);
    if (!state || !state.subs.delete(sub)) return;
    this.totalSubs = Math.max(0, this.totalSubs - 1);
    if (state.subs.size === 0) {
      clearInterval(state.timer);
      this.pollers.delete(sub.resource);
    }
    if (this.totalSubs === 0 && this.resyncTimer !== undefined) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = undefined;
    }
  }

  /** One poll tick: forward-drain new rows, then re-scan the overlap window. Public for tests. */
  async pollResource(name: StreamResourceName): Promise<void> {
    const state = this.pollers.get(name);
    if (!state || state.polling) return;
    state.polling = true;
    try {
      // (1) Forward drain — strict `> tip`, advances tip. A backlog larger than
      // the budget just continues next tick (the tip moved). Never starves.
      const forward = await this.scan(name, state, state.tip, null, this.deps.maxForwardPages);
      state.tip = forward.cmp;

      // (2) Overlap re-scan — drain the full recent window for late commits.
      const tipMs = Date.parse(state.tip.s);
      if (Number.isFinite(tipMs)) {
        const floorIso = new Date(Math.max(0, tipMs - this.deps.overlapMs)).toISOString();
        const overlap = await this.scan(name, state, { s: floorIso, i: '0' }, state.tip.s, this.deps.maxOverlapPages);
        if (!overlap.exhausted) {
          // The window is bigger than we can re-read in one tick — we can no
          // longer guarantee late updates are caught. Force a re-snapshot.
          logger.warn({ resource: name }, 'stream poller: overlap window exceeded page budget — resync');
          this.resyncResource(state, 'overlap_window_too_large');
        }
      }
      this.evict(state);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), resource: name }, 'stream poller: tick failed');
    } finally {
      state.polling = false;
    }
  }

  /**
   * Page from `start` (exclusive keyset) up to `maxPages`, optionally capped at
   * `upperTs` (inclusive). Emits each row; returns the furthest cursor reached
   * and whether the range was exhausted (a short final page) vs hit the cap.
   */
  private async scan(
    name: StreamResourceName,
    state: PollerState,
    start: Cmp,
    upperTs: string | null,
    maxPages: number,
  ): Promise<ScanResult> {
    const resource = STREAM_RESOURCES[name];
    let cmp = start;
    for (let page = 0; page < maxPages; page += 1) {
      let q = this.deps
        .getClient()
        .from(resource.table)
        .select(resource.columns)
        .eq('network', this.deps.getNetwork())
        .or(keysetOrExpr(cmp.s, cmp.i));
      if (upperTs !== null) q = q.lte('row_updated_at', upperTs);
      const { data, error } = await q
        .order('row_updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(this.deps.pollLimit);
      if (error) {
        // Transient — log and stop; the next tick retries. Treat as exhausted so
        // a one-off error doesn't trip the overflow resync.
        logger.error({ err: error.message, resource: name }, 'stream poller: query failed');
        return { cmp, exhausted: true };
      }
      const rows = (data ?? []) as unknown as StreamRow[];
      for (const row of rows) {
        this.emitRow(name, state, row);
        cmp = { s: row.row_updated_at, i: String(row.id) };
      }
      if (rows.length < this.deps.pollLimit) return { cmp, exhausted: true };
    }
    return { cmp, exhausted: false };
  }

  /** Dedupe by event-cursor, then fan out to matching subscribers. */
  private emitRow(name: StreamResourceName, state: PollerState, row: StreamRow): void {
    const tsMs = Date.parse(row.row_updated_at);
    const key = `${row.row_updated_at}|${String(row.id)}`;
    if (state.emitted.has(key)) return;
    state.emitted.set(key, Number.isFinite(tsMs) ? tsMs : Date.now());

    const resource = STREAM_RESOURCES[name];
    const body = resource.toBody(row);
    if (body === null) return; // e.g. an unenriched speculation
    const cursorId = cursorFromRow(resource.cursorTable, row, 'live');
    for (const sub of state.subs) {
      if (!matchesRow(sub.filters, row)) continue;
      try {
        sub.onDelta(body, cursorId);
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err), resource: name }, 'stream fan-out: onDelta threw');
      }
    }
  }

  /** Drop dedupe entries that can no longer be re-scanned (older than 2× overlap below tip). */
  private evict(state: PollerState): void {
    const tipMs = Date.parse(state.tip.s);
    if (!Number.isFinite(tipMs)) return;
    const cutoff = tipMs - this.deps.overlapMs * 2;
    for (const [key, tsMs] of state.emitted) {
      if (tsMs < cutoff) state.emitted.delete(key);
    }
  }

  private resyncResource(state: PollerState, reason: string): void {
    for (const sub of state.subs) {
      try {
        sub.onResync(reason);
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'stream resync: onResync threw');
      }
    }
  }

  /** On connect: if a recovery completed within the grace window, this subscriber re-snapshots. */
  private async checkRecentRecovery(sub: Subscriber): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.deps.resyncGraceMs).toISOString();
      const { data, error } = await this.deps
        .getClient()
        .from('recovery_runs')
        .select('id')
        .eq('network', this.deps.getNetwork())
        .eq('status', 'complete')
        .gt('completed_at', cutoff)
        .limit(1);
      if (error) {
        logger.error({ err: error.message }, 'stream resync: recent-recovery check failed');
        return;
      }
      if ((data ?? []).length > 0) {
        try {
          sub.onResync('recovery');
        } catch {
          /* writer no-ops once the socket closes */
        }
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'stream resync: recent-recovery check threw');
    }
  }

  /** Poll recovery_runs; broadcast resync on newly-completed recoveries. Public for tests. */
  async pollResync(): Promise<void> {
    if (this.totalSubs === 0 || this.resyncPolling) return;
    this.resyncPolling = true;
    try {
      const net = this.deps.getNetwork();
      const client = this.deps.getClient();
      if (this.resyncCompletedAt === null) {
        // Baseline EXCLUDES recoveries completed within the grace window, so one
        // completing right around the first subscribe isn't absorbed — it sorts
        // after the baseline and is broadcast by the same poll (fall through).
        const cutoff = new Date(Date.now() - this.deps.resyncGraceMs).toISOString();
        const { data, error } = await client
          .from('recovery_runs')
          .select('completed_at')
          .eq('network', net)
          .eq('status', 'complete')
          .lt('completed_at', cutoff)
          .order('completed_at', { ascending: false })
          .limit(1);
        if (error) {
          logger.error({ err: error.message }, 'stream resync: baseline query failed');
          return;
        }
        const top = (data ?? [])[0] as { completed_at: string } | undefined;
        // Epoch sentinel when there are no older completions, so the broadcast
        // picks up everything completed within the grace window.
        this.resyncCompletedAt = top?.completed_at ?? new Date(0).toISOString();
        // No early return: fall through so within-grace completions get broadcast.
      }

      const { data, error } = await client
        .from('recovery_runs')
        .select('completed_at, kind')
        .eq('network', net)
        .eq('status', 'complete')
        .gt('completed_at', this.resyncCompletedAt)
        .order('completed_at', { ascending: true })
        .limit(50);
      if (error) {
        logger.error({ err: error.message }, 'stream resync: poll failed');
        return;
      }
      const rows = (data ?? []) as Array<{ completed_at: string; kind: string }>;
      for (const row of rows) this.broadcastResync(String(row.kind));
      // Rows are ordered by completed_at asc, so the last is the new watermark.
      const last = rows[rows.length - 1];
      if (last) this.resyncCompletedAt = last.completed_at;
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'stream resync: tick failed');
    } finally {
      this.resyncPolling = false;
    }
  }

  private broadcastResync(reason: string): void {
    for (const state of this.pollers.values()) {
      this.resyncResource(state, reason);
    }
  }

  stats(): { resources: number; subscribers: number } {
    return { resources: this.pollers.size, subscribers: this.totalSubs };
  }
}

// ── singleton (real deps) ───────────────────────────────────────────────
let singleton: StreamHub | undefined;

export function getStreamHub(): StreamHub {
  if (!singleton) {
    singleton = new StreamHub({
      getClient: () => getSupabase(),
      getNetwork: () => loadConfig().network,
    });
  }
  return singleton;
}

/** Test-only: install an isolated hub (with mock deps) behind getStreamHub(). */
export function __setStreamHubForTest(hub: StreamHub | undefined): void {
  singleton = hub;
}
