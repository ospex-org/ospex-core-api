/**
 * The connector's wording — `src/mcp/words.ts`. Pure functions, literal
 * expectations.
 *
 * The fixtures are chosen to disagree where a wrong implementation would not:
 * the spread lines are non-zero so a dropped sign shows, the two teams share no
 * word except where a case needs them to, and the instants sit on either side
 * of a daylight-saving change so a fixed offset would be caught.
 */
import { describe, expect, it } from 'vitest';
import {
  backingLabel,
  formatEastern,
  formatEasternMs,
  formatHandicap,
  formatLine,
  handicapFor,
  lineHeading,
  matchupLabel,
  oppositeSide,
  parseLine,
  positionTypeOf,
  pushSentence,
  resolveSide,
  shorten,
  sideOf,
  sidesOf,
  teamLabel,
} from '../src/mcp/words.js';

const TEAMS = { away: 'Tampa Bay Rays', home: 'Philadelphia Phillies' };

describe('sides', () => {
  it('names a position type by its market', () => {
    expect(sideOf('moneyline', 0)).toBe('away');
    expect(sideOf('moneyline', 1)).toBe('home');
    expect(sideOf('spread', 0)).toBe('away');
    expect(sideOf('spread', 1)).toBe('home');
    expect(sideOf('total', 0)).toBe('over');
    expect(sideOf('total', 1)).toBe('under');
  });

  it('gives a side its position type', () => {
    expect(positionTypeOf('away')).toBe(0);
    expect(positionTypeOf('over')).toBe(0);
    expect(positionTypeOf('home')).toBe(1);
    expect(positionTypeOf('under')).toBe(1);
  });

  it('pairs each side with the one across from it', () => {
    expect(oppositeSide('away')).toBe('home');
    expect(oppositeSide('home')).toBe('away');
    expect(oppositeSide('over')).toBe('under');
    expect(oppositeSide('under')).toBe('over');
  });

  it('lists a market\'s two sides, upper first', () => {
    expect(sidesOf('moneyline')).toEqual(['away', 'home']);
    expect(sidesOf('spread')).toEqual(['away', 'home']);
    expect(sidesOf('total')).toEqual(['over', 'under']);
  });
});

describe('lines', () => {
  it('writes ticks as a line with one decimal place', () => {
    expect(formatLine(70)).toBe('7.0');
    expect(formatLine(75)).toBe('7.5');
    expect(formatLine(-35)).toBe('-3.5');
    expect(formatLine(2205)).toBe('220.5');
    expect(formatLine(5)).toBe('0.5');
    expect(formatLine(0)).toBe('0.0');
  });

  it('writes a handicap with its sign, and never a negative zero', () => {
    expect(formatHandicap(15)).toBe('+1.5');
    expect(formatHandicap(-15)).toBe('-1.5');
    expect(formatHandicap(0)).toBe('+0.0');
    expect(formatHandicap(-0)).toBe('+0.0');
  });

  it('reads a stored spread line from each side', () => {
    // Stored lines are the away team's handicap.
    expect(handicapFor('away', -15)).toBe(-15);
    expect(handicapFor('home', -15)).toBe(15);
    expect(handicapFor('away', 30)).toBe(30);
    expect(handicapFor('home', 30)).toBe(-30);
    expect(Object.is(handicapFor('home', 0), 0)).toBe(true);
  });

  it('parses a line a caller wrote, to one decimal place and no further', () => {
    expect(parseLine(7)).toEqual({ ok: true, ticks: 70 });
    expect(parseLine(7.5)).toEqual({ ok: true, ticks: 75 });
    expect(parseLine(-1.5)).toEqual({ ok: true, ticks: -15 });
    expect(parseLine(220.5)).toEqual({ ok: true, ticks: 2205 });
    expect(parseLine(0)).toEqual({ ok: true, ticks: 0 });
    expect(parseLine(7.25)).toEqual({ ok: false });
    expect(parseLine(Number.NaN)).toEqual({ ok: false });
    expect(parseLine(Number.POSITIVE_INFINITY)).toEqual({ ok: false });
    expect(parseLine(1e21)).toEqual({ ok: false });
    expect(parseLine(1234567)).toEqual({ ok: false });
  });

  it('parses negative zero as zero', () => {
    const parsed = parseLine(-0);
    expect(parsed.ok && Object.is(parsed.ticks, 0)).toBe(true);
  });
});

