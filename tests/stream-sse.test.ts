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

  it('enforces the per-IP anon cap (maxPerIp - reservedPerIpOwner) and frees a slot on release', () => {
    const ip = '1.2.3.4';
    // Default caps: 16 per IP with 3 reserved for owner-auth → 13 anon slots.
    for (let i = 0; i < 13; i += 1) expect(acquire(ip).ok).toBe(true);
    const over = acquire(ip); // 14th anon — would dip into the owner reserve
    expect(over.ok).toBe(false);
    expect(over.scope).toBe('ip');

    release(ip);
    expect(acquire(ip).ok).toBe(true); // a slot freed up
  });

  it('co-located makers (the docs example): at the default 16/3, N=2 makers × 7 odds = 14 anon streams 429s the 14th, while both own-state streams still fit', () => {
    // The .env.example / README co-location example: PER_IP=16, reserve=3, N=2, odds=7.
    // The OVERALL check N*(odds+1)=2*8=16 ≤ 16 looks like it fits, but the BINDING
    // anon-odds check N*odds=14 > PER_IP-reserve=13 rejects the 14th odds stream — so
    // docs must size PER_IP for the anon constraint, not the overall one.
    const ip = '198.51.100.7'; // one shared egress host for both makers
    for (let i = 0; i < 13; i += 1) expect(acquire(ip, 'anon').ok).toBe(true); // 13 odds streams fit
    expect(acquire(ip, 'anon')).toMatchObject({ ok: false, scope: 'ip' }); // the 14th odds stream is 429'd
    // …but the reserve still admits each maker's safety-critical own-state stream.
    expect(acquire(ip, 'owner').ok).toBe(true); // maker A own-state
    expect(acquire(ip, 'owner').ok).toBe(true); // maker B own-state
    // 13 anon + 2 owner = 15 held; one reserved slot to spare under the 16 cap.
    expect(connectionStats()).toMatchObject({ maxPerIp: 16, reservedPerIpOwner: 3, total: 15 });
  });

  it('owner-auth streams may use the reserved slots anon cannot, up to the full per-IP cap', () => {
    const ip = '1.2.3.4';
    for (let i = 0; i < 13; i += 1) expect(acquire(ip, 'anon').ok).toBe(true); // fill the anon cap
    expect(acquire(ip, 'anon').ok).toBe(false); // anon is now capped out (the reserve is owner-only)…
    // …but owner can still take the 3 reserved slots — anon saturation can't starve own-state.
    expect(acquire(ip, 'owner').ok).toBe(true);
    expect(acquire(ip, 'owner').ok).toBe(true);
    expect(acquire(ip, 'owner').ok).toBe(true);
    const overOwner = acquire(ip, 'owner'); // 17th total from this IP — over the full per-IP cap (16)
    expect(overOwner.ok).toBe(false);
    expect(overOwner.scope).toBe('ip');
  });

  it('releasing an owner slot (kind must match) restores the reserve', () => {
    const ip = '9.9.9.9';
    configureConnectionCaps({ maxPerIp: 3, reservedPerIpOwner: 1 }); // anon cap 2, 1 owner-reserved
    expect(acquire(ip, 'anon').ok).toBe(true);
    expect(acquire(ip, 'anon').ok).toBe(true);
    expect(acquire(ip, 'anon').ok).toBe(false); // anon capped at 2
    expect(acquire(ip, 'owner').ok).toBe(true); // takes the reserved slot (total 3)
    expect(acquire(ip, 'owner').ok).toBe(false); // per-IP cap (3) hit
    release(ip, 'owner');
    expect(acquire(ip, 'owner').ok).toBe(true); // reserve available again
    expect(acquire(ip, 'anon').ok).toBe(false); // still anon-capped (2 anon held)
  });

  it('reservedPerIpOwner = 0 is the original single shared per-IP pool', () => {
    const ip = '7.7.7.7';
    configureConnectionCaps({ maxPerIp: 2, reservedPerIpOwner: 0 });
    expect(acquire(ip, 'anon').ok).toBe(true);
    expect(acquire(ip, 'anon').ok).toBe(true); // anon may use the whole per-IP cap
    expect(acquire(ip, 'anon').ok).toBe(false);
    expect(acquire(ip, 'owner').ok).toBe(false); // no reserve — owner gets no privileged slot
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

  it('reports the default caps (200 total / 16 per IP / 3 owner-reserved) until configured', () => {
    expect(connectionStats()).toMatchObject({ maxTotal: 200, maxPerIp: 16, reservedPerIpOwner: 3 });
  });

  it('configureConnectionCaps overrides both caps and enforces the new limits', () => {
    configureConnectionCaps({ maxTotal: 3, maxPerIp: 2, reservedPerIpOwner: 0 });
    expect(connectionStats()).toMatchObject({ maxTotal: 3, maxPerIp: 2, reservedPerIpOwner: 0 });

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

// ── Cumulative counters (rejected + slow-client shed) ────────────────────────

describe('cumulative counters', () => {
  afterEach(() => __resetConnections());

  it('acquire failures bump rejectedTotal (per-IP scope)', () => {
    configureConnectionCaps({ maxTotal: 100, maxPerIp: 1, reservedPerIpOwner: 0 });
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
