/**
 * The words the connector's tools answer in: which side is which, what a line
 * is called from each side, when a bet is a push, and how a time is written.
 *
 * Pure: no I/O, no clock. A caller that needs "now" passes it in.
 *
 * ## Sides
 *
 * On chain a position is Upper (0) or Lower (1). Which words those are depends
 * on the market:
 *
 *     moneyline, spread   Upper = the AWAY team    Lower = the HOME team
 *     total               Upper = OVER             Lower = UNDER
 *
 * A quote records the side its MAKER holds. Whoever takes it gets the other
 * one, so a reader who wants the Under takes quotes whose maker holds the Over.
 *
 * ## Spread lines
 *
 * A spread's stored line is the AWAY team's handicap, times ten. The home
 * team's handicap is its negation, and both sides of one market share the one
 * stored value. "Home -1.5" and "Away +1.5" are the same line, stored as +15.
 *
 * ## Teams are always named
 *
 * "Home" and "away" on their own are easy to swap. Every label here that says
 * one of them also says which team it is.
 */

import type { MarketType } from '../lib/speculation.js';
import { parseTimestampMicros } from '../v1/utils/gameTime.js';

export type Side = 'away' | 'home' | 'over' | 'under';

export interface Teams {
  away: string;
  home: string;
}

/** The side a position type is, in this market. */
export function sideOf(market: MarketType, positionType: 0 | 1): Side {
  if (market === 'total') return positionType === 0 ? 'over' : 'under';
  return positionType === 0 ? 'away' : 'home';
}

/** The two sides of a market, Upper first. */
export function sidesOf(market: MarketType): readonly [Side, Side] {
  return market === 'total' ? ['over', 'under'] : ['away', 'home'];
}

// ── lines ──────────────────────────────────────────────────────────────

/** Line ticks as a line with one decimal place: `70` is `7.0`, `-35` is `-3.5`. */
export function formatLine(lineTicks: number): string {
  const negative = lineTicks < 0;
  const magnitude = Math.abs(lineTicks);
  return `${negative ? '-' : ''}${String(Math.trunc(magnitude / 10))}.${String(magnitude % 10)}`;
}

/** A handicap with its sign always written: `+1.5`, `-3.5`, and `+0.0` for a pick'em. */
export function formatHandicap(lineTicks: number): string {
  // `-0` is a number JavaScript will happily hand over; it is not a handicap.
  const ticks = lineTicks === 0 ? 0 : lineTicks;
  return ticks < 0 ? formatLine(ticks) : `+${formatLine(ticks)}`;
}

/** A spread's stored line, as the handicap of the given side. */
export function handicapFor(side: 'away' | 'home', lineTicks: number): number {
  const ticks = side === 'away' ? lineTicks : -lineTicks;
  return ticks === 0 ? 0 : ticks;
}

export type ParsedLine = { ok: true; ticks: number } | { ok: false };

/**
 * Read a line as a caller wrote it into ticks. At most one decimal place;
 * a second one is refused, not rounded, because 7.25 is not a line that
 * rounds to a nearby one the caller would accept.
 */
export function parseLine(input: number): ParsedLine {
  if (!Number.isFinite(input)) return { ok: false };
  const text = String(input);
  const match = /^(-?)(\d{1,6})(?:\.(\d))?$/.exec(text);
  if (match === null) return { ok: false };
  const magnitude = Number(match[2]) * 10 + Number(match[3] ?? '0');
  const ticks = match[1] === '-' ? -magnitude : magnitude;
  return { ok: true, ticks: ticks === 0 ? 0 : ticks };
}

// ── labels ─────────────────────────────────────────────────────────────

const NAME_MAX_LENGTH = 80;

/**
 * A team's name as one line of plain text. Names are the only text a person
 * wrote that the tools print from the database; the rest comes from typed
 * columns written from chain data: addresses, hashes, amounts, times and
 * statuses. An answer is read
 * line by line, and a name holding a line break could put a line of its own
 * into one.
 *
 * Characters that print as nothing (zero-width ones, direction marks, tags)
 * and halves of a character are dropped, not turned into a space. The cut is
 * made on characters, and the end is trimmed again because the cut can land
 * on a space.
 */
