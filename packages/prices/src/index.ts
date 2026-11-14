import { type PriceSourceName, toBaseUnits } from '@glidepath/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

/** One independent price feed. Prices are integer micro-dollars (e6). */
export interface PriceSource {
  readonly name: Exclude<PriceSourceName, '1click_quote'>;
  readonly mode: 'mock' | 'live';
  priceE6(symbol: string, atMs: number): Promise<bigint>;
}

/**
 * The simulated market. Each asset has a base price; the market price wanders deterministically
 * around it (so tests and demos reproduce), and a source can be pushed away from the market to
 * rehearse manipulation. All of it is labelled simulation in the UI.
 */
export const MarketSettings = z.object({
  assets: z.record(z.string(), z.object({ basePriceE6: z.string().regex(/^\d+$/) })),
  /** Basis points added to one source's price, to rehearse a manipulated or broken feed. */
  sourceOffsetsBps: z.record(z.string(), z.int().min(-5000).max(5000)).default({}),
  /** How far the market wanders around the base price, in basis points. */
  volatilityBps: z.int().min(0).max(2000).default(150),
});
export type MarketSettings = z.output<typeof MarketSettings>;

/**
 * The simulated-market key for a token: its address, lowercase (a NEAR account or a 0x address),
 * so one plan's listing price can never move another token that shares its symbol. Settings
 * written before that are keyed by symbol, so a symbol that alone has a price still answers.
 */
export function marketKey(settings: MarketSettings, address: string, symbol: string): string {
  const key = address.toLowerCase();
  return !settings.assets[key] && settings.assets[symbol] ? symbol : key;
}

/** Ten-minute buckets give a price that moves during a demo but not between two reads. */
const BUCKET_MS = 600_000;

function hashInt(...parts: (string | number)[]): bigint {
  const digest = sha256(utf8ToBytes(parts.join('|')));
  let n = 0n;
  for (const b of digest.slice(0, 8)) n = (n << 8n) | BigInt(b);
  return n;
}

/** A value in [-range, range] fixed by its inputs. */
const signedNoise = (range: number, ...parts: (string | number)[]): bigint =>
  range === 0 ? 0n : (hashInt(...parts) % BigInt(2 * range + 1)) - BigInt(range);

/** The market price at a time: linear between bucket points, integer math only. */
export function marketPriceE6(settings: MarketSettings, key: string, atMs: number): bigint {
  const asset = settings.assets[key];
  if (!asset) throw new Error(`No simulated market for ${key}`);
  const base = BigInt(asset.basePriceE6);
  const k = Math.floor(atMs / BUCKET_MS);
  const a = signedNoise(settings.volatilityBps, key, k);
  const b = signedNoise(settings.volatilityBps, key, k + 1);
  const frac = BigInt(atMs - k * BUCKET_MS);
  const bps = a + ((b - a) * frac) / BigInt(BUCKET_MS);
  return (base * (10_000n + bps)) / 10_000n;
}

/** Each simulated exchange sees the market with a little of its own noise, plus any offset. */
export function simulatedSourcePriceE6(
  settings: MarketSettings,
  source: string,
  key: string,
  atMs: number,
): bigint {
  const market = marketPriceE6(settings, key, atMs);
  const jitter = signedNoise(5, source, key, Math.floor(atMs / 60_000));
  const offset = BigInt(settings.sourceOffsetsBps[source] ?? 0);
  return (market * (10_000n + jitter + offset)) / 10_000n;
}

export class SimulatedPriceSource implements PriceSource {
  readonly mode = 'mock' as const;
  constructor(
    readonly name: PriceSource['name'],
    private readonly settings: () => Promise<MarketSettings>,
  ) {}

  /** `key` is the token's market key (`marketKey`), not its symbol. */
  async priceE6(key: string, atMs: number): Promise<bigint> {
    return simulatedSourcePriceE6(await this.settings(), this.name, key, atMs);
  }
}

/** Public endpoints answer in a second or two; a slow source must not stall a sale decision. */
const LIVE_TIMEOUT_MS = 5_000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** Binance public ticker (no key): GET /api/v3/ticker/price?symbol=<SYM>USDT. */
export class BinancePriceSource implements PriceSource {
  readonly name = 'binance' as const;
  readonly mode = 'live' as const;
  constructor(private readonly baseUrl = 'https://api.binance.com') {}

  async priceE6(symbol: string): Promise<bigint> {
    const body = z
      .object({ price: z.string() })
      .parse(await getJson(`${this.baseUrl}/api/v3/ticker/price?symbol=${symbol}USDT`));
    return toBaseUnits(trimDecimals(body.price, 6), 6);
  }
}

/** Coinbase public spot price (no key): GET /v2/prices/<SYM>-USD/spot. */
export class CoinbasePriceSource implements PriceSource {
  readonly name = 'coinbase' as const;
  readonly mode = 'live' as const;
  constructor(private readonly baseUrl = 'https://api.coinbase.com') {}

  async priceE6(symbol: string): Promise<bigint> {
    const body = z
      .object({ data: z.object({ amount: z.string() }) })
      .parse(await getJson(`${this.baseUrl}/v2/prices/${symbol}-USD/spot`));
    return toBaseUnits(trimDecimals(body.data.amount, 6), 6);
  }
}

/** Truncates a decimal string to n fraction digits (rounding down, never up). */
function trimDecimals(value: string, n: number): string {
  const [whole, frac = ''] = value.split('.');
  return frac ? `${whole}.${frac.slice(0, n)}` : (whole ?? '0');
}

/**
 * A feed that is live for listed tokens and simulated for the rest: `pairs` maps our symbol to the
 * exchange's base symbol (wNEAR → NEAR). A demo token has no market, so it is priced on the
 * simulated market, and the UI says so; matching by a guessed symbol could price a demo token as an
 * unrelated listed coin, so only the configured pairs go live.
 */
export class ListedPriceSource implements PriceSource {
  readonly name: PriceSource['name'];
  readonly mode = 'live' as const;
  constructor(
    private readonly live: PriceSource,
    private readonly simulated: PriceSource,
    private readonly pairs: Map<string, string>,
  ) {
    this.name = live.name;
  }

  isLive(symbol: string): boolean {
    return this.pairs.has(symbol);
  }

  /** A listed symbol is priced live; anything else is a simulated-market key. */
  priceE6(symbolOrKey: string, atMs: number): Promise<bigint> {
    const pair = this.pairs.get(symbolOrKey);
    return pair ? this.live.priceE6(pair, atMs) : this.simulated.priceE6(symbolOrKey, atMs);
  }
}
