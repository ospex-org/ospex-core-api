/**
 * The complete traversal's deadline against a read that never comes back.
 *
 * Separate from `positions-bounded.test.ts` because these need a REAL socket. The
 * in-memory double resolves synchronously, so it can prove the deadline is
 * CHECKED but never that an in-flight read is CANCELLED — and a check-only
 * deadline is exactly what a reviewer defeated on the first version of this work:
 * with a stalled response body both endpoints were still pending sixteen seconds
 * in, because nothing runs between `await` and the response arriving.
 *
 * So these drive the real `@supabase/supabase-js` client at a server that accepts
 * the connection and then goes quiet, in two shapes: silent before the headers,
 * and silent halfway through the body. The body case is the one that matters —
 * aborting a request whose headers already arrived has to tear down the body
 * stream too, or the endpoint hangs having "received a response".
 *
 * Time is faked, so the sixteen seconds cost nothing: the abort hangs off an
 * ordinary `setTimeout`, which vitest's fake timers control, while the socket
 * itself is real. Verified against the real client before this file was written —
 * a faked timer does abort an in-flight postgrest read, and the abort arrives as
 * an ordinary `error` on the result rather than a rejection, which is why the
 * helper converts it where it does.
 *
 * ONE server for the whole file, started before the handlers are imported. A
 * server per case meant a fresh URL per case, and only the first case reached it:
 * the module graph kept the first URL and every later case silently dialled a
 * closed port. The reach assertion below is what turned that into a failure
 * instead of four green tests measuring nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

const ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';

/** Where the server goes quiet. Set per test. */
let mode: 'headers' | 'body' = 'headers';
let received = 0;
/**
 * Resolves when the server has actually accepted a request.
 *
 * Load-bearing, not tidiness. Advancing the fake clock before the read is
 * dispatched aborts the signal first, so fetch rejects without ever connecting
 * and the case measures nothing. That raced: it passed on Windows/Node 22 and
 * the FIRST case failed on CI's Linux/Node 20.19, where dispatch is slower than
 * the advance (the later cases won because undici already had a warm connection
 * to the origin). Waiting on the far side of the request removes the race
 * instead of hoping to win it.
 */
let arrived: () => void = () => undefined;
let arrival: Promise<void> = Promise.resolve();
const held: ServerResponse[] = [];
const sockets: Socket[] = [];

const server = createServer((_req, res) => {
  received += 1;
  arrived();
  if (mode === 'body') {
    // Headers and an opening bracket, so the client blocks consuming a BODY
    // rather than waiting for a status line.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('[');
  }
  held.push(res); // never ended
});
// The listener and every accepted socket each keep the loop alive on their own,
// and an unclosed response keeps its socket. Unref all of them or a passing
// suite still hangs at exit.
server.on('connection', (s) => { s.unref(); sockets.push(s); });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
server.unref();
const { port } = server.address() as { port: number };

vi.mock('../src/lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, formatError: String }));
vi.doMock('../src/lib/env.js', () => ({
  loadConfig: () => ({
    supabaseUrl: `http://127.0.0.1:${String(port)}`,
    supabaseServiceRoleKey: 'test-key',
    network: 'polygon',
  }),
}));

const { getPositionStatusHandler, getClaimParamsHandler } = await import('../src/v1/positions.js');

beforeEach(() => {
  received = 0;
  arrival = new Promise<void>((resolve) => { arrived = resolve; });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-21T00:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a complete traversal is cancelled, not merely checked (#75)', () => {
  it.each([
    ['status', 'headers'],
    ['status', 'body'],
    ['claim-params', 'headers'],
    ['claim-params', 'body'],
  ] as Array<['status' | 'claim-params', 'headers' | 'body']>)(
    'the %s handler refuses a read stalled before the %s rather than hanging',
    async (which, where) => {
      mode = where;
      const handler = which === 'status' ? getPositionStatusHandler : getClaimParamsHandler;
      const res = {
        statusCode: 0, body: {} as Record<string, unknown>,
        status(c: number) { this.statusCode = c; return this; },
        json(b: Record<string, unknown>) { this.body = b; return this; },
      };

      const pending = handler(
        { params: { address: ADDR } } as unknown as Request,
        res as unknown as Response,
      );
      // Only advance once the read is genuinely in flight — see `arrival`.
      await arrival;
      // Sixteen faked seconds. The socket is real and still open; only the abort
      // timer is virtual.
      await vi.advanceTimersByTimeAsync(16_000);
      await pending;

      // A setup failure and a fast success look identical from here, so prove the
      // client actually reached the server before trusting anything below.
      expect(received).toBeGreaterThan(0);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        error: expect.stringContaining('time budget') as unknown as string,
        code: 'ENUMERATION_DEADLINE_EXCEEDED',
      });
    },
  );
});
