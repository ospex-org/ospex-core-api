/**
 * The deployed `SpeculationModule`'s void cooldown, read from the chain once.
 *
 * `ospex-core-api#79` needs one term this service has never had: how long after a
 * contest's frozen start time `settleSpeculation` will void a still-`verified`
 * contest. Everything else in that prediction is already here — `contests.start_time`
 * is mirrored from the `CONTEST_VERIFIED` event, and the clock is the clock.
 *
 * ## Why this is an `eth_call` and not a constant or an env var
 *
 * Four options were priced. Three of them can be silently WRONG, and the wrong
 * direction advertises settlement work whose transaction reverts
 * `SpeculationModule__ContestNotFinalized`:
 *
 *   - **A per-network constant in code**, or **an env var holding the seconds**, can
 *     disagree with the module address it is supposed to describe, and nothing
 *     detects the disagreement. The committed provenance makes that concrete rather
 *     than theoretical: the only committed broadcast JSON in
 *     `ospex-foundry-matched-pairs` carrying `604800` belongs to the RETIRED R4
 *     module, and it agrees with R5 by coincidence of deployment policy rather than
 *     by provenance. The live R5 broadcast record is gitignored.
 *   - **`isContestPastCooldown(contestId)`** does the whole comparison on chain and
 *     cannot be stale at all — but it is one call PER CONTEST. The complete-enumeration
 *     endpoints are bounded at 12,735 position rows per request inside a 15,000 ms
 *     traversal deadline already spent on Supabase reads, so that bound is 12,735
 *     `eth_call`s per request. Refused on cost (`production-cost-review.md`).
 *   - **`i_voidCooldown()`** is a `uint32 public immutable` auto-getter, so the value
 *     CANNOT change for a given address. One call per process, cached, and a redeploy
 *     is a new address — which needs new configuration anyway. Reading the term from
 *     the same module that would execute the settlement is the tightest binding
 *     available: the two cannot disagree.
 *
 * ## Why the transport is `fetch` and an `AbortController`, not an ethers provider
 *
 * Two review rounds were spent learning that "bounded" has three separate meanings
 * here, and that an ethers `JsonRpcProvider` delivers none of them for this purpose.
 *
 * Round 1 bounded a REJECTION and not a STALL: a provider whose call never settles
 * never throws, so the first caller hung and — because the cache held that promise —
 * every later caller hung on it for the process lifetime.
 *
 * Round 2 added `FetchRequest.timeout` and a caller-side race, and the reviewer
 * showed, on real sockets on Node 20.19.0 and 22.23.2, that this is still not an
 * absolute bound:
 *
 *   - **`FetchRequest.timeout` is an INACTIVITY timeout.** A server that sends part of
 *     a JSON body and then a space every 100 ms keeps it alive indefinitely.
 *   - **The timeout rejection does not destroy the request,** and `provider.destroy()`
 *     does not cancel an exchange already dispatched. Measured: the caller returned
 *     `null` promptly while the client went on consuming the unfinished body, socket
 *     `destroyed: false`, `bytesRead` climbing 449 → 2,549 → 43,779.
 *   - **So the shared attempt never settled,** and at t≈62.8 s — past the negative
 *     window — the next caller awaited that same pending promise, timed out, and
 *     re-armed the window. One `eth_call` ever, on a fixture that would have answered
 *     a fresh request immediately. Never recovering is worse than being slow.
 *
 * `fetch` with an `AbortSignal` is the primitive that actually does it: aborting
 * cancels request AND body consumption and destroys the socket. Verified here before
 * this was written — an abort at 400 ms against an endless drip ended the read at
 * 417 ms with the server observing the response close and the socket `destroyed`.
 *
 * ethers keeps the job it is good at, per `3e`: `Interface` computes the selector and
 * decodes the `uint32`, so neither is hand-rolled. What is hand-rolled is a
 * four-field JSON-RPC envelope, which is a stable wire format rather than a model of
 * someone else's behaviour.
 *
 * ## Three bounds, and every one of them is now absolute
 *
 *   1. **The attempt's own deadline** ({@link ATTEMPT_DEADLINE_MS}) aborts the fetch.
 *      Because the attempt therefore always settles, `inFlight` is always retired and
 *      a later caller starts a FRESH attempt — the recovery property round 2 lacked.
 *   2. **A response byte cap** ({@link MAX_RESPONSE_BYTES}), so "bounded" is true on
 *      size as well as on time. The deadline alone caps bytes only at bandwidth ×
 *      2 s, which is not a bound worth claiming.
 *   3. **The caller's own budget**, because a complete traversal near the end of its
 *      15,000 ms deadline must not wait the full attempt. It stops waiting; the
 *      attempt continues and still caches a value for the next request.
 *
 * Plus a **negative window**: a failed attempt is not retried by every request, only
 * once per window. With (1) in place the window now expires into a real retry.
 *
 * ## Fail CLOSED, and say so
 *
 * When the address is unset, the RPC is unreachable, slow, oversized, or the answer is
 * not a positive integer, this returns `null` and the caller must refuse every
 * `verified` contest — i.e. behave exactly as the service did before #79. That is the
 * same shape as `collectExecuted` refusing every receipt when `scorers` is
 * unconfigured: a missing term is not a licence to guess one.
 *
 * What this canNOT detect is a wrong-but-positive answer from a wrong address. The
 * protection there is that the address is deliberate operator configuration naming
 * the deployment whose settlement the prediction is about, not a band check inventing
 * a policy the contract does not have.
 */
