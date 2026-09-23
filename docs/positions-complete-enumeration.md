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

### The settleable set: two mirrored facts and one prediction

`settlementCandidates` admits an open speculation on a contest that is `scored`, `voided`, **or**
`verified` with the void cooldown provably elapsed. The third ground closed ospex-core-api#79, and it
is the one that matters most in practice: settling a still-`verified` contest is what makes it read
`voided` at all — `ContestStatus.Voided` has one write site, reachable only from inside that cooldown
branch — so before #79 this bucket caught a stalled contest's SIBLING speculations and never the first
one, which is the settlement that starts the refund.

The two kinds of claim are kept apart deliberately. `scored` and `voided` are facts the indexer mirrors
from events. `verified` + past-cooldown is a PREDICTION from three terms — the status,
`contests.start_time`, and the deployed `SpeculationModule`'s `i_voidCooldown` — and it refuses itself
whenever any term is missing, because a wrong "yes" advertises work whose transaction reverts
`ContestNotFinalized` while a wrong "no" is just the pre-#79 answer.

Three consequences a consumer should know:

- **The timestamp is `contests.start_time`, never `contests_effective.effective_start_time`.** The
  effective view is a bounded `LEAST` over `games.match_time` and provider snapshots, so it is `<=` the
  chain's frozen value and would read past-cooldown EARLY.
- **The cooldown is read from the chain, not configured as a number.** One `eth_call` to the
  `uint32 public immutable i_voidCooldown` getter per process, cached — so the term cannot disagree
  with the module address it describes, which a constant or an env var can. It is read ONLY when a
  `verified` contest is actually in scope, and it is bounded three ways so an optional term can
  never hold a request: a 2,000 ms transport timeout, the caller's remaining traversal budget
  (capped at 2,500 ms), and a 60 s window in which a failed attempt is not retried. Any failure,
  including a provider that never answers, degrades the prediction rather than the response.
