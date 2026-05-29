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
 * spec §2.1.3 enum via `derivePositionStatus`.
 *
 * Limitation (PR1): the cursor's `p` watermark advances on
 * `positions.row_updated_at`. A pure speculation-status transition (e.g.
 * settled → win_side set) that does NOT propagate to the position row will
 * not bump the cursor; the next tick still re-reads via the overlap window
 * and the SDK reducer's dedup key
 *   `(address, speculationId, positionType, status, sourceUpdatedAt)`
 * absorbs the re-emit. The MM accepts this — `positionStatus` is canonical
 * (`to` only); the SDK reducer is monotonic per rank. If real-world drift
 * surfaces, a future PR adds a periodic speculation-row poll keyed by the
 * wallet's tracked speculationIds.
 *
 * Dependency-injected (client/network/intervals) so it unit-tests against
 * a recorded mock with no timers or live DB.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { getSupabase } from '../../lib/supabase.js';
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
import {
  derivePositionStatus,
  type ContestInput,
  type PositionStatusEventBody,
  type SpeculationInput,
} from './positionStatus.js';
import type { MarketType } from '../../lib/speculation.js';

// ── Subscriber surface ───────────────────────────────────────────────────

export interface OwnStateCallbacks {
  /** A maker-scoped commitment row update (insert or mutation). */
  onCommitment: (body: CommitmentBody, ts: string, id: string) => void;
  /** A maker or taker side fill row. */
  onFill: (body: FillBody, ts: string, id: string) => void;
  /** A derived position-status transition. `ts`/`id` are positions.row_updated_at / positions.id. */
  onPositionStatus: (body: PositionStatusEventBody, ts: string, id: string) => void;
  /**
   * Upstream recovery completed (reorg) or the hub couldn't keep its
   * overlap window honest — the subscriber should reconnect/re-snapshot.
   */
  onResync: (reason: string) => void;
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
 * `positionStatus` events. Spec §2.1.2 keys positionStatus events on
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
}

