import { z } from 'zod';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Days of data fetched before the unlock: 30 for the pre-unlock window plus 5 for volatility warm-up. */
export const DAYS_BEFORE = 35;
/** Days fetched after the unlock: the 90-day plan window plus slack for the T+90d price. */
export const DAYS_AFTER = 95;

/** Binance prices and volumes stay decimal strings on disk so the files match what the API sent. */
const Decimal = z.string().regex(/^\d+(\.\d+)?$/);

/** One hourly Binance candle: open time (ms), OHLC, base volume and quote (USDT) volume. */
export const Candle = z.object({
  t: z.number().int(),
  o: Decimal,
  h: Decimal,
  l: Decimal,
  c: Decimal,
  v: Decimal,
  qv: Decimal,
});
export type Candle = z.infer<typeof Candle>;

/** A fetched kline file as written by scripts/replay-fetch.ts. */
export const KlineFile = z.object({
  symbol: z.string(),
  event_id: z.string(),
  source_url: z.url(),
  fallback_source_url: z.url(),
  fetched_at: z.iso.datetime(),
  interval: z.literal('1h'),
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  candles: z.array(Candle).min(1),
});
export type KlineFile = z.infer<typeof KlineFile>;

/** The window [start, end) of hourly data the study needs for an unlock on `unlockDate`. */
export function dataWindow(unlockDate: string): { startMs: number; endMs: number } {
  const t = unlockMs(unlockDate);
  return { startMs: t - DAYS_BEFORE * DAY_MS, endMs: t + DAYS_AFTER * DAY_MS };
}

/** Unlocks are dated, not timed; we take 00:00 UTC on the date as the unlock instant. */
export const unlockMs = (unlockDate: string): number => Date.parse(`${unlockDate}T00:00:00Z`);

export const fileName = (symbol: string, unlockDate: string): string =>
  `${symbol}-${unlockDate}.json`;

/** Hourly bar converted to numbers for analysis. */
export interface Bar {
  t: number;
  close: number;
  /** Binance's own hourly VWAP (quote volume / base volume); close when the hour had no trades. */
  vwap: number;
  quoteVolume: number;
}

/**
 * Converts candles to numeric bars sorted by time. Floats are fine here: this is statistical price
 * analysis on market data, not accounting of anyone's money.
 */
export function toBars(candles: Candle[]): Bar[] {
  return candles
    .map((c) => {
      const close = Number(c.c);
      const base = Number(c.v);
      const quote = Number(c.qv);
      return { t: c.t, close, vwap: base > 0 ? quote / base : close, quoteVolume: quote };
    })
    .sort((a, b) => a.t - b.t);
}
