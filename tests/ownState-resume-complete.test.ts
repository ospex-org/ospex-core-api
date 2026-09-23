/**
 * `#76` B1, END TO END — the reviewer's own case from the PR #100 review, kept
 * because the property is about what a RECONNECT gets rather than about what a
 * query asks for.
 *
 * The snapshot went complete and the resume leg did not, so a wallet recovered
 * completely at connect and then, on an ordinary reconnect with the cursor it had
 * been handed, seeded 200 keys and re-asserted `degraded`. Everything the cap
 * omitted fell out of the hub's cache, so a speculation settling without touching
 * its position row reached nobody. Reproduced here before fixing:
 * `resumePositions: 200`, `resumeHealth: [degraded]`, `missingTailClaimable: 0`.
 * After: 300, `[]`, 1 — the same numbers as the reviewer's own cap control, reached
 * by paging rather than by raising a constant.
 *
 * Their gate on `REVIEW_REQUIRE_COMPLETE_RESUME` is removed: it existed so the case
 * could be run red against base, and committed it is unconditional.
 */
/** Reviewer-owned PR #100 probes. Synthetic relational fixtures; no live DB/RPC.
 * Imports production snapshot/fetcher/hub/SSE handler. The fake applies filters,
 * nested PostgREST OR/AND, timestamp+bigint ordering, selected columns and limits.
 * REVIEW_BASE=1 changes ONLY the known cold-snapshot expectations for base.
 * REVIEW_REQUIRE_COMPLETE_RESUME=1 turns the recorded resume gap into a red test.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
const config = vi.hoisted(() => ({ network: 'polygon', chainId: 137, redactHiddenPublic: true, ownStateSnapshotMaxCommitments: 5000 }));
const mocks = vi.hoisted(() => ({ getSupabase: vi.fn(), cooldown: vi.fn(async () => null) }));
vi.mock('../src/lib/env.js', () => ({ loadConfig: () => config }));
vi.mock('../src/lib/supabase.js', () => ({ getSupabase: mocks.getSupabase }));
vi.mock('../src/lib/voidCooldown.js', () => ({ readVoidCooldownSeconds: mocks.cooldown, DEFAULT_COOLDOWN_TIMEOUT_MS: 60_000 }));
const { loadOwnStateSnapshot } = await import('../src/v1/ownState/snapshot.js');
const { getOwnStateStreamHandler, __resetOwnStateStreamMetrics } = await import('../src/v1/ownState/stream.js');
const { OwnStateHub, __setOwnStateHubForTest } = await import('../src/v1/ownState/hub.js');
const { __resetConnections } = await import('../src/v1/stream/connections.js');
const { compareIsoTimestamptz } = await import('../src/v1/ownState/timestamps.js');
const { encodeOwnStateCursor, decodeOwnStateCursor, OWN_STATE_CURSOR_VERSION } = await import('../src/v1/ownState/cursor.js');
const ADDRESS = '0x1111111111111111111111111111111111111111';
const NOW = Date.parse('2026-09-23T16:00:00.000Z');
const STAMP = '2026-09-23T15:00:00.000100+00:00';
const BASE = process.env.REVIEW_BASE === '1';
type Row = Record<string, string | number | boolean | null>;
type Tables = Record<string, Row[]>;
type Query = { table: string; select: string; filters: Array<[string,string,unknown]>; or?: string; orders: Array<[string,boolean]>; limit?: number; signal?: AbortSignal; rows?: number };
type Reply = { data: Row[] | null; error: { message: string } | null };
/**
 * Ordering and comparison the way Postgres would, and the hottest function in this
 * file by a wide margin: the page-budget case filters and sorts a 12,736-row table
 * once per page for 64 pages, so `cmp` runs tens of millions of times and its
 * constant factor IS that test's runtime.
 *
 * It used to build up to FOUR BigInts per numeric comparison —
 * `BigInt(String(a)) < BigInt(String(b)) ? -1 : BigInt(String(a)) > BigInt(String(b))`
 * — which put that one case at 4,787ms against vitest's 5,000ms default timeout. A
 * 213ms margin on this machine is no margin at all on a slower one, and the
 * reviewer of PR #102 hit the timeout on theirs (on the BASE commit too — it is not
 * a #102 regression). Now it builds at most two, and skips BigInt entirely when both
 * operands are short decimal integers.
 *
 * The 15-digit bound is the load-bearing part: 10^15 < 2^53, so a Number comparison
 * of two such values is exact. `risk_amount`/`profit_amount` are uint256 as decimal
 * strings and DO exceed it, which is why the BigInt path stays rather than being
 * replaced — the fast path must not be allowed to swallow them. Anything that is not
 * a plain non-negative integer string (a sign, a decimal point, an empty string)
 * fails the test and falls through, so the fast path can only ever agree with the
 * slow one.
 */