interface WalletPoller {
  subs: Set<OwnStateSubscriber>;
  /**
   * Per-wallet poll timer. NULL until {@link OwnStateHub.beginLive} is
   * called for the first subscriber on this wallet — the handler invokes
   * `beginLive` only AFTER its catch-up has seeded the cache, so a tick
   * cannot silently absorb a derived-state transition that happened during
   * the handoff (the preReady-race blocker from review-32 round 2).
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
 * Per-tick cap on the position re-derivation query. Mirrors
 * `POSITION_QUERY_LIMIT` in `positionFetch.ts` so the stream and snapshot
 * cover the same population. `ORDER BY row_updated_at DESC` keeps the most
 * recent transitions in-window; long-quiet terminal positions naturally
 * fall out of the window without losing future events (they don't
 * transition again).
 */
const STATUS_DERIVATION_LIMIT = 200;

/**
 * Returns the largest ISO-8601 timestamp by parsed epoch ms. Used for
 * `sourceUpdatedAt` derivation across (position, speculation, contest)
 * row_updated_at values. Different rows may emit `Z` vs `+00:00` shapes
 * (PostgREST quirk — see `cursor.ts` self-compat note), so we compare on
 * the parsed numeric value, not lexicographically. The original string
 * is preserved verbatim so cursor pagination keeps full precision.
 */
function maxIsoTimestamp(
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

export class OwnStateHub {
  private readonly deps: Required<OwnStateHubDeps>;
  private readonly pollers = new Map<string, WalletPoller>();
  private totalSubs = 0;
  private resyncTimer: ReturnType<typeof setInterval> | undefined;
  private resyncCursor: { completedAt: string; id: bigint } | null = null;
  private resyncPolling = false;
  private resyncBroadcastTotal = 0;

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
    entries: Array<{ key: string; status: import('./positionStatus.js').PositionStatus; sourceUpdatedAt: string }>,
  ): void {
    const state = this.pollers.get(address.toLowerCase());
    if (!state) return;
    for (const e of entries) {
      state.statusCache.set(e.key, { status: e.status, sourceUpdatedAt: e.sourceUpdatedAt });
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
   * Population: `claimed=false AND risk_amount>0` (the actionable set,
   * matching `fetchCategorizedPositions`) UNION currently-cached keys.
   * Cached keys carry forward any position the handler seeded — so a
   * recent transition that has just left the actionable filter (e.g.
   * `claimed` just flipped to true and the row has `risk_amount=0`) is
   * still re-derived against current spec/contest data, and the resulting
   * terminal status (`claimed`) is emitted before the row falls out of
   * tracking.
   *
   * Per-tick cost: one positions query (capped at 200 by
   * `STATUS_DERIVATION_LIMIT`) + one positions IN-list query for stale
   * cached keys + one speculations IN-list query + one contests IN-list
   * query. Bounded.
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
    // Phase A — actionable population (matches snapshot's
    // `fetchCategorizedPositions` filter so the live view and the
    // snapshot view always cover the same rows).
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
    // Phase B — currently-cached keys that are NOT in the actionable set
    // any more. These are positions whose status may have transitioned
    // (e.g. just claimed; just transferred-out) — we need to re-fetch their
    // current row so the derivation reflects the transition before the
    // cache entry falls out of tracking.
    const actionableKeys = new Set(
      actionable.map(
        (p) =>
          `${String(p.speculation_id)}_${p.position_type === 'upper' ? 0 : 1}`,
      ),
    );
    const staleCachedSpecIds: number[] = [];
    for (const key of state.statusCache.keys()) {
      if (actionableKeys.has(key)) continue;
      const specPart = key.slice(0, key.lastIndexOf('_'));
      const id = Number(specPart);
      if (Number.isFinite(id)) staleCachedSpecIds.push(id);
    }
    let staleRows: typeof actionable = [];
    if (staleCachedSpecIds.length > 0) {
      const staleRes = await sb
        .from('positions')
        .select(
          'speculation_id, user_address, position_type, risk_amount, profit_amount, ' +
            'claimed, row_updated_at, id',
        )
        .eq('network', net)
        .eq('user_address', address)
        .in('speculation_id', staleCachedSpecIds)
        .limit(STATUS_DERIVATION_LIMIT);
      if (staleRes.error) {
        logger.error(
          { err: staleRes.error.message, address },
          'ownStateHub positionStatus: cached-key refresh query failed',
        );
        return;
      }
      staleRows = (staleRes.data ?? []) as unknown as typeof actionable;
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

    for (const row of positions) {
      const spec = specsById.get(Number(row.speculation_id));
      if (!spec) continue; // orphan — defensive skip
      const contest = spec.contest_id != null ? contestsById.get(spec.contest_id) ?? null : null;
      const positionType: 0 | 1 = row.position_type === 'upper' ? 0 : 1;
      const sourceUpdatedAt = maxIsoTimestamp(
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
      state.statusCache.set(key, { status: body.status, sourceUpdatedAt });
      // Emit when derived status differs from the seeded/cached entry.
      // Covers both raw position transitions AND spec/contest-driven
      // transitions on unchanged position rows. A previously-unseen key
      // (prior === undefined) also emits — the handler is responsible for
      // seeding every position it discovered, so an unseen key means a
      // genuinely new position OR a tick that raced the handoff (in which
      // case the subscriber's preReady abort path catches it).
      if (prior && prior.status === body.status) continue;
      for (const sub of state.subs) {
        try {
          sub.onPositionStatus(body, sourceUpdatedAt, String(row.id));
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
      for (const row of rows) {
        const key = `${row.row_updated_at}|${String(row.id)}`;
        if (res.emitted.has(key)) {
          cmp = { s: row.row_updated_at, i: String(row.id) };
          continue;
        }
        const tsMs = Date.parse(row.row_updated_at);
        res.emitted.set(key, Number.isFinite(tsMs) ? tsMs : Date.now());
        const body = commitmentRowToBody(row as unknown as CommitmentRow, nowMs);
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

  stats(): { wallets: number; subscribers: number; resyncBroadcastTotal: number } {
    return {
      wallets: this.pollers.size,
      subscribers: this.totalSubs,
      resyncBroadcastTotal: this.resyncBroadcastTotal,
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
