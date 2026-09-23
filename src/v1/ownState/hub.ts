/**
 * OwnStateHub — per-wallet live-delta poller for `/v1/stream/own-state`.
 *
 * Where `StreamHub` (../stream/hub.ts) collapses many subscribers to one poller
 * per RESOURCE, this hub collapses many subscribers to one poller per WALLET.
 * The fan-out shape differs because the own-state stream is composite — each
 * tick polls THREE tables (commitments, position_fills, positions) for one
 * wallet's rows and fans typed deltas (`commitment`, `fill`, `positionStatus`)
 * to subscribers. A wallet's poller stops when its last subscriber leaves.
 *
 * Each polled resource has the same two-phase scan as StreamHub:
 *
 *   1. Forward drain — strict keyset `(row_updated_at, id) > tip`, paged.
 *      Always makes forward progress; a large backlog spreads across ticks.
 *
 *   2. Overlap re-scan — the recent window `row_updated_at ∈ [tip − overlap,
 *      tip]`, drained fully and deduped by `(row_updated_at, id)`. Same
 *      rationale as the per-resource hub: Postgres `now()` is the
 *      transaction-start time, so a slow writer tx can land a row whose
 *      `row_updated_at` predates `tip`.
 *
 * `commitment` deltas carry the full owner body (signature, EIP-712 fields,
 * etc.) because the route is owner-auth — there is no public-redaction
 * boundary here. `fill` deltas carry the public fill body. `positionStatus`
 * deltas are SYNTHETIC: the hub joins each new/changed `positions` row with
 * its `speculations` + `contests` row at tick time and derives the canonical
 * canonical enum via `derivePositionStatus`.
 *
 * Cursor `p` advances on the DERIVED `sourceUpdatedAt = max(positions,
 * speculations, contests)` row_updated_at — not raw
 * `positions.row_updated_at`. Every tick the hub DRAINS the actionable set's
 * `(row_updated_at, id)` keyset from its own tip to DISCOVER positions the
 * subscriber has not been told about, plus a by-id refresh of the tracked keys
 * that are still live. The derivation emits in sorted `(sourceUpdatedAt, id)`
 * ASC order so a mid-tick disconnect cannot leave the subscriber's cursor past
 * an undelivered earlier-source event. The SDK reducer's dedup key
 *   `(address, speculationId, positionType, status, sourceUpdatedAt)`
 * absorbs any over-emission from overlap re-reads.
 *
 * Neither read is unbounded, and neither is silent. The contract they are
 * measured against is stated on `reDerivePositionStatuses` (`#83`) — every
 * position whose derived status can still change is re-derived every tick, a
 * position `positionStatus` has proved finished is retired, and a derivation
 * that cannot honour the first clause says so. Discovery honours it by
 * construction (`scanPositionRows`, `#97`) and so has nothing to report;
 * maintenance honours it up to a per-tick budget, and exceeding that budget is
 * `onDegraded('positionsTruncated')`, once per poller, which the handler
 * forwards as `event: degraded`.
 *
 * Dependency-injected (client/network/intervals) so it unit-tests against
 * a recorded mock with no timers or live DB.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { getSupabase } from '../../lib/supabase.js';
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
import {
  derivePositionStatus,
  isTerminalForever,
  type ContestInput,
  type PositionStatusEventBody,
  type SpeculationInput,
} from './positionStatus.js';
import {
  compareIsoTimestamptz,
  maxIsoTimestamptz,
} from './timestamps.js';
import type { MarketType } from '../../lib/speculation.js';

// ── Subscriber surface ───────────────────────────────────────────────────

export interface OwnStateCallbacks {
  /** A maker-scoped commitment row update (insert or mutation). */
  onCommitment: (body: OwnerCommitmentBody, ts: string, id: string) => void;
  /** A maker or taker side fill row. */
  onFill: (body: FillBody, ts: string, id: string) => void;
  /**
   * A derived position-status transition. `ts` is the derived
   * `sourceUpdatedAt = max(positions.row_updated_at,
   * speculations.row_updated_at, contests.row_updated_at)` — preserved
   * verbatim with microsecond precision; `id` is the position row's
   * `id` as a tie-breaker for same-`sourceUpdatedAt` events.
   */
  onPositionStatus: (body: PositionStatusEventBody, ts: string, id: string) => void;
  /**
   * Upstream recovery completed (reorg) or the hub couldn't keep its
   * overlap window honest — the subscriber should reconnect/re-snapshot.
   */
  onResync: (reason: string) => void;
  /**
   * The live derivation could not cover the wallet's whole population this
   * tick — position visibility is PARTIAL from here on (`#83`).
   *
   * Distinct from {@link onResync} in both directions. A resync says
   * "reconnect, my view may be out of order"; this says "I am still ordered
   * and still delivering, and there are rows I cannot see." Reconnecting does
   * not fix it, so the subscriber should degrade rather than retry — the
   * handler maps it to `event: degraded` with the same `positionsTruncated`
   * reason the cold-start and catch-up legs already use, which is the only
   * degradation channel the SDK observes (`onStatus('degraded')`).
   *
   * Required rather than optional so every construction site has to decide.
   * Fired at most ONCE per wallet poller — see `signalSaturation`.
   */
  onDegraded: (reason: string) => void;
}

export interface OwnStateSubscriber extends OwnStateCallbacks {
  /** Address the subscriber is bound to (lowercased). */
  readonly address: string;
}

// ── Hub deps + internal state ────────────────────────────────────────────

export interface OwnStateHubDeps {
  getClient: () => SupabaseClient;
  getNetwork: () => string;
  /** Overlap re-scan window (ms). Mirrors RECOVERY_OVERLAP_MS. */
  overlapMs?: number;
  /** Per-wallet poll interval (ms). */
  pollMs?: number;
  /** recovery_runs watcher interval (ms). */
  resyncMs?: number;
  /** On connect, a recovery within this window triggers re-snapshot. */
  resyncGraceMs?: number;
  /** Max rows fetched per page; PostgREST caps at 1000. */
  pollLimit?: number;
  /** Max forward pages per tick per resource. */
  maxForwardPages?: number;
  /** Safety cap on overlap-rescan pages. */
  maxOverlapPages?: number;
}

interface Tip {
  s: string;
  i: string;
}

interface ResourceTipState {
  tip: Tip;
  /** event-key (`ts|id`) → row_updated_at ms, for dedupe + eviction. */
  emitted: Map<string, number>;
}

/** One `positions` row as both derivation phases select it. */
interface PositionDerivationRow {
  speculation_id: string | number;
  user_address: string;
  position_type: 'upper' | 'lower';
  risk_amount: string | number | null;
  profit_amount: string | number | null;
  claimed: boolean;
  row_updated_at: string;
  id: string | number;
}

/**
 * Is `next` strictly past `tip` in `(row_updated_at, id)` order?
 *
 * Microsecond-aware, because `Date.parse` truncates to milliseconds and a
 * `timestamptz` carries six digits (`.claude/rules/core-api-streaming.md` §4).
 * The consequence is narrow and worth stating exactly rather than generally: the
 * drain's floor is derived through `Date.parse` and is therefore millisecond-
 * grained either way, so a coarse comparison here does not lose rows. What it
 * loses is the ANSWER TO "did the tip advance" for two rows inside one
 * millisecond, and that answer is what separates "there is more above the tip"
 * from "this tick could not get past its own overlap" — so at millisecond
 * resolution an unexhausted drain that advanced by microseconds is misreported as
 * a livelock, and the wallet is told to resync for nothing.
 */
function afterTip(next: Tip, tip: Tip): boolean {
  const byTs = compareIsoTimestamptz(next.s, tip.s);
  if (byTs !== 0) return byTs > 0;
  try {
    return BigInt(next.i) > BigInt(tip.i);
  } catch {
    return false;
  }
}

/**
 * Per-position status cache — the semantic-event-key dedup contract for
 * `positionStatus` events. The wire contract keys positionStatus events on
 * `(address, speculationId, positionType, status, sourceUpdatedAt)`. Raw
 * `(positions.row_updated_at, positions.id)` dedup would lose
 * speculation/contest-driven transitions (the underlying position row
 * doesn't move when the parent speculation settles or the contest scores).
 * We re-derive status from a join of (position, speculation, contest)
 * EVERY tick and emit when the derived status differs from the cached one
 * — that catches every source of change while still suppressing no-op
 * re-emits.
 *
 * Per-key: `${speculationId}_${positionType}`. The address is implicit
 * (it's the wallet poller's key).
 */
