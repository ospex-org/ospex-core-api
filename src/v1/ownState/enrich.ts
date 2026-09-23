/**
 * Owner-state body enrichment.
 *
 * The owner-auth own-state surface carries a SUPERSET of the public
 * {@link CommitmentBody}: a maker needs the contest context (sport + the
 * ABSOLUTE home/away teams), the canonical `speculationId`, a freshness
 * timestamp, and — the load-bearing piece — the full SIGNED payload so it can
 * authoritatively `cancelOnchainSigned` a row it has taken off the public book
 * (`book_visible=false`) without re-fetching from a public surface that
 * redacts hidden rows. `speculationId` is deliberately ABSENT from the public
 * body (audit deny-list in `commitments.ts`); it is owner-auth-only here.
 *
 * ── Signed-payload reconstruction ───────────────────────────────────────
 *
 * The 9-field EIP-712 `OspexCommitment` struct is rebuilt from the stored
 * columns, plus the hash + signature. bigint struct fields
 * (`contestId`/`riskAmount`/`nonce`/`expiry`) are emitted as decimal STRINGS
 * — JSON has no bigint — and the SDK coerces them back. Reconstruction is
 * lossless: `risk_amount`/`nonce` are `numeric(78,0)` (returned as strings),
 * `contest_id` is `bigint`, and `expiry` was signed as whole unix-seconds so
 * the stored `timestamptz` round-trips exactly. The SDK asserts
 * `hashCommitment(commitment) === commitmentHash` BEFORE it ever signs a
 * cancel, so a drifted or incomplete reconstruction can never cancel the
 * wrong on-chain slot — `null` here (signature absent OR any signed struct
 * field absent) is the fail-closed signal the MM reads as
 * `signedPayloadStatus: 'missing-legacy'`.
 *
 * ── speculationId resolution ────────────────────────────────────────────
 *
 * `speculations` has no `speculation_key` column, but the key is just
 * `keccak(contestId, scorer, lineTicks)` — so the speculation a commitment
 * belongs to is the one whose `(contest_id, speculation_scorer, line_ticks)`
 * matches the commitment's. We batch-fetch speculations for the same
 * `contest_id` set as the contest join and match in-memory. `null` when no
 * speculation exists yet (a still-unmatched commitment) — the field is
 * nullable by contract.
 */

import { getSupabase } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import {
  rowToBody,
  type CommitmentBody,
  type CommitmentRow,
  type CommitmentRecoveryRow,
} from '../commitments.js';

const POSITION_TYPE_TO_INT: Record<'upper' | 'lower', 0 | 1> = { upper: 0, lower: 1 };

/**
 * Wire shape of the canonical signed commitment payload. Mirrors the SDK's
 * `SignedCommitmentPayload`: the EIP-712 hash, the 9-field struct (bigint
 * fields as decimal strings), and the maker signature. The SDK coerces the
 * string fields back to bigint and asserts the struct hashes to
 * `commitmentHash` before acting on it.
 */
export interface SignedCommitmentWire {
  commitmentHash: string;
  commitment: {
    maker: string;
    contestId: string;
    scorer: string;
    lineTicks: number;
    positionType: 0 | 1;
    oddsTick: number;
    riskAmount: string;
    nonce: string;
    expiry: string;
  };
  signature: string;
}

/**
 * Owner-auth commitment body — the public {@link CommitmentBody} plus the
 * owner-only enrichment fields. `fillability` (a public-only advisory) is
 * never populated on this surface.
 */
export interface OwnerCommitmentBody extends CommitmentBody {
  /** Canonical numeric speculation id, or null when no speculation exists yet. */
  speculationId: string | null;
  /** `contests.sport_slug ?? ''` — matches the rest of the API's sport mapping. */
  sport: string;
  /** Absolute away team (distinct from the maker-relative position side). */
  awayTeam: string;
  /** Absolute home team. */
  homeTeam: string;
  /** `row_updated_at` as whole unix seconds — a freshness signal for the consumer. */
  updatedAtUnixSec: number;
  /** Full signed payload, or null when not reconstructable (fail-closed). */
  signedPayload: SignedCommitmentWire | null;
}

interface ContestContext {
  awayTeam: string;
  homeTeam: string;
  sport: string;
}

