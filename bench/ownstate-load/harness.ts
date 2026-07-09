/**
 * Own-state SSE load harness — cap=10 correctness + graceful-SIGTERM slice.
 *
 * This is TRACKED-BUT-NOT-DEPLOYED test tooling (it lives outside `src/`, so the
 * `tsc` build never bundles it). It starts a LOCAL core-api process pointed at an
 * in-harness fake Supabase, drives the real own-state SSE contract over HTTP, and
 * asserts OBSERVABLE behavior. It tests paths that were code-reviewed but never
 * run under load: if it surfaces a real defect (a leaked/zombie hub slot, an
 * unclean shutdown, a dropped/duplicated event across restart) it REPORTS it as a
 * finding rather than tuning the harness to pass.
 *
 * Run:  yarn bench:ownstate                 (cap defaults to 10)
 *       OWNSTATE_LOAD_CAP=5 yarn bench:ownstate
 *
 * PLATFORM: the graceful-shutdown half of profile 2 needs a catchable SIGTERM.
 * On Windows Node maps kill() to TerminateProcess (abrupt, no handler), so those
 * assertions are SKIPPED there with a clear note — run on Linux/macOS/CI/WSL for
 * full graceful-shutdown coverage. Profile 1 and the restart+resume half run
 * everywhere.
 *
 * OUT OF SCOPE for this slice (the rest of the stream-readiness gate) —
 * tracked in DEFERRED below so it isn't forgotten:
 *   - the full N=100 scale profile,
 *   - reconnect storms,
 *   - mid-stream token refresh under load,
 *   - slow-client backpressure shedding under load,
 *   - the latency / throughput / >=99%-reconnect / bounded-memory metric gates.
 */

import { Wallet } from 'ethers';
import { FakeSupabase, type Row } from './fakeSupabase.js';
import { OwnStateClient, mintToken } from './streamClient.js';
import { Report } from './report.js';
import { getFreePort, startServer, sleep, SIGTERM_IS_GRACEFUL, type ServerHandle } from './serverProcess.js';

const CAP = Number(process.env['OWNSTATE_LOAD_CAP'] ?? '10');
const NETWORK = 'polygon';
const MATCHING_MODULE = '0x1234567890123456789012345678901234567890';
const HMAC_SECRET = 'ospex-load-harness-hmac-secret-0123456789abcdef'; // >=32 chars
const AUDIENCE = 'ospex-load-harness'; // fixed (port-independent) so tokens survive restart

interface Ctx {
  serverUrl: string;
  fakePort: number;
  fake: FakeSupabase;
  server: ServerHandle;
  report: Report;
}

function buildEnv(fakePort: number, port: number): Record<string, string> {
  return {
    PORT: String(port),
    NODE_ENV: 'production',
    NETWORK,
    SUPABASE_URL: `http://127.0.0.1:${fakePort}`,
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key-not-used-by-fake',
    MATCHING_MODULE_ADDRESS: MATCHING_MODULE,
    STREAM_AUTH_HMAC_SECRET: HMAC_SECRET,
    STREAM_AUTH_AUDIENCE: AUDIENCE,
    MAX_STREAM_CONNECTIONS_PER_IP: String(CAP),
    MAX_STREAM_CONNECTIONS_TOTAL: String(CAP * 4 + 8),
    LOG_LEVEL: 'warn',
  };
}

interface Metrics {
  ownState: { wallets: number; subscribers: number; resyncBroadcastTotal: number };
  connections: { total: number; ips: number; maxTotal: number; maxPerIp: number; rejectedByScope: { ip: number; total: number } };
}

async function getMetrics(url: string): Promise<Metrics> {
  const res = await fetch(`${url}/v1/metrics`, { signal: AbortSignal.timeout(3000) });
  return (await res.json()) as Metrics;
}

