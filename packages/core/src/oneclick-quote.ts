import { sha256 } from '@noble/hashes/sha2.js';
import { base58Encode, utf8ToBytes } from './encoding.ts';

/**
 * 1Click's quote signature, as 1Click signs it (verified against a live, non-dry quote on
 * 2026-11-11, and against 1Click's own published key). The signed message is the UTF-8 text of
 * base58(sha256(Q)), where Q is a stable-stringified object built from the echoed request, the
 * quote and the response timestamp. The signature is `ed25519:<base58>` under 1Click's key.
 *
 * The registry receives Q itself (it never rebuilds it), checks the signature, then parses Q and
 * binds its fields to the sale. So this module is the single place Q is built.
 */

/** 1Click's quote-signing key as published in its responses (base58 of the 32-byte key). */
export const ONECLICK_LIVE_QUOTE_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

const REQUEST_FIELDS = [
  'dry',
  'swapType',
  'slippageTolerance',
  'originAsset',
  'depositType',
  'destinationAsset',
  'amount',
  'refundTo',
  'refundType',
  'recipient',
  'recipientType',
  'deadline',
] as const;
const REQUEST_FIELDS_IF_SET = [
  'quoteWaitingTimeMs',
  'referral',
  'virtualChainRecipient',
  'virtualChainRefundRecipient',
  'customRecipientMsg',
] as const;
const QUOTE_FIELDS = [
  'amountIn',
  'amountInFormatted',
  'amountInUsd',
  'minAmountIn',
  'amountOut',
  'amountOutFormatted',
  'amountOutUsd',
  'minAmountOut',
] as const;
/** Only for non-dry quotes, only when truthy; the quote's own deadline replaces the request's. */
const LIVE_QUOTE_FIELDS_IF_SET = [
  'depositAddress',
  'depositMemo',
  'deadline',
  'timeWhenInactive',
  'timeEstimate',
  'refundFee',
  'withdrawFee',
] as const;

/** JSON with keys sorted at every level, no whitespace, undefined members dropped. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The parts of a 1Click quote response that Q is built from. */
export interface OneClickQuoteLike {
  timestamp: string;
  quoteRequest: Record<string, unknown>;
  quote: Record<string, unknown>;
}

/** Q: the exact string 1Click's signature covers (through base58(sha256(Q))). */
export function oneclickQuoteMessage(r: OneClickQuoteLike): string {
  const req = r.quoteRequest;
  const q = r.quote;
  const o: Record<string, unknown> = {};
  for (const k of REQUEST_FIELDS) o[k] = req[k];
  for (const k of REQUEST_FIELDS_IF_SET) if (req[k]) o[k] = req[k];
  for (const k of QUOTE_FIELDS) o[k] = q[k];
  if (req.dry !== true) for (const k of LIVE_QUOTE_FIELDS_IF_SET) if (q[k]) o[k] = q[k];
  o.timestamp = r.timestamp;
  return stableStringify(o);
}

/** The bytes the ed25519 signature is over: the UTF-8 text of base58(sha256(Q)). */
export const oneclickSignedBytes = (q: string): Uint8Array =>
  utf8ToBytes(base58Encode(sha256(utf8ToBytes(q))));

/** The fields of Q the registry binds, as it parses them. */
export interface QuoteTerms {
  dry: boolean;
  swapType: string;
  originAsset: string;
  destinationAsset: string;
  amount: string;
  amountIn: string;
  amountInUsd: string;
  amountOut: string;
  amountOutUsd: string;
  minAmountOut: string;
  refundTo: string;
  recipient: string;
  depositAddress?: string;
  /** ISO time: the quote's own deadline for non-dry quotes. */
  deadline: string;
}

export function parseQuoteTerms(q: string): QuoteTerms {
  return JSON.parse(q) as QuoteTerms;
}

/**
 * The most a quote may cost, measured on 1Click's own signed USD values:
 * amountInUsd − amountOutUsd ≤ amountInUsd × QUOTE_COST_MAX_BPS / 10 000 + QUOTE_COST_FLAT_USD.
 * 1Click charges 20 bps without a partner key (seen live) and about 1 bp with one, plus a
 * near-flat withdrawal fee (0.0046 USDC in the live fixture). 50 bps leaves room for that and a
 * normal solver spread (the live fixture cost 30 bps in all); a third-party `appFees` entry, which
 * the signature does not cover but which lowers amountOut, cannot take more than the remaining
 * room. The sealed floor still applies on top.
 */
export const QUOTE_COST_MAX_BPS = 50n;
/** $1.00 in units of 10^-12 USD, the flat part of the bound (withdrawal fees are near-flat). */
export const QUOTE_COST_FLAT_USD_E12 = 1_000_000_000_000n;

/** A decimal USD string ("3.650000000000") in units of 10^-12 USD, extra digits truncated. */
export function usdToE12(value: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`Invalid USD amount: ${value}`);
  const [, whole = '0', frac = ''] = m;
  return BigInt(whole + frac.slice(0, 12).padEnd(12, '0'));
}

/** Whether a quote's cost stays inside the bound above (the registry's `quote_fee_too_high`). */
export function quoteCostWithinBound(t: Pick<QuoteTerms, 'amountInUsd' | 'amountOutUsd'>): boolean {
  const inUsd = usdToE12(t.amountInUsd);
  const outUsd = usdToE12(t.amountOutUsd);
  const cost = inUsd > outUsd ? inUsd - outUsd : 0n;
  return cost * 10_000n <= inUsd * QUOTE_COST_MAX_BPS + QUOTE_COST_FLAT_USD_E12 * 10_000n;
}