export interface CommitmentEnrichment {
  /** `String(contest_id)` → contest context. */
  contestById: Map<string, ContestContext>;
  /** `${contestId}|${scorerLower}|${lineTicks}` → speculationId. */
  speculationIdByTuple: Map<string, string>;
}

/**
 * What {@link fetchCommitmentEnrichment} returns: the maps, plus whether the
 * speculation drain actually got all of them.
 *
 * Deliberately separate from {@link CommitmentEnrichment}, which stays the
 * parameter type of {@link toOwnerCommitmentBody} — that function consumes the
 * MAPS and has no business knowing how completely they were filled. This type is
 * structurally assignable to the narrower one, so no caller or fixture that only
 * needs the maps has to carry the flag.
 */
export interface CommitmentEnrichmentResult extends CommitmentEnrichment {
  /**
   * True when the speculations drain hit its page budget, so
   * `speculationIdByTuple` may be missing tuples and the commitments they belong
   * to will be served `speculationId: null`.
   *
   * Nothing on the wire carries this and nothing should be added for it — that
   * would be a new field for no consumer. It exists so the condition is
   * ASSERTABLE: the downstream outcome, a null optional field, cannot distinguish
   * "the budget bound" from "no speculation exists for this tuple yet", which is
   * the ordinary and correct case (`verification-discipline.md` 3b-outcome).
   */
  speculationsIncomplete: boolean;
}

type SbClient = ReturnType<typeof getSupabase>;

interface ContestLiteRow {
  contest_id: string | number;
  away_team: string | null;
  home_team: string | null;
  sport_slug: string | null;
}
interface SpeculationTupleRow {
  /** Also the drain's cursor — see {@link drainSpeculations}. */
  speculation_id: string | number;
  contest_id: string | number | null;
  speculation_scorer: string | null;
  line_ticks: number | null;
}

/** `${contestId}|${scorerLower}|${lineTicks}`, or null when any part is absent. */
function specTupleKey(
  contestId: string,
  scorer: string | null,
  lineTicks: number | null,
): string | null {
  if (contestId === '' || scorer == null || lineTicks == null) return null;
  return `${contestId}|${scorer.toLowerCase()}|${lineTicks}`;
}

/**
 * Batch-fetch the contest context + speculation-id mapping for a set of
 * commitment rows in two queries (contests + speculations, both scoped by the
 * rows' distinct `contest_id`s). The returned maps are consumed by
 * {@link toOwnerCommitmentBody} so per-row mapping does no IO.
 */
/** Ids per parent read — see the note inside `fetchCommitmentEnrichment`. */
const ENRICH_ID_CHUNK = 199;

/**
 * Rows per page of the speculations drain, and its page budget.
 *
 * **999, not 1,000.** PostgREST's documented default response maximum is 1,000
 * rows, so asking for exactly that would make a full page ambiguous: 1,000 rows
 * back could mean "the page you asked for" or "the server truncated you", and
 * those need opposite responses. One short of the maximum makes a full page
 * unambiguously THIS code's bound. Same reasoning as the sentinel row in
 * `verification-discipline.md`'s `3g-legalmax` — make the observation attributable.
 *
 * It is also chosen to cost nothing on today's data. Measured against production
 * 2026-09-23: polygon holds 992 speculations across 461 contests, at most 3 per
 * contest, so the densest possible 199-contest chunk answers 473 rows. That is one
 * request per chunk — exactly what the unpaged read cost — and a second round trip
 * is only ever spent once the fan-out is real.
 *
 * 64 pages mirrors `COMPLETE_MAX_PAGES` in `positionFetch.ts`, so the family has
 * one number rather than two that can drift. It is 63,936 rows per chunk: a mean
 * of 321 speculations per contest across 199 contests, against a current maximum
 * of 3. That is a backstop for a pathological loop, not a bound on real data. It
 * binds PER CHUNK; the number of chunks is bounded separately by the caller's
 * commitment cap (`ownStateSnapshotMaxCommitments`, 5,000 → at most 26 chunks).
 */
const ENRICH_SPEC_PAGE_SIZE = 999;
const ENRICH_SPEC_MAX_PAGES = 64;