async function waitMetrics(url: string, pred: (m: Metrics) => boolean, timeoutMs = 6000): Promise<Metrics> {
  const deadline = Date.now() + timeoutMs;
  let last = await getMetrics(url);
  while (!pred(last)) {
    if (Date.now() > deadline) return last;
    await sleep(150);
    last = await getMetrics(url);
  }
  return last;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout (${ms}ms): ${label}`)), ms)),
  ]);
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

function safeJson(s: string): { code?: string } | null {
  try { return JSON.parse(s); } catch { return null; }
}

// ── fake-row builders ──────────────────────────────────────────────────────

function microIso(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, -1)}000+00:00`; // .SSS -> .SSS000 + explicit UTC offset
}

let nextId = 1000;
function makeCommitmentRow(maker: string, hashByte: string, updatedAtMs: number): Row {
  const id = ++nextId;
  return {
    id,
    row_updated_at: microIso(updatedAtMs),
    commitment_hash: `0x${hashByte.repeat(64)}`.slice(0, 66),
    maker: maker.toLowerCase(),
    contest_id: 990000 + id,
    scorer: `0x${'22'.repeat(20)}`,
    line_ticks: 0,
    position_type: 'upper',
    odds_tick: 200,
    market_type: 'moneyline',
    risk_amount: '1000000',
    filled_risk_amount: '0',
    nonce: String(id),
    expiry: microIso(Date.now() + 3_600_000),
    speculation_key: `0x${'bb'.repeat(32)}`,
    signature: `0x${'9'.repeat(130)}`,
    status: 'open',
    source: 'agent',
    network: NETWORK,
    nonce_invalidated: false,
    book_visible: true,
    created_at: microIso(updatedAtMs),
  };
}

/**
 * commitmentHashes a client received as LIVE / CATCH-UP `commitment` DELTA events
 * — NOT the cold-start `snapshot` body. The resume assertions key off this on
 * purpose: a server that ignored `Last-Event-ID` and cold-started would deliver
 * the active rows inside a `snapshot` (and emit no `commitment` deltas), so a
 * snapshot-inclusive count would FALSE-PASS the resume contract. (A review caught
 * exactly that hole — counting snapshot rows made the resume gate non-load-bearing
 * against a cursor-ignored regression.)
 */
function commitmentDeltaHashes(c: OwnStateClient): Set<string> {
  const out = new Set<string>();
  for (const f of c.frames) {
    if (f.event !== 'commitment') continue;
    const h = (f.data as { commitmentHash?: string }).commitmentHash?.toLowerCase();
    if (h) out.add(h);
  }
  return out;
}

/**
 * commitmentHashes delivered as CATCH-UP deltas — `commitment` events received
 * BEFORE the connection's `ready` frame. A correct `Last-Event-ID` resume emits
 * the recovered rows as catch-up deltas BEFORE `ready`; a cursor-ignored cold
 * start emits a `snapshot` then `ready` with NO commitment deltas before it (the
 * live re-emit comes after `ready`). Keying the resume assertions off this makes
 * gapless / overlap / cross-outage ALL fail the cold-start regression — not just
 * the no-snapshot check.
 */
function catchUpDeltaHashes(c: OwnStateClient): Set<string> {
  const readyIdx = c.frames.findIndex((f) => f.event === 'ready');
  const cutoff = readyIdx === -1 ? c.frames.length : readyIdx;
  const out = new Set<string>();
  for (let i = 0; i < cutoff; i++) {
    const f = c.frames[i]!;
    if (f.event !== 'commitment') continue;
    const h = (f.data as { commitmentHash?: string }).commitmentHash?.toLowerCase();
    if (h) out.add(h);
  }
  return out;
}

// ── profile 1 — cap correctness ─────────────────────────────────────────────