const TIME_KEY = /(_at|_time)$/;
const NUM_KEY = /^(id|speculation_id|contest_id|risk_amount|profit_amount)$/;
/** <= 15 digits is < 2^53, so Number compares these exactly. */
const SAFE_DIGITS = /^\d{1,15}$/;
function cmp(key: string, a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (TIME_KEY.test(key)) return compareIsoTimestamptz(String(a), String(b));
  if (NUM_KEY.test(key)) {
    const sa = String(a); const sb = String(b);
    if (SAFE_DIGITS.test(sa) && SAFE_DIGITS.test(sb)) {
      const na = Number(sa); const nb = Number(sb);
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    const x = BigInt(sa); const y = BigInt(sb);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function split(expr: string): string[] {
  let d = 0; let start = 0; const parts: string[] = [];
  for (let i=0;i<expr.length;i++) { if(expr[i] === '(')d++; if(expr[i] === ')')d--; if(expr[i] === ',' && d === 0){parts.push(expr.slice(start,i));start=i+1;} }
  parts.push(expr.slice(start)); return parts;
}
function predicate(expr: string, r: Row): boolean {
  if (expr.startsWith('and(') && expr.endsWith(')')) return split(expr.slice(4,-1)).every(e => predicate(e,r));
  if (expr.startsWith('or(') && expr.endsWith(')')) return split(expr.slice(3,-1)).some(e => predicate(e,r));
  const m = /^(\w+)\.(eq|gt|gte|lt|lte)\.(.*)$/.exec(expr);
  if (!m) throw new Error(`Unsupported expression ${expr}`);
  const c = cmp(m[1]!,r[m[1]!],m[3]);
  return m[2] === 'eq' ? c === 0 : m[2] === 'gt' ? c > 0 : m[2] === 'gte' ? c >= 0 : m[2] === 'lt' ? c < 0 : c <= 0;
}
function database(t: Tables, intercept?: (q: Query, reply: Reply) => Reply | void) {
  const queries: Query[] = [];
  return { queries, from(table: string) {
    const q: Query = { table, select: '*', filters: [], orders: [] };
    const run = (): Reply => {
      queries.push(q);
      const all = (t[table] ?? []).filter(r => q.filters.every(([op,k,v]) => {
        if (op === 'in') return (v as unknown[]).some(x=>cmp(k,r[k],x)===0);
        const c=cmp(k,r[k],v); return op==='eq'||op==='is' ? c===0 : op==='neq' ? c!==0 : op==='gt' ? c>0 : op==='gte' ? c>=0 : op==='lt' ? c<0 : c<=0;
      }) && (q.or===undefined || split(q.or).some(e=>predicate(e,r))))
      .sort((a,b)=> { for(const [k,asc] of q.orders) {const c=cmp(k,a[k],b[k]);if(c)return asc?c:-c;}return 0; })
      .slice(0,Math.min(q.limit??1000,1000))
      .map(r=>q.select==='*'?{...r}:Object.fromEntries(q.select.split(',').map(k=>k.trim()).map(k=>[k,r[k]??null])) as Row);
      const reply = intercept?.(q,{data:all,error:null}) ?? {data:all,error:null}; q.rows=reply.data?.length??0; return reply;
    };
    const b = {
      select(s: string){q.select=s;return b;},
      eq(k:string,v:unknown){q.filters.push(['eq',k,v]);return b;},
      neq(k:string,v:unknown){q.filters.push(['neq',k,v]);return b;},
      is(k:string,v:unknown){q.filters.push(['is',k,v]);return b;},
      in(k:string,v:unknown[]){q.filters.push(['in',k,v]);return b;},
      gt(k:string,v:unknown){q.filters.push(['gt',k,v]);return b;},
      gte(k:string,v:unknown){q.filters.push(['gte',k,v]);return b;},
      lt(k:string,v:unknown){q.filters.push(['lt',k,v]);return b;},
      lte(k:string,v:unknown){q.filters.push(['lte',k,v]);return b;},
      or(s:string){q.or=s;return b;},
      order(k:string,o:{ascending:boolean}){q.orders.push([k,o.ascending]);return b;},
      limit(n:number){q.limit=n;return b;},
      abortSignal(s:AbortSignal){q.signal=s;return b;},
      range(){throw new Error('Unexpected offset pagination');},
      async maybeSingle(){const r=run();return {...r,data:r.data?.[0]??null};},
      then(resolve:(r:Reply)=>void){resolve(run());},
    }; return b;
  }};
}
function fixture(n:number, live=n): Tables {
  const t:Tables={positions:[],speculations:[],contests:[]};
  for(let id=1;id<=n;id++) {
    const terminal=id<=n-live;
    t.positions!.push({id,speculation_id:id,user_address:ADDRESS,network:'polygon',position_type:'upper',risk_amount:'10000',profit_amount:'15000',claimed:false,claimed_at:null,position_created_at:STAMP,row_updated_at:STAMP});
    t.speculations!.push({speculation_id:id,contest_id:id,network:'polygon',market_type:'moneyline',line_ticks:0,speculation_status:terminal?'closed':'open',win_side:terminal?'home':'tbd',row_updated_at:STAMP});
    t.contests!.push({contest_id:id,network:'polygon',away_team:'Away',home_team:'Home',sport_slug:'mlb',contest_status:terminal?'scored':'unverified',away_score:terminal?0:null,home_score:terminal?1:null,start_time:null,row_updated_at:STAMP});
  } return t;
}
function liveCursor(): import('../src/v1/ownState/cursor.js').OwnStateCursor { return {t:'own-state' as const,v:OWN_STATE_CURSOR_VERSION,k:'live' as const,c:{s:'2026-09-23T14:00:00.000Z',i:'0'},f:{s:'2026-09-23T14:00:00.000Z',i:'0'},p:{s:'2026-09-23T14:00:00.000Z',i:'0'}}; }
function response() {
  const r={statusCode:0,body:undefined as unknown,writableEnded:false,writableLength:0,written:[] as string[],closeHandlers:[] as Array<()=>void>,headers:{} as Record<string,unknown>,
    setHeader(k:string,v:unknown){r.headers[k]=v;},flushHeaders(){},flush(){},
    write(s:string){r.written.push(s);return true;},end(){if(r.writableEnded)return;r.writableEnded=true;for(const h of r.closeHandlers)h();},
    on(ev:string,cb:()=>void){if(ev==='close')r.closeHandlers.push(cb);return r;},status(c:number){r.statusCode=c;return r;},json(b:unknown){r.body=b;return r;}};
  return r;
}
function events(r:ReturnType<typeof response>) {
  return r.written.join('').split('\n\n').filter(x=>x.includes('event:')).map(frame=>{
    const lines=frame.split('\n');const get=(p:string)=>lines.find(x=>x.startsWith(p))?.slice(p.length).trim();
    return {event:get('event:')!,data:JSON.parse(get('data:')??'{}') as Record<string,unknown>,id:get('id:')};
  });
}
function request(cursor?:string):Request {return {query:{},params:{},ip:'9.9.9.9',header:(k:string)=>k.toLowerCase()==='last-event-id'?cursor:undefined,streamAuth:{address:ADDRESS,expiresAt:Math.floor(Date.now()/1000)+900}} as unknown as Request;}
async function flush(n=600){for(let i=0;i<n;i++)await Promise.resolve();}
function attach(db: ReturnType<typeof database>) {mocks.getSupabase.mockReturnValue(db);const hub=new OwnStateHub({getClient:()=>db as unknown as SupabaseClient,getNetwork:()=> 'polygon',pollMs:1e9,resyncMs:1e9});__setOwnStateHubForTest(hub);return hub;}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);vi.clearAllMocks();__resetConnections();__resetOwnStateStreamMetrics();});
afterEach(()=>{__setOwnStateHubForTest(undefined);__resetConnections();__resetOwnStateStreamMetrics();vi.clearAllTimers();vi.useRealTimers();});

