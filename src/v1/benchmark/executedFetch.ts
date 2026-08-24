/**
 * The executed record's I/O: benchmark fill receipts → the immutable on-chain
 * fill EVENT → that fill's own deployment history → chain outcome → per-arm
 * summary.
 *
 * Separate from `executed.ts`, which is the pure derivation, for the same
 * reason `standingsProject.ts` is separate from `standings.ts`.
 *
 * ## The join is the EVENT, not the aggregate position
 *
 * The first cut reconstructed each fill from `positions`, keyed
 * `(speculation_id, taker_address)`. That was wrong in four ways, all of the
 * same shape — an immutable receipt reconstructed from a mutable aggregate —
 * and review caught it before any of them could reach a page:
 *
 *  - **`positions` is an AGGREGATE.** Its `risk_amount` is the wallet's total
 *    risk on that speculation, not this fill's. Two receipts against one
 *    position each read the full aggregate, so the stake double-counts.
 *  - **The key is not unique.** `positions` is unique on `(network,
 *    speculation_id, user_address, position_type)`; dropping the side means a
 *    wallet holding both sides resolves to whichever row arrived last, and the
 *    verdict flips with row order. Measured on production 2026-08-24: 54
 *    `(speculation, wallet)` pairs hold both sides — all of them MAKERS today,
 *    so it was latent rather than live, which is exactly the kind of "0 today"
 *    this repo's rules say not to build on.
 *  - **`speculation_id` is a per-deployment counter** (073 records the same
 *    hazard for `contest_id`, and the counter reset at R5).
 *  - The unfiltered `.limit(1000)` on a chunk of 100 speculations could
 *    silently drop the wallet's row: 178 speculations already carry 694
 *    position rows.
 *
 * Joining `position_fills` on `(network, tx_hash)` answers all four at once. A
 * transaction hash is globally unique and immutable; the event row carries
 * `taker_position_type` (the side, stated rather than inferred),
 * `taker_risk_amount` (THIS fill's stake) and `maker_risk_amount` (this fill's
 * profit if it wins). `positions` is not read at all.
 *
 * ## The OUTCOME is read from the fill's own deployment, never by counter
 *
 * A transaction hash proves which fill happened. It does not prove that the
 * `speculations` row the service could read today is the speculation that
 * fill was on: `speculation_id` and `contest_id` restart on every redeploy,
 * and the projected tables carry no deployment column, so after a redeploy the
 * current row for id 88 can be a different speculation on a different
 * contest. Review reproduced that twice — first against a reused id created
 * after the fill, then, once creation-block ordering was added, against a
 * reused id created in the SAME block as the old fill, which no block rule can
 * separate from a legitimate create-and-fill-in-one-block.
 *
 * So the outcome path does not read `speculations` or `contests` at all. The
 * indexer keeps every event it ever ingested in `chain_events` — the raw
 * immutable log, the canonical source its own rebuild reads from — and each
 * row carries the `emitter_address` that emitted it. That address is the
 * deployment: the ContestModule and SpeculationModule counters live in the
 * contracts a Core delegates to, so a counter that restarted did so under a
 * new Core (a new emitter), or under the same Core with a second
 * `SPECULATION_CREATED` for the same id — and this module refuses both.
 *
 * Every receipt therefore has to pass four links, and a link that does not
 * hold REFUSES it into `unresolvedFills`:
 *
 *  1. receipt → fill event: same `tx_hash`, and every event in the
 *     transaction names the receipt's taker, speculation, contest and
 *     commitment hash, on one side;
 *  2. fill event → its own `COMMITMENT_MATCHED` log row, at the same
 *     `tx_hash` and `log_index`, with the same taker, speculation, contest,
 *     commitment hash and block — that row's `emitter_address` is the
 *     deployment `E` the fill happened under;
 *  3. the speculation's history UNDER `E`: exactly one `SPECULATION_CREATED`
 *     for the id, citing the receipt's contest and a scorer that maps to the
 *     receipt's market; at most one `SPECULATION_SETTLED`;
 *  4. the contest's history UNDER `E`: exactly one `CONTEST_CREATED` whose
 *     `jsonoddsId` IS the receipt's `game_id` — the durable spine migration
 *     079 names — at most one `CONTEST_SCORES_SET`, at most one
 *     `CONTEST_VOIDED`.
 *
 * The three immutable witnesses have to AGREE with each other too: every
 * `COMMITMENT_MATCHED` row for the fill names the creation's scorer and line,
 * and the settlement names the creation's scorer. Two events that disagree
 * about which contract scored a speculation are not one speculation.
 *
 * The verdict then comes from those events: settled → the protocol's side;
 * voided → void; scored → the scorer replayed on the created line; else
 * pending. A later deployment that reuses every id on the same game in the
 * same block emits under a different `E` and is never consulted; a counter
 * reset under one `E` shows as a second creation and is refused. Measured on
 * production 2026-08-24: 6,131 log rows, one emitter, every `SPECULATION_*`,
 * `CONTEST_*` and `COMMITMENT_MATCHED` row classified by entity (0 nulls), 0
 * duplicate `(emitter, speculationId)` creations among 492.
 *
 * ## The whole chain read is bracketed by the indexer's recovery state
 *
 * The reads above are separate PostgREST statements, and the indexer's
 * recovery — a reorg or a backfill — replaces a block range across several
 * statements of its own. A read that starts before a recovery and finishes
 * after it can pair a fill from one canonical history with a settlement from
 * another. Review reproduced exactly that: an orphaned fill priced from the
 * replacement fork's outcome.
 *
 * Every recovery runs inside a `recovery_runs` lifecycle (`in_progress` →
 * `complete` | `failed`), and the indexer's own ingest and retry loops refuse
 * to touch state while a row is `in_progress` or `failed`. This reader gates
 * on the same signal: the recovery state is read BEFORE the first chain read
 * and AFTER the last, and if an incomplete row exists at either point, or the
 * latest row changed in between — a recovery started and completed during the
 * read — the whole read is refused as {@link ProjectionUnstableError}, a 503.
 * A failed or hung recovery therefore blocks this record exactly as it blocks
 * the indexer, until an operator clears it.
 *
 * `deployment_round` and `run_id` are selected and carried on every fill so a
 * consumer can see which round's counters a receipt cites. They are
 * provenance, not a join key, for the same reason the counters are not.
 *
 * ## The scorer map is the CONFIGURED deployment's — stated as the bound
 *
 * The scorer addresses in config are what name the market of the chain's
 * scorer contract, so the executed record needs them: with `SCORER_*` unset,
 * every receipt is reported unresolved rather than priced on the receipt's
 * own word. Scorer modules are Core-bound, so after a Core rotation the
 * previous deployment's scorers are no longer in config and its fills — if
 * their history was retained at all — are reported unresolved rather than
 * priced by a map this service does not hold. The indexer's supported
 * redeploy resets and reindexes from the new deployment, which leaves those
 * fills without an event to resolve against in any case; the narrowing is
 * stated rather than hidden, and pinned by a test.
 *
 * ## Anything ambiguous is REFUSED, not guessed
 *
 * A record is a public claim about money; a fill this service cannot identify
 * exactly is one it must not price. An amount it cannot read is refused, never
 * read as zero.
 *
 * ## Paging is by KEYSET, and duplicates are a fault
 *
 * `benchmark_execution_fills` is append-only under a publisher that can insert
 * between two pages. Offset paging over it double-counted in review: a row
 * inserted before page two shifts the set, and 1,001 unique receipts came back
 * as 1,002 fills. The walk is now keyed on `tx_hash`, which 079 makes UNIQUE per
 * network, so a cursor is a value rather than a position. A `tx_hash` seen
 * twice after that is something the schema rules out, and the read is refused
 * as a whole rather than deduplicated: a duplicate means the read cannot be
 * trusted, and the honest answer is no record rather than a repaired one.
 *
 * ## Today this reads zero rows
 *
 * `benchmark_execution_fills` is empty until Hermes's `publish_serving.py`
 * (work-order Part 3) runs. The downstream reads are skipped entirely when
 * there are no receipts, so the empty case costs one query rather than five,
 * and every arm's `executed` block serves nulls rather than zeroes.
 */

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import {
  BENCHMARK,
  ProjectionIntegrityError,
  ProjectionUnstableError,
  chunkIds,
  readAllByKeyset,
} from './source.js';
import {
  summarizeExecuted,
  type ExecutedContest,
  type ExecutedFill,
  type ExecutedSpeculation,
  type ExecutedSummary,
} from './executed.js';
import { scorerToType, type ScorerAddresses, type WinSide } from '../../lib/speculation.js';

