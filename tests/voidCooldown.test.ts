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

const { readVoidCooldownSeconds, resetVoidCooldownCacheForTests, expireVoidCooldownWindowForTests } =
  await import('../src/lib/voidCooldown.js');

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

/** Server-side sockets, so socket CLOSURE can be asserted rather than assumed. */
let serverSockets: import('node:net').Socket[] = [];
/** How many responses the server saw close — the far side of the cancellation. */
let closedResponses = 0;
/** Bytes the drip has written, so "stopped consuming" is a measurement. */
let dripBytesWritten = 0;
/** `drip` holds a partial body open; `answer` replies normally; `flood` oversends. */
let dripMode: 'drip' | 'answer' | 'flood' = 'drip';

/**
 * A server that sends part of a JSON body and then whitespace forever.
 *
 * This is the shape that defeats an INACTIVITY timeout: the connection is never idle,
 * so nothing upstream ever decides it has stalled. Only an absolute deadline that
 * cancels the exchange ends it.
 */
async function serveDrip(): Promise<void> {
  const s = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string; params?: unknown[] };
      seen.push({ method: body.method, params: body.params ?? [] });
      if (dripMode === 'answer') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: encodeUint32(SEVEN_DAYS) }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = dripMode === 'flood' ? ' '.repeat(16 * 1024) : ' ';
      const opener = '{"jsonrpc":"2.0","id":1,"result":"0x000';
      res.write(opener);
      dripBytesWritten += opener.length;
      const timer = setInterval(() => {
        try {
          res.write(chunk);
          dripBytesWritten += chunk.length;
        } catch {
          clearInterval(timer);
        }
      }, dripMode === 'flood' ? 5 : 25);
      timer.unref();
      res.on('close', () => {
        clearInterval(timer);
        closedResponses += 1;
      });
    });
  });
  s.unref();
  s.on('connection', (socket) => {
    socket.unref();
    serverSockets.push(socket);
  });
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
  serverSockets = [];
  closedResponses = 0;
  dripBytesWritten = 0;
  dripMode = 'drip';
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

/**
 * The round-3 blocker: "bounded" has to mean an ABSOLUTE deadline that cancels the
 * exchange, not an inactivity timeout that a drip defeats.
 *
 * The reviewer reproduced this on real sockets on Node 20.19.0 and 22.23.2 against the
 * previous head: a server sending part of a JSON body and then whitespace every 100 ms
 * kept ethers' `FetchRequest.timeout` alive indefinitely, the timeout rejection did not
 * destroy the request, `provider.destroy()` did not cancel a dispatched exchange, and
 * so the SHARED attempt never settled. Measured consequences, in their numbers: socket
 * `destroyed: false` throughout, `bytesRead` climbing 449 → 2,549 → 43,779, and at
 * t≈62.8 s — past the negative window — the next caller awaited that same pending
 * promise, timed out and re-armed the window. One `eth_call` ever, against a fixture
 * that would have answered a fresh request immediately.
 *
 * Never recovering is worse than being slow, so these three cases pin the three things
 * that were missing: the read ends, the socket is GONE, and the next caller past the
 * window issues a NEW request.
 */
describe('readVoidCooldownSeconds — a drip body is cancelled, not waited out', () => {
  it('ends the read and DESTROYS the socket against an endless partial body', async () => {
    await serveDrip();

    const started = Date.now();
    expect(await readVoidCooldownSeconds({ timeoutMs: 400 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);

    // The part an elapsed-time assertion cannot show, and the part that was false
    // before: the exchange is actually gone. A caller that returns while the client
    // keeps consuming the body has not bounded anything, it has only stopped looking.
    await vi.waitFor(
      () => {
        expect(closedResponses).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    expect(serverSockets.some((s) => s.destroyed)).toBe(true);
    // And the diagnostic names the DEADLINE rather than a generic failure, so an
    // operator can tell a cancelled read from a refused connection. The caller's own
    // 400 ms bound warns 'timed-out' first; this is the attempt's own bound arriving
    // afterwards, which is the one that did the cancelling.
    expect(logMock.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'deadline' }),
      expect.any(String),
    );
  }, 20_000);

  it('stops consuming the body rather than growing bytesRead', async () => {
    await serveDrip();
    expect(await readVoidCooldownSeconds({ timeoutMs: 400 })).toBeNull();

    // Let the attempt's own deadline pass, then take two readings a second apart. The
    // reviewer's evidence is a growing count; a settled exchange cannot grow.
    await vi.waitFor(
      () => {
        expect(closedResponses).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    const first = dripBytesWritten;
    await new Promise((r) => setTimeout(r, 400));
    expect(dripBytesWritten).toBe(first);
  }, 20_000);

  it('makes a NEW request after the window, instead of awaiting the abandoned one', async () => {
    // THE recovery property. Before the fix the abandoned attempt stayed in `inFlight`
    // forever, so every later caller — including one past the sixty-second window —
    // waited on a promise that would never settle. `seen` going from 1 to 2 is the
    // whole assertion: a second `eth_call` reached the node.
    await serveDrip();
    expect(await readVoidCooldownSeconds({ timeoutMs: 300 })).toBeNull();
    expect(seen).toHaveLength(1);

    // Wait for the attempt's own absolute deadline to retire it.
    await vi.waitFor(
      () => {
        expect(closedResponses).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    // The node starts answering, and the window is expired the way sixty seconds
    // would expire it.
    dripMode = 'answer';
    expireVoidCooldownWindowForTests();

    expect(await readVoidCooldownSeconds({ timeoutMs: 3_000 })).toBe(SEVEN_DAYS);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.method).toBe('eth_call');
  }, 20_000);

  it('refuses a body larger than the cap without buffering it', async () => {
    // The second axis of "bounded": the deadline alone caps bytes at bandwidth x 2s,
    // which is not a bound worth claiming. A flood is refused on SIZE, and well inside
    // the time bound, so it is the cap that answered.
    dripMode = 'flood';
    await serveDrip();
    const started = Date.now();
    expect(await readVoidCooldownSeconds({ timeoutMs: 5_000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_800);
  }, 20_000);
});
