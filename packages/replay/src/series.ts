import { type Bar, DAY_MS, HOUR_MS } from './data.ts';
import { stdev } from './stats.ts';

/** Hourly bars indexed by open time, with the lookups the study needs. */
export interface Series {
  bars: Bar[];
  byTime: Map<number, Bar>;
}

export const toSeries = (bars: Bar[]): Series => ({
  bars,
  byTime: new Map(bars.map((b) => [b.t, b])),
});

/** The close of the hour that ends at `ms` (so `priceAt(T)` is the last price before T). */
export function priceAt(series: Series, ms: number): number {
  const bar = series.byTime.get(ms - HOUR_MS);
  if (!bar) throw new Error(`No candle ending at ${new Date(ms).toISOString()}`);
  return bar.close;
}

/** Bars whose open time is in [fromMs, toMs). */
export const barsBetween = (series: Series, fromMs: number, toMs: number): Bar[] =>
  series.bars.filter((b) => b.t >= fromMs && b.t < toMs);

/** UTC day start for a timestamp. */
export const dayOf = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** Total quote (USDT) volume traded on Binance per UTC day. */
export function dailyQuoteVolume(series: Series): Map<number, number> {
  const out = new Map<number, number>();
  for (const b of series.bars) out.set(dayOf(b.t), (out.get(dayOf(b.t)) ?? 0) + b.quoteVolume);
  return out;
}

/**
 * Daily volatility estimated from hourly log returns in [fromMs, toMs), scaled by sqrt(24). It is
 * measured before the unlock so the model uses only what a seller could have known in advance.
 */
export function dailyVolatility(series: Series, fromMs: number, toMs: number): number {
  const bars = barsBetween(series, fromMs, toMs);
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1] as Bar;
    const cur = bars[i] as Bar;
    returns.push(Math.log(cur.close / prev.close));
  }
  return stdev(returns) * Math.sqrt(24);
}

/** Largest peak-to-trough fall of hourly closes in [fromMs, toMs), as a negative fraction. */
export function maxDrawdown(series: Series, fromMs: number, toMs: number): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const b of barsBetween(series, fromMs, toMs)) {
    peak = Math.max(peak, b.close);
    worst = Math.min(worst, b.close / peak - 1);
  }
  return worst;
}
