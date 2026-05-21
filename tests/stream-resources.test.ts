import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { STREAM_RESOURCES, isStreamResource, matchesRow, type StreamRow } from '../src/v1/stream/resources.js';

function req(query: Record<string, string>): Request {
  return { query } as unknown as Request;
}

describe('isStreamResource', () => {
  it('accepts the five stream resources and rejects others', () => {
    for (const r of ['commitments', 'positions', 'fills', 'speculations', 'contests']) {
      expect(isStreamResource(r)).toBe(true);
    }
    expect(isStreamResource('teams')).toBe(false);
    expect(isStreamResource('')).toBe(false);
  });
});

describe('parseFilters', () => {
  it('commitments: maps + lowercases identity filters', () => {
    const f = STREAM_RESOURCES.commitments.parseFilters(
      req({ maker: '0xAbC1111111111111111111111111111111111111', contestId: '7' }),
    );
    expect(f).toEqual({ maker: '0xabc1111111111111111111111111111111111111', contest_id: '7' });
  });

  it('commitments: rejects a bad maker address', () => {
    const f = STREAM_RESOURCES.commitments.parseFilters(req({ maker: 'nope' }));
    expect(f).toMatchObject({ errorBody: { code: 'INVALID_PARAM' } });
  });

  it('commitments: rejects a negative contestId', () => {
    const f = STREAM_RESOURCES.commitments.parseFilters(req({ contestId: '-1' }));
    expect(f).toMatchObject({ errorBody: { code: 'INVALID_PARAM' } });
  });

  it('fills: maps maker/taker/speculationId/contestId/commitmentHash to columns', () => {
    const f = STREAM_RESOURCES.fills.parseFilters(
      req({
        maker: '0x1111111111111111111111111111111111111111',
        taker: '0x2222222222222222222222222222222222222222',
        speculationId: '5',
        contestId: '1',
        commitmentHash: `0x${'A'.repeat(64)}`,
      }),
    );
    expect(f).toEqual({
      maker_address: '0x1111111111111111111111111111111111111111',
      taker_address: '0x2222222222222222222222222222222222222222',
      speculation_id: '5',
      contest_id: '1',
      commitment_hash: `0x${'a'.repeat(64)}`,
    });
  });

  it('fills: rejects a malformed commitmentHash', () => {
    const f = STREAM_RESOURCES.fills.parseFilters(req({ commitmentHash: '0x123' }));
    expect(f).toMatchObject({ errorBody: { code: 'INVALID_PARAM' } });
  });

  it('empty query → empty filter map', () => {
    expect(STREAM_RESOURCES.positions.parseFilters(req({}))).toEqual({});
  });
});

describe('matchesRow', () => {
  const row = { maker_address: '0xaaa', contest_id: 7, id: 1, row_updated_at: 't' } as unknown as StreamRow;

  it('matches when every filtered column equals (string-compared)', () => {
    expect(matchesRow({ maker_address: '0xaaa', contest_id: '7' }, row)).toBe(true);
  });
  it('does not match on a differing column', () => {
    expect(matchesRow({ maker_address: '0xbbb' }, row)).toBe(false);
  });
  it('empty filter matches everything', () => {
    expect(matchesRow({}, row)).toBe(true);
  });
});

describe('toBody', () => {
  it('commitments: reuses the effective-status mapper (filled stays filled, storedStatus present)', () => {
    const body = STREAM_RESOURCES.commitments.toBody({
      commitment_hash: `0x${'a'.repeat(64)}`,
      maker: '0x1111111111111111111111111111111111111111',
      contest_id: 1,
      scorer: '0x2222222222222222222222222222222222222222',
      line_ticks: 0,
      position_type: 'upper',
      odds_tick: 200,
      market_type: 'moneyline',
      risk_amount: '1000000',
      filled_risk_amount: '1000000',
      nonce: '1',
      expiry: '2026-05-21T00:00:00.000Z',
      speculation_key: '0xspec',
      signature: '0xsig',
      status: 'filled',
      source: 'agent',
      network: 'polygon',
      nonce_invalidated: false,
      created_at: '2026-05-20T10:00:00.000Z',
      id: 1,
      row_updated_at: 't',
    } as unknown as StreamRow) as { status: string; storedStatus: string } | null;
    expect(body).toMatchObject({ status: 'filled', storedStatus: 'filled' });
  });

  it('speculations: returns null for an unenriched (null market_type) row', () => {
    const body = STREAM_RESOURCES.speculations.toBody({
      speculation_id: 1,
      contest_id: 1,
      market_type: null,
      line_ticks: 0,
      speculation_status: 'open',
      id: 1,
      row_updated_at: 't',
    } as unknown as StreamRow);
    expect(body).toBeNull();
  });
});
