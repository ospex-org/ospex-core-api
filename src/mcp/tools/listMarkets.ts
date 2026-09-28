/**
 * `list_markets` — the games starting soon, their lines, and the prices a
 * reader could take on each side.
 *
 * Three reads per call: the contests in the window, the speculations under
 * those contests, and the open quotes on them. The open-quote read is paged,
 * so it is one request while fewer than 999 quotes are open on those contests
 * and at most 8 past that. The contest read is capped at {@link MAX_CONTESTS};
 * a window holding more says so instead of showing part of it as the whole.
 */

import { logger } from '../../lib/logger.js';
import { SPORTS, isSport } from '../../lib/sports.js';
import { fetchOpenBook } from '../../v1/commitments.js';
import { buildContestListItems, fetchContestListRows } from '../../v1/contests.js';
import { parseTimestampMicros } from '../../v1/utils/gameTime.js';
import { TAKE_MARGIN_MICROS, buildBookLines, priceLevels, type BookLine } from '../book.js';
import {
  NOT_CONFIGURED,
  READ_FAILED,
  answer,
  microsOf,
  refusal,
  type ToolAnswer,
  type ToolContext,
} from '../context.js';
import { formatOddsTick, formatUsdcCentsDown, takerOddsTick } from '../takeMath.js';
import {
  backingLabel,
  formatEastern,
  formatEasternMs,
  lineHeading,
  matchupLabel,
  sidesOf,
  teamsOf,
  type Teams,
} from '../words.js';

export const DEFAULT_WINDOW_HOURS = 48;
export const MAX_WINDOW_HOURS = 168;
/** Contests one call lists. */
export const MAX_CONTESTS = 25;
/** Price levels shown per side. */
export const MAX_LEVELS = 3;
/**
 * The speculation read carries no limit of its own, so the server's ceiling is
 * the only one it has. Reaching it means rows may be missing.
 */
const SPECULATION_READ_CEILING = 1000;

export interface ListMarketsArgs {
  windowHours: number;
  sport: string | undefined;
}

function renderLine(line: BookLine, teams: Teams): string[] {
  const out = [`   ${lineHeading(line.market, line.lineTicks)}`];
  for (const side of sidesOf(line.market)) {
    const label = backingLabel(line.market, side, line.lineTicks, teams);
    const levels = priceLevels(line.quotes[side]).slice(0, MAX_LEVELS);
    if (levels.length === 0) {
      out.push(`     ${label}: no quote posted`);
      continue;
    }
    const prices = levels
      .map(
        (level) =>
          `${formatOddsTick(takerOddsTick(level.makerOddsTick))} (up to ${formatUsdcCentsDown(level.maxTakerRisk)} USDC)`,
      )
      .join(', ');
    out.push(`     ${label}: ${prices}`);
  }
  return out;
}

