# ospex-core-api

Public REST read API, signed-write relay, and SSE push layer for the Ospex protocol — a zero-vig peer-to-peer sports prediction protocol on Polygon. Reads on-chain state mirrored into Supabase by the protocol indexer and exposes it as a versioned API at `/v1/*`.

**Where the trust sits.** Settlement, custody, matching validity, cancellation, and nonce floors are all enforced on-chain by the protocol's verified contracts. This service holds no signing key, submits no transactions, and holds no user funds — it cannot forge or alter an on-chain fill. What it *can* do is decide what the public orderbook shows and which signed commitments it relays onward, and it serves reads from a database mirror of chain state rather than from the chain directly. So this repo is the code you read to check that it doesn't play games with any of that. See "Hidden-row redaction" and [`docs/CANCEL_FLOW.md`](./docs/CANCEL_FLOW.md) for where it matters most.

## Status

Live on Polygon mainnet. The API surface today:

- `/healthz` (liveness), `/readyz` (readiness)
- `POST /v1/commitments` — EIP-712 commitment relay
- `GET /v1/commitments` — list with filters / pagination
- `GET /v1/contests`, `GET /v1/contests/:contestId` — contest list / detail (renamed from `/v1/markets/*`). Carries six start-time fields: `matchTime` (the current conservative start-time safety bound — gate on this), `chainStartTime` (the immutable on-chain value), `gameMatchTime` (the odds-feed schedule), `gameEarliestMatchTime` (the game's retained safety floor), and `gameRundownMatchTime` / `gameSportspageMatchTime` (the enrichment providers' start-time snapshots, admitted into the minimum only within a one-hour freshness window). See "Contest start times" below
- `GET /v1/speculations`, `GET /v1/speculations/:speculationId` — speculation list (filters: `contestId`, `sport`, `status`) / detail (with orderbook + parent contest context)
- `GET /v1/protocol/info` — static protocol metadata
- `GET /v1/auth/domain` — EIP-712 self-discovery: the signing `domain`, every registered action's typed-field schema, and a per-endpoint map of which `action.type` each signed endpoint accepts. Copy `domain` + the action's fields straight into `wallet.signTypedData(...)`. Returns `503 NOT_READY` if `MATCHING_MODULE_ADDRESS` is unset
- `GET /v1/config/public` — bootstrap config for public clients: `{supabaseUrl, supabaseAnonKey, network, chainId}`. The Supabase key served here is the **publishable** key and is public by design — it is gated by row-level security, and grants only the anonymous read access the protocol already exposes. Returns `503 NOT_READY` if `SUPABASE_ANON_KEY` is unset
- `GET /v1/positions/:address` — wallet position history
- `GET /v1/positions/:address/status` — categorized active / pendingSettle / claimable
- `GET /v1/positions/:address/claim-params` — ordered `txParams[]` action plan
  (one `claimPosition` step for settled rows; `settleSpeculation` then `claimPosition` for
  rows whose contest is scored but whose speculation is still open)
