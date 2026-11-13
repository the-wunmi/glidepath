import { z } from 'zod';

/**
 * Token amounts are integer base units (bigint). 10^36 is far above any real supply at 24 decimals
 * and keeps every product we form (amount × price × 10^decimals) inside the contract's U256 math.
 */
export const MAX_TOKEN_AMOUNT = 10n ** 36n;

/** Base units as a JSON string of digits, parsed to bigint. */
export const TokenAmount = z
  .preprocess((v) => (typeof v === 'bigint' ? v.toString() : v), z.string().regex(/^\d{1,37}$/))
  .transform((v) => BigInt(v))
  .refine((v) => v <= MAX_TOKEN_AMOUNT, {
    message: 'Amount is too large',
  }) as unknown as z.ZodType<bigint, bigint | string>;

/** Parse a decimal string ("1234.5") into base units without floating point. */
export function toBaseUnits(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid amount: ${value}`);
  const [, whole = '0', frac = ''] = match;
  if (frac.length > decimals) throw new Error(`Too many decimals (max ${decimals}): ${value}`);
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/** Base units to a decimal string, truncated to maxFraction digits, trailing zeros trimmed. */
export function fromBaseUnits(amount: bigint, decimals: number, maxFraction = decimals): string {
  const neg = amount < 0n;
  const s = (neg ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? s : s.slice(0, -decimals);
  const frac = (decimals === 0 ? '' : s.slice(-decimals).slice(0, maxFraction)).replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

/** Groups thousands for display: 1234567.5 → 1,234,567.5. */
export function formatAmount(amount: bigint, decimals: number, maxFraction = 2): string {
  const [whole = '0', frac] = fromBaseUnits(amount, decimals, maxFraction).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** amount × bps ÷ 10 000, rounded down so a budget derived from a percentage never overshoots. */
export const bpsOfDown = (amount: bigint, bps: number | bigint): bigint =>
  (amount * BigInt(bps)) / 10_000n;

/** USD prices are integer micro-dollars (e6), the same unit the contract's floor uses. */
export const USD_E6 = 1_000_000n;

export const UsdDecimal = z.string().regex(/^\d{1,9}(\.\d{1,6})?$/, 'Use a price like 1.50');

export const usdToE6 = (value: string): bigint => toBaseUnits(value, 6);
export const e6ToUsd = (value: bigint): string => fromBaseUnits(value, 6, 6);

/** Value in quote base units of amount token base units at priceE6, rounded down. */
export function quoteValueDown(
  amount: bigint,
  priceE6: bigint,
  tokenDecimals: number,
  quoteDecimals: number,
): bigint {
  return (
    (amount * priceE6 * 10n ** BigInt(quoteDecimals)) / (10n ** BigInt(tokenDecimals) * USD_E6)
  );
}

/** Implied price (e6) of selling amount for out, rounded down. */
export function impliedPriceE6(
  amount: bigint,
  out: bigint,
  tokenDecimals: number,
  quoteDecimals: number,
): bigint {
  if (amount === 0n) return 0n;
  return (out * 10n ** BigInt(tokenDecimals) * USD_E6) / (amount * 10n ** BigInt(quoteDecimals));
}

/**
 * The contract's floor test, reproduced exactly: min_out × 10^td × 10^6 ≥ amount × floor × 10^qd.
 * Shared so the enclave never builds a request the contract would refuse.
 */
export const meetsFloor = (
  amount: bigint,
  minOut: bigint,
  floorE6: bigint,
  tokenDecimals: number,
  quoteDecimals: number,
): boolean =>
  minOut * 10n ** BigInt(tokenDecimals) * USD_E6 >= amount * floorE6 * 10n ** BigInt(quoteDecimals);

export const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
