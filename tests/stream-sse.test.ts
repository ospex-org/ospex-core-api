import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { initSse, writeComment, writeEvent } from '../src/v1/stream/sse.js';
import {
  __resetConnections,
  acquire,
  closeAllStreams,
  configureConnectionCaps,
  connectionStats,
  registerStream,
  release,
} from '../src/v1/stream/connections.js';

interface FakeRes {
  statusCode: number;
  writableEnded: boolean;
  headers: Record<string, unknown>;
  written: string[];
  setHeader: (k: string, v: unknown) => void;
  flushHeaders: () => void;
  write: (s: string) => boolean;
  flush?: () => void;
}
function makeRes(): FakeRes {
  return {
    statusCode: 0,
    writableEnded: false,
    headers: {},
    written: [],
    setHeader(k, v) {
      this.headers[k] = v;
    },
    flushHeaders() {},
    write(s) {
      this.written.push(s);
      return true;
    },
  };
}

describe('sse wire format', () => {
  it('initSse sets event-stream headers and a no-transform cache directive', () => {
    const res = makeRes();
    initSse(res as unknown as Response);
    expect(String(res.headers['Content-Type'])).toContain('text/event-stream');
    expect(String(res.headers['Cache-Control'])).toContain('no-transform');
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    expect(res.statusCode).toBe(200);
  });

  it('writeEvent emits id/event/data terminated by a blank line', () => {
    const res = makeRes();
    writeEvent(res as unknown as Response, 'delta', { a: 1 }, 'CUR');
    expect(res.written.join('')).toBe('id: CUR\nevent: delta\ndata: {"a":1}\n\n');
  });

  it('writeEvent omits id when not supplied', () => {
    const res = makeRes();
    writeEvent(res as unknown as Response, 'ready', { resource: 'fills' });
    expect(res.written.join('')).toBe('event: ready\ndata: {"resource":"fills"}\n\n');
  });

  it('writeComment emits a comment line', () => {
    const res = makeRes();
    writeComment(res as unknown as Response, 'hb');
    expect(res.written.join('')).toBe(': hb\n\n');
  });

  it('no-ops once the socket has ended', () => {
    const res = makeRes();
    res.writableEnded = true;
    writeEvent(res as unknown as Response, 'delta', { a: 1 }, 'CUR');
    writeComment(res as unknown as Response, 'hb');
    expect(res.written).toHaveLength(0);
  });
});

describe('connection caps', () => {
  afterEach(() => __resetConnections());

  it('enforces the per-IP cap and frees a slot on release', () => {
    const ip = '1.2.3.4';
    for (let i = 0; i < 10; i += 1) expect(acquire(ip).ok).toBe(true);
    const over = acquire(ip);
    expect(over.ok).toBe(false);
    expect(over.scope).toBe('ip');

    release(ip);
    expect(acquire(ip).ok).toBe(true); // a slot freed up
  });

  it('tracks distinct IPs independently', () => {
    expect(acquire('a').ok).toBe(true);
    expect(acquire('b').ok).toBe(true);
    release('a');
    // b still holds its slot; acquiring for b again is fine
    expect(acquire('b').ok).toBe(true);
  });

  it('releasing an IP that holds no slot leaves the total intact (no undercount)', () => {
    expect(acquire('a').ok).toBe(true);
    expect(connectionStats().total).toBe(1);
    release('b'); // 'b' never acquired — must be a no-op, not a total decrement
    expect(connectionStats().total).toBe(1);
  });

  it('reports the default caps (200 total / 10 per IP) until configured', () => {
    expect(connectionStats()).toMatchObject({ maxTotal: 200, maxPerIp: 10 });
  });

  it('configureConnectionCaps overrides both caps and enforces the new limits', () => {
    configureConnectionCaps({ maxTotal: 3, maxPerIp: 2 });
    expect(connectionStats()).toMatchObject({ maxTotal: 3, maxPerIp: 2 });

    const ip = '1.1.1.1';
    expect(acquire(ip).ok).toBe(true);
    expect(acquire(ip).ok).toBe(true);
    const overIp = acquire(ip); // 3rd from this IP — over the per-IP cap (total untouched)
    expect(overIp.ok).toBe(false);
    expect(overIp.scope).toBe('ip');

    expect(acquire('2.2.2.2').ok).toBe(true); // total now 3 (at the cap)
    const overTotal = acquire('3.3.3.3'); // 4th total — over the total cap
    expect(overTotal.ok).toBe(false);
    expect(overTotal.scope).toBe('total');
  });

  it('configureConnectionCaps overrides only the cap provided', () => {
    configureConnectionCaps({ maxPerIp: 1 });
    expect(connectionStats()).toMatchObject({ maxTotal: 200, maxPerIp: 1 });
  });
});

