/**
 * `get_order_status` — where a posted quote stands, and who has taken it.
 *
 * A quote's status says whether it can still be taken. Its fills say what has
 * been taken from it, by whom, and in which transaction. A reader who just
 * confirmed a take looks for their own address among the fills.
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
 *
 * Three reads per call: the quote, its fills, and its contest for the names.
 * The third is for wording only, so its failure costs the names and nothing else.
 */

import { isAddress } from 'ethers';
import { logger } from '../../lib/logger.js';
import { HASH_PATTERN, fetchPublicCommitmentByHash } from '../../v1/commitments.js';
import { fetchContestListItem } from '../../v1/contests.js';
import { fetchFillRows, rowToBody as fillRowToBody, type FillBody } from '../../v1/fills.js';
import { READ_FAILED, answer, refusal, type ToolAnswer, type ToolContext } from '../context.js';
import { formatOddsTick, formatUsdcShort, isValidOddsTick, maxTakerRisk, takerOddsTick } from '../takeMath.js';
import { backingLabel, formatEastern, matchupLabel, sideOf, type Teams } from '../words.js';

export interface GetOrderStatusArgs {
  commitmentHash: string;
  takerAddress: string | undefined;
}

/** Fills one call reads. The server's own ceiling for one response. */
export const MAX_FILLS = 1000;

const LAG_NOTE =
  'A fill is listed once its block is final, usually within about 15 seconds of the transaction confirming.';

const STATUS_WORDS: Record<string, string> = {
  open: 'open: it can be taken',
  partially_filled: 'partially filled: part has been taken and the rest can be',
  filled: 'filled: all of it has been taken',
  cancelled: 'cancelled: it can no longer be taken',
  expired: 'expired: it can no longer be taken',
};

function renderFill(fill: FillBody, index: number): string {
  const price = isValidOddsTick(fill.oddsTick) ? ` at ${formatOddsTick(takerOddsTick(fill.oddsTick))}` : '';
  const when = formatEastern(fill.filledAt) ?? fill.filledAt;
  return (
    `${String(index + 1)}. ${fill.taker} risked ${formatUsdcShort(BigInt(fill.takerRiskAmount))} USDC ` +
    `to win ${formatUsdcShort(BigInt(fill.makerRiskAmount))}${price}, ${when}. Transaction ${fill.txHash}`
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
    if (!isAddress(lowered)) {
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

  // Names only. Without them the answer is still right, just harder to read.
  let teams: Teams | undefined;
  if (quote.contestId !== null && ctx.scorers !== undefined) {
    const contestRead = await fetchContestListItem(ctx.sb, ctx.network, quote.contestId, ctx.scorers, false);
    if (!contestRead.ok) {
      logger.warn({ err: contestRead.message }, 'mcp: get_order_status contest read failed, names omitted');
    } else if (contestRead.contest !== null) {
      teams = { away: contestRead.contest.awayTeam, home: contestRead.contest.homeTeam };
    }
  }

  const out: string[] = [`Quote ${hash}`, `Status: ${STATUS_WORDS[quote.status] ?? quote.status}.`];
  if (teams !== undefined) out.push(`Game: ${matchupLabel(teams)} (contest_id ${quote.contestId ?? ''}).`);

  // A quote that was partly taken and then expired reads "expired", and one
  // that was partly taken and then cancelled reads "cancelled". The status
  // alone never says nothing was taken, so what was taken is always stated.
  const taken = /^\d+$/.test(quote.filledRiskAmount) ? BigInt(quote.filledRiskAmount) : 0n;
  if ('redacted' in quote) {
    out.push('Its maker withdrew it from the book, so its price and size are not shown.');
    out.push(`Taken from it before that: ${formatUsdcShort(taken)} USDC of what the maker put up.`);
  } else {
    if (/^\d+$/.test(quote.riskAmount)) {
      out.push(
        `Taken so far: ${formatUsdcShort(taken)} of the ${formatUsdcShort(BigInt(quote.riskAmount))} USDC the maker put up.`,
      );
    }
    if (
      teams !== undefined &&
      quote.marketType !== null &&
      quote.positionType !== null &&
      quote.lineTicks !== null
    ) {
      const takerSide = sideOf(quote.marketType, quote.positionType === 0 ? 1 : 0);
      out.push(`Taking it backs: ${backingLabel(quote.marketType, takerSide, quote.lineTicks, teams)}.`);
    }
    if (quote.oddsTick !== null && isValidOddsTick(quote.oddsTick)) {
      out.push(`Price for the taker: ${formatOddsTick(takerOddsTick(quote.oddsTick))}.`);
      if (quote.status === 'open' || quote.status === 'partially_filled') {
        const left = maxTakerRisk(quote.oddsTick, BigInt(quote.remainingRiskAmount));
        out.push(`Still takeable: up to ${formatUsdcShort(left)} USDC of risk.`);
      }
    }
    if (quote.expiry !== null) {
      out.push(`${quote.status === 'expired' ? 'Expired' : 'Expires'} ${formatEastern(quote.expiry) ?? quote.expiry}.`);
    }
  }

  out.push('');
  const whose = taker === undefined ? 'on this quote' : `on this quote by ${taker}`;
  if (fills.length === 0) {
    out.push(`No fills ${whose} yet.`);
  } else {
    out.push(`Fills ${whose}: ${String(fills.length)}${fills.length >= MAX_FILLS ? ' (the first 1000; there may be more)' : ''}.`);
    fills.forEach((fill, index) => out.push(renderFill(fill, index)));
  }
  out.push('');
  out.push(LAG_NOTE);
  return answer(out);
}
