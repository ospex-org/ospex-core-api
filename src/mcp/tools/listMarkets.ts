/**
 * `list_markets` — the games starting soon, their lines, and the prices a
 * reader could take on each side.
 *
 * Three reads per call, whatever the size of the history behind them: the
 * contests in the window, the speculations under those contests, and the open
 * quotes on them. The contest read is capped at {@link MAX_CONTESTS}; a window
 * holding more says so instead of showing part of it as the whole.
 */

import { logger } from '../../lib/logger.js';
import { SPORTS, isSport } from '../../lib/sports.js';
import { fetchOpenBook } from '../../v1/commitments.js';
import { buildContestListItems, fetchContestListRows } from '../../v1/contests.js';
import { parseTimestampMicros } from '../../v1/utils/gameTime.js';
import { buildBookLines, priceLevels, type BookLine } from '../book.js';
import {
  NOT_CONFIGURED,
  READ_FAILED,
  answer,
  microsOf,
  refusal,
  type ToolAnswer,
  type ToolContext,
} from '../context.js';
import { formatOddsTick, formatUsdcCents, takerOddsTick } from '../takeMath.js';
import { backingLabel, formatEastern, formatEasternMs, lineHeading, matchupLabel, sidesOf } from '../words.js';

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

function renderLine(line: BookLine, teams: { away: string; home: string }): string[] {
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
          `${formatOddsTick(takerOddsTick(level.makerOddsTick))} (up to ${formatUsdcCents(level.maxTakerRisk)} USDC)`,
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

  const window = `the next ${String(args.windowHours)} hours`;
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

  for (const contest of contests) {
    // The read already bounded the start by the window. A start that cannot
    // be read here cannot be shown as upcoming, so the game is left out.
    const startMicros = parseTimestampMicros(contest.matchTime);
    if (startMicros === null || startMicros <= nowMicros) continue;

    const teams = { away: contest.awayTeam, home: contest.homeTeam };
    const lines = buildBookLines(contest.contestId, contest.speculations, book.commitments, ctx.scorers, nowMicros);
    shown += 1;
    if (lines.some((line) => sidesOf(line.market).some((side) => line.quotes[side].length > 0))) withQuotes += 1;

    out.push('');
    out.push(
      `${String(shown)}. ${matchupLabel(teams)} — ${contest.sport.toUpperCase()} — ` +
        `${formatEastern(contest.matchTime) ?? contest.matchTime} — contest_id ${contest.contestId}`,
    );
    out.push(`   ${contest.awayTeam} is the away team, ${contest.homeTeam} is the home team.`);
    if (lines.length === 0) {
      out.push('   No line exists on-chain for this game yet.');
      continue;
    }
    for (const line of lines) out.push(...renderLine(line, teams));
  }

  if (shown === 0) {
    return answer([
      `No${scope} games are open for betting on Ospex in ${window}.`,
      'A game appears here once its contest is verified on-chain.',
    ]);
  }

  const head = [
    `Ospex: ${String(shown)}${scope} ${shown === 1 ? 'game' : 'games'} in ${window}` +
      `${asOf === null ? '' : `, as of ${asOf}`}.`,
    'Prices are decimal odds for the person taking the quote. Amounts are USDC, and "up to" is the most one order can risk at that price.',
  ];
  if (withQuotes === 0) head.push('No quotes are posted on any of these games right now.');

  const notes: string[] = [];
  if (read.total > read.rows.length) {
    notes.push(
      `Showing the first ${String(read.rows.length)} of ${String(read.total)} games by start time. ` +
        'Ask for one sport or a shorter window to see the rest.',
    );
  }
  if (!book.complete || read.specRows.length >= SPECULATION_READ_CEILING) {
    notes.push('The book was too large to read completely, so some lines or quotes may be missing.');
  }
  notes.push('Listing prices places nothing. prepare_order turns one of them into a preview and a link.');

  return answer([...head, ...out, '', ...notes]);
}
