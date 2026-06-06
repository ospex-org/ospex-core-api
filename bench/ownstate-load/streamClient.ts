/**
 * Black-box client for the own-state SSE surface: mints a real stream-auth
 * bearer (challenge → EIP-712 sign → token) with an ethers wallet, then opens
 * `GET /v1/stream/own-state` over `fetch` and parses the SSE frames. It is
 * deliberately decoupled from `src/` — the harness exercises the deployed HTTP
 * contract, not internal functions. The EIP-712 typed-data mirrors
 * `src/lib/eip712.ts` (OspexStreamAuth); kept inline so the harness has no
 * compile coupling to the server build.
 */

import { type BaseWallet, type TypedDataField } from 'ethers';

const STREAM_AUTH_TYPES: Record<string, TypedDataField[]> = {
  OspexStreamAuth: [
    { name: 'address', type: 'address' },
    { name: 'resource', type: 'string' },
    { name: 'scope', type: 'string' },
    { name: 'network', type: 'StreamAuthNetwork' },
    { name: 'audience', type: 'string' },
    { name: 'challengeId', type: 'string' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
  StreamAuthNetwork: [{ name: 'chainId', type: 'uint256' }],
};

export interface MintedToken {
  token: string;
  address: string;
  expiresAt: number;
}

/** Challenge → sign → token. Throws with the server's body on any non-200. */
export async function mintToken(
  baseUrl: string,
  wallet: BaseWallet,
  matchingModule: string,
): Promise<MintedToken> {
  const address = wallet.address;
  const chRes = await fetch(`${baseUrl}/v1/auth/stream-challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  if (chRes.status !== 200) {
    throw new Error(`stream-challenge ${chRes.status}: ${await chRes.text()}`);
  }
  const { challenge } = (await chRes.json()) as { challenge: StreamChallenge };
  const domain = {
    name: 'OspexStreamAuth',
    version: '1',
    chainId: challenge.network.chainId,
    verifyingContract: matchingModule,
  };
  const signature = await wallet.signTypedData(domain, STREAM_AUTH_TYPES, challenge);
  const tkRes = await fetch(`${baseUrl}/v1/auth/stream-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge, signature }),
  });
  if (tkRes.status !== 200) {
    throw new Error(`stream-token ${tkRes.status}: ${await tkRes.text()}`);
  }
  const { token, expiresAt } = (await tkRes.json()) as { token: string; expiresAt: number };
  return { token, address: address.toLowerCase(), expiresAt };
}

interface StreamChallenge {
  address: string;
  resource: string;
  scope: string;
  network: { chainId: number };
  audience: string;
  challengeId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SseFrame {
  event: string;
  data: unknown;
  id: string | undefined;
  receivedAtMs: number;
}

/**
 * One own-state SSE subscription. Connects, parses frames, records the ordered
 * event log + a dedup-by-id view (the client-side dedup the SDK / MM boot-seed
 * performs), and exposes promises for `ready` and stream close.
 */
export class OwnStateClient {
  readonly frames: SseFrame[] = [];
  /** Frames keyed by SSE id (the cursor). First-write-wins — models client dedup. */
  readonly byId = new Map<string, SseFrame>();
  httpStatus = 0;
  httpBody = '';
  lastEventId: string | undefined;
  closed = false;
  closeReason: 'server' | 'aborted' | 'error' = 'server';
  /** Whether a final truncated SSE frame was observed (an unclean close signal). */
  sawPartialFrame = false;

  private controller = new AbortController();
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  readonly ready: Promise<void>;
  private closeResolve!: () => void;
  readonly done: Promise<void>;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly opts: { lastEventId?: string; label?: string } = {},
  ) {
    this.ready = new Promise((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    // Mark `ready` as handled so a non-200 open (e.g. the expected 429 on the
    // cap+1 connection, which is checked via httpStatus, not awaited) never
    // surfaces as an unhandledRejection. Explicit `await client.ready` still
    // observes the rejection.
    this.ready.catch(() => undefined);
    this.done = new Promise((res) => {
      this.closeResolve = res;
    });
    this.lastEventId = opts.lastEventId;
  }

  get label(): string {
    return this.opts.label ?? 'client';
  }

  /** Open the connection and start consuming. Resolves once the HTTP response
   *  headers are in (status known); the frame loop continues in the background. */
  async open(): Promise<void> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' };
    if (this.opts.lastEventId) headers['Last-Event-ID'] = this.opts.lastEventId;
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/stream/own-state`, {
        headers,
        signal: this.controller.signal,
      });
    } catch (e) {
      this.httpStatus = -1;
      this.closeReason = 'error';
      this.closed = true;
      this.readyReject(new Error(`connect failed: ${(e as Error).message}`));
      this.closeResolve();
      return;
    }
    this.httpStatus = resp.status;
    if (resp.status !== 200 || !resp.body) {
      this.httpBody = await resp.text();
      this.closed = true;
      this.readyReject(new Error(`stream open ${resp.status}: ${this.httpBody}`));
      this.closeResolve();
      return;
    }
    void this.consume(resp.body);
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          this.onFrame(raw);
        }
      }
      // Any bytes left after the last `\n\n` is an unterminated (truncated) frame.
      if (buf.trim().length > 0 && !buf.startsWith(':')) this.sawPartialFrame = true;
    } catch {
      this.closeReason = this.controller.signal.aborted ? 'aborted' : 'error';
    }
    this.closed = true;
    if (this.controller.signal.aborted) this.closeReason = 'aborted';
    this.closeResolve();
  }

  private onFrame(raw: string): void {
    if (raw.startsWith(':')) return; // heartbeat comment
    let event = 'message';
    let dataStr = '';
    let id: string | undefined;
    for (const line of raw.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trimStart();
      else if (line.startsWith('event:')) event = line.slice(6).trimStart();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trimStart();
    }
    let data: unknown = dataStr;
    try {
      data = JSON.parse(dataStr);
    } catch {
      /* leave as string */
    }
    const frame: SseFrame = { event, data, id, receivedAtMs: Date.now() };
    this.frames.push(frame);
    if (id !== undefined) {
      this.lastEventId = id;
      if (!this.byId.has(id)) this.byId.set(id, frame);
    }
    if (event === 'ready') this.readyResolve();
  }

  /** Abort the connection from the client side (does NOT signal the server). */
  async close(): Promise<void> {
    this.controller.abort();
    await this.done;
  }

  framesOfType(type: string): SseFrame[] {
    return this.frames.filter((f) => f.event === type);
  }
}