import { Interface } from 'ethers';
import { loadConfig } from './env.js';
import { logger } from './logger.js';

/** The one function this service reads. `uint32 public immutable i_voidCooldown`. */
const IFACE = new Interface(['function i_voidCooldown() view returns (uint32)']);
const FN = 'i_voidCooldown';

/**
 * The ABSOLUTE deadline for one attempt, enforced by aborting the fetch.
 *
 * Generous against a healthy `eth_call` (tens to low hundreds of milliseconds) and
 * small against the 15,000 ms traversal deadline this read has to fit inside.
 */
const ATTEMPT_DEADLINE_MS = 2_000;

/**
 * The caller's default bound. Just ABOVE the attempt deadline, so a healthy-but-slow
 * provider produces the attempt's own diagnostic rather than an opaque local timeout.
 */
export const DEFAULT_COOLDOWN_TIMEOUT_MS = 2_500;

/**
 * The most body this read will consume. The real answer is 66 bytes of JSON-RPC
 * envelope plus a 32-byte word; 64 KiB is four orders of magnitude of headroom and
 * still a bound.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** How long a failed or abandoned attempt suppresses the next one. */
const NEGATIVE_WINDOW_MS = 60_000;

/** The immutable answer, once known. Never re-read: it cannot change for an address. */
let known: number | undefined;
/** The attempt in flight, shared by concurrent callers so one read serves all. */
let inFlight: Promise<number | null> | undefined;
/** Epoch ms before which no new attempt is made. */
let retryAfter = 0;

/** Why the term is unavailable, logged so an operator can act on it. */
type Unavailable =
  | 'no-module-address'
  | 'no-rpc-url'
  | 'read-failed'
  | 'deadline'
  | 'response-too-large'
  | 'rpc-error'
  | 'timed-out'
  | 'not-a-positive-integer';

function unavailable(reason: Unavailable, detail?: unknown): null {
  try {
    logger.warn(
      { reason, ...(detail === undefined ? {} : { detail: String(detail) }) },
      'void cooldown unavailable — verified contests will not be reported as settlement work',
    );
  } catch {
    // A logger that cannot log is not a reason to fail a request. Measured: six test
    // doubles in this repo mock the logger as `{ error }` only, and an earlier draft's
    // `logger.warn` raised a TypeError that propagated out of the caller and 500ed
    // thirty passing tests.
  }
  return null;
}

/**
 * Read the body with a byte cap, aborting rather than buffering past it.
 *
 * `res.text()` cannot be capped, and it is the call that consumed 43,779 bytes of a
 * drip in the reviewer's reproduction.
 */
