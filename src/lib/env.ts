import { isAddress } from 'ethers';
import { logger } from './logger.js';
import type { ScorerAddresses } from './speculation.js';

export type Network = 'polygon' | 'amoy';
export type ChainId = 137 | 80002;

/**
 * Required vars are validated at boot and always present on Config.
 *
 * Optional vars are reserved for endpoints that haven't migrated yet.
 * They're format-validated when set, but absence is allowed so the
 * scaffold can boot in environments that don't yet have those secrets.
 * Consumers must check presence at use site (or upgrade them to
 * required as they land).
 *
 * `matchingModuleAddress` and `scorers` are jointly required for any
 * endpoint that verifies / persists EIP-712 commitments — see
 * `eip712Auth` and `postCommitmentHandler`.
 */
export interface Config {
  port: number;
  nodeEnv: string;
  network: Network;
  chainId: ChainId;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabaseAnonKey?: string;
  alchemyRpcUrl?: string;
  matchingModuleAddress?: string;
  positionModuleAddress?: string;
  scorers?: ScorerAddresses;
  /** SSE concurrent-connection caps. Absent ⇒ the stream module's defaults apply. */
  maxStreamConnectionsTotal?: number | undefined;
  maxStreamConnectionsPerIp?: number | undefined;
  /** Per-IP slots reserved for owner-auth (own-state) streams. Absent ⇒ the stream module's default. */
  reservedStreamConnectionsPerIpOwner?: number | undefined;
  /**
   * Public hidden-row (`book_visible=false`) redaction switch — short-lived
   * rollout/rollback guard. Default `true` (redaction enforced). Set `false`
   * ONLY to revert behavior during a deploy window; the flag is slated for
   * removal entirely once the redaction rollout has soaked.
   */
  redactHiddenPublic: boolean;
  /**
   * Stream-auth secrets + config — optional. Endpoints check at use site
   * (mirrors `matchingModuleAddress`) and 503 NOT_READY if missing, so the API
   * boots cleanly even before the stream-auth feature is wired.
   *
   * `streamAuthHmacSecret`: HMAC-SHA256 secret used to sign + verify bearer
   * tokens minted by POST /v1/auth/stream-token. Must be ≥ 32 bytes of entropy.
   *
   * `streamAuthAudience`: the canonical host string the SDK derives from its
   * baseUrl. Bound into both the challenge typed-data and the issued token, so
   * a token minted for deployment A cannot be replayed against deployment B.
   */
  streamAuthHmacSecret?: string;
  streamAuthAudience?: string;
  /** Stream-challenge TTL (seconds). Default 180 (3 min); bounded to 2–5 min. */
  streamChallengeTtlSec: number;
  /** Stream-token TTL (seconds). Default 900 (15 min); bounded to 1–30 min. */
  streamTokenTtlSec: number;
  /**
   * Per-page commitments cap for `GET /v1/own-state/snapshot`.
   * Default 5000. Boot-fatal outside [100, 50000] — too small breaks paged
   * cold start, too large defeats the cap's purpose (bounded response time).
   */
  ownStateSnapshotMaxCommitments: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    logger.fatal({ var: name }, 'Missing required environment variable');
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Read the first env var that's set, in priority order. Logs a deprecation
 * warning if a non-canonical name is used so operators can migrate.
 */
function aliasedEnv(canonical: string, ...legacy: string[]): string | undefined {
  const value = optionalEnv(canonical);
  if (value !== undefined) return value;
  for (const name of legacy) {
    const v = optionalEnv(name);
    if (v !== undefined) {
      logger.warn(
        { used: name, canonical },
        'env var alias used — set the canonical name and remove the alias',
      );
      return v;
    }
  }
  return undefined;
}

function validateAddress(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAddress(value)) {
    logger.fatal({ var: name, value }, `${name} is set but is not a valid Ethereum address`);
    process.exit(1);
  }
  return value;
}

function optionalAddressEnv(name: string): string | undefined {
  return validateAddress(name, optionalEnv(name));
}

/**
 * Optional positive-integer env var. Returns undefined when unset (caller falls
 * back to a default); fails loud at boot when set to a non-positive / non-integer
 * value, so a typo can't silently disable a cap.
 */
function optionalPositiveIntEnv(name: string): number | undefined {
  const raw = optionalEnv(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    logger.fatal({ var: name, value: raw }, `${name} must be a positive integer`);
    process.exit(1);
  }
  return n;
}

