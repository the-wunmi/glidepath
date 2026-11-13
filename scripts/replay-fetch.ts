/**
 * Fetches hourly Binance klines around each replayed unlock (and BTC for the same window, as the
 * market reference) and writes data/replay/<SYMBOL>-<date>.json. Keyless: Binance market data needs
 * no API key. Run with `pnpm replay`; then `pnpm --filter @vsp/replay build:results`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Candle,
  DAY_MS,
  dataWindow,
  fileName,
  HOUR_MS,
  KlineFile,
} from '../packages/replay/src/data.ts';
import { EVENTS, MARKET_SYMBOL } from '../packages/replay/src/events.ts';

const PRIMARY = 'https://api.binance.com/api/v3/klines';
const FALLBACK = 'https://data-api.binance.vision/api/v3/klines';
/** Binance's documented maximum rows per klines request. */
const PAGE_LIMIT = 1000;
/**
 * Each klines call costs weight 2 against a 6000/min budget; 250 ms between calls is at most 4
 * calls a second, about 8% of it, which is polite for a one-off fetch.
 */
const PAUSE_MS = 250;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'replay');

type RawKline = [number, string, string, string, string, string, number, string, ...unknown[]];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPage(base: string, symbol: string, startMs: number, endMs: number) {
  const url = `${base}?symbol=${symbol}&interval=1h&startTime=${startMs}&endTime=${endMs - 1}&limit=${PAGE_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return (await res.json()) as RawKline[];
}

/** Pages through [startMs, endMs) from one host. */
async function fetchRange(base: string, symbol: string, startMs: number, endMs: number) {
  const candles: Candle[] = [];
  let from = startMs;
  while (from < endMs) {
    const page = await getPage(base, symbol, from, endMs);
    await sleep(PAUSE_MS);
    if (page.length === 0) break;
    for (const k of page) {
      candles.push({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5], qv: k[7] });
    }
    const last = page[page.length - 1];
    if (!last) break;
    from = last[0] + HOUR_MS;
  }
  return candles;
}

async function fetchWithFallback(symbol: string, startMs: number, endMs: number) {
  try {
    return { source: PRIMARY, candles: await fetchRange(PRIMARY, symbol, startMs, endMs) };
  } catch (error) {
    // api.binance.com answers 451 in some regions; the market-data mirror serves the same rows.
    console.warn(`primary failed for ${symbol}: ${(error as Error).message}; using mirror`);
    return { source: FALLBACK, candles: await fetchRange(FALLBACK, symbol, startMs, endMs) };
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const event of EVENTS) {
    const { startMs, endMs } = dataWindow(event.unlock_date);
    for (const symbol of [event.symbol, MARKET_SYMBOL]) {
      const { source, candles } = await fetchWithFallback(symbol, startMs, endMs);
      const expected = (endMs - startMs) / HOUR_MS;
      const file = KlineFile.parse({
        symbol,
        event_id: event.id,
        source_url: `${source}?symbol=${symbol}&interval=1h&startTime=${startMs}&endTime=${endMs - 1}&limit=${PAGE_LIMIT}`,
        fallback_source_url: `${source === PRIMARY ? FALLBACK : PRIMARY}?symbol=${symbol}&interval=1h`,
        fetched_at: new Date().toISOString(),
        interval: '1h',
        start_ms: startMs,
        end_ms: endMs,
        candles,
      });
      const path = join(OUT_DIR, fileName(symbol, event.unlock_date));
      writeFileSync(path, `${JSON.stringify(file)}\n`);
      const days = ((endMs - startMs) / DAY_MS).toFixed(0);
      console.log(`${path}: ${candles.length}/${expected} hourly candles over ${days} days`);
    }
  }
}

await main();
