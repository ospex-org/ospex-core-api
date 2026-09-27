/**
 * `prepare_order` — turn "this side, this much" into a preview a person can
 * read and a link that carries the order to their wallet.
 *
 * Nothing is placed and nothing is stored. The link names one posted quote by
 * its hash and an amount; the page behind it builds the transaction, and the
 * reader's own wallet sends it.
 *
 * ## Checks, in order
 *
 *   1. the amount is a positive USDC amount with at most six decimals
 *   2. the contest exists and is `verified`
 *   3. the contest has not started
 *   4. the side named is a side of that market
 *   5. the market has an open line on-chain
 *   6. the line, if named, is one of those lines
 *   7. a quote can be taken on that side for that amount
 *
 * The contract makes none of checks 2 and 3 when a quote is taken on an
 * existing line: a quote's own expiry is its only guard against time. So they
 * are made here, and the start is read from the conservative start bound the
 * contest listing serves.
 *
 * Four reads per call: the contest, its speculations, its open quotes, and the
 * funding snapshots of the makers on the chosen side.
 */

import { logger } from '../../lib/logger.js';
import type { MarketType } from '../../lib/speculation.js';
import { fetchMakerBacking, fetchOpenBook } from '../../v1/commitments.js';
import { fetchContestListItem } from '../../v1/contests.js';
import { parseTimestampMicros } from '../../v1/utils/gameTime.js';
import { buildBookLines, chooseQuote, type BookLine } from '../book.js';
import {
  NOT_CONFIGURED,
  READ_FAILED,
  answer,
  microsOf,
  refusal,
  type ToolAnswer,
  type ToolContext,
} from '../context.js';
import {
  formatOddsTick,
  formatUsdcCents,
  formatUsdcExact,
  formatUsdcShort,
  isWholeCents,
  parseUsdc,
} from '../takeMath.js';
import {
  backingLabel,
  formatEastern,
  formatHandicap,
  formatLine,
  handicapFor,
  matchupLabel,
  parseLine,
  pushSentence,
  resolveSide,
  type Side,
  type Teams,
} from '../words.js';

export interface PrepareOrderArgs {
  contestId: string;
  market: MarketType;
  side: string;
  riskUsdc: number;
  line: number | undefined;
}

const CONTEST_ID_PATTERN = /^\d{1,20}$/;
const NOTHING_PLACED = 'No order was prepared, and nothing was placed.';

/** A line as a caller on `side` would name it. */
function lineAsNamed(market: MarketType, side: Side, lineTicks: number): string {
  if (market === 'spread' && (side === 'away' || side === 'home')) {
    return formatHandicap(handicapFor(side, lineTicks));
  }
  return formatLine(Math.abs(lineTicks));
}

function amountProblem(reason: string): string {
  switch (reason) {
    case 'too_many_decimals':
      return 'risk_usdc has more than six decimal places. USDC has six.';
    case 'not_positive':
      return 'risk_usdc must be more than zero.';
    case 'too_large':
      return 'risk_usdc is more than one order may carry (1,000,000 USDC).';
    default:
      return 'risk_usdc must be a plain number of USDC, such as 10 or 2.5.';
  }
}

function sideProblem(reason: string, market: MarketType, teams: Teams): string {
  if (market === 'total') return 'For a total, side is over or under.';
  if (reason === 'both_teams_match') {
    return `That name fits both teams. Say ${teams.away} (away) or ${teams.home} (home).`;
  }
  if (reason === 'not_a_side_of_this_market') {
    return `Over and under are sides of a total. For a ${market}, side is ${teams.away} (away) or ${teams.home} (home).`;
  }
  return `That is not one of the teams in this game. Side is ${teams.away} (away) or ${teams.home} (home).`;
}

