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
 *   2. the contest exists and is `verified`, with a start on-chain
 *   3. the contest does not start within {@link TAKE_MARGIN_MICROS}
 *   4. the side named is a side of that market
 *   5. the market has an open line on-chain
 *   6. the line, if named, is one of those lines
 *   7. a quote can be taken on that side for that amount
 *
 * Three refusals sit between them. Before 2, a contest id that is not the
 * digits of a 64-bit id is refused without a read, and so is every call when
 * the service has no scorer addresses. Between 4 and 5 the open quotes are
 * read, and a book too large to read whole is refused: its best price cannot
 * be found in part of it.
 *
 * The contract refuses a take once a contest is scored or voided, or is past
 * its void cooldown, which is counted from the start. It does not refuse a
 * take because the game has started, so check 3 is made here, against the
 * conservative start bound the contest listing serves. The margin is the one
 * a quote's expiry gets, for the same reason: a reader needs time to open the
 * link, confirm, and be mined.
 *
 * A margin narrows the gap and cannot close it. A link prepared three minutes
 * before the start is still a link after it, and the contract would fill it.
 * The page behind the link has to look at the start again.
 *
 * Four reads per call: the contest, its speculations, its open quotes, and the
 * funding snapshots of the makers on the chosen side. The open-quote read is
 * paged, so it is one request while fewer than 999 quotes are open on the
 * contest and at most 8 past that.
 */

import { logger } from '../../lib/logger.js';
import type { MarketType } from '../../lib/speculation.js';
import { fetchMakerBacking, fetchOpenBook } from '../../v1/commitments.js';
import { fetchContestListItem } from '../../v1/contests.js';
import { parseTimestampMicros } from '../../v1/utils/gameTime.js';
import { TAKE_MARGIN_MICROS, buildBookLines, chooseQuote, type BookLine } from '../book.js';
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
  formatUsdcCentsDown,
  formatUsdcExact,
  formatUsdcShort,
  isWholeCents,
  parseUsdc,
  takerOddsTick,
} from '../takeMath.js';
import {
  backingLabel,
  formatEastern,
  formatEasternMs,
  formatHandicap,
  formatLine,
  handicapFor,
  matchupLabel,
  parseLine,
  pushSentence,
  resolveSide,
  teamsOf,
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
/** The largest id the database's 64-bit column holds. One past it is an error there, not a miss. */
const MAX_CONTEST_ID = 9_223_372_036_854_775_807n;
/**
 * Makers whose funding one call reads. A maker past this many is not known
 * to be short, so its quote can still be offered, with the preview saying the
 * funds were not confirmed.
 */
export const MAX_FUNDING_MAKERS = 100;
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

/**
 * Every form these sentences tell a caller to pass is one `resolveSide` takes:
 * `away`, `home`, `over`, `under`, or a team's name with nothing added to it.
 */
function sideProblem(reason: string, market: MarketType, teams: Teams): string {
  if (market === 'total') return 'For a total, side is over or under, by itself.';
  const either = `Pass away for ${teams.away}, or home for ${teams.home}.`;
  if (reason === 'both_teams_match') return `That name fits both teams. ${either}`;
  if (reason === 'not_a_side_of_this_market') {
    return `Over and under are sides of a total. For a ${market}, side is a team. ${either}`;
  }
  return `side was not read as one of the two teams. Pass a team's name by itself, with nothing after it. ${either}`;
}

export async function prepareOrder(args: PrepareOrderArgs, ctx: ToolContext): Promise<ToolAnswer> {
  const amount = parseUsdc(args.riskUsdc);
  if (!amount.ok) return refusal([amountProblem(amount.reason), NOTHING_PLACED]);

  const contestId = args.contestId.trim();
  if (!CONTEST_ID_PATTERN.test(contestId) || BigInt(contestId) > MAX_CONTEST_ID) {
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

  const teams = teamsOf(contest);
  const game = matchupLabel(teams);

  if (contest.status === 'verified' && contest.chainStartTime === '') {
    return answer([`${game} is not open for betting: its contest has no start time on-chain.`, NOTHING_PLACED]);
  }
  if (contest.status !== 'verified') {
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
    // The contract would still fill a take after the start; it is this tool
    // that prepares none.
    return answer([`${game} started ${startsAt}. No order is prepared on a game under way.`, NOTHING_PLACED]);
  }
  if (startMicros - nowMicros <= TAKE_MARGIN_MICROS) {
    return answer([
      `${game} starts ${startsAt}, less than two minutes from now. That is too close to the start to prepare an order.`,
      NOTHING_PLACED,
    ]);
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

  // The quotes are best first, so the makers read are the best-priced ones.
  const makers = [...new Set(candidates.map((quote) => quote.maker))].slice(0, MAX_FUNDING_MAKERS);
  const funding = await fetchMakerBacking(ctx.sb, ctx.network, makers, ctx.nowMs);
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
    // The win is rounded down, so the headline never promises more than the
    // chain pays. The exact amounts follow whenever the two differ.
    `Risk ${formatUsdcCents(plan.takerRisk)} USDC to win ${formatUsdcCentsDown(plan.takerProfit)} at ${price}.`,
  ];
  const push = pushSentence(line.market, line.lineTicks, teams);
  if (push !== null) out.push(push);
  // The contract does not look at the start, so a quote that expires after it
  // could be taken with the game under way. The start is the deadline to give.
  out.push(
    quote.expiryMicros > startMicros
      ? `Take it before the game starts, ${startsAt}. The quote itself expires later than that.`
      : `Quote expires ${formatEastern(quote.expiry) ?? quote.expiry}.`,
  );
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
  // One order takes one quote, so the better price is not this order's to
  // have. Saying it is there lets the reader ask for the amount that fits.
  //
  // Two posted prices can show as one price at two decimals. A line that says
  // "better" and names the price already shown is left out. The amount is
  // rounded DOWN, so that asking for the amount named gets the price named.
  if (choice.better !== undefined && takerOddsTick(choice.better.makerOddsTick) > plan.takerOddsTick) {
    out.push(
      `A better price, ${formatOddsTick(takerOddsTick(choice.better.makerOddsTick))}, is posted for up to ` +
        `${formatUsdcCentsDown(choice.better.maxTakerRisk)} USDC.`,
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
  // A fill by the same wallet on the same quote, from an earlier order, is
  // what get_order_status would list for this one too. The time tells them
  // apart, to the second, and a tie goes the safe way: an order cannot be
  // confirmed and mined in the second it was prepared.
  out.push(
    `Prepared ${formatEasternMs(ctx.nowMs, true) ?? new Date(ctx.nowMs).toISOString()}. ` +
      'A fill made at or before then is not this order.',
  );
  out.push('');
  out.push(`contest_id: ${canonicalId}`);
  out.push(`commitment_hash: ${quote.commitmentHash}`);
  out.push(`market: ${line.market}`);
  if (line.market !== 'moneyline') out.push(`line: ${lineAsNamed(line.market, side, line.lineTicks)}`);
  out.push(`side: ${side}`);
  if (side === 'away' || side === 'home') out.push(`team: ${side === 'away' ? teams.away : teams.home}`);
  out.push(`risk_usdc: ${formatUsdcShort(plan.takerDesiredRisk)}`);
  return answer(out);
}
