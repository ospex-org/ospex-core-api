/**
 * `/readyz` dependency probe.
 *
 * The property under test: when the `contests_effective` view is absent, the
 * probe must report NOT ready. Before this, the probe hit the base `contests`
 * table and explicitly classified a PostgREST relation-not-found as
 * "connected" — so deploying ahead of the indexer migration produced a dyno
 * that booted, answered `/readyz` with 200, and 500'd every contest query.
 *
 * Paired negative control throughout: a healthy probe must still report ready,
 * otherwise these assertions would pass against a probe broken to fail always.
 */
import { describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ getSupabase: vi.fn() }));
vi.mock('../src/lib/supabase.js', () => supabaseMock);

const { checkDependencies, isReady, CONTESTS_VIEW } = await import('../src/lib/readiness.js');

interface ProbeError {
  code: string;
  message: string;
}

/** Records the table the probe selected from and returns a canned error. */
function makeSupabase(error: ProbeError | null): { client: unknown; tables: string[] } {
  const tables: string[] = [];
  const client = {
    from(table: string): unknown {
      tables.push(table);
      const builder: Record<string, unknown> = {};
      builder['select'] = (): unknown => builder;
      builder['limit'] = (): Promise<{ error: ProbeError | null }> => Promise.resolve({ error });
      return builder;
    },
  };
  return { client, tables };
}

describe('checkDependencies — the readiness probe targets the contests view', () => {
  it('probes contests_effective, not the base contests table', async () => {
    const { client, tables } = makeSupabase(null);
    supabaseMock.getSupabase.mockReturnValue(client);
    await checkDependencies();
    expect(tables).toEqual([CONTESTS_VIEW]);
    expect(tables).not.toContain('contests');
  });

  it('NEGATIVE CONTROL: a healthy probe reports connected AND view present', async () => {
    const { client } = makeSupabase(null);
    supabaseMock.getSupabase.mockReturnValue(client);
    const r = await checkDependencies();
    expect(r.supabase.connected).toBe(true);
    expect(r.contestsView.present).toBe(true);
  });

  // PostgREST schema-cache miss and the raw Postgres undefined_table code.
  for (const code of ['PGRST205', '42P01']) {
    it(`a missing view (${code}) reports connected=true but present=FALSE`, async () => {
      const { client } = makeSupabase({ code, message: 'relation does not exist' });
      supabaseMock.getSupabase.mockReturnValue(client);
      const r = await checkDependencies();
      // The round trip happened, so the transport is genuinely fine…
      expect(r.supabase.connected).toBe(true);
      // …but readiness must still fail, on this term.
      expect(r.contestsView.present).toBe(false);
      expect(r.contestsView.error).toContain(CONTESTS_VIEW);
    });
  }

  it('any other PostgREST error reports NOT connected', async () => {
    const { client } = makeSupabase({ code: 'PGRST301', message: 'JWT expired' });
    supabaseMock.getSupabase.mockReturnValue(client);
    const r = await checkDependencies();
    expect(r.supabase.connected).toBe(false);
    expect(r.contestsView.present).toBe(false);
    expect(r.supabase.error).toBe('JWT expired');
  });

  it('a thrown transport failure reports NOT connected', async () => {
    supabaseMock.getSupabase.mockImplementation(() => {
      throw new Error('ECONNREFUSED');
    });
    const r = await checkDependencies();
    expect(r.supabase.connected).toBe(false);
    expect(r.contestsView.present).toBe(false);
    expect(r.supabase.error).toContain('ECONNREFUSED');
  });
});

describe('isReady — the /readyz verdict requires all three terms', () => {
  // `isReady` is the exact expression `/readyz` composes (server.ts calls
  // main() at module scope and starts a listener, so it cannot be imported;
  // the verdict lives in lib/readiness.ts precisely so it can be tested).
  const deps = (connected: boolean, present: boolean): Parameters<typeof isReady>[0] => ({
    supabase: { connected },
    contestsView: { present },
  });

  it('all three true → ready', () => {
    expect(isReady(deps(true, true), { configured: true })).toBe(true);
  });
  it('view missing → NOT ready even when everything else is fine', () => {
    expect(isReady(deps(true, false), { configured: true })).toBe(false);
  });
  it('supabase down → NOT ready', () => {
    expect(isReady(deps(false, true), { configured: true })).toBe(false);
  });
  it('commitments unconfigured → NOT ready', () => {
    expect(isReady(deps(true, true), { configured: false })).toBe(false);
  });
});

describe('end to end: a missing view makes the composed verdict NOT ready', () => {
  it('probe reports the view absent → isReady is false', async () => {
    const { client } = makeSupabase({ code: 'PGRST205', message: 'relation does not exist' });
    supabaseMock.getSupabase.mockReturnValue(client);
    const r = await checkDependencies();
    expect(isReady(r, { configured: true })).toBe(false);
  });

  it('NEGATIVE CONTROL: a healthy probe → isReady is true', async () => {
    const { client } = makeSupabase(null);
    supabaseMock.getSupabase.mockReturnValue(client);
    const r = await checkDependencies();
    expect(isReady(r, { configured: true })).toBe(true);
  });
});
