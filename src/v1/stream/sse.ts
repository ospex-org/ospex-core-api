/**
 * Server-Sent Events wire helpers.
 *
 * Frame format: optional `id:` (the opaque cursor), `event:` (delta | resync |
 * ready), `data:` (one-line JSON — JSON.stringify never emits raw newlines, so
 * a single `data:` line is always valid). Each write is flushed past the
 * compression middleware (it adds `res.flush`); the route is also excluded from
 * compression in server.ts and sets `no-transform`, so this is belt-and-braces.
 */

import type { Response } from 'express';

export type SseEvent = 'ready' | 'delta' | 'resync';

export function initSse(res: Response): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Defeat proxy buffering (nginx and friends) that would hold events back.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export function writeEvent(res: Response, event: SseEvent, data: unknown, id?: string): void {
  if (res.writableEnded) return; // client gone — don't write to a closed socket
  let frame = '';
  if (id !== undefined) frame += `id: ${id}\n`;
  frame += `event: ${event}\n`;
  frame += `data: ${JSON.stringify(data)}\n\n`;
  res.write(frame);
  flush(res);
}

/** SSE comment line — used for heartbeats to keep the connection under the idle timeout. */
export function writeComment(res: Response, text: string): void {
  if (res.writableEnded) return;
  res.write(`: ${text}\n\n`);
  flush(res);
}

function flush(res: Response): void {
  const r = res as Response & { flush?: () => void };
  if (typeof r.flush === 'function') r.flush();
}