interface ReceiptRow {
  cohort_id: string;
  participant_id: string;
  game_id: string;
  market: string;
  run_id: string;
  deployment_round: string;
  contest_id: number | string;
  speculation_id: number | string;
  commitment_hash: string;
  taker_address: string;
  tx_hash: string;
  block_number: number | string;
  filled_at: string;
  stake_usdc: number;
  would_abstain: boolean;
}

interface FillEventRow {
  id: number;
  speculation_id: number | string;
  contest_id: number | string | null;
  commitment_hash: string | null;
  taker_address: string;
  taker_position_type: 'upper' | 'lower';
  taker_risk_amount: string | number | null;
  maker_risk_amount: string | number | null;
  tx_hash: string;
  log_index: number;
}

/** A `chain_events` row — the indexer's raw immutable log. Payload values are strings. */
interface ChainEventRow {
  id: number;
  event_name: string;
  emitter_address: string;
  entity_id: number | string | null;
  block_number: number | string;
  tx_hash: string;
  log_index: number;
  payload: Record<string, string | undefined>;
}

/** Event names and entity classes, as the indexer writes them. */
const CHAIN_EVENTS = 'chain_events';
const EVENT = {
  matched: 'COMMITMENT_MATCHED',
  speculationCreated: 'SPECULATION_CREATED',
  speculationSettled: 'SPECULATION_SETTLED',
  contestCreated: 'CONTEST_CREATED',
  scoresSet: 'CONTEST_SCORES_SET',
  contestVoided: 'CONTEST_VOIDED',
} as const;
const ENTITY = { fill: 'fill', speculation: 'speculation', contest: 'contest' } as const;

