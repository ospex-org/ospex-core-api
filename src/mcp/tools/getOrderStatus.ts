/**
 * `get_order_status` — where a posted quote stands, and who has taken it.
 *
 * A quote's fills say what has been taken from it, by whom, and in which
 * transaction. A reader who just confirmed a take looks for their own address
 * among them, which is what `taker_address` is for.
 *
 * ## A quote's status is about the quote
 *
 * "Open" says that a quote has not been filled, cancelled or expired. It does
 * not say an order can be placed against it. So the answer says what is left
 * to take only when the contest, the start and the quote itself pass the
 * checks `prepare_order` makes on them, and says which one failed when one
 * does. It does not say `prepare_order` would offer the quote: that also takes
 * an open line on-chain and a funded maker, and `prepare_order` picks among a
 * side's quotes by price and size.
 *
 * ## Fills are everyone's unless a wallet is named
 *
 * Without `taker_address` the fills listed are every taker's. A quote that
 * reads "filled" with a fill under it was taken by somebody, which is not the
 * same as by the reader, and the answer says so.
 *
 * ## Fills arrive late, on purpose
 *
 * A fill is recorded once the indexer has seen its block as final, so a take
 * that has just confirmed is not listed yet. The answer says so every time,
 * because "no fills" a few seconds after a take reads as "it failed" otherwise.
 *
 * ## Hidden quotes
 *
 * A quote its maker withdrew from the book is served without its price, size
 * or line, exactly as the REST API serves it. Its fills are public either way.
 * Withdrawing a quote takes it off the book and does not cancel it on-chain,
 * so it is reported as withdrawn, not as one that can no longer be taken.
 *
 * Three reads per call: the quote, its fills, and its contest. A failed contest
 * read costs the names and what is said about taking the quote, and nothing
 * else.
 */

import { isAddress } from 'ethers';
import { logger } from '../../lib/logger.js';
import {
  HASH_PATTERN,
  fetchPublicCommitmentByHash,
  type CommitmentBody,
} from '../../v1/commitments.js';
import { fetchContestListItem } from '../../v1/contests.js';
import { fetchFillRows, rowToBody as fillRowToBody, type FillBody } from '../../v1/fills.js';
import { parseTimestampMicros } from '../../v1/utils/gameTime.js';
import { TAKE_MARGIN_MICROS, takeableQuote } from '../book.js';
import { READ_FAILED, answer, microsOf, refusal, type ToolAnswer, type ToolContext } from '../context.js';
import {
  ODDS_SCALE,
  formatOddsTick,
  formatUsdcShort,
  isValidOddsTick,
  maxTakerRisk,
  takerOddsTick,
} from '../takeMath.js';
import { backingLabel, formatEastern, matchupLabel, sideOf, teamsOf, type Teams } from '../words.js';

export interface GetOrderStatusArgs {
  commitmentHash: string;
  takerAddress: string | undefined;
}

/** Fills one call reads. The server's own ceiling for one response. */
export const MAX_FILLS = 1000;

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

const LAG_NOTE =
  'A fill is listed once its block is final, usually within about 15 seconds of the transaction confirming.';

/** A map, so that a status nobody expected is looked up and not found. */
const STATUS_WORDS: ReadonlyMap<string, string> = new Map([
  ['open', 'open'],
  ['partially_filled', 'partially filled: part of it has been taken'],
  ['filled', 'filled: all of it has been taken'],
  ['cancelled', 'cancelled: it can no longer be taken'],
  ['expired', 'expired: it can no longer be taken'],
]);

const LIVE: ReadonlySet<string> = new Set(['open', 'partially_filled']);
const CLOSED: ReadonlySet<string> = new Set(['filled', 'cancelled', 'expired']);

/** What the contest read says about the game, when it could be made. */
interface Game {
  teams: Teams;
  status: string;
  chainStartTime: string;
  matchTime: string;
}

function renderFill(fill: FillBody, index: number): string {
  const price = isValidOddsTick(fill.oddsTick) ? ` at ${formatOddsTick(takerOddsTick(fill.oddsTick))}` : '';
  // To the second: a reader compares it with the time an order was prepared.
  const when = formatEastern(fill.filledAt, true) ?? fill.filledAt;
  return (
    `${String(index + 1)}. ${fill.taker} risked ${formatUsdcShort(BigInt(fill.takerRiskAmount))} USDC ` +
    `to win ${formatUsdcShort(BigInt(fill.makerRiskAmount))} USDC${price}, ${when}. Transaction ${fill.txHash}`
  );
}