/** A raw `id` as a bigint cursor, or null when it cannot serve as one. */
function rowCursor(raw: string | number | null): bigint | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text);
}

/**
 * Drain every speculation under one chunk of contest ids, paging by the table's
 * own primary key.
 *
 * ## Why this is a drain and not one request (`#101`)
 *
 * `#76`'s B2 chunked this function's id list at {@link ENRICH_ID_CHUNK}, which
 * bounds the REQUEST. For this read that is not the same number as the response.
 * The sibling `contests` read is keyed on `contest_id` and answers one row per id,
 * so a 199-id chunk cannot exceed 199 rows. This read is keyed on the same column
 * and is one-to-MANY — a contest carries a speculation per market and line — so its
 * answer fans out BENEATH a bounded input list. PostgREST's default response
 * maximum is 1,000 rows and a read that crosses it SUCCEEDS with fewer rows: no
 * error, no `error` field, no short-page signal. The tuples that did not come back
 * then resolve to nothing and their commitments are served `speculationId: null`.
 *
 * Reproduced before it was fixed, with one contest and 1,001 tuples: 1,000 of 1,001
 * resolved, and an otherwise identical run with the server maximum lifted resolved
 * all of them (`tests/ownState-enrich-wire.test.ts`).
 *
 * ## Why the cursor is `speculation_id`
 *
 * A keyset drain is complete only while its ordering column is unique WITHIN THE
 * FILTERED SET: a value straddling a page boundary is skipped by the strict `>`.
 * That holds here by constraint, not by assumption —
 * `uq_speculation UNIQUE (network, speculation_id)` (`ospex-indexer` schema/live.sql)
 * — and it holds because this read pins exactly one `network` with `.eq`. If a
 * future edit ever widened that to several networks, the guarantee would go with it
 * and the cursor would need the network in it too.
 *
 * Verified against production 2026-09-23 as well as read off the DDL: 992 rows on
 * polygon, drained complete at page sizes 999 and 100 (10 pages), 992 distinct ids
 * both times, matching the server's own `count=exact`.
 *
 * What does NOT apply here, because a reader who knows `#97` will ask: the hazards
 * that disqualified an id watermark for POSITIONS discovery — sparse ids from
 * `ON CONFLICT`, a row re-entering the population under an old id, a reorg replay
 * assigning fresh ids — are all properties of a cursor that is DURABLE ACROSS
 * TICKS. This cursor lives for the length of one read and is then discarded, so only
 * within-query uniqueness matters. (The reorg replay is the sharp one: it re-inserts
 * at the SAME `speculation_id`, so a persisted watermark would never revisit it.
 * A one-shot cursor cannot care.)
 *
 * ## What it costs (production-cost-review.md)
 *
 * `EXPLAIN (ANALYZE, BUFFERS)` on a local PG16 carrying the real DDL and all eight
 * real indexes, warm, per 199-contest chunk:
 *
 *   fan-out 398 (today's density, one page):      27 -> 75 buffers
 *   fan-out 995 (5 markets/contest, one page):    61 -> 177 buffers
 *
 * So bounding the read costs roughly 2.8x the buffers of the unbounded one it
 * replaces, on a chunk that is one page. The extra is the sort: no index can serve
 * `ORDER BY speculation_id` across a multi-valued `contest_id` IN-list, so the page
 * is a top-N over the chunk's fan-out.
 *
 * Above 999 rows per chunk that becomes N pages of about one chunk scan each
 * (~2,094 buffers per page at a 3,980-row fan-out). The number that matters for
 * this rule is that the per-page cost is INVARIANT TO TOTAL HISTORY — 2,094 buffers
 * at 800,000 rows and 2,094 at 4,000,000 — because it tracks speculations PER
 * CONTEST, which is a product parameter, not an accumulation. Today's maximum is 3
 * per contest and one page needs a mean of 5.03, so the multi-page regime is a
 * feature away rather than a date away.
 *
 * Two alternatives were measured and rejected rather than reasoned about:
 *
 *  - a COMPOUND keyset on `(contest_id, speculation_id)`, on the theory that
 *    ordering by the indexed prefix would let each page resume instead of
 *    re-scanning. It does not: the planner still sorts and still filters the rows it
 *    already returned, at an identical 2,094 buffers. No gain, more expression.
 *  - SUBDIVIDING the contest-id list on a saturated probe (no ORDER BY at all,
 *    halving until a short answer). Genuinely cheaper in the multi-page regime
 *    (~4,000 buffers against ~10,000) and it costs 3x the round trips there, needs a
 *    keyset for its single-contest base case anyway, and is 24 buffers better on the
 *    path that actually runs. Not worth a second mechanism today; it is the fix to
 *    reach for if markets-per-contest ever crosses ~5.
 *
 * ## Why exhaustion degrades instead of throwing
 *
 * All three callers already catch a throw from this module, and two of them turn it
 * into something worse than a missing optional field: `snapshot.ts` answers HTTP
 * 500, and `stream.ts` writes a `resync` that the SDK retries with `attempt = 0`
 * and no backoff. Discarding tens of thousands of resolved tuples to avoid a
 * handful of nulls would trade a degraded field for a failed connection — the same
 * decision, and the same reason, that `#76` recorded for the position enumeration
 * limit.
 *
 * A non-advancing page, an oversized page and a full page with no cursor at all DO
 * throw, because those are code or schema
 * defects (a dropped select column, an unordered page) rather than data conditions,
 * and they should redden a test rather than quietly serve less.
 */