/** On-chain `WinSide` enum value → name; the indexer's `WIN_SIDE_MAP`. */
const WIN_SIDE_BY_VALUE: Readonly<Record<string, WinSide>> = {
  '0': 'tbd',
  '1': 'away',
  '2': 'home',
  '3': 'over',
  '4': 'under',
  '5': 'push',
  '6': 'void',
};

/** One benchmark fill receipt, joined and ready to render on a pick card. */
export interface BenchmarkFill {
  cohortId: string;
  participantId: string;
  gameId: string;
  market: string;
  /**
   * Whether the identity chain bound this receipt to exactly one priced fill.
   * The receipt is carried either way — it is the operator's published
   * statement that the placement happened — but only a resolved one is in
   * the standings record, and a consumer rendering the receipt is told which.
   */
  resolved: boolean;
  /** The run the receipt cites — part of the decision's identity under 079. */
  runId: string;
  /**
   * The deployment round whose counters `contestId` / `speculationId` belong
   * to. Provenance, served so a reader can tell which round's id 41 this is;
   * never a join key (see the file header).
   */
  deploymentRound: string;
  contestId: string;
  speculationId: string;
  takerAddress: string;
  txHash: string;
  blockNumber: string;
  filledAt: string;
  stakeUsdc: number;
  wouldAbstain: boolean;
}

export interface ExecutedCollection {
  fills: BenchmarkFill[];
  byParticipant: Map<string, ExecutedSummary>;
}

/**
 * Read bounds. Each raises rather than truncates — see `readAllByKeyset`.
 * One receipt is one transaction with a handful of events; one speculation
 * has a handful of log rows; these sit far above any real slate.
 */
