import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetConfigCache, loadConfig } from '../src/lib/env.js';

// `loadConfig()` reads process.env at call time, memoizes the result, and
// `process.exit(1)`s on a bad value. These tests run it under a controlled
// minimal env: process.env is swapped for a clean minimal object so an ambient
// var can't interfere, the memo is reset around every call, and `process.exit`
// is stubbed to throw — so a regressed boot-fatal surfaces as a catchable throw
// rather than killing the test runner.
describe('loadConfig — RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER parsing', () => {
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

  it('accepts 0 — the documented single-shared-pool setting — without a boot-fatal (regression: was rejected as non-positive)', () => {
    process.env.RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER = '0';
    const config = loadConfig();
    expect(config.reservedStreamConnectionsPerIpOwner).toBe(0);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('accepts a positive override', () => {
    process.env.RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER = '5';
    expect(loadConfig().reservedStreamConnectionsPerIpOwner).toBe(5);
  });

  it('leaves it undefined (the stream-module default applies) when unset', () => {
    delete process.env.RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER;
    expect(loadConfig().reservedStreamConnectionsPerIpOwner).toBeUndefined();
  });

  it('still boot-fatals on a negative reserve', () => {
    process.env.RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER = '-1';
    expect(() => loadConfig()).toThrow(/process\.exit/);
  });

  it('still boot-fatals on a non-integer reserve', () => {
    process.env.RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER = '2.5';
    expect(() => loadConfig()).toThrow(/process\.exit/);
  });
});
