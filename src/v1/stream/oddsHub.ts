/**
 * OddsHub — the internal odds source. ONE process-level Supabase Realtime
 * channel on `current_odds`, classified + mapped server-side and fanned out to
 * every SSE odds connection. This is the deliberate exception to the protocol
 * stream's poll-and-fan-out model: `current_odds` is already published for
 * Realtime (REPLICA IDENTITY FULL), and odds move often, so a single
 * subscription is cheaper and lower-latency than polling — and it's still the
 * N→1 collapse (one upstream channel regardless of how many agents connect).
 * The Supabase boundary stays inside core-api; SDK clients only ever see the
 * Ospex SSE stream.
 *
 * Fan-out: a Realtime event is classified once (change / refresh / none — see
 * `classifyOddsUpdate`), mapped once to the public per-market shape, then
 * delivered to subscribers whose (jsonoddsId, market) matches. The
 * provider-specific `jsonoddsId` is used only for internal routing; it never
 * reaches the wire.
 *
 * Readiness — why `onActive`: Realtime only delivers row changes that occur
 * AFTER the channel reaches `SUBSCRIBED`, and that handshake is async. So a
 * subscriber must take its baseline snapshot only once the channel is live,
 * or it can miss an update committed between its snapshot read and
 * `SUBSCRIBED`. The hub signals readiness via `onActive`: broadcast on every
 * transition into `SUBSCRIBED` (the first one drives initial snapshots; later
 * ones are post-reconnect resyncs), and fired directly (next microtask) for a
 * subscriber that joins an already-subscribed channel.
 *
 * Degradation: the channel can drop (CHANNEL_ERROR / TIMED_OUT / an unexpected
 * CLOSED). We mark degraded and broadcast `onDegraded`; supabase-js rejoins
 * transient drops on its own, and if it hasn't within `resetDelayMs` we
 * hard-reset (remove + recreate) as a backstop. The next `SUBSCRIBED` clears
 * degraded and broadcasts `onActive` (→ resnapshot). Status callbacks from a
 * channel we've already torn down are ignored (so our own teardown CLOSED
 * doesn't look like a failure).
 *
 * Dependency-injected (client / network / timings) so it unit-tests without a
 * live websocket.
 */

import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
  SupabaseClient,
} from '@supabase/supabase-js';
import { classifyOddsUpdate, type CurrentOddsRow } from '../../lib/oddsClassifier.js';
import { loadConfig } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { getSupabase } from '../../lib/supabase.js';
import { rowToMarketOdds, type MarketOdds, type OddsMarket } from '../utils/odds.js';

export interface OddsSubscriberCallbacks {
  /** A genuine price move for this subscriber's (jsonoddsId, market). */
  onChange: (odds: MarketOdds) => void;
  /** A re-poll with no price change (liveness) for this subscriber. */
  onRefresh: (odds: MarketOdds) => void;
  /** The internal source is degraded; the stream is briefly behind. */
  onDegraded: (reason: string) => void;
  /** The live source is (now) active: take/refresh the baseline snapshot. Fires
   * once the channel is confirmed SUBSCRIBED — initially and after each
   * reconnect — so the snapshot can't miss a pre-subscription update. */
  onActive: () => void;
}

export interface OddsSubscriber extends OddsSubscriberCallbacks {
  readonly jsonoddsId: string;
  readonly market: OddsMarket;
}

export interface OddsHubDeps {
  getClient: () => SupabaseClient;
  getNetwork: () => string;
  /** Realtime channel name. */
  channelName?: string;
  /** Backstop delay before a hard channel reset when the library hasn't
   * rejoined on its own. */
  resetDelayMs?: number;
}

