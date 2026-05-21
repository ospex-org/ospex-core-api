/**
 * StreamHub — one internal poller per resource, fanning live deltas out to all
 * matching SSE subscribers. This is the N→1 collapse: many agents subscribe,
 * but each resource is polled once per tick regardless of subscriber count.
 *
 * Each tick has two phases:
 *
 *   1. Forward drain — strict keyset `(row_updated_at, id) > tip`, paged,
 *      advancing `tip` per row. This always makes forward progress, so it can
 *      never starve: a per-tick page budget just spreads a large backlog
 *      across ticks (the next tick resumes past the new tip).
 *
 *   2. Overlap re-scan — the recent window `row_updated_at ∈ [tip − overlap,
 *      tip]`, deduped by event-cursor `(row_updated_at, id)`. `now()` is
 *      transaction-start time, so a slow writer tx can commit a row whose
 *      `row_updated_at` predates `tip`; the forward drain (strictly `> tip`)
 *      would miss it, so this bounded re-scan catches it. The window slides as
 *      `tip` advances, so a late row is always reached within a tick or two.
 *
 * A late row is therefore emitted out of `row_updated_at` order (after newer
 * rows). The contract is convergence, not wire-order: clients apply
 * last-write-wins keyed by natural key, comparing the event cursor — a delta
 * whose cursor is ≤ the one already applied for that key is a no-op.
 *
 * Reorg safety: a watcher polls `recovery_runs`; when a recovery completes it
 * broadcasts `resync` to every subscriber (recovery hard-deletes rows, which
 * polling can't observe). Pollers are ref-counted; the resync watcher runs
 * whenever any subscriber exists and baselines immediately on the first one.
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
  /** Max forward pages per tick (a large backlog spreads across ticks — no starvation). */
  maxForwardPages?: number;
  /** Max overlap-rescan pages per tick (the window is bounded, so this rarely binds). */
  maxOverlapPages?: number;
}

interface Cmp {
  s: string;
  i: string;
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
  private resyncHighId: bigint | null = null;
  private resyncPolling = false;

  constructor(deps: StreamHubDeps) {
    this.deps = {
      overlapMs: 30_000,
      pollMs: 1_500,
      resyncMs: 5_000,
      pollLimit: 500,
      maxForwardPages: 20,
      maxOverlapPages: 10,
      ...deps,
    };
  }

  subscribe(resource: StreamResourceName, filters: StreamFilters, cb: SubscriberCallbacks): Subscriber {
    const sub: Subscriber = { resource, filters, onDelta: cb.onDelta, onResync: cb.onResync };

    let state = this.pollers.get(resource);
    if (!state) {
      state = {
        subs: new Set(),
        // Start from now — history is the connection's catch-up job. The first
        // tick's overlap re-scan still sweeps the last `overlap` of changes.
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
      // Baseline immediately (not after resyncMs) so a recovery completing right
      // after the first subscriber connects isn't silently swallowed.
      this.resyncHighId = null;
      void this.pollResync();
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

  /** One poll tick: forward-drain new rows, then re-scan the overlap window. Public for tests. */
  async pollResource(name: StreamResourceName): Promise<void> {
    const state = this.pollers.get(name);
    if (!state || state.polling) return;
    state.polling = true;
    try {
      // (1) Forward drain — strict `> tip`, advances tip. Never starves.
      state.tip = await this.scan(name, state, state.tip, null, this.deps.maxForwardPages);

      // (2) Overlap re-scan — recent window for late commits; does not move tip.
      const tipMs = Date.parse(state.tip.s);
      if (Number.isFinite(tipMs)) {
        const floorIso = new Date(Math.max(0, tipMs - this.deps.overlapMs)).toISOString();
        await this.scan(name, state, { s: floorIso, i: '0' }, state.tip.s, this.deps.maxOverlapPages);
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
   * `upperTs` (inclusive). Emits each row, returns the furthest cursor reached.
   */
  private async scan(
    name: StreamResourceName,
    state: PollerState,
    start: Cmp,
    upperTs: string | null,
    maxPages: number,
  ): Promise<Cmp> {
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
        logger.error({ err: error.message, resource: name }, 'stream poller: query failed');
        break;
      }
      const rows = (data ?? []) as unknown as StreamRow[];
      for (const row of rows) {
        this.emitRow(name, state, row);
        cmp = { s: row.row_updated_at, i: String(row.id) };
      }
      if (rows.length < this.deps.pollLimit) break;
    }
    return cmp;
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

  /** Poll recovery_runs; broadcast resync on newly-completed recoveries. Public for tests. */
  async pollResync(): Promise<void> {
    if (this.totalSubs === 0 || this.resyncPolling) return;
    this.resyncPolling = true;
    try {
      const net = this.deps.getNetwork();
      const client = this.deps.getClient();
      if (this.resyncHighId === null) {
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

/** Test-only: install an isolated hub (with mock deps) behind getStreamHub(). */
export function __setStreamHubForTest(hub: StreamHub | undefined): void {
  singleton = hub;
}