describe('labels', () => {
  it('writes the matchup away team first', () => {
    expect(matchupLabel(TEAMS)).toBe('Tampa Bay Rays @ Philadelphia Phillies');
  });

  it('names the team beside its role', () => {
    expect(teamLabel('away', TEAMS)).toBe('Tampa Bay Rays (away)');
    expect(teamLabel('home', TEAMS)).toBe('Philadelphia Phillies (home)');
  });

  it('says what each side of each market backs', () => {
    expect(backingLabel('total', 'over', 70, TEAMS)).toBe('Over 7.0');
    expect(backingLabel('total', 'under', 75, TEAMS)).toBe('Under 7.5');
    expect(backingLabel('moneyline', 'away', 0, TEAMS)).toBe('Tampa Bay Rays (away) to win');
    expect(backingLabel('moneyline', 'home', 0, TEAMS)).toBe('Philadelphia Phillies (home) to win');
  });

  it('writes a spread from the side being backed', () => {
    // Stored -15: the away team gives a run and a half.
    expect(backingLabel('spread', 'away', -15, TEAMS)).toBe('Tampa Bay Rays (away) -1.5');
    expect(backingLabel('spread', 'home', -15, TEAMS)).toBe('Philadelphia Phillies (home) +1.5');
    // Stored +30: the home team gives three.
    expect(backingLabel('spread', 'away', 30, TEAMS)).toBe('Tampa Bay Rays (away) +3.0');
    expect(backingLabel('spread', 'home', 30, TEAMS)).toBe('Philadelphia Phillies (home) -3.0');
  });

  it('heads a line by its market', () => {
    expect(lineHeading('moneyline', 0)).toBe('Moneyline');
    expect(lineHeading('total', 85)).toBe('Total 8.5');
    expect(lineHeading('spread', -15)).toBe('Spread');
  });
});

describe('pushSentence', () => {
  it('a moneyline pushes on a tie', () => {
    expect(pushSentence('moneyline', 0, TEAMS)).toBe('A tie is a push.');
  });

  it('a total on a whole number pushes on exactly that number', () => {
    expect(pushSentence('total', 70, TEAMS)).toBe('Exactly 7 is a push.');
    expect(pushSentence('total', 2200, TEAMS)).toBe('Exactly 220 is a push.');
  });

  it('a total or spread on a half point cannot push', () => {
    expect(pushSentence('total', 75, TEAMS)).toBeNull();
    expect(pushSentence('spread', -15, TEAMS)).toBeNull();
    expect(pushSentence('spread', 35, TEAMS)).toBeNull();
  });

  it('a spread on a whole number pushes when the team giving points wins by exactly that many', () => {
    // Stored -20: away score - 2 == home score, so the away team won by two.
    expect(pushSentence('spread', -20, TEAMS)).toBe('Tampa Bay Rays winning by exactly 2 is a push.');
    // Stored +30: away score + 3 == home score, so the home team won by three.
    expect(pushSentence('spread', 30, TEAMS)).toBe('Philadelphia Phillies winning by exactly 3 is a push.');
    expect(pushSentence('spread', 0, TEAMS)).toBe('A tie is a push.');
  });
});

