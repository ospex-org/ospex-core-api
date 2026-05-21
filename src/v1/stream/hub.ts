/**
 * StreamHub — one internal poller per resource, fanning live deltas out to all
 * matching SSE subscribers. This is the N→1 collapse: many agents subscribe,
 * but each resource is polled once per tick regardless of subscriber count.
 *
 * Late-commit safety (the companion to A1's resume overlap): `now()` is
 * transaction-start time, so a slow writer tx can land a row whose
 * `row_updated_at` predates rows already emitted. Each tick re-scans an overlap
 * window (`highWater − overlap`) and dedupes by event-cursor `(row_updated_at,
 * id)`, so a late row is picked up on a subsequent tick and emitted exactly
 * once. Within a tick, paging is strict keyset (forward, terminating).
 *
 * Reorg safety: a separate watcher polls `recovery_runs`; when a recovery
 * (reorg/backfill) completes, it broadcasts a `resync` to every subscriber —
 * recovery hard-DELETEs rows, which polling can't observe, so clients
 * re-snapshot. Pollers are ref-counted: started on the first subscriber for a
 * resource, stopped on the last; the resync watcher runs whenever any
 * subscriber exists.
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
  /** Max rows fetched per page; PostgREST caps at 1000. */
  pollLimit?: number;
  /** Max pages drained per tick (burst guard; the next tick continues). */
  maxPagesPerTick?: number;
}

interface PollerState {
  subs: Set<Subscriber>;
  timer: ReturnType<typeof setInterval>;
  /** Max row_updated_at (ms) ever fetched — the re-scan floor is this minus overlap. */
  highTsMs: number;
  /** event-key (`ts|id`) → row_updated_at ms, for dedupe + eviction. */
  emitted: Map<string, number>;
  polling: boolean;
}

export class StreamHub {
  private readonly deps: Required<StreamHubDeps>;
  private readonly pollers = new Map<StreamResourceName, PollerState>();
  private totalSubs = 0;
  private resyncTimer: ReturnType<typeof setInterval> | undefined;
  private resyncHighId: bigint | null = null;
  private resyncPolling = false;

  constructor(deps: StreamHubDeps) {
    this.deps = {
      overlapMs: 30_000,
      pollMs: 1_500,
      resyncMs: 5_000,
      pollLimit: 500,
      maxPagesPerTick: 20,
      ...deps,
    };
  }