describe('graceful-shutdown stream registry', () => {
  afterEach(() => __resetConnections());

  it('closeAllStreams invokes every registered closer once, then clears the registry', () => {
    const a = vi.fn();
    const b = vi.fn();
    registerStream(a);
    registerStream(b);

    closeAllStreams();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    closeAllStreams(); // registry cleared — no re-invocation
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('deregister removes a closer so a later shutdown does not invoke it', () => {
    const a = vi.fn();
    const deregister = registerStream(a);
    deregister();
    closeAllStreams();
    expect(a).not.toHaveBeenCalled();
  });

  it('a closer that throws does not abort the rest of the shutdown', () => {
    const boom = vi.fn(() => {
      throw new Error('boom');
    });
    const ok = vi.fn();
    registerStream(boom);
    registerStream(ok);
    expect(() => closeAllStreams()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

// ── M0 cumulative counters (rejected + slow-client shed) ─────────────────────

describe('M0 cumulative counters', () => {
  afterEach(() => __resetConnections());

  it('acquire failures bump rejectedTotal (per-IP scope)', () => {
    configureConnectionCaps({ maxTotal: 100, maxPerIp: 1 });
    expect(connectionStats().rejectedTotal).toBe(0);

    acquire('1.1.1.1'); // ok
    acquire('1.1.1.1'); // rejected — per-ip
    acquire('1.1.1.1'); // rejected — per-ip

    expect(connectionStats().rejectedTotal).toBe(2);
    expect(connectionStats().rejectedByScope).toEqual({ ip: 2, total: 0 });
  });

  it('acquire failures bump rejectedTotal (total scope)', () => {
    configureConnectionCaps({ maxTotal: 1, maxPerIp: 10 });
    expect(connectionStats().rejectedTotal).toBe(0);

    acquire('1.1.1.1'); // ok
    acquire('2.2.2.2'); // rejected — total
    acquire('3.3.3.3'); // rejected — total

    expect(connectionStats().rejectedTotal).toBe(2);
    expect(connectionStats().rejectedByScope).toEqual({ ip: 0, total: 2 });
  });

  it('makeShedIfSlow bumps slowClientShedTotal when the buffer exceeds MAX_PENDING_BYTES', async () => {
    const { makeShedIfSlow, MAX_PENDING_BYTES } = await import('../src/v1/stream/common.js');
    const res = { writableEnded: false, writableLength: MAX_PENDING_BYTES + 1, end: vi.fn() };
    const onShed = vi.fn();
    const shed = makeShedIfSlow(res as unknown as Response, onShed);

    expect(connectionStats().slowClientShedTotal).toBe(0);
    shed();
    expect(connectionStats().slowClientShedTotal).toBe(1);
    expect(onShed).toHaveBeenCalledWith(MAX_PENDING_BYTES + 1);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('makeShedIfSlow is a no-op (no counter bump) when the buffer is under threshold', async () => {
    const { makeShedIfSlow, MAX_PENDING_BYTES } = await import('../src/v1/stream/common.js');
    const res = { writableEnded: false, writableLength: MAX_PENDING_BYTES - 1, end: vi.fn() };
    const onShed = vi.fn();
    const shed = makeShedIfSlow(res as unknown as Response, onShed);

    shed();
    expect(connectionStats().slowClientShedTotal).toBe(0);
    expect(onShed).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('makeShedIfSlow is a no-op (no counter bump) once the socket has ended', async () => {
    const { makeShedIfSlow, MAX_PENDING_BYTES } = await import('../src/v1/stream/common.js');
    const res = { writableEnded: true, writableLength: MAX_PENDING_BYTES + 1, end: vi.fn() };
    const shed = makeShedIfSlow(res as unknown as Response, vi.fn());

    shed();
    expect(connectionStats().slowClientShedTotal).toBe(0);
    expect(res.end).not.toHaveBeenCalled();
  });
});