export class OddsHub {
  private readonly deps: Required<OddsHubDeps>;
  private readonly subs = new Set<OddsSubscriber>();
  private channel: RealtimeChannel | undefined;
  /** Channel currently confirmed SUBSCRIBED (live capture active). */
  private subscribed = false;
  private degraded = false;
  private resetting = false;
  private resetTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: OddsHubDeps) {
    this.deps = {
      channelName: 'ospex-odds-source',
      resetDelayMs: 10_000,
      ...deps,
    };
  }

  subscribe(jsonoddsId: string, market: OddsMarket, cb: OddsSubscriberCallbacks): OddsSubscriber {
    const sub: OddsSubscriber = { jsonoddsId, market, ...cb };
    this.subs.add(sub);
    // Open lazily on the first subscriber. While a reset is mid-flight the
    // channel is being recreated — don't race a duplicate open.
    if (this.channel === undefined && !this.resetting) this.openChannel();
    // Catch a joiner up to the channel's current state (deferred so we never
    // re-enter the handler synchronously inside subscribe()):
    //   - already live  → snapshot now (no pre-subscription gap to worry about).
    //   - degraded      → tell it; it takes a best-effort baseline and resyncs
    //                      via onActive when the source recovers.
    //   - mid-handshake → neither; the SUBSCRIBED / error broadcast will reach it.
    if (this.subscribed) queueMicrotask(() => this.fireActive(sub));
    else if (this.degraded) queueMicrotask(() => this.fireDegraded(sub, 'degraded'));
    return sub;
  }

  unsubscribe(sub: OddsSubscriber): void {
    if (!this.subs.delete(sub)) return;
    if (this.subs.size === 0) this.closeChannel();
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  stats(): { subscribers: number; channelOpen: boolean; subscribed: boolean; degraded: boolean } {
    return {
      subscribers: this.subs.size,
      channelOpen: this.channel !== undefined,
      subscribed: this.subscribed,
      degraded: this.degraded,
    };
  }

  // ── channel lifecycle ───────────────────────────────────────────────────

  private openChannel(): void {
    const client = this.deps.getClient();
    const ch = client.channel(this.deps.channelName);
    ch.on(
      // supabase-js narrows `event` strictly per overload; the SDK uses the
      // same cast. Subscribe to the whole table (no server-side filter) and
      // route in-process — `current_odds` is small (one row per game×market).
      'postgres_changes' as never,
      { event: '*', schema: 'public', table: 'current_odds' },
      (payload: RealtimePostgresChangesPayload<CurrentOddsRow>) => {
        if (this.channel === ch) this.onRealtime(payload);
      },
    );
    ch.subscribe((status, err) => {
      // Ignore callbacks from a channel we've already torn down (e.g. the CLOSED
      // our own removeChannel triggers) — only the current channel speaks.
      if (this.channel === ch) this.onStatus(String(status), err);
    });
    this.channel = ch;
  }

  private closeChannel(): void {
    this.clearResetTimer();
    this.subscribed = false;
    this.degraded = false;
    void this.teardownChannel();
  }

  private async teardownChannel(): Promise<void> {
    const ch = this.channel;
    this.channel = undefined; // do this first: stale status/event callbacks now no-op
    if (!ch) return;
    try {
      await this.deps.getClient().removeChannel(ch);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'odds source: removeChannel failed');
    }
  }

  // Public for tests: drive the channel status callback directly.
  onStatus(status: string, err?: Error): void {
    if (status === 'SUBSCRIBED') {
      this.clearResetTimer();
      const wasDown = !this.subscribed;
      this.subscribed = true;
      this.degraded = false;
      // Broadcast on the transition into SUBSCRIBED: the first one drives every
      // current subscriber's initial snapshot (they connected before live
      // capture began); later ones are post-reconnect resyncs.
      if (wasDown) this.broadcastActive();
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      logger.warn({ status, err: err?.message }, 'odds source: realtime channel down');
      this.subscribed = false;
      if (!this.degraded) {
        this.degraded = true;
        this.broadcastDegraded(reasonForStatus(status));
      }
      this.scheduleReset();
    }
  }

  private scheduleReset(): void {
    if (this.resetting || this.resetTimer !== undefined) return;
    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined;
      void this.hardReset();
    }, this.deps.resetDelayMs);
    this.resetTimer.unref?.();
  }

  private clearResetTimer(): void {
    if (this.resetTimer !== undefined) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
  }

  /** Backstop: the library didn't rejoin within the delay — recreate the
   * channel. The fresh SUBSCRIBED broadcasts onActive (→ resnapshot). */
  private async hardReset(): Promise<void> {
    if (this.resetting || this.subs.size === 0 || !this.degraded) return;
    this.resetting = true;
    let failed = false;
    try {
      await this.teardownChannel();
      // The last subscriber may have left during the await (closeChannel ran);
      // only reopen if someone still needs the stream — never leave an orphan.
      if (this.subs.size > 0) this.openChannel();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'odds source: hard reset failed');
      failed = true;
    }
    // Always clear the flag (so a later subscribe can reopen) BEFORE possibly
    // rescheduling — scheduleReset is a no-op while `resetting` is true.
    this.resetting = false;
    if (failed && this.subs.size > 0 && this.degraded) this.scheduleReset();
  }

  // ── event fan-out ─────────────────────────────────────────────────────────

  // Public for tests: drive a Realtime payload directly.
  onRealtime(payload: RealtimePostgresChangesPayload<CurrentOddsRow>): void {
    try {
      const rawNew = payload.new as Partial<CurrentOddsRow> | null | undefined;
      // DELETE / empty payloads carry no usable row — skip (a removed odds row
      // simply won't appear in future snapshots).
      if (!rawNew || typeof rawNew.jsonodds_id !== 'string' || typeof rawNew.market !== 'string') return;
      const newRow = rawNew as CurrentOddsRow;
      // Scope to this deployment's network (the payload carries the full row).
      if (newRow.network !== this.deps.getNetwork()) return;

      const rawOld = payload.old as Partial<CurrentOddsRow> | null | undefined;
      const oldRow = rawOld && Object.keys(rawOld).length > 0 ? (rawOld as CurrentOddsRow) : null;

      const cls = classifyOddsUpdate(oldRow, newRow);
      if (cls === 'none') return;

      const shape = rowToMarketOdds(newRow);
      if (shape === null) return;

      for (const sub of this.subs) {
        if (sub.jsonoddsId !== newRow.jsonodds_id || sub.market !== newRow.market) continue;
        try {
          if (cls === 'change') sub.onChange(shape);
          else sub.onRefresh(shape);
        } catch (err) {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, 'odds fan-out: handler threw');
        }
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'odds source: realtime event failed');
    }
  }

  private broadcastActive(): void {
    for (const sub of this.subs) this.fireActive(sub);
  }

  private broadcastDegraded(reason: string): void {
    for (const sub of this.subs) this.fireDegraded(sub, reason);
  }

  private fireActive(sub: OddsSubscriber): void {
    if (!this.subs.has(sub)) return;
    try {
      sub.onActive();
    } catch {
      /* writer no-ops once the socket closes */
    }
  }

  private fireDegraded(sub: OddsSubscriber, reason: string): void {
    if (!this.subs.has(sub)) return;
    try {
      sub.onDegraded(reason);
    } catch {
      /* writer no-ops once the socket closes */
    }
  }
}

function reasonForStatus(status: string): string {
  if (status === 'TIMED_OUT') return 'timed_out';
  if (status === 'CLOSED') return 'closed';
  return 'channel_error';
}

// ── singleton (real deps) ───────────────────────────────────────────────────
let singleton: OddsHub | undefined;

export function getOddsHub(): OddsHub {
  if (!singleton) {
    singleton = new OddsHub({
      getClient: () => getSupabase(),
      getNetwork: () => loadConfig().network,
    });
  }
  return singleton;
}

/** Test-only: install an isolated hub (with mock deps) behind getOddsHub(). */
export function __setOddsHubForTest(hub: OddsHub | undefined): void {
  singleton = hub;
}
