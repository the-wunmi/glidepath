import { usdToE6 } from '@vsp/core';
import type { TrustEnvelope, TrustMandate } from './mandate.ts';

/**
 * The enclave's rebalance decision: pure, integer-only, and reproduced case by case by the Rust
 * module (enclave-wasi/src/trust.rs, checked by `pnpm enclave:wasi`). Given what the trust holds,
 * prices, the sealed mandate and the public envelope, it picks at most one trade: from the most
 * overweight holding to the most underweight target, sized to close the smaller gap within the
 * mandate's and the envelope's limits. It never buys an asset that is not a target, is in an
 * excluded sector (targets never are), or is on the public exclusion list.
 */

export interface Holding {
  asset: string;
  /** Base units, as a decimal string. */
  amount: string;
  decimals: number;
}

export interface AssetPrice {
  asset: string;
  /** USD × 10^6 per whole token. */
  price_usd_e6: string;
}

/** The contract's public counters for the trust, as `get_trust` returns them. */
export interface TrustCounters {
  start_ms: number;
  period_index: number;
  turnover_in_period_usd_e6: string;
  last_trade_ms: number | null;
}

export interface DecideInput {
  mandate: TrustMandate;
  envelope: TrustEnvelope;
  counters: TrustCounters;
  holdings: Holding[];
  prices: AssetPrice[];
  now_ms: number;
}

export type HoldReason =
  | 'not_started'
  | 'min_gap'
  | 'turnover_used'
  | 'no_price'
  | 'no_value'
  | 'no_target'
  | 'within_bands'
  | 'too_small';

export type Decision =
  | { type: 'hold'; reason: HoldReason }
  | { type: 'trade'; origin: string; destination: string; amount: string; usd_e6: string };

/** Hold reasons the chain shows anyway; every other one would hint at the mandate. */
export const PUBLIC_HOLD_REASONS: readonly HoldReason[] = [
  'not_started',
  'min_gap',
  'turnover_used',
];

const hold = (reason: HoldReason): Decision => ({ type: 'hold', reason });
// biome-ignore lint/complexity/useMathMinMax: Math.min does not take bigints.
const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

/** Turnover still allowed in the current period, from the contract's counters. */
export function remainingTurnoverE6(
  envelope: TrustEnvelope,
  counters: TrustCounters,
  nowMs: number,
): bigint {
  if (nowMs < counters.start_ms) return 0n;
  const period = Math.floor((nowMs - counters.start_ms) / envelope.period_ms);
  const used = period === counters.period_index ? BigInt(counters.turnover_in_period_usd_e6) : 0n;
  const cap = BigInt(envelope.max_turnover_usd_e6);
  return cap > used ? cap - used : 0n;
}

export function decideRebalance(input: DecideInput): Decision {
  const { mandate, envelope, counters, now_ms: now } = input;
  if (now < counters.start_ms) return hold('not_started');
  if (counters.last_trade_ms !== null && now - counters.last_trade_ms < envelope.min_gap_ms)
    return hold('min_gap');
  const remaining = remainingTurnoverE6(envelope, counters, now);
  if (remaining === 0n) return hold('turnover_used');

  const prices = new Map(input.prices.map((p) => [p.asset, BigInt(p.price_usd_e6)]));
  const values = new Map<string, bigint>();
  const held = new Map<string, Holding>();
  for (const h of input.holdings) {
    const amount = BigInt(h.amount);
    if (amount === 0n) continue;
    const price = prices.get(h.asset);
    if (price === undefined) return hold('no_price');
    // Rounded down: a holding is never valued above what it is worth.
    values.set(h.asset, (values.get(h.asset) ?? 0n) + (amount * price) / 10n ** BigInt(h.decimals));
    held.set(h.asset, h);
  }
  const total = [...values.values()].reduce((a, b) => a + b, 0n);
  if (total === 0n) return hold('no_value');

  // A target the envelope now excludes counts as weight 0; the rest share the trust.
  const weights = new Map<string, bigint>();
  for (const t of mandate.targets)
    if (!envelope.excluded_assets.includes(t.asset)) weights.set(t.asset, BigInt(t.weight_bps));
  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0n);
  if (totalWeight === 0n) return hold('no_target');

  const band = (total * BigInt(mandate.band_bps)) / 10_000n;
  const assets = [...new Set([...values.keys(), ...weights.keys()])].sort(byCodeUnit);
  let triggered = false;
  let origin: { asset: string; over: bigint } | null = null;
  let destination: { asset: string; under: bigint } | null = null;
  for (const asset of assets) {
    const value = values.get(asset) ?? 0n;
    const weight = weights.get(asset) ?? 0n;
    const target = (total * weight) / totalWeight;
    const over = value > target ? value - target : 0n;
    const under = target > value ? target - value : 0n;
    // Anything held that is not a target (outside the universe, an excluded sector, publicly
    // excluded) is sold whatever the band.
    if ((weight === 0n && value > 0n) || over > band || under > band) triggered = true;
    if (over > 0n && (!origin || over > origin.over)) origin = { asset, over };
    if (weight > 0n && under > 0n && (!destination || under > destination.under))
      destination = { asset, under };
  }
  if (!triggered || !origin || !destination) return hold('within_bands');

  const usd = min(origin.over, destination.under, usdToE6(mandate.max_trade_usd), remaining);
  if (usd < usdToE6(mandate.min_trade_usd)) return hold('too_small');
  const source = held.get(origin.asset) as Holding;
  const price = prices.get(origin.asset) as bigint;
  // Rounded down: never sell more than the trade's value.
  const amount = min((usd * 10n ** BigInt(source.decimals)) / price, BigInt(source.amount));
  if (amount === 0n) return hold('too_small');
  return {
    type: 'trade',
    origin: origin.asset,
    destination: destination.asset,
    amount: amount.toString(),
    usd_e6: usd.toString(),
  };
}

/** UTF-16 code unit order, which Rust's byte order matches for the ASCII ids assets use. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
