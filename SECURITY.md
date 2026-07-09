# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, use [GitHub's private vulnerability reporting](https://github.com/ospex-org/ospex-core-api/security/advisories/new) to report the issue privately. We'll triage and respond as soon as possible.

When reporting, please include:

- A clear description of the vulnerability and its impact
- Steps to reproduce, ideally with a minimal request sequence
- The affected version (commit SHA), and whether you observed it against a local instance or the public deployment
- Any suggested mitigations

## Scope

This repository is the protocol's public read API, signed-write relay, and SSE push layer. In-scope concerns include (non-exhaustive):

- **Redaction bypass.** Any path by which an anonymous reader can obtain a book-hidden commitment's payload — the signature, nonce, `oddsTick`, `riskAmount`, `lineTicks`, `scorer`, or `speculationKey` — or otherwise enumerate a maker's hidden book. See "Hidden-row redaction" in the README for the intended guarantee.
- **Relay integrity.** Anything that lets a caller get a commitment accepted that the on-chain `MatchingModule` would reject, get another maker's commitment accepted or cancelled, or cause a validly signed commitment to be silently dropped or altered.
- **Stream-auth weaknesses.** Bearer-token forgery, replay across audiences or chains, challenge replay or fixation, scope escalation, or any way to read another address's owner-authenticated own-state stream or snapshot.
- **Off-chain cancel authorization.** Any way to hide a commitment you do not control.
- **Resource exhaustion** disproportionate to the documented rate limits and SSE connection caps.
- Dependency vulnerabilities surfaced by the lockfile.

## Out of scope

- **Smart-contract issues** (the on-chain protocol itself) — please report those against the contracts repository. Settlement, custody, matching validity, cancellation, and nonce floors are enforced on-chain; this service cannot override them.
- Findings that require the operator's own credentials (`SUPABASE_SERVICE_ROLE_KEY`, `STREAM_AUTH_HMAC_SECRET`) to already be compromised.
- The Supabase publishable key served by `GET /v1/config/public`. It is public by design and gated by row-level security.
- Missing rate limits on endpoints where the README documents that no limit applies (the SSE streams, which are bounded by connection caps instead).

## Disclosure

We will coordinate disclosure timing with reporters. The default expectation is 90 days from acknowledgment to public disclosure, shorter if the issue is being actively exploited.

We will not pursue legal action for good-faith security research conducted in accordance with this policy. Please avoid privacy violations, data destruction, and any degradation of the live service while testing. No monetary bug bounty is currently offered.
