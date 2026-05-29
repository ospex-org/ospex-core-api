/**
 * HTTP-layer tests for the stream-auth surface (M3):
 *   - POST /v1/auth/stream-challenge → mints + stores
 *   - POST /v1/auth/stream-token     → verifies sig + consumes + mints token
 *   - verifyStreamToken middleware   → 401s on every failure mode, attaches
 *     req.streamAuth on success
 *
 * EIP-712 signing uses a real `ethers.Wallet` against the production-shape
 * `buildStreamAuthDomain` + `STREAM_AUTH_TYPES` — so a regression in either
 * the domain mint or the type schema surfaces here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { ethers } from 'ethers';

const MATCHING_MODULE = '0xCAFE000000000000000000000000000000000001';
const SECRET = 'unit-test-hmac-secret-aaaaaaaaaa00';
const AUDIENCE = 'https://api.test.local';

const envMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    network: 'polygon',
    chainId: 137,
    matchingModuleAddress: MATCHING_MODULE,
    redactHiddenPublic: true,
    streamAuthHmacSecret: SECRET,
    streamAuthAudience: AUDIENCE,
    streamChallengeTtlSec: 180,
    streamTokenTtlSec: 900,
  })),
}));
vi.mock('../src/lib/env.js', () => envMock);

const { postStreamChallengeHandler, postStreamTokenHandler } = await import(
  '../src/v1/streamAuth.js'
);
const { verifyStreamToken } = await import('../src/middleware/verifyStreamToken.js');
const { challengeStore, mintStreamAuthToken, STREAM_AUTH_KID } = await import(
  '../src/lib/streamAuth.js'
);
const { buildStreamAuthDomain, STREAM_AUTH_TYPES } = await import('../src/lib/eip712.js');

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
}
function makeRes(): FakeRes {
  const r: FakeRes = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return r;
}
function makeReq(opts: { body?: unknown; headers?: Record<string, unknown> } = {}): Request {
  return {
    body: opts.body,
    headers: opts.headers ?? {},
    query: {},
    params: {},
  } as unknown as Request;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-28T16:00:00.000Z'));
  challengeStore.__reset();
  envMock.loadConfig.mockReturnValue({
    network: 'polygon',
    chainId: 137,
    matchingModuleAddress: MATCHING_MODULE,
    redactHiddenPublic: true,
    streamAuthHmacSecret: SECRET,
    streamAuthAudience: AUDIENCE,
    streamChallengeTtlSec: 180,
    streamTokenTtlSec: 900,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  challengeStore.__reset();
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/auth/stream-challenge
// ─────────────────────────────────────────────────────────────────────────

describe('POST /v1/auth/stream-challenge', () => {
  it('mints a structurally-correct challenge for a valid address', () => {
    const wallet = ethers.Wallet.createRandom();
    const res = makeRes();
    postStreamChallengeHandler(
      makeReq({ body: { address: wallet.address } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { challenge: Record<string, unknown>; expiresAt: number };
    expect(body.challenge).toMatchObject({
      address: wallet.address.toLowerCase(),
      resource: 'own-state',
      scope: 'read:own-state',
      network: { chainId: 137 },
      audience: AUDIENCE,
    });
    expect(typeof body.challenge['challengeId']).toBe('string');
    expect(body.challenge['expiresAt']).toBe(body.expiresAt);
    expect(body.expiresAt).toBeGreaterThan(body.challenge['issuedAt'] as number);
  });

  it('rejects a non-Ethereum address (400)', () => {
    const res = makeRes();
    postStreamChallengeHandler(
      makeReq({ body: { address: 'not-an-address' } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('rejects a missing body (400)', () => {
    const res = makeRes();
    postStreamChallengeHandler(makeReq({ body: undefined }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('503 NOT_READY when audience env is missing', () => {
    envMock.loadConfig.mockReturnValue({
      network: 'polygon',
      chainId: 137,
      matchingModuleAddress: MATCHING_MODULE,
      redactHiddenPublic: true,
      streamAuthHmacSecret: SECRET,
      streamAuthAudience: undefined as unknown as string,
      streamChallengeTtlSec: 180,
      streamTokenTtlSec: 900,
    });
    const res = makeRes();
    postStreamChallengeHandler(
      makeReq({ body: { address: '0x1111111111111111111111111111111111111111' } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'NOT_READY' });
  });

  // Hermes review-30: stream-challenge previously only required AUDIENCE +
  // MATCHING_MODULE_ADDRESS, but a challenge minted with HMAC_SECRET unset
  // cannot be traded for a token — dead-end UX. Unified contract: BOTH
  // endpoints require all three vars.
  it('503 NOT_READY when HMAC secret is missing (unified contract — review-30)', () => {
    envMock.loadConfig.mockReturnValue({
      network: 'polygon',
      chainId: 137,
      matchingModuleAddress: MATCHING_MODULE,
      redactHiddenPublic: true,
      streamAuthHmacSecret: undefined as unknown as string,
      streamAuthAudience: AUDIENCE,
      streamChallengeTtlSec: 180,
      streamTokenTtlSec: 900,
    });
    const res = makeRes();
    postStreamChallengeHandler(
      makeReq({ body: { address: '0x1111111111111111111111111111111111111111' } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'NOT_READY' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/auth/stream-token — full mint→sign→submit flow with ethers
// ─────────────────────────────────────────────────────────────────────────

async function mintAndSign(opts: {
  wallet: ethers.HDNodeWallet;
  audienceOverride?: string;
  chainIdOverride?: number;
  issuedAtOverride?: number;
  expiresAtOverride?: number;
}): Promise<{ challenge: Record<string, unknown>; signature: string }> {
  const res = makeRes();
  postStreamChallengeHandler(
    makeReq({ body: { address: opts.wallet.address } }),
    res as unknown as Response,
  );
  const body = res.body as { challenge: Record<string, unknown>; expiresAt: number };
  const challenge = { ...body.challenge };
  if (opts.audienceOverride !== undefined) challenge['audience'] = opts.audienceOverride;
  if (opts.chainIdOverride !== undefined) {
    challenge['network'] = { chainId: opts.chainIdOverride };
  }
  if (opts.issuedAtOverride !== undefined) challenge['issuedAt'] = opts.issuedAtOverride;
  if (opts.expiresAtOverride !== undefined) challenge['expiresAt'] = opts.expiresAtOverride;
  const domain = buildStreamAuthDomain(137, MATCHING_MODULE);
  const message = {
    address: challenge['address'],
    resource: challenge['resource'],
    scope: challenge['scope'],
    network: challenge['network'],
    audience: challenge['audience'],
    challengeId: challenge['challengeId'],
    issuedAt: BigInt(challenge['issuedAt'] as number),
    expiresAt: BigInt(challenge['expiresAt'] as number),
  };
  const signature = await opts.wallet.signTypedData(
    domain,
    STREAM_AUTH_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
    message,
  );
  return { challenge, signature };
}

describe('POST /v1/auth/stream-token', () => {
  it('valid signature → 200 + token (the happy path)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { challenge, signature } = await mintAndSign({ wallet });
    const res = makeRes();
    postStreamTokenHandler(
      makeReq({ body: { challenge, signature } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { token: string; expiresAt: number };
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.')).toHaveLength(2);
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('valid handshake consumes the challenge — replay returns 401 AUTH_CHALLENGE_REPLAY', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { challenge, signature } = await mintAndSign({ wallet });
    postStreamTokenHandler(
      makeReq({ body: { challenge, signature } }),
      makeRes() as unknown as Response,
    );
    const second = makeRes();
    postStreamTokenHandler(
      makeReq({ body: { challenge, signature } }),
      second as unknown as Response,
    );
    expect(second.statusCode).toBe(401);
    expect(second.body).toMatchObject({ code: 'AUTH_CHALLENGE_REPLAY' });
  });

  it('signed under a different wallet → 401 AUTH_SIGNATURE_INVALID', async () => {
    const honest = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    // honest user got the challenge; attacker signs the (unmodified) typed-data.
    const { challenge } = await mintAndSign({ wallet: honest });
    const domain = buildStreamAuthDomain(137, MATCHING_MODULE);
    const message = {
      address: challenge['address'],
      resource: challenge['resource'],
      scope: challenge['scope'],
      network: challenge['network'],
      audience: challenge['audience'],
      challengeId: challenge['challengeId'],
      issuedAt: BigInt(challenge['issuedAt'] as number),
      expiresAt: BigInt(challenge['expiresAt'] as number),
    };
    const sig = await attacker.signTypedData(
      domain,
      STREAM_AUTH_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
      message,
    );
    const res = makeRes();
    postStreamTokenHandler(makeReq({ body: { challenge, signature: sig } }), res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_SIGNATURE_INVALID' });
  });

  it('audience tampered in body → 401 AUTH_AUDIENCE_MISMATCH (fails before sig recovery)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { challenge, signature } = await mintAndSign({
      wallet,
      audienceOverride: 'https://malicious.example',
    });
    const res = makeRes();
    postStreamTokenHandler(makeReq({ body: { challenge, signature } }), res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_AUDIENCE_MISMATCH' });
  });

  it('chainId tampered in body → 401 AUTH_CHAIN_MISMATCH', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { challenge, signature } = await mintAndSign({ wallet, chainIdOverride: 1 });
    const res = makeRes();
    postStreamTokenHandler(makeReq({ body: { challenge, signature } }), res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_CHAIN_MISMATCH' });
  });

  it('challengeId not in store → 401 AUTH_CHALLENGE_UNKNOWN', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { challenge, signature } = await mintAndSign({ wallet });
    challengeStore.__reset(); // drop the entry
    const res = makeRes();
    postStreamTokenHandler(makeReq({ body: { challenge, signature } }), res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_CHALLENGE_UNKNOWN' });
  });

  it('expired challenge → 401 AUTH_CHALLENGE_EXPIRED', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { challenge, signature } = await mintAndSign({ wallet });
    // Advance system time past expiresAt + cleanup grace.
    vi.setSystemTime(new Date((challenge['expiresAt'] as number) * 1000 + 1_000));
    const res = makeRes();
    postStreamTokenHandler(makeReq({ body: { challenge, signature } }), res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_CHALLENGE_EXPIRED' });
  });

  // ── Hermes review-30 round 2 BLOCKER ─────────────────────────────────
  // A valid wallet that re-signs a CLIENT-MUTATED challenge (e.g. flipped
  // expiresAt) used to succeed because the server stored only address +
  // expiresAt and trusted client-supplied timestamps. The exchange now binds
  // every server-minted field, so the mutated typed-data hits
  // AUTH_CHALLENGE_TAMPERED before the token is issued.
  describe('signed-but-tampered challenge timestamps (review-30 round 2)', () => {
    it('expiresAt mutated to the past → 401 AUTH_CHALLENGE_TAMPERED (Hermes repro)', async () => {
      const wallet = ethers.Wallet.createRandom();
      const nowSec = Math.floor(Date.now() / 1000);
      const { challenge, signature } = await mintAndSign({
        wallet,
        expiresAtOverride: nowSec - 1, // claim "already expired"
      });
      const res = makeRes();
      postStreamTokenHandler(
        makeReq({ body: { challenge, signature } }),
        res as unknown as Response,
      );
      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({ code: 'AUTH_CHALLENGE_TAMPERED' });
    });

    it('expiresAt mutated to a far-future extension → 401 AUTH_CHALLENGE_TAMPERED', async () => {
      const wallet = ethers.Wallet.createRandom();
      const nowSec = Math.floor(Date.now() / 1000);
      const { challenge, signature } = await mintAndSign({
        wallet,
        expiresAtOverride: nowSec + 365 * 24 * 3600,
      });
      const res = makeRes();
      postStreamTokenHandler(
        makeReq({ body: { challenge, signature } }),
        res as unknown as Response,
      );
      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({ code: 'AUTH_CHALLENGE_TAMPERED' });
    });

    it('issuedAt mutated → 401 AUTH_CHALLENGE_TAMPERED', async () => {
      const wallet = ethers.Wallet.createRandom();
      const { challenge, signature } = await mintAndSign({ wallet, issuedAtOverride: 0 });
      const res = makeRes();
      postStreamTokenHandler(
        makeReq({ body: { challenge, signature } }),
        res as unknown as Response,
      );
      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({ code: 'AUTH_CHALLENGE_TAMPERED' });
    });
  });

  it('malformed body → 400 INVALID_PARAM', () => {
    const res = makeRes();
    postStreamTokenHandler(makeReq({ body: {} }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
  });

  // ── Hermes review-30 BLOCKER: malformed timestamps must 400, not 500 ──
  // Each of these would previously reach `BigInt(c.issuedAt)` and throw
  // a RangeError that Express turned into a 500. The parser must catch
  // them at the boundary — they're publicly-submittable values.
  describe('safe-integer guards on numeric challenge fields (review-30)', () => {
    function bodyWithChallengeOverride(over: Record<string, unknown>): { challenge: Record<string, unknown>; signature: string } {
      return {
        challenge: {
          address: '0x1111111111111111111111111111111111111111',
          resource: 'own-state',
          scope: 'read:own-state',
          network: { chainId: 137 },
          audience: AUDIENCE,
          challengeId: 'fixture-challenge-id',
          issuedAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 180,
          ...over,
        },
        signature: '0x00',
      };
    }

    it.each([
      ['fractional issuedAt', { issuedAt: 1.5 }],
      ['Infinity issuedAt (1e309)', { issuedAt: 1e309 }],
      ['NaN issuedAt', { issuedAt: Number.NaN }],
      ['negative issuedAt', { issuedAt: -1 }],
      ['unsafe-integer issuedAt', { issuedAt: Number.MAX_SAFE_INTEGER + 2 }],
      ['fractional expiresAt', { expiresAt: 1.5 }],
      ['Infinity expiresAt', { expiresAt: 1e309 }],
      ['NaN expiresAt', { expiresAt: Number.NaN }],
      ['negative expiresAt', { expiresAt: -100 }],
      ['fractional chainId', { network: { chainId: 1.5 } }],
      ['Infinity chainId', { network: { chainId: 1e309 } }],
      ['NaN chainId', { network: { chainId: Number.NaN } }],
      ['zero chainId', { network: { chainId: 0 } }],
      ['negative chainId', { network: { chainId: -1 } }],
      ['string issuedAt', { issuedAt: '12345' as unknown as number }],
    ])('400 INVALID_PARAM for %s — never 500', (_label, override) => {
      const res = makeRes();
      postStreamTokenHandler(
        makeReq({ body: bodyWithChallengeOverride(override as Record<string, unknown>) }),
        res as unknown as Response,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
    });

    it('challenge.network not an object → 400 INVALID_PARAM', () => {
      const res = makeRes();
      postStreamTokenHandler(
        makeReq({ body: bodyWithChallengeOverride({ network: 'nope' as unknown as object }) }),
        res as unknown as Response,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_PARAM' });
    });
  });

  it('503 NOT_READY when HMAC secret is missing', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { challenge, signature } = await mintAndSign({ wallet });
    envMock.loadConfig.mockReturnValue({
      network: 'polygon',
      chainId: 137,
      matchingModuleAddress: MATCHING_MODULE,
      redactHiddenPublic: true,
      streamAuthHmacSecret: undefined as unknown as string,
      streamAuthAudience: AUDIENCE,
      streamChallengeTtlSec: 180,
      streamTokenTtlSec: 900,
    });
    const res = makeRes();
    postStreamTokenHandler(makeReq({ body: { challenge, signature } }), res as unknown as Response);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'NOT_READY' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// verifyStreamToken middleware
// ─────────────────────────────────────────────────────────────────────────

describe('verifyStreamToken middleware', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  function mintForAddress(address: string, opts: { ttl?: number } = {}): string {
    return mintStreamAuthToken(
      {
        address: address.toLowerCase(),
        resource: 'own-state',
        scope: 'read:own-state',
        audience: AUDIENCE,
        chainId: 137,
        issuedAt: nowSec(),
        expiresAt: nowSec() + (opts.ttl ?? 900),
      },
      SECRET,
    );
  }

  it('valid token → next() + req.streamAuth populated', () => {
    const address = '0x1111111111111111111111111111111111111111';
    const token = mintForAddress(address);
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next: NextFunction = vi.fn();
    verifyStreamToken(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((req as unknown as { streamAuth: unknown }).streamAuth).toMatchObject({
      address,
    });
  });

  it('missing header → 401 AUTH_MISSING (next NOT called)', () => {
    const res = makeRes();
    const next: NextFunction = vi.fn();
    verifyStreamToken(makeReq(), res as unknown as Response, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_MISSING' });
    expect(next).not.toHaveBeenCalled();
  });

  it('non-Bearer scheme → 401 AUTH_MISSING', () => {
    const res = makeRes();
    verifyStreamToken(
      makeReq({ headers: { authorization: 'Basic something' } }),
      res as unknown as Response,
      vi.fn(),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_MISSING' });
  });

  it('empty Bearer token → 401 AUTH_MISSING', () => {
    const res = makeRes();
    verifyStreamToken(
      makeReq({ headers: { authorization: 'Bearer ' } }),
      res as unknown as Response,
      vi.fn(),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_MISSING' });
  });

  it('malformed token (no dot) → 401 AUTH_TOKEN_MALFORMED', () => {
    const res = makeRes();
    verifyStreamToken(
      makeReq({ headers: { authorization: 'Bearer not-a-token' } }),
      res as unknown as Response,
      vi.fn(),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_MALFORMED' });
  });

  it('token signed by a different secret → 401 AUTH_TOKEN_INVALID', () => {
    const tokenForOtherSecret = mintStreamAuthToken(
      {
        address: '0x1111111111111111111111111111111111111111',
        resource: 'own-state',
        scope: 'read:own-state',
        audience: AUDIENCE,
        chainId: 137,
        issuedAt: nowSec(),
        expiresAt: nowSec() + 900,
      },
      'a-completely-different-secret-aaaa',
    );
    const res = makeRes();
    verifyStreamToken(
      makeReq({ headers: { authorization: `Bearer ${tokenForOtherSecret}` } }),
      res as unknown as Response,
      vi.fn(),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
  });

  it('expired token → 401 AUTH_TOKEN_EXPIRED', () => {
    const token = mintForAddress('0x1111111111111111111111111111111111111111', { ttl: 1 });
    vi.advanceTimersByTime(2_000); // 2s elapsed → token expired
    const res = makeRes();
    verifyStreamToken(
      makeReq({ headers: { authorization: `Bearer ${token}` } }),
      res as unknown as Response,
      vi.fn(),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
  });

  it('audience-mismatched token → 401 AUTH_TOKEN_AUDIENCE_MISMATCH', () => {
    const token = mintStreamAuthToken(
      {
        address: '0x1111111111111111111111111111111111111111',
        resource: 'own-state',
        scope: 'read:own-state',
        audience: 'https://wrong.example',
        chainId: 137,
        issuedAt: nowSec(),
        expiresAt: nowSec() + 900,
      },
      SECRET,
    );
    const res = makeRes();
    verifyStreamToken(
      makeReq({ headers: { authorization: `Bearer ${token}` } }),
      res as unknown as Response,
      vi.fn(),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_AUDIENCE_MISMATCH' });
  });

  it('chain-mismatched token → 401 AUTH_TOKEN_CHAIN_MISMATCH', () => {
    const token = mintStreamAuthToken(
      {
        address: '0x1111111111111111111111111111111111111111',
        resource: 'own-state',
        scope: 'read:own-state',
        audience: AUDIENCE,
        chainId: 1, // Ethereum mainnet, not Polygon
        issuedAt: nowSec(),
        expiresAt: nowSec() + 900,
      },
      SECRET,
    );
    const res = makeRes();
    verifyStreamToken(
      makeReq({ headers: { authorization: `Bearer ${token}` } }),
      res as unknown as Response,
      vi.fn(),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_CHAIN_MISMATCH' });
  });

  it('unknown_kid token → 401 AUTH_TOKEN_UNKNOWN_KID', () => {
    // Craft a token with a future kid. (Mirrors what the verifier lib would
    // see during a rotation; the middleware surfaces the lib's verdict.)
    const claims = {
      address: '0x1111111111111111111111111111111111111111',
      resource: 'own-state' as const,
      scope: 'read:own-state' as const,
      audience: AUDIENCE,
      chainId: 137,
      issuedAt: nowSec(),
      expiresAt: nowSec() + 900,
      kid: 'v2',
    };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const token = `${payload}.xxxx`;
    const res = makeRes();
    verifyStreamToken(
      makeReq({ headers: { authorization: `Bearer ${token}` } }),
      res as unknown as Response,
      vi.fn(),
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_UNKNOWN_KID' });
  });

  it('503 NOT_READY when HMAC secret is missing', () => {
    envMock.loadConfig.mockReturnValue({
      network: 'polygon',
      chainId: 137,
      matchingModuleAddress: MATCHING_MODULE,
      redactHiddenPublic: true,
      streamAuthHmacSecret: undefined as unknown as string,
      streamAuthAudience: AUDIENCE,
      streamChallengeTtlSec: 180,
      streamTokenTtlSec: 900,
    });
    const res = makeRes();
    verifyStreamToken(
      makeReq({ headers: { authorization: 'Bearer x.y' } }),
      res as unknown as Response,
      vi.fn(),
    );
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'NOT_READY' });
  });

  it('confirms the kid hardcode for sanity', () => {
    expect(STREAM_AUTH_KID).toBe('v1');
  });
});
