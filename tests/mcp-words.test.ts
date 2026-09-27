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
  cleanName,
  formatEastern,
  formatEasternMs,
  formatHandicap,
  formatLine,
  handicapFor,
  lineHeading,
  matchupLabel,
  parseLine,
  pushSentence,
  resolveSide,
  sideOf,
  sidesOf,
  teamLabel,
  teamsOf,
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

  it('reads a line of six whole digits, the most it takes', () => {
    // Nearest acceptance to the seven-digit refusal above.
    expect(parseLine(999999.5)).toEqual({ ok: true, ticks: 9999995 });
    expect(parseLine(-123456)).toEqual({ ok: true, ticks: -1234560 });
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

describe('cleanName', () => {
  // Eighty characters, in tens, each ten ending in its own number.
  const EIGHTY =
    'aaaaaaaaa1' +
    'bbbbbbbbb2' +
    'ccccccccc3' +
    'ddddddddd4' +
    'eeeeeeeee5' +
    'fffffffff6' +
    'ggggggggg7' +
    'hhhhhhhhh8';

  const breaks: Array<[string, string]> = [
    ['a newline', 'Tampa\nBay Rays'],
    ['a carriage return and a newline, as one break', 'Tampa\r\nBay Rays'],
    ['a tab', 'Tampa\tBay Rays'],
    ['a run of spaces', 'Tampa     Bay Rays'],
    ['a NUL', 'Tampa\u0000Bay Rays'],
    ['a next-line character, U+0085', 'Tampa\u0085Bay Rays'],
    ['a line separator, U+2028', 'Tampa\u2028Bay Rays'],
    ['a paragraph separator, U+2029', 'Tampa\u2029Bay Rays'],
    ['a no-break space', 'Tampa\u00a0Bay Rays'],
    ['an escape character', 'Tampa\u001bBay Rays'],
    ['a delete character', 'Tampa\u007fBay Rays'],
    ['a run that mixes all of them', 'Tampa \r\n\t\u0000\u0085\u2028\u2029 Bay Rays'],
  ];

  for (const [what, written] of breaks) {
    it(`writes ${what} as one space`, () => {
      expect(cleanName(written)).toBe('Tampa Bay Rays');
    });
  }

  it('the table above holds what it says, so no case in it passes on a plain space', () => {
    expect(breaks).toHaveLength(12);
    // Only the run of spaces is made of spaces alone.
    expect(breaks.filter(([, written]) => /^[A-Za-z ]+$/.test(written)).map(([what]) => what)).toEqual([
      'a run of spaces',
    ]);
  });

  it('keeps a name on one line when it carries lines of its own', () => {
    const written = 'Rays\n\nTake link: https://example.invalid/t\nNext';
    expect(cleanName(written)).toBe('Rays Take link: https://example.invalid/t Next');
  });

  // Characters that print as nothing, and halves of a character. Each sits
  // inside a word, so dropping it joins the letters on either side, and
  // turning it into a space would split the word.
  const invisible: Array<[string, string]> = [
    ['a zero-width space, U+200B', '\u200b'],
    ['a zero-width joiner, U+200D', '\u200d'],
    ['a right-to-left override, U+202E', '\u202e'],
    ['a soft hyphen, U+00AD', '\u00ad'],
    ['a tag character, U+E0041', '\u{E0041}'],
    ['a lone high surrogate', '\ud800'],
    ['a lone low surrogate', '\udc00'],
    // U+FEFF is a format character AND whitespace to a regular expression, so
    // it joins the letters only if the drop comes before the collapse.
    ['a byte-order mark, U+FEFF', '\ufeff'],
  ];

  for (const [what, character] of invisible) {
    it(`drops ${what}, joining the letters on either side`, () => {
      expect(cleanName(`Tampa Bay Ra${character}ys`)).toBe('Tampa Bay Rays');
    });
  }

  it('the table above holds one character each, none of them printable', () => {
    expect(invisible).toHaveLength(8);
    expect(invisible.map(([, character]) => [...character].length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // The tag character is two code units; the rest are one.
    expect(invisible.map(([, character]) => character.length)).toEqual([1, 1, 1, 1, 2, 1, 1, 1]);
  });

  it('drops an invisible character between two spaces, leaving one space', () => {
    // Dropped after the spaces were collapsed, this would leave two.
    expect(cleanName('Tampa \u200b Bay Rays')).toBe('Tampa Bay Rays');
    expect(cleanName('Tampa \u202e\u200d Bay Rays')).toBe('Tampa Bay Rays');
  });

  it('keeps a combining accent, which prints on the letter before it', () => {
    expect(cleanName('Montre\u0301al Canadiens')).toBe('Montre\u0301al Canadiens');
  });

  it('cuts on characters, so an emoji at the edge is kept or dropped whole', () => {
    // 79 letters, an emoji, then more: the emoji is the 80th character and
    // two code units, the 80th and 81st.
    const seventyNine = EIGHTY.slice(0, 79);
    const kept = cleanName(`${seventyNine}\u{1F600}XYZ`);
    expect(kept).toBe(`${seventyNine}\u{1F600}`);
    expect([...kept]).toHaveLength(80);
    expect(kept).toHaveLength(81);
    // 80 letters, then the emoji as the 81st character: dropped whole.
    expect(cleanName(`${EIGHTY}\u{1F600}`)).toBe(EIGHTY);
    // Nothing that is left is half a character.
    expect(/[\ud800-\udfff]/u.test(kept.replace(/\u{1F600}/gu, ''))).toBe(false);
  });

  it('counts an emoji as one character towards the 80', () => {
    // Ten emoji and 70 letters are 80 characters and 90 code units.
    const written = `${'\u{1F600}'.repeat(10)}${EIGHTY.slice(0, 70)}`;
    expect(written).toHaveLength(90);
    expect(cleanName(`${written}XYZ`)).toBe(written);
  });

  it('does not leave a space where the cut lands on one', () => {
    const seventyNine = EIGHTY.slice(0, 79);
    // The 80th character is a space.
    expect(cleanName(`${seventyNine} more`)).toBe(seventyNine);
    // Nearest acceptance: with a letter there, the cut keeps it.
    expect(cleanName(`${seventyNine}Z more`)).toBe(`${seventyNine}Z`);
  });

  it('answers an empty name for one made only of invisible characters', () => {
    expect(cleanName('\u200b\u200d\u202e\u00ad')).toBe('');
    expect(cleanName(' \u200b \u{E0041} ')).toBe('');
  });

  it('trims both ends', () => {
    expect(cleanName('  Tampa Bay Rays  ')).toBe('Tampa Bay Rays');
    expect(cleanName('\n\tTampa Bay Rays\r\n')).toBe('Tampa Bay Rays');
    expect(cleanName('\u0000Tampa Bay Rays\u0000')).toBe('Tampa Bay Rays');
  });

  it('keeps a name of exactly 80 characters and cuts one of 81', () => {
    expect(EIGHTY).toHaveLength(80);
    expect(cleanName(EIGHTY)).toBe(EIGHTY);
    expect(cleanName(`${EIGHTY}X`)).toBe(EIGHTY);
    expect(cleanName(EIGHTY.slice(0, 79))).toBe(
      'aaaaaaaaa1bbbbbbbbb2ccccccccc3ddddddddd4eeeeeeeee5fffffffff6ggggggggg7hhhhhhhhh',
    );
  });

  it('counts the 80 characters after trimming, so space in front costs the name nothing', () => {
    // Cut first and trimmed second, this would lose the last three characters.
    expect(cleanName(`   ${EIGHTY}`)).toBe(EIGHTY);
  });

  it('counts a collapsed run as the one space it becomes', () => {
    // 'ab', five spaces, then 77 more: 80 once the run is one space.
    const written = `ab     ${EIGHTY.slice(3)}`;
    expect(written).toHaveLength(84);
    expect(cleanName(written)).toBe(
      'ab aaaaaa1bbbbbbbbb2ccccccccc3ddddddddd4eeeeeeeee5fffffffff6ggggggggg7hhhhhhhhh8',
    );
  });

  it('answers an empty name for an empty name and for one that is only whitespace', () => {
    expect(cleanName('')).toBe('');
    expect(cleanName(' ')).toBe('');
    expect(cleanName(' \r\n\t\u0000\u2028 ')).toBe('');
  });

  it('leaves an ordinary name as it is written', () => {
    for (const name of [
      'Tampa Bay Rays',
      "Hawai'i Rainbow Warriors",
      "St. John's Red Storm",
      'Montréal Canadiens',
      'Philadelphia 76ers',
      'Texas A&M-Corpus Christi',
    ]) {
      expect(cleanName(name)).toBe(name);
    }
  });
});

describe('teamsOf', () => {
  it('names each team from its own column, cleaned', () => {
    expect(teamsOf({ awayTeam: ' Tampa\nBay  Rays ', homeTeam: 'Philadelphia\tPhillies\u0000' })).toEqual({
      away: 'Tampa Bay Rays',
      home: 'Philadelphia Phillies',
    });
  });

  it('leaves two ordinary names as they are', () => {
    expect(teamsOf({ awayTeam: 'Tampa Bay Rays', homeTeam: 'Philadelphia Phillies' })).toEqual({
      away: 'Tampa Bay Rays',
      home: 'Philadelphia Phillies',
    });
  });

  it('cuts each name to 80 characters by itself', () => {
    const teams = teamsOf({ awayTeam: 'a'.repeat(81), homeTeam: 'h'.repeat(79) });
    expect(teams.away).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(teams.away).toHaveLength(80);
    expect(teams.home).toBe(
      'hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh',
    );
    expect(teams.home).toHaveLength(79);
  });

  const blank: Array<[string, string]> = [
    ['empty', ''],
    ['only spaces', '   '],
    ['only line breaks and controls', '\r\n\t\u0000'],
    ['only invisible characters', '​‮\u{E0041}'],
  ];

  for (const [what, name] of blank) {
    it(`names a team by its role when its name is ${what}`, () => {
      expect(teamsOf({ awayTeam: name, homeTeam: 'Philadelphia Phillies' })).toEqual({
        away: 'Away team',
        home: 'Philadelphia Phillies',
      });
      expect(teamsOf({ awayTeam: 'Tampa Bay Rays', homeTeam: name })).toEqual({
        away: 'Tampa Bay Rays',
        home: 'Home team',
      });
      expect(teamsOf({ awayTeam: name, homeTeam: name })).toEqual({ away: 'Away team', home: 'Home team' });
    });
  }

  it('keeps a name of one character, which is not empty', () => {
    expect(teamsOf({ awayTeam: 'A', homeTeam: ' B ' })).toEqual({ away: 'A', home: 'B' });
  });
});

describe('pushSentence', () => {
  // A second pair of teams, so a name in a sentence is shown to come from the
  // teams passed in.
  const OTHERS = { away: 'Boston Red Sox', home: 'Chicago Cubs' };

  it('a moneyline pushes on a tie', () => {
    expect(pushSentence('moneyline', 0, TEAMS)).toBe('A tie is a push: the stake is returned.');
    expect(pushSentence('moneyline', 0, OTHERS)).toBe('A tie is a push: the stake is returned.');
  });

  it('a moneyline has no line, and whatever is passed as one is not read', () => {
    // 15 would answer null if it were read as a half point, and 20 would name
    // a team winning by two.
    expect(pushSentence('moneyline', 15, TEAMS)).toBe('A tie is a push: the stake is returned.');
    expect(pushSentence('moneyline', 20, TEAMS)).toBe('A tie is a push: the stake is returned.');
    expect(pushSentence('moneyline', -20, TEAMS)).toBe('A tie is a push: the stake is returned.');
  });

  it('a total on a whole number pushes on a combined score of exactly that number', () => {
    expect(pushSentence('total', 70, TEAMS)).toBe(
      'A combined score of exactly 7 is a push: the stake is returned.',
    );
    expect(pushSentence('total', 80, TEAMS)).toBe(
      'A combined score of exactly 8 is a push: the stake is returned.',
    );
    expect(pushSentence('total', 100, TEAMS)).toBe(
      'A combined score of exactly 10 is a push: the stake is returned.',
    );
    expect(pushSentence('total', 2200, TEAMS)).toBe(
      'A combined score of exactly 220 is a push: the stake is returned.',
    );
  });

  it('a total names no team', () => {
    expect(pushSentence('total', 70, OTHERS)).toBe(
      'A combined score of exactly 7 is a push: the stake is returned.',
    );
  });

  it('a total is read by its size, as its heading and its backing are', () => {
    expect(lineHeading('total', -70)).toBe('Total 7.0');
    expect(backingLabel('total', 'under', -70, TEAMS)).toBe('Under 7.0');
    expect(backingLabel('total', 'over', -75, TEAMS)).toBe('Over 7.5');
    expect(pushSentence('total', -70, TEAMS)).toBe(
      'A combined score of exactly 7 is a push: the stake is returned.',
    );
  });

  it('a total on a half point cannot push', () => {
    expect(pushSentence('total', 75, TEAMS)).toBeNull();
    expect(pushSentence('total', 85, TEAMS)).toBeNull();
    expect(pushSentence('total', 5, TEAMS)).toBeNull();
    expect(pushSentence('total', 2205, TEAMS)).toBeNull();
  });

  it('a spread on a half point cannot push, whichever team gives the points', () => {
    expect(pushSentence('spread', -15, TEAMS)).toBeNull();
    expect(pushSentence('spread', 15, TEAMS)).toBeNull();
    expect(pushSentence('spread', -5, TEAMS)).toBeNull();
    expect(pushSentence('spread', 5, TEAMS)).toBeNull();
    expect(pushSentence('spread', 35, TEAMS)).toBeNull();
    expect(pushSentence('spread', -105, TEAMS)).toBeNull();
  });

  it('a negative whole spread pushes when the AWAY team wins by exactly that many', () => {
    // The stored line is added to the away score. Stored -20: away - 2 equals
    // home, so the away team gave two and won by two.
    expect(backingLabel('spread', 'away', -20, TEAMS)).toBe('Tampa Bay Rays (away) -2.0');
    expect(pushSentence('spread', -20, TEAMS)).toBe(
      'Tampa Bay Rays winning by exactly 2 is a push: the stake is returned.',
    );
    expect(pushSentence('spread', -10, TEAMS)).toBe(
      'Tampa Bay Rays winning by exactly 1 is a push: the stake is returned.',
    );
    expect(pushSentence('spread', -100, TEAMS)).toBe(
      'Tampa Bay Rays winning by exactly 10 is a push: the stake is returned.',
    );
    expect(pushSentence('spread', -20, OTHERS)).toBe(
      'Boston Red Sox winning by exactly 2 is a push: the stake is returned.',
    );
  });

  it('a positive whole spread pushes when the HOME team wins by exactly that many', () => {
    // Stored +30: away + 3 equals home, so the home team gave three and won by three.
    expect(backingLabel('spread', 'home', 30, TEAMS)).toBe('Philadelphia Phillies (home) -3.0');
    expect(pushSentence('spread', 30, TEAMS)).toBe(
      'Philadelphia Phillies winning by exactly 3 is a push: the stake is returned.',
    );
    expect(pushSentence('spread', 10, TEAMS)).toBe(
      'Philadelphia Phillies winning by exactly 1 is a push: the stake is returned.',
    );
    expect(pushSentence('spread', 100, TEAMS)).toBe(
      'Philadelphia Phillies winning by exactly 10 is a push: the stake is returned.',
    );
    expect(pushSentence('spread', 30, OTHERS)).toBe(
      'Chicago Cubs winning by exactly 3 is a push: the stake is returned.',
    );
  });

  it('a spread of zero pushes on a tie and names nobody', () => {
    expect(pushSentence('spread', 0, TEAMS)).toBe('A tie is a push: the stake is returned.');
    expect(pushSentence('spread', -0, TEAMS)).toBe('A tie is a push: the stake is returned.');
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

  it('drops "the" only when a name follows it, so "the" alone is looked up as a word', () => {
    const article = { away: 'The Citadel Bulldogs', home: 'Furman Paladins' };
    expect(resolveSide('the', 'moneyline', article)).toEqual({ ok: true, side: 'away' });
    expect(resolveSide('the Paladins', 'moneyline', article)).toEqual({ ok: true, side: 'home' });
    expect(resolveSide('the Citadel', 'moneyline', article)).toEqual({ ok: true, side: 'away' });
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

describe('times with seconds', () => {
  it('writes the seconds, two digits of them, when asked', () => {
    expect(formatEasternMs(Date.UTC(2026, 8, 27, 12, 0, 0), true)).toBe('Sun Sep 27, 8:00:00 am ET');
    expect(formatEasternMs(Date.UTC(2026, 8, 27, 19, 5, 9), true)).toBe('Sun Sep 27, 3:05:09 pm ET');
    expect(formatEastern('2026-09-27T12:00:00Z', true)).toBe('Sun Sep 27, 8:00:00 am ET');
    expect(formatEastern('2026-09-27T19:05:09+00:00', true)).toBe('Sun Sep 27, 3:05:09 pm ET');
    expect(formatEastern('2026-09-27T19:05:41+00:00', true)).toBe('Sun Sep 27, 3:05:41 pm ET');
  });

  it('writes the same instants to the minute when seconds are left out or false', () => {
    // Nearest to the case above: the same instants, and no seconds in the text.
    expect(formatEasternMs(Date.UTC(2026, 8, 27, 19, 5, 9))).toBe('Sun Sep 27, 3:05 pm ET');
    expect(formatEasternMs(Date.UTC(2026, 8, 27, 19, 5, 9), false)).toBe('Sun Sep 27, 3:05 pm ET');
    expect(formatEastern('2026-09-27T19:05:09+00:00')).toBe('Sun Sep 27, 3:05 pm ET');
    expect(formatEastern('2026-09-27T19:05:09+00:00', false)).toBe('Sun Sep 27, 3:05 pm ET');
    expect(formatEastern('2026-09-27T12:00:00Z')).toBe('Sun Sep 27, 8:00 am ET');
  });

  it('writes midnight and noon with seconds', () => {
    expect(formatEastern('2026-09-27T04:00:00+00:00', true)).toBe('Sun Sep 27, 12:00:00 am ET');
    expect(formatEastern('2026-09-27T04:00:07+00:00', true)).toBe('Sun Sep 27, 12:00:07 am ET');
    expect(formatEastern('2026-09-27T16:00:00+00:00', true)).toBe('Sun Sep 27, 12:00:00 pm ET');
    expect(formatEastern('2026-09-27T16:00:30+00:00', true)).toBe('Sun Sep 27, 12:00:30 pm ET');
  });

  it('crosses the autumn change: one second on, the clock reads an hour earlier', () => {
    // Daylight time ends at 2:00 am Eastern on Sunday 1 November 2026, when the
    // clock goes back to 1:00 am. 05:59:59 UTC is 1:59:59 am daylight time, and
    // 06:00:00 UTC is 1:00:00 am standard time.
    expect(formatEastern('2026-11-01T05:59:59+00:00', true)).toBe('Sun Nov 1, 1:59:59 am ET');
    expect(formatEastern('2026-11-01T06:00:00+00:00', true)).toBe('Sun Nov 1, 1:00:00 am ET');
    expect(formatEastern('2026-11-01T07:00:01+00:00', true)).toBe('Sun Nov 1, 2:00:01 am ET');
    // The day before the change is still four hours behind.
    expect(formatEasternMs(Date.UTC(2026, 9, 31, 5, 59, 59), true)).toBe('Sat Oct 31, 1:59:59 am ET');
  });

  it('keeps the second a timestamp with microseconds falls in, never the next one', () => {
    expect(formatEastern('2026-09-27T12:00:59.999999Z', true)).toBe('Sun Sep 27, 8:00:59 am ET');
    expect(formatEastern('2026-09-27T12:00:59.9995+00:00', true)).toBe('Sun Sep 27, 8:00:59 am ET');
    expect(formatEastern('2026-09-27T12:59:59.999999+00:00', true)).toBe('Sun Sep 27, 8:59:59 am ET');
    expect(formatEasternMs(Date.UTC(2026, 8, 27, 12, 0, 59, 999), true)).toBe('Sun Sep 27, 8:00:59 am ET');
    // Nearest acceptance: one microsecond later is the next second.
    expect(formatEastern('2026-09-27T12:01:00Z', true)).toBe('Sun Sep 27, 8:01:00 am ET');
  });

  it('answers null for a timestamp it cannot read, with seconds or without', () => {
    for (const unreadable of ['', 'not a time', '2026-02-30T00:00:00Z', '2026-09-27T19:05:00']) {
      expect(formatEastern(unreadable, true)).toBeNull();
      expect(formatEastern(unreadable, false)).toBeNull();
    }
    expect(formatEasternMs(Number.NaN, true)).toBeNull();
    expect(formatEasternMs(Number.POSITIVE_INFINITY, true)).toBeNull();
    expect(formatEasternMs(Number.POSITIVE_INFINITY, false)).toBeNull();
  });
});