async function readCapped(res: Response, abort: (reason: Error) => void): Promise<string | null> {
  const reader = res.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        abort(new Error(`response exceeded ${String(MAX_RESPONSE_BYTES)} bytes`));
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function attempt(): Promise<number | null> {
  const { speculationModuleAddress, alchemyRpcUrl } = loadConfig();
  if (speculationModuleAddress === undefined) return unavailable('no-module-address');
  if (alchemyRpcUrl === undefined || alchemyRpcUrl === '') return unavailable('no-rpc-url');

  const controller = new AbortController();
  let reason: Unavailable = 'read-failed';
  // REF'd and cleared in the `finally`: an unref'd timer would let Node drain the
  // loop while this await is the only pending work (`3f-timers`).
  const timer = setTimeout(() => {
    reason = 'deadline';
    controller.abort(new Error(`void cooldown read exceeded ${String(ATTEMPT_DEADLINE_MS)}ms`));
  }, ATTEMPT_DEADLINE_MS);

  let body: string | null;
  try {
    const res = await fetch(alchemyRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: speculationModuleAddress, data: IFACE.encodeFunctionData(FN) }, 'latest'],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      controller.abort(new Error(`HTTP ${String(res.status)}`));
      return unavailable('rpc-error', `HTTP ${String(res.status)}`);
    }
    body = await readCapped(res, (err) => {
      reason = 'response-too-large';
      controller.abort(err);
    });
  } catch (err: unknown) {
    return unavailable(reason, err);
  } finally {
    clearTimeout(timer);
  }

  if (body === null) return unavailable(reason);

  let raw: unknown;
  try {
    const parsed = JSON.parse(body) as { result?: unknown; error?: { message?: string } };
    if (parsed.error !== undefined) {
      return unavailable('rpc-error', parsed.error.message ?? 'unknown');
    }
    if (typeof parsed.result !== 'string') return unavailable('rpc-error', 'no result');
    [raw] = IFACE.decodeFunctionResult(FN, parsed.result);
  } catch (err: unknown) {
    return unavailable('read-failed', err);
  }

  // `uint32` decodes to a `bigint`. Anything else, or a non-positive value, is a
  // decode or address mistake rather than a protocol parameter: a zero would make
  // EVERY verified contest read as past-cooldown immediately.
  if (typeof raw !== 'bigint' || raw <= 0n || raw > 0xffff_ffffn) {
    return unavailable('not-a-positive-integer', raw);
  }
  const seconds = Number(raw);
  try {
    logger.info(
      { seconds, speculationModuleAddress },
      'void cooldown read from the deployed SpeculationModule',
    );
  } catch {
    // As above: logging is not load-bearing.
  }
  return seconds;
}

/**
 * The cooldown in seconds, or `null` when it cannot be established WITHIN THE BUDGET.
 *
 * Never throws, never outlives `timeoutMs`, and never leaves an attempt that a later
 * caller can be stuck behind.
 */
export async function readVoidCooldownSeconds(
  options: { timeoutMs?: number } = {},
): Promise<number | null> {
  if (known !== undefined) return known;
  const budget = options.timeoutMs ?? DEFAULT_COOLDOWN_TIMEOUT_MS;
  if (budget <= 0) return null;
  // Inside the negative window: refuse without spending anything.
  if (Date.now() < retryAfter) return null;

  if (inFlight === undefined) {
    inFlight = attempt()
      .then((value) => {
        if (value === null) retryAfter = Date.now() + NEGATIVE_WINDOW_MS;
        else known = value;
        inFlight = undefined;
        return value;
      })
      .catch((err: unknown) => {
        // The outer safety net, for the failures `attempt` cannot name — an
        // unexpected config shape, a runtime that throws somewhere new. An optional
        // term must not be able to fail a request, whatever goes wrong inside it.
        retryAfter = Date.now() + NEGATIVE_WINDOW_MS;
        inFlight = undefined;
        return unavailable('read-failed', err);
      });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budget);
    });
    const outcome = await Promise.race([inFlight, timeout]);
    if (outcome === 'timeout') {
      // This caller stops waiting. The attempt is absolutely bounded, so it will
      // settle on its own and either cache a value for the next request or arm the
      // window — `inFlight` is never left for a later caller to be stuck behind.
      retryAfter = Date.now() + NEGATIVE_WINDOW_MS;
      return unavailable('timed-out', `${String(budget)}ms`);
    }
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test seam only: drop every cached decision so the next call reads again. */
export function resetVoidCooldownCacheForTests(): void {
  known = undefined;
  inFlight = undefined;
  retryAfter = 0;
}

/**
 * Test seam only: expire the negative window without clearing anything else.
 *
 * Exists so the RECOVERY property is testable without a sixty-second test: after an
 * abandoned attempt, the next caller past the window must make a NEW request rather
 * than await the old one. That is the property round 2 did not have.
 */
export function expireVoidCooldownWindowForTests(): void {
  retryAfter = 0;
}