interface StatusCacheEntry {
  status: import('./positionStatus.js').PositionStatus;
  /** `max(positions.row_updated_at, speculations.row_updated_at, contests.row_updated_at)` at emit time. */
  sourceUpdatedAt: string;
  /**
   * Advisory categorical result (won/lost/push/void) — part of the
   * payload-level dedup. A same-status event with a different `result`
   * still emits (e.g. score correction flipping pendingSettle's
   * prediction). The SDK reducer's dedup key is
   * (addr, specId, ptype, status, sourceUpdatedAt); we include `result`
   * + `claimableAmount` here as belt-and-braces against any derivation
   * that could change the payload while keeping the same (status,
   * sourceUpdatedAt) pair.
   */
  result: 'won' | 'lost' | 'push' | 'void' | undefined;
  /** wei6 claimable amount — part of the payload-level dedup. */
  claimableAmount: string | undefined;
  /**
   * `true` once the derivation proved this key can never transition again
   * (`isTerminalForever`). A frozen entry is RETIRED FROM THE WORK-LIST: it
   * is still consulted for dedup, and it is no longer re-fetched by id in
   * phase B. Phase A still returns it whenever it is inside the recency
   * window, so a change that touches the position row is still observed.
   *
   * Seeded entries start `false` — the handler's seed carries a derived
   * status but not the speculation row the predicate needs, so the first
   * tick is what retires them. One tick of full work on connect is the
   * cost, and it is work the first tick does anyway.
   */
  frozen: boolean;
}

interface WalletPoller {
  subs: Set<OwnStateSubscriber>;
  /**
   * Per-wallet poll timer. NULL until {@link OwnStateHub.beginLive} is
   * called for the first subscriber on this wallet — the handler invokes
   * `beginLive` only AFTER its catch-up has seeded the cache, so a tick
   * cannot silently absorb a derived-state transition that happened during
   * the handoff (the preReady-race blocker found in review).
   */
  timer: ReturnType<typeof setInterval> | null;
  commitments: ResourceTipState;
  fills: ResourceTipState;
  /**
   * DISCOVERY cursor for `positions` (`#97`): the `(row_updated_at, id)` of the
   * newest row phase A has DERIVED. Advances only over rows that reached
   * `statusCache`, so neither a failed query, nor an exhausted page budget, nor a
   * failure in the maintenance page or either parent join can skip one — the
   * caller commits it and only on success (`#97` B1).
   *
   * A bare {@link Tip} rather than a {@link ResourceTipState} because there is
   * no `emitted` map to carry: commitments and fills dedup POSITIONALLY on
   * `(row_updated_at, id)` and therefore need one, plus an eviction pass, while
   * positionStatus dedups SEMANTICALLY on {@link WalletPoller.statusCache}. So a
   * re-read costs a comparison and emits nothing, which is also why this scan
   * folds its overlap into the drain's own floor instead of paying for the
   * separate re-scan `pollCommitments` runs.
   */
  positionsTip: Tip;
  /**
   * Last-emitted (status, sourceUpdatedAt) per `${speculationId}_${positionType}`.
   * Seeded by the handler from its catch-up / cold-start derivation BEFORE
   * the timer starts (see `seedStatusCache`). Ticks emit when the
   * re-derived status differs from the cached entry; new keys are emitted
   * as the appearance of a previously-unknown position.
   */
  statusCache: Map<string, StatusCacheEntry>;
  /**
   * OBSERVABILITY dedup — one log line and one metric bump per poller. Set the
   * first time this wallet's derivation could not cover its population and never
   * cleared, because the tick runs every `pollMs` and a wallet whose live
   * work-list is over the phase-B budget is over it on EVERY tick: unlatched,
   * that is 2,400 identical log lines per hour per wallet.
   *
   * It does NOT gate delivery. Conflating the two was a review blocker: a poller
   * outlives the connection that first saturated it, so a subscriber joining a
   * latched poller was never told anything — reproduced with a first subscriber
   * saturating, the population falling to 10, a second subscriber connecting on
   * a COMPLETE snapshot, and the population then growing again. The tick
   * saturated and the second connection received nothing at all. Delivery is
   * tracked per subscriber in {@link WalletPoller.saturationNotified}.
   */
  saturationSignalled: boolean;
  /**
   * DELIVERY dedup — the subscribers that have already been handed
   * `onDegraded`. Each connection is told exactly once, and a subscriber that
   * joins later is told on the next tick that actually observes saturation
   * rather than on the strength of a latch set for someone else.
   *
   * A WeakSet rather than a Set: it holds no strong reference, so a subscriber
   * that leaves is collectable whether or not anything removes it. An earlier
   * version used a Set plus an explicit `delete` in `unsubscribe`, which works
   * and which no test can distinguish from forgetting the delete — the observable
   * is retained memory, not behaviour. Removing the need for the line beats
   * documenting a permanent survivor for it.
   */
  saturationNotified: WeakSet<OwnStateSubscriber>;
  polling: boolean;
}

interface ScanResult {
  tip: Tip;
  exhausted: boolean;
}

// supabase-js's `.or()` quoting: a hex/lowercase ethereum address has no
// reserved chars, so direct interpolation is safe. The hub never accepts
// untrusted address input — `req.streamAuth.address` is set by the
// verifyStreamToken middleware after EIP-712 recovery.

/**
 * Columns phase A and phase B both read. One list so the two reads cannot
 * drift into deriving from different column sets.
 */
const POSITION_DERIVATION_COLUMNS =
  'speculation_id, user_address, position_type, risk_amount, profit_amount, ' +
  'claimed, row_updated_at, id';

// The phase-A discovery cap this file used to carry (`STATUS_DERIVATION_LIMIT
// = 200`) is GONE, and `scanPositionRows` documents why: a window ordered by a
// mutable key can be displaced, so discovery is a keyset cursor instead and has
// no population cap to saturate. `POSITION_QUERY_LIMIT` (positionFetch.ts) and
// `CATCHUP_POSITIONS_LIMIT` (stream.ts) are unchanged — they bound the SEED,
// which is a different question and still `#76`'s.

/**
 * Phase-B budget: how many cached `speculation_id`s one tick refreshes, and in
 * pages of what size.
 *
 * Chunked rather than one `IN` list because the list length is the caller's
 * data, not a constant — it grows with the number of positions the subscriber
 * holds, and an unbounded `IN` list is an unbounded URL. `4 × 100` covers 400
 * keys per tick; beyond that the tick signals saturation instead of quietly
 * refreshing an arbitrary subset, which is what the single
 * `.limit(STATUS_DERIVATION_LIMIT)` with no `.order()` did before.
 *
 * The per-page row limit is `2 ×` the chunk because
 * `(network, speculation_id, user_address, position_type)` is unique, so a
 * chunk of N speculations yields at most 2N rows for one wallet. That makes the
 * limit an assertion rather than a truncation: reaching it means the uniqueness
 * assumption is wrong, which is worth a warning and is not a silent short read.
 */
const STALE_REFRESH_CHUNK = 100;
const STALE_REFRESH_MAX_PAGES = 4;


export class OwnStateHub {
  private readonly deps: Required<OwnStateHubDeps>;
  private readonly pollers = new Map<string, WalletPoller>();
  private totalSubs = 0;
  private resyncTimer: ReturnType<typeof setInterval> | undefined;
  private resyncCursor: { completedAt: string; id: bigint } | null = null;
  private resyncPolling = false;
  private resyncBroadcastTotal = 0;
  private positionSaturationTotal = 0;