async function drainSpeculations(
  sb: SbClient,
  network: string,
  contestIdSlice: string[],
): Promise<{ rows: SpeculationTupleRow[]; incomplete: boolean }> {
  const rows: SpeculationTupleRow[] = [];
  let afterId: bigint | undefined;
  let pages = 0;
  for (;;) {
    // Checked BEFORE the read, so the budget bounds reads ISSUED rather than reads
    // completed — mirroring `fetchCategorizedPositions`' complete traversal.
    if (pages >= ENRICH_SPEC_MAX_PAGES) {
      logger.warn(
        { network, contests: contestIdSlice.length, pages, rows: rows.length },
        'ownState/enrich speculations: page budget exhausted, tuple map may be incomplete',
      );
      return { rows, incomplete: true };
    }
    let query = sb
      .from('speculations')
      // `speculation_id` is both a payload column and the cursor. A select list
      // missing it yields an undefined cursor and a drain that cannot advance,
      // which is why the wire test asserts the column list and the ORDER BY and
      // not only the rows that came back.
      .select('speculation_id, contest_id, speculation_scorer, line_ticks')
      .eq('network', network)
      .in('contest_id', contestIdSlice);
    if (afterId !== undefined) query = query.gt('speculation_id', afterId.toString());
    const res = await query
      .order('speculation_id', { ascending: true })
      .limit(ENRICH_SPEC_PAGE_SIZE);
    if (res.error) {
      throw new Error(`fetchCommitmentEnrichment speculations: ${res.error.message}`);
    }
    // A list `select` answers an ARRAY on success, and `error` was checked above, so a
    // null or otherwise non-array answer is a shape this code cannot read. Note which
    // reading is the dangerous one: `(data ?? []).length` is 0, which is
    // indistinguishable from a short page and would END the drain while claiming
    // completeness — the silent-truncation class this whole change is about. It is
    // also not worth a throw, because `snapshot.ts` turns a throw from this module
    // into HTTP 500. So the rows gathered so far are returned INCOMPLETE: neither
    // discarded nor blessed.
    //
    // The sibling `contests` read keeps its plain `?? []`: it is unpaged, so an empty
    // answer there is not a claim about having reached the end of anything.
    if (!Array.isArray(res.data)) {
      logger.warn(
        { network, contests: contestIdSlice.length, pages },
        'ownState/enrich speculations: page answer was not an array, tuple map may be incomplete',
      );
      return { rows, incomplete: true };
    }
    const page = res.data as unknown as SpeculationTupleRow[];
    pages += 1;
    if (page.length > ENRICH_SPEC_PAGE_SIZE) {
      throw new Error('fetchCommitmentEnrichment speculations: oversized page');
    }
    // Validate EVERY row, not just the page's last: a repeated, overlapping or
    // out-of-order page has to fail instead of looping for ever or advertising a
    // completeness it does not have.
    //
    // A row whose `speculation_id` will not parse is SKIPPED rather than fatal, and
    // the skip is bounded immediately below (rule 3k — a skip inside a verifier is an
    // opt-out unless the skipped case is unreachable). It IS unreachable: the column
    // is `bigint NOT NULL`. And such a row is already dropped by `specTupleKey`, so
    // refusing the whole enrichment over one would discard every OTHER tuple this
    // call resolved and, on the snapshot path, answer 500 — the failure path throwing
    // away more than the defect costs (rule 3j-retain).
    let advanced = false;
    for (const row of page) {
      const id = rowCursor(row.speculation_id);
      if (id === null) continue;
      if (afterId !== undefined && id <= afterId) {
        throw new Error('fetchCommitmentEnrichment speculations: non-advancing keyset page');
      }
      afterId = id;
      advanced = true;
    }
    rows.push(...page);
    if (page.length < ENRICH_SPEC_PAGE_SIZE) return { rows, incomplete: false };
    // Here the page was FULL, so there is more to read and the cursor has to move.
    // A full page carrying no usable cursor at all cannot be continued from, and
    // asking again would return the same page for ever.
    if (!advanced) {
      throw new Error('fetchCommitmentEnrichment speculations: page carries no usable cursor');
    }
  }
}

