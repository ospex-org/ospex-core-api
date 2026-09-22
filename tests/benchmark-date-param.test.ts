/**
 * `parseSlateDate` — the shared `date` / `slateDate` validator.
 *
 * Every benchmark endpoint that takes a date routes through this, so the matrix
 * below is the whole calendar contract for the surface.
 *
 * ## Why the fixtures are what they are
 *
 * A date validator is the textbook case for `3g-both` in
 * `.claude/rules/verification-discipline.md`: an EXTREME input fails every
 * candidate rule, which is exactly what makes it useless for telling them apart.
 * `2026-99-99` proves nothing. So each case below sits where two plausible
 * implementations DISAGREE, and the comment says which one it kills.
 *
 * The two century cases are worth a word, because they look like the year-1900
 * over-reach `claim-calibration.md` warns about and they are not the same thing.
 * Nothing here CLAIMS anything about serving 1900 data — no such slate exists and
 * none ever will. They are in the matrix because they are the only inputs that
 * separate a correct Gregorian rule from the two wrong ones people actually
 * write, and each costs one line. Testing a rule with its discriminating inputs
 * is not the same as promising a domain.
 */
import { describe, expect, it } from 'vitest';
import { parseSlateDate } from '../src/v1/benchmark/window.js';

describe('parseSlateDate — absence', () => {
  it('reports an absent param as undefined, distinct from invalid', () => {
    // A handler branches three ways on this, so `undefined` and `'invalid'` must
    // not be merged: absent means "no date filter", invalid means "400".
    expect(parseSlateDate(undefined)).toBeUndefined();
    expect(parseSlateDate('')).toBe('invalid');
  });
});

describe('parseSlateDate — accepts a real calendar date', () => {
  it.each([
    ['an ordinary date, the control every refusal below needs', '2026-08-27'],
    ['the last day of a 31-day month', '2026-12-31'],
    ['the last day of a 30-day month', '2026-04-30'],
    ['the first day of a month', '2026-03-01'],
    ['a leap day in a year divisible by 4', '2024-02-29'],
    ['Feb 28 in a NON-leap year', '2026-02-28'],
    // Kills "no century is a leap year", which is the first over-correction
    // someone writes after learning centuries are special.
    ['a leap day in a year divisible by 400', '2000-02-29'],
    // Kills a year floor set higher than 1. The floor is "Postgres has no year
    // zero", not "no date before some plausible epoch".
    ['year 1, because the floor is year zero and nothing else', '0001-01-01'],
  ])('accepts %s', (_why, value) => {
    expect(parseSlateDate(value)).toBe(value);
  });

  it('trims surrounding whitespace rather than refusing it', () => {
    expect(parseSlateDate('  2026-08-27  ')).toBe('2026-08-27');
  });
});

describe('parseSlateDate — refuses an impossible date', () => {
  it.each([
    // THE case this function was written for. Shape-valid, so the old regex passed
    // it; `new Date('2026-02-30T00:00:00Z')` does not refuse it either, it SHIFTS
    // it to 2026-03-02 — so an isNaN-based check accepts it too.
    ['February 30th', '2026-02-30'],
    // Kills a naive "divisible by 4" leap rule.
    ['February 29th in a year not divisible by 4', '2026-02-29'],
    // Kills "divisible by 4 and not by 100" WITHOUT the 400 exception... no:
    // this one kills the plain "divisible by 4" rule at a century boundary.
    ['February 29th in a century not divisible by 400', '1900-02-29'],
    // Kills a flat 31-day month table.
    ['the 31st of a 30-day month', '2026-04-31'],
    ['the 31st of September', '2026-09-31'],
    ['month 13', '2026-13-01'],
    ['month 00', '2026-00-10'],
    ['day 00', '2026-01-00'],
    ['day 32', '2026-01-32'],
    // Postgres's `date` has no year zero, so this is not a date it can store.
    ['year 0000', '0000-01-01'],
    ['year 0000 on a leap-shaped day', '0000-02-29'],
  ])('refuses %s', (_why, value) => {
    expect(parseSlateDate(value)).toBe('invalid');
  });
});

describe('parseSlateDate — refuses a wrong shape', () => {
  it.each([
    ['day-first', '27-08-2026'],
    ['an unpadded month', '2026-8-27'],
    ['an unpadded day', '2026-08-7'],
    ['a full timestamp', '2026-08-27T00:00:00Z'],
    ['no separators', '20260827'],
    ['slashes', '2026/08/27'],
    ['a trailing character', '2026-08-27x'],
    ['a leading sign', '+2026-08-27'],
    ['a five-digit year', '02026-08-27'],
    ['a PostgREST operator smuggled in', 'gte.2026-08-27'],
    ['prose', 'yesterday'],
  ])('refuses %s', (_why, value) => {
    expect(parseSlateDate(value)).toBe('invalid');
  });
});

/**
 * The property that makes the whole matrix meaningful: for every date the parser
 * accepts, the round trip through `Date` must land on the SAME day.
 *
 * This is the independent witness. The matrix above checks the cases I thought
 * of; this sweeps every day of several representative years — including both
 * kinds of century — and fails if the month table or the leap rule disagrees
 * with the platform's own calendar anywhere in them. It is derived from `Date`
 * rather than from the parser's own internals, so it cannot agree with a broken
 * month table by construction (`3d-witness`).
 */
describe('parseSlateDate — differential against the platform calendar', () => {
  it.each([[2024], [2025], [2026], [1900], [2000]])(
    'agrees with Date on every day of %i, and on every day it rejects',
    (year) => {
      let accepted = 0;
      let rejected = 0;
      for (let month = 1; month <= 12; month++) {
        for (let day = 1; day <= 31; day++) {
          const value = `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const parsed = parseSlateDate(value);
          // `Date` shifts an impossible day instead of refusing it, so the
          // question asked of it is "did it land where I asked", never "is it NaN".
          const utc = new Date(`${value}T00:00:00Z`);
          const real = !Number.isNaN(utc.getTime()) && utc.toISOString().slice(0, 10) === value;
          if (real) {
            expect(parsed).toBe(value);
            accepted++;
          } else {
            expect(parsed).toBe('invalid');
            rejected++;
          }
        }
      }
      // Both branches must be non-trivially exercised, or the loop could pass by
      // never reaching one of them.
      expect(accepted).toBe(year === 2024 || year === 2000 ? 366 : 365);
      expect(rejected).toBe(372 - accepted);
    },
  );
});