  constructor(deps: OwnStateHubDeps) {
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

  subscribe(address: string, cb: OwnStateCallbacks): OwnStateSubscriber {
    const addr = address.toLowerCase();
    const sub: OwnStateSubscriber = { address: addr, ...cb };

    let state = this.pollers.get(addr);
    if (!state) {
      const nowIso = new Date().toISOString();
      state = {
        subs: new Set(),
        commitments: { tip: { s: nowIso, i: '0' }, emitted: new Map() },
        fills: { tip: { s: nowIso, i: '0' }, emitted: new Map() },
        // Same origin as the other two resources, and for the same reason: the
        // handler's seed covers everything written before this instant, so the
        // cursor only owes what arrives after it. Deliberately NOT epoch — an
        // epoch start would page the wallet's whole actionable history on the
        // first tick, which is the cost `#76` is pricing in the SNAPSHOT.
        positionsTip: { s: nowIso, i: '0' },
        statusCache: new Map(),
        saturationSignalled: false,
        saturationNotified: new WeakSet(),
        polling: false,
        // Timer is deliberately NOT started here — the handler calls
        // `beginLive(sub)` after seeding the status cache. Starting the
        // timer at subscribe time would let a tick run before the cache
        // was seeded, silently caching whatever current state it observed
        // and missing transitions that happened during the catch-up
        // handoff. Commitments/fills don't have this hazard (their
        // callbacks correctly set `aborted=true` during preReady), but
        // positionStatus is derived — a tick without a seeded baseline
        // can't tell "new transition" from "first observation".
        timer: null,
      };
      this.pollers.set(addr, state);
    }
    state.subs.add(sub);

    this.totalSubs += 1;
    if (this.totalSubs === 1 && this.resyncTimer === undefined) {
      this.resyncCursor = null;
      void this.pollResync();
      this.resyncTimer = setInterval(() => {
        void this.pollResync();
      }, this.deps.resyncMs);
      this.resyncTimer.unref?.();
    }

    void this.checkRecentRecovery(sub);
    return sub;
  }

  unsubscribe(sub: OwnStateSubscriber): void {
    const state = this.pollers.get(sub.address);
    if (!state || !state.subs.delete(sub)) return;
    this.totalSubs = Math.max(0, this.totalSubs - 1);
    if (state.subs.size === 0) {
      if (state.timer !== null) clearInterval(state.timer);
      this.pollers.delete(sub.address);
    }
    if (this.totalSubs === 0 && this.resyncTimer !== undefined) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = undefined;
    }
  }

  /**
   * Seed the wallet's positionStatus cache from the handler's catch-up /
   * cold-start derivation. Called BEFORE {@link beginLive} so the first
   * tick has a valid comparison baseline. Idempotent across re-seeding:
   * later seeds overwrite earlier ones, which lets a fresh catch-up's
   * derivation take precedence over a stale cache entry.
   *
   * The handler MUST seed every position it discovered (whether it
   * emitted a positionStatus event for it or not). Anything missing from
   * the seed will be treated as "newly observed" on the first tick and
   * emit unconditionally — which, during a same-tick preReady race,
   * trips the abort signal and forces a resync.
   *
   * ## `terminal`, and why the seed carries it
   *
   * A seeded entry used to arrive live, because the seed carried a derived
   * status but not the speculation row `isTerminalForever` needs, so the first
   * tick had to retire it. That is fine while the seed is capped at 200 and
   * costs one tick of work. It is NOT fine once the seed is complete: 635
   * seeded keys minus the 200 in the recency window phase A used to read is 435
   * live stale keys against a 400-key budget, so the first tick after a complete
   * cold start would report saturation for rows it was about to retire. Measured
   * on the merged code at the time: 635 seeded keys → 4 phase-B pages, 400 of
   * 435 keys covered, `positionsTruncated` signalled, and by tick 2 the
   * retirement had reduced it to one page. The signal is latched per
   * subscriber, so a transient mechanism produced a permanent frame.
   *
   * `#97` made this flag MORE load-bearing rather than less: phase A is now a
   * delta, so it subtracts nothing from the work-list, and every non-frozen
   * seeded key is phase B's on the first tick. 621 seeded keys with the flag is
   * 51 keys of work; without it, it is 621 against a budget of 400.
   *
   * `fetchCategorizedPositions` computes the flag from the join it already did,
   * so this costs nothing and removes the tick-1 spike entirely.
   */
  seedStatusCache(
    address: string,
    entries: Array<{
      key: string;
      status: import('./positionStatus.js').PositionStatus;
      sourceUpdatedAt: string;
      result?: 'won' | 'lost' | 'push' | 'void' | undefined;
      claimableAmount?: string | undefined;
      /** `isTerminalForever` over the deriving join. Absent ⇒ assumed live. */
      terminal?: boolean | undefined;
    }>,
  ): void {
    const state = this.pollers.get(address.toLowerCase());
    if (!state) return;
    for (const e of entries) {
      state.statusCache.set(e.key, {
        status: e.status,
        sourceUpdatedAt: e.sourceUpdatedAt,
        result: e.result,
        claimableAmount: e.claimableAmount,
        // NOT derivable from `e.status` alone — `settledLost` retires only on a
        // CLOSED speculation — so it is the deriving read's answer or nothing.
        // A caller that omits it gets the old behaviour: live until the first
        // tick reads the speculation row and retires it.
        frozen: e.terminal ?? false,
      });
    }
  }

  /**
   * Idempotently start the per-wallet poll timer for `sub`'s wallet.
   * Called by the handler AFTER catch-up / snapshot seeding completes and
   * BEFORE `ready` is emitted. Subsequent calls on the same wallet
   * (multi-subscriber case) are no-ops.
   */
  beginLive(sub: OwnStateSubscriber): void {
    const state = this.pollers.get(sub.address);
    if (!state || state.timer !== null) return;
    const addr = sub.address;
    state.timer = setInterval(() => {
      void this.pollWallet(addr);
    }, this.deps.pollMs);
    state.timer.unref?.();
  }