export async function fetchCommitmentEnrichment(
  sb: SbClient,
  network: string,
  rows: CommitmentRecoveryRow[],
): Promise<CommitmentEnrichmentResult> {
  const contestById = new Map<string, ContestContext>();
  const speculationIdByTuple = new Map<string, string>();
  // Three return sites, and each one is its own property (rule 2b, "count the
  // serialization sites"): the two short-circuits below are complete by
  // definition — they read nothing, so nothing can be missing.
  if (rows.length === 0) {
    return { contestById, speculationIdByTuple, speculationsIncomplete: false };
  }

  const contestIds = [
    ...new Set(
      rows
        .map((r) => r.contest_id)
        .filter((id): id is string | number => id != null)
        .map(String),
    ),
  ];
  if (contestIds.length === 0) {
    return { contestById, speculationIdByTuple, speculationsIncomplete: false };
  }

  // TWO BOUNDS, ONE PER READ, because the two reads have different shapes and a
  // single number would be dishonest about one of them (`#76` B2, then `#101`).
  //
  // The id LIST is chunked at `ENRICH_ID_CHUNK`. It is the distinct contests across
  // up to `ownStateSnapshotMaxCommitments` (5,000) commitment rows and the contest
  // population grows monotonically with the season, so an unbounded `.in(...)` here
  // is a bound that gets crossed rather than one that cannot be.
  //
  // That chunk is the WHOLE bound for `contests`, which is keyed on `contest_id` and
  // answers one row per id: 199 ids, at most 199 rows, comfortably under PostgREST's
  // 1,000-row default response maximum.
  //
  // It is NOT the whole bound for `speculations`, which is keyed on the same column
  // and answers one row per market AND line beneath each contest — so its answer
  // fans out beneath a bounded input list and can still cross that maximum, which a
  // PostgREST read does silently. `drainSpeculations` pages it; the reasoning, the
  // production measurement, the choice of cursor and why exhaustion degrades rather
  // than throws are all documented there.
  //
  // The general rule, worth more than either instance: ask whether a join is 1:1 or
  // 1:many before believing that chunking its input made it safe.
  //
  // A missing contest leaves a commitment with EMPTY team/sport strings and a
  // missing speculation tuple leaves its `speculationId` unresolved — served, not
  // dropped, which is why this family degrades where the positions one could not.
  //
  // The two reads stay parallel WITHIN a chunk, which is what the original
  // `Promise.all` bought and what adding the drain must not cost.
  let speculationsIncomplete = false;
  for (let start = 0; start < contestIds.length; start += ENRICH_ID_CHUNK) {
    const slice = contestIds.slice(start, start + ENRICH_ID_CHUNK);
    const [contestRes, specDrain] = await Promise.all([
      sb
        .from('contests')
        .select('contest_id, away_team, home_team, sport_slug')
        .eq('network', network)
        .in('contest_id', slice),
      drainSpeculations(sb, network, slice),
    ]);
    if (contestRes.error) {
      throw new Error(`fetchCommitmentEnrichment contests: ${contestRes.error.message}`);
    }
    if (specDrain.incomplete) speculationsIncomplete = true;

    for (const c of (contestRes.data ?? []) as unknown as ContestLiteRow[]) {
      contestById.set(String(c.contest_id), {
        awayTeam: c.away_team ?? '',
        homeTeam: c.home_team ?? '',
        sport: c.sport_slug ?? '',
      });
    }
    for (const s of specDrain.rows) {
      // The row's own id has to be usable, not just its KEY parts. `specTupleKey`
      // checks contest/scorer/line and the VALUE stored here is
      // `String(s.speculation_id)` — so a row arriving without one would publish the
      // literal string `"undefined"` as a `speculationId`, which is worse than null:
      // the market maker's `validateSpeculationId` accepts any non-empty string and
      // `BigInt('undefined')` then throws deep in its exposure grouping. Unreachable
      // from the live schema (`bigint NOT NULL`); reachable from a `select` list that
      // stopped naming the column, which is the same producer the drain's cursor check
      // guards. Deliberately the SAME predicate, so the two cannot disagree.
      if (rowCursor(s.speculation_id) === null) continue;
      const key = specTupleKey(
        s.contest_id != null ? String(s.contest_id) : '',
        s.speculation_scorer,
        s.line_ticks,
      );
      if (key != null) speculationIdByTuple.set(key, String(s.speculation_id));
    }
  }

  return { contestById, speculationIdByTuple, speculationsIncomplete };
}

