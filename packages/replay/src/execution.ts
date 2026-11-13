import { type ImpactModel, impactFraction } from './impact.ts';
import { type Rng, randomIndex } from './random.ts';
import { dayOf, type Series } from './series.ts';

/** One planned sale: the hour it happens in (open time, ms) and how many whole tokens it sells. */
export interface Sale {
  t: number;
  quantity: bigint;
}

/**
 * Splits `quantity` evenly across `hours`. Token quantities are integers, so the remainder goes one
 * token at a time to the earliest hours; the total is exactly `quantity`.
 */
export function evenSchedule(hours: number[], quantity: bigint): Sale[] {
  if (hours.length === 0) throw new Error('No hours to sell in');
  const n = BigInt(hours.length);
  const base = quantity / n; // rounds down; the remainder is handed out below
  const remainder = quantity % n;
  return hours.map((t, i) => ({ t, quantity: base + (BigInt(i) < remainder ? 1n : 0n) }));
}

/** Weight scale for random sale sizes: integer weights keep the split exact in bigint. */
const WEIGHT_SCALE = 1_000_000;

/**
 * A sealed plan's execution: `sales` sales at hours drawn uniformly from `hours`, each sized by a
 * random weight in [0.5, 1.5) of the average. Sizes are floored and the remainder is added to the
 * last sale, so the plan sells exactly `quantity`, never more.
 */
export function randomSchedule(hours: number[], quantity: bigint, sales: number, rng: Rng): Sale[] {
  if (hours.length === 0 || sales < 1) throw new Error('Need hours and at least one sale');
  const times = Array.from(
    { length: sales },
    () => hours[randomIndex(hours.length, rng)] as number,
  );
  times.sort((a, b) => a - b);
  const weights = times.map(() => BigInt(Math.floor((0.5 + rng()) * WEIGHT_SCALE)));
  const total = weights.reduce((s, w) => s + w, 0n);
  const sized = times.map((t, i) => ({ t, quantity: (quantity * (weights[i] as bigint)) / total }));
  const sold = sized.reduce((s, x) => s + x.quantity, 0n);
  const last = sized[sized.length - 1] as Sale;
  last.quantity += quantity - sold;
  return sized;
}

/** Result of running a schedule against historical prices and the impact model. */
export interface ExecutionResult {
  quantity: bigint;
  /** Proceeds at Binance's hourly VWAP with no impact: observed prices only. */
  gross_usd: number;
  /** Modelled cost of the seller's own price impact. */
  impact_cost_usd: number;
  net_usd: number;
  /** Impact cost as basis points of gross proceeds. */
  impact_bps: number;
  avg_price_usd: number;
  /** Highest share of a day's Binance quote volume the seller would have been. */
  max_daily_participation: number;
  sale_count: number;
  active_days: number;
}

/**
 * Prices each sale at the VWAP of its hour, groups sales by UTC day, and charges each day's total as
 * one square-root-impact metaorder against that day's Binance quote volume. Floats are acceptable:
 * this estimates proceeds for analysis; no money is accounted with these numbers.
 */
export function execute(
  schedule: Sale[],
  token: Series,
  dailyVolume: Map<number, number>,
  model: ImpactModel,
): ExecutionResult {
  const perDay = new Map<number, number>();
  let gross = 0;
  let quantity = 0n;
  for (const sale of schedule) {
    const bar = token.byTime.get(sale.t);
    if (!bar) throw new Error(`No candle at ${new Date(sale.t).toISOString()}`);
    const notional = Number(sale.quantity) * bar.vwap;
    gross += notional;
    quantity += sale.quantity;
    perDay.set(dayOf(sale.t), (perDay.get(dayOf(sale.t)) ?? 0) + notional);
  }
  let impact = 0;
  let maxParticipation = 0;
  for (const [day, notional] of perDay) {
    const volume = dailyVolume.get(day) ?? 0;
    impact += notional * impactFraction(model, notional, volume);
    maxParticipation = Math.max(maxParticipation, volume > 0 ? notional / volume : 1);
  }
  return {
    quantity,
    gross_usd: gross,
    impact_cost_usd: impact,
    net_usd: gross - impact,
    impact_bps: gross > 0 ? (impact / gross) * 10_000 : 0,
    avg_price_usd: quantity > 0n ? gross / Number(quantity) : 0,
    max_daily_participation: maxParticipation,
    sale_count: schedule.length,
    active_days: perDay.size,
  };
}