  /** Poll all 3 resources for `address`. Public for tests. */
  async pollWallet(address: string): Promise<void> {
    const state = this.pollers.get(address);
    if (!state || state.polling) return;
    state.polling = true;
    try {
      // Sequential per resource keeps query bursts small (most maker wallets
      // have few rows changing per tick); per-tick parallelism saves at most
      // a handful of ms on the median tick at the cost of read-burst spikes.
      await this.pollCommitments(address, state);
      await this.pollFills(address, state);
      // positionStatus is a derived event over (positions, speculations,
      // contests). Forward-scan on positions.row_updated_at alone would miss
      // every speculation/contest-driven transition (parent settles,
      // contest scores) since those don't bump the position row. Instead,
      // re-derive the full join every tick and emit on derived-status
      // change. See `reDerivePositionStatuses` for the dedup contract.
      await this.reDerivePositionStatuses(address, state);
      this.evict(state.commitments);
      this.evict(state.fills);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), address },
        'ownStateHub: tick failed',
      );
    } finally {
      state.polling = false;
    }
  }

  // ── per-resource poll: forward drain then overlap rescan ──────────────

  private async pollCommitments(address: string, state: WalletPoller): Promise<void> {
    const resState = state.commitments;
    const forward = await this.scanCommitments(
      address,
      resState,
      resState.tip,
      null,
      this.deps.maxForwardPages,
      state.subs,
    );
    resState.tip = forward.tip;
    const tipMs = Date.parse(resState.tip.s);
    if (!Number.isFinite(tipMs)) return;
    const floorIso = new Date(Math.max(0, tipMs - this.deps.overlapMs)).toISOString();
    const overlap = await this.scanCommitments(
      address,
      resState,
      { s: floorIso, i: '0' },
      resState.tip.s,
      this.deps.maxOverlapPages,
      state.subs,
    );
    if (!overlap.exhausted) {
      logger.warn({ address }, 'ownStateHub commitments: overlap window exceeded budget — resync');
      this.resyncWallet(state, 'overlap_window_too_large');
    }
  }

  private async pollFills(address: string, state: WalletPoller): Promise<void> {
    const resState = state.fills;
    const forward = await this.scanFills(
      address,
      resState,
      resState.tip,
      null,
      this.deps.maxForwardPages,
      state.subs,
    );
    resState.tip = forward.tip;
    const tipMs = Date.parse(resState.tip.s);
    if (!Number.isFinite(tipMs)) return;
    const floorIso = new Date(Math.max(0, tipMs - this.deps.overlapMs)).toISOString();
    const overlap = await this.scanFills(
      address,
      resState,
      { s: floorIso, i: '0' },
      resState.tip.s,
      this.deps.maxOverlapPages,
      state.subs,
    );
    if (!overlap.exhausted) {
      logger.warn({ address }, 'ownStateHub fills: overlap window exceeded budget — resync');
      this.resyncWallet(state, 'overlap_window_too_large');
    }
  }

  /**
   * WHY DISCOVERY IS A CURSOR AND NOT A WINDOW (`#97`).
   *
   * Phase A used to be `row_updated_at DESC LIMIT 200` — the 200 most recently
   * touched actionable rows — on the argument that a new or re-touched position
   * carries `row_updated_at = now` and therefore enters at the HEAD of the window.
   * That argument is true at the WRITE and false at the READ, which is the whole
   * defect: let one position arrive, then let 200 already-known positions take
   * newer timestamps before the next tick, and the new row is below the window's
   * floor. Phase A cannot see it and phase B never asks, because phase B is keyed
   * on what the cache already holds. The maintainer's reviewer reproduced it end
   * to end from 199 rows — inside the old cap, so it needed no future feature.
   *
   * A top-N window ordered by a MUTABLE key can be displaced. A keyset CURSOR over
   * the same key cannot, and the difference is the sort direction: ascending from a
   * watermark, a row that arrived earlier is read FIRST and a page limit cuts the
   * NEWEST rows, which the next tick then reads. So this hub already had the right
   * mechanism — `scanCommitments` and `scanFills` drain `(row_updated_at, id)`
   * ascending from a tip with an overlap re-scan — and positions were the one
   * resource given a window instead. `.claude/rules/core-api-streaming.md`'s
   * meta-rule is the reason this is a restructure rather than a fourth patch: past
   * ~3 rounds in one area, implement the explicit model.
   *
   * ## The proof, and what it assumes
   *
   * **Every actionable row is either in `statusCache` or above the positions tip.**
   * Inductively: the handler's seed puts the whole actionable population in the
   * cache at connect (when its read was not truncated — see below); the tip starts
   * at subscribe time, which is BEFORE that read; and any later write that puts a
   * row into the actionable set — an insert, a claim reversal, a stake transfer
   * back in — sets `row_updated_at = now()` through
   * `trg_positions_row_updated_at` (`update_row_updated_at`, BEFORE UPDATE FOR EACH
   * ROW, plus the column's `DEFAULT now()` on INSERT), so it lands above the tip
   * and the next drain reads it. The tip advances only over rows that were
   * DERIVED — not merely read — so nothing downstream of the drain can skip one
   * either. An earlier version of this said "actually read", and that word was the
   * defect: the maintenance page and both parent joins run after the drain, and a
   * failure in any of them left the drained rows uncached with the cursor already
   * past them. See the acknowledgement note in `reDerivePositionStatuses`.
   *
   * Three assumptions, stated because each one is a way this can be wrong:
   *
   *   1. **`now()` is TRANSACTION START**, so a writer whose transaction opened
   *      before the tip and committed after it lands a row below the tip. That is
   *      what the overlap re-scan is for, and 30s (`overlapMs`, mirroring
   *      `RECOVERY_OVERLAP_MS`) is the same bound the other two resources already
   *      accept. A positions write held open longer than that is outside it.
   *   2. **The cache is only as complete as the seed.** `positionsTruncated` is
   *      exactly the flag the snapshot raises when its actionable read hit its cap
   *      (`positionsHitCap` in `snapshot.ts`), and the handler emits `degraded`
   *      for it before `ready`. So "the subscriber's book is incomplete" is
   *      already on the wire whenever it is true; the hub does not need its own
   *      copy of that signal, and does not have one. What the hub still reports is
   *      the limit only it can see: phase B's per-tick budget.
   *   3. **Frozen keys are never re-read.** `isTerminalForever` (`#83`) is what
   *      licenses that, and it is unchanged here.
   *
   * ## Per-tick cost (`.claude/rules/production-cost-review.md`)
   *
   * Measured against production through a counting proxy, wallet
   * `0x5316fa54…` (the market maker's own maker wallet, 1,215 rows / 621
   * actionable / 51 non-frozen), 2026-09-23:
   *
   *   - BEFORE: 7 statements, **489 rows** per tick — 200 positions + 181
   *     speculations + 108 contests — identical on every tick, for ever. At
   *     `pollMs = 1_500` that is 1.17M rows/hour for one wallet, and the number
   *     grows with the wallet's distinct parents while its COVERAGE shrinks as
   *     history grows.
   *   - AFTER: the drain reads the rows written since the last tick. Measured
   *     write rate for the busiest wallet is **max 4 rows per 1.5s and 7 per
   *     30s** (largest identical-`row_updated_at` group in the whole table: 2), so
   *     the steady-state drain is 0 rows and the spec/contest joins shrink from
   *     200 parents to the non-frozen work-list.
   *
   * The drain cannot read more than the wallet's actionable population in one
   * tick — a row appears at most once per scan — so its worst case equals the old
   * design's every case. What remains linear in anything is phase B, and it is
   * linear in UNRESOLVED EXPOSURE (51 of 621 rows here, 12%), not in history.
   *
   * ## The PLAN, and how it scales (PostgreSQL 16, local, `EXPLAIN ANALYZE`)
   *
   * PostgREST refuses `EXPLAIN` (HTTP 406 `PGRST107`, verified for both
   * service_role and anon), so this was measured against a throwaway Postgres
   * carrying the table's five real indexes and a fixture of the same SHAPE — eight
   * wallets, ~49% claimed, `row_updated_at` spread over months — at two history
   * sizes. Buffers, because that is the unit that does not depend on cache warmth:
   *
   *                                    4,000 rows      400,000 rows
   *   this drain (tip 30s back)             9 buf            64 buf
   *   the `DESC LIMIT 200` window          69 buf        25,760 buf
   *
   * The drain is served by `idx_positions_network_row_updated_id` — the
   * `(network, row_updated_at, id)` index `ospex-indexer` migration 048 created
   * for exactly this query shape — at both sizes, so its cost tracks CHURN INSIDE
   * THE WINDOW rather than history. The window it replaces is the one that grows:
   * at 400k rows the planner walks that same index BACKWARD and discards 25,199
   * rows to find 200, because no index carries
   * `(network, user_address, row_updated_at)`. So the read this change removes is
   * the one that was linear in total history, which is the question
   * `production-cost-review.md` exists to ask.
   */
  private async scanPositionRows(
    address: string,
    state: WalletPoller,
  ): Promise<{ rows: PositionDerivationRow[]; tip: Tip } | null> {
    const sb = this.deps.getClient();
    const net = this.deps.getNetwork();
    const tip = state.positionsTip;
    const tipMs = Date.parse(tip.s);
    // The lower bound is the tip less the overlap, and it is a TIME floor: the
    // `id.gt.0` half admits EVERY row stamped at exactly that instant, which a
    // strict tuple comparison would not. That matters here and not in theory —
    // `rpc_position_matched_pair` stamps the maker row and the taker row with one
    // `now()`, so same-timestamp pairs are the normal case and a tie can straddle
    // a tuple cursor.
    const start: Tip = Number.isFinite(tipMs)
      ? { s: new Date(Math.max(0, tipMs - this.deps.overlapMs)).toISOString(), i: '0' }
      : tip;
    const rows: PositionDerivationRow[] = [];
    let cmp = start;
    let exhausted = false;
    for (let page = 0; page < this.deps.maxForwardPages; page += 1) {
      const { data, error } = await sb
        .from('positions')
        .select(POSITION_DERIVATION_COLUMNS)
        .eq('network', net)
        .eq('user_address', address)
        .eq('claimed', false)
        .gt('risk_amount', 0)
        .or(`row_updated_at.gt.${cmp.s},and(row_updated_at.eq.${cmp.s},id.gt.${cmp.i})`)
        .order('row_updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(this.deps.pollLimit);
      if (error) {
        logger.error(
          { err: error.message, address },
          'ownStateHub positionStatus: discovery drain failed',
        );
        // Tip unmoved, so the next tick asks the same question. A failed read
        // must not look like an empty one — returning `[]` here would let the
        // derivation treat every cached key as stale and re-fetch the lot.
        return null;
      }
      const got = (data ?? []) as unknown as PositionDerivationRow[];
      for (const row of got) {
        rows.push(row);
        cmp = { s: row.row_updated_at, i: String(row.id) };
      }
      if (got.length < this.deps.pollLimit) {
        exhausted = true;
        break;
      }
    }
    // DELIBERATELY does not write `state.positionsTip`. The caller commits it, and
    // only after the rows have been DERIVED — see `reDerivePositionStatuses`.
    if (afterTip(cmp, tip)) {
      if (!exhausted) {
        // Forward progress was made and there is more above it; the next tick
        // continues from here. Not saturation and not a wire event: nothing is
        // skipped, the view is momentarily behind. Worth a line because the
        // budget is `maxForwardPages × pollLimit` rows in one tick against a
        // measured peak of 4 rows per tick.
        logger.warn(
          { address, rows: rows.length },
          'ownStateHub positionStatus: discovery drain filled its page budget',
        );
      }
    } else if (!exhausted) {
      // The overlap window alone outran the page budget, so the tip cannot
      // advance and the next tick would re-read the same prefix for ever. Same
      // condition and same answer as `pollCommitments` / `pollFills`.
      logger.warn(
        { address },
        'ownStateHub positionStatus: overlap window exceeded budget — resync',
      );
      this.resyncWallet(state, 'overlap_window_too_large');
    }
    // The tip the caller may commit, already made monotone here so there is ONE
    // place that decides it. A quiet tick returns the tip unchanged rather than
    // the floor, which is what stops a tick that read nothing from walking the
    // cursor backwards by one overlap every time.
    return { rows, tip: afterTip(cmp, tip) ? cmp : tip };
  }

  /**
   * Re-derive `positionStatus` for every tracked wallet position and emit on
   * change. Mirrors `loadOwnStateSnapshot`'s join (positions →
   * speculations → contests) so the stream and snapshot agree on derived
   * state.
   *
   * ## What this owes, stated (`#83`)
   *
   * **Every position whose derived status can still change is re-derived every
   * tick; a position that is provably finished may be retired; and when the
   * derivation cannot honour the first clause it says so on the wire.**
   *
   * The two phases divide that work by the question they answer, not by table:
   *
   *   - **Phase A — discovery.** `claimed=false AND risk_amount>0` (the
   *     actionable set, the same filter `fetchCategorizedPositions` uses),
   *     drained as an ASCENDING KEYSET CURSOR over `(row_updated_at, id)` from
   *     {@link WalletPoller.positionsTip} less the overlap. Finds every position
   *     that entered the actionable set since the last tick, and cannot be
   *     displaced by churn on other rows the way the `DESC LIMIT 200` window it
   *     replaces could — see `scanPositionRows` for the proof and its
   *     assumptions (`#97`).
   *   - **Phase B — maintenance.** Every cached key that is NOT frozen and NOT
   *     in phase A's result, re-fetched BY IDENTITY in ordered chunks. These are
   *     rows the subscriber holds in its book, including ones that have just
   *     left the actionable filter (`claimed` flipped, stake transferred out) —
   *     their terminal status is emitted before the entry falls out of tracking.
   *
   * The division is exhaustive in one direction and not the other, and saying
   * which is the whole calibration: phase A covers ENTRIES into the actionable
   * set, because entering it requires a write to the positions row itself (the
   * predicate is entirely on positions columns) and every such write is stamped.
   * It cannot report an EXIT — a claimed row leaves the filter and later scans
   * skip it — and it cannot report a parent-driven transition, because a
   * settling speculation does not touch the position row. Both of those belong
   * to rows the cache already holds, which is exactly phase B's work-list. So
   * "discovery is complete" is a claim about entries, and phase B plus the freeze
   * predicate is load-bearing for everything else.
   *
   * Saturating PHASE B is `onDegraded('positionsTruncated')`, once per poller. It
   * is not a resync: the view stays ordered and keeps delivering, and reconnecting
   * would not widen it. Phase A no longer has a saturation condition — a cursor
   * has no population cap — and the signal it used to raise is not lost: the
   * snapshot leg raises `positionsTruncated` for the same wallets from its own
   * capped read, which is where the subscriber's book is actually incomplete.
   *
   * ## Per-tick cost, and what bounds it
   *
   * Three statements on a quiet tick: the phase-A drain (one page, usually zero
   * rows), one speculations `IN` list and one contests `IN` list — plus one per
   * phase-B chunk when the work-list is non-empty, and one extra drain page per
   * `pollLimit` rows of churn.
   *
   * Phase A is proportional to CHURN SINCE THE LAST TICK, bounded above by the
   * wallet's actionable population (a row can appear at most once per scan).
   * Phase B is linear in the wallet's NON-FROZEN cached keys, and that is the
   * number this design controls: without the freeze it would be linear in
   * unclaimed history, which only grows — the oldest unclaimed row on polygon is
   * from 2026-06-29 and nothing will ever claim a loser.
   *
   * Measured on polygon 2026-09-23. 3,973 positions rows over eight wallets;
   * 1,790 of 1,955 actionable rows are `isTerminalForever` (92%), so the live
   * work-list is 0–51 keys against 31–621 actionable, and the worst wallet sits
   * at 51 of the 400-key phase-B budget — 8× headroom. Per-tick churn for the
   * busiest wallet peaks at 4 rows per 1.5s and 7 per 30s, and the largest group
   * of positions rows sharing one `row_updated_at` in the whole table is 2.
   *
   * Measured against production through a counting proxy — the real cold-start
   * snapshot and the real `pollWallet`, wallet `0x5316fa54…` (1,215 rows, 621
   * actionable, 51 live), three ticks each, 2026-09-23:
   *
   *   BEFORE  7 statements, 489 rows/tick  (200 positions + 181 specs + 108
   *           contests), identical on every tick for ever — 1.17M rows/hour at
   *           `pollMs = 1_500` — and `degraded: positionsTruncated` on tick 1.
   *   AFTER   8 statements,  86 rows/tick  (0 drain + 44 phase B + 28 specs + 14
   *           contests), no degraded, saturation counter 0.
   *
   * One statement MORE and 82% of the rows GONE: phase B now issues the page it
   * used to get for free from the window, and the two `IN` lists shrink with the
   * work-list because they are built from what the two phases actually returned.
   * Upstream time is flat (526–573ms against 569ms) because it is round-trip
   * bound and the drain's own read got cheaper as it stopped returning rows.
   *
   * What this does NOT buy is a complete view for a wallet whose SEED was capped:
   * the 421 rows that wallet's truncated snapshot omitted are `#76`'s to deliver,
   * and until it lands the snapshot still reports `positionsTruncated` and the
   * hub still cannot maintain a key it was never told about.
   *
   * One delivery DOES go away, measured on the same wallet: the old window's first
   * tick emitted 5 `positionStatus` events for keys the snapshot never sent,
   * because the window orders by `row_updated_at` and the snapshot by
   * `position_created_at`, and a day of settlement churn had moved 5 of the 200.
   * The drain emits 0. Those 5 were 5 of the 421 rows that wallet's snapshot
   * omitted, arriving by accident rather than by enumeration; the enumeration is
   * `#76`'s.
   *
   * Emit contract: handler seeds the cache before `beginLive`, so on the
   * first tick the cache reflects the catch-up's view of derived state.
   * A derived-status difference emits a `positionStatus` event — during
   * preReady this trips the handler's abort signal (which is the desired
   * behavior; the catch-up's view was stale). During live phase the SDK
   * sees the transition.
   */
  private async reDerivePositionStatuses(
    address: string,
    state: WalletPoller,
  ): Promise<void> {
    // Phase A — DISCOVERY, as a keyset drain. Same filter as the snapshot's
    // `fetchCategorizedPositions`, so the two cover the same population; the
    // snapshot enumerates it and this reads the delta.
    const discovery = await this.scanPositionRows(address, state);
    if (discovery === null) return; // read failed; logged, tip unmoved, retry next tick

    // THE CURSOR IS ACKNOWLEDGED BY THE WORK, NOT BY THE READ.
    //
    // An earlier version of this advanced `positionsTip` inside the scan, the
    // moment the rows came back. Reading is not processing: the maintenance page
    // and the two parent joins all happen AFTER the drain and all of them can
    // fail, and on that path the drained rows have neither been emitted nor
    // entered `statusCache` — so maintenance cannot recover them either, because
    // maintenance is keyed on what the cache already holds. The reviewer
    // reproduced it end to end through the real snapshot helper, handler and hub:
    // a position arriving during a transient join outage was never delivered,
    // the connection stayed open, and no `degraded`, `resync` or error frame was
    // written. Once its stamp fell outside the overlap it was unreachable.
    //
    // This is `3f-latch` one level out — "a once-only latch must be taken by the
    // ACTION, never by the notification" — and a cursor is exactly that latch: a
    // claim-check the reader takes on behalf of an actor that may never run. The
    // sibling scans do not have the hole because they EMIT as they read, so their
    // action precedes their acknowledgement by construction; this one has to split
    // read from act, because the derivation needs the parent joins first.
    //
    // So the tip moves only when every drained row has been DERIVED into the
    // cache. A tick that fails re-reads the same rows next time, which costs
    // nothing: the status cache makes the re-derivation a no-op.
    if (await this.derivePositionDelta(address, state, discovery.rows)) {
      state.positionsTip = discovery.tip;
    }
  }

  /**
   * Derive and emit over the drained delta plus the maintenance work-list.
   *
   * Returns **true only when every discovered row reached `statusCache`**, which
   * is what licenses the caller to advance the discovery cursor past them. Every
   * early exit here is a row that was read and not processed.
   */
  private async derivePositionDelta(
    address: string,
    state: WalletPoller,
    discovered: PositionDerivationRow[],
  ): Promise<boolean> {
    const sb = this.deps.getClient();
    const net = this.deps.getNetwork();
    // Phase B — MAINTENANCE of cached keys that are NOT in phase A's result.
    // These are positions the subscriber already holds whose status may have
    // transitioned (just claimed; stake just transferred out), so their current
    // row is re-fetched by identity and the resulting terminal status is emitted
    // before the cache entry falls out of tracking.
    //
    // Frozen entries are skipped: `isTerminalForever` has already proved they
    // cannot transition, and a row that gets touched is drained by phase A
    // anyway. That skip is what keeps this phase proportional to unresolved
    // exposure rather than to unclaimed history — and with phase A now a delta
    // rather than a 200-row window, this phase carries the WHOLE live work-list
    // instead of whatever the window happened to leave over. That is the number
    // to watch: measured 0–51 keys per wallet against a 400-key budget.
    //
    // Ordered and chunked, where it used to be one unordered `IN` list under a
    // single 200-row limit. Two defects in that: with more than 200 matching
    // rows PostgREST returned an UNSPECIFIED subset, so which cached positions
    // stopped being maintained was not merely arbitrary but free to differ
    // between ticks; and nothing reported the short read. Sorting the ids makes
    // the covered prefix deterministic, and exhausting the page budget is
    // saturation.
    const discoveredKeys = new Set(
      discovered.map(
        (p) =>
          `${String(p.speculation_id)}_${p.position_type === 'upper' ? 0 : 1}`,
      ),
    );
    // DISTINCT speculation ids, because the work-list is keyed per POSITION and
    // the read is keyed per SPECULATION: a wallet holding both sides of one
    // speculation contributes two keys and one `IN` value. Listing it twice costs
    // a chunk slot and, worse, doubles that chunk's `legalMax` — the sentinel
    // bound below is `2 × chunk.length`, so a duplicated id would raise the bar
    // the illegal row has to clear and blunt the only check that can prove the
    // uniqueness assumption wrong. Phase A used to hide this by returning both
    // rows, which kept both keys out of the work-list entirely.
    const staleSpecIdSet = new Set<number>();
    for (const [key, entry] of state.statusCache) {
      if (entry.frozen) continue;
      if (discoveredKeys.has(key)) continue;
      const specPart = key.slice(0, key.lastIndexOf('_'));
      const id = Number(specPart);
      if (Number.isFinite(id)) staleSpecIdSet.add(id);
    }
    // Ascending so the prefix a budget-limited tick covers is specified.
    const staleCachedSpecIds = [...staleSpecIdSet].sort((a, b) => a - b);
    const staleBudget = STALE_REFRESH_CHUNK * STALE_REFRESH_MAX_PAGES;
    const staleSaturated = staleCachedSpecIds.length > staleBudget;
    let staleRows: PositionDerivationRow[] = [];
    for (let off = 0; off < Math.min(staleCachedSpecIds.length, staleBudget); off += STALE_REFRESH_CHUNK) {
      const chunk = staleCachedSpecIds.slice(off, off + STALE_REFRESH_CHUNK);
      // One MORE than can legally exist. `(network, speculation_id,
      // user_address, position_type)` is unique, so a chunk of N speculations
      // holds at most 2N rows for one wallet — and asking for exactly 2N then
      // treating 2N as overflow condemns the legal maximum. That was a review
      // blocker: one closed push with the upper side claimable and the lower
      // side just claimed returns both rows, nothing omitted, and the old bound
      // called it truncation and could have put the market maker on quote hold.
      // The sentinel row is the standard fix — ask for one that cannot exist,
      // and getting it is the only proof the uniqueness assumption is wrong.
      const legalMax = chunk.length * 2;
      const pageLimit = legalMax + 1;
      const staleRes = await sb
        .from('positions')
        .select(POSITION_DERIVATION_COLUMNS)
        .eq('network', net)
        .eq('user_address', address)
        .in('speculation_id', chunk)
        .order('id', { ascending: true })
        .limit(pageLimit);
      if (staleRes.error) {
        logger.error(
          { err: staleRes.error.message, address },
          'ownStateHub positionStatus: cached-key refresh query failed',
        );
        return false;
      }
      const page = (staleRes.data ?? []) as unknown as PositionDerivationRow[];
      if (page.length > legalMax) {
        // Only reachable if the uniqueness assumption above is wrong. The page
        // is then a truncation rather than a complete chunk, so it is saturation
        // and not just a log line.
        logger.warn(
          { address, chunk: chunk.length, rows: page.length },
          'ownStateHub positionStatus: cached-key chunk filled its row limit',
        );
        this.signalSaturation(address, state, 'stale_chunk_full', {
          discovered: discovered.length,
          staleKeys: staleCachedSpecIds.length,
        });
      }
      staleRows = staleRows.concat(page);
    }
    if (staleSaturated) {
      this.signalSaturation(
        address,
        state,
        'stale_budget',
        { discovered: discovered.length, staleKeys: staleCachedSpecIds.length },
      );
    }
    // Dedupe across the two queries by (speculation_id, position_type).
    const positionsByKey = new Map<string, PositionDerivationRow>();
    for (const row of [...discovered, ...staleRows]) {
      const key = `${String(row.speculation_id)}_${row.position_type === 'upper' ? 0 : 1}`;
      // Drained rows come first; keep their data over the stale refresh (they
      // are the same row from two queries, and the drain's filters are the
      // stricter pair).
      if (!positionsByKey.has(key)) positionsByKey.set(key, row);
    }
    const positions = [...positionsByKey.values()];
    if (positions.length === 0) {
      // No actionable rows and no cached keys to refresh — wallet is empty
      // or fully terminal. Nothing to emit, and nothing was read either: this is
      // only reachable when the drain returned zero rows, so the tip the caller
      // then commits is the one it already had.
      return true;
    }
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
          'ownStateHub positionStatus: speculations join failed',
        );
        return false;
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
          'ownStateHub positionStatus: contests join failed',
        );
        return false;
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

    // Two-phase emission. Phase 1: derive every row, collect rows whose
    // derived (status, sourceUpdatedAt, result, claimableAmount) differs
    // from the cached entry. Phase 2: SORT collected emissions by
    // (sourceUpdatedAt, idBig) ASC, then iterate emit + cache.set.
    //
    // The sort is load-bearing for no-loss reconnect: positions are
    // queried in `positions.row_updated_at DESC` order but
    // `sourceUpdatedAt = max(pos, spec, contest)` can reorder. Emitting
    // a later-source row first and dropping the connection before the
    // earlier-source row means the subscriber's cursor.p advances past
    // the earlier row, and reconnect catch-up filters it out as
    // "already covered" — silently losing the event.
    interface PendingEmission {
      key: string;
      body: PositionStatusEventBody;
      sourceUpdatedAt: string;
      id: string;
      idBig: bigint;
      nextCacheEntry: StatusCacheEntry;
    }
    const emissions: PendingEmission[] = [];
    let unresolved = 0;

    for (const row of positions) {
      const spec = specsById.get(Number(row.speculation_id));
      if (!spec) {
        // Counted rather than merely skipped: a row that was READ and never
        // DERIVED holds the discovery cursor — see the note at the end of this
        // method. Only a DISCOVERED row holds it, though. A maintenance row that
        // does not resolve is re-fetched from the cache on the next tick anyway,
        // and letting it hold the cursor would give a maintenance-side anomaly the
        // power to stall discovery, which is a worse failure than the one this
        // guard exists for.
        if (
          discoveredKeys.has(
            `${String(row.speculation_id)}_${row.position_type === 'upper' ? 0 : 1}`,
          )
        ) {
          unresolved += 1;
        }
        continue;
      }
      const contest = spec.contest_id != null ? contestsById.get(spec.contest_id) ?? null : null;
      const positionType: 0 | 1 = row.position_type === 'upper' ? 0 : 1;
      const sourceUpdatedAt = maxIsoTimestamptz(
        row.row_updated_at,
        spec.row_updated_at,
        contest?.row_updated_at,
      );
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
      const key = `${String(row.speculation_id)}_${positionType}`;
      const prior = state.statusCache.get(key);
      // Retire the key from phase B's work-list when the derivation proves no
      // further transition is reachable. Computed for EVERY derived row, not
      // only the emitting ones: a seeded entry arrives `frozen: false` and a
      // settled loser is precisely the row that never emits again, so deciding
      // this inside the emission loop would leave it live forever.
      const frozen = isTerminalForever(body.status, {
        speculationStatus: spec.speculation_status,
        winSide: spec.win_side,
      });
      const nextCacheEntry: StatusCacheEntry = {
        status: body.status,
        sourceUpdatedAt,
        result: body.result,
        claimableAmount: body.claimableAmount,
        frozen,
      };
      // Dedup contract: we emit when ANY semantic field differs from the
      // seeded/cached entry. The SDK reducer's dedup key is
      // (addr, specId, positionType, status, sourceUpdatedAt); we
      // additionally compare `result` and `claimableAmount` so a same-
      // status payload-only change (e.g. a contest score correction
      // flipping pendingSettle's predicted result from `won` to `push`,
      // or changing the claimable amount) still surfaces. A previously-
      // unseen key (prior === undefined) also emits — the handler is
      // responsible for seeding every position it discovered, so an
      // unseen key means a genuinely new position OR a tick that raced
      // the handoff (the preReady abort path then catches it).
      if (
        prior &&
        prior.status === body.status &&
        prior.sourceUpdatedAt === sourceUpdatedAt &&
        prior.result === body.result &&
        prior.claimableAmount === body.claimableAmount
      ) {
        // No event, but the retirement still has to land — this is the only
        // path a settled loser ever takes after its first derivation.
        if (frozen && !prior.frozen) state.statusCache.set(key, { ...prior, frozen: true });
        continue;
      }
      let idBig: bigint;
      try {
        idBig = BigInt(String(row.id));
      } catch {
        idBig = 0n;
      }
      emissions.push({
        key,
        body,
        sourceUpdatedAt,
        id: String(row.id),
        idBig,
        nextCacheEntry,
      });
    }

    // Sort by (sourceUpdatedAt, idBig) ASC. Microsecond-aware via
    // `compareIsoTimestamptz` — Date.parse would collapse same-ms parent
    // transitions and break the monotonic-cursor guarantee.
    emissions.sort((a, b) => {
      const byTs = compareIsoTimestamptz(a.sourceUpdatedAt, b.sourceUpdatedAt);
      if (byTs !== 0) return byTs;
      if (a.idBig === b.idBig) return 0;
      return a.idBig < b.idBig ? -1 : 1;
    });

    for (const e of emissions) {
      state.statusCache.set(e.key, e.nextCacheEntry);
      for (const sub of state.subs) {
        try {
          sub.onPositionStatus(e.body, e.sourceUpdatedAt, e.id);
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), address },
            'ownStateHub positionStatus: onPositionStatus threw',
          );
        }
      }
    }
    // An UNRESOLVED row is a row that was read and not processed, so it holds the
    // cursor exactly as a failed read does. The only way to reach this while
    // `fk_position_speculation` holds — `(network, speculation_id)` REFERENCES
    // `speculations`, so a positions row cannot outlive its parent — is a parent
    // join that came back SHORT rather than failing, which is indistinguishable
    // from an orphan at this layer and is equally a reason to retry. The FK is
    // also what stops this from stalling: the parent exists, so the next tick
    // resolves it.
    if (unresolved > 0) {
      logger.warn(
        { address, unresolved, discovered: discovered.length },
        'ownStateHub positionStatus: discovered rows could not be joined to a speculation — holding the cursor',
      );
      return false;
    }
    return true;
  }

  // ── per-resource scans ────────────────────────────────────────────────

  private async scanCommitments(
    address: string,
    res: ResourceTipState,
    start: Tip,
    upperTs: string | null,
    maxPages: number,
    subs: Set<OwnStateSubscriber>,
  ): Promise<ScanResult> {
    const nowMs = Date.now();
    let cmp = start;
    for (let page = 0; page < maxPages; page += 1) {
      let q = this.deps
        .getClient()
        .from('commitments')
        .select(COMMITMENT_RECOVERY_COLUMNS)
        .eq('network', this.deps.getNetwork())
        .eq('maker', address)
        .or(`row_updated_at.gt.${cmp.s},and(row_updated_at.eq.${cmp.s},id.gt.${cmp.i})`);
      if (upperTs !== null) q = q.lte('row_updated_at', upperTs);
      const { data, error } = await q
        .order('row_updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(this.deps.pollLimit);
      if (error) {
        logger.error({ err: error.message, address }, 'ownStateHub commitments: query failed');
        return { tip: cmp, exhausted: true };
      }
      const rows = (data ?? []) as unknown as CommitmentRecoveryRow[];
      let enrichment;
      try {
        enrichment = await fetchCommitmentEnrichment(
          this.deps.getClient(),
          this.deps.getNetwork(),
          rows,
        );
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), address },
          'ownStateHub commitments: enrichment failed',
        );
        return { tip: cmp, exhausted: true };
      }
      for (const row of rows) {
        const key = `${row.row_updated_at}|${String(row.id)}`;
        if (res.emitted.has(key)) {
          cmp = { s: row.row_updated_at, i: String(row.id) };
          continue;
        }
        const tsMs = Date.parse(row.row_updated_at);
        res.emitted.set(key, Number.isFinite(tsMs) ? tsMs : Date.now());
        const body = toOwnerCommitmentBody(row, nowMs, enrichment);
        for (const sub of subs) {
          try {
            sub.onCommitment(body, row.row_updated_at, String(row.id));
          } catch (err) {
            logger.error(
              { err: err instanceof Error ? err.message : String(err), address },
              'ownStateHub commitments: onCommitment threw',
            );
          }
        }
        cmp = { s: row.row_updated_at, i: String(row.id) };
      }
      if (rows.length < this.deps.pollLimit) return { tip: cmp, exhausted: true };
    }
    return { tip: cmp, exhausted: false };
  }

  private async scanFills(
    address: string,
    res: ResourceTipState,
    start: Tip,
    upperTs: string | null,
    maxPages: number,
    subs: Set<OwnStateSubscriber>,
  ): Promise<ScanResult> {
    let cmp = start;
    for (let page = 0; page < maxPages; page += 1) {
      // The wallet appears as EITHER maker_address or taker_address; the
      // outer .or() composes the keyset filter AND the maker/taker filter
      // into one PostgREST `or=(...)` expression — supabase-js doesn't
      // chain two `.or()` calls (the second clobbers the first). We
      // collapse to one `or=(...)` containing every legal combination of
      // (keyset, side) using `and(...)` nesting.
      const keyset = `row_updated_at.gt.${cmp.s},and(row_updated_at.eq.${cmp.s},id.gt.${cmp.i})`;
      const sidedKeyset =
        `and(maker_address.eq.${address},or(${keyset}))` +
        `,and(taker_address.eq.${address},or(${keyset}))`;
      let q = this.deps
        .getClient()
        .from('position_fills')
        .select(FILL_COLUMNS)
        .eq('network', this.deps.getNetwork())
        .or(sidedKeyset);
      if (upperTs !== null) q = q.lte('row_updated_at', upperTs);
      const { data, error } = await q
        .order('row_updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(this.deps.pollLimit);
      if (error) {
        logger.error({ err: error.message, address }, 'ownStateHub fills: query failed');
        return { tip: cmp, exhausted: true };
      }
      const rows = (data ?? []) as unknown as FillRow[];
      for (const row of rows) {
        const key = `${row.row_updated_at}|${String(row.id)}`;
        if (res.emitted.has(key)) {
          cmp = { s: row.row_updated_at, i: String(row.id) };
          continue;
        }
        const tsMs = Date.parse(row.row_updated_at);
        res.emitted.set(key, Number.isFinite(tsMs) ? tsMs : Date.now());
        const body = fillRowToBody(row);
        for (const sub of subs) {
          try {
            sub.onFill(body, row.row_updated_at, String(row.id));
          } catch (err) {
            logger.error(
              { err: err instanceof Error ? err.message : String(err), address },
              'ownStateHub fills: onFill threw',
            );
          }
        }
        cmp = { s: row.row_updated_at, i: String(row.id) };
      }
      if (rows.length < this.deps.pollLimit) return { tip: cmp, exhausted: true };
    }
    return { tip: cmp, exhausted: false };
  }

  private evict(res: ResourceTipState): void {
    const tipMs = Date.parse(res.tip.s);
    if (!Number.isFinite(tipMs)) return;
    const cutoff = tipMs - this.deps.overlapMs * 2;
    for (const [key, tsMs] of res.emitted) {
      if (tsMs < cutoff) res.emitted.delete(key);
    }
  }

  private resyncWallet(state: WalletPoller, reason: string): void {
    this.resyncBroadcastTotal += 1;
    for (const sub of state.subs) {
      try {
        sub.onResync(reason);
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'ownStateHub resync: onResync threw',
        );
      }
    }
  }

  /**
   * Report that the live derivation could not cover this wallet's population.
   *
   * Three observability channels, deliberately, because they answer to different
   * readers and a wire event alone is not enough for an operator:
   *
   *   - the WIRE, once per poller — `onDegraded('positionsTruncated')`, which the
   *     handler turns into `event: degraded` and the SDK into
   *     `onStatus('degraded')`. It reuses the existing reason string because that
   *     is the only degradation the SDK observes at all; a new event name would
   *     land in its `default: // ignore` branch and be a signal nobody receives;
   *   - the LOG, once per poller, carrying `cause` and the two counts, so the
   *     wallet and the magnitude are recoverable from Heroku logs;
   *   - the METRIC, `stats().positionSaturationTotal`, cumulative across pollers
   *     and readable from `/v1/stream/metrics` without grepping anything.
   *
   * The two kinds of dedup are SEPARATE, and conflating them was a review
   * blocker. The log and the metric are deduped per POLLER, because a saturated
   * wallet saturates on every tick and 2,400 identical log lines an hour is not
   * observability. DELIVERY is deduped per SUBSCRIBER, because the poller
   * outlives the connection that first saturated it: with one latch doing both, a
   * subscriber that connected later — on a snapshot that was complete at the time
   * — was silenced by a signal sent to somebody else, and never learned that the
   * wallet's live work-list had gone back over the budget.
   *
   * A subscriber is marked told only after its callback RETURNS. One that threw
   * has not been told, and the next tick (which will saturate again) retries it —
   * the same rule the handler's own latch had to learn.
   */
  private signalSaturation(
    address: string,
    state: WalletPoller,
    cause: 'stale_budget' | 'stale_chunk_full',
    counts: { discovered: number; staleKeys: number },
  ): void {
    if (!state.saturationSignalled) {
      state.saturationSignalled = true;
      this.positionSaturationTotal += 1;
      logger.warn(
        { address, cause, ...counts, budget: STALE_REFRESH_CHUNK * STALE_REFRESH_MAX_PAGES },
        'ownStateHub positionStatus: derivation saturated — position visibility is partial',
      );
    }
    for (const sub of state.subs) {
      if (state.saturationNotified.has(sub)) continue;
      try {
        sub.onDegraded('positionsTruncated');
        // Marked only AFTER the call returned. A subscriber that threw has not
        // been told, and the next tick — which will saturate again — retries it.
        // The same rule the handler's own latch had to learn: mark it sent when
        // it was actually sent.
        state.saturationNotified.add(sub);
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), address },
          'ownStateHub positionStatus: onDegraded threw',
        );
      }
    }
  }

  private async checkRecentRecovery(sub: OwnStateSubscriber): Promise<void> {
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
        logger.error({ err: error.message }, 'ownStateHub resync: recent-recovery check failed');
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
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'ownStateHub resync: recent-recovery check threw',
      );
    }
  }

  /** Poll recovery_runs; broadcast resync to all wallets on new completions. Public for tests. */
  async pollResync(): Promise<void> {
    if (this.totalSubs === 0 || this.resyncPolling) return;
    this.resyncPolling = true;
    try {
      const net = this.deps.getNetwork();
      const client = this.deps.getClient();
      if (this.resyncCursor === null) {
        const cutoff = new Date(Date.now() - this.deps.resyncGraceMs).toISOString();
        const { data, error } = await client
          .from('recovery_runs')
          .select('completed_at, id')
          .eq('network', net)
          .eq('status', 'complete')
          .lt('completed_at', cutoff)
          .order('completed_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(1);
        if (error) {
          logger.error({ err: error.message }, 'ownStateHub resync: baseline query failed');
          return;
        }
        const top = (data ?? [])[0] as { completed_at: string; id: string | number } | undefined;
        this.resyncCursor = top
          ? { completedAt: top.completed_at, id: BigInt(String(top.id)) }
          : { completedAt: new Date(0).toISOString(), id: 0n };
      }
      const cur = this.resyncCursor;
      const keyset = `completed_at.gt.${cur.completedAt},and(completed_at.eq.${cur.completedAt},id.gt.${cur.id.toString()})`;
      const { data, error } = await client
        .from('recovery_runs')
        .select('completed_at, id, kind')
        .eq('network', net)
        .eq('status', 'complete')
        .or(keyset)
        .order('completed_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(50);
      if (error) {
        logger.error({ err: error.message }, 'ownStateHub resync: poll failed');
        return;
      }
      const rows = (data ?? []) as Array<{
        completed_at: string;
        id: string | number;
        kind: string;
      }>;
      for (const row of rows) this.broadcastResync(String(row.kind));
      const last = rows[rows.length - 1];
      if (last) this.resyncCursor = { completedAt: last.completed_at, id: BigInt(String(last.id)) };
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'ownStateHub resync: tick failed',
      );
    } finally {
      this.resyncPolling = false;
    }
  }

  private broadcastResync(reason: string): void {
    for (const state of this.pollers.values()) {
      this.resyncWallet(state, reason);
    }
  }

  stats(): {
    wallets: number;
    subscribers: number;
    resyncBroadcastTotal: number;
    positionSaturationTotal: number;
  } {
    return {
      wallets: this.pollers.size,
      subscribers: this.totalSubs,
      resyncBroadcastTotal: this.resyncBroadcastTotal,
      positionSaturationTotal: this.positionSaturationTotal,
    };
  }
}

// ── singleton ────────────────────────────────────────────────────────────
let singleton: OwnStateHub | undefined;

export function getOwnStateHub(): OwnStateHub {
  if (!singleton) {
    singleton = new OwnStateHub({
      getClient: () => getSupabase(),
      getNetwork: () => loadConfig().network,
    });
  }
  return singleton;
}

/** Test-only: install an isolated hub (with mock deps) behind getOwnStateHub(). */
export function __setOwnStateHubForTest(hub: OwnStateHub | undefined): void {
  singleton = hub;
}