/**
 * What is left of an open quote to take, or why no order can be prepared
 * against it.
 *
 * The checks are the ones `prepare_order` makes on the contest, the start and
 * the quote itself, in its order. Whether the quote's line is open on-chain,
 * whether its maker is funded, and which quote on a side an order gets are
 * `prepare_order`'s to decide and are not looked at here.
 */
function whatIsLeft(quote: CommitmentBody, game: Game, nowMicros: bigint): string {
  if (game.status === 'verified' && game.chainStartTime === '') {
    return 'Its contest has no start time on-chain, so no order can be prepared against it.';
  }
  if (game.status !== 'verified') {
    return `Its contest is ${game.status === '' ? 'in an unknown state' : game.status}, so no order can be prepared against it.`;
  }
  const startMicros = parseTimestampMicros(game.matchTime);
  if (startMicros === null) {
    return 'Its game has no start time Ospex can read, so no order can be prepared against it.';
  }
  const startsAt = formatEastern(game.matchTime) ?? game.matchTime;
  if (startMicros <= nowMicros) {
    return `Its game started ${startsAt}, so no order can be prepared against it.`;
  }
  if (startMicros - nowMicros <= TAKE_MARGIN_MICROS) {
    return `Its game starts ${startsAt}, less than two minutes from now, which is too close to prepare an order.`;
  }
  const takeable = takeableQuote(quote, nowMicros);
  if (takeable === null) {
    // Size and time are the two reasons a well-formed quote is not on offer.
    // Anything else is a row the book will not hand out a link for.
    const expiryMicros = quote.expiry === null ? null : parseTimestampMicros(quote.expiry);
    const short = /^\d+$/.test(quote.remainingRiskAmount) && BigInt(quote.remainingRiskAmount) < ODDS_SCALE;
    const late = expiryMicros !== null && expiryMicros - nowMicros <= TAKE_MARGIN_MICROS;
    return short || late
      ? 'Too little of it is left, or too little time before it expires, to prepare an order against it.'
      : 'It cannot be offered as it stands, so no order can be prepared against it.';
  }
  const left = maxTakerRisk(takeable.makerOddsTick, takeable.remainingMakerRisk);
  return (
    `Left to take: up to ${formatUsdcShort(left)} USDC of taker risk. ` +
    'prepare_order chooses the quote for an order itself, and may choose another one or none.'
  );
}

