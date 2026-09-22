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
 *     CANNOT change for a given address. One call per process, cached forever, and a
 *     redeploy is a new address — which needs new configuration anyway. Reading the
 *     term from the same module that would execute the settlement is the tightest
 *     binding available: the two cannot disagree.
 *
 * So the cost is **one `eth_call` per process lifetime**, paid by the first request
 * that needs it, and zero thereafter. `ALCHEMY_RPC_URL` is already configured on the
 * live app and this service already holds an ethers provider for tx-receipt parsing,
 * so no new outbound dependency is introduced — but this IS this service's first
 * contract read, and it needs one new config value.
 *
 * ## Fail CLOSED, and say so
 *
 * When the address is unset, the RPC is unreachable, or the answer is not a positive
 * integer, this returns `null` and the caller must refuse every `verified` contest —
 * i.e. behave exactly as the service did before #79. That is the same shape as
 * `collectExecuted` refusing every receipt when `scorers` is unconfigured: a missing
 * term is not a licence to guess one.
 *
 * What this canNOT detect is a wrong-but-positive answer from a wrong address. The
 * protection there is that the address is deliberate operator configuration naming
 * the deployment whose settlement the prediction is about, not a band check inventing
 * a policy the contract does not have.
 */
import { Contract } from 'ethers';
import { loadConfig } from './env.js';
import { getProvider } from './rpc.js';
import { logger } from './logger.js';

/** The one function this service reads. `uint32 public immutable i_voidCooldown`. */
const ABI = ['function i_voidCooldown() view returns (uint32)'] as const;

/**
 * The cached answer, as a PROMISE rather than a value, so concurrent first
 * requests share one `eth_call` instead of racing to issue several.
 */
let cached: Promise<number | null> | undefined;

/** Why the term is unavailable, logged once so an operator can act on it. */
type Unavailable = 'no-module-address' | 'rpc-unavailable' | 'read-failed' | 'not-a-positive-integer';

function unavailable(reason: Unavailable, detail?: unknown): null {
  logger.warn(
    { reason, ...(detail === undefined ? {} : { detail: String(detail) }) },
    'void cooldown unavailable — verified contests will not be reported as settlement work',
  );
  return null;
}

async function read(): Promise<number | null> {
  const { speculationModuleAddress } = loadConfig();
  if (speculationModuleAddress === undefined) return unavailable('no-module-address');

  let contract: Contract;
  try {
    contract = new Contract(speculationModuleAddress, [...ABI], getProvider());
  } catch (err: unknown) {
    // `getProvider` throws when ALCHEMY_RPC_URL is unset.
    return unavailable('rpc-unavailable', err);
  }

  let raw: unknown;
  try {
    raw = await (contract['i_voidCooldown'] as () => Promise<unknown>)();
  } catch (err: unknown) {
    return unavailable('read-failed', err);
  }

  // ethers returns a `uint32` as a `bigint`. Anything else, or a non-positive
  // value, is a decode or address mistake rather than a protocol parameter: a
  // zero would make EVERY verified contest read as past-cooldown immediately.
  if (typeof raw !== 'bigint' || raw <= 0n || raw > 0xffff_ffffn) {
    return unavailable('not-a-positive-integer', raw);
  }
  const seconds = Number(raw);
  logger.info({ seconds, speculationModuleAddress }, 'void cooldown read from the deployed SpeculationModule');
  return seconds;
}

/**
 * The cooldown in seconds, or `null` when it cannot be established.
 *
 * Cached for the life of the process. Safe to call on every request.
 *
 * ## This function cannot throw, and that is load-bearing
 *
 * The caller is a money-adjacent read path where this term is OPTIONAL: without it
 * the endpoint answers exactly what it answered before #79. So an unexpected failure
 * here must degrade the PREDICTION, never the response. `read()` already catches the
 * two failures it can name — no provider, a failed call — and the outer catch covers
 * the ones it cannot: a config shape it did not expect, an ethers version that throws
 * somewhere new, a logger that is missing a method.
 *
 * That last one is not hypothetical. Six test doubles in this repo mock the logger as
 * `{ error: vi.fn() }`, so the first draft's `logger.warn` raised a `TypeError` inside
 * this module, propagated out of `fetchCategorizedPositions`, and turned 30 passing
 * tests into 500s. The doubles have been completed — but a term whose absence is
 * supposed to be harmless should not have been able to do that in the first place.
 */
export function readVoidCooldownSeconds(): Promise<number | null> {
  if (cached === undefined) {
    cached = read().catch((err: unknown) => {
      try {
        logger.warn({ reason: 'unexpected', detail: String(err) }, 'void cooldown read threw');
      } catch {
        // A logger that cannot log is still not a reason to fail the request.
      }
      return null;
    });
  }
  return cached;
}

/** Test seam only: drop the cached answer so the next call reads again. */
export function resetVoidCooldownCacheForTests(): void {
  cached = undefined;
}
