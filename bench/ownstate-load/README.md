# Own-state SSE load harness (M1 slice)

Tracked-but-**not-deployed** test tooling. It lives outside `src/`, so the `tsc`
build (`yarn build`) never bundles it — it is a bench/test like the unit suite,
not part of the deploy.

It exercises the own-state SSE surface (`GET /v1/stream/own-state`) under load
against a **local** core-api the harness starts and signals. These paths were
code-reviewed but never run under load; the harness asserts **observable**
behavior and, if it surfaces a real defect (a leaked/zombie hub slot, an unclean
shutdown, a dropped/duplicated event across restart), **reports it as a finding**
rather than being tuned to pass.

## Run

```bash
yarn bench:ownstate                 # cap defaults to 10
OWNSTATE_LOAD_CAP=5 yarn bench:ownstate
yarn bench:check                    # typecheck the harness (tsc -p bench/tsconfig.json)
```

Exit code `0` = PASS; `1` = a check failed or a finding was surfaced. No
credentials, no prod core-api, and no real database are involved (see *Fake
Supabase* below).

## What it asserts

**Profile 1 — connection-cap correctness (cap=N)**
- Connections `1..N` reach `ready` (HTTP 200 → `snapshot` → `ready`).
- The `(N+1)`th gets a clean **`429 RATE_LIMIT_EXCEEDED`** — not a hang, not a 500.
- `GET /v1/metrics` shows **exactly N** live (`ownState.subscribers` and
  `connections.total`) and the reject bumped `connections.rejectedByScope.ip` —
  i.e. the rejected connection left **no leaked/zombie slot**.
- Closing one connection drops the live count by exactly one (slot freed), and a
  new subscription then succeeds (capacity frees correctly).

**Profile 2 — graceful SIGTERM + restart/resume**
- An active subscription reaches `ready`, then live `commitment` deltas are
  injected and delivered.
- *(POSIX only — see Platform)* on `SIGTERM` the in-flight stream gets **exactly
  one** `resync{reason:'server_shutdown'}` then a **clean close** (no truncated
  frame), and the server **stops accepting** new connections.
- After restart, the client resumes via **`Last-Event-ID`**; the resumed sequence
  is **gapless** (a row that arrived during the outage is caught up) and
  **duplicate-free** (the at-least-once overlap re-delivery collapses to the
  seeded set under client content-dedup — the same property the F5 restart-dedup
  boot-seed only unit-tests).

## Platform — graceful SIGTERM is POSIX-only

The graceful-shutdown assertions need a **catchable** `SIGTERM`. On **Windows**,
Node maps `child.kill('SIGTERM')` to `TerminateProcess` — abrupt, the process's
`SIGTERM` handler never runs. The harness detects this
(`SIGTERM_IS_GRACEFUL === false`) and **skips** those assertions with a clear
note. Profile 1 and the restart+resume half of profile 2 run on every platform.

**Run on Linux / macOS / CI / WSL for full graceful-shutdown coverage.**

## Fake Supabase

The server boots requiring `SUPABASE_URL` and reads its own-state snapshot + live
deltas from Supabase over PostgREST (REST polling, ~1.5 s; no Realtime). To stay
fully off prod and deterministic, the harness serves those reads from an
in-process fake (`fakeSupabase.ts`) the spawned server points at. It implements
just enough PostgREST (the `eq`/`in`/`gt`/keyset-`or`/`order`/`limit` the
own-state path emits) for the server's keyset + watermark logic to behave as it
does against real Postgres. Anything it cannot serve faithfully is **logged**
(`[fake-fidelity]`) so a harness gap can never masquerade as a server finding.

The harness is the data source: empty by default (profile 1), and `seed()` /
`append()` controlled rows (profile 2 event injection).

## Out of scope (deferred — the rest of the spec §11 stream-readiness gate)

Marked as skipped in the run output and tracked here so the gate isn't forgotten;
pick these up at the agent-onboarding trigger:

- the full **N=100** scale profile (steady-state + ramp),
- **reconnect storms** (mass simultaneous reconnect),
- **mid-stream token refresh** under load,
- **slow-client backpressure / shedding** under sustained load,
- the **metric gates**: latency, throughput, ≥99% reconnect success, bounded memory.

## Files

| File | Role |
|---|---|
| `harness.ts` | Orchestrator + the two profiles + deferred markers. Entry point. |
| `serverProcess.ts` | Spawn/supervise a local core-api (`node --import tsx src/server.ts`), wait-ready, signal. |
| `fakeSupabase.ts` | In-process PostgREST fake (empty by default, seedable). |
| `streamClient.ts` | EIP-712 token mint + a fetch-based SSE client (parses frames, dedups, `Last-Event-ID` resume). |
| `report.ts` | Pass/fail/skip + findings collector and summary. |
