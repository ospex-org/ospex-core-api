/**
 * GET /v1/metrics — surfaces the SSE subsystem's in-memory counters. Fake hubs
 * stand in for the stream/odds singletons so the test asserts the handler wires
 * each stats source (hub stats pass through, live connection counts + configured
 * caps reflected) without a DB or Realtime channel.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import type { StreamHub } from '../src/v1/stream/hub.js';
import type { OddsHub } from '../src/v1/stream/oddsHub.js';

import { getMetricsHandler } from '../src/v1/metrics.js';
import { __setStreamHubForTest } from '../src/v1/stream/hub.js';
import { __setOddsHubForTest } from '../src/v1/stream/oddsHub.js';
import { __resetConnections, acquire, configureConnectionCaps } from '../src/v1/stream/connections.js';
import { __resetHandlerMetrics } from '../src/v1/stream/handler.js';

interface FakeRes {
  statusCode: number;
  body?: unknown;
  status: (c: number) => FakeRes;
  json: (b: unknown) => FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 0,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}
const req = {} as unknown as Request;

function fakeStreamHub(stats: {
  resources: number;
  subscribers: number;
  resyncBroadcastTotal?: number;
}): StreamHub {
  const full = { resyncBroadcastTotal: 0, ...stats };
  return { stats: () => full } as unknown as StreamHub;
}
function fakeOddsHub(stats: {
  subscribers: number;
  channelOpen: boolean;
  subscribed: boolean;
  degraded: boolean;
  channelDegradedTotal?: number;
  hardResetTotal?: number;
}): OddsHub {
  const full = { channelDegradedTotal: 0, hardResetTotal: 0, ...stats };
  return { stats: () => full } as unknown as OddsHub;
}

beforeEach(() => {
  __resetConnections();
  __resetHandlerMetrics();
});
afterEach(() => {
  __setStreamHubForTest(undefined);
  __setOddsHubForTest(undefined);
  __resetConnections();
  __resetHandlerMetrics();
});

describe('GET /v1/metrics', () => {
  it('returns the three stat blocks (plus uptime/timestamp) with default caps', () => {
    __setStreamHubForTest(fakeStreamHub({ resources: 0, subscribers: 0 }));
    __setOddsHubForTest(fakeOddsHub({ subscribers: 0, channelOpen: false, subscribed: false, degraded: false }));

    const res = makeRes();
    getMetricsHandler(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      stream: { resources: 0, subscribers: 0 },
      odds: { subscribers: 0, channelOpen: false, subscribed: false, degraded: false },
      connections: { total: 0, ips: 0, maxTotal: 200, maxPerIp: 10 },
    });
    const body = res.body as { uptimeSeconds: unknown; timestamp: unknown };
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.timestamp).toBe('string');
  });

  it('reflects live hub stats, held connections, and configured caps', () => {
    __setStreamHubForTest(fakeStreamHub({ resources: 2, subscribers: 5 }));
    __setOddsHubForTest(fakeOddsHub({ subscribers: 3, channelOpen: true, subscribed: true, degraded: false }));
    configureConnectionCaps({ maxTotal: 50, maxPerIp: 4 });
    acquire('1.2.3.4');
    acquire('1.2.3.4');
    acquire('5.6.7.8');

    const res = makeRes();
    getMetricsHandler(req, res as unknown as Response);

    expect(res.body).toMatchObject({
      stream: { resources: 2, subscribers: 5 },
      odds: { subscribers: 3, channelOpen: true, subscribed: true, degraded: false },
      connections: { total: 3, ips: 2, maxTotal: 50, maxPerIp: 4 },
    });
  });

  // ── M0 cumulative counters ───────────────────────────────────────────────

  it('exposes the M0 counters (cumulative; zero on a fresh process)', () => {
    __setStreamHubForTest(fakeStreamHub({ resources: 0, subscribers: 0 }));
    __setOddsHubForTest(fakeOddsHub({ subscribers: 0, channelOpen: false, subscribed: false, degraded: false }));

    const res = makeRes();
    getMetricsHandler(req, res as unknown as Response);

    expect(res.body).toMatchObject({
      stream: {
        resyncBroadcastTotal: 0,
        catchupStartedTotal: 0,
        catchupCompletedTotal: 0,
        catchupResyncedTotal: 0,
      },
      odds: {
        channelDegradedTotal: 0,
        hardResetTotal: 0,
      },
      connections: {
        rejectedTotal: 0,
        rejectedByScope: { ip: 0, total: 0 },
        slowClientShedTotal: 0,
      },
    });
  });

  it('surfaces per-IP rejection counts (acquire failures bump rejectedTotal + rejectedByScope.ip)', () => {
    __setStreamHubForTest(fakeStreamHub({ resources: 0, subscribers: 0 }));
    __setOddsHubForTest(fakeOddsHub({ subscribers: 0, channelOpen: false, subscribed: false, degraded: false }));
    configureConnectionCaps({ maxTotal: 10, maxPerIp: 2 });
    acquire('1.2.3.4'); // ok
    acquire('1.2.3.4'); // ok (at cap)
    acquire('1.2.3.4'); // rejected — per-ip
    acquire('1.2.3.4'); // rejected — per-ip

    const res = makeRes();
    getMetricsHandler(req, res as unknown as Response);

    expect(res.body).toMatchObject({
      connections: {
        total: 2,
        rejectedTotal: 2,
        rejectedByScope: { ip: 2, total: 0 },
      },
    });
  });

  it('surfaces server-wide rejection counts (rejectedByScope.total when maxTotal hit)', () => {
    __setStreamHubForTest(fakeStreamHub({ resources: 0, subscribers: 0 }));
    __setOddsHubForTest(fakeOddsHub({ subscribers: 0, channelOpen: false, subscribed: false, degraded: false }));
    configureConnectionCaps({ maxTotal: 2, maxPerIp: 10 });
    acquire('1.1.1.1'); // ok
    acquire('2.2.2.2'); // ok (at total cap)
    acquire('3.3.3.3'); // rejected — total
    acquire('4.4.4.4'); // rejected — total

    const res = makeRes();
    getMetricsHandler(req, res as unknown as Response);

    expect(res.body).toMatchObject({
      connections: {
        total: 2,
        rejectedTotal: 2,
        rejectedByScope: { ip: 0, total: 2 },
      },
    });
  });
});