for(const n of [0,198,199,200,201,398,399,621]) it(`complete real snapshot ${n}`,async()=>{
  const db=database(fixture(n));mocks.getSupabase.mockReturnValue(db);
  const out=await loadOwnStateSnapshot(ADDRESS,null,Date.now());expect(out.ok).toBe(true);if(!out.ok)throw new Error(JSON.stringify(out));
  expect(out.body.positions).toHaveLength(BASE?Math.min(n,200):n);expect(out.seedRows).toHaveLength(BASE?Math.min(n,200):n);
  expect(out.body.positionsTruncated).toBe(BASE&&n>=200);expect(decodeOwnStateCursor(out.body.cursor).k).toBe('live');
  if(!BASE)expect(db.queries.filter(q=>q.table==='positions'&&q.limit===199).length).toBe(Math.floor(n/199)+1);
  expect(mocks.cooldown).not.toHaveBeenCalled();
});

for(const n of [199,635])it(`terminal history ${n}, fixed three live keys: complete SSE then bounded polls`,async()=>{
  const tables=fixture(n,3);
  // Keep the SAME three live rows in the base capped window and the head
  // complete traversal; otherwise fewer reads can mean missing coverage.
  for(const table of ['positions','speculations','contests']) for(const row of tables[table]!.slice(-3)) { row.row_updated_at='2026-09-23T15:30:00.000Z'; if(table==='positions')row.position_created_at='2026-09-23T15:30:00.000Z'; }
  const db=database(tables);const hub=attach(db);const r=response();getOwnStateStreamHandler(request(),r as unknown as Response);await flush();
  const cold=events(r);expect(cold.filter(e=>e.event==='resync')).toEqual([]);expect(cold.find(e=>e.event==='ready')).toBeDefined();
  expect(cold.find(e=>e.event==='snapshot')?.data.positionsTruncated).toBe(BASE&&n>=200);
  const ticks:unknown[]=[];
  for(let tick=1;tick<=3;tick++){const start=db.queries.length;vi.setSystemTime(NOW+1500*tick);await hub.pollWallet(ADDRESS);const q=db.queries.slice(start).filter(q=>['positions','speculations','contests'].includes(q.table));ticks.push({statements:q.length,rows:q.reduce((a,q)=>a+(q.rows??0),0),maintenance:q.filter(q=>q.table==='positions'&&q.filters.some(f=>f[0]==='in')).map(q=>q.rows)});}
  console.log('REVIEW_COST',JSON.stringify({n,base:BASE,coldEvents:cold.map(e=>e.event),ticks}));
  expect(ticks).toEqual(Array.from({length:3},()=>({statements:4,rows:9,maintenance:[3]})));
  expect(events(r).filter(e=>e.event==='degraded')).toHaveLength(BASE&&n>=200?1:0);r.end();
});

