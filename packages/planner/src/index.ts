import {
  absDiff,
  type Compliance,
  type Envelope,
  impliedPriceE6,
  maxBig,
  meetsFloor,
  minBig,
  type PlanLimits,
  type PriceSourceName,
  planLimits,
  type SealedPlan,
} from '@glidepath/core';

/**
 * The enclave's private bookkeeping for one plan. It is sealed with the plan and never published;
 * the contract keeps its own public counters for the envelope.
 */
export interface PlanState {
  periodIndex: number;
  soldInPeriod: bigint;
  soldTotal: bigint;
  lastSaleMs: number | null;
  /** When the next sale may happen. Drawn at random, so nobody outside can predict it. */
  nextSaleAtMs: number;
}

/** Source of random bytes; the enclave passes crypto.getRandomValues, tests pass a fixed stream. */
export type RandomBytes = (n: number) => Uint8Array;

/** Uniform integer in [0, bound) by rejection sampling, so there is no modulo bias. */
export function randomBelow(bound: bigint, random: RandomBytes): bigint {
  if (bound <= 0n) throw new Error('Bound must be positive');
  const bytes = Math.ceil(bound.toString(16).length / 2) + 1;
  const space = 1n << BigInt(bytes * 8);
  const limit = space - (space % bound);
  for (;;) {
    let n = 0n;
    for (const b of random(bytes)) n = (n << 8n) | BigInt(b);
    if (n < limit) return n % bound;
  }
}

const randomBetween = (lo: bigint, hi: bigint, random: RandomBytes): bigint =>
  hi <= lo ? lo : lo + randomBelow(hi - lo + 1n, random);

export const periodIndexAt = (limits: PlanLimits, nowMs: number): number =>
  Math.floor((nowMs - limits.startMs) / limits.periodMs);

/** The first sale time: a random point in the first gap window after the start. */
export function initialState(plan: SealedPlan, random: RandomBytes): PlanState {
  const l = planLimits(plan);
  return {
    periodIndex: 0,
    soldInPeriod: 0n,
    soldTotal: 0n,
    lastSaleMs: null,
    nextSaleAtMs: l.startMs + Number(randomBetween(0n, BigInt(l.maxGapMs), random)),
  };
}

/** Draws the next sale time after now, between the plan's shortest and longest gap. */
export function scheduleAfter(plan: SealedPlan, nowMs: number, random: RandomBytes): number {
  const l = planLimits(plan);
  return nowMs + Number(randomBetween(BigInt(l.minGapMs), BigInt(l.maxGapMs), random));
}

/** The registry's public sale counters for a plan, as `get_plan` returns them. */
export interface ChainCounters {
  period_index: number;
  sold_in_period: string;
  sold_total: string;
  last_sale_ms: number | null;
}

/**
 * The state of a plan this enclave takes over from another build. The counters come from the
 * registry, which counts every build's sales; the next sale time is drawn afresh.
 */
export function handoverState(plan: SealedPlan, c: ChainCounters, random: RandomBytes): PlanState {
  const l = planLimits(plan);
  return {
    periodIndex: c.period_index,
    soldInPeriod: BigInt(c.sold_in_period),
    soldTotal: BigInt(c.sold_total),
    lastSaleMs: c.last_sale_ms,
    nextSaleAtMs:
      c.last_sale_ms === null
        ? l.startMs + Number(randomBetween(0n, BigInt(l.maxGapMs), random))
        : scheduleAfter(plan, c.last_sale_ms, random),
  };
}

export type Proposal =
  | { type: 'wait'; reason: WaitReason; untilMs: number | null }
  | { type: 'sell'; amount: bigint; periodIndex: number };

export type WaitReason =
  | 'not_started'
  | 'ended'
  | 'not_scheduled_yet'
  | 'period_budget_used'
  | 'allocation_used'
  | 'gap_too_short';

/**
 * Decides whether a sale is due now and how large it is. The amount is random between half the
 * per-sale cap and the cap, so sizes leak as little as timing. Both the sealed limits and the
 * public envelope apply; the contract re-checks the envelope.
 */
export function proposeSale(
  plan: SealedPlan,
  envelope: Envelope,
  state: PlanState,
  nowMs: number,
  balance: bigint,
  random: RandomBytes,
): Proposal {
  const l = planLimits(plan);
  if (nowMs < l.startMs) return { type: 'wait', reason: 'not_started', untilMs: l.startMs };
  if (nowMs >= l.endMs) return { type: 'wait', reason: 'ended', untilMs: null };
  if (nowMs < state.nextSaleAtMs)
    return { type: 'wait', reason: 'not_scheduled_yet', untilMs: state.nextSaleAtMs };
  const minGap = Math.max(l.minGapMs, envelope.min_gap_ms);
  if (state.lastSaleMs !== null && nowMs - state.lastSaleMs < minGap)
    return { type: 'wait', reason: 'gap_too_short', untilMs: state.lastSaleMs + minGap };

  const periodIndex = periodIndexAt(l, nowMs);
  const soldInPeriod = periodIndex === state.periodIndex ? state.soldInPeriod : 0n;
  const periodCap = minBig(l.perPeriod, envelope.max_amount_per_period);
  const left = minBig(periodCap - soldInPeriod, balance);
  if (balance <= 0n) return { type: 'wait', reason: 'allocation_used', untilMs: null };
  if (left <= 0n) {
    const nextPeriod = l.startMs + (periodIndex + 1) * l.periodMs;
    return { type: 'wait', reason: 'period_budget_used', untilMs: nextPeriod };
  }
  const saleCap = minBig(l.perTx, envelope.max_amount_per_tx);
  return { type: 'sell', amount: saleSize(saleCap, left, random), periodIndex };
}

