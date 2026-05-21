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
 * Degradation: the channel can drop (CHANNEL_ERROR / TIMED_OUT). supabase-js
 * rejoins transient drops on its own; we observe the status and broadcast a
 * `degraded` signal to subscribers so the handler can tell clients the stream
 * is briefly behind. If the library hasn't recovered within `resetDelayMs`, we
 * hard-reset (remove + recreate the channel) as a backstop. On any return to
 * SUBSCRIBED after a degradation, we broadcast `resnapshot` — odds is
 * latest-state, so a fresh snapshot fully resyncs whatever moved during the
 * gap (no event replay needed).
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
  /** The source recovered; re-snapshot to resync (latest-state). */
  onResnapshot: () => void;
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
    return sub;
  }

  unsubscribe(sub: OddsSubscriber): void {
    if (!this.subs.delete(sub)) return;
    if (this.subs.size === 0) this.closeChannel();
  }

  /** Whether the source is currently degraded — the handler emits `degraded`
   * right after a fresh subscriber's initial snapshot when this is true. */
  isDegraded(): boolean {
    return this.degraded;
  }

  stats(): { subscribers: number; channelOpen: boolean; degraded: boolean } {
    return { subscribers: this.subs.size, channelOpen: this.channel !== undefined, degraded: this.degraded };
  }

  // ── channel lifecycle ───────────────────────────────────────────────────

  private openChannel(): void {
    const client = this.deps.getClient();
    this.channel = client
      .channel(this.deps.channelName)
      .on(
        // supabase-js narrows `event` strictly per overload; the SDK uses the
        // same cast. Subscribe to the whole table (no server-side filter) and
        // route in-process — `current_odds` is small (one row per game×market).
        'postgres_changes' as never,
        { event: '*', schema: 'public', table: 'current_odds' },
        (payload: RealtimePostgresChangesPayload<CurrentOddsRow>) => this.onRealtime(payload),
      )
      .subscribe((status, err) => this.onStatus(String(status), err));
  }

  private closeChannel(): void {
    this.clearResetTimer();
    this.degraded = false;
    void this.teardownChannel();
  }

  private async teardownChannel(): Promise<void> {
    const ch = this.channel;
    this.channel = undefined;
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
      if (this.degraded) {
        this.degraded = false;
        this.broadcastResnapshot();
      }
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      logger.warn({ status, err: err?.message }, 'odds source: realtime channel degraded');
      if (!this.degraded) {
        this.degraded = true;
        this.broadcastDegraded(status === 'TIMED_OUT' ? 'timed_out' : 'channel_error');
      }
      this.scheduleReset();
    }
    // CLOSED only comes from our own teardown — ignore.
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
   * channel. The fresh SUBSCRIBED (degraded still true) triggers a resnapshot. */
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

  private broadcastDegraded(reason: string): void {
    for (const sub of this.subs) {
      try {
        sub.onDegraded(reason);
      } catch {
        /* writer no-ops once the socket closes */
      }
    }
  }

  private broadcastResnapshot(): void {
    for (const sub of this.subs) {
      try {
        sub.onResnapshot();
      } catch {
        /* writer no-ops once the socket closes */
      }
    }
  }
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
