/**
 * `src/lib/voidCooldown.ts` — the one contract read this service makes, and the
 * layer `tests/positionFetch.test.ts` deliberately stubs.
 *
 * Split this way on purpose (`3i-install`): the positionFetch cases drive the real
 * CALL SITE with a stubbed answer, and these drive the real answer against a real
 * socket. Neither file can cover the other's half.
 *
 * ## Against a local HTTP server, not a mocked `ethers`
 *
 * The JSON-RPC request is the artifact (`3c-harness`). A stubbed `provider.call`
 * cannot show that the selector encoding is right, cannot show that the explicit
 * network suppresses ethers' own detection round trip, and — the reason that matters most
 * here — cannot reproduce a STALL, which is the failure that got PR #92 blocked: a
 * provider that never answers does not reject, so a module bounded only against
 * rejection is not bounded at all.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const envMock = vi.hoisted(() => ({ loadConfig: vi.fn() }));
const logMock = vi.hoisted(() => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  formatError: String,
}));

vi.mock('../src/lib/env.js', () => envMock);
vi.mock('../src/lib/logger.js', () => logMock);

const { readVoidCooldownSeconds, resetVoidCooldownCacheForTests } = await import(
  '../src/lib/voidCooldown.js'
);

const MODULE = '0xEA21b58E91eDcA41d0c42A8655234F8A64fa31bc';
/** The R5 mainnet value, as recorded in the deploy parameters: 7 days. */
const SEVEN_DAYS = 604_800;
/** `keccak256('i_voidCooldown()')[0:4]`, checked against the ABI rule itself. */
const SELECTOR = '0x17759393';

interface Captured {
  method: string;
  params: unknown[];
}

/** Every JSON-RPC request the module actually sent. */
let seen: Captured[] = [];
let server: Server | undefined;

/** A 32-byte ABI-encoded `uint32`, which is what the real getter returns. */
const encodeUint32 = (v: number): string => '0x' + v.toString(16).padStart(64, '0');

/**
 * Stand a JSON-RPC server up and point the config at it.
 *
 * `reply` returning `undefined` means NEVER ANSWER — the request is accepted and the
 * socket stays open, which is what a withheld header or a stalled body looks like to
 * the caller.
 */
async function serve(
  reply: (req: Captured) => string | { error: string } | undefined,
): Promise<void> {
  const s = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string; params?: unknown[] };
      const captured = { method: body.method, params: body.params ?? [] };
      seen.push(captured);
      const answer = reply(captured);
      if (answer === undefined) return; // hold the socket open, deliberately
      const payload =
        typeof answer === 'string'
          ? { jsonrpc: '2.0', id: body.id, result: answer }
          : { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: answer.error } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  // `unref` so a deliberately held-open socket cannot keep the runner alive — a
  // fake server hosting both ends holds its own handles (`3f-handles`).
  s.unref();
  s.on('connection', (socket) => socket.unref());
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  server = s;
  const port = (s.address() as AddressInfo).port;
  envMock.loadConfig.mockReturnValue({
    speculationModuleAddress: MODULE,
    alchemyRpcUrl: `http://127.0.0.1:${String(port)}`,
    chainId: 137,
  });
}