export async function getOrderStatus(args: GetOrderStatusArgs, ctx: ToolContext): Promise<ToolAnswer> {
  const rawHash = args.commitmentHash.trim();
  if (!HASH_PATTERN.test(rawHash)) {
    return refusal(['commitment_hash must be 0x followed by 64 hex characters, as prepare_order gave it.']);
  }
  const hash = rawHash.toLowerCase();

  let taker: string | undefined;
  if (args.takerAddress !== undefined && args.takerAddress.trim() !== '') {
    const lowered = args.takerAddress.trim().toLowerCase();
    // The library takes forty hex characters with no `0x` in front as an
    // address. The database holds the prefix, so that form would match no row
    // and read as a wallet with no fills.
    if (!ADDRESS_PATTERN.test(lowered) || !isAddress(lowered)) {
      return refusal(['taker_address must be a wallet address: 0x followed by 40 hex characters.']);
    }
    taker = lowered;
  }

  const found = await fetchPublicCommitmentByHash(ctx.sb, ctx.network, hash, ctx.nowMs);
  if (found.error !== null) {
    logger.error({ err: found.error }, 'mcp: get_order_status quote read failed');
    return refusal([READ_FAILED]);
  }
  const quote = found.commitment;
  if (quote === null) {
    return answer([`Ospex has no quote with the hash ${hash}.`, 'Check that the whole hash was copied.']);
  }

  const fillsRead = await fetchFillRows(
    ctx.sb,
    ctx.network,
    { commitmentHash: hash, taker },
    { cursor: null, limit: MAX_FILLS },
  );
  if (fillsRead.error !== null) {
    logger.error({ err: fillsRead.error }, 'mcp: get_order_status fills read failed');
    return refusal([READ_FAILED]);
  }
  const fills = fillsRead.rows.map(fillRowToBody);

  let game: Game | undefined;
  if (quote.contestId !== null && ctx.scorers !== undefined) {
    const contestRead = await fetchContestListItem(ctx.sb, ctx.network, quote.contestId, ctx.scorers, false);
    if (!contestRead.ok) {
      logger.warn({ err: contestRead.message }, 'mcp: get_order_status contest read failed, game omitted');
    } else if (contestRead.contest !== null) {
      game = {
        teams: teamsOf(contestRead.contest),
        status: contestRead.contest.status,
        chainStartTime: contestRead.contest.chainStartTime,
        matchTime: contestRead.contest.matchTime,
      };
    }
  }

  const nowMicros = microsOf(ctx.nowMs);
  const expiryMicros = quote.expiry === null ? null : parseTimestampMicros(quote.expiry);

  // A withdrawn quote is served as "cancelled", which it is not on-chain: it
  // takes orders until it expires or its maker raises the nonce floor past it.
  // Keyed on the row's visibility, not on whether its body was redacted, so
  // the answer is the same when redaction is switched off.
  const withdrawn = quote.bookVisible === false && LIVE.has(quote.storedStatus);
  const status = !withdrawn
    ? quote.status
    : quote.nonceInvalidated
      ? 'cancelled'
      : expiryMicros === null || expiryMicros <= nowMicros
        ? 'expired'
        : 'withdrawn';
  const closed = CLOSED.has(status);
  /** Can still take an order, as far as the quote itself says. */
  const live = status === 'withdrawn' || LIVE.has(status);

  const out: string[] = [
    `Quote ${hash}`,
    status === 'withdrawn'
      ? 'Quote status: withdrawn from the book by its maker.'
      : `Quote status: ${STATUS_WORDS.get(status) ?? `${status}, which is not a status this tool knows`}.`,
  ];
  if (game !== undefined) out.push(`Game: ${matchupLabel(game.teams)} (contest_id ${quote.contestId ?? ''}).`);

  // A quote that was partly taken and then expired reads "expired", and one
  // that was partly taken and then cancelled reads "cancelled". The status
  // alone never says nothing was taken, so what was taken is stated whenever
  // the amounts can be read.
  const taken = /^\d+$/.test(quote.filledRiskAmount) ? BigInt(quote.filledRiskAmount) : 0n;
  if ('redacted' in quote) {
    out.push('Its maker withdrew it from the book, so its posted price and size are not shown.');
    out.push(`Taken from it so far: ${formatUsdcShort(taken)} USDC of what the maker put up.`);
  } else {
    if (/^\d+$/.test(quote.riskAmount)) {
      out.push(
        `Taken so far: ${formatUsdcShort(taken)} of the ${formatUsdcShort(BigInt(quote.riskAmount))} USDC the maker put up.`,
      );
    }
    if (
      game !== undefined &&
      quote.marketType !== null &&
      (quote.positionType === 0 || quote.positionType === 1) &&
      quote.lineTicks !== null
    ) {
      const takerSide = sideOf(quote.marketType, quote.positionType === 0 ? 1 : 0);
      out.push(`Side for the taker: ${backingLabel(quote.marketType, takerSide, quote.lineTicks, game.teams)}.`);
    }
    if (quote.oddsTick !== null && isValidOddsTick(quote.oddsTick)) {
      out.push(`Price for the taker: ${formatOddsTick(takerOddsTick(quote.oddsTick))}.`);
    }
    if (LIVE.has(status) && game !== undefined) out.push(whatIsLeft(quote, game, nowMicros));
  }
  // An expiry matters while a quote can take an order, and as the reason it
  // no longer can. On a quote that was filled or cancelled it is neither. It
  // is public for a withdrawn quote too, whose price, size and line are not.
  if (quote.expiry !== null && (live || status === 'expired')) {
    const at = formatEastern(quote.expiry) ?? quote.expiry;
    out.push(status === 'expired' ? `Expired ${at}.` : `Expires ${at}.`);
  }

  out.push('');
  const whose = taker === undefined ? 'on this quote' : `on this quote by ${taker}`;
  if (fills.length === 0) {
    out.push(
      closed
        ? `No fills ${whose}. The quote is ${status} and takes no more orders.`
        : live
          ? `No fills ${whose} yet.`
          : `No fills ${whose}.`,
    );
  } else {
    const more = fills.length >= MAX_FILLS ? ' (the first 1000; there may be more)' : '';
    out.push(
      taker === undefined
        ? `Fills on this quote, by every wallet that took it: ${String(fills.length)}${more}.`
        : `Fills ${whose}: ${String(fills.length)}${more}.`,
    );
    fills.forEach((fill, index) => out.push(renderFill(fill, index)));
    if (taker === undefined) {
      out.push(
        "These may be anyone's. Whether one person's order went through shows only with their wallet address as taker_address.",
      );
    }
  }
  out.push('');
  out.push(LAG_NOTE);
  return answer(out);
}