export async function prepareOrder(args: PrepareOrderArgs, ctx: ToolContext): Promise<ToolAnswer> {
  const amount = parseUsdc(args.riskUsdc);
  if (!amount.ok) return refusal([amountProblem(amount.reason), NOTHING_PLACED]);

  const contestId = args.contestId.trim();
  if (!CONTEST_ID_PATTERN.test(contestId)) {
    return refusal(['contest_id must be the number list_markets shows for the game.', NOTHING_PLACED]);
  }
  const canonicalId = BigInt(contestId).toString();
  if (ctx.scorers === undefined) return refusal([NOT_CONFIGURED]);

  const read = await fetchContestListItem(ctx.sb, ctx.network, canonicalId, ctx.scorers);
  if (!read.ok) {
    logger.error({ err: read.message, stage: read.stage }, 'mcp: prepare_order contest read failed');
    return refusal([READ_FAILED]);
  }
  const contest = read.contest;
  if (contest === null) {
    return refusal([`There is no contest ${canonicalId} on Ospex.`, NOTHING_PLACED]);
  }

  const teams: Teams = { away: contest.awayTeam, home: contest.homeTeam };
  const game = matchupLabel(teams);

  if (contest.status !== 'verified' || contest.chainStartTime === '') {
    return answer([
      `${game} is not open for betting: its contest is ${contest.status === '' ? 'in an unknown state' : contest.status}.`,
      NOTHING_PLACED,
    ]);
  }

  const nowMicros = microsOf(ctx.nowMs);
  const startMicros = parseTimestampMicros(contest.matchTime);
  if (startMicros === null) {
    // No readable start is not the same as a start in the future.
    logger.warn({ contestId: canonicalId }, 'mcp: prepare_order found a contest with no readable start time');
    return answer([`${game} has no start time Ospex can read, so it cannot be bet on.`, NOTHING_PLACED]);
  }
  const startsAt = formatEastern(contest.matchTime) ?? contest.matchTime;
  if (startMicros <= nowMicros) {
    return answer([`${game} started ${startsAt}. Ospex takes no bets on a game under way.`, NOTHING_PLACED]);
  }

  const resolved = resolveSide(args.side, args.market, teams);
  if (!resolved.ok) return refusal([sideProblem(resolved.reason, args.market, teams), NOTHING_PLACED]);
  const side = resolved.side;

  const book = await fetchOpenBook(ctx.sb, ctx.network, [canonicalId], ctx.nowMs);
  if (!book.ok) {
    logger.error({ err: book.error }, 'mcp: prepare_order open book read failed');
    return refusal([READ_FAILED]);
  }
  if (!book.complete) {
    // Part of a book cannot be searched for its best price.
    logger.warn({ contestId: canonicalId }, 'mcp: prepare_order could not read a whole book');
    return refusal([`The book on ${game} is too large to read completely.`, NOTHING_PLACED]);
  }

  const lines = buildBookLines(canonicalId, contest.speculations, book.commitments, ctx.scorers, nowMicros).filter(
    (line) => line.market === args.market,
  );
  if (lines.length === 0) {
    return answer([`${game} has no ${args.market} line on-chain yet.`, NOTHING_PLACED]);
  }

  let line: BookLine | undefined;
  if (args.line !== undefined && args.market !== 'moneyline') {
    const parsed = parseLine(args.line);
    if (!parsed.ok) {
      return refusal(['line must be a number with at most one decimal place, such as 7.5 or -1.5.', NOTHING_PLACED]);
    }
    // A spread is named from the side being backed; it is stored from the away side.
    const wanted =
      args.market === 'spread' && (side === 'away' || side === 'home')
        ? handicapFor(side, parsed.ticks)
        : Math.abs(parsed.ticks);
    line = lines.find((candidate) => candidate.lineTicks === wanted);
    if (line === undefined) {
      const offered = lines.map((candidate) => lineAsNamed(args.market, side, candidate.lineTicks)).join(', ');
      return answer([
        `${game} has no ${args.market} line at ${lineAsNamed(args.market, side, wanted)}. Lines on-chain: ${offered}.`,
        NOTHING_PLACED,
      ]);
    }
  } else {
    const quoted = lines.filter((candidate) => candidate.quotes[side].length > 0);
    if (quoted.length > 1) {
      const offered = quoted
        .map((candidate) => backingLabel(args.market, side, candidate.lineTicks, teams))
        .join('; ');
      return refusal([`More than one line has a quote: ${offered}. Say which with line.`, NOTHING_PLACED]);
    }
    line = quoted[0] ?? lines[0];
  }
  if (line === undefined) {
    return answer([`${game} has no ${args.market} line on-chain yet.`, NOTHING_PLACED]);
  }

  const backing = backingLabel(line.market, side, line.lineTicks, teams);
  const candidates = line.quotes[side];
  if (candidates.length === 0) {
    return answer([`No quote is posted for ${backing} on ${game} right now.`, NOTHING_PLACED]);
  }

  const funding = await fetchMakerBacking(
    ctx.sb,
    ctx.network,
    [...new Set(candidates.map((quote) => quote.maker))],
    ctx.nowMs,
  );
  const choice = chooseQuote(candidates, amount.baseUnits, funding);
  if (!choice.ok) {
    if (choice.reason === 'too_small') {
      return answer([
        `${formatUsdcShort(amount.baseUnits)} USDC is too small to take any quote for ${backing}. ` +
          `The smallest is ${formatUsdcShort(choice.minTakerRisk)} USDC.`,
        NOTHING_PLACED,
      ]);
    }
    if (choice.reason === 'maker_unfunded') {
      return answer([
        `A quote is posted for ${backing}, but its maker does not have the funds behind it right now.`,
        NOTHING_PLACED,
      ]);
    }
    return answer([`No quote is posted for ${backing} on ${game} right now.`, NOTHING_PLACED]);
  }

  const { plan, quote } = choice;
  const price = formatOddsTick(plan.takerOddsTick);
  const out: string[] = [
    `${backing} — ${game}, ${startsAt}.`,
    `Risk ${formatUsdcCents(plan.takerRisk)} USDC to win ${formatUsdcCents(plan.takerProfit)} at ${price}.`,
  ];
  const push = pushSentence(line.market, line.lineTicks, teams);
  if (push !== null) out.push(push);
  out.push(`Quote expires ${formatEastern(quote.expiry) ?? quote.expiry}.`);
  if (!isWholeCents(plan.takerRisk) || !isWholeCents(plan.takerProfit)) {
    out.push(
      `Exact amounts: you pay ${formatUsdcExact(plan.takerRisk)} USDC and win ${formatUsdcExact(plan.takerProfit)} USDC.`,
    );
  }
  if (plan.reduced) {
    out.push(
      `This quote can take ${formatUsdcShort(plan.takerDesiredRisk)} USDC, not the ` +
        `${formatUsdcShort(plan.requestedTakerRisk)} asked for. The order is for ${formatUsdcShort(plan.takerDesiredRisk)}.`,
    );
  }
  if (!choice.fundingConfirmed) {
    out.push(
      "The maker's funds could not be confirmed just now. If they are short the transaction fails and only gas is spent.",
    );
  }

  const link =
    `${ctx.takeLinkBaseUrl}/take/${quote.commitmentHash}` + `?risk=${formatUsdcShort(plan.takerDesiredRisk)}`;
  out.push('');
  out.push(`Take link: ${link}`);
  out.push('Nothing has been placed. The order is placed only when you open the link and confirm in your wallet.');
  out.push('');
  out.push(`contest_id: ${canonicalId}`);
  out.push(`commitment_hash: ${quote.commitmentHash}`);
  out.push(`market: ${line.market}`);
  if (line.market !== 'moneyline') out.push(`line: ${lineAsNamed(line.market, side, line.lineTicks)}`);
  out.push(`side: ${side}`);
  out.push(`risk_usdc: ${formatUsdcShort(plan.takerDesiredRisk)}`);
  return answer(out);
}
