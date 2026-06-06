/**
 * Tiny in-process fake of the Supabase PostgREST surface the own-state SSE path
 * reads. The M1 load harness points a spawned LOCAL core-api at this fake
 * (`SUPABASE_URL=http://127.0.0.1:<port>`) so the whole run is self-contained:
 * no prod core-api, no prod database, no credentials. The harness is the data
 * source — it serves empty results by default (profile 1 = transport/capacity)
 * and can `seed()` controlled rows (profile 2 = event injection across restart).
 *
 * Scope: only what `@supabase/supabase-js` emits for the own-state read path —
 * `GET /rest/v1/<table>?select=…&<col>=<op>.<val>&order=…&limit=…[&or=(…)]`.
 * It implements just enough PostgREST semantics (eq / neq / in / gt / gte / lt /
 * lte / is.null, the keyset `or=(…)` expression, `order`, `limit`, `offset`, and
 * the `Prefer: count=exact` → `Content-Range` header) for the server's keyset
 * pagination + watermark logic to behave as it does against real Postgres. It is
 * deliberately NOT a general PostgREST — anything it does not understand is
 * surfaced loudly (logged) so a harness-fidelity gap can never masquerade as a
 * server finding.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Row = Record<string, unknown>;

interface ParsedFilter {
  col: string;
  op: string;
  raw: string;
}

/** A query the fake could not faithfully serve — recorded so the harness can fail loudly. */
export interface FidelityGap {
  table: string;
  reason: string;
  url: string;
}

export class FakeSupabase {
  private server: http.Server | null = null;
  private readonly tables = new Map<string, Row[]>();
  /** Every request, for debugging / assertions about what the server polled. */
  readonly requests: Array<{ table: string; url: string }> = [];
  /** Filters/operators the fake met but could not faithfully apply. */
  readonly fidelityGaps: FidelityGap[] = [];

  /** Replace the rows for a table. Pass [] to clear. */
  seed(table: string, rows: Row[]): void {
    this.tables.set(table, rows.map((r) => ({ ...r })));
  }