beforeEach(() => {
  resetVoidCooldownCacheForTests();
  seen = [];
  // Nothing listening on port 1: the default for cases that must not reach a node.
  envMock.loadConfig.mockReturnValue({
    speculationModuleAddress: MODULE,
    alchemyRpcUrl: 'http://127.0.0.1:1',
    chainId: 137,
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  const s = server;
  server = undefined;
  if (s !== undefined) {
    // `close` alone WAITS for the deliberately-held-open socket, which timed the
    // hook out at 10s. Drop the connections first.
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

afterAll(() => {
  resetVoidCooldownCacheForTests();
});

describe('readVoidCooldownSeconds — one call, decoded, against a real socket', () => {
  it('sends exactly one eth_call with the real selector, and decodes the uint32', async () => {
    await serve(() => encodeUint32(SEVEN_DAYS));

    expect(await readVoidCooldownSeconds()).toBe(SEVEN_DAYS);

    // ONE request, not two, and the count is the whole point. Measured: a provider
    // given `staticNetwork: true` but NO network still tries to detect one, fails,
    // and retries on a one-second loop having sent nothing — so the explicit
    // `Network.from(chainId)` is what makes this deterministic, not the flag.
    // Asserting the count is what would catch a regression to detection.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('eth_call');
    const [tx] = seen[0]!.params as [{ to: string; data: string }];
    expect(tx.to.toLowerCase()).toBe(MODULE.toLowerCase());
    expect(tx.data).toBe(SELECTOR);
  });

  it('caches, so a second caller costs no second request', async () => {
    await serve(() => encodeUint32(SEVEN_DAYS));
    const [a, b, c] = await Promise.all([
      readVoidCooldownSeconds(),
      readVoidCooldownSeconds(),
      readVoidCooldownSeconds(),
    ]);
    expect([a, b, c]).toEqual([SEVEN_DAYS, SEVEN_DAYS, SEVEN_DAYS]);
    expect(await readVoidCooldownSeconds()).toBe(SEVEN_DAYS);
    // One read serves three concurrent callers AND every later one: the cache holds
    // the promise, not just the value, so simultaneous first requests share it.
    expect(seen).toHaveLength(1);
  });

  it('reads a different deployment’s value rather than a hard-coded 7 days', async () => {
    // Amoy is deployed with 1 day. A build returning a constant passes every case
    // above and fails this one — which is the whole reason this is an eth_call.
    await serve(() => encodeUint32(86_400));
    expect(await readVoidCooldownSeconds()).toBe(86_400);
  });
});

describe('readVoidCooldownSeconds — bounded in TIME, not only against failure', () => {
  it('returns null within the budget when the provider never answers', async () => {
    // THE PR #92 BLOCKER, reproduced then pinned. Before the fix this never settled:
    // the only bound was ethers' default 300,000 ms transport timeout, against a
    // 15,000 ms traversal deadline.
    await serve(() => undefined);

    const started = Date.now();
    expect(await readVoidCooldownSeconds({ timeoutMs: 250 })).toBeNull();
    const elapsed = Date.now() - started;

    // Bounded by the CALLER's budget. The margin is wide because a CI box is slow,
    // and it is still far below the 2,000 ms transport bound — so only the
    // caller-side race can have produced this, which excludes the rival mechanism
    // by margin rather than by assertion (`3b-rescue`).
    expect(elapsed).toBeLessThan(1_500);
    expect(seen).toHaveLength(1);
  });

  it('does not hand the NEXT caller the attempt that already timed out', async () => {
    // The half that made the first version worse than a per-request hang: the cache
    // held the pending promise, so one stall wedged every later request for the
    // process lifetime. Measured before the fix — the second caller hung too.
    await serve(() => undefined);
    // A 20 ms budget against the 2,000 ms transport bound, deliberately: the two
    // worlds are only distinguishable BEFORE the transport timeout fires, because
    // once the attempt resolves on its own it sets the window through a different
    // branch. A 100x gap is what keeps the window open under parallel test load —
    // measured, an earlier 250 ms budget let the mutant SURVIVE in a four-file run
    // while killing it when this file ran alone (`3b-rescue`: exclude the rival
    // mechanism by margin, or the green means nothing).
    const first = readVoidCooldownSeconds({ timeoutMs: 20 });
    // Wait until the server has ACTUALLY received the request before judging what
    // happens after it (`3b-reach`). Without this the 20 ms budget can expire before
    // the request lands, and then `seen` is empty and the case fails on its own setup
    // — measured, it did, in isolation but not under load.
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(await first).toBeNull();

    const warnsAfterFirst = logMock.logger.warn.mock.calls.length;
    const answered = await Promise.race([
      readVoidCooldownSeconds({ timeoutMs: 5_000 }).then(() => 'answered' as const),
      new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), 200)),
    ]);

    // Inside the negative window the answer comes back without consulting the
    // attempt at all. A build that dropped the window awaits the stalled attempt and
    // is still waiting here — 200 ms against the 2,000 ms it would need.
    expect(answered).toBe('answered');
    // And it produced no new diagnostic, which is the non-timing half of the same
    // property: the refusal never reached the provider.
    expect(logMock.logger.warn.mock.calls.length).toBe(warnsAfterFirst);
    expect(seen).toHaveLength(1);
  });

  it('refuses without spending anything when the budget is already gone', async () => {
    await serve(() => encodeUint32(SEVEN_DAYS));
    expect(await readVoidCooldownSeconds({ timeoutMs: 0 })).toBeNull();
    expect(await readVoidCooldownSeconds({ timeoutMs: -1 })).toBeNull();
    // `seen` alone cannot see this: a build that proceeded would lose its own 0 ms
    // race before the HTTP request landed, so the request count is still 0 when
    // asserted. The absence of ANY diagnostic is what distinguishes "refused before
    // attempting" from "attempted and timed out instantly".
    expect(logMock.logger.warn).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });
  it('is bounded by the TRANSPORT timeout when the caller allows more', async () => {
    // Isolates the second layer. With a caller budget well above the 2,000 ms
    // transport bound, only the transport bound can end this — so a build that
    // reverted to ethers' 300,000 ms default would be caught here and nowhere else
    // (`3b-rescue`: every layer is a rival explanation for the same green).
    await serve(() => undefined);
    const started = Date.now();
    expect(await readVoidCooldownSeconds({ timeoutMs: 6_000 })).toBeNull();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4_000);
    // And NOT instant, which is what proves the transport bound answered rather than
    // one of the pre-flight refusals.
    expect(elapsed).toBeGreaterThan(500);
  }, 15_000);
});

describe('readVoidCooldownSeconds — every failure is a null, never a throw', () => {
  it('returns null when reading the CONFIG itself throws', async () => {
    // Reaches the outer wrapper, which nothing else does: `attempt` catches the
    // failures it can name, and `loadConfig` is deliberately outside its try. This is
    // the "unexpected config shape" the wrapper exists for, and without this case the
    // wrapper is dead code that a mutant can delete unnoticed.
    envMock.loadConfig.mockImplementation(() => {
      throw new Error('config shape changed under us');
    });
    await expect(readVoidCooldownSeconds()).resolves.toBeNull();
  });

  it('returns null when no module address is configured', async () => {
    envMock.loadConfig.mockReturnValue({ alchemyRpcUrl: 'http://127.0.0.1:1', chainId: 137 });
    expect(await readVoidCooldownSeconds()).toBeNull();
    // The REASON, not merely that something warned (`3b`). Without this the case
    // passed for the wrong reason: an unconfigured address falls through to the
    // contract construction, that throw is caught, and the answer is the same null
    // under a different reason — so a mutant deleting this guard survived.
    expect(logMock.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no-module-address' }),
      expect.any(String),
    );
  });

  it('returns null when no RPC url is configured', async () => {
    envMock.loadConfig.mockReturnValue({ speculationModuleAddress: MODULE, chainId: 137 });
    expect(await readVoidCooldownSeconds()).toBeNull();
    expect(logMock.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no-rpc-url' }),
      expect.any(String),
    );
  });

  it('returns null when the node answers with an error', async () => {
    await serve(() => ({ error: 'execution reverted' }));
    expect(await readVoidCooldownSeconds()).toBeNull();
  });

  it('returns null when the socket is refused outright', async () => {
    // Nothing listening on port 1. Distinct from the stall above: this REJECTS, and
    // both directions have to end in the same null.
    expect(await readVoidCooldownSeconds({ timeoutMs: 2_000 })).toBeNull();
  });

  it('returns null on a ZERO, which would make every verified contest past-cooldown', async () => {
    // The discriminating refusal. A zero decodes cleanly and is the single most
    // dangerous answer: `block.timestamp >= startTime + 0` is true for every
    // verified contest, so the endpoint would advertise work that reverts.
    await serve(() => encodeUint32(0));
    expect(await readVoidCooldownSeconds()).toBeNull();
  });

  it('returns null when the answer does not decode as a uint32', async () => {
    await serve(() => '0x');
    expect(await readVoidCooldownSeconds()).toBeNull();
  });

  it('returns null rather than throwing when the LOGGER is broken', async () => {
    // Not hypothetical: the first draft called `logger.warn` and six test doubles in
    // this repo mock the logger as `{ error }` only, so a TypeError propagated out
    // of this module and turned 30 passing tests into 500s.
    const real = logMock.logger.warn;
    logMock.logger.warn = undefined as unknown as typeof real;
    envMock.loadConfig.mockReturnValue({});
    try {
      await expect(readVoidCooldownSeconds()).resolves.toBeNull();
    } finally {
      logMock.logger.warn = real;
    }
  });
});
