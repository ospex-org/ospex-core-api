import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetConfigCache, isTakeLinkOrigin, loadConfig } from '../src/lib/env.js';
import { logger } from '../src/lib/logger.js';

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
    'https://take.example:65535',
    // Scheme and host are matched without regard to case, and kept as given.
    'HTTPS://Take.Example',
    'http://localhost',
    'http://localhost:5173',
    'HTTP://LOCALHOST:5173',
    'http://127.0.0.1:5173',
    'http://127.0.0.1',
    'https://ospex.org',
    // A hyphen inside a label, beside the refused ones at either end of it.
    'https://a-b.c',
    'https://take-link.example:443',
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
    // A loopback origin with something in front of it, or after it.
    'javascript:http://localhost:5173',
    'javascript:http://127.0.0.1:5173',
    ' http://localhost:5173',
    'http://localhost:5173/',
    'http://localhost:5173/take',
    'http://localhost:5173@take.example',
    // A port of six digits, on either kind of origin, and a second colon in the host.
    'https://take.example:123456',
    'http://localhost:123456',
    'https://take.example:80:80',
    // A colon with no port after it, on either kind of origin.
    'https://take.example:',
    'http://localhost:',
    // A host that starts with a dot, or ends with a hyphen.
    'https://.take.example',
    'https://take.example-',
    // The dots of the loopback address are dots, not any character.
    'http://127a0b0c1:5173',
    // Five digits, and still past the last port there is.
    'https://take.example:99999',
    'https://take.example:65536',
    'http://localhost:65536',
    'http://127.0.0.1:99999',
    // A label with nothing in it, or one that starts or ends with a hyphen.
    'https://ospex..org',
    'https://a-.b',
    'https://a.-b',
    'https://take.-example',
    'https://take-.example:8443',
  ]) {
    it(`boot-fatals on ${JSON.stringify(bad)}`, () => {
      process.env.MCP_TAKE_LINK_BASE_URL = bad;
      expect(() => loadConfig()).toThrow(/process\.exit/);
    });
  }

  describe('what a refusal writes to the log', () => {
    // Three refused values of three different shapes. The first carries a name
    // and a password. Its letters are mixed case so that a log line which
    // changed the case of what it printed is still found.
    const REFUSED = [
      {
        value: 'https://Opsname-Example:Hunter2-Example@Take.Example.invalid',
        parts: ['Hunter2-Example', 'Opsname-Example', 'Take.Example.invalid', 'Opsname-Example:Hunter2-Example'],
      },
      {
        value: 'https://Second.Example.invalid/Some/Path?Key=Abc123',
        parts: ['Second.Example.invalid', '/Some/Path', 'Abc123'],
      },
      {
        value: 'ftp://Third.Example.invalid:2121',
        parts: ['Third.Example.invalid', '2121', 'ftp:'],
      },
    ];

    const MESSAGE =
      'MCP_TAKE_LINK_BASE_URL must be an origin with no path: https://host, or http:// for localhost';

    /**
     * Every string reachable from a value: the value itself, and every own
     * property of an object, enumerable or not, all the way down. `JSON.stringify`
     * would not do: it renders an `Error` as `{}`, and the message of an error is
     * exactly where a refused value would sit.
     */
    function strings(value: unknown, seen = new Set<unknown>()): string[] {
      if (typeof value === 'string') return [value];
      if (typeof value !== 'object' || value === null || seen.has(value)) return [];
      seen.add(value);
      const out: string[] = [];
      for (const name of Object.getOwnPropertyNames(value)) {
        out.push(...strings((value as Record<string, unknown>)[name], seen));
      }
      return out;
    }

    /** Every string of every argument of every call, lowercased. */
    function written(spies: Array<{ mock: { calls: unknown[][] } }>): string[] {
      const out: string[] = [];
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          for (const argument of call) out.push(...strings(argument).map((text) => text.toLowerCase()));
        }
      }
      return out;
    }

    function refuse(value: string): { fatal: unknown[][]; texts: string[] } {
      const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => undefined);
      // The other places a value could be written on the way out.
      const others = [
        vi.spyOn(logger, 'error').mockImplementation(() => undefined),
        vi.spyOn(logger, 'warn').mockImplementation(() => undefined),
        vi.spyOn(logger, 'info').mockImplementation(() => undefined),
        vi.spyOn(logger, 'debug').mockImplementation(() => undefined),
        vi.spyOn(console, 'error').mockImplementation(() => undefined),
        vi.spyOn(console, 'warn').mockImplementation(() => undefined),
        vi.spyOn(console, 'log').mockImplementation(() => undefined),
        vi.spyOn(console, 'info').mockImplementation(() => undefined),
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      ];
      process.env.MCP_TAKE_LINK_BASE_URL = value;
      __resetConfigCache();
      let thrown: unknown;
      try {
        loadConfig();
      } catch (err) {
        thrown = err;
      }
      const result = {
        fatal: fatal.mock.calls.map((call) => [...call]),
        texts: written([fatal, ...others]),
        thrown,
      };
      for (const spy of [fatal, ...others]) spy.mockRestore();
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('process.exit(1) called');
      return result;
    }

    it('the search sees inside an error, which JSON.stringify renders as {}', () => {
      expect(JSON.stringify(new Error('Hunter2-Example'))).toBe('{}');
      expect(strings({ err: new Error('Hunter2-Example') })).toContain('Hunter2-Example');
    });

    for (const { value, parts } of REFUSED) {
      it(`carries no part of ${JSON.stringify(value)}`, () => {
        const { fatal, texts } = refuse(value);
        // The line was written, so the search below has something to search:
        // the fatal call's two arguments at least.
        expect(fatal).toHaveLength(1);
        expect(texts.length).toBeGreaterThanOrEqual(2);
        for (const text of texts) {
          expect(text).not.toContain(value.toLowerCase());
          for (const part of parts) expect(text).not.toContain(part.toLowerCase());
        }
      });
    }

    it('is the same line, byte for byte, whatever was refused', () => {
      const lines = REFUSED.map(({ value }) => refuse(value).fatal);
      expect(lines).toHaveLength(3);
      for (const fatal of lines) {
        expect(fatal).toEqual([[{ var: 'MCP_TAKE_LINK_BASE_URL' }, MESSAGE]]);
        expect(JSON.stringify(fatal)).toBe(JSON.stringify(lines[0]));
      }
    });

    // Values the pattern alone would take: the URL parser refuses the port, or
    // a label of the host is empty or has a hyphen at one end.
    const PAST_THE_PATTERN = [
      { value: 'https://Take.Example:99999', parts: ['Take.Example', '99999'] },
      { value: 'https://Take.Example:65536', parts: ['Take.Example', '65536'] },
      { value: 'https://Ospex..Org', parts: ['Ospex..Org'] },
      { value: 'https://Qa-.Bz', parts: ['Qa-.Bz', 'Qa-'] },
      { value: 'https://Qa.-Bz', parts: ['Qa.-Bz', '-Bz'] },
    ];

    for (const { value, parts } of PAST_THE_PATTERN) {
      it(`refuses ${JSON.stringify(value)} with the fixed line, and carries no part of it`, () => {
        const { fatal, texts } = refuse(value);
        expect(fatal).toEqual([[{ var: 'MCP_TAKE_LINK_BASE_URL' }, MESSAGE]]);
        for (const text of texts) {
          expect(text).not.toContain(value.toLowerCase());
          for (const part of parts) expect(text).not.toContain(part.toLowerCase());
        }
      });
    }

    it('writes no fatal line for a value that is taken', () => {
      const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => undefined);
      process.env.MCP_TAKE_LINK_BASE_URL = 'https://take.example.invalid';
      expect(loadConfig().mcpTakeLinkBaseUrl).toBe('https://take.example.invalid');
      expect(fatal).not.toHaveBeenCalled();
    });
  });

  it('isTakeLinkOrigin agrees with what loadConfig accepts', () => {
    expect(isTakeLinkOrigin('https://ospex.org')).toBe(true);
    expect(isTakeLinkOrigin('http://localhost:5173')).toBe(true);
    expect(isTakeLinkOrigin('http://ospex.org')).toBe(false);
    expect(isTakeLinkOrigin('https://ospex.org/')).toBe(false);
    expect(isTakeLinkOrigin('')).toBe(false);
    expect(isTakeLinkOrigin('https://take.example:65535')).toBe(true);
    expect(isTakeLinkOrigin('https://take.example:65536')).toBe(false);
    expect(isTakeLinkOrigin('http://127.0.0.1')).toBe(true);
    expect(isTakeLinkOrigin('https://ospex..org')).toBe(false);
    expect(isTakeLinkOrigin('https://a-b.c')).toBe(true);
    expect(isTakeLinkOrigin('https://a-.b')).toBe(false);
    expect(isTakeLinkOrigin('https://a.-b')).toBe(false);
  });
});
