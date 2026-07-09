/**
 * GET /v1/protocol/info — the `build` provenance block.
 *
 * `build` echoes Heroku's runtime-dyno-metadata (HEROKU_SLUG_COMMIT etc.) so a
 * reader of the public repo can point at the exact commit the running service
 * was built from. These tests pin: populated when the metadata is present,
 * `null` when it is absent (local dev / feature not enabled), and the commit
 * URL is derived from the SHA.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { __resetConfigCache } from '../src/lib/env.js';
import { getProtocolInfoHandler } from '../src/v1/protocol.js';

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

interface BuildInfo {
  commit: string;
  commitUrl: string;
  releaseVersion: string | null;
  releasedAt: string | null;
}
interface ProtocolBody {
  name: string;
  build: BuildInfo | null;
}

describe('GET /v1/protocol/info — build provenance', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = process.env;
    process.env = {
      NODE_ENV: 'test',
      NETWORK: 'polygon',
      SUPABASE_URL: 'http://localhost',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    } as NodeJS.ProcessEnv;
    __resetConfigCache();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ''}) called`);
    }) as never);
  });

  afterEach(() => {
    process.env = savedEnv;
    __resetConfigCache();
    vi.restoreAllMocks();
  });

  it('populates `build` from Heroku runtime-dyno-metadata when present', () => {
    process.env.HEROKU_SLUG_COMMIT = 'a60c919bc0deadbeefcafef00d1234567890abcd';
    process.env.HEROKU_RELEASE_VERSION = 'v248';
    process.env.HEROKU_RELEASE_CREATED_AT = '2026-07-09T19:10:00Z';

    const res = makeRes();
    getProtocolInfoHandler(req, res as unknown as Response);
    const body = res.body as ProtocolBody;

    expect(res.statusCode).toBe(200);
    expect(body.build).toEqual({
      commit: 'a60c919bc0deadbeefcafef00d1234567890abcd',
      commitUrl:
        'https://github.com/ospex-org/ospex-core-api/commit/a60c919bc0deadbeefcafef00d1234567890abcd',
      releaseVersion: 'v248',
      releasedAt: '2026-07-09T19:10:00Z',
    });
  });

  it('nulls the optional release fields when only the commit is present', () => {
    process.env.HEROKU_SLUG_COMMIT = 'abc123';

    const res = makeRes();
    getProtocolInfoHandler(req, res as unknown as Response);
    const build = (res.body as ProtocolBody).build;

    expect(build).not.toBeNull();
    expect(build?.commit).toBe('abc123');
    expect(build?.releaseVersion).toBeNull();
    expect(build?.releasedAt).toBeNull();
  });

  it('reports `build: null` when the metadata is absent (local dev / feature off)', () => {
    const res = makeRes();
    getProtocolInfoHandler(req, res as unknown as Response);
    const body = res.body as ProtocolBody;

    expect(res.statusCode).toBe(200);
    expect(body.name).toBe('Ospex');
    expect(body.build).toBeNull();
  });
});