  /** Append rows to a table (simulates the indexer writing new rows between polls). */
  append(table: string, rows: Row[]): void {
    const existing = this.tables.get(table) ?? [];
    this.tables.set(table, [...existing, ...rows.map((r) => ({ ...r }))]);
  }

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // PostgREST lives under /rest/v1/<table>; supabase-js also probes a few
    // health/realtime paths we can answer trivially.
    const restMatch = url.pathname.match(/^\/rest\/v1\/([^/?]+)/);
    if (!restMatch) {
      // Unknown path (e.g. /auth/v1/*, /realtime/*). 200 empty keeps the client happy.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }
    const table = decodeURIComponent(restMatch[1]!);
    this.requests.push({ table, url: req.url ?? '' });

    if (req.method !== 'GET') {
      // The own-state READ path never writes. A write would be a surprise — record it.
      this.fidelityGaps.push({ table, reason: `unexpected ${req.method}`, url: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }

    const rows = this.query(table, url);
    const wantsObject = (req.headers['accept'] ?? '').includes('application/vnd.pgrst.object+json');
    const wantsCount = String(req.headers['prefer'] ?? '').includes('count=');

    if (wantsObject) {
      // .single() / .maybeSingle(): one object, or PGRST116 on 0 rows (supabase-js
      // maps that to { data: null } for maybeSingle).
      if (rows.length === 0) {
        res.writeHead(406, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'PGRST116', message: '0 rows', details: '', hint: null }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rows[0]));
      return;
    }

    const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json' };
    if (wantsCount) {
      const n = rows.length;
      headers['content-range'] = n === 0 ? '*/0' : `0-${n - 1}/${n}`;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(rows));
  }

  private query(table: string, url: URL): Row[] {
    let rows = (this.tables.get(table) ?? []).map((r) => ({ ...r }));
    const params = url.searchParams;

    for (const [key, value] of params.entries()) {
      if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') continue;
      if (key === 'or') {
        rows = rows.filter((r) => this.matchOr(r, value, table, url));
        continue;
      }
      // Standard `<col>=<op>.<rest>` filter.
      const dot = value.indexOf('.');
      if (dot === -1) {
        this.fidelityGaps.push({ table, reason: `unparseable filter ${key}=${value}`, url: url.search });
        continue;
      }
      const op = value.slice(0, dot);
      const operand = value.slice(dot + 1);
      rows = rows.filter((r) => this.matchOne(r, { col: key, op, raw: operand }, table, url));
    }

    // ORDER BY col.asc/desc, comma-separated.
    const order = params.get('order');
    if (order) {
      const terms = order.split(',').map((t) => {
        const [col, dir] = t.split('.');
        return { col: col!, desc: dir === 'desc' };
      });
      rows.sort((a, b) => {
        for (const t of terms) {
          const cmp = compareValues(a[t.col], b[t.col]);
          if (cmp !== 0) return t.desc ? -cmp : cmp;
        }
        return 0;
      });
    }

    const offset = Number(params.get('offset') ?? '0');
    if (Number.isInteger(offset) && offset > 0) rows = rows.slice(offset);
    const limit = params.get('limit');
    if (limit !== null && Number.isInteger(Number(limit))) rows = rows.slice(0, Number(limit));
    return rows;
  }

  /** PostgREST keyset `or=(row_updated_at.gt.X,and(row_updated_at.eq.X,id.gt.Y))`. */
  private matchOr(row: Row, expr: string, table: string, url: URL): boolean {
    const inner = expr.startsWith('(') && expr.endsWith(')') ? expr.slice(1, -1) : expr;
    const terms = splitTopLevel(inner);
    return terms.some((term) => {
      if (term.startsWith('and(') && term.endsWith(')')) {
        const andInner = term.slice(4, -1);
        return splitTopLevel(andInner).every((sub) => this.matchFilterToken(row, sub, table, url));
      }
      return this.matchFilterToken(row, term, table, url);
    });
  }

  /** A `col.op.operand` token (used inside or=/and=). */
  private matchFilterToken(row: Row, token: string, table: string, url: URL): boolean {
    const parts = token.split('.');
    if (parts.length < 3) {
      this.fidelityGaps.push({ table, reason: `unparseable or-token ${token}`, url: url.search });
      return true;
    }
    const col = parts[0]!;
    const op = parts[1]!;
    const operand = parts.slice(2).join('.');
    return this.matchOne(row, { col, op, raw: operand }, table, url);
  }

  private matchOne(row: Row, f: ParsedFilter, table: string, url: URL): boolean {
    const v = row[f.col];
    switch (f.op) {
      case 'eq':
        return looseEq(v, decodeOperand(f.raw));
      case 'neq':
        return !looseEq(v, decodeOperand(f.raw));
      case 'gt':
        return compareValues(v, decodeOperand(f.raw)) > 0;
      case 'gte':
        return compareValues(v, decodeOperand(f.raw)) >= 0;
      case 'lt':
        return compareValues(v, decodeOperand(f.raw)) < 0;
      case 'lte':
        return compareValues(v, decodeOperand(f.raw)) <= 0;
      case 'is':
        return f.raw === 'null' ? v === null || v === undefined : looseEq(v, f.raw);
      case 'in': {
        const list = parseInList(f.raw);
        return list.some((x) => looseEq(v, x));
      }
      default:
        this.fidelityGaps.push({ table, reason: `unsupported operator ${f.op}`, url: url.search });
        return true; // fail-open so an unknown filter never hides a real server finding as "no rows"
    }
  }
}

// ── value helpers ─────────────────────────────────────────────────────────

function decodeOperand(raw: string): string {
  // PostgREST wraps strings with special chars in double quotes.
  let s = raw;
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s;
}

function parseInList(raw: string): string[] {
  let s = raw;
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  return s.split(',').map(decodeOperand);
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined || String(b) === 'null';
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Order-by + keyset comparison. Strings compared lexicographically (ISO timestamptz
 *  sorts correctly that way); numeric strings compared numerically when both parse. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && String(a).trim() !== '' && String(b).trim() !== '') {
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Split on top-level commas, respecting nested `and(...)` / `(...)` parens. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