- `GET /v1/positions/by-tx/:txHash` — parse `PositionFilled` from a tx
- `GET /v1/positions/claim-result/:txHash` — parse `PositionClaimed` from a tx
- `GET /v1/leaderboard` — current active leaderboard
- `GET /v1/schedule?sport=` — upcoming games
- `GET /v1/games`, `GET /v1/games/:gameId` — upcoming games available for contest creation. **`matchTime` is a conservative safety bound** — a bounded minimum over `match_time`, `earliest_match_time`, and the provider snapshots `rundown_match_time` / `sportspage_match_time` (each admitted only within one hour below `match_time` — the same freshness guard the contest-shaped surfaces' view applies) — with the raw inputs published alongside it as `gameMatchTime`, `earliestMatchTime`, `rundownMatchTime`, and `sportspageMatchTime`. Includes the `externalIds` (`jsonodds`, `sportspage`, `rundown`) contest creation needs. `gameId` is the immutable `jsonodds_id`; the human-readable `slug` is exposed separately and is **mutable** (the writer renames it on a reschedule or doubleheader), so anything persisting a game id between calls must store the `jsonodds_id` form. Each game also carries `probablePitchers: { home, away }` — advisory MLB probable/announced starters as last reported by the upstream odds feed (both null when unannounced and for non-MLB sports); never an input to contest creation, matching, or scoring
- `GET /v1/teams/aliases?sport=` — flat list of team aliases (full name / nickname / abbrev / city) joined to canonical team metadata. Consumed by `@ospex/sdk`'s resolver layer to map free-form `--side` input ("Lakers", "LAL") to a canonical team id when staking a commitment.
- `GET /v1/contests/:contestId/odds` — current upstream reference odds for the contest's underlying game (moneyline / spread / total snapshot from `current_odds`). Per-market response shapes are explicit (no shared "line + away/home" envelope) so consumers can't misread the semantics — see "`GET /v1/contests/:contestId/odds`" below for the exact shape.
- `GET /v1/analytics/odds-history/:contestId` — opening + current odds for analytics callers (deprecated SDK-internal use; new code should prefer `/contests/:contestId/odds` for current-state reads).
- `DELETE /v1/commitments/:hash` — EIP-712 signed off-chain cancel; hides the maker's commitment from the public book. **Authoritative cancel is still on-chain** — see [`docs/CANCEL_FLOW.md`](./docs/CANCEL_FLOW.md).
- **Cursor recovery:** `?since=<cursor>` recovery mode on `GET /v1/commitments`, `/v1/speculations`, `/v1/contests`; bare `GET /v1/positions` (recovery) alongside the address-scoped snapshot; `GET /v1/fills` (append-only fill events). See "Cursor recovery reads" below.
- **SSE streams:** `GET /v1/stream/{commitments,positions,fills,speculations,contests}` — live deltas + cursor catch-up + resync over Server-Sent Events. See "SSE streams" below.
- **Odds stream:** `GET /v1/stream/odds?contestId=&market=` — snapshot then live `change`/`refresh` over Server-Sent Events (latest-state, no cursor). See "Odds stream" below.
- `GET /v1/metrics` — operational stream / odds / own-state / connection counters (process-local). See "Metrics" below.
- **Stream auth:** `POST /v1/auth/stream-challenge` + `POST /v1/auth/stream-token` — EIP-712 challenge/response that mints a ~15 min HMAC bearer token, scoped to `{address, audience, chainId}`. Required for the owner-auth `/v1/own-state/*` surfaces; the public/anonymous reads above are unchanged.
- **Own-state snapshot:** `GET /v1/own-state/snapshot?cursor=<opt>` — owner-auth (`Authorization: Bearer <stream-token>`) paged snapshot of the maker's commitments + positions. Returns `{cursor, commitments[], positions[], truncated, positionsTruncated}`. The composite cursor is the resume point for `/v1/stream/own-state` or — when `truncated: true` (commitments-only) — the continuation key for the next page. `positionsTruncated` is the DEGRADED discriminant, decoupled from `truncated`: when `true`, position visibility is PARTIAL. The stream cold-start emits `event: degraded` before `ready` and consumers (SDK / market maker) must quote-hold and treat owner-state as partial. There is no paging/convergence mechanism that drains positions beyond the actionable cap; the `/v1/positions/:address` REST endpoint provides full history out-of-band for operator tooling. **Passive expiry** (a commitment whose only terminal transition is `expiry <= now`) is NOT emitted by recovery — the indexer doesn't advance `row_updated_at` for time alone, so such rows fall outside both halves of the recovery response. The SDK reducer is responsible for computing effective status locally (same `deriveEffectiveStatus` pattern used by `/v1/commitments`) and pruning any locally-held active commitment whose stored expiry has lapsed; the active set the snapshot returns is authoritative of currently-matchable rows.
- **Own-state stream:** `GET /v1/stream/own-state` — owner-auth composite SSE stream of the caller's own commitments + position-status transitions. Cold start (no cursor) emits an inline `snapshot` event; reconnects resume from the composite cursor via `Last-Event-ID` or `?cursor=`. Emits `degraded` before `ready` when owner-state visibility is partial.
- `GET /v1/health/own-state` — **public** (no stream-auth) indexer-lag probe returning `{indexerLagSeconds, lastIndexedAt, lagSource}`. Indexer lag is a global, wallet-independent signal; a market maker polls it to decide whether its owner-state view is fresh enough to quote against.

Not ported (no analog in the current protocol — see "Position helpers" section below): `/withdraw-params`, `/withdraw-result/:txHash`. Not ported in any batch yet (deferred or out of scope): everything else under `/v1/analytics/*`, `/v1/current-odds*` (the legacy `/v1/current-odds*` paths are superseded by the contest-centric `/v1/contests/:contestId/odds`).

## Stack

- Node.js 20.19+, TypeScript (strict, `exactOptionalPropertyTypes`)
- Express 5
- Supabase (`@supabase/supabase-js`) — the only data layer. **No Firebase.**
- ethers v6 — EIP-712 typed-data hashing / signature recovery
- pino for logs

## Run locally

```bash
yarn install
cp .env.example .env  # fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
yarn typecheck
yarn dev
```

Then:

```bash
curl http://localhost:3000/healthz   # liveness — always 200 if process is up
curl http://localhost:3000/readyz    # readiness — 200 when always-required deps (Supabase + the contests_effective view + EIP-712 relay env) are wired
```

## Health endpoints

- `/healthz` — **liveness**. The process is up and the event loop is responsive. Always returns 200. Heroku/uptime monitors should target this — restarting the dyno doesn't fix a downstream outage, so we don't fail liveness when Supabase is down.
- `/readyz` — **readiness**. The process is up *and* its required dependencies are reachable. Returns 503 if Supabase is unreachable, or if the `contests_effective` view every contest-shaped read depends on is absent, so traffic routers / smoke tests can avoid sending requests that would fail.

## Endpoints

Most read endpoints share `readRateLimit` (600 req/min per IP); the write endpoint has its own tighter limit. The SSE stream endpoints (`/v1/stream/*`) are intentionally exempt — a stream is one long-lived request, not a burst — and are bounded by a concurrent-connection cap instead (see "SSE streams").

### `POST /v1/commitments`

Accepts a signed EIP-712 `OspexCommitment` from a maker, persists it to Supabase as `status: 'open'`, and returns the stored row. Idempotent on `commitment_hash`: a duplicate post returns 200 with the existing row instead of 409. If a row exists from the indexer (no signature yet), the API enriches it with the maker's signature, full risk amount, nonce, expiry, and speculation key.

Body shape:

```json
{
  "action": {
    "type": "OspexCommitment",
    "maker":        "0x…",
    "contestId":    "1234",
    "scorer":       "0x…",
    "lineTicks":    -35,
    "positionType": 0,
    "oddsTick":     220,
    "riskAmount":   "10000000",
    "nonce":        "1730000000",
    "expiry":       "1735000000"
  },
  "signature": "0x…"
}
```

Notes:
- 9 fields, in the exact order the contract's `COMMITMENT_TYPEHASH` declares them. A signer producing a different field set will fail verification on-chain.
- `verifyingContract` of the EIP-712 domain is the **MatchingModule**, not OspexCore.
- `riskAmount` must be a multiple of 100 (lot-size aligned).
- `oddsTick` ∈ [101, 10100].
- `expiry` is unix seconds; must be in the future and within ~1 year of now (the upper bound prevents JS `Date` overflow on pathological values).
- `positionType`: 0 = upper (away/over), 1 = lower (home/under).
- Rate-limited at 60 requests/minute per IP.
- The API also pre-checks `maker_nonce_floors` and rejects commitments with `nonce < min_nonce` as `400 NONCE_TOO_LOW` so unfillable orders never reach the open feed.

Responses: `201 Created` on new, `200 OK` on duplicate, `400` for validation, `401 AUTH_INVALID` on signature mismatch, `429`, `500`.

### `GET /v1/commitments`

List commitments, sorted by `created_at DESC, commitment_hash ASC` (newest first; tie-break on hash so offset-based pagination is deterministic — backfilled rows can share a timestamp, so the hash tie-break is load-bearing).

The default response is **the matchable open book**: still-fillable commitments that a taker could `matchCommitment` against right now. Power users can opt back into invalidated / expired / non-default-status rows via the flags below. Off-book (hidden) rows are excluded unconditionally — the legacy `?includeHidden=true` opt-in was removed. Makers retrieve their own hidden rows via the owner-auth own-state surface.

Every returned commitment carries two status fields: **`status` is the _effective_ lifecycle status** and **`storedStatus`** is the raw on-chain lifecycle value the indexer/relay recorded. Effective status folds in what the contract enforces at match time but the indexer never writes as an event, plus off-chain book visibility: a stored `open`/`partially_filled` row past its `expiry` reports `status: 'expired'`; a nonce-invalidated row, or one the maker hid from the book via an off-chain `DELETE` (`bookVisible: false`), reports `status: 'cancelled'` (the row may still be matchable on-chain — read `storedStatus`/`bookVisible` for chain truth). `filled` and `cancelled` stay terminal. The `status`, `includeExpired`, and `includeInvalidated` query params filter on the **stored** value + the expiry / nonce columns (which keeps pagination and `total` exact); the effective lifecycle is read off the response `status` (notably on get-by-hash and on `include*` results). Off-book (hidden) rows are filtered out of the list unconditionally — there is no longer an `includeHidden` opt-in (see "Hidden-row redaction" below).

Query params:
| Param | Notes |
|---|---|
| `maker` | optional — filter by maker address |
| `contestId` | optional — filter by contest |
| `scorer` | optional — filter by scorer address |
| `status` | optional, comma-separated. Filters the **stored** status column. Default `open,partially_filled` (both still fillable — `partially_filled` rows have `remaining_risk_amount > 0`). Any of `open`, `partially_filled`, `filled`, `cancelled`. `expired` is **not** accepted here — it is never a stored value; surface time-expired rows with `includeExpired=true` and read the effective `status` in the response. |
| `includeInvalidated` | optional bool, default `false`. By default, rows where the maker has raised `s_minNonces[maker][speculationKey]` past this commitment's nonce (`nonce_invalidated = true`) are excluded — the contract would reject `matchCommitment` on them. Set `true` to include; included nonce-invalidated rows report effective `status: 'cancelled'` (raw `storedStatus` unchanged). |
| `includeExpired` | optional bool, default `false`. By default, rows whose `expiry` has passed are excluded. Set `true` to include; included past-expiry rows report effective `status: 'expired'`. |
| `includeFillability` | optional bool, default `false`. When `true`, each returned commitment carries an advisory `fillability` object (Layer-D maker-funding signal — see below). Off by default; the response is byte-identical without it. Costs one extra indexed `maker_funding` query per call when enabled. |
| `limit` | optional, default 100, max 1000 |
| `offset` | optional, default 0 |

Response: `{ commitments: CommitmentBody[], pagination: { limit, offset, total, hasMore } }`. Each `CommitmentBody` has the full canonical shape including `status` (effective lifecycle), `storedStatus` (raw indexed value), `bookVisible` (off-chain book visibility), `signature`, `speculationKey`, `nonceInvalidated`, `createdAt`, etc.

#### Hidden-row redaction across anonymous reads

Anonymous reads of off-book rows (`book_visible=false`) return an **allow-list projection**, not the full body. The projection is enforced at **runtime**: the allow-list is the single source of truth, the wire type is derived from it, and the body is built by projecting the full body through it — so a field can't leak unless it's on the list, regardless of any upstream change. Hidden bodies expose only lifecycle and identity fields and **omit** `signature`, `nonce`, `oddsTick`, `riskAmount`, `remainingRiskAmount`, `lineTicks`, `scorer`, `speculationKey`, and every EIP-712 typed-data field — enough that no anonymous taker can reconstruct a `matchCommitment` transaction against a soft-cancelled order. The two structural discriminants `redacted: true` and `payloadAvailable: false` let consumers branch on the response shape without probing for missing fields.

The projection is the contract for the paths that legitimately surface lifecycle transitions for tracked rows — `GET /v1/commitments/:hash`, `?since=<cursor>` recovery, and the SSE `/v1/stream/commitments` payload. The two **orderbook embeds**, `GET /v1/contests/:contestId` and `GET /v1/speculations/:speculationId`, also route through the same projection as **defense-in-depth** on top of their `book_visible=true` filter: a hidden row that ever slipped past the filter emerges redacted, never as a signed payload. (The contest embed groups commitments by `speculationKey`, which a redacted body lacks, so it **drops** such a row; the speculation embed's flat orderbook **surfaces** it redacted, matching the list/recovery/SSE paths.) The default `GET /v1/commitments` list never serves hidden rows in the first place — the filter excludes them.

With `includeFillability=true`, each `CommitmentBody` also carries a `fillability` object — an **advisory** maker-funding signal derived from the indexer's ~30s `maker_funding` snapshot (the maker's USDC balance + PositionModule allowance vs. their visible committed book risk). It is point-in-time and **never folded into `status`**. Shape: `{ advisory: true, makerFundingStatus: 'fully_backed' | 'overcommitted' | 'unknown' | 'stale', orderIndividuallyBackedNow, makerBookBackedNow, makerBackingWei6, makerVisibleCommittedWei6, makerCoverageRatioBps, checkedAtBlock, stale }`. `makerFundingStatus` is the headline: `unknown` = no snapshot for that maker; `stale` = the snapshot aged past ~120s (the `…BackedNow` booleans are then `null` — a "now" assertion can't be made from old data, though the last-known numbers are still returned). `orderIndividuallyBackedNow` = backing covers THIS order's remaining maker risk; `makerBookBackedNow` = backing covers the maker's WHOLE visible book — a maker can be individually-backed yet overcommitted across their book, which is the "fake liquidity" this surfaces. A `maker_funding` read failure degrades every row to `unknown` rather than failing the list.

### `GET /v1/contests`

List upcoming contests within a configurable time window (default 72h, max 168h).

Query params: `sport` (one of `nba`, `nhl`, `ncaab`, `nfl`, `mlb`), `status`, `window` (hours), `limit` (max 200), `offset`.

Response: `{ contests: ContestListItem[], pagination }`. Each contest has `contestId`, team names, sport, the six start-time fields `matchTime` / `chainStartTime` / `gameMatchTime` / `gameEarliestMatchTime` / `gameRundownMatchTime` / `gameSportspageMatchTime` (see **Contest start times** below), status, and a list of speculations. Each embedded speculation carries the same base shape as the `GET /v1/speculations` response (below): `speculationId`, `contestId`, `type` (`moneyline`/`spread`/`total`), `lineTicks` (raw int32, 10x format per the contracts), `line` (`lineTicks / 10`), `speculationStatus`, the settlement outcome `winSide` / `settledAt` / `voided` (see that section for the value set and the `speculationStatus === 1` ⟺ `winSide !== null` invariant), and for spread also `awayLine` / `homeLine`. The optional `closing` object that the `GET /v1/speculations` **list** endpoint attaches (below) is **not** present on embedded contest speculations.

The `window` filter and the result ordering both run on the same value served as `matchTime`, so a contest never appears in a window its own served start time falls outside. Contests with no on-chain start time yet (`unverified`) are excluded from this list, as they always have been.

Because the window bounds the *minimum*, a contest's listing lifetime is coupled to the odds feed as well as the chain: a `gameMatchTime` that moves into the past drops the contest out of this list even though its `chainStartTime` is still hours away. That is the intended fail-closed direction — a consumer stops quoting rather than quoting into a live game — but it does mean a bad feed value can retire a market early. `GET /v1/contests/:contestId` is unfiltered and still returns the contest, with all six fields, for anyone who needs to tell the two cases apart.

#### Contest start times

Every contest-shaped body — `GET /v1/contests`, `GET /v1/contests?since=`, `GET /v1/stream/contests`, `GET /v1/contests/:contestId`, and the `contest` block on `GET /v1/speculations/:speculationId` — carries six time fields. All six are ISO-8601 UTC strings, or `""` when the underlying value is null.

| Field | What it is |
|---|---|
| `matchTime` | **The current conservative start-time safety bound** — a bounded minimum over **five** inputs: `chainStartTime`, `gameMatchTime`, the game's current retained safety floor (served alongside as `gameEarliestMatchTime`), and the two provider snapshots (served alongside as `gameRundownMatchTime` / `gameSportspageMatchTime`), each snapshot admitted only while within **one hour below** `gameMatchTime`. It is **not a prediction of first pitch**. Gate on this. `<= chainStartTime` whenever `chainStartTime` is non-empty (see the ordering guarantee below), so off-chain gating is never more permissive than the protocol's own on-chain gates. |
| `chainStartTime` | The value written on-chain at verification (TheRundown's `event_date`), mirrored into `contests.start_time`. This is what the protocol's own leaderboard / live-betting gates compare against. `""` until the contest is verified; once set, the protocol never rewrites it. |
| `gameMatchTime` | The odds-feed (JsonOdds) schedule for the same game, which tracks reschedules **in both directions**. `""` when no game row is linked. |
| `gameEarliestMatchTime` | The game's **current retained safety floor** (`games.earliest_match_time`), served **verbatim** — never clamped. `""` when no game row is linked. When it is the minimum of the inputs, it is what is driving `matchTime`. Exactly one value is retained — it is not a history (see below). |
| `gameRundownMatchTime` / `gameSportspageMatchTime` | The enrichment providers' start-time **snapshots** (`games.rundown_match_time` / `games.sportspage_match_time`), served **verbatim**. Dated observations, not live values — captured when the provider id was claimed, re-observed after absorbed feed moves, nulled on id release. They enter `matchTime` only through the view's **one-hour read-time freshness guard**, so a served snapshot far below `matchTime` is stale and deliberately **not** driving the bound. `""` when no game row is linked or no snapshot has been captured. |

###### The third input: a retained safety floor, and why `matchTime` can sit below both published fields

`gameMatchTime` is mutable in both directions, so on its own it cannot hold a safety bound: a feed that moves a start earlier and then moves it back would let `matchTime` **rise again**, and a gate that had already opened would close. The protocol indexer's schema therefore maintains a per-game **current retained safety floor**, and `matchTime` takes the minimum over it as well.

**Read that guarantee at its actual width.** What the schema enforces is that *ordinary schedule writes* cannot raise the floor — a trigger recomputes it from the prior value on any write that touches `match_time`. It is **not** an absolute:

- an explicit **operator remedy** — a floor-only update — *can* raise it, and exists precisely so a bad observation can be corrected;
- because of that remedy, `gameEarliestMatchTime <= gameMatchTime` is **not** an invariant: the served floor can sit **above** the served schedule, and it is served verbatim either way — do not assert otherwise. `matchTime` keeps tracking the lower inputs in that shape;
- an insert may supply the initial floor, and a delete-then-reinsert reseeds it;
- exactly **one** value is retained. It is **not** a history of every start this game has ever been scheduled at.

**Every input to the minimum is served raw**, which keeps a below-both `matchTime` explicable from the body alone: `matchTime` can sit **strictly less than both `chainStartTime` and `gameMatchTime`**, and the body identifies the driver — it is whichever served lower input **equals** the served `matchTime`. Two classes of input — three candidate fields — can produce that shape:

- `gameEarliestMatchTime` equals it → the retained floor is driving, typically after a feed rollback the bound is deliberately refusing to follow back up;
- `gameRundownMatchTime` or `gameSportspageMatchTime` equals it → a **fresh provider snapshot** (within its one-hour window below `gameMatchTime`) is driving, while the floor can remain higher. Do **not** infer from a below-both `matchTime` that the floor equals it — that inference broke when the snapshot inputs landed.

Either way the consumer reading is the same: **the input equal to `matchTime` is currently the minimum.** That proves nothing about when or why the schedule moved and does not establish that any particular earlier start was ever observed. Do **not** infer that `gameMatchTime` is the authoritative value to gate on — `matchTime` is.

The floor closes the rollback hole; the provider snapshots add the second-provider signal it could not see (a start that moved earlier — or was always earlier — without the odds feed noticing). A provider that moves its time while the odds feed holds still is re-observed only on the writer's schedule, so the snapshots remain dated observations, not live values.

A recorded start time is a **prediction**, not ground truth — real first pitch drifts in both directions, and a game that moves *earlier* than the frozen on-chain value would otherwise leave every "has it started?" check reading a time in the future. Serving the minimum is a safety rule, not a truth-recovery rule: it does not claim to know the true start; it serves the bounded minimum of the current retained inputs described above. Anyone who wants the last pre-game minutes on a contest whose feed time moved can read `chainStartTime` and decide for themselves.

##### The ordering guarantee, and its one exception

`matchTime <= chainStartTime` holds **whenever `chainStartTime` is non-empty**. It is **not** unconditional.

`contests.start_time` is null between contest creation and contest verification — a window every contest passes through — so an **unverified** contest that already has a linked game row serves `chainStartTime: ""` next to a non-empty `matchTime`. A naive `matchTime <= chainStartTime` string comparison is `false` for exactly that window. `GET /v1/contests` (the list) excludes those rows, but the detail, `?since=` recovery, and `/v1/stream/contests` surfaces do **not**. Write the check as:

```
chainStartTime === '' || matchTime <= chainStartTime
```

Both values are ISO-8601 `…Z`, so lexicographic comparison equals chronological comparison and no date parsing is needed — which is also the safer choice, since `Date.parse` truncates the underlying `timestamptz` to milliseconds.

The minimum is computed in Postgres by the `contests_effective` view (a bounded `LEAST` over the contest's start time, the game's schedule, **the game's current retained safety floor**, and the two provider snapshots behind their one-hour freshness guard, across a `contests` → `games` join on `(network, jsonodds_id)` — never on the `games.contest_id` back-pointer, which is not unique per contest), so it arrives in the same row read that produces the rest of the body. Every contest-shaped read in this service goes through that view; it is owned by the protocol indexer's schema and must exist before this service is deployed.

##### Convergence when only the game moves

Because `matchTime` derives partly from `games.match_time`, a reschedule can change a contest's served start time without any on-chain contest write. `GET /v1/contests?since=` and `GET /v1/stream/contests` are keyset-cursored on `contests.row_updated_at`, so that change is delivered only if the cursor advances with it — and nothing in this service can make it.

The close is a write-side one, owned by the protocol indexer's schema: per-column triggers that advance the linked contest's `row_updated_at` when a projected `games` column changes. Three cover the four projected columns. The `match_time` trigger handles ordinary schedule writes (which also move the floor, so schedule movement and the floor movement it causes arrive together). The floor-column companion closes a narrower gap: a **floor-only** update (the operator remedy), which touches no `match_time`. And the snapshot-column trigger covers the writer's provider-snapshot writes — id claims, releases, and post-move re-observations — which name neither of the other columns yet can move both the served raw fields and, through the freshness guard, `matchTime` itself. **Where those migrations are applied**, a game-only change surfaces as an ordinary contest delta on both surfaces; this service needs no change for it. Operators running against a database without them should read the paragraph below before relying on a cursor to converge a start time.

The triggers key on the projected columns specifically, not on `games.row_updated_at` — that column is bumped by many writes with no contest-visible effect (odds flags, probable pitchers, final scores), each of which would otherwise re-deliver the contest row.

Against a database where those migrations have not been applied, reads are still correct — every response computes `matchTime` from the view at read time — but a cursor-based subscriber can miss a game-only change until an unrelated contest-row update or a cold snapshot.

Touching the contest row also reaches `/v1/stream/own-state`, which advances its position-status cursor on a derived `sourceUpdatedAt = max(positions, speculations, contests).row_updated_at`. An owner therefore gets a re-emitted `positionStatus` event for the affected positions on a reschedule. Note what that event does and does not carry: `positionStatus` has no start-time field, so it is a prompt to re-read the contest, not the new time itself.

> **Name collision — `/v1/contests.matchTime` and `/v1/games.matchTime` are both conservative derived bounds, computed over different input sets.** Both endpoints serve a `matchTime` that is a minimum over their raw fields — but the contest surfaces minimise over the on-chain `chainStartTime` as well, while `/v1/games` (whose rows precede any contest) has no chain input. The two are therefore still not equality-comparable across endpoints. Compare raw with raw: contest `gameMatchTime` against `/v1/games.gameMatchTime`, and contest `gameEarliestMatchTime` against `/v1/games.earliestMatchTime` — the same underlying columns; note the null encodings differ (`""` on contest surfaces, `null` on `/v1/games`).

### `GET /v1/contests/:contestId`

Single contest detail. Returns the same shape as a list item, plus an `orderbook` array on each speculation populated with currently fillable commitments. Same default filter as `GET /v1/commitments` (status `open` or `partially_filled`, not invalidated, not expired); each entry has the same wire shape as a commitment from `GET /v1/commitments`. Sorted by `createdAt` ascending; price-aware sorting is a follow-up. The list endpoint `GET /v1/contests` does not populate orderbooks.

Detail-only fields surfaced here (omitted on list rows): `jsonoddsId`, `rundownId`, `sportspageId`, `contestCreator`, `leagueId`, `awayScore`, `homeScore`, `contestCreatedAt`, `verifiedAt`, `scoredAt`, `voidedAt`, plus `awayTeamId` / `homeTeamId` (UUIDs from the `teams` table, resolved via `contests.network + jsonodds_id → games.{home_team_id, away_team_id}`; null when no game linkage exists). The team UUIDs are consumed by `@ospex/sdk`'s resolver layer to scope alias matching to a contest's two teams.

### `GET /v1/contests/:contestId/odds`

Current upstream reference odds for the contest's underlying game. One snapshot read of `current_odds` keyed by the contest's `jsonodds_id`. Distinct from the Realtime subscribe path on the SDK side (`client.odds.subscribe(...)`) — the snapshot is "what are the odds right now?", subscribe is "stream me changes."

**Source labelling**: this is upstream/reference odds (what the broader market is pricing the game at, via `ospex-writer`), NOT Ospex liquidity. Consumers should label it that way to users — the SDK + CLI surfacing this endpoint do.

Response shape:

```jsonc
{
  "contestId": "42",
  "jsonoddsId": "jo-abc-123",  // null when contest has no upstream linkage
  "odds": {
    "moneyline": { "market": "moneyline", "awayOddsAmerican": 145, "homeOddsAmerican": -180,
                   "upstreamLastUpdated": "...", "pollCapturedAt": "...", "changedAt": "..." } | null,
    "spread":    { "market": "spread", "awayLine": 3.5, "homeLine": -3.5,
                   "awayOddsAmerican": -110, "homeOddsAmerican": -110, ...timestamps } | null,
    "total":     { "market": "total", "line": 8.5,
                   "overOddsAmerican": -105, "underOddsAmerican": -115, ...timestamps } | null
  }
}
```

**Per-market shapes are explicit** so callers can't misread the semantics:

- **moneyline** carries `awayOddsAmerican` / `homeOddsAmerican` only. No `line` field — moneyline is line-less.
- **spread** carries both `awayLine` and `homeLine` — they're always negations of each other (`awayLine = -homeLine`). No generic un-labelled `line` field, because the writer's raw `current_odds.line` column stores the *home* team's spread (negative if home favored), and a single un-labelled value would let callers misalign with `/v1/contests/:contestId` (which exposes both `awayLine` and `homeLine` on each speculation row) or `/v1/analytics/odds-history`.
- **total** carries `line` (over/under threshold, perspective-neutral) and `overOddsAmerican` / `underOddsAmerican`. The writer's storage convention (Over → `away_odds_american`, Under → `home_odds_american`) is hidden — consumers don't see away/home naming on total markets.

**Status codes**:

| Status | Condition |
|---|---|
| 200 (full) | Contest exists, has `jsonoddsId`, `current_odds` has all three markets populated |
| 200 (partial) | Some markets `null` because the writer hasn't populated them for this game |
| 200 (all `null`) | Contest exists but has no upstream `jsonoddsId` linkage, OR no `current_odds` rows for this game |
| 404 | Contest does not exist |
| 400 | `contestId` is non-numeric |
| 500 | `contests` or `current_odds` query errored (logged with `contestId` + `jsonoddsId`) |

`network` is implicit (the API is deployment-bound to one network) and is not duplicated on each market entry. `jsonoddsId` is at the top level only — a snapshot is for one game, so per-market repetition would be noise.

### `GET /v1/speculations`

List speculations across one or more contests.

Query params:

| Name | What it does |
|---|---|
| `contestId` | optional. Fast path — single-table query keyed on the indexed `contest_id` column. |
| `sport` | optional, one of `nba`/`nhl`/`ncaab`/`nfl`/`mlb`. Slower path: resolves to a contest_id list via the `contests` table first. |
| `status` | optional, `open` or `closed`. Filters on `speculations.speculation_status`. |
| `limit` | optional, default 100, max 500. |
| `offset` | optional, default 0. |

Response: `{ speculations: Speculation[], pagination }`. Each `Speculation` carries `speculationId`, `contestId`, `type`, `lineTicks`, `line`, `speculationStatus`, the settlement outcome `winSide` / `settledAt` / `voided`, (for spread) `awayLine`/`homeLine`, and — **on this list endpoint only** — an optional `closing` object (the no-vig fair closing line for CLV; see **Closing line** below). List rows do NOT include `orderbook` — fetch the detail endpoint for that.

Settlement fields:

- `speculationStatus` — `0` = open (taking commitments), `1` = closed (settled on-chain via `settleSpeculation`). Maps directly from `speculations.speculation_status`, which flips to `closed` only at settle time — never at contest-score time.
- `winSide` — the settled outcome, or `null` while open. One of `away`/`home` (moneyline, spread), `over`/`under` (total), `push`, or `void`. This is the authoritative on-chain `WinSide`; for spread/total/push/void it cannot be recomputed client-side from scores alone. **Invariant: `speculationStatus === 1` ⟺ `winSide !== null`** — both are projected from the same atomic row (the indexer writes `speculation_status` + `win_side` + `settled_at` in one UPDATE), so a closed speculation always carries its winner.
- `settledAt` — ISO timestamp of the on-chain settlement, or `null` while open.
- `voided` — `true` iff the speculation settled to `void` (equivalently `winSide === 'void'`); surfaced explicitly so consumers needn't special-case the enum value.

(`scoredAt` is a contest-level field — read it from `GET /v1/contests/:contestId` (`scoredAt`), not the speculation.)

**Closing line (`closing`)** — optional, **list endpoint only**. When a servable closing line exists for the speculation's market (the materialized `closing_lines` table, written by `ospex-writer` — `fresh` *and* not polled past its own lock; see the conditions below), the row carries:

```jsonc
"closing": {
  "awayDecimal": 1.96078,  // no-vig fair closing decimal, away/over side (upper, positionType 0) = 1 / away_p_novig
  "homeDecimal": 2.04082,  // no-vig fair closing decimal, home/under side (lower, positionType 1)
  "line": null,            // the line the market closed at (null for moneyline)
  "estimated": false       // true if a side was push-probability-derived; currently ALWAYS false
}
```

Both sides are the de-vig'd fair close (their implied probabilities sum to 1). Consumers derive CLV by comparing a taker's actual transacted price to the fair closing decimal for their side.

- **Absent** when no servable closing line exists for the market, and when the enrichment fetch fails (best-effort: the speculations read still succeeds either way).

  A row is served only if it is `confidence='fresh'` **and** it clears the same **timing-admissibility** contract `ospex-benchmark`'s CLV scorer applies. That contract is a validation step followed by two verdicts, in this order:

  1. **Timing evidence must be usable.** A `fresh` row must carry all three of `value_captured_at`, `last_polled_at` and `poll_gap_seconds`; every instant must be **offset-qualified** (`Z` or `±hh:mm`); and `poll_gap_seconds` must agree with `lock_time - last_polled_at` within 1000 ms. A row failing any of these is withheld (scorer: `close_timing_unusable`) — it establishes nothing, so no verdict is read off it.
  2. **Not polled past its own lock** — `last_polled_at` at or after `lock_time` by ≥ 1000 ms means the feed was still quoting past the recorded start (scorer: `close_after_start`).
  3. **Value not captured past the lock** — `value_captured_at > lock_time`, strictly, with no tolerance (scorer: `close_value_after_lock`).

  The offset requirement is not cosmetic: an offsetless timestamp is read by `Date.parse` in the **server's local zone**, so the same row could produce different public verdicts on different hosts. Requiring the offset removes the question.

  Why any of this exists: `confidence` applies only an *upper* bound on the writer's poll gap, so a market polled *after* its lock still classifies `fresh`. The scorer refuses those independently, so serving them made this API the more permissive of two CLV surfaces over the same data — 147 rows, 4.05%, on the corpus measured 2026-07-31.

  Ported as the full **timing** contract rather than its final comparison — copying only the last step reproduces the scorer's answer for well-formed rows and silently disagrees on every malformed one. The instant validator's accept set is verified against the scorer's by differential probe over 120,328 inputs, zero disagreements in either direction.

  **Scope, stated precisely:** this is timing-admissibility parity, **not** complete scorer admissibility. The scorer applies further refusals that are not ported — notably its quote-consistency check, which refuses a close whose two no-vig probabilities do not cohere. A row can therefore be served here and still be refused by the scorer on a non-timing ground. Extending to quote consistency is separate work.

  This is a **reduction in served data, not a contract change** — `closing` was already optional, and a withheld market renders as "CLV not yet measurable" exactly as an uncaptured one does. Each refusal is logged under its own reason.

- For a **spread/total whose line moved** off the speculation's line, `closing` is present but `awayDecimal` / `homeDecimal` are `null` (the price isn't resolvable at the speculation's line; a push-probability estimate is deferred). `line` still reports what the market closed at.
- Moneyline has no line, so it always resolves when a `fresh` row exists.
- **Only** this list endpoint attaches `closing`. It is NOT present on `GET /v1/speculations/:speculationId`, the `?since=` recovery mode, the SSE stream, or embedded contest speculations.

Reads `speculations.market_type` directly; does not depend on the `SCORER_*_ADDRESS` env vars.

### `GET /v1/speculations/:speculationId`

Single speculation detail with the orderbook of currently fillable commitments and a small parent-contest context block.

Response: `Speculation` (as above) plus:

- `orderbook: Array<CommitmentBody | CommitmentHiddenBody>` — same default filter as `GET /v1/commitments` (open/partially_filled, not invalidated, not expired), keyed on the speculation's `speculation_key`. In normal operation every entry is a full `CommitmentBody`; the union is defense-in-depth — a hidden row that ever slipped past the `book_visible=true` filter surfaces as a redacted body (`redacted: true`, `payloadAvailable: false`), matching the list/recovery/SSE redaction paths (see "Hidden-row redaction" above).
- `contest: { contestId, awayTeam, homeTeam, awayTeamId, homeTeamId, sport, matchTime, chainStartTime, gameMatchTime, gameEarliestMatchTime, gameRundownMatchTime, gameSportspageMatchTime, status }` — keeps the response useful without a second fetch. `awayTeamId` / `homeTeamId` are UUIDs from the `teams` table (resolved via the `games` join — null when no game linkage exists). The six start-time fields carry the same meanings as on `/v1/contests` (see **Contest start times** above): `matchTime` is the current conservative safety bound and the one to gate on; `chainStartTime` is the immutable on-chain value; `gameMatchTime` is the raw odds-feed schedule; `gameEarliestMatchTime` is the game's retained safety floor, served verbatim. Source hashes / scores / lifecycle timestamps stay on the contest detail endpoint.

### `GET /v1/protocol/info`

Static metadata: name, network, chainId, contract addresses (matchingModule, scorers), supported sports, fees.

Also carries a **`build`** block naming the git commit the running service was deployed from:

```json
"build": {
  "commit": "a60c919…",
  "commitUrl": "https://github.com/ospex-org/ospex-core-api/commit/a60c919…",
  "commitSource": "build",
  "releaseVersion": "v248",
  "releasedAt": "2026-07-09T19:10:00Z"
}
```

This lets a reader of the public repo confirm which source is live — follow `commitUrl` to the exact reviewed code, and check the commit sits on `main` — and spot deploy drift. It's a **self-reported build identifier, not a cryptographic proof** that the dyno runs unmodified code; it makes honest operation checkable and accidental staleness visible.

`commit` prefers `HEROKU_BUILD_COMMIT` (the current build SHA) and falls back to the **deprecated** `HEROKU_SLUG_COMMIT`, which can reflect the previously-running slug — `commitSource` (`"build"` | `"slug"`) says which was used, so `"slug"` is a signal to enable the build-metadata feature (below). `build` is `null` in local dev and until the Heroku dyno-metadata features are enabled; `releaseVersion`/`releasedAt` are `null` if unavailable.

### Position helpers

#### `GET /v1/positions/:address`

Paginated position history for a wallet. Returns positions with `riskAmountUSDC`, `profitAmountUSDC`, `claimed`, `positionType` (0|1), and totals (`totalCount`, `totalRiskUSDC`, `totalProfitUSDC`, `activeCount`).

Query params: `limit` (max 200), `offset`.

#### `GET /v1/positions/:address/status`

Returns the wallet's unclaimed positions split into three buckets:

- **`active`** — speculation still open AND parent contest not yet `Scored`. Nothing the user can do yet.
- **`pendingSettle`** — speculation still open but the parent contest's `contest_status = 'scored'` on-chain. Anyone can call `SpeculationModule.settleSpeculation(speculationId)` (permissionless) to finalize, after which the position becomes claimable. Predicted-loser rows are filtered out (settling them would just expose `NoPayout` on the subsequent `claimPosition`).
- **`claimable`** — speculation closed (already settled), position has non-zero expected payout.

Each entry has `positionId`, `speculationId`, `positionType`, `team`, `opponent`, `market`, `oddsDecimal`, `riskAmountUSDC`, `profitAmountUSDC`. **Claimable** entries also have `result` (`won`/`push`/`void`), `estimatedPayoutUSDC` (full precision, no rounding), and `estimatedPayoutWei6` (raw uint256-as-string). **PendingSettle** entries carry the same `result` / `estimatedPayoutUSDC` / `estimatedPayoutWei6` fields plus `predictedWinSide` (`away`/`home`/`over`/`under`/`push`) — derived off-chain by replaying the on-chain scorer logic against `contests.{away_score, home_score}` and `speculations.line_ticks`. Once `settleSpeculation` runs the on-chain `winSide` will match.

Top-level `totals` mirrors all three buckets:

| Field | What it sums |
|---|---|
| `activeCount` | rows in `active` |
| `pendingSettleCount` | rows in `pendingSettle` |
| `claimableCount` | rows in `claimable` |
| `estimatedPayoutUSDC` / `estimatedPayoutWei6` | claimable-only payouts (ready to sweep right now) |
| `pendingSettlePayoutUSDC` / `pendingSettlePayoutWei6` | pendingSettle-only predicted payouts (require an extra `settleSpeculation` call before they materialize) |

Wei6 totals are aggregated in bigint to avoid float-rounding loss across many rows; the USDC float is the bigint sum divided by 1e6. Capped at 200 unclaimed positions per address.

Filtering matches the contract exactly: `claimPosition` reverts with `PositionModule__NoPayout` when `riskAmount == 0 || payout == 0`. The filter is done in wei6 (bigint), so sub-cent payouts that ARE claimable on-chain still appear in the response. Lost positions are excluded (the contract would revert with `NoPayout`); positions on still-open speculations whose parent contest is not yet scored go in `active`. There is no `withdrawable` bucket — see note below.

This endpoint reads `speculations.market_type` and `contests.{contest_status, away_score, home_score}` directly (all populated by the indexer) and does not depend on the `SCORER_*_ADDRESS` env vars — those are only required for `POST /v1/commitments`.

#### `GET /v1/positions/:address/claim-params`

Returns ready-to-sign tx params for every claimable AND pendingSettle position. `claimPosition` takes `(speculationId, positionType)` — positions are uniquely identified by `(speculationId, user, positionType)`.

Same filter / market_type / scorer-replay semantics as `/status` above.

Response shape:

```json
{
  "address": "0x…",
  "positions": [
    {
      "positionId":           "42_0x…_0",
      "speculationId":        "42",
      "description":          "Lakers moneyline — Won (≈ $191.00)",
      "bucket":               "claimable",
      "result":               "won",
      "estimatedPayoutUSDC":  191,
      "estimatedPayoutWei6":  "191000000",
      "txParams": [
        { "method": "claimPosition", "target": "PositionModule",
          "args": { "speculationId": "42", "positionType": 0 } }
      ]
    },
    {
      "positionId":           "99_0x…_1",
      "speculationId":        "99",
      "description":          "Celtics moneyline — Won (≈ $50.00, needs settle)",
      "bucket":               "pendingSettle",
      "result":               "won",
      "estimatedPayoutUSDC":  50,
      "estimatedPayoutWei6":  "50000000",
      "txParams": [
        { "method": "settleSpeculation", "target": "SpeculationModule",
          "args": { "speculationId": "99" } },
        { "method": "claimPosition",     "target": "PositionModule",
          "args": { "speculationId": "99", "positionType": 1 } }
      ]
    }
  ]
}
```

`txParams` is **always an array** — `claimable` rows have a single `claimPosition` step; `pendingSettle` rows lead with `settleSpeculation` (permissionless, any EOA) and then `claimPosition`. Consumers MUST execute the steps in array order; later steps depend on earlier ones (a `claimPosition` call would revert with `NotSettled` if the preceding `settleSpeculation` hasn't yet landed). `target` is a stable label the consumer maps to the deployed contract address per chain — the API never returns raw contract addresses here so address rotations don't ripple through every consumer. Claimable rows are listed first (single tx, faster to execute), then pendingSettle rows.

The `description` field shows `"<$0.01"` for sub-cent expected payouts so it doesn't misleadingly round to `$0.00`. PendingSettle descriptions append `, needs settle` so the wording differentiates the two buckets when rendered in a CLI / dashboard.

#### `GET /v1/positions/by-tx/:txHash`

Parses the `PositionFilled(speculationId, maker, taker, makerPositionType, takerPositionType, makerRisk, takerRisk)` event from a tx receipt. Each fill creates **two** position rows (maker + taker) so the response returns both as a single array. If `POSITION_MODULE_ADDRESS` is set, only logs from that contract are decoded; otherwise any log matching the event topic is decoded.

Requires `ALCHEMY_RPC_URL`.

#### `GET /v1/positions/claim-result/:txHash`

Parses `PositionClaimed(speculationId, user, positionType, payout)`. Returns the speculation, user, position type, and payout (both as wei6 string and USDC float).

Requires `ALCHEMY_RPC_URL`.

#### Not ported — `/withdraw-params`, `/withdraw-result/:txHash`

The protocol has no `adjustUnmatchedPair` method or `PositionAdjusted` event. Positions are always fully matched at fill time, so "unmatched" lives on the `commitments` table instead of on a position.

The analog of "withdraw your unfilled stake" is therefore "cancel your open commitment" via `MatchingModule.cancelCommitment(commitment)`. Consumers can build that call directly from the existing `GET /v1/commitments?maker=…` response — every commitment row carries the 9 fields needed. So no helper endpoint is required. A future `GET /v1/commitments/cancel-result/:txHash` (parsing `CommitmentCancelled`) could be added if needed.

### `GET /v1/leaderboard`

Current active leaderboard (the soonest-ending one whose start has passed) with paginated, descending-by-bankroll registrations.

Query params: `limit` (max 500), `offset`.

### `GET /v1/schedule?sport=`

> ⚠ **Dormant — this endpoint returns an empty list for every sport.** It reads `current_schedules`, an ESPN-sourced table that stopped being refreshed: on production 2026-07-31 it holds 6,580 rows whose newest `game_date` is 2026-04-19 and whose newest `fetched_at` is 2026-04-15, and no writer in the project populates it. The window below is forward-only, so nothing falls inside it. Verified against the deployed service: `GET /v1/schedule?sport=nba` and `?sport=mlb` both return `{"games":[], "pagination":{"total":0,...}}`.
>
> This is recorded because an empty list is indistinguishable from "no games in the next 36 hours", which is an ordinary answer — a caller cannot tell a dormant endpoint from a quiet one. **Use `GET /v1/games` for a live schedule**; it is backed by the writer-managed `games` table.
>
> Its `gameDate` is also **not** subject to the `LEAST`-over-inputs rule the contest-shaped surfaces and `/v1/games` apply: it is a raw start from a different table and a different provider, with no monotone floor and no second input. It is deliberately left that way — retrofitting a floor onto a table nothing writes would be inventing a guarantee. Whether to repopulate or retire this endpoint is an open decision, not something to patch silently.

Upcoming games within `windowHours` (default 36, max 168). Returns games with team names resolved from the `teams` table.

Out of scope for this batch: best-effort merge with on-chain `contests` (so each game can flag whether it has a contest). Callers can cross-check by team-name against `GET /v1/contests` (or, for free-form input, use `GET /v1/teams/aliases` plus a contest's `awayTeamId` / `homeTeamId`).

### `GET /v1/teams/aliases`

Flat list of every row in the `team_aliases` table joined to canonical team metadata from the `teams` table. Network-agnostic — `team_aliases` and `teams` are sports-reference data shared across networks.

Closes the `resolveTeam` gap historically called out in this file. The legacy resolver was never migrated from the deprecated agent server; consumers (notably the SDK's commitment resolver layer) now read aliases from this endpoint instead of re-implementing it.

Query params:

| Name | What it does |
|---|---|
| `sport` | optional, one of `mlb`/`nba`/`ncaab`/`ncaaf`/`nfl`/`nhl`. Validated against the shared sport constant (`src/lib/sports.ts`). |
| `limit` | optional, default 1000, max 1000 (matches the underlying PostgREST per-request row cap). |
| `offset` | optional, default 0. |

Response:

```json
{
  "aliases": [
    {
      "teamId": "<uuid>",
      "sport": "nba",
      "sportId": 1,
      "teamName": "Los Angeles Lakers",
      "abbrev": "LAL",
      "alias": "Lakers",
      "aliasType": "nickname",
      "source": "manual"
    }
  ],
  "pagination": { "limit": 1000, "offset": 0, "total": 1846, "hasMore": true }
}
```

`team_aliases` stores `sport_id` (smallint) but not `sport` (text). The handler joins through `teams` so callers don't have to maintain their own sport_id ↔ sport mapping.

Pagination caveat: PostgREST returns at most 1000 rows per request, so `limit` is capped at 1000 — the table is ~1300+ rows, and a larger advertised limit would silently truncate while still echoing the requested limit in `pagination.limit`, causing naive `offset += pagination.limit` clients to skip rows. SDK consumers should paginate until `hasMore: false`.

### Cursor recovery reads

The catch-up side of the push contract. A client streams live deltas (SSE — see "SSE streams") and, after a disconnect, asks for everything after its last cursor. These reads are intentionally distinct from the open-book list/snapshot endpoints above.

- **Ordering** is keyset `(row_updated_at, id)` ascending — not offset. `row_updated_at` is trigger-maintained on every UPDATE, so a stored `open → filled/cancelled`, a `settleSpeculation`, or a `claimPosition` advances it and surfaces here. The `id` tie-breaker means same-millisecond updates are never skipped. For `contests`, where the indexer migration described under "Convergence when only the game moves" is applied, the cursor also advances on a game-only reschedule, so a changed `matchTime` converges even with no on-chain write.
- **Includes terminal rows.** Recovery does NOT apply the open-book `status`/`expiry`/`nonce_invalidated` defaults — a commitment that went `filled`/`cancelled`, or a speculation that `settled`, must surface so a client converges its local state.
- **Filters are identity/scope only** (e.g. `maker`, `contestId`, `scorer`, `speculationId`, `address`), not lifecycle-status.
- **Cursor is opaque.** Treat `nextCursor` as a blob and pass it back as `?since=`; it embeds the resource so a cursor from one stream can't be used on another (400 `INVALID_CURSOR`).
- **Convergence vs events.** For mutable rows (commitments/positions/speculations/contests) this is ordered state-delta *convergence* — a row that changed several times while you were away may surface only at its latest state. `position_fills` is the only append-only, event-like stream (`/v1/fills`), where every row is delivered; dedupe client-side on `(txHash, logIndex)`.
- **Resume vs paging (late-commit safety).** Cursors are kind-tagged. A `live` cursor — minted at the stream tail / snapshot tip — makes recovery re-scan an **overlap window**: it queries from `cursor.ts − overlap` (default 30s) so a row committed late under the `now()`-is-transaction-start schema isn't skipped on reconnect. Every `nextCursor` is a `page` cursor (strict keyset on its own `(row_updated_at, id)`), so paging through a backlog terminates regardless of overlap size. The id tie-breaker means same-millisecond rows are never skipped; the overlap re-scan can re-deliver a row already returned, so apply rows idempotently by natural key (commitment hash, speculation id, etc.).

Common response envelope: `{ <resource>: [...], nextCursor: string | null, hasMore: boolean }`. `hasMore` is true when a full `limit` page came back; an empty page echoes the input cursor so the client holds position. `limit` defaults to 100, max 1000.

| Endpoint | Resource | Filters (all optional) |
|---|---|---|
| `GET /v1/commitments?since=` | commitments | `maker`, `contestId`, `scorer`, `speculationId` |
| `GET /v1/positions?since=` | positions | `address`, `speculationId` |
| `GET /v1/fills` | position_fills (events) | `maker`, `taker`, `speculationId`, `contestId`, `commitmentHash` |
| `GET /v1/speculations?since=` | speculations | `contestId` |
| `GET /v1/contests?since=` | contests | `contestId` |

On the mutable-row endpoints, `?since=` *switches* the endpoint into recovery mode; without it they behave exactly as documented above (open-book list / window). `GET /v1/positions` (bare) and `GET /v1/fills` are recovery-native (cursor optional — absent means "from the beginning", paged).

### SSE streams

`GET /v1/stream/:resource` (`resource` ∈ `commitments | positions | fills | speculations | contests`) opens a [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream — the live, push side of the contract. One internal poller per resource fans deltas out to every connected client: many agents subscribe, but each resource is polled once per tick (the N→1 collapse that keeps a busy fleet off the DB).

Connect, e.g. `GET /v1/stream/fills?maker=0x…&cursor=<opaque>`:
- **Filters** (identity/scope, all optional) match the recovery table above — commitments: `maker`/`contestId`/`scorer`; positions: `address`/`speculationId`; fills: `maker`/`taker`/`speculationId`/`contestId`/`commitmentHash`; speculations/contests: `contestId`. (`speculationId` on commitments is recovery-REST-only.) Unknown `:resource` → 404.
- **`cursor`** (optional, opaque): the resume point. With it the server replays missed deltas (catch-up) before going live; without it, snapshot first via the REST endpoints, then stream.

Events:
- `event: delta` — `id:` is the opaque cursor; `data:` is the same body shape as the REST recovery/snapshot for that resource. (On `/v1/stream/commitments`, hidden rows arrive in the redacted allow-list projection — see the "Hidden-row redaction" subsection above; the data shape is allow-list-only for those rows.) The cursor is an **opaque resume token, not a version** — store the last `id` to reconnect, and never decode it. Deltas are **not ordered by cursor** (a row committed late under the `now()`-is-transaction-start watermark can arrive after a newer one), so apply **last-received-wins**: process deltas in the order received and overwrite per natural key. The poller re-reads current DB state every tick, so the most recently received delta for an entity reflects its most recent read — a late update is re-emitted by the overlap re-scan and supersedes the stale one because it arrives later. (`position_fills` is append-only — apply every event; dedupe by `(txHash, logIndex)`.)
- `event: ready` — **catch-up complete and this connection is live.** Emitted exactly once, and only on a clean handoff: catch-up finished AND no live delta or resync raced it. So at `ready` the client's state equals the DB state catch-up observed. A `resync` is never followed by `ready` on the same connection.
- `event: resync` (`data: { reason }`) — **re-snapshot.** Fires when: a reorg/backfill recovery completes upstream (recovery hard-deletes rows, which polling can't observe); the catch-up backlog was too large to replay; or **a live delta/resync raced the cursor catch-up** (`reason: "handoff_raced"`). On a raced handoff the server emits one `resync` and closes the connection — the client should re-snapshot and reconnect. (See "Reconnect".)
- `: hb` comment heartbeats (~20s) keep the connection under the platform idle timeout.

Operational notes:
- **Reconnect** with the last `id` you saw (a live cursor): a native `EventSource` resends it automatically as the `Last-Event-ID` header, or pass it as `?cursor=`. **`Last-Event-ID` takes precedence** over `?cursor=` — on an `EventSource` auto-reconnect the original URL's `?cursor=` is stale, while the header is the true resume point. The server replays missed deltas from there, re-scanning the overlap window so a row committed late under the `now()`-based schema isn't missed, then emits `ready`. **Under concurrent write activity** the cursor handoff conservatively aborts to `resync` rather than risk a stale-at-`ready` merge; on `resync` the client re-snapshots (REST) and reconnects (without a cursor, since the snapshot is current).
- SSE is **exempt from gzip** (compression buffers streams would defeat it) and from the request-rate limiter; a **concurrent-connection cap** (per-IP + total) bounds resource use instead — `429` when full. Of the per-IP budget, `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER` slots are reserved for the owner-auth own-state stream so anonymous (odds/protocol) saturation from one IP can't 429 a market-maker's safety-critical own-state reconnect. The caps are env-tunable (`MAX_STREAM_CONNECTIONS_TOTAL` / `MAX_STREAM_CONNECTIONS_PER_IP` / `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER`); the live values show on `GET /v1/metrics`.
- **Graceful shutdown.** On `SIGTERM`/`SIGINT` the server proactively ends open streams — protocol streams get a final `resync` (`reason: "server_shutdown"`) then close — so it drains fast instead of waiting out the shutdown timeout. Reconnect as usual.
- `position_fills` is append-only (every event delivered); the other four are state-delta convergence (latest state per row).
- Backed by the same `(network, row_updated_at, id)` indexes as the cursor-recovery reads — those indexes must exist before production stream traffic.

### Odds stream

`GET /v1/stream/odds?contestId=<numeric>&market=<moneyline|spread|total>` opens a Server-Sent Events stream of upstream reference odds for a contest's underlying game. Both query params are **required**. This is a separate route from the protocol `/v1/stream/:resource` streams because odds is **latest-state, not a durable log** — there's no cursor, no catch-up replay, and no `Last-Event-ID` resume. The server maintains one internal `current_odds` subscription for the whole process and fans out to every connected client (the N→1 collapse); that internal source stays server-side and the provider game id is **never** on the wire (it's resolved from `contestId` internally).

**Source labelling**: this is upstream/reference odds (what the broader market is pricing the game at, via `ospex-writer`), NOT Ospex liquidity — surface it to users that way.

Events:
- `event: snapshot` — `data: { contestId, market, odds }` where `odds` is the current per-market shape (same shapes as `GET /v1/contests/:contestId/odds` — moneyline / spread / total) or `null` when the writer hasn't populated that market (or the contest has no upstream linkage). It is the baseline you're live from, and is re-sent on recovery. **The server never emits a `change`/`refresh` before a `snapshot`** — if the baseline read fails it retries (staying behind a `degraded`) rather than streaming deltas without a baseline.
- `event: change` — `data: { contestId, market, odds }`. A genuine price move (a tracked column changed, or `changedAt` advanced).
- `event: refresh` — `data: { contestId, market, odds }`. The writer re-polled and saw no price change (liveness). Usually you only care about `change`.
- `event: degraded` — `data: { reason }`. The internal source is behind/unavailable; updates are paused. It can arrive **before** any snapshot (the source was down at connect — you get no baseline until it recovers) or after (the source dropped). The connection stays open; on recovery the server sends a fresh `snapshot` (which fully resyncs, since odds is latest-state) and resumes live.
- `: hb` comment heartbeats (~20s).

Apply semantics:
- **No cursor** — there's no `id:` on these events; don't try to resume with `Last-Event-ID`. On any disconnect, just reconnect; the new connection re-snapshots.
- **Latest-state convergence** — the server only emits a delta whose `pollCapturedAt` is strictly newer than the last one emitted for this stream, so duplicates and out-of-order delivery are already filtered. Treat each `change`/`refresh`/`snapshot` as the current value for `(contestId, market)`.
- Unknown `market` (or non-numeric `contestId`) → `400`; unknown contest → `404`; both *before* the stream opens.
- Same gzip exemption and concurrent-connection cap as the protocol streams (shared budget; `429` when full).
- **Graceful shutdown.** On `SIGTERM`/`SIGINT` the server ends the stream with a final `: server_shutdown` comment (no event — odds is latest-state, so there's no protocol `resync`) then closes. Reconnect re-snapshots as usual.

### `GET /v1/metrics`

Operational counters for the SSE subsystem, surfaced as JSON. Kept separate from `/readyz` so readiness stays a pure up/down dependency check; this is the "how loaded is the stream stack" view. Read-rate-limited like the other `GET /v1/*` endpoints.

```jsonc
{
  "stream": {
    "resources": 0, "subscribers": 0,                  // protocol-stream hub: active pollers + total subscribers
    "resyncBroadcastTotal": 0,                         // cumulative resync broadcasts (overlap-window overflow + recovery)
    "catchupStartedTotal": 0,                          // cumulative SSE handler entries into the catchup phase
    "catchupCompletedTotal": 0,                        // cumulative clean handoffs (`ready` emitted)
    "catchupResyncedTotal": 0                          // cumulative catchup → resync exits (started - completed - resynced ≈ in-flight or disconnected mid-catchup)
  },
  "odds": {
    "subscribers": 0, "channelOpen": false, "subscribed": false, "degraded": false,
    "channelDegradedTotal": 0,                         // cumulative Realtime channel-down events (gated by !degraded; one bump per outage)
    "hardResetTotal": 0                                // cumulative hard-reset backstops fired
  },
  "ownState": {
    "wallets": 0,                                      // own-state hub: active per-wallet pollers
    "subscribers": 0,                                  // total owner-auth own-state subscribers
    "resyncBroadcastTotal": 0                          // cumulative own-state resync broadcasts (overlap-window overflow + recovery)
  },
  "connections": {
    "total": 0, "ips": 0, "maxTotal": 200, "maxPerIp": 10,
    "rejectedTotal": 0,                                // cumulative 429s
    "rejectedByScope": { "ip": 0, "total": 0 },        // 429s split by limiting scope
    "slowClientShedTotal": 0                           // cumulative connections ended for backpressure (outbound buffer > MAX_PENDING_BYTES)
  },
  "uptimeSeconds": 0,
  "timestamp": "..."
}
```

All counters are **process-local and cumulative since process start** (reset on restart) — on a multi-dyno deploy, scrape each dyno rather than going through the load balancer. `connections.maxTotal` / `maxPerIp` echo the active caps (defaults, or the `MAX_STREAM_CONNECTIONS_*` overrides).

## Scripts

| Script | What it does |
|---|---|
| `yarn dev` | Watch + reload via `tsx`, reads `.env` automatically |
| `yarn build` | `tsc` → `dist/` |
| `yarn start` | `node dist/server.js` (production / Heroku) |
| `yarn typecheck` | `tsc --noEmit` |
| `yarn typecheck:tests` | `tsc --noEmit -p tsconfig.tests.json` — typechecks `tests/` as well as `src/`. Reporting-only; see below |
| `yarn lint` | ESLint over `src/` |

### Typechecking the test tree

`yarn typecheck` and the Heroku release build both compile `tsconfig.json`, whose `include` is `["src"]` — so nothing under `tests/` was ever typechecked. Vitest does not close the gap either: it transpiles through esbuild, which strips types without checking them. The result was that a test file could carry an outright type error and still sail through `typecheck`, `build`, `lint` and the suite itself.

`yarn typecheck:tests` compiles `tsconfig.tests.json`, which extends the base config and includes **both** `src` and `tests` — the tests import from `src`, so `src` has to be in the program. It inherits `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` unchanged; the only overrides are `noEmit`, the three emit-related options it turns off, and a `rootDir` widened to the repo root so `tests/` is admissible at all.

**It is reporting-only, and it must stay that way.** It is deliberately not wired into `test`, `build`, `typecheck`, `prepare`, CI, or any git hook, and it should not become a required check. Run it when you touch tests, read what it reports, and keep going — a type error in a test file blocks nothing by itself. The test suite and review are what gate a merge.

## Environment

See `.env.example`. Required values are validated at boot — missing vars exit with `code 1` immediately, not on first request.

| Var | Required | Notes |
|---|---|---|
| `PORT` | no | Defaults to 3000 |
| `NODE_ENV` | no | Defaults to `development` |
| `LOG_LEVEL` | no | Defaults to `info` (pino levels) |
| `NETWORK` | no | `polygon` or `amoy`, defaults to `polygon` |
| `SUPABASE_URL` | **yes** | |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Bypasses RLS — see conventions |
| `ALCHEMY_RPC_URL` | for `/v1/positions/by-tx/:txHash` and `/v1/positions/claim-result/:txHash` | Polygon RPC endpoint for tx-receipt parsing |
| `MATCHING_MODULE_ADDRESS` | for `POST /v1/commitments` | EIP-712 `verifyingContract`. Format-validated when set. |
| `POSITION_MODULE_ADDRESS` | optional | Defensive log-source filter for tx parsers. When set, by-tx / claim-result only decode logs from this address. Format-validated when set. |
| `SCORER_MONEYLINE_ADDRESS` | for `POST /v1/commitments` | All-or-nothing; partial config rejected at boot |
| `SCORER_SPREAD_ADDRESS` | for `POST /v1/commitments` | |
| `SCORER_TOTAL_ADDRESS` | for `POST /v1/commitments` | |
| `MAX_STREAM_CONNECTIONS_TOTAL` | no | Max concurrent SSE streams process-wide. Positive integer; defaults to 200. Surfaced on `/v1/metrics`. |
| `MAX_STREAM_CONNECTIONS_PER_IP` | no | Max concurrent SSE streams per client IP. Positive integer; defaults to 16. Surfaced on `/v1/metrics`. |
| `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER` | no | Of the per-IP budget, slots reserved for the owner-auth own-state stream — anonymous streams may use at most `(PER_IP - this)`; own-state may use the full `PER_IP`. **Non-negative integer (`0` is allowed** = no reserve / original single shared pool, anon + own-state share the full `PER_IP`); defaults to 3. Surfaced on `/v1/metrics`. |

## Deployment

Heroku app: `ospex-core-api`. Production URL: `https://ospex-core-api-195f635df864.herokuapp.com/`.

Procfile: `web: node dist/server.js`. Heroku auto-runs `yarn build` (`tsc` → `dist/`) on slug compile.

**Deploy provenance.** The `build` block on `GET /v1/protocol/info` reports the running commit. It is populated from Heroku's dyno-metadata labs features — enable **both** once:

```
heroku labs:enable runtime-dyno-build-metadata --app ospex-core-api   # HEROKU_BUILD_COMMIT (current)
heroku labs:enable runtime-dyno-metadata --app ospex-core-api         # HEROKU_RELEASE_VERSION / _CREATED_AT
```

`runtime-dyno-build-metadata` provides `HEROKU_BUILD_COMMIT`, the current, correct build SHA (Heroku deprecated `HEROKU_SLUG_COMMIT`, which `runtime-dyno-metadata` still emits and the endpoint uses only as a labeled fallback). `runtime-dyno-metadata` provides the release version + timestamp. All are build identifiers injected at dyno boot, not secrets. Until the build-metadata feature is enabled the response shows `commitSource: "slug"` (or `build: null` if neither feature is on) — no other endpoint is affected.

### Required Heroku config vars

Set via `heroku config:set <var>=<value> --app ospex-core-api`. Mirrors `.env.example`:

- `NETWORK` — `polygon` for production, `amoy` for testnet
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `ALCHEMY_RPC_URL` — Polygon mainnet RPC (PAYG-tier — required by `/v1/positions/by-tx` and `/v1/positions/claim-result`)
- `MATCHING_MODULE_ADDRESS` — the deployed `MatchingModule`; verifying contract for the EIP-712 domain on `POST /v1/commitments` and `DELETE /v1/commitments/:hash`, **and** reused as the verifying contract of the separate `OspexStreamAuth` domain (see `STREAM_AUTH_*` below). The stream-auth endpoints return `503 NOT_READY` if this is unset
- `SCORER_MONEYLINE_ADDRESS`, `SCORER_SPREAD_ADDRESS`, `SCORER_TOTAL_ADDRESS` — required by `POST /v1/commitments` (all-or-nothing; partial config is rejected at boot)
- `POSITION_MODULE_ADDRESS` — optional defensive log-source filter for tx parsers
- `MAX_STREAM_CONNECTIONS_TOTAL`, `MAX_STREAM_CONNECTIONS_PER_IP`, `RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER` — optional SSE concurrent-connection caps (defaults 200 / 16 / 3); per-IP is per egress host. Co-locating N market makers must satisfy BOTH per-IP constraints: `N·(odds channels + 1) ≤ PER_IP` (overall) **and** `N·(odds channels) ≤ PER_IP − RESERVED` (anonymous odds — usually the binding one, since the reserve shrinks the anon budget below the total cap). E.g. PER_IP=16, reserve=3, N=2, odds=7 passes the overall check (16 ≤ 16) but fails anon (14 > 13), so core-api 429s the 14th odds stream — raise `PER_IP`. The owner-auth reserve keeps anonymous saturation from 429-ing a maker's own-state reconnect (`RESERVED=0` disables it = single shared pool). Set any to tune the stream stack without a code change
- `REDACT_HIDDEN_PUBLIC` — optional bool, **default `true`** (redaction enforced). Short-lived rollout/rollback guard for hidden-row redaction. Setting `false` reverts every anonymous read path to the legacy "full body for all rows" behavior, for a deploy window only; the flag is scheduled for removal once the redaction rollout has soaked
- `STREAM_AUTH_HMAC_SECRET` — optional but required by **both** stream-auth POST endpoints AND the `verifyStreamToken` middleware (each returns `503 NOT_READY` if unset). HMAC-SHA256 secret used to sign + verify stream-auth bearer tokens; must be ≥ 32 characters of entropy (boot-time fatal otherwise). Rotation = add a second key and accept both during transition (follow-up; current `kid` is `v1`)
- `STREAM_AUTH_AUDIENCE` — optional but required by both stream-auth POST endpoints (same `503 NOT_READY` rule). The canonical host string bound into both the challenge typed-data and the issued token (e.g. `https://api.ospex.org`); SDK clients derive the same string from their `baseUrl`, so a token minted for one deployment cannot be replayed against another
- `STREAM_CHALLENGE_TTL_SECONDS` — optional, default `180` (3 min). Lifetime of a single-use challenge; **boot-fatal outside [120, 300]** (2–5 min)
- `STREAM_TOKEN_TTL_SECONDS` — optional, default `900` (15 min). Lifetime of an issued bearer token; **boot-fatal outside [60, 1800]**
- `OWN_STATE_SNAPSHOT_MAX_COMMITMENTS` — optional, default `5000`. Per-page commitments cap for `GET /v1/own-state/snapshot`; **boot-fatal outside [100, 50000]**. SDK pages with `?cursor=` until the response carries `truncated: false`

The stream-auth challenge store is **in-memory, per-process**. A challenge minted on one dyno cannot be consumed on another — fine for the current single-dyno Heroku deployment, but horizontal scale-out requires moving challenges to Redis/Postgres or running with sticky routing first. The endpoint-level `503 NOT_READY` checks are deliberately separate from `/readyz` (next section) — `/readyz` keeps the meaning "the always-required dependencies are reachable", and stream-auth is opt-in at the operator level.

`NODE_ENV=production` and `LOG_LEVEL=info` are recommended. **Do not set `PORT`** — Heroku injects it; setting it as a config var creates a binding mismatch.

### Post-deploy smoke test

```bash
URL=https://ospex-core-api-195f635df864.herokuapp.com
curl -s "$URL/healthz"            # 200 + service / network / chainId
curl -s "$URL/readyz"              # 200 only when supabase.connected, contestsView.present and commitments.configured
curl -s "$URL/v1/protocol/info"    # mainnet contract addresses
curl -s "$URL/v1/contests"         # paginated list (empty until indexer ingests data)
```

`/readyz` checks the always-required dependencies: Supabase reachability, presence of the `contests_effective` view, and EIP-712 relay env config for `POST /v1/commitments`. The view is reported as its own `contestsView: { present, error? }` block rather than folded into `supabase` — it is created by a migration in the protocol indexer's schema, so it can be missing while Postgres is perfectly healthy, and every contest-shaped read depends on it. A PostgREST "relation not found" response therefore reports `supabase.connected: true` and `contestsView.present: false`, and readiness fails on the second term.

The view probe is a row-less **GET**, and it treats only a returned rows array as proof of presence. Both details are load-bearing: a HEAD response carries no body, and the Supabase client rewrites a body-less 404 into `204` with **no error** — so a HEAD probe, or any probe that infers success from a null error, reports the view present when it is absent. Anything other than a rows array fails closed. One residual is documented rather than defended: the same client turns a 404 whose body is a JSON *array* into an exact copy of the success envelope, which no check on the returned value can detect. PostgREST never emits that shape, so it takes a misbehaving intermediary to produce — but a probe reading the raw HTTP status, rather than the client's envelope, is what would close it. Note also that when Supabase is unreachable the client retries idempotent requests three times with backoff, so `/readyz` can take ~7s to answer during an outage; size platform readiness timeouts accordingly. It does **not** include stream-auth readiness — those endpoints are opt-in at the operator level and surface their own `503 NOT_READY` per call when `STREAM_AUTH_HMAC_SECRET` / `STREAM_AUTH_AUDIENCE` / `MATCHING_MODULE_ADDRESS` are unset.

## Project conventions

- **Supabase only** — no Firebase, no Firestore, no `firebase-admin`. The `package.json` has zero firebase deps and any PR adding one should be rejected at review.
- **No data-source smuggling** — handlers and their helpers must read from the same data layer. Don't repeat the legacy `positionFetch.ts` pattern where a Supabase-looking handler quietly called a Firestore helper.
- **Network-scoped queries** — every Supabase query that hits a network-partitioned table must filter `eq('network', NETWORK)`. Any table carrying a `network` column is network-partitioned.
- **Service-role key bypasses RLS** — the server uses `SUPABASE_SERVICE_ROLE_KEY`, which sees every column on every row. Handlers must explicitly select the public columns they intend to expose (`.select('id, name, ...')` not `.select('*')`) and never echo a row directly to the response. Treat raw row shape as private by default.
- **Strict TypeScript** — `any` is an error, unused vars are errors, console is an error (use the pino `logger`). Run `yarn typecheck` before merging.

## Layout

```
src/
  server.ts            # Express app + boot
  lib/
    env.ts             # boot-time env validation, typed Config
    supabase.ts        # lazy-init Supabase client
    logger.ts          # pino
    eip712.ts          # OspexCommitment schema, domain, verify, hash
    rpc.ts             # lazy ethers JsonRpcProvider
    sanitize.ts        # wei6ToUSDC, toISOString
    parseOdds.ts       # American / line parsers
    slugs.ts           # toSlug / fromSlug
    speculation.ts     # scorer ↔ market_type, lineTicksToLine (pure)
    txParams.ts        # numeric primitives for on-chain tx building
    cursor.ts          # opaque (table, row_updated_at, id) recovery cursor codec
    recovery.ts        # ?since= parse + nextCursor helpers for recovery reads
    oddsClassifier.ts  # current_odds change/refresh/none classifier (pure)
  middleware/
    asyncHandler.ts    # error-forwarding wrapper
    errorHandler.ts    # final 500 handler, ApiError shape
    eip712Auth.ts      # per-action signature verifier
    rateLimit.ts       # express-rate-limit instances
  v1/
    router.ts          # versioned router
    commitments.ts     # POST + GET /v1/commitments
    contests.ts        # GET /v1/contests, /:contestId
    speculations.ts    # GET /v1/speculations, /:speculationId
    protocol.ts        # GET /v1/protocol/info
    auth.ts            # GET /v1/auth/domain — EIP-712 self-discovery
    config.ts          # GET /v1/config/public — publishable client bootstrap
    metrics.ts         # GET /v1/metrics — stream/odds/own-state/connection counters
    positions.ts       # GET /v1/positions (recovery) + /:address + /status,
                       #   /claim-params, /by-tx/:txHash, /claim-result/:txHash
    fills.ts           # GET /v1/fills — append-only fill event recovery
    stream/            # GET /v1/stream/* — SSE
      handler.ts       #   protocol handoff state machine: cap → subscribe → catch-up → (clean? ready : resync)
      hub.ts           #   per-resource poller + fan-out + resync watcher (N→1)
      resources.ts     #   per-resource registry (columns, toBody, filters)
      oddsHandler.ts   #   GET /v1/stream/odds — snapshot + live change/refresh (latest-state)
      oddsHub.ts       #   one current_odds Realtime channel → classify → fan out (N→1)
      sse.ts           #   SSE wire helpers (event/comment frames)
      common.ts        #   shared handler scaffolding (heartbeat/shed consts, 429 acquire)
      connections.ts   #   concurrent-connection caps + graceful-shutdown stream registry
    leaderboard.ts     # GET /v1/leaderboard
    schedule.ts        # GET /v1/schedule
    games.ts           # GET /v1/games, /:gameId
    teams.ts           # GET /v1/teams/aliases
    utils/
      positionFetch.ts # categorize active/pendingSettle/claimable (Supabase-only)
      speculations.ts  # shared Speculation wire shape + row→Speculation converters
      odds.ts          # shared per-market odds shapes + row→shape mapper (REST + stream)
```