const EVENT_READ_CAP = 100_000;
const RECEIPT_READ_CAP = 200_000;
const LOG_READ_CAP = 200_000;

const WEI6 = 1_000_000;

/**
 * A chain amount (wei6, a whole number) as a bigint, or null when the value
 * cannot be read as one. Null REFUSES the receipt downstream: an amount this
 * service cannot read is not zero, and pricing it as zero would publish a
 * fill with no stake and the full profit — the one place "refuse rather than
 * guess" leaked in the first cut, found by an adversarial pass.
 */
function toBig(v: string | number | null): bigint | null {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/** A decimal integer string (a payload value) as a safe integer, or null. */
function toInt(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : /^-?\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** Hex is stored lowercase (079 CHECKs it); payload addresses are checksummed. */
const sameHex = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a !== null && a !== undefined && b !== null && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** Two ids that may arrive as `number` or as a decimal string. */
const sameId = (a: number | string | null | undefined, b: number | string | null | undefined): boolean =>
  a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

/**
 * Every `chain_events` row for a set of entities, by keyset on `id`. The
 * `(network, entity_type, entity_id)` index is what makes this cheap.
 */
async function readChainEvents(
  sb: SupabaseClient,
  network: string,
  entityType: string,
  entityIds: readonly string[],
): Promise<{ rows: ChainEventRow[]; error: PostgrestError | null }> {
  const rows: ChainEventRow[] = [];
  for (const chunk of chunkIds(entityIds, 100)) {
    const page = await readAllByKeyset<ChainEventRow, number>(
      CHAIN_EVENTS,
      LOG_READ_CAP,
      (r) => r.id,
      (after, limit) => {
        let q = sb
          .from(CHAIN_EVENTS)
          .select('id, event_name, emitter_address, entity_id, block_number, tx_hash, log_index, payload')
          .eq('network', network)
          .eq('entity_type', entityType)
          .in('entity_id', chunk)
          .order('id', { ascending: true })
          .limit(limit);
        if (after !== null) q = q.gt('id', after);
        return q as unknown as PromiseLike<{
          data: ChainEventRow[] | null;
          error: PostgrestError | null;
        }>;
      },
    );
    if (page.error) return { rows, error: page.error };
    rows.push(...page.rows);
  }
  return { rows, error: null };
}

/** The indexer's recovery ledger — see the file header. */
const RECOVERY_RUNS = 'recovery_runs';
const INCOMPLETE_RECOVERY = ['in_progress', 'failed'];

interface RecoveryRunRow {
  id: number | string;
  status: string;
}

/** A snapshot of the recovery ledger: is anything incomplete, and what is the latest row. */
interface RecoveryState {
  incomplete: { id: string; status: string } | null;
  latest: { id: string; status: string } | null;
}

async function readRecoveryState(
  sb: SupabaseClient,
  network: string,
): Promise<{ state: RecoveryState; error: PostgrestError | null }> {
  const incomplete = await sb
    .from(RECOVERY_RUNS)
    .select('id, status')
    .eq('network', network)
    .in('status', INCOMPLETE_RECOVERY)
    .order('id', { ascending: false })
    .limit(1);
  if (incomplete.error) return { state: { incomplete: null, latest: null }, error: incomplete.error };
  const latest = await sb
    .from(RECOVERY_RUNS)
    .select('id, status')
    .eq('network', network)
    .order('id', { ascending: false })
    .limit(1);
  if (latest.error) return { state: { incomplete: null, latest: null }, error: latest.error };
  const inc = ((incomplete.data ?? []) as unknown as RecoveryRunRow[])[0];
  const lat = ((latest.data ?? []) as unknown as RecoveryRunRow[])[0];
  return {
    state: {
      incomplete: inc === undefined ? null : { id: String(inc.id), status: inc.status },
      latest: lat === undefined ? null : { id: String(lat.id), status: lat.status },
    },
    error: null,
  };
}

/**
 * The same latest ledger row both times, or none both times.
 *
 * Only the id is compared, deliberately. A row's status moves from
 * `in_progress` and nowhere else, and an `in_progress` (or `failed`) row
 * present BEFORE the read is refused before any chain read happens — so the
 * only change the closing snapshot can observe is a row that did not exist
 * when the read opened, which is a recovery that started after it. Comparing
 * status or timestamps as well would be clauses no input can reach.
 */
function sameRecoveryState(a: RecoveryState, b: RecoveryState): boolean {
  return (a.latest?.id ?? null) === (b.latest?.id ?? null);
}

/** Group log rows by their entity id. */
function byEntity(rows: readonly ChainEventRow[]): Map<string, ChainEventRow[]> {
  const out = new Map<string, ChainEventRow[]>();
  for (const row of rows) {
    if (row.entity_id === null) continue;
    const key = String(row.entity_id);
    const list = out.get(key);
    if (list === undefined) out.set(key, [row]);
    else list.push(row);
  }
  return out;
}

/**
 * Read the fill receipts for a set of cohorts and roll them up per participant.
 *
 * @param scorers the configured scorer contracts — what names the market of a
 *   chain speculation. Absent ⇒ every receipt is unresolved (see the header).
 * @param inScopeGames when supplied, only receipts on these games count — the
 *   sport scope, which the cohort filter alone does not apply.
 */
export async function collectExecuted(
  sb: SupabaseClient,
  network: string,
  cohortIds: readonly string[],
  scorers: ScorerAddresses | undefined,
  inScopeGames?: ReadonlySet<string>,
): Promise<ExecutedCollection | { error: PostgrestError; context: string }> {
  const receiptRows: ReceiptRow[] = [];
  const seenTx = new Set<string>();
  for (const chunk of chunkIds(cohortIds, 50)) {
    // Keyset on `tx_hash`: UNIQUE per network under 079, so it is a strict
    // total order and a cursor cannot be shifted by an insert.
    const page = await readAllByKeyset<ReceiptRow, string>(
      BENCHMARK.executionFills,
      RECEIPT_READ_CAP,
      (r) => r.tx_hash,
      (after, limit) => {
        let q = sb
          .from(BENCHMARK.executionFills)
          .select(
            'cohort_id, participant_id, game_id, market, run_id, deployment_round, contest_id, ' +
              'speculation_id, commitment_hash, taker_address, tx_hash, block_number, filled_at, ' +
              'stake_usdc, would_abstain',
          )
          .eq('network', network)
          .in('cohort_id', chunk)
          .order('tx_hash', { ascending: true })
          .limit(limit);
        if (after !== null) q = q.gt('tx_hash', after);
        return q as unknown as PromiseLike<{
          data: ReceiptRow[] | null;
          error: PostgrestError | null;
        }>;
      },
    );
    if (page.error) return { error: page.error, context: BENCHMARK.executionFills };
    for (const row of page.rows) {
      // Cannot happen with a UNIQUE key and a keyset walk. Enforced rather than
      // assumed, because the failure it guards is a silently doubled stake.
      if (seenTx.has(row.tx_hash)) {
        throw new ProjectionIntegrityError(
          BENCHMARK.executionFills,
          `receipt ${row.tx_hash} was returned more than once`,
        );
      }
      seenTx.add(row.tx_hash);
      receiptRows.push(row);
    }
  }

  const scoped =
    inScopeGames === undefined ? receiptRows : receiptRows.filter((r) => inScopeGames.has(r.game_id));

  if (scoped.length === 0) return { fills: [], byParticipant: new Map() };

  const byArm = new Map<string, ExecutedFill[]>();
  const unresolvedByArm = new Map<string, number>();
  const resolvedTx = new Set<string>();
  const refuse = (participantId: string): void => {
    unresolvedByArm.set(participantId, (unresolvedByArm.get(participantId) ?? 0) + 1);
  };
  const finish = (): ExecutedCollection => {
    const byParticipant = new Map<string, ExecutedSummary>();
    for (const participantId of new Set([...byArm.keys(), ...unresolvedByArm.keys()])) {
      byParticipant.set(
        participantId,
        summarizeExecuted(byArm.get(participantId) ?? [], unresolvedByArm.get(participantId) ?? 0),
      );
    }
    const fills: BenchmarkFill[] = scoped.map((f) => ({
      cohortId: f.cohort_id,
      participantId: f.participant_id,
      gameId: f.game_id,
      market: f.market,
      resolved: resolvedTx.has(f.tx_hash),
      runId: f.run_id,
      deploymentRound: f.deployment_round,
      contestId: String(f.contest_id),
      speculationId: String(f.speculation_id),
      takerAddress: f.taker_address,
      txHash: f.tx_hash,
      blockNumber: String(f.block_number),
      filledAt: f.filled_at,
      stakeUsdc: Number(f.stake_usdc),
      wouldAbstain: f.would_abstain,
    }));
    return { fills, byParticipant };
  };

  // Without the scorer addresses no chain speculation can be assigned a
  // market, so nothing can be priced. Refused, not priced on the receipt's
  // own word — and without reading anything the refusal would be about.
  if (scorers === undefined) {
    for (const receipt of scoped) refuse(receipt.participant_id);
    return finish();
  }

  // ── the recovery bracket opens: nothing chain-derived is read before this ─
  const before = await readRecoveryState(sb, network);
  if (before.error) return { error: before.error, context: RECOVERY_RUNS };
  if (before.state.incomplete !== null) {
    throw new ProjectionUnstableError(
      `recovery ${before.state.incomplete.id} is ${before.state.incomplete.status}`,
    );
  }

  // ── the immutable fill events, by transaction ────────────────────────────
  const txHashes = [...new Set(scoped.map((r) => r.tx_hash))];
  const eventsByTx = new Map<string, FillEventRow[]>();
  for (const chunk of chunkIds(txHashes, 50)) {
    const page = await readAllByKeyset<FillEventRow, number>(
      'position_fills',
      EVENT_READ_CAP,
      (r) => r.id,
      (after, limit) => {
        let q = sb
          .from('position_fills')
          .select(
            'id, speculation_id, contest_id, commitment_hash, taker_address, ' +
              'taker_position_type, taker_risk_amount, maker_risk_amount, tx_hash, log_index',
          )
          .eq('network', network)
          .in('tx_hash', chunk)
          .order('id', { ascending: true })
          .limit(limit);
        if (after !== null) q = q.gt('id', after);
        return q as unknown as PromiseLike<{
          data: FillEventRow[] | null;
          error: PostgrestError | null;
        }>;
      },
    );
    if (page.error) return { error: page.error, context: 'position_fills' };
    for (const row of page.rows) {
      const list = eventsByTx.get(row.tx_hash);
      if (list === undefined) eventsByTx.set(row.tx_hash, [row]);
      else list.push(row);
    }
  }

  // ── the fill's own deployment history, from the raw log ──────────────────
  const specIds = [
    ...new Set([...eventsByTx.values()].flat().map((e) => String(e.speculation_id))),
  ];
  const matched = await readChainEvents(sb, network, ENTITY.fill, specIds);
  if (matched.error) return { error: matched.error, context: CHAIN_EVENTS };
  const matchedBySpec = byEntity(matched.rows);

  const specLog = await readChainEvents(sb, network, ENTITY.speculation, specIds);
  if (specLog.error) return { error: specLog.error, context: CHAIN_EVENTS };
  const specLogById = byEntity(specLog.rows);

  const contestIds = [...new Set(scoped.map((r) => String(r.contest_id)))];
  const contestLog = await readChainEvents(sb, network, ENTITY.contest, contestIds);
  if (contestLog.error) return { error: contestLog.error, context: CHAIN_EVENTS };
  const contestLogById = byEntity(contestLog.rows);

  // ── the recovery bracket closes: the last chain read is behind us ────────
  // A recovery that started during the reads — whether it has completed or
  // is still running — is a ledger row that was not there when the read
  // opened. The rows above may then span two canonical histories, and none
  // of them is served.
  const after = await readRecoveryState(sb, network);
  if (after.error) return { error: after.error, context: RECOVERY_RUNS };
  if (!sameRecoveryState(before.state, after.state)) {
    const latest = after.state.latest;
    throw new ProjectionUnstableError(
      `recovery ${latest?.id ?? '?'} (${latest?.status ?? '?'}) started while the record was being read`,
    );
  }

  // ── resolve each receipt to exactly one priced position, or refuse it ────
  for (const receipt of scoped) {
    const events = eventsByTx.get(receipt.tx_hash) ?? [];
    // Every guard below refuses rather than guesses. A receipt the indexer has
    // not caught up to simply reappears on the next read; one whose transaction
    // does not match it is a real disagreement an operator should see.
    if (events.length === 0) {
      refuse(receipt.participant_id);
      continue;
    }
    // Link 1: every event in the transaction is THIS receipt's fill — the same
    // taker, speculation, contest and commitment. A transaction that also
    // carries someone else's fill, or a fill of a different commitment, would
    // price this arm's record with money that is not its own.
    const mine = events.filter(
      (e) =>
        sameHex(e.taker_address, receipt.taker_address) &&
        sameId(e.speculation_id, receipt.speculation_id) &&
        sameId(e.contest_id, receipt.contest_id) &&
        sameHex(e.commitment_hash, receipt.commitment_hash),
    );
    if (mine.length === 0 || mine.length !== events.length) {
      refuse(receipt.participant_id);
      continue;
    }
    const sides = new Set(mine.map((e) => e.taker_position_type));
    if (sides.size !== 1) {
      refuse(receipt.participant_id);
      continue;
    }
    const specId = String(mine[0]?.speculation_id);

    // Link 2: each projected fill event has its own COMMITMENT_MATCHED log row
    // at the same tx and log index, agreeing on every identity field and on
    // the block — and the rows share ONE emitter. That emitter is the
    // deployment the fill happened under.
    const logRows = (matchedBySpec.get(specId) ?? []).filter(
      (r) => r.event_name === EVENT.matched && sameHex(r.tx_hash, receipt.tx_hash),
    );
    const logFor = (e: FillEventRow): ChainEventRow | undefined =>
      logRows.find((r) => r.log_index === e.log_index);
    const consistent =
      logRows.length === mine.length &&
      mine.every((e) => {
        const r = logFor(e);
        return (
          r !== undefined &&
          sameId(r.payload.speculationId, specId) &&
          sameId(r.payload.contestId, receipt.contest_id) &&
          sameHex(r.payload.taker, receipt.taker_address) &&
          sameHex(r.payload.commitmentHash, receipt.commitment_hash) &&
          sameId(r.block_number, receipt.block_number)
        );
      });
    const emitters = new Set(logRows.map((r) => r.emitter_address.toLowerCase()));
    if (!consistent || emitters.size !== 1) {
      refuse(receipt.participant_id);
      continue;
    }
    const emitter = [...emitters][0] as string;
    const underEmitter = (rows: readonly ChainEventRow[] | undefined, name: string): ChainEventRow[] =>
      (rows ?? []).filter((r) => r.event_name === name && sameHex(r.emitter_address, emitter));

    // Link 3: the speculation's history under that deployment. Exactly one
    // creation — a second one is a counter that restarted — citing the
    // receipt's contest, with a scorer that names the receipt's market.
    const created = underEmitter(specLogById.get(specId), EVENT.speculationCreated);
    const settled = underEmitter(specLogById.get(specId), EVENT.speculationSettled);
    if (created.length !== 1 || settled.length > 1) {
      refuse(receipt.participant_id);
      continue;
    }
    const creation = (created[0] as ChainEventRow).payload;
    const market = creation.scorer === undefined ? null : scorerToType(creation.scorer, scorers);
    const lineTicks = toInt(creation.lineTicks);
    if (
      !sameId(creation.contestId, receipt.contest_id) ||
      market === null ||
      market !== receipt.market ||
      lineTicks === null
    ) {
      refuse(receipt.participant_id);
      continue;
    }
    // Link 3b: the witnesses agree with the creation. Every fill log row
    // names the same scorer and line the speculation was created with, and
    // the settlement names the same scorer. Two immutable events that
    // disagree about which contract scored a speculation are not describing
    // one speculation, whatever ids they share.
    const witnessesAgree =
      logRows.every(
        (r) => sameHex(r.payload.scorer, creation.scorer) && sameId(r.payload.lineTicks, creation.lineTicks),
      ) &&
      settled.every((r) => sameHex(r.payload.scorer, creation.scorer));
    if (!witnessesAgree) {
      refuse(receipt.participant_id);
      continue;
    }
    const settledSide =
      settled.length === 1 ? WIN_SIDE_BY_VALUE[(settled[0] as ChainEventRow).payload.winSideValue ?? ''] : undefined;
    if (settled.length === 1 && settledSide === undefined) {
      refuse(receipt.participant_id);
      continue;
    }

    // Link 4: the contest's history under that deployment — created exactly
    // once, for the receipt's GAME (the spine), scored at most once, voided at
    // most once.
    const contestId = String(receipt.contest_id);
    const contestCreated = underEmitter(contestLogById.get(contestId), EVENT.contestCreated);
    const scores = underEmitter(contestLogById.get(contestId), EVENT.scoresSet);
    const voided = underEmitter(contestLogById.get(contestId), EVENT.contestVoided);
    if (
      contestCreated.length !== 1 ||
      (contestCreated[0] as ChainEventRow).payload.jsonoddsId !== receipt.game_id ||
      scores.length > 1 ||
      voided.length > 1
    ) {
      refuse(receipt.participant_id);
      continue;
    }
    const awayScore = scores.length === 1 ? toInt((scores[0] as ChainEventRow).payload.awayScore) : null;
    const homeScore = scores.length === 1 ? toInt((scores[0] as ChainEventRow).payload.homeScore) : null;
    if (scores.length === 1 && (awayScore === null || homeScore === null)) {
      refuse(receipt.participant_id);
      continue;
    }

    // Amounts the service cannot read are refused, never read as zero.
    const risks = mine.map((e) => toBig(e.taker_risk_amount));
    const profits = mine.map((e) => toBig(e.maker_risk_amount));
    const receiptStake = Number(receipt.stake_usdc);
    if (
      risks.some((r) => r === null) ||
      profits.some((p) => p === null) ||
      !Number.isFinite(receiptStake)
    ) {
      refuse(receipt.participant_id);
      continue;
    }
    const riskWei6 = risks.reduce<bigint>((n, r) => n + (r as bigint), 0n);
    const profitWei6 = profits.reduce<bigint>((n, p) => n + (p as bigint), 0n);

    const speculation: ExecutedSpeculation = {
      speculationStatus: settled.length === 1 ? 'closed' : 'open',
      winSide: settledSide ?? 'tbd',
      marketType: market,
      lineTicks,
    };
    const contest: ExecutedContest = {
      contestStatus: voided.length === 1 ? 'voided' : scores.length === 1 ? 'scored' : 'unverified',
      awayScore,
      homeScore,
    };

    const entry: ExecutedFill = {
      position: {
        positionType: mine[0]?.taker_position_type === 'upper' ? 0 : 1,
        riskWei6,
        profitWei6,
        // The receipt's own stake, from the operator's executor, against the
        // indexer's projection of the same event. Two producers, one quantity —
        // a genuine second witness rather than the same number read twice.
        // `numeric(18,6)` decimal USDC on the receipt; wei6 on the chain side.
        receiptStakeWei6: BigInt(Math.round(receiptStake * WEI6)),
      },
      speculation,
      contest,
    };
    const list = byArm.get(receipt.participant_id);
    if (list === undefined) byArm.set(receipt.participant_id, [entry]);
    else list.push(entry);
    resolvedTx.add(receipt.tx_hash);
  }

  return finish();
}