for(const n of [0,199,200,201,399,400,3199,3200,3201])it(`real claimed keyset ${n} with timestamp ties`,async()=>{
  const t=fixture(0);
  for(let id=1;id<=n;id++)t.positions!.push({id,speculation_id:id,user_address:ADDRESS,network:'polygon',position_type:'upper',risk_amount:'10000',profit_amount:'15000',claimed:true,claimed_at:STAMP,position_created_at:STAMP,row_updated_at:id%2===0?'2026-09-23T15:00:00.000200Z':STAMP});
  const db=database(t);mocks.getSupabase.mockReturnValue(db);const input=liveCursor();const out=await loadOwnStateSnapshot(ADDRESS,input,Date.now());
  expect(out.ok).toBe(true);if(!out.ok)throw new Error(JSON.stringify(out));
  const cap=BASE?200:3200;expect(out.body.positions).toHaveLength(Math.min(n,cap));expect(new Set(out.body.positions.map(p=>p.speculationId)).size).toBe(Math.min(n,cap));
  expect(out.body.positionsTruncated).toBe(n>=cap);const reads=db.queries.filter(q=>q.table==='positions'&&q.filters.some(f=>f[1]==='claimed'&&f[2]===true));
  expect(reads.length).toBe(BASE?1:Math.min(16,Math.floor(n/200)+1));
  if(n>=cap)expect(decodeOwnStateCursor(out.body.cursor).p).toEqual(input.p);
});

