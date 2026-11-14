import { formatAmount } from '@vsp/core';

export const DAY_MS = 86_400_000;

/** Significant digits shown for an amount too small for the usual decimals. */
const SMALL_DIGITS = 3;

/**
 * Base-unit string to a grouped decimal, e.g. "1,250,000.5". An amount below the usual decimals
 * shows its first significant digits, rounded down ("0.0000411"), so it never reads as nothing.
 */
export function tokens(amount: string | bigint | null | undefined, decimals: number, max = 2) {
  if (amount === null || amount === undefined) return '—';
  const v = typeof amount === 'bigint' ? amount : BigInt(amount);
  const out = formatAmount(v, decimals, max);
  if (v <= 0n || !/^0(\.0*)?$/.test(out)) return out;
  const leadingZeros = decimals - v.toString().length;
  return formatAmount(v, decimals, leadingZeros + SMALL_DIGITS);
}

/** USDC base units (6 decimals) with cents always shown: "32,404.50 USDC". */
export function usdc(amount: string | bigint) {
  const [whole = '0', frac = ''] = formatAmount(BigInt(amount), 6, 2).split('.');
  return `${whole}.${frac.padEnd(2, '0')} USDC`;
}

/** Micro-dollars (e6) to "$1.50": always at least cents, more only when the value has them. */
export function usdE6(value: string | bigint) {
  const [whole = '0', frac = ''] = formatAmount(BigInt(value), 6, 6).split('.');
  return `$${whole}.${frac.padEnd(2, '0')}`;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export const fmtDate = (ms: number | string) => dateFmt.format(new Date(ms));
export const fmtDateTime = (ms: number | string) => dateTimeFmt.format(new Date(ms));
export const fmtTime = (ms: number | string) => timeFmt.format(new Date(ms));

/** "29 days 23 h", "4 h 12 min", "38 s": the two largest units. */
export function duration(ms: number): string {
  if (ms <= 0) return '0 s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d} day${d === 1 ? '' : 's'}${h ? ` ${h} h` : ''}`;
  if (h > 0) return `${h} h${m ? ` ${m} min` : ''}`;
  if (m > 0) return `${m} min${sec ? ` ${sec} s` : ''}`;
  return `${sec} s`;
}

/** A period in words: 30 days, 12 hours, 10 minutes. */
export function periodWords(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} day${ms === DAY_MS ? '' : 's'}`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? '' : 's'}`;
  if (ms % 60_000 !== 0) {
    const sec = Math.round(ms / 1000);
    return `${sec} second${sec === 1 ? '' : 's'}`;
  }
  const m = ms / 60_000;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export function shortHash(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Percent of b that a is, to one decimal, without floats on the big values. */
export function pctOf(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  return Number((a * 1000n) / b) / 10;
}

export const pct = (fraction: number, digits = 1) =>
  `${fraction > 0 ? '+' : fraction < 0 ? '−' : ''}${Math.abs(fraction * 100).toFixed(digits)}%`;

export const bps = (value: number) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(Math.round(value)).toLocaleString('en-US')} bps`;

export const usdCompact = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