export function cleanName(name: string): string {
  const oneLine = name
    .replace(/[\p{Cf}\p{Cs}]/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim();
  return [...oneLine].slice(0, NAME_MAX_LENGTH).join('').trimEnd();
}

/**
 * The two teams of a game, named as they are printed. A name that is empty
 * once cleaned is printed as its role, so no label is left with a blank in it.
 */
export function teamsOf(contest: { awayTeam: string; homeTeam: string }): Teams {
  const away = cleanName(contest.awayTeam);
  const home = cleanName(contest.homeTeam);
  return { away: away === '' ? 'Away team' : away, home: home === '' ? 'Home team' : home };
}

export function matchupLabel(teams: Teams): string {
  return `${teams.away} @ ${teams.home}`;
}

/** A team with its role: `Philadelphia Phillies (home)`. */
export function teamLabel(side: 'away' | 'home', teams: Teams): string {
  return `${side === 'away' ? teams.away : teams.home} (${side})`;
}

/**
 * What a bettor on `side` is backing, in words.
 *
 *     total       Under 7.0
 *     moneyline   Philadelphia Phillies (home) to win
 *     spread      Philadelphia Phillies (home) -1.5
 */
export function backingLabel(market: MarketType, side: Side, lineTicks: number, teams: Teams): string {
  if (side === 'over' || side === 'under') {
    return `${side === 'over' ? 'Over' : 'Under'} ${formatLine(Math.abs(lineTicks))}`;
  }
  if (market === 'spread') {
    return `${teamLabel(side, teams)} ${formatHandicap(handicapFor(side, lineTicks))}`;
  }
  return `${teamLabel(side, teams)} to win`;
}

/** The heading of a market's line: `Moneyline`, `Total 7.0`, `Spread`. */
export function lineHeading(market: MarketType, lineTicks: number): string {
  if (market === 'moneyline') return 'Moneyline';
  if (market === 'total') return `Total ${formatLine(Math.abs(lineTicks))}`;
  return 'Spread';
}

const PUSH_RETURNS = 'the stake is returned.';

/**
 * The sentence that says when this bet is a push, or `null` when it cannot be
 * one. Follows the scorer contracts:
 *
 *     moneyline   push when the scores are level
 *     spread      push when away score + line equals home score
 *     total       push when the combined score equals the line
 *
 * A spread or total on a half point has no score that lands on it. Every
 * sentence says what a push does, for a reader who has not met the word.
 */
export function pushSentence(market: MarketType, lineTicks: number, teams: Teams): string | null {
  if (market === 'moneyline') return `A tie is a push: ${PUSH_RETURNS}`;
  if (lineTicks % 10 !== 0) return null;
  const points = Math.abs(lineTicks) / 10;
  if (market === 'total') return `A combined score of exactly ${String(points)} is a push: ${PUSH_RETURNS}`;
  if (lineTicks === 0) return `A tie is a push: ${PUSH_RETURNS}`;
  // The line is added to the away score. Negative: the away team gives points
  // and pushes by winning by exactly that many. Positive: the home team does.
  const giver = lineTicks < 0 ? teams.away : teams.home;
  return `${giver} winning by exactly ${String(points)} is a push: ${PUSH_RETURNS}`;
}

// ── which side did the caller mean ─────────────────────────────────────

export type SideResolution =
  | { ok: true; side: Side }
  | { ok: false; reason: 'not_a_side_of_this_market' | 'no_team_matches' | 'both_teams_match' };

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/** True when `needle` appears in `haystack` as a run of whole words. */
function containsWords(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

/**
 * Work out which side a caller named.
 *
 * A total takes `over` or `under`. A moneyline or spread takes `away`, `home`,
 * or a team's name — whole words of it, so "Phillies" and "Philadelphia" both
 * find the Philadelphia Phillies and "Phil" finds nobody. A leading "the" is
 * dropped. A name that fits both teams is refused rather than guessed at.
 */
export function resolveSide(input: string, market: MarketType, teams: Teams): SideResolution {
  const written = words(input);
  const asked = written.length > 1 && written[0] === 'the' ? written.slice(1) : written;
  const word = asked.length === 1 ? asked[0] : undefined;

  if (market === 'total') {
    if (word === 'over' || word === 'under') return { ok: true, side: word };
    return { ok: false, reason: 'not_a_side_of_this_market' };
  }

  if (word === 'away' || word === 'home') return { ok: true, side: word };
  if (word === 'over' || word === 'under') return { ok: false, reason: 'not_a_side_of_this_market' };

  const away = containsWords(words(teams.away), asked);
  const home = containsWords(words(teams.home), asked);
  if (away && home) return { ok: false, reason: 'both_teams_match' };
  if (away) return { ok: true, side: 'away' };
  if (home) return { ok: true, side: 'home' };
  return { ok: false, reason: 'no_team_matches' };
}

// ── times ──────────────────────────────────────────────────────────────

const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

/**
 * An instant as US Eastern wall-clock time: `Sun Sep 27, 3:05 pm ET`, or with
 * `seconds`, `Sun Sep 27, 3:05:09 pm ET`.
 *
 * Seconds are for the two times a reader compares with each other: when an
 * order was prepared and when a fill was made. To the minute, a fill made
 * earlier in the same minute could not be told from the order.
 *
 * Assembled from the formatter's parts, not its finished string, because the
 * separators in that string differ between runtime versions.
 */
export function formatEasternMs(epochMs: number, seconds = false): string | null {
  if (!Number.isFinite(epochMs)) return null;
  const parts = new Map<string, string>();
  for (const part of EASTERN.formatToParts(new Date(epochMs))) parts.set(part.type, part.value);
  const weekday = parts.get('weekday');
  const month = parts.get('month');
  const day = parts.get('day');
  const hour = parts.get('hour');
  const minute = parts.get('minute');
  const second = parts.get('second');
  const period = parts.get('dayPeriod');
  if (!weekday || !month || !day || !hour || !minute || !second || !period) return null;
  const clock = seconds ? `${hour}:${minute}:${second}` : `${hour}:${minute}`;
  return `${weekday} ${month} ${day}, ${clock} ${period.toLowerCase()} ET`;
}

/** A database timestamp as US Eastern wall-clock time, or `null` when it cannot be read. */
export function formatEastern(timestamp: string, seconds = false): string | null {
  const micros = parseTimestampMicros(timestamp);
  if (micros === null) return null;
  return formatEasternMs(Number(micros / 1000n), seconds);
}