it('real complete deadline refusal returns safe partial cold SSE (even below the old cap)',async()=>{
  if(BASE)return;let refused=false;const db=database(fixture(20),(q,r)=>{if(!refused&&q.table==='positions'&&q.limit===199){refused=true;vi.setSystemTime(NOW+15_001);}return r;});
  attach(db);const r=response();getOwnStateStreamHandler(request(),r as unknown as Response);await flush();
  expect(refused).toBe(true);expect(events(r).map(e=>e.event)).toEqual(['snapshot','degraded','ready']);
  const snap=events(r)[0]!.data;expect((snap.positions as unknown[]).length).toBe(20);expect(snap.positionsTruncated).toBe(true);expect(decodeOwnStateCursor(String(snap.cursor)).p).toEqual({s:'1970-01-01T00:00:00.000Z',i:'0'});expect(r.writableEnded).toBe(false);r.end();
});
/**
 * The one case here that legitimately does real work: 64 full pages is 64*199 =
 * 12,736 rows by construction, because the drain only continues while a page is FULL,
 * so the budget cannot be reached with fewer.
 *
 * It carries an EXPLICIT timeout rather than leaning on vitest's 5,000ms default,
 * because the default is an arbitrary number that happens to sit near this case's
 * honest cost. Measured on this machine, whole suite in parallel: 4,787ms before the
 * `cmp` fix above and 2,257ms after (778ms with this file run alone — the spread is
 * machine contention, which is precisely why a 5,000ms line is the wrong instrument).
 * The PR #102 reviewer hit the default on their hardware, on the BASE commit as well
 * as this branch.
 *
 * The global `testTimeout` is deliberately NOT raised: that would relax the implicit
 * bound on all 1,488 tests to fix one, and every other test in the repo should stay
 * fast enough that 5,000ms is a real signal. A slow machine now reports THIS case's
 * actual assertion — the page count — instead of a timeout that says nothing about it.
 *
 * Note what does NOT bound this case: the production traversal's own
 * `COMPLETE_DEADLINE_MS` (15s) cannot fire here, because `vi.useFakeTimers()` freezes
 * `Date.now()`. That mechanism is a rival explanation for "it fell back", and it has
 * its own case above which advances the clock deliberately — so the two are separable
 * rather than both satisfied at once (rule 3b-rescue).
 */
