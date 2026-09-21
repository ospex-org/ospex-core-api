# Public positions status: bounded complete enumeration

Public `GET /v1/positions/:address/status` and `claim-params` explicitly opt into complete enumeration. The pinned SDK shapes status into `{active, pendingSettle, claimable, totals}`, so the CLI does **not** receive the additive fields. The separately reviewed MVE consumer must read status directly from this public endpoint over HTTPS, retaining the CLI for every write and every other read. No SDK/CLI upgrade is part of this change.

- Raw positive-risk, unclaimed positions are scanned by immutable `id DESC` with strict `id < cursor`, 199 rows per read. Continue past categorized-empty/loser-only pages; only a short raw page terminates the scan. Related speculation/contest joins are chunked at 199.
- **The traversal is bounded, and exhausting a bound is an error rather than a short answer.** Two bounds, because they mean different things. `COMPLETE_MAX_PAGES` = 64 counts DATABASE READS of the positions scan — the same thing `enumeration.pages` reports, terminal short read included — so the largest population that completes is `64 x 199 - 1` = **12,735 rows**, and 12,736 needs a 65th read and is refused. That off-by-one is a consequence of the unit, not an accident: the loop stops on a short page, so an exact multiple of the page size costs one extra read to discover it has ended. `COMPLETE_DEADLINE_MS` = 15,000 covers the WHOLE traversal, the scan and both joins together, because that is what a request spends; it is half of the platform's 30s request timeout so categorisation and the response fit in the other half. **It is enforced by cancellation, not only by inspection**: one `AbortSignal` for the whole traversal is attached to every read, so a request already in flight — including one stalled part-way through its response BODY — is torn down at the deadline rather than awaited indefinitely. One signal per traversal, not one per read, or each read would get its own fifteen seconds and the total would be unbounded again. The clock is then checked after EVERY read and once more before any success return, which is what refuses a read that merely RETURNED late: a terminal short read and an empty wallet both end the loop, so without that check nothing ran afterwards to notice. Rows carry no separate budget — an oversized page is already refused, so reads x page size bounds rows exactly.
- Exhaustion throws `PositionEnumerationLimitError` and both public handlers answer `500` with `ENUMERATION_BUDGET_EXCEEDED` or `ENUMERATION_DEADLINE_EXCEEDED`. **Neither is transient**: the same wallet reproduces it until a bound is deliberately raised or reads get faster. No partial buckets, no `enumeration.complete=true`, and no false zero escapes — the refusal replaces the whole result. The deadline is the operative guard; the page budget is the backstop for a loop that is pathological but fast, and is set generously on purpose. The DEFAULT capped path is one read and carries neither bound.
- `enumeration = {complete:true,pageSize:199,pages,positionCount}` counts successful raw reads (including terminal empty reads where applicable), and raw positions before payout filtering. An error, stalled cursor, missing identity, or missing join produces an error response, not partial-success metadata.
- `settlementCandidates` contains all open-speculation controlled positive-risk positions whose contest is `scored` **or** `voided`, including losers and unavailable predictions. Deduplicate speculation IDs before settlement. It is NOT a payout bucket. `pendingSettle` retains winnings-only semantics.
- `settledLost` is always present (including `[]`) and contains positive-risk, unclaimed positions on **closed** speculations with an authoritative losing `win_side`. Each row is the existing structured `PositionBase` plus `result: "lost"`: `positionId`, string `speculationId`/`contestId`, numeric `positionType` (0 upper / 1 lower), `team`, `opponent`, `market`, `oddsDecimal`, `riskAmountUSDC`, `profitAmountUSDC`, `sport`, `awayTeam`, `homeTeam`, `riskAmountWei6`, `counterpartyRiskWei6`, `updatedAtUnixSec`. The `positionId` remains `${speculationId}_${lowercaseAddress}_${positionType}`. No `estimatedPayout*`, `predictedWinSide`, or `txParams` is added. Historical risk/profit is evidence, not active exposure, claim value, or money owed. These terminal rows are excluded from `active`, `settlementCandidates`, `pendingSettle`, `claimable`, every money total, and claim-params. No data is mutated to mark them claimed.
- Reconcile raw `enumeration.positionCount` against the stable-position-identity **union** of `active`, `settlementCandidates`, `pendingSettle`, `claimable`, and `settledLost`. Candidates overlap pending/active rows; summing bucket lengths is incorrect. Never replace the raw count with categorized counts to manufacture completeness. A closed/`tbd` inconsistent outcome is still unclassified and thus remains a raw/union mismatch for strict consumers. Read/join/cursor error handling remains unchanged.
- Open predicted losers are still settlement work, **not** `settledLost`; do not use the broader own-state stream's advisory `settledLost` derivation to populate this bucket. Closed push (draw) and void refunds remain claimable. An **open** speculation on a `voided` contest is now a `settlementCandidates` row as well as an `active` one, which is the fix for ospex-core-api#77; the earlier statement that this bucket ignored voided contests no longer describes the code. What it still does not do is serve that refund's AMOUNT or a claim plan — see the bound below.
- Default shared-helper/own-state calls retain their single 200-row cap, join budget, raw `hitCap`, and UNKNOWN handling. History/list endpoints are unchanged.
- This is an observational multi-query scan, not a transactionally frozen database snapshot. Rows can change after they are read; descend by immutable ID to avoid offset-skipping a shrinking unclaimed set. New head inserts are picked up by the next scan. Chain state remains authoritative at execution; backlog completion requires a fresh readback and repeated bounded passes.