describe('resolveSide', () => {
  it('takes over and under on a total, in any case', () => {
    expect(resolveSide('under', 'total', TEAMS)).toEqual({ ok: true, side: 'under' });
    expect(resolveSide(' Over ', 'total', TEAMS)).toEqual({ ok: true, side: 'over' });
    expect(resolveSide('UNDER', 'total', TEAMS)).toEqual({ ok: true, side: 'under' });
  });

  it('takes nothing else on a total, a team name included', () => {
    expect(resolveSide('home', 'total', TEAMS)).toEqual({ ok: false, reason: 'not_a_side_of_this_market' });
    expect(resolveSide('Phillies', 'total', TEAMS)).toEqual({ ok: false, reason: 'not_a_side_of_this_market' });
    expect(resolveSide('', 'total', TEAMS)).toEqual({ ok: false, reason: 'not_a_side_of_this_market' });
  });

  it('takes away and home on a moneyline or spread', () => {
    expect(resolveSide('away', 'moneyline', TEAMS)).toEqual({ ok: true, side: 'away' });
    expect(resolveSide('Home', 'spread', TEAMS)).toEqual({ ok: true, side: 'home' });
  });

  it('refuses over and under on a moneyline or spread', () => {
    expect(resolveSide('over', 'moneyline', TEAMS)).toEqual({ ok: false, reason: 'not_a_side_of_this_market' });
    expect(resolveSide('under', 'spread', TEAMS)).toEqual({ ok: false, reason: 'not_a_side_of_this_market' });
  });

  it('finds a team by whole words of its name', () => {
    expect(resolveSide('Phillies', 'moneyline', TEAMS)).toEqual({ ok: true, side: 'home' });
    expect(resolveSide('philadelphia', 'moneyline', TEAMS)).toEqual({ ok: true, side: 'home' });
    expect(resolveSide('Philadelphia Phillies', 'spread', TEAMS)).toEqual({ ok: true, side: 'home' });
    expect(resolveSide('rays', 'moneyline', TEAMS)).toEqual({ ok: true, side: 'away' });
    expect(resolveSide('Tampa Bay', 'moneyline', TEAMS)).toEqual({ ok: true, side: 'away' });
    expect(resolveSide('the  RAYS!', 'moneyline', TEAMS)).toEqual({ ok: true, side: 'away' });
    expect(resolveSide('the under', 'total', TEAMS)).toEqual({ ok: true, side: 'under' });
  });

  it('drops a leading "the" and nothing else', () => {
    expect(resolveSide('the', 'moneyline', TEAMS)).toEqual({ ok: false, reason: 'no_team_matches' });
    expect(resolveSide('go Rays', 'moneyline', TEAMS)).toEqual({ ok: false, reason: 'no_team_matches' });
  });

  it('does not match part of a word, or words out of order', () => {
    expect(resolveSide('Phil', 'moneyline', TEAMS)).toEqual({ ok: false, reason: 'no_team_matches' });
    expect(resolveSide('Ray', 'moneyline', TEAMS)).toEqual({ ok: false, reason: 'no_team_matches' });
    expect(resolveSide('Bay Tampa', 'moneyline', TEAMS)).toEqual({ ok: false, reason: 'no_team_matches' });
    expect(resolveSide('Yankees', 'moneyline', TEAMS)).toEqual({ ok: false, reason: 'no_team_matches' });
    expect(resolveSide('', 'moneyline', TEAMS)).toEqual({ ok: false, reason: 'no_team_matches' });
  });

  it('refuses a name both teams answer to', () => {
    const sox = { away: 'Chicago White Sox', home: 'Boston Red Sox' };
    expect(resolveSide('Sox', 'moneyline', sox)).toEqual({ ok: false, reason: 'both_teams_match' });
    expect(resolveSide('Red Sox', 'moneyline', sox)).toEqual({ ok: true, side: 'home' });
    expect(resolveSide('White Sox', 'moneyline', sox)).toEqual({ ok: true, side: 'away' });
    const newYork = { away: 'New York Mets', home: 'New York Yankees' };
    expect(resolveSide('New York', 'spread', newYork)).toEqual({ ok: false, reason: 'both_teams_match' });
    expect(resolveSide('Mets', 'spread', newYork)).toEqual({ ok: true, side: 'away' });
  });

  it('matches nothing against a team with no name', () => {
    expect(resolveSide('Rays', 'moneyline', { away: '', home: '' })).toEqual({
      ok: false,
      reason: 'no_team_matches',
    });
  });

  it('a team whose name is a side word is still reached by the side word first', () => {
    // "Home" and "away" are roles before they are names.
    const odd = { away: 'Home Town Heroes', home: 'Visitors' };
    expect(resolveSide('home', 'moneyline', odd)).toEqual({ ok: true, side: 'home' });
    expect(resolveSide('Heroes', 'moneyline', odd)).toEqual({ ok: true, side: 'away' });
  });
});

describe('times', () => {
  it('writes an instant as Eastern wall-clock time', () => {
    // Daylight time: UTC-4.
    expect(formatEastern('2026-09-27T19:05:00+00:00')).toBe('Sun Sep 27, 3:05 pm ET');
    expect(formatEastern('2026-09-27T18:55:00Z')).toBe('Sun Sep 27, 2:55 pm ET');
    // Standard time: UTC-5.
    expect(formatEastern('2026-12-06T18:00:00+00:00')).toBe('Sun Dec 6, 1:00 pm ET');
  });

  it('crosses midnight and noon correctly', () => {
    expect(formatEastern('2026-09-28T02:10:00+00:00')).toBe('Sun Sep 27, 10:10 pm ET');
    expect(formatEastern('2026-09-27T04:00:00+00:00')).toBe('Sun Sep 27, 12:00 am ET');
    expect(formatEastern('2026-09-27T16:00:00+00:00')).toBe('Sun Sep 27, 12:00 pm ET');
  });

  it('reads an offset other than zero as the instant it names', () => {
    expect(formatEastern('2026-09-27T15:05:00-04:00')).toBe('Sun Sep 27, 3:05 pm ET');
  });

  it('keeps the minute when the timestamp carries microseconds', () => {
    expect(formatEastern('2026-09-27T19:05:59.999999+00:00')).toBe('Sun Sep 27, 3:05 pm ET');
  });

  it('answers null for a timestamp it cannot read', () => {
    expect(formatEastern('')).toBeNull();
    expect(formatEastern('not a time')).toBeNull();
    expect(formatEastern('2026-02-30T00:00:00Z')).toBeNull();
    expect(formatEastern('2026-09-27T19:05:00')).toBeNull();
  });

  it('formats a clock reading in milliseconds', () => {
    expect(formatEasternMs(Date.UTC(2026, 8, 27, 12, 0, 0))).toBe('Sun Sep 27, 8:00 am ET');
    expect(formatEasternMs(Number.NaN)).toBeNull();
  });
});

describe('shorten', () => {
  it('keeps both ends of a long value and all of a short one', () => {
    expect(shorten('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
    expect(shorten('0x1234')).toBe('0x1234');
  });
});