/**
 * Reconstruct the signed payload from a commitment row. Returns null —
 * fail-closed — when the signature is absent (indexer-discovered rows) OR any
 * signed struct field is missing (an incomplete row can't produce a struct
 * that hashes back to `commitmentHash`).
 */
export function buildSignedPayload(row: CommitmentRow): SignedCommitmentWire | null {
  if (!row.signature) return null;
  if (
    row.contest_id == null ||
    row.scorer == null ||
    row.line_ticks == null ||
    row.position_type == null ||
    row.odds_tick == null ||
    row.risk_amount == null ||
    row.nonce == null ||
    row.expiry == null
  ) {
    return null;
  }
  const expiryMs = Date.parse(row.expiry);
  if (!Number.isFinite(expiryMs)) return null;

  return {
    commitmentHash: row.commitment_hash,
    commitment: {
      maker: row.maker,
      contestId: String(row.contest_id),
      scorer: row.scorer,
      lineTicks: row.line_ticks,
      positionType: POSITION_TYPE_TO_INT[row.position_type],
      oddsTick: row.odds_tick,
      riskAmount: String(row.risk_amount),
      nonce: String(row.nonce),
      // Signed as whole unix-seconds; the stored timestamptz round-trips exactly.
      expiry: String(Math.floor(expiryMs / 1000)),
    },
    signature: row.signature,
  };
}

/**
 * Map a commitment recovery row to the enriched owner body, using a
 * pre-fetched {@link CommitmentEnrichment} (no IO). The base public fields
 * come from the shared `rowToBody`; the owner-only fields are layered on.
 */
export function toOwnerCommitmentBody(
  row: CommitmentRecoveryRow,
  nowMs: number,
  enrichment: CommitmentEnrichment,
): OwnerCommitmentBody {
  const base = rowToBody(row as unknown as CommitmentRow, nowMs);
  const contestId = row.contest_id != null ? String(row.contest_id) : '';
  const contest = contestId !== '' ? enrichment.contestById.get(contestId) : undefined;
  const tupleKey = specTupleKey(contestId, row.scorer, row.line_ticks);
  const speculationId =
    tupleKey != null ? (enrichment.speculationIdByTuple.get(tupleKey) ?? null) : null;
  const updatedAtMs = Date.parse(row.row_updated_at);

  return {
    ...base,
    speculationId,
    sport: contest?.sport ?? '',
    awayTeam: contest?.awayTeam ?? '',
    homeTeam: contest?.homeTeam ?? '',
    updatedAtUnixSec: Number.isFinite(updatedAtMs) ? Math.floor(updatedAtMs / 1000) : 0,
    signedPayload: buildSignedPayload(row as unknown as CommitmentRow),
  };
}