Rollout is separately approved: deploy this producer before the MVE consumer. The companion consumer must require the new `settledLost` array as well as complete-enumeration metadata and exact raw/union reconciliation; older status bodies must not be interpreted as complete. No deployment, live settlement, claim, SDK pin/build change, or own-state cap removal is authorized by this PR.

## Classification bound and deferred adjacent work

The exclusion of closed/`tbd` relies on the registered moneyline, spread and total scorers returning only `{Away, Home, Over, Under, Push}` on successful scoring. Atomic indexer writes are not the guarantee: settlement does not enforce a non-TBD result, and the indexer's unknown-outcome fallback is `tbd`. If an inconsistent closed/`tbd` row exists, the strict raw/union mismatch blocks that wallet's entire consumer lane. Identity reconciliation detects omission and contradiction, not a producer misclassification whose fields are stamped by the same branch that chose its bucket.

Within REST-visible positive-risk, unclaimed positions, the own-state advisory `settledLost` label is broader than this REST bucket: it also includes closed/`tbd` rows and open predicted losers. The REST bucket contains only authoritative closed losses. Do not substitute one for the other.

### The settleable set is bounded by what the row alone proves

`settlementCandidates` admits an open speculation whose contest is `scored` or `voided`. On chain a
third state is settleable: a `verified` contest past the void cooldown settles to `Void`, and doing so
is what makes a contest read `voided` at all — `ContestStatus.Voided` has one write site, reachable
only from inside that cooldown branch. So this bucket catches a stalled contest's sibling speculations
and not the first one.

That is a stated bound rather than an oversight. `scored` and `voided` are facts the indexer mirrors
from events; `verified` + past-cooldown is a prediction from a stored timestamp plus the deployment's
`voidCooldown` immutable, neither of which this endpoint reads, and a wrong constant would advertise
work whose transaction reverts `ContestNotFinalized`. Tracked as ospex-core-api#79, which also records
that the right timestamp is `contests.start_time` and not the effective-start view.

### Open-void refunds: settlement work is served, the refund amount is not

An open speculation on a `voided` contest is reported as settlement work. Its refund is deliberately
absent from `pendingSettle`, from the `totals` money fields, and from `claim-params`, and the reason is
a consumer contract rather than a preference.

`pendingSettle` rows carry a required `predictedWinSide`, and ospex-sdk validates that field with
`z.enum(['away', 'home', 'over', 'under', 'push'])` in `packages/sdk/src/ownState/schemas.ts`. The
own-state snapshot's position row is a `z.discriminatedUnion` on `status` with no `void` member. So a
server that emitted a void into either shape would not degrade an installed client, it would fail that
client's decode outright — on the feed a market maker uses to track its own money. Widening those two
declarations and releasing the SDK has to land before the amount can be served, so it is one
coordinated change rather than a unilateral server edit.

What follows from that, for a consumer today: an open-void row appears in `settlementCandidates` and in
`active`, `settleSpeculation` is the action, and the refund becomes visible through the ordinary
`claimable` path once the speculation is closed. Do not read the absence of a payout figure as evidence
that nothing is owed. Tracked as the follow-up to ospex-core-api#77.

The dual membership is deliberate and the MVE consumer already permits it: `active` overlapping
`settlementCandidates` is not one of the overlaps that consumer refuses, and its union count is keyed by
`(speculationId, side)` so a row in both is counted once. Keeping the row in `active` is what holds the
raw-count-equals-bucket-union reconciliation together — a row in no bucket at all would fail that
wallet's entire lane closed, and it would also vanish from the own-state snapshot, whose positions array
is built from these buckets. The pinned SDK never reads `settlementCandidates` at all (its
`PositionStatusBody` names only `active`, `pendingSettle`, `claimable` and `totals`), so no installed SDK
or CLI client observes this change.

Two pre-existing behaviors remain separate follow-ups, not fixes in #74:

- **Own-state 200-row cap:** terminal losses remain unclaimed with positive historical risk and no payout/transfer clearing path, so they can permanently consume the default capped query's budget and keep `positionsTruncated`/the MM health hold asserted. A durable correction must exclude terminal rows before applying the actionable own-state cap (without falsifying raw complete-enumeration evidence), and prove with more than 200 terminal losses plus actionable rows that health recovers without hiding live exposure. Raising the cap only delays the problem. This source finding does not establish whether any live maker is currently latched.
- **History/list totals:** `GET /v1/positions/:address` still reports page-scoped sums alongside full-set `totalCount`, and counts unclaimed settled losses in `activeCount`. A separate contract/documentation correction must make aggregation scope explicit and pin terminal-loss classification across multiple pages. This status correction leaves that endpoint unchanged.

Tests use an in-memory query double and explicitly mapped historical ledger rows. The immutable fixture includes exact captured-row strings, source hashes and row indexes. Synthetic database IDs/timestamps are labeled; these are not live response or transaction evidence.