it('real page-budget refusal falls back after exactly 64 position pages',async()=>{
  if(BASE)return;const db=database(fixture(64*199));mocks.getSupabase.mockReturnValue(db);const out=await loadOwnStateSnapshot(ADDRESS,null,Date.now());
  expect(out.ok).toBe(true);if(!out.ok)throw new Error(JSON.stringify(out));expect(out.body.positions).toHaveLength(200);expect(out.body.positionsTruncated).toBe(true);
  expect(db.queries.filter(q=>q.table==='positions'&&q.limit===199)).toHaveLength(64);expect(db.queries.filter(q=>q.table==='positions'&&q.limit===200)).toHaveLength(1);
},20_000);
it('ordinary complete database failure is not disguised as a budget fallback',async()=>{
  const db=database(fixture(20),(q,r)=>q.table==='positions'?{data:null,error:{message:'review database failure'}}:r);mocks.getSupabase.mockReturnValue(db);const out=await loadOwnStateSnapshot(ADDRESS,null,Date.now());
  expect(out.ok).toBe(false);if(out.ok)throw new Error('expected failure');expect(out.status).toBe(500);expect(db.queries.filter(q=>q.table==='positions')).toHaveLength(1);
});

it('B1: complete cold start followed by ordinary cursor resume',async()=>{
  const t=fixture(300);const db=database(t);let hub=attach(db);const cold=response();getOwnStateStreamHandler(request(),cold as unknown as Response);await flush();
  const first=events(cold);const snapshot=first.find(e=>e.event==='snapshot');expect(snapshot).toBeDefined();expect(first.find(e=>e.event==='ready')).toBeDefined();
  const snap=snapshot!.data;const cursor=String(snap.cursor);expect((snap.positions as unknown[]).length).toBe(BASE?200:300);expect(snap.positionsTruncated).toBe(BASE);
  cold.end();vi.setSystemTime(NOW+60_000);const start=db.queries.length;
  const resumed=response();getOwnStateStreamHandler(request(cursor),resumed as unknown as Response);await flush();
  const wire=events(resumed);const status=wire.filter(e=>e.event==='positionStatus');const health=wire.filter(e=>e.event==='degraded'||e.event==='resync');
  // A transition in the omitted older tail changes only the parent row; the
  // position timestamp is unchanged, so discovery cannot substitute for a seed.
  t.speculations![0]!.speculation_status='closed';t.speculations![0]!.win_side='away';t.speculations![0]!.row_updated_at=new Date(NOW+61_000).toISOString();
  vi.setSystemTime(NOW+61_500);await hub.pollWallet(ADDRESS);await flush();
  const late=events(resumed).filter(e=>e.event==='positionStatus'&&e.data.speculationId==='1'&&e.data.status==='claimable');
  console.log('REVIEW_RESUME',JSON.stringify({base:BASE,coldPositions:(snap.positions as unknown[]).length,coldTruncated:snap.positionsTruncated,coldEvents:first.map(e=>e.event),resumePositions:status.length,resumeHealth:health.map(e=>({event:e.event,data:e.data})),resumeReady:wire.some(e=>e.event==='ready'),missingTailClaimable:late.length,resumeActionableReads:db.queries.slice(start).filter(q=>q.table==='positions'&&q.filters.some(f=>f[1]==='claimed'&&f[2]===false)&&q.limit===200).map(q=>({limit:q.limit,rows:q.rows})),open:!resumed.writableEnded}));
  expect(wire.some(e=>e.event==='ready')).toBe(true);expect(resumed.writableEnded).toBe(false);
  {
    expect(health,'complete recovery must not become partial solely on reconnect').toEqual([]);
    expect(late,'previously covered position must remain maintained after reconnect').toHaveLength(1);
  }
  // The branch this replaces asserted BASE behaviour, quoted so the change is legible:
  //   expect(health.map(e=>e.event)).toEqual(['degraded']);
  //   expect(status).toHaveLength(200);
  //   expect(late).toHaveLength(0);
  // i.e. a reconnect re-asserting degraded, seeding 200 of 300, and never delivering
  // the settled tail position's transition. That is the defect, not the contract.
  resumed.end();
});