async function profile1(ctx: Ctx): Promise<void> {
  const { serverUrl, report } = ctx;
  report.section(`Profile 1 — connection-cap correctness (cap=${CAP})`);

  const wallets = Array.from({ length: CAP + 2 }, () => Wallet.createRandom());
  const tokens = await Promise.all(wallets.map((w) => mintToken(serverUrl, w, MATCHING_MODULE)));
  report.check('minted cap+2 stream-auth bearers (challenge -> EIP-712 sign -> token)', tokens.length === CAP + 2);

  const open: OwnStateClient[] = [];
  for (let i = 0; i < CAP; i++) {
    const c = new OwnStateClient(serverUrl, tokens[i]!.token, { label: `sub${i + 1}` });
    await c.open();
    open.push(c);
  }
  const readyResults = await Promise.allSettled(open.map((c) => withTimeout(c.ready, 15_000, c.label)));
  const readyCount = readyResults.filter((r) => r.status === 'fulfilled').length;
  report.check(`all ${CAP} subscriptions reached 'ready' (HTTP 200 + snapshot + ready)`, readyCount === CAP, `${readyCount}/${CAP} ready`);

  const overflow = new OwnStateClient(serverUrl, tokens[CAP]!.token, { label: 'overflow' });
  await overflow.open();
  const body = safeJson(overflow.httpBody);
  report.check('(cap+1)th subscription rejected with HTTP 429 (not a hang, not a 500)', overflow.httpStatus === 429, `status=${overflow.httpStatus}`);
  report.check("429 body carries code 'RATE_LIMIT_EXCEEDED'", body?.code === 'RATE_LIMIT_EXCEEDED', `code=${body?.code}`);

  const m = await waitMetrics(serverUrl, (mm) => mm.ownState.subscribers === CAP, 6000);
  report.info(`metrics after cap+1: ownState=${JSON.stringify(m.ownState)} connections.total=${m.connections.total} rejected.ip=${m.connections.rejectedByScope.ip}`);
  const subsOk = report.check('own-state hub subscribers == cap (no leaked slot)', m.ownState.subscribers === CAP, `subscribers=${m.ownState.subscribers}`);
  const totalOk = report.check('connections.total == cap', m.connections.total === CAP, `total=${m.connections.total}`);
  report.check('connections.maxPerIp == cap', m.connections.maxPerIp === CAP, `maxPerIp=${m.connections.maxPerIp}`);
  report.check('the rejected (cap+1)th bumped rejectedByScope.ip', m.connections.rejectedByScope.ip >= 1, `ip=${m.connections.rejectedByScope.ip}`);
  if (!subsOk || !totalOk) {
    report.finding({ severity: 'high', title: 'Connection-cap slot leak',
      detail: `After cap subscriptions + one rejected, live count != cap (subscribers=${m.ownState.subscribers}, connections.total=${m.connections.total}).` });
  }

  await open[0]!.close();
  const mAfter = await waitMetrics(serverUrl, (mm) => mm.connections.total === CAP - 1 && mm.ownState.subscribers === CAP - 1, 6000);
  const freed = report.check('closing one subscription drops the live count by exactly one (slot freed)',
    mAfter.connections.total === CAP - 1 && mAfter.ownState.subscribers === CAP - 1,
    `total=${mAfter.connections.total} subscribers=${mAfter.ownState.subscribers}`);
  if (!freed) {
    report.finding({ severity: 'high', title: 'Slot not released on disconnect',
      detail: `After closing one subscription the live count did not drop to ${CAP - 1} within timeout (total=${mAfter.connections.total}, subscribers=${mAfter.ownState.subscribers}) — a zombie slot.` });
  }

  const fresh = new OwnStateClient(serverUrl, tokens[CAP + 1]!.token, { label: 'fresh' });
  await fresh.open();
  let freshReady = false;
  try { await withTimeout(fresh.ready, 15_000, 'fresh'); freshReady = true; } catch { /* */ }
  report.check('a NEW subscription succeeds after capacity frees', freshReady && fresh.httpStatus === 200, `status=${fresh.httpStatus} ready=${freshReady}`);
  open.push(fresh);

  await Promise.allSettled([...open.slice(1).map((c) => c.close()), overflow.close()]);
  await waitMetrics(serverUrl, (mm) => mm.connections.total === 0, 6000);
}

