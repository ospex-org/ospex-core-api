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
 * ## An OPTIONAL term must be bounded in TIME, not only in failure
 *
 * The first version of this module was bounded against a rejection and not against a
 * stall, which is not the same thing — a promise that never settles never throws.
 * Measured on PR #92: a provider whose `call` never settled left the first caller
 * pending indefinitely AND, because the cache held that promise, left every
 * subsequent caller pending on it for the process lifetime. The only real bound was
 * ethers' default `FetchRequest.timeout` of **300,000 ms**, five minutes, against a
 * traversal deadline of fifteen seconds.
 *
 * Three things fix it, and all three are needed because each bounds something the
 * others do not:
 *
 *   1. **A transport timeout**, on this module's OWN `FetchRequest`. That is what
 *      bounds body consumption — a caller-side race abandons the await while the
 *      socket keeps streaming, so a race alone leaves a stalled response in flight.
 *      An EXPLICIT `Network` goes with it, and `staticNetwork: true` alone is not
 *      enough: measured against a local JSON-RPC server, a provider given
 *      `staticNetwork: true` but no network still tries to DETECT one, fails, and
 *      retries on a one-second loop having sent no request at all. Handing it
 *      `Network.from(chainId)` — which this service already knows from config —
 *      skips detection entirely and sends exactly one `eth_call`. A mocked
 *      `provider.call` cannot show that; a real socket did (`3c-harness`).
 *   2. **A caller-side deadline**, because the transport timeout is the provider's
 *      promise and this module should not depend on another library's bound being
 *      the one that fires (`3b-rescue`: name the rival mechanism). The caller passes
 *      the budget, so a complete traversal can hand over what is left of its own
 *      fifteen seconds rather than adding to it.
 *   3. **A negative window**, so a failed or timed-out attempt is not retried by
 *      every request. Without it a broken provider costs one bounded attempt per
 *      request; with it, one per window. The cache never hands a later caller the
 *      promise that already timed out.
 *
 * A separate provider from `lib/rpc.ts` on purpose: that one is shared with the
 * tx-receipt parsers, and giving it a two-second transport timeout to suit this read
 * would change their behaviour for a reason that has nothing to do with them.
 *
 * ## Fail CLOSED, and say so
 *
 * When the address is unset, the RPC is unreachable or slow, or the answer is not a
 * positive integer, this returns `null` and the caller must refuse every `verified`
 * contest — i.e. behave exactly as the service did before #79. That is the same shape
 * as `collectExecuted` refusing every receipt when `scorers` is unconfigured: a
 * missing term is not a licence to guess one.
 *
 * What this canNOT detect is a wrong-but-positive answer from a wrong address. The
 * protection there is that the address is deliberate operator configuration naming
 * the deployment whose settlement the prediction is about, not a band check inventing
 * a policy the contract does not have.
 */
import { Contract, FetchRequest, JsonRpcProvider, Network } from 'ethers';
import { loadConfig } from './env.js';
import { logger } from './logger.js';

/** The one function this service reads. `uint32 public immutable i_voidCooldown`. */
const ABI = ['function i_voidCooldown() view returns (uint32)'] as const;

/**
 * The transport bound. Generous against a healthy Alchemy `eth_call` (tens to low
 * hundreds of milliseconds) and small against the 15,000 ms traversal deadline this
 * read has to fit inside.
 */
const TRANSPORT_TIMEOUT_MS = 2_000;

/**
 * The caller's default bound, deliberately just ABOVE the transport one so that a
 * healthy-but-slow provider produces a real transport error — which names itself in
 * the log — rather than an opaque local timeout.
 */
export const DEFAULT_COOLDOWN_TIMEOUT_MS = 2_500;

/** How long a failed or timed-out attempt suppresses the next one. */
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
    // doubles in this repo mock the logger as `{ error }` only, and the first draft's
    // `logger.warn` raised a TypeError that propagated out of the caller and 500ed
    // thirty passing tests.
  }
  return null;
}

async function attempt(): Promise<number | null> {
  const { speculationModuleAddress, alchemyRpcUrl, chainId } = loadConfig();
  if (speculationModuleAddress === undefined) return unavailable('no-module-address');
  if (alchemyRpcUrl === undefined || alchemyRpcUrl === '') return unavailable('no-rpc-url');

  let raw: unknown;
  try {
    const request = new FetchRequest(alchemyRpcUrl);
    // THE bound on body consumption. ethers' default here is 300_000 ms.
    request.timeout = TRANSPORT_TIMEOUT_MS;
    // The network is STATED, not detected — see the header. `chainId` is already
    // derived from `NETWORK` in `env.ts`, so this adds no configuration.
    const provider = new JsonRpcProvider(request, Network.from(chainId), {
      staticNetwork: true,
    });
    try {
      const contract = new Contract(speculationModuleAddress, [...ABI], provider);
      raw = await (contract['i_voidCooldown'] as () => Promise<unknown>)();
    } finally {
      // Release the socket rather than leaving one per attempt behind. The negative
      // window means attempts are rare, but "rare" is not "never".
      provider.destroy();
    }
  } catch (err: unknown) {
    return unavailable('read-failed', err);
  }

  // ethers returns a `uint32` as a `bigint`. Anything else, or a non-positive value,
  // is a decode or address mistake rather than a protocol parameter: a zero would
  // make EVERY verified contest read as past-cooldown immediately.
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
 * Never throws and never outlives `timeoutMs`. A caller with its own deadline should
 * pass what remains of it rather than the default.
 */
export async function readVoidCooldownSeconds(
  options: { timeoutMs?: number } = {},
): Promise<number | null> {
  if (known !== undefined) return known;
  const budget = options.timeoutMs ?? DEFAULT_COOLDOWN_TIMEOUT_MS;
  if (budget <= 0) return null;
  // Inside the negative window: refuse without spending anything. This is also what
  // stops a later caller awaiting an attempt that has already timed out.
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
        // The outer safety net. `attempt` catches the failures it can name; this
        // covers the ones it cannot — an unexpected config shape, an ethers version
        // that throws somewhere new. An optional term must not be able to fail a
        // request, whatever goes wrong inside it.
        retryAfter = Date.now() + NEGATIVE_WINDOW_MS;
        inFlight = undefined;
        return unavailable('read-failed', err);
      });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // REF'd deliberately, and cleared in the `finally`: an unref'd timer would let
    // Node drain the loop while this await is the only pending work, and the promise
    // would never settle (`3f-timers`).
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budget);
    });
    const outcome = await Promise.race([inFlight, timeout]);
    if (outcome === 'timeout') {
      // The attempt may still be in flight and may still resolve usefully for a
      // later request; what must not happen is this caller waiting on it, or the
      // next caller waiting again immediately.
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
