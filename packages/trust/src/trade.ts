import {
  oneclickSignedBytes,
  parseNearKey,
  parseQuoteTerms,
  type QuoteTerms,
  usdToE12,
} from '@glidepath/core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { remainingTurnoverE6 } from './decide.ts';
import type { TrustMandate } from './mandate.ts';
import {
  type ChainTrust,
  TRUST_COST_MAX_BPS,
  TRUST_MAX_SLIPPAGE_BPS,
  TRUST_MIN_TRADE_USD_E6,
  TRUST_QUOTE_DEADLINE_MS,
  type TradeAttestation,
} from './messages.ts';

/** A trade the enclave decided and is waiting to see quoted. */
export interface PendingTrade {
  seq: number;
  origin: string;
  destination: string;
  amount: string;
  decided_at_ms: number;
}

/** The 1Click quote request for a decided trade: proceeds and refunds go to the trust account. */
export function tradeQuoteRequest(chain: ChainTrust, pending: PendingTrade, nowMs: number) {
  return {
    dry: false,
    swapType: 'EXACT_INPUT' as const,
    slippageTolerance: TRUST_MAX_SLIPPAGE_BPS,
    originAsset: pending.origin,
    depositType: 'ORIGIN_CHAIN' as const,
    destinationAsset: pending.destination,
    amount: pending.amount,
    refundTo: chain.trust_account,
    refundType: 'ORIGIN_CHAIN' as const,
    recipient: chain.trust_account,
    recipientType: 'DESTINATION_CHAIN' as const,
    deadline: new Date(nowMs + TRUST_QUOTE_DEADLINE_MS).toISOString(),
  };
}

/**
 * The lowest `minAmountOut` the contract accepts for a quote's `amountOut`: 1% under it, rounded
 * down as 1Click rounds its own minimum down.
 */
export const slippageFloor = (amountOut: bigint): bigint =>
  (amountOut * BigInt(10_000 - TRUST_MAX_SLIPPAGE_BPS)) / 10_000n;

/**
 * The quote's deposit, refund and payout all happen on chain accounts: `INTENTS` types would leave
 * proceeds or refunds inside intents.near, out of the keyless trust account's reach.
 */
export function routesOnChain(quote: object): boolean {
  const q = quote as Record<string, unknown>;
  return (
    q.depositType === 'ORIGIN_CHAIN' &&
    q.refundType === 'ORIGIN_CHAIN' &&
    q.recipientType === 'DESTINATION_CHAIN'
  );
}

/** The contract's fee bound for trusts: cost ≤ 0.5% of the signed input value, no flat part. */
export function trustCostWithinBound(t: Pick<QuoteTerms, 'amountInUsd' | 'amountOutUsd'>): boolean {
  const inUsd = usdToE12(t.amountInUsd);
  const outUsd = usdToE12(t.amountOutUsd);
  const cost = inUsd > outUsd ? inUsd - outUsd : 0n;
  return cost * 10_000n <= inUsd * TRUST_COST_MAX_BPS;
}

/** The turnover a quote counts on-chain: its signed `amountInUsd`, rounded up to USD × 10^6. */
export const quoteTurnoverE6 = (amountInUsd: string): bigint =>
  (usdToE12(amountInUsd) + 999_999n) / 1_000_000n;

/**
 * Whether a quote that came back through the host is genuine and is the one asked for. The
 * contract repeats every binding check; these reasons stay inside the enclave.
 */
export function tradeQuoteProblems(
  quoteSignerKey: string,
  chain: ChainTrust,
  pending: PendingTrade,
  quote: { payload: string; signature: string },
  nowMs: number,
): { problems: string[]; terms: QuoteTerms | null } {
  let signed = false;
  try {
    signed = ed25519.verify(
      parseNearKey(quote.signature).bytes,
      oneclickSignedBytes(quote.payload),
      parseNearKey(quoteSignerKey).bytes,
    );
  } catch {
    signed = false;
  }
  let q: QuoteTerms;
  try {
    q = parseQuoteTerms(quote.payload);
  } catch {
    return { problems: ['The quote could not be read'], terms: null };
  }
  const problems: string[] = [];
  if (!signed) problems.push('The quote is not signed by 1Click');
  if (q.dry !== false || q.swapType !== 'EXACT_INPUT')
    problems.push('The quote is not a live exact-input quote');
  if (!q.depositAddress) problems.push('1Click gave no deposit address');
  if (q.recipient !== chain.trust_account || q.refundTo !== chain.trust_account)
    problems.push('The quote pays or refunds outside the trust');
  if (q.originAsset !== pending.origin || q.destinationAsset !== pending.destination)
    problems.push('The quote is for a different pair');
  if (q.amountIn !== pending.amount || q.amount !== pending.amount)
    problems.push('The quote is for a different amount');
  if (!(Date.parse(q.deadline) > nowMs)) problems.push('The quote has expired');
  if (!routesOnChain(q)) problems.push('The quote routes through intents');
  try {
    if (!trustCostWithinBound(q)) problems.push('The quote costs more than the fee bound allows');
    if (quoteTurnoverE6(q.amountInUsd) < TRUST_MIN_TRADE_USD_E6)
      problems.push('The trade is under the smallest trade the contract takes');
    if (BigInt(q.minAmountOut) < slippageFloor(BigInt(q.amountOut)))
      problems.push('The quote allows too much slippage');
  } catch {
    problems.push('The quote could not be read');
  }
  return { problems, terms: q };
}

/** The enclave's yes/no statements about a quoted trade, each checked against the mandate. */
export function tradeAttestation(
  mandate: TrustMandate,
  chain: ChainTrust,
  pending: PendingTrade,
  amountInUsd: string,
  nowMs: number,
): TradeAttestation {
  const sector = mandate.universe.find((u) => u.asset === pending.destination)?.sector;
  const notExcluded =
    !chain.envelope.excluded_assets.includes(pending.destination) &&
    sector !== undefined &&
    !mandate.excluded_sectors.includes(sector);
  let withinTurnover = false;
  try {
    withinTurnover =
      quoteTurnoverE6(amountInUsd) <= remainingTurnoverE6(chain.envelope, chain, nowMs);
  } catch {
    withinTurnover = false;
  }
  return {
    within_mandate:
      pending.origin !== pending.destination &&
      mandate.targets.some((t) => t.asset === pending.destination),
    not_excluded: notExcluded,
    within_turnover: withinTurnover,
  };
}