// ── profile 2 — graceful SIGTERM + restart/resume ───────────────────────────

async function profile2(ctx: Ctx): Promise<void> {
  const { report, fake, fakePort } = ctx;
  let serverUrl = ctx.serverUrl;
  let server = ctx.server;
  report.section('Profile 2 — graceful SIGTERM + restart/resume');

  const wallet = Wallet.createRandom();
  const minted = await mintToken(serverUrl, wallet, MATCHING_MODULE);

  const a = new OwnStateClient(serverUrl, minted.token, { label: 'A' });
  await a.open();
  await withTimeout(a.ready, 15_000, 'A');
  report.check('active subscription reached ready on an empty wallet', a.framesOfType('ready').length === 1);

  // Inject two live commitment deltas (polled AFTER beginLive).
  const t0 = Date.now();
  fake.append('commitments', [makeCommitmentRow(wallet.address, '11', t0), makeCommitmentRow(wallet.address, '22', t0 + 1000)]);
  await waitFor(() => a.framesOfType('commitment').length >= 2, 12_000);
  const deltaCount = a.framesOfType('commitment').length;
  report.check('live commitment deltas delivered before shutdown', deltaCount >= 2, `${deltaCount} commitment events`);
  const resumeCursor = a.lastEventId;
  report.info(`resume cursor (Last-Event-ID) = ${resumeCursor ? resumeCursor.slice(0, 24) + '...' : '(none)'}`);
  const seenBefore = commitmentDeltaHashes(a); // A's r1/r2 arrived as live deltas (its cold snapshot was empty)

  // ── graceful-shutdown assertions (POSIX only) ──
  if (SIGTERM_IS_GRACEFUL) {
    const exited = server.exited;
    server.sigterm();
    await withTimeout(a.done, 12_000, 'A-close').catch(() => undefined);
    const shutdownResync = a.framesOfType('resync').filter((f) => (f.data as { reason?: string }).reason === 'server_shutdown');
    const okOne = report.check("in-flight stream got EXACTLY one resync{reason:'server_shutdown'}", shutdownResync.length === 1, `${shutdownResync.length} server_shutdown resync(s)`);
    const cleanClose = report.check('stream closed cleanly — no truncated/partial final frame', !a.sawPartialFrame);
    if (!okOne) report.finding({ severity: 'medium', title: 'Shutdown resync not exactly-once', detail: `On SIGTERM an in-flight stream emitted ${shutdownResync.length} server_shutdown resync events (expected 1).` });
    if (!cleanClose) report.finding({ severity: 'high', title: 'Unclean SSE close on shutdown', detail: 'On SIGTERM the in-flight stream ended mid-frame (truncated SSE).' });

    let refusedNew = false;
    try { refusedNew = (await fetch(`${serverUrl}/healthz`, { signal: AbortSignal.timeout(1500) })).status >= 500; } catch { refusedNew = true; }
    report.check('server stops accepting new connections after SIGTERM', refusedNew);
    await exited;
  } else {
    report.skip('graceful-shutdown assertions (resync{server_shutdown} + clean close + stops accepting)',
      'needs a catchable SIGTERM — not deliverable to a Node child on Windows (kill->TerminateProcess); run on Linux/macOS/CI/WSL');
    server.forceKill();
    await server.exited;
    await a.close().catch(() => undefined);
  }

  // ── restart + Last-Event-ID resume (all platforms) ──
  const newPort = await getFreePort();
  server = await startServer(buildEnv(fakePort, newPort), newPort);
  ctx.server = server; // adopt before waitReady so cleanup always kills the latest child
  serverUrl = `http://127.0.0.1:${newPort}`;
  ctx.serverUrl = serverUrl;
  await server.waitReady();
  report.check('server restarted cleanly', true, `new port ${newPort}`);

  // A cross-outage row arrives while the client was disconnected.
  fake.append('commitments', [makeCommitmentRow(wallet.address, '33', Date.now())]);

  const b = new OwnStateClient(serverUrl, minted.token, { label: 'B', ...(resumeCursor ? { lastEventId: resumeCursor } : {}) });
  await b.open();
  const bReady = await withTimeout(b.ready, 15_000, 'B').then(() => true).catch(() => false);
  report.check('resumed subscription (Last-Event-ID) reached ready', bReady && b.httpStatus === 200, `status=${b.httpStatus}`);

  // LOAD-BEARING: a Last-Event-ID connection must run CATCH-UP, not a cold restart.
  // A cold-started connection delivers the active rows in a `snapshot` body and emits
  // NO `commitment` deltas — so the absence of a snapshot frame (and delivery via
  // deltas, below) is what proves the cursor was actually honored. Without this, a
  // server that ignored the cursor would still pass the resume gate (the hole a
  // review surfaced and the mutation `stream.ts` → ignore cursor reproduces).
  const bSnapshots = b.framesOfType('snapshot').length;
  const resumeMode = report.check("resume ran CATCH-UP, not a cold start — NO snapshot frame on the Last-Event-ID connection",
    bSnapshots === 0, `${bSnapshots} snapshot frame(s)`);
  if (!resumeMode) report.finding({ severity: 'high', title: 'Last-Event-ID ignored — resume cold-started',
    detail: `A Last-Event-ID connection received a cold-start snapshot (${bSnapshots} snapshot frame[s]) instead of catch-up; the server did not honor the resume cursor, so no real catch-up/dedup occurred.` });

  // Delivery is measured from CATCH-UP deltas only (commitment events before
  // `ready`, never the snapshot), so the cross-outage row + overlap re-delivery
  // must come via real cursor catch-up — a cold-started server delivers none.
  await waitFor(() => catchUpDeltaHashes(b).has(`0x${'33'.repeat(32)}`) || b.framesOfType('ready').length > 0, 12_000);

  const seenAfter = catchUpDeltaHashes(b);
  const all = new Set<string>([...seenBefore, ...seenAfter]);
  const expected = new Set(['11', '22', '33'].map((bb) => `0x${bb.repeat(32)}`));

  const missing = [...expected].filter((h) => !all.has(h));
  const phantom = [...all].filter((h) => !expected.has(h));

  // GAPLESS — every seeded commitment is delivered as a DELTA across the boundary
  // (A's r1/r2 live deltas + B's catch-up deltas). A cursor-ignored cold start
  // delivers nothing as a delta on B, so r3 goes missing → this fails.
  const gapless = report.check('resumed sequence is GAPLESS — every seeded commitment delivered as a delta across the restart',
    missing.length === 0, missing.length ? `missing ${missing.join(',')}` : 'all 3 present');

  // The resume must actually re-deliver a pre-restart row (the fresh server has no
  // in-memory dedup, so overlap re-sends it) — that is what makes the client-side
  // content dedup (the F5 boot-seed) load-bearing. If nothing is re-delivered, the
  // dedup was never exercised.
  const reDelivered = [...seenAfter].filter((h) => seenBefore.has(h));
  report.check('overlap re-delivered a pre-restart row on resume (exercises the client content-dedup / boot-seed)',
    reDelivered.length > 0, reDelivered.length ? `${reDelivered.length} re-delivered` : 'no overlap observed');
  report.check('the cross-outage row (r3) was delivered to the resumed client as a catch-up DELTA (not a snapshot)',
    seenAfter.has(`0x${'33'.repeat(32)}`));

  // DUPLICATE-FREE (canonical, content-keyed): after the client collapses the at-least-once
  // stream by content key (commitmentHash — the boot-seed key), the result is EXACTLY the
  // seeded set: no phantom row, no logical event that survives content-dedup as a duplicate.
  const dupFree = report.check('DUPLICATE-FREE — content-dedup (by commitmentHash) yields exactly the seeded set (no phantom)',
    phantom.length === 0, phantom.length ? `phantom ${phantom.join(',')}` : 'no phantom');

  // Secondary (resume idempotency): a re-delivered row should carry a STABLE cursor id so
  // Last-Event-ID resume is idempotent. In a richer multi-resource stream the composite
  // cursor can legitimately shift, so this is a low-severity observation, not the dup gate.
  const idsByHash = new Map<string, Set<string>>();
  for (const c of [a, b]) {
    for (const f of c.frames) {
      if (f.event !== 'commitment' || f.id === undefined) continue;
      const h = (f.data as { commitmentHash?: string }).commitmentHash?.toLowerCase();
      if (!h) continue;
      (idsByHash.get(h) ?? idsByHash.set(h, new Set()).get(h)!).add(f.id);
    }
  }
  const unstable = [...idsByHash.entries()].filter(([, ids]) => ids.size > 1);
  const stableIds = report.check('re-delivered rows carry a stable cursor id (Last-Event-ID resume is idempotent)',
    unstable.length === 0, unstable.length ? `${unstable.length} row(s) with >1 id` : 'stable ids');

  if (!gapless) report.finding({ severity: 'high', title: 'Dropped event across restart', detail: `Seeded commitment(s) ${missing.join(',')} were never delivered across the SIGTERM + Last-Event-ID resume boundary.` });
  if (!dupFree) report.finding({ severity: 'high', title: 'Phantom/duplicated event across restart', detail: `Content-dedup left extra commitment(s) ${phantom.join(',')} the client cannot reconcile to a seeded row.` });
  if (!stableIds) report.finding({ severity: 'low', title: 'Unstable resume cursor id', detail: `A re-delivered commitment carried different cursor ids before/after restart — Last-Event-ID resume is not idempotent for it.` });

  await b.close().catch(() => undefined);
}