export async function listMarkets(args: ListMarketsArgs, ctx: ToolContext): Promise<ToolAnswer> {
  if (!Number.isInteger(args.windowHours) || args.windowHours < 1 || args.windowHours > MAX_WINDOW_HOURS) {
    return refusal([`window_hours must be a whole number from 1 to ${String(MAX_WINDOW_HOURS)}.`]);
  }
  let sport: string | null = null;
  if (args.sport !== undefined && args.sport.trim() !== '') {
    sport = args.sport.trim().toLowerCase();
    if (!isSport(sport)) {
      return refusal([`sport must be one of: ${[...SPORTS].sort().join(', ')}.`]);
    }
  }
  if (ctx.scorers === undefined) return refusal([NOT_CONFIGURED]);

  const read = await fetchContestListRows(ctx.sb, ctx.network, {
    nowMs: ctx.nowMs,
    windowHours: args.windowHours,
    sport,
    status: 'verified',
    limit: MAX_CONTESTS,
    offset: 0,
    datedDay: null,
    tiebreakByContestId: true,
  });
  if (!read.ok) {
    logger.error({ err: read.message, stage: read.stage }, 'mcp: list_markets contest read failed');
    return refusal([READ_FAILED]);
  }

  const window = args.windowHours === 1 ? 'the next hour' : `the next ${String(args.windowHours)} hours`;
  const scope = sport === null ? '' : ` ${sport.toUpperCase()}`;
  const asOf = formatEasternMs(ctx.nowMs);
  if (read.rows.length === 0) {
    return answer([
      `No${scope} games are open for betting on Ospex in ${window}.`,
      'A game appears here once its contest is verified on-chain.',
    ]);
  }

  const contests = buildContestListItems(read.rows, read.specRows, ctx.scorers, null);
  const book = await fetchOpenBook(
    ctx.sb,
    ctx.network,
    contests.map((contest) => contest.contestId),
    ctx.nowMs,
  );
  if (!book.ok) {
    logger.error({ err: book.error }, 'mcp: list_markets open book read failed');
    return refusal([READ_FAILED]);
  }

  const nowMicros = microsOf(ctx.nowMs);
  const out: string[] = [];
  let shown = 0;
  let withQuotes = 0;
  let tooClose = 0;

  for (const contest of contests) {
    // The read asked for verified contests only. prepare_order checks the same
    // two things on the row it reads, and so does this.
    if (contest.status !== 'verified' || contest.chainStartTime === '') continue;
    // The read already bounded the start by the window. A start that cannot
    // be read here cannot be shown as upcoming, so the game is left out. So is
    // one too close to its start for prepare_order to take, so that nothing is
    // listed here that would be refused there; those are counted, and the
    // answer says how many.
    const startMicros = parseTimestampMicros(contest.matchTime);
    if (startMicros === null) continue;
    if (startMicros - nowMicros <= TAKE_MARGIN_MICROS) {
      tooClose += 1;
      continue;
    }

    const teams = teamsOf(contest);
    const lines = buildBookLines(contest.contestId, contest.speculations, book.commitments, ctx.scorers, nowMicros);
    shown += 1;
    if (lines.some((line) => sidesOf(line.market).some((side) => line.quotes[side].length > 0))) withQuotes += 1;

    out.push('');
    out.push(
      `${String(shown)}. ${matchupLabel(teams)} — ${contest.sport.toUpperCase()} — ` +
        `${formatEastern(contest.matchTime) ?? contest.matchTime} — contest_id ${contest.contestId}`,
    );
    out.push(`   ${teams.away} is the away team, ${teams.home} is the home team.`);
    if (lines.length === 0) {
      out.push('   No line exists on-chain for this game yet.');
      continue;
    }
    for (const line of lines) out.push(...renderLine(line, teams));
  }

  const leftOut =
    tooClose === 0
      ? null
      : `${String(tooClose)} ${tooClose === 1 ? 'game that starts' : 'games that start'} within two minutes ` +
        `${tooClose === 1 ? 'is' : 'are'} left out: that is too close to the start to prepare an order.`;

  const later = read.total - read.rows.length;
  if (shown === 0) {
    // When the read was cut short, the rest of the window's games were not
    // read, so "none" would be a claim about games nobody looked at.
    if (later > 0) {
      return answer([
        `None of the first ${String(read.rows.length)}${scope} games in ${window} can be bet on now.`,
        ...(leftOut === null ? [] : [leftOut]),
        `${String(later)} more ${later === 1 ? 'game' : 'games'} in the window ${later === 1 ? 'was' : 'were'} not read. ` +
          'Ask for one sport or a shorter window to see them.',
      ]);
    }
    return answer([
      `No${scope} games are open for betting on Ospex in ${window}.`,
      leftOut ?? 'A game appears here once its contest is verified on-chain.',
    ]);
  }

  const head = [
    `Ospex: ${String(shown)}${scope} ${shown === 1 ? 'game' : 'games'} in ${window}` +
      `${asOf === null ? '' : `, as of ${asOf}`}.`,
    'Prices are decimal odds for the person taking the quote, rounded to two places. Amounts are USDC, and "up to" is the most one order can risk at that price.',
  ];
  const incomplete = !book.complete || read.specRows.length >= SPECULATION_READ_CEILING;
  // Part of a book that shows no quote is not a book with none.
  if (withQuotes === 0 && !incomplete) head.push('No quotes are posted on any of these games right now.');

  const notes: string[] = [];
  if (leftOut !== null) notes.push(leftOut);
  // Whether the cap was reached is a fact about the read. How many are shown
  // is what the reader counts.
  if (later > 0) {
    notes.push(
      `Showing the first ${String(shown)} of ${String(read.total)} games by start time. ` +
        'Ask for one sport or a shorter window to see the rest.',
    );
  }
  if (incomplete) {
    notes.push('The book was too large to read completely, so some lines or quotes may be missing.');
  }
  notes.push(
    'Listing prices places nothing. prepare_order turns one of them into a preview with the amounts paid and won, and a link.',
  );

  return answer([...head, ...out, '', ...notes]);
}