- **`voidCooldownSeconds` is served on the response**, and `null` means the term was unavailable and
  every `verified` contest was therefore refused. A short `settlementCandidates` list plus a null term
  is a missing configuration, not an idle wallet. The number also lets a consumer recompute the
  boundary instead of trusting it.

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

  **Partly addressed, 2026-09-22 (`#83`), and the remainder is named.** The LIVE stream half is done: the own-state hub now retires provably-finished positions from its per-tick work-list via `isTerminalForever`, so the terminal losses stop consuming the maintenance budget, and saturating either of its two bounds is reported (`event: degraded`) instead of being a silent short read. The measurement that scoped it: of 1,916 actionable rows across the six wallets holding positions on polygon, 1,644 (86%) are provably finished, and all 742 rows that fall outside the hub's window carry 0.00 USDC claimable.

  **ADDRESSED 2026-09-23 (`#76`).** The own-state snapshot now calls the complete enumeration, and the claimed-since read pages the keyset it was already ordered by. `positionsTruncated` therefore reports a BUDGET rather than a cap: a complete traversal that runs out of pages or time falls back to the capped read and says so, and the claimed paging says so when it runs out of its 16 pages. No polygon wallet reaches either budget — the largest actionable population is 621 against 12,735, and the largest claimed population is 594 against 3,200. Exhaustion FALLS BACK rather than erroring, because the SDK retries a `resync` with no backoff and the SSE route carries no read rate limit, so a 500 on this path is a reconnect loop that pays for a fresh snapshot each time.

  The paragraph that follows is the pre-`#76` statement of the problem, kept because it is what the measurement below was taken against:

  What is NOT addressed, deliberately: the DEFAULT CAPPED READ in `fetchCategorizedPositions` still applies its 200-row cap to the whole actionable set, so `positionsTruncated` and the MM health hold still latch for a wallet whose unclaimed losers exceed the cap — three wallets do today, at 635 / 499 / 210 rows, and the largest is the market maker's own maker wallet. Excluding terminal rows there means either a per-row join inside the capped read or a complete traversal, and both change what that read costs on a path the own-state snapshot takes on every connect. That is `#76`'s decision and it needs its own cost measurement; `#83` deliberately did not touch it, and did not remove `positionsTruncated`.

  **The cost is now measured** (2026-09-22, on the wire, by proxying PostgREST and counting what the client actually sent). For the 635-row maker wallet the snapshot's position read goes from **3 statements / 466 rows / 649 ms** capped to **10 statements / 1,619 rows / 958 ms** complete, and the complete path does not come near its 64-page or 15,000 ms bounds. Against a path taken once per own-state CONNECT — rather than the hub's once per 1.5 s — that is affordable, which is the answer `production-cost-review.md` was asking for. Two further facts that the same measurement settled: no polygon speculation has a null `contest_id`, so the complete path's fail-closed contest join is not reachable from current data; and `/v1/positions/:address` ALREADY enumerates completely, so `src/v1/ownState/snapshot.ts` is the last capped caller and the two surfaces already disagree for that wallet.

  **What `#76` also has to do, found while scoping it.** Making the snapshot complete is not sufficient on its own, and it cannot ship first. The hub's phase-A rule treats a full discovery page as saturation regardless of what the cache holds, so a complete snapshot would be followed by a `degraded` frame on the first tick — permanently, since the frame latches per subscriber and the SDK has no in-connection event that clears a live-phase one. Probed at the real size: 635 seeded keys produced 4 phase-B pages, 400 of 435 keys covered, and a latched signal.

  **Both halves are now fixed, and the second one is `#97` (2026-09-23).** `derivedStatuses.terminal` carries `isTerminalForever` from the read that already did the join, so the seed retires finished keys instead of spending a first tick on them — the 635-key cold start issues ZERO phase-B queries. And the phase-A rule that treated a full discovery page as saturation is GONE, because the page is gone: discovery is an ASCENDING KEYSET DRAIN over `(row_updated_at, id)` from the poller's own tip, the same mechanism `scanCommitments`/`scanFills` already used in that file. A top-N window ordered by a mutable key can be displaced; a cursor ascending from a watermark cannot, because a page limit cuts the NEWEST rows and the next tick reads them. The relaxation withdrawn in `#96` is therefore not re-attempted — there is no longer a signal to relax, and the counterexample it failed (199 rows, a new key displaced by churn on 200 known keys) is now answered by DELIVERING the row.

  What remains reportable from the live path is phase B's per-tick maintenance budget, which is the one bound only the hub can see: 400 keys against a measured worst case of 51 live keys on the 621-row wallet. Measured on the wire, same proxy method as above, three ticks on `0x5316fa54…`: **7 statements / 489 rows per tick BEFORE** (200 positions + 181 speculations + 108 contests, identical for ever, plus a `degraded` frame on tick 1) against **8 statements / 86 rows per tick AFTER** (0 + 44 + 28 + 14, no degraded). One statement more, 82% of the rows gone, upstream time flat. Every wallet gets cheaper and the finished ones dramatically so: `0x4fa0a5aa…` (51 actionable, ZERO still live) now costs **5 statements / 0 rows** a tick — one drain that returns nothing and no join at all — against 139 rows before, spent re-deriving 51 rows that can never change again. The cost that remains is linear in UNRESOLVED EXPOSURE rather than in unclaimed history.

  ⚠ **The cursor is acknowledged by the WORK, not by the read**, and getting that wrong was the review blocker on the change that introduced it. The maintenance page and both parent joins run AFTER the drain; an earlier version advanced the cursor as soon as the rows came back, so a transient failure in any of those three left the drained rows uncached with the cursor already past them — and maintenance cannot recover a key the cache never held. A `DESC LIMIT 200` window passed that case for free because it re-read every row every tick. A cursor only does if the tip is committed after the derivation, which is what it now does; an unresolved parent join holds it for the same reason. The three failure boundaries are enumerated in `tests/ownState-hub-derivation-bound.test.ts`, so a fourth read added to the derivation has to be added there too.

  So `#76` is unblocked: a complete seed is no longer contradicted by the next tick.

  There are NO 200-row caps left in this family. There were four: `STATUS_DERIVATION_LIMIT` (the hub's live discovery) went with `#97`, which replaced it with a keyset drain; `POSITION_QUERY_LIMIT` (the snapshot's actionable read), `CLAIMED_PAGE_CAP` (its claimed page) and `CATCHUP_POSITIONS_LIMIT` (the resume leg's TWO reads) all became bounded traversals in `#76`. ⚠ The resume leg was missed on the first attempt and caught in review: the cold start went complete while the resume leg stayed capped, so a complete recovery became partial again on an ordinary reconnect and a settled position the cap omitted never delivered its transition. Enumerating a cap family is not the same as fixing it — this doc named all four and the PR fixed two. The claimed-since population exceeds its cap for the same two wallets (295 and 293 claimed rows), and `positionsTruncated` carries two of them AND the decision to freeze the cursor's `p`, so the snapshot's two reads have to become complete together or `p` advances on a partial view.
- **History/list totals:** `GET /v1/positions/:address` still reports page-scoped sums alongside full-set `totalCount`, and counts unclaimed settled losses in `activeCount`. A separate contract/documentation correction must make aggregation scope explicit and pin terminal-loss classification across multiple pages. This status correction leaves that endpoint unchanged.

Tests use an in-memory query double and explicitly mapped historical ledger rows. The immutable fixture includes exact captured-row strings, source hashes and row indexes. Synthetic database IDs/timestamps are labeled; these are not live response or transaction evidence.