/**
 * A random size in [cap/2, cap] that never leaves less than cap/2 behind in `left`. Drawing from
 * what is left alone would shrink each sale by half or more, a tail of dust sales that each cost a
 * run, a signature and gas. So a draw that would leave a remainder under the smallest sale takes
 * the remainder too when that fits one sale, and otherwise leaves exactly the smallest sale.
 */
export function saleSize(cap: bigint, left: bigint, random: RandomBytes): bigint {
  const smallest = maxBig(cap / 2n, 1n);
  const drawn = randomBetween(smallest, cap, random);
  if (left - drawn >= smallest) return drawn;
  return left <= cap ? left : left - smallest;
}

/** Records a confirmed sale and draws the next time. Only called once the contract accepted it. */
export function recordSale(
  plan: SealedPlan,
  state: PlanState,
  amount: bigint,
  periodIndex: number,
  nowMs: number,
  random: RandomBytes,
): PlanState {
  const sameperiod = periodIndex === state.periodIndex;
  return {
    periodIndex,
    soldInPeriod: (sameperiod ? state.soldInPeriod : 0n) + amount,
    soldTotal: state.soldTotal + amount,
    lastSaleMs: nowMs,
    nextSaleAtMs: scheduleAfter(plan, nowMs, random),
  };
}

/** Pushes the next attempt back after a refusal, without counting a sale. */
export const deferSale = (
  plan: SealedPlan,
  state: PlanState,
  nowMs: number,
  random: RandomBytes,
): PlanState => ({ ...state, nextSaleAtMs: scheduleAfter(plan, nowMs, random) });

export interface PriceObservation {
  source: PriceSourceName;
  priceE6: bigint;
}

export interface QuoteView {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
}

export interface MarketCheck {
  ok: boolean;
  reasons: string[];
  /** The lowest independent price: the floor is checked against the least favourable view. */
  referencePriceE6: bigint;
  compliance: Compliance;
}

/**
 * Checks independent prices and a 1Click quote against the sealed plan. Every source the plan
 * names must answer; they must agree within the plan's tolerance of the median; the lowest price
 * and the quote's guaranteed output must both clear the floor; the quote's own slippage must be
 * within the plan's limit. Any failure means no sale.
 */
export function checkMarket(
  plan: SealedPlan,
  envelope: Envelope,
  amount: bigint,
  prices: PriceObservation[],
  quote: QuoteView,
  quoteDecimals: number,
): MarketCheck {
  const reasons: string[] = [];
  const d = plan.token.decimals;
  const l = planLimits(plan);
  const quotePrice = impliedPriceE6(amount, quote.amountOut, d, quoteDecimals);
  const observed: PriceObservation[] = plan.price_sources.flatMap((source) => {
    if (source === '1click_quote') return [{ source, priceE6: quotePrice }];
    const found = prices.find((p) => p.source === source);
    if (!found) reasons.push(`No price from ${source}`);
    return found ? [found] : [];
  });

  const sorted = observed.map((p) => p.priceE6).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0n) : 0n;
  const reference = sorted[0] ?? 0n;
  const pricesAgree =
    median > 0n &&
    observed.every(
      (p) => absDiff(p.priceE6, median) * 10_000n <= median * BigInt(plan.price_agreement_bps),
    );
  if (!pricesAgree) reasons.push('Price sources disagree');

  const floor = maxBig(l.floorE6, envelope.min_price_usd_e6);
  const aboveFloor =
    reference >= floor && meetsFloor(amount, quote.minAmountOut, floor, d, quoteDecimals);
  if (!aboveFloor) reasons.push('Price is below the floor');

  // 1Click rounds minAmountOut down, so compare with the plan's minimum rounded the same way.
  const lowestAllowedOut = (quote.amountOut * (10_000n - BigInt(plan.max_slippage_bps))) / 10_000n;
  const slippageOk =
    quote.amountIn === amount && quote.minAmountOut > 0n && quote.minAmountOut >= lowestAllowedOut;
  if (!slippageOk) reasons.push('Quote does not match the sale or allows too much slippage');

  const compliance: Compliance = {
    within_period_budget: true,
    within_tx_cap: amount <= minBig(l.perTx, envelope.max_amount_per_tx),
    above_floor: aboveFloor,
    venue_allowed: plan.venues.includes('1click'),
    prices_agree: pricesAgree && slippageOk,
    schedule_ok: true,
  };
  return { ok: reasons.length === 0, reasons, referencePriceE6: reference, compliance };
}