function describeDeferred(report: Report): void {
  report.section('DEFERRED — remaining stream-readiness gate (NOT in this slice)');
  for (const item of [
    'N=100 full scale profile (steady-state + ramp)',
    'reconnect storms (mass simultaneous reconnect)',
    'mid-stream token refresh under load',
    'slow-client backpressure / shedding under sustained load (slowClientShedTotal)',
    'metric gates: latency, throughput, >=99% reconnect success, bounded memory',
  ]) report.skip(item, 'deferred to the agent-onboarding trigger');
}

async function main(): Promise<void> {
  const report = new Report();
  const fake = new FakeSupabase();
  const fakePort = await fake.start();
  const port = await getFreePort();
  const server = await startServer(buildEnv(fakePort, port), port);
  console.log(`Starting local core-api (port ${port}) against fake Supabase (port ${fakePort}); cap=${CAP}; SIGTERM graceful: ${SIGTERM_IS_GRACEFUL}`);
  await server.waitReady();
  const ctx: Ctx = { serverUrl: `http://127.0.0.1:${port}`, fakePort, fake, server, report };

  try {
    await profile1(ctx);
    await profile2(ctx);
  } catch (e) {
    report.finding({ severity: 'critical', title: 'Harness aborted', detail: `${(e as Error).message}\n${(e as Error).stack ?? ''}` });
  } finally {
    describeDeferred(report);
    ctx.server.forceKill();
    await ctx.server.exited.catch(() => undefined);
    await fake.stop();
    if (fake.fidelityGaps.length > 0) {
      console.log(`\n[fake-fidelity] ${fake.fidelityGaps.length} unhandled query feature(s) — review before trusting findings:`);
      for (const g of fake.fidelityGaps.slice(0, 10)) console.log(`  - ${g.table}: ${g.reason} (${g.url})`);
    }
  }

  const ok = report.finish();
  process.exit(ok ? 0 : 1);
}

void main();
