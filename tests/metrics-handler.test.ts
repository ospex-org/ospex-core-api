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

function fakeStreamHub(stats: { resources: number; subscribers: number }): StreamHub {
  return { stats: () => stats } as unknown as StreamHub;
}
function fakeOddsHub(stats: { subscribers: number; channelOpen: boolean; subscribed: boolean; degraded: boolean }): OddsHub {
  return { stats: () => stats } as unknown as OddsHub;
}

beforeEach(() => {
  __resetConnections();
});
afterEach(() => {
  __setStreamHubForTest(undefined);
  __setOddsHubForTest(undefined);
  __resetConnections();
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
});
