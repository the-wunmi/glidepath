import { ONECLICK_LIVE_QUOTE_KEY } from '@vsp/core';
import type { Engine } from './context.ts';

/** wNEAR to USDC on NEAR mainnet, 1 wNEAR: a pair 1Click always quotes. */
const REFERENCE_REQUEST = {
  dry: true,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: 'nep141:wrap.near',
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  amount: (10n ** 24n).toString(),
  // 1Click wants existing mainnet accounts here; a dry quote opens no deposit address.
  refundTo: 'aurora',
  refundType: 'ORIGIN_CHAIN',
  recipient: 'aurora',
  recipientType: 'DESTINATION_CHAIN',
} as const;

/** Each page view would otherwise ask 1Click again. */
const CACHE_MS = 120_000;
let cached: { at: number; value: ReferenceQuote } | null = null;

export interface ReferenceQuote {
  /** The raw answer, untouched: its signature covers the exact fields 1Click sent. */
  response: unknown;
  signerKey: string;
  fetchedAt: string;
}

/**
 * A live, signed 1Click quote that no plan uses. 1Click has no testnet, so sales settle through
 * the simulator; this shows the real service's quote format and signing key, which the enclave
 * and the verifier check, against a real answer.
 */
export async function referenceQuote(e: Engine): Promise<ReferenceQuote> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  const res = await fetch(`${e.config.ONECLICK_BASE_URL}/v0/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...REFERENCE_REQUEST, deadline }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`1Click answered ${res.status}`);
  const value = {
    response: await res.json(),
    signerKey: ONECLICK_LIVE_QUOTE_KEY,
    fetchedAt: new Date().toISOString(),
  };
  cached = { at: Date.now(), value };
  return value;
}
