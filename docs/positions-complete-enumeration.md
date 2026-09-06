# Public positions status: bounded complete enumeration

Public `GET /v1/positions/:address/status` and `claim-params` explicitly opt into complete enumeration. Existing SDK/CLI status JSON passes the additive fields through; no SDK/CLI upgrade is part of this change.

- Raw positive-risk, unclaimed positions are scanned by immutable `id DESC` with strict `id < cursor`, 199 rows per read. Continue past categorized-empty/loser-only pages; only a short raw page terminates the scan. Related speculation/contest joins are chunked at 199.
- `enumeration = {complete:true,pageSize:199,pages,positionCount}` counts successful raw reads (including terminal empty reads where applicable), and raw positions before payout filtering. An error, stalled cursor, missing identity, or missing join produces an error response, not partial-success metadata.
- `settlementCandidates` contains all scored-contest/open-speculation controlled positive-risk positions, including losers and unavailable predictions. Deduplicate speculation IDs before settlement. It is NOT a payout bucket. `pendingSettle` retains winnings-only semantics.
- Default shared-helper/own-state calls retain their single 200-row cap, join budget, raw `hitCap`, and UNKNOWN handling. History/list endpoints are unchanged.
- This is an observational multi-query scan, not a transactionally frozen database snapshot. Rows can change after they are read; descend by immutable ID to avoid offset-skipping a shrinking unclaimed set. New head inserts are picked up by the next scan. Chain state remains authoritative at execution; backlog completion requires a fresh readback and repeated bounded passes.

Rollout is separately approved: deploy this producer before the MVE consumer. The consumer refuses older status bodies without complete-enumeration metadata. No deployment, live settlement, claim, SDK pin/build change, or own-state cap removal is authorized by this PR.

Tests use an in-memory query double and explicitly mapped historical ledger rows. The immutable fixture includes exact captured-row strings, source hashes and row indexes. Synthetic database IDs/timestamps are labeled; these are not live response or transaction evidence.
