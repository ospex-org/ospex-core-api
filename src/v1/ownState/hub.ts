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
 * `positions.row_updated_at`. Every tick the hub runs a capped recency query
 * over the actionable set to DISCOVER positions the subscriber has not been
 * told about, plus a by-id refresh of the tracked keys that are still live and
 * fell outside it. The derivation emits in sorted `(sourceUpdatedAt, id)` ASC
 * order so a mid-tick disconnect cannot leave the subscriber's cursor past an
 * undelivered earlier-source event. The SDK reducer's dedup key
 *   `(address, speculationId, positionType, status, sourceUpdatedAt)`
 * absorbs any over-emission from overlap re-scans.
 *
 * Neither read is unbounded, and neither is silent: saturating either one is
 * `onDegraded('positionsTruncated')`, once per poller, and the handler forwards
 * it as `event: degraded`. The contract those bounds are measured against is
 * stated on `reDerivePositionStatuses` (`#83`) — every position whose derived
 * status can still change is re-derived every tick, a position `positionStatus`
 * has proved finished is retired, and a derivation that cannot honour the first
 * clause says so.
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
   * Last-emitted (status, sourceUpdatedAt) per `${speculationId}_${positionType}`.
   * Seeded by the handler from its catch-up / cold-start derivation BEFORE
   * the timer starts (see `seedStatusCache`). Ticks emit when the
   * re-derived status differs from the cached entry; new keys are emitted
   * as the appearance of a previously-unknown position.
   */
  statusCache: Map<string, StatusCacheEntry>;
  /**
   * Latch for {@link OwnStateCallbacks.onDegraded}. Set the first time this
   * wallet's derivation could not cover its population, and never cleared —
   * a stream does not un-degrade itself, the consumer clears it by
   * reconnecting (which builds a new poller).
   *
   * One-shot because the tick runs every `pollMs` and an over-cap wallet
   * saturates on EVERY tick: an unlatched signal would be 2,400 identical
   * wire events and log lines per hour per wallet.
   */
  saturationSignalled: boolean;
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
 * Per-tick cap on the phase-A discovery query. Same number and same filter as
 * `POSITION_QUERY_LIMIT` in `positionFetch.ts` and `CATCHUP_POSITIONS_LIMIT` in
 * `stream.ts`, so the three reads saturate on the same condition.
 *
 * ## What this bound is FOR, and what it is not
 *
 * Phase A is DISCOVERY: it finds positions the subscriber has not been told
 * about. That is why recency is the right window rather than an arbitrary one —
 * a new or re-touched position carries `row_updated_at = now`, so it enters at
 * the HEAD of the window and cannot be cut by it. Maintenance of positions the
 * subscriber already holds is phase B's job, keyed by identity rather than by
 * recency, and phase B covers its whole non-frozen work-list or says so.
 *
 * Recency is NOT a liveness signal, and the comment this replaces claimed it
 * was ("long-quiet terminal positions naturally fall out of the window without
 * losing future events"). `positions.row_updated_at` does not move when a
 * parent speculation settles or a contest scores — this module's own header
 * says so at the top — so a quiet ACTIVE position sorts to the tail exactly
 * like a settled one. Measured on polygon 2026-09-22: three of eight wallets
 * exceed this cap (633 / 499 / 210 actionable rows), 742 rows fall outside the
 * window in total, and every one of them derives to `settledLost` with 0.00
 * USDC claimable. The window happens to be right because a position can only
 * become terminal AFTER its contest resolves, which is after it was created,
 * and no wallet here creates 200 positions inside one contest's lifetime. That
 * is a property of the data, not of the query: the margin on the worst wallet
 * is 119 rows (its oldest still-transitionable row sits at rank 80 of 200).
 *
 * So the bound stays, and saturation is SIGNALLED rather than silent —
 * `signalSaturation` → `onDegraded('positionsTruncated')`. Raising the number
 * would move the margin without changing the class; making the traversal
 * complete every tick would cost the whole unclaimed history every 1.5s, which
 * is the trade `#76` has to price (see `reDerivePositionStatuses`).
 */
const STATUS_DERIVATION_LIMIT = 200;

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
        statusCache: new Map(),
        saturationSignalled: false,
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
   */
  seedStatusCache(
    address: string,
    entries: Array<{
      key: string;
      status: import('./positionStatus.js').PositionStatus;
      sourceUpdatedAt: string;
      result?: 'won' | 'lost' | 'push' | 'void' | undefined;
      claimableAmount?: string | undefined;
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
        // Deliberately not derived from `e.status` alone: `settledLost` freezes
        // only on a CLOSED speculation and the seed does not carry one. The
        // first tick reads the speculation row and retires it then.
        frozen: false,
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
   *     ordered by recency and capped at {@link STATUS_DERIVATION_LIMIT}. Finds
   *     positions the subscriber has not been told about. A new or re-touched
   *     row carries `row_updated_at = now` and so enters at the head.
   *   - **Phase B — maintenance.** Every cached key that is NOT frozen and NOT
   *     in phase A's result, re-fetched BY IDENTITY in ordered chunks. These are
   *     rows the subscriber holds in its book, including ones that have just
   *     left the actionable filter (`claimed` flipped, stake transferred out) —
   *     their terminal status is emitted before the entry falls out of tracking.
   *
   * Saturating either phase is `onDegraded('positionsTruncated')`, once per
   * poller. It is not a resync: the view stays ordered and keeps delivering,
   * and reconnecting would not widen it.
   *
   * ## Per-tick cost, and what bounds it
   *
   * Four statements per tick per wallet: phase A (≤200 rows), phase B (0–4
   * pages of ≤200), one speculations `IN` list, one contests `IN` list. Rows
   * read per tick are therefore `≤ 200 + 800` positions plus one spec and one
   * contest per distinct parent.
   *
   * Phase A is constant. Phase B is linear in the wallet's NON-FROZEN cached
   * keys, and that is the number this design controls: without the freeze it
   * would be linear in unclaimed history, which only grows — the oldest
   * unclaimed row on polygon is from 2026-06-29 and nothing will ever claim a
   * loser. Measured across the six wallets holding positions (2026-09-22):
   * 1,644 of 1,916 actionable rows (86%) are `isTerminalForever`, so the live
   * work-list is 36–79 rows per wallet against 185–633 actionable. Today phase
   * B issues NO query for any of them, because the seed and phase A's window
   * currently coincide; the freeze is what keeps that true once `#76` seeds the
   * complete population (633 keys → 79 live, instead of 433 stale keys a tick).
   *
   * The traversal that phase A does not do — paging the whole actionable set
   * every tick — would cost the largest wallet ~1,800 rows per 1.5s, 4.3M row
   * reads an hour, growing with history. That is `#76`'s trade to price, not
   * this one's; `.claude/rules/production-cost-review.md` is the reason it is
   * written down here rather than discovered later.
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
    const sb = this.deps.getClient();
    const net = this.deps.getNetwork();
    // Phase A — DISCOVERY over the actionable population. Same filter and
    // same cap as the snapshot's `fetchCategorizedPositions`, so the two
    // saturate on the same condition — but NOT the same ORDER BY: the snapshot's
    // capped read orders by `position_created_at DESC` and this one by
    // `row_updated_at DESC`. Under the cap that is immaterial (both return the
    // whole set); over it the two windows are only guaranteed to agree while a
    // position's update order tracks its creation order. Measured on polygon
    // 2026-09-22 they agree exactly — 200 of 200 keys on each of the three
    // over-cap wallets — which is a fact about the data, not a guarantee, and
    // the prose that used to say "always cover the same rows" claimed the
    // second thing on the strength of the first.
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
      .limit(STATUS_DERIVATION_LIMIT);
    if (actionableRes.error) {
      logger.error(
        { err: actionableRes.error.message, address },
        'ownStateHub positionStatus: actionable positions query failed',
      );
      return;
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
    const actionableSaturated = actionable.length >= STATUS_DERIVATION_LIMIT;
    // Phase B — MAINTENANCE of cached keys that are NOT in phase A's result.
    // These are positions the subscriber already holds whose status may have
    // transitioned (just claimed; stake just transferred out), so their current
    // row is re-fetched by identity and the resulting terminal status is emitted
    // before the cache entry falls out of tracking.
    //
    // Frozen entries are skipped: `isTerminalForever` has already proved they
    // cannot transition, and a row that gets touched re-enters phase A's window
    // at its head anyway. That skip is what keeps this phase proportional to
    // unresolved exposure rather than to unclaimed history.
    //
    // Ordered and chunked, where it used to be one unordered `IN` list under a
    // single `.limit(STATUS_DERIVATION_LIMIT)`. Two defects in that: with more
    // than 200 matching rows PostgREST returned an UNSPECIFIED subset, so which
    // cached positions stopped being maintained was not merely arbitrary but
    // free to differ between ticks; and nothing reported the short read. Sorting
    // the ids makes the covered prefix deterministic, and exhausting the page
    // budget is saturation.
    const actionableKeys = new Set(
      actionable.map(
        (p) =>
          `${String(p.speculation_id)}_${p.position_type === 'upper' ? 0 : 1}`,
      ),
    );
    const staleCachedSpecIds: number[] = [];
    for (const [key, entry] of state.statusCache) {
      if (entry.frozen) continue;
      if (actionableKeys.has(key)) continue;
      const specPart = key.slice(0, key.lastIndexOf('_'));
      const id = Number(specPart);
      if (Number.isFinite(id)) staleCachedSpecIds.push(id);
    }
    // Ascending so the prefix a budget-limited tick covers is specified.
    staleCachedSpecIds.sort((a, b) => a - b);
    const staleBudget = STALE_REFRESH_CHUNK * STALE_REFRESH_MAX_PAGES;
    const staleSaturated = staleCachedSpecIds.length > staleBudget;
    let staleRows: typeof actionable = [];
    for (let off = 0; off < Math.min(staleCachedSpecIds.length, staleBudget); off += STALE_REFRESH_CHUNK) {
      const chunk = staleCachedSpecIds.slice(off, off + STALE_REFRESH_CHUNK);
      const pageLimit = chunk.length * 2;
      const staleRes = await sb
        .from('positions')
        .select(
          'speculation_id, user_address, position_type, risk_amount, profit_amount, ' +
            'claimed, row_updated_at, id',
        )
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
        return;
      }
      const page = (staleRes.data ?? []) as unknown as typeof actionable;
      if (page.length >= pageLimit) {
        // Unreachable while `(network, speculation_id, user_address,
        // position_type)` is unique — at most two rows per speculation per
        // wallet. Reaching it means that assumption is wrong, and the page is
        // then a truncation rather than a complete chunk, so it is saturation
        // and not just a log line.
        logger.warn(
          { address, chunk: chunk.length, rows: page.length },
          'ownStateHub positionStatus: cached-key chunk filled its row limit',
        );
        this.signalSaturation(address, state, 'stale_chunk_full', {
          actionable: actionable.length,
          staleKeys: staleCachedSpecIds.length,
        });
      }
      staleRows = staleRows.concat(page);
    }
    if (actionableSaturated || staleSaturated) {
      this.signalSaturation(
        address,
        state,
        actionableSaturated ? 'actionable_cap' : 'stale_budget',
        { actionable: actionable.length, staleKeys: staleCachedSpecIds.length },
      );
    }
    // Dedupe across the two queries by (speculation_id, position_type).
    const positionsByKey = new Map<string, (typeof actionable)[number]>();
    for (const row of [...actionable, ...staleRows]) {
      const key = `${String(row.speculation_id)}_${row.position_type === 'upper' ? 0 : 1}`;
      // Actionable rows come first; keep their data over the stale refresh
      // (they're the same row from concurrent queries, but actionable's
      // strict filters guarantee freshness).
      if (!positionsByKey.has(key)) positionsByKey.set(key, row);
    }
    const positions = [...positionsByKey.values()];
    if (positions.length === 0) {
      // No actionable rows and no cached keys to refresh — wallet is empty
      // or fully terminal. Nothing to emit.
      return;
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
        return;
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
        return;
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
   * Latched, because the tick that saturates saturates every 1.5s. The latch is
   * per POLLER, so it dies with the last subscriber and a fresh connection is
   * told again — which is what makes it safe for the consumer to clear the state
   * by reconnecting even though the hub never clears it.
   */
  private signalSaturation(
    address: string,
    state: WalletPoller,
    cause: 'actionable_cap' | 'stale_budget' | 'stale_chunk_full',
    counts: { actionable: number; staleKeys: number },
  ): void {
    if (state.saturationSignalled) return;
    state.saturationSignalled = true;
    this.positionSaturationTotal += 1;
    logger.warn(
      { address, cause, ...counts, cap: STATUS_DERIVATION_LIMIT },
      'ownStateHub positionStatus: derivation saturated — position visibility is partial',
    );
    for (const sub of state.subs) {
      try {
        sub.onDegraded('positionsTruncated');
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