/**
 * Optional non-negative-integer env var (accepts 0; rejects negatives /
 * non-integers). Used for RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER, where `0` is
 * the documented "disable the reserve / original single shared pool" setting that
 * the acquire logic clamps for (see `src/v1/stream/connections.ts`); the per-IP
 * and total caps stay {@link optionalPositiveIntEnv} (a 0 there would block every
 * connection). Returns undefined when unset (caller falls back to a default).
 */
function optionalNonNegativeIntEnv(name: string): number | undefined {
  const raw = optionalEnv(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    logger.fatal({ var: name, value: raw }, `${name} must be a non-negative integer`);
    process.exit(1);
  }
  return n;
}

/**
 * Boolean env var with a fixed default. Accepts `true|false|1|0` (case-insensitive);
 * any other value is a boot-time fatal so a typo can't silently flip a security gate.
 */
function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = optionalEnv(name);
  if (raw === undefined) return defaultValue;
  const s = raw.toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  logger.fatal({ var: name, value: raw }, `${name} must be true|false|1|0`);
  process.exit(1);
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    logger.fatal({ value: process.env.PORT }, 'PORT must be an integer between 1 and 65535');
    process.exit(1);
  }

  const nodeEnv = process.env.NODE_ENV ?? 'development';

  const rawNetwork = (process.env.NETWORK ?? 'polygon').toLowerCase();
  if (rawNetwork !== 'polygon' && rawNetwork !== 'amoy') {
    logger.fatal({ network: rawNetwork }, 'NETWORK must be "polygon" or "amoy"');
    process.exit(1);
  }
  const network = rawNetwork as Network;
  const chainId: ChainId = network === 'polygon' ? 137 : 80002;

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseServiceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseAnonKey = optionalEnv('SUPABASE_ANON_KEY');

  const alchemyRpcUrl = optionalEnv('ALCHEMY_RPC_URL');
  const matchingModuleAddress = optionalAddressEnv('MATCHING_MODULE_ADDRESS');
  const positionModuleAddress = optionalAddressEnv('POSITION_MODULE_ADDRESS');

  // Scorer addresses — accept the canonical name first, fall back to the
  // legacy name so a copied-over deployment env still works.
  const scorerMoneyline = validateAddress(
    'SCORER_MONEYLINE_ADDRESS',
    aliasedEnv('SCORER_MONEYLINE_ADDRESS', 'MONEYLINE_SCORER_ADDRESS'),
  );
  const scorerSpread = validateAddress(
    'SCORER_SPREAD_ADDRESS',
    aliasedEnv('SCORER_SPREAD_ADDRESS', 'SPREAD_SCORER_ADDRESS'),
  );
  const scorerTotal = validateAddress(
    'SCORER_TOTAL_ADDRESS',
    aliasedEnv('SCORER_TOTAL_ADDRESS', 'TOTAL_SCORER_ADDRESS'),
  );

  // Scorers are an all-or-nothing bundle. Partial config is almost
  // certainly a misconfiguration, not "we deliberately set one of
  // three" — fail loud.
  let scorers: ScorerAddresses | undefined;
  const setCount = [scorerMoneyline, scorerSpread, scorerTotal].filter((v) => v !== undefined).length;
  if (setCount === 3) {
    scorers = {
      moneyline: scorerMoneyline as string,
      spread: scorerSpread as string,
      total: scorerTotal as string,
    };
  } else if (setCount !== 0) {
    logger.fatal(
      { moneyline: !!scorerMoneyline, spread: !!scorerSpread, total: !!scorerTotal },
      'SCORER_*_ADDRESS env vars must all be set together (or all unset)',
    );
    process.exit(1);
  }

  // SSE connection caps — optional; the stream module owns the defaults, so an
  // unset var leaves the cap at its default rather than overriding it.
  const maxStreamConnectionsTotal = optionalPositiveIntEnv('MAX_STREAM_CONNECTIONS_TOTAL');
  const maxStreamConnectionsPerIp = optionalPositiveIntEnv('MAX_STREAM_CONNECTIONS_PER_IP');
  // Per-IP owner-auth reserve. `0` is a valid, documented setting — the original
  // single shared pool (anonymous + own-state share the full per-IP cap; the
  // acquire clamp in `src/v1/stream/connections.ts` treats 0 as no reserve), so it
  // parses through the NON-negative helper (negatives / non-integers still fatal).
  // Unset leaves it at the stream module's DEFAULT_RESERVED_PER_IP_OWNER.
  const reservedStreamConnectionsPerIpOwner = optionalNonNegativeIntEnv(
    'RESERVED_STREAM_CONNECTIONS_PER_IP_OWNER',
  );

  // Public hidden-row redaction. Default ON; flip to false only as a deploy-window
  // rollback (see Config.redactHiddenPublic docstring).
  const redactHiddenPublic = parseBoolEnv('REDACT_HIDDEN_PUBLIC', true);
  logger.info({ redactHiddenPublic }, 'env: REDACT_HIDDEN_PUBLIC');

  // Stream-auth. Secret + audience are optional at boot (handlers 503 if
  // unset) so the server boots cleanly in environments where stream-auth isn't
  // yet wired. A set-but-too-short secret fails loud — a 16-char secret is a
  // misconfiguration we want to surface, not a quiet weakening.
  const streamAuthHmacSecret = optionalEnv('STREAM_AUTH_HMAC_SECRET');
  if (streamAuthHmacSecret !== undefined && streamAuthHmacSecret.length < 32) {
    logger.fatal(
      { length: streamAuthHmacSecret.length },
      'STREAM_AUTH_HMAC_SECRET must be at least 32 characters of entropy',
    );
    process.exit(1);
  }
  const streamAuthAudience = optionalEnv('STREAM_AUTH_AUDIENCE');
  // TTL bounds: challenge 2–5 min, plus a sane 60s–30min envelope for the
  // token. Boot-fatal — silent clamping would hide an operator typo that
  // weakens the security boundary (e.g. a "1d" token TTL).
  const streamChallengeTtlSec = optionalPositiveIntEnv('STREAM_CHALLENGE_TTL_SECONDS') ?? 180;
  if (streamChallengeTtlSec < 120 || streamChallengeTtlSec > 300) {
    logger.fatal(
      { value: streamChallengeTtlSec },
      'STREAM_CHALLENGE_TTL_SECONDS must be between 120 and 300 (2–5 min)',
    );
    process.exit(1);
  }
  const streamTokenTtlSec = optionalPositiveIntEnv('STREAM_TOKEN_TTL_SECONDS') ?? 900;
  if (streamTokenTtlSec < 60 || streamTokenTtlSec > 1800) {
    logger.fatal(
      { value: streamTokenTtlSec },
      'STREAM_TOKEN_TTL_SECONDS must be between 60 and 1800 (1 min – 30 min)',
    );
    process.exit(1);
  }
  const ownStateSnapshotMaxCommitments =
    optionalPositiveIntEnv('OWN_STATE_SNAPSHOT_MAX_COMMITMENTS') ?? 5000;
  if (
    ownStateSnapshotMaxCommitments < 100 ||
    ownStateSnapshotMaxCommitments > 50_000
  ) {
    logger.fatal(
      { value: ownStateSnapshotMaxCommitments },
      'OWN_STATE_SNAPSHOT_MAX_COMMITMENTS must be between 100 and 50000',
    );
    process.exit(1);
  }
  logger.info(
    {
      streamAuthHmacSecret: streamAuthHmacSecret !== undefined ? 'set' : 'unset',
      streamAuthAudience: streamAuthAudience ?? 'unset',
      streamChallengeTtlSec,
      streamTokenTtlSec,
    },
    'env: stream-auth',
  );

  cached = {
    port,
    nodeEnv,
    network,
    chainId,
    supabaseUrl,
    supabaseServiceRoleKey,
    redactHiddenPublic,
    streamChallengeTtlSec,
    streamTokenTtlSec,
    ownStateSnapshotMaxCommitments,
    ...(supabaseAnonKey !== undefined ? { supabaseAnonKey } : {}),
    ...(alchemyRpcUrl !== undefined ? { alchemyRpcUrl } : {}),
    ...(matchingModuleAddress !== undefined ? { matchingModuleAddress } : {}),
    ...(positionModuleAddress !== undefined ? { positionModuleAddress } : {}),
    ...(scorers !== undefined ? { scorers } : {}),
    ...(maxStreamConnectionsTotal !== undefined ? { maxStreamConnectionsTotal } : {}),
    ...(maxStreamConnectionsPerIp !== undefined ? { maxStreamConnectionsPerIp } : {}),
    ...(reservedStreamConnectionsPerIpOwner !== undefined ? { reservedStreamConnectionsPerIpOwner } : {}),
    ...(streamAuthHmacSecret !== undefined ? { streamAuthHmacSecret } : {}),
    ...(streamAuthAudience !== undefined ? { streamAuthAudience } : {}),
  };
  return cached;
}

/** Test-only: clear the memoized config so a test can re-run `loadConfig()` under a different env. */
export function __resetConfigCache(): void {
  cached = undefined;
}
