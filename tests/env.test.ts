import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetConfigCache, isTakeLinkOrigin, loadConfig } from '../src/lib/env.js';

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

describe('loadConfig — MCP_TAKE_LINK_BASE_URL parsing', () => {
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

  it('points at ospex.org when unset', () => {
    expect(loadConfig().mcpTakeLinkBaseUrl).toBe('https://ospex.org');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('points at ospex.org when set to nothing', () => {
    process.env.MCP_TAKE_LINK_BASE_URL = '';
    expect(loadConfig().mcpTakeLinkBaseUrl).toBe('https://ospex.org');
  });

  for (const origin of [
    'https://take.example',
    'https://staging.take.example:8443',
    'http://localhost',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]) {
    it(`accepts ${origin}`, () => {
      process.env.MCP_TAKE_LINK_BASE_URL = origin;
      expect(loadConfig().mcpTakeLinkBaseUrl).toBe(origin);
      expect(process.exit).not.toHaveBeenCalled();
    });
  }

  // Each of these would put a link somewhere other than where it reads as going.
  for (const bad of [
    'http://take.example',
    'https://take.example/',
    'https://take.example/app',
    'https://take.example?next=1',
    'https://take.example#take',
    'https://user:secret@take.example',
    'https://take.example@evil.example',
    'https:// take.example',
    'https://',
    'take.example',
    'javascript:alert(1)',
    'ftp://take.example',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'http://192.168.1.10:5173',
    ' https://take.example',
    'https://take.example\n',
  ]) {
    it(`boot-fatals on ${JSON.stringify(bad)}`, () => {
      process.env.MCP_TAKE_LINK_BASE_URL = bad;
      expect(() => loadConfig()).toThrow(/process\.exit/);
    });
  }

  it('isTakeLinkOrigin agrees with what loadConfig accepts', () => {
    expect(isTakeLinkOrigin('https://ospex.org')).toBe(true);
    expect(isTakeLinkOrigin('http://localhost:5173')).toBe(true);
    expect(isTakeLinkOrigin('http://ospex.org')).toBe(false);
    expect(isTakeLinkOrigin('https://ospex.org/')).toBe(false);
    expect(isTakeLinkOrigin('')).toBe(false);
  });
});
