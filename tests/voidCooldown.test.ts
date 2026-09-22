/**
 * `src/lib/voidCooldown.ts` — the one contract read this service makes, and the
 * layer `tests/positionFetch.test.ts` deliberately stubs.
 *
 * Split this way on purpose (`3i-install`): the positionFetch tests drive the real
 * CALL SITE with a stubbed answer, and these drive the real answer with a stubbed
 * provider. Neither file can cover the other's half, and a single file stubbing both
 * would leave the ABI decode and every refusal path unexecuted.
 *
 * The provider is a fake `ContractRunner` rather than a mocked `ethers`, so the
 * real `Contract` does the real selector encoding and the real `uint32` decode —
 * the two things a hand-rolled `provider.call` wrapper would have got to skip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ loadConfig: vi.fn() }));
const rpcMock = vi.hoisted(() => ({ getProvider: vi.fn() }));
const logMock = vi.hoisted(() => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  formatError: String,
}));

vi.mock('../src/lib/env.js', () => envMock);
vi.mock('../src/lib/rpc.js', () => rpcMock);
vi.mock('../src/lib/logger.js', () => logMock);

const { readVoidCooldownSeconds, resetVoidCooldownCacheForTests } = await import(
  '../src/lib/voidCooldown.js'
);

const MODULE = '0xEA21b58E91eDcA41d0c42A8655234F8A64fa31bc';
/** The R5 mainnet value, as recorded in the deploy parameters: 7 days. */
const SEVEN_DAYS = 604_800;

/** A 32-byte ABI-encoded `uint32`, which is what the real getter returns. */
function encodeUint32(value: number): string {
  return '0x' + value.toString(16).padStart(64, '0');
}

/**
 * The minimal `ContractRunner` ethers needs for a view call.
 *
 * Only `call` — no signer, no `resolveName`. If ethers ever needs more, this fails
 * loudly rather than silently passing, which is the direction to be wrong in for a
 * harness whose whole job is to exercise the real encode/decode.
 */
function runner(call: (tx: { to?: string | null; data?: string }) => Promise<string>) {
  return { call: vi.fn(call) };
}

beforeEach(() => {
  resetVoidCooldownCacheForTests();
  envMock.loadConfig.mockReturnValue({ speculationModuleAddress: MODULE });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('readVoidCooldownSeconds — the happy path is one call, decoded', () => {
  it('reads the uint32 immutable and returns it as seconds', async () => {
    const provider = runner(async () => encodeUint32(SEVEN_DAYS));
    rpcMock.getProvider.mockReturnValue(provider);

    expect(await readVoidCooldownSeconds()).toBe(SEVEN_DAYS);

    // The REAL selector for `i_voidCooldown()`, sent to the configured address.
    // Asserting the outbound call rather than the return value is what makes this
    // a test of the wiring rather than of the fake.
    //
    // The literal is the first four bytes of `keccak256('i_voidCooldown()')`, checked
    // against the ABI rule itself (`ethers.id(sig).slice(0, 10)`) rather than copied
    // from whatever this encoder happened to emit — otherwise it would agree with a
    // wrong signature. A rename on the contract reddens here.
    expect(provider.call).toHaveBeenCalledTimes(1);
    const tx = provider.call.mock.calls[0]![0] as { to?: string | null; data?: string };
    expect((tx.to ?? '').toLowerCase()).toBe(MODULE.toLowerCase());
    expect(tx.data).toBe('0x17759393');
  });

  it('caches, so a second caller costs no second eth_call', async () => {
    const provider = runner(async () => encodeUint32(SEVEN_DAYS));
    rpcMock.getProvider.mockReturnValue(provider);

    const [a, b, c] = await Promise.all([
      readVoidCooldownSeconds(),
      readVoidCooldownSeconds(),
      readVoidCooldownSeconds(),
    ]);

    expect([a, b, c]).toEqual([SEVEN_DAYS, SEVEN_DAYS, SEVEN_DAYS]);
    // ONE call for three concurrent callers: the cache holds the PROMISE, not the
    // value, so simultaneous first requests share a read instead of racing. Caching
    // the value would have made this three.
    expect(provider.call).toHaveBeenCalledTimes(1);
  });

  it('reads a different deployment’s value rather than a hard-coded 7 days', async () => {
    // Amoy is deployed with 1 day. A build that returned a constant would pass every
    // case above and fail this one — which is the whole reason this is an eth_call.
    const provider = runner(async () => encodeUint32(86_400));
    rpcMock.getProvider.mockReturnValue(provider);
    expect(await readVoidCooldownSeconds()).toBe(86_400);
  });
});

describe('readVoidCooldownSeconds — every failure is a null, never a throw', () => {
  it('returns null when no module address is configured', async () => {
    envMock.loadConfig.mockReturnValue({});
    const provider = runner(async () => encodeUint32(SEVEN_DAYS));
    rpcMock.getProvider.mockReturnValue(provider);

    expect(await readVoidCooldownSeconds()).toBeNull();
    // And it must not reach the chain at all — a refusal that still spent a request
    // would be the wrong shape even with the right answer.
    expect(provider.call).not.toHaveBeenCalled();
    expect(logMock.logger.warn).toHaveBeenCalled();
  });

  it('returns null when the provider is unavailable', async () => {
    // `getProvider` throws when ALCHEMY_RPC_URL is unset.
    rpcMock.getProvider.mockImplementation(() => {
      throw new Error('ALCHEMY_RPC_URL is not configured');
    });
    expect(await readVoidCooldownSeconds()).toBeNull();
  });

  it('returns null when the call itself fails', async () => {
    rpcMock.getProvider.mockReturnValue(
      runner(async () => {
        throw new Error('network unreachable');
      }),
    );
    expect(await readVoidCooldownSeconds()).toBeNull();
  });

  it('returns null on a ZERO, which would make every verified contest past-cooldown', async () => {
    // The discriminating refusal. A zero decodes cleanly and is the single most
    // dangerous answer: `block.timestamp >= startTime + 0` is true for every
    // verified contest, so the endpoint would advertise work that reverts.
    rpcMock.getProvider.mockReturnValue(runner(async () => encodeUint32(0)));
    expect(await readVoidCooldownSeconds()).toBeNull();
  });

  it('returns null when the answer does not decode as a uint32', async () => {
    rpcMock.getProvider.mockReturnValue(runner(async () => '0x'));
    expect(await readVoidCooldownSeconds()).toBeNull();
  });

  it('returns null rather than throwing when the LOGGER is broken', async () => {
    // Not hypothetical: the first draft called `logger.warn` and six test doubles in
    // this repo mock the logger as `{ error }` only, so a TypeError propagated out of
    // this module and turned 30 passing tests into 500s. An optional term must not be
    // able to fail a request, whatever goes wrong inside it.
    const broken = logMock.logger.warn;
    logMock.logger.warn = undefined as unknown as typeof broken;
    envMock.loadConfig.mockReturnValue({});
    try {
      await expect(readVoidCooldownSeconds()).resolves.toBeNull();
    } finally {
      logMock.logger.warn = broken;
    }
  });
});
