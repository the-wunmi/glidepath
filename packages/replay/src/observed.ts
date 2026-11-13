import { DAY_MS } from './data.ts';
import {
  barsBetween,
  dailyQuoteVolume,
  dailyVolatility,
  maxDrawdown,
  priceAt,
  type Series,
} from './series.ts';

/**
 * What actually happened around a public unlock at time T (00:00 UTC on the unlock date). Returns
 * are simple fractions (-0.12 = -12%). "Excess" subtracts BTC's return over the same window, a rough
 * control for market-wide moves; it is not a full event-study abnormal return.
 */
export interface ObservedStats {
  prices: {
    t_minus_30d: number;
    t_minus_1d: number;
    t: number;
    t_plus_7d: number;
    t_plus_30d: number;
    t_plus_90d: number;
  };
  return_t_minus_30d_to_t_minus_1d: number;
  return_t_minus_1d_to_t_plus_7d: number;
  return_t_minus_1d_to_t_plus_30d: number;
  market_return_t_minus_30d_to_t_minus_1d: number;
  market_return_t_minus_1d_to_t_plus_7d: number;
  market_return_t_minus_1d_to_t_plus_30d: number;
  excess_return_t_minus_30d_to_t_minus_1d: number;
  excess_return_t_minus_1d_to_t_plus_7d: number;
  excess_return_t_minus_1d_to_t_plus_30d: number;
  /** Peak-to-trough fall of hourly closes from T-30d to T+30d. */
  max_drawdown_t_minus_30d_to_t_plus_30d: number;
  /** Lowest hourly close in [T, T+30d) relative to the T-1d price. */
  low_t_to_t_plus_30d_vs_t_minus_1d: number;
  avg_daily_quote_volume_usd_t_minus_30d_to_t: number;
  avg_daily_quote_volume_usd_t_to_t_plus_7d: number;
  /** Post-unlock week volume over pre-unlock month volume (Binance spot only). */
  volume_ratio_week_after_vs_month_before: number;
  daily_volatility_t_minus_30d_to_t: number;
}

const ret = (from: number, to: number) => to / from - 1;

function avgDailyVolume(series: Series, fromMs: number, toMs: number): number {
  const volumes = dailyQuoteVolume({ ...series, bars: barsBetween(series, fromMs, toMs) });
  const values = [...volumes.values()];
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function observedStats(token: Series, market: Series, unlockAtMs: number): ObservedStats {
  const at = (s: Series, days: number) => priceAt(s, unlockAtMs + days * DAY_MS);
  const prices = {
    t_minus_30d: at(token, -30),
    t_minus_1d: at(token, -1),
    t: at(token, 0),
    t_plus_7d: at(token, 7),
    t_plus_30d: at(token, 30),
    t_plus_90d: at(token, 90),
  };
  const pre = ret(prices.t_minus_30d, prices.t_minus_1d);
  const post7 = ret(prices.t_minus_1d, prices.t_plus_7d);
  const post30 = ret(prices.t_minus_1d, prices.t_plus_30d);
  const mPre = ret(at(market, -30), at(market, -1));
  const mPost7 = ret(at(market, -1), at(market, 7));
  const mPost30 = ret(at(market, -1), at(market, 30));
  const after = barsBetween(token, unlockAtMs, unlockAtMs + 30 * DAY_MS);
  const low = Math.min(...after.map((b) => b.close));
  const volPre = avgDailyVolume(token, unlockAtMs - 30 * DAY_MS, unlockAtMs);
  const volPost = avgDailyVolume(token, unlockAtMs, unlockAtMs + 7 * DAY_MS);
  return {
    prices,
    return_t_minus_30d_to_t_minus_1d: pre,
    return_t_minus_1d_to_t_plus_7d: post7,
    return_t_minus_1d_to_t_plus_30d: post30,
    market_return_t_minus_30d_to_t_minus_1d: mPre,
    market_return_t_minus_1d_to_t_plus_7d: mPost7,
    market_return_t_minus_1d_to_t_plus_30d: mPost30,
    excess_return_t_minus_30d_to_t_minus_1d: pre - mPre,
    excess_return_t_minus_1d_to_t_plus_7d: post7 - mPost7,
    excess_return_t_minus_1d_to_t_plus_30d: post30 - mPost30,
    max_drawdown_t_minus_30d_to_t_plus_30d: maxDrawdown(
      token,
      unlockAtMs - 30 * DAY_MS,
      unlockAtMs + 30 * DAY_MS,
    ),
    low_t_to_t_plus_30d_vs_t_minus_1d: ret(prices.t_minus_1d, low),
    avg_daily_quote_volume_usd_t_minus_30d_to_t: volPre,
    avg_daily_quote_volume_usd_t_to_t_plus_7d: volPost,
    volume_ratio_week_after_vs_month_before: volPost / volPre,
    daily_volatility_t_minus_30d_to_t: dailyVolatility(token, unlockAtMs - 30 * DAY_MS, unlockAtMs),
  };
}