  subscribe(resource: StreamResourceName, filters: StreamFilters, cb: SubscriberCallbacks): Subscriber {
    const sub: Subscriber = { resource, filters, onDelta: cb.onDelta, onResync: cb.onResync };

    let state = this.pollers.get(resource);
    if (!state) {
      state = {
        subs: new Set(),
        // Start from now: history is the connection's catch-up job. The first
        // tick re-scans the overlap window to catch anything just committed.
        highTsMs: Date.now(),
        emitted: new Map(),
        polling: false,
        timer: setInterval(() => {
          void this.pollResource(resource);
        }, this.deps.pollMs),
      };
      // Don't keep the event loop alive on the timer alone.
      state.timer.unref?.();
      this.pollers.set(resource, state);
    }
    state.subs.add(sub);

    this.totalSubs += 1;
    if (this.totalSubs === 1 && this.resyncTimer === undefined) {
      this.resyncHighId = null; // re-baseline on next resync poll
      this.resyncTimer = setInterval(() => {
        void this.pollResync();
      }, this.deps.resyncMs);
      this.resyncTimer.unref?.();
    }
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

  /** One poll tick for a resource: drain new/late deltas and fan them out. Public for tests. */
  async pollResource(name: StreamResourceName): Promise<void> {
    const state = this.pollers.get(name);
    if (!state || state.polling) return;
    state.polling = true;
    try {
      const resource = STREAM_RESOURCES[name];
      const floorIso = new Date(Math.max(0, state.highTsMs - this.deps.overlapMs)).toISOString();
      let cmp: { s: string; i: string } = { s: floorIso, i: '0' };
      const fresh: StreamRow[] = [];

      for (let page = 0; page < this.deps.maxPagesPerTick; page += 1) {
        const { data, error } = await this.deps
          .getClient()
          .from(resource.table)
          .select(resource.columns)
          .eq('network', this.deps.getNetwork())
          .or(keysetOrExpr(cmp.s, cmp.i))
          .order('row_updated_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(this.deps.pollLimit);
        if (error) {
          logger.error({ err: error.message, resource: name }, 'stream poller: query failed');
          return;
        }
        const rows = (data ?? []) as unknown as StreamRow[];
        for (const row of rows) {
          fresh.push(row);
          cmp = { s: row.row_updated_at, i: String(row.id) };
        }
        if (rows.length < this.deps.pollLimit) break;
      }

      this.processDeltas(name, state, fresh);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), resource: name }, 'stream poller: tick failed');
    } finally {
      state.polling = false;
    }
  }

  /** Dedupe by event-cursor, fan out to matching subscribers, advance the watermark. */
  private processDeltas(name: StreamResourceName, state: PollerState, rows: StreamRow[]): void {
    const resource = STREAM_RESOURCES[name];
    for (const row of rows) {
      const tsMs = Date.parse(row.row_updated_at);
      if (Number.isFinite(tsMs) && tsMs > state.highTsMs) state.highTsMs = tsMs;
      const key = `${row.row_updated_at}|${String(row.id)}`;
      if (state.emitted.has(key)) continue;
      state.emitted.set(key, Number.isFinite(tsMs) ? tsMs : state.highTsMs);

      const body = resource.toBody(row);
      if (body === null) continue; // e.g. an unenriched speculation
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
    // Evict dedupe entries that can no longer be re-scanned (older than 2× overlap).
    const cutoff = state.highTsMs - this.deps.overlapMs * 2;
    for (const [key, tsMs] of state.emitted) {
      if (tsMs < cutoff) state.emitted.delete(key);
    }
  }

  /** Poll recovery_runs; broadcast resync on newly-completed recoveries. Public for tests. */
  async pollResync(): Promise<void> {
    if (this.totalSubs === 0 || this.resyncPolling) return;
    this.resyncPolling = true;
    try {
      const net = this.deps.getNetwork();
      const client = this.deps.getClient();
      if (this.resyncHighId === null) {
        // Baseline: highest already-completed run, so we don't replay history.
        const { data, error } = await client
          .from('recovery_runs')
          .select('id')
          .eq('network', net)
          .eq('status', 'complete')
          .order('id', { ascending: false })
          .limit(1);
        if (error) {
          logger.error({ err: error.message }, 'stream resync: baseline query failed');
          return;
        }
        const top = (data ?? [])[0] as { id: string | number } | undefined;
        this.resyncHighId = top ? BigInt(String(top.id)) : 0n;
        return;
      }

      const { data, error } = await client
        .from('recovery_runs')
        .select('id, kind')
        .eq('network', net)
        .eq('status', 'complete')
        .gt('id', this.resyncHighId.toString())
        .order('id', { ascending: true })
        .limit(50);
      if (error) {
        logger.error({ err: error.message }, 'stream resync: poll failed');
        return;
      }
      for (const row of (data ?? []) as Array<{ id: string | number; kind: string }>) {
        this.broadcastResync(String(row.kind));
        const idB = BigInt(String(row.id));
        if (idB > this.resyncHighId) this.resyncHighId = idB;
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'stream resync: tick failed');
    } finally {
      this.resyncPolling = false;
    }
  }

  private broadcastResync(reason: string): void {
    for (const state of this.pollers.values()) {
      for (const sub of state.subs) {
        try {
          sub.onResync(reason);
        } catch (err) {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, 'stream resync: onResync threw');
        }
      }
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
