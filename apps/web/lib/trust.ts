'use client';

import type { SealedBox, SimulatedQuote } from '@vsp/core';
import type {
  ChainTrust,
  ChainTrustReceipt,
  TrustEnclaveEntry,
  TrustEnvelope,
  TrustQuoteSigner,
} from '@vsp/trust';
import { api } from './api';
import { accessKeys, nearChainTimeMs, nearView } from './chain';

/** GET /api/trusts/meta: where the blind trust prototype runs, its assets and enclave. */
export type TrustMeta =
  | { available: false }
  | {
      available: true;
      network: 'local' | 'testnet';
      contract: string;
      /** The persona that plays the official here; the mandate names it as beneficiary. */
      official: string;
      minCoolingOffMs: number;
      tokens: { asset: string; symbol: string; name: string; sector: string; decimals: number }[];
      enclave: {
        mode: 'mock' | 'live';
        signingKey: string;
        encryptionKeyHex: string;
        quote: SimulatedQuote | unknown;
        quoteHash: string;
        sameAsAttested: boolean;
      };
    };

export type AvailableTrustMeta = Extract<TrustMeta, { available: true }>;

export const trustMeta = () => api<TrustMeta>('/api/trusts/meta');
export const trustList = () =>
  api<{ id: number; label: string; status: ChainTrust['status'] }[]>('/api/trusts');
export const trustSummary = (id: number) =>
  api<{ id: number; label: string; totalValueUsdE6: string; valuedAtMs: number }>(
    `/api/trusts/${id}`,
  );

export interface CreateTrustBody {
  label: string;
  commitment: string;
  sealed_box: SealedBox;
  envelope: TrustEnvelope;
  cooling_off_ms: number;
  end_ms: number;
  deposits: { asset: string; tokens: string }[];
}

export const createTrust = (body: CreateTrustBody) =>
  api<{ trustId: number; txHash: string; ownerKey: string }>('/api/trusts', { body });

const keyName = (id: number) => `vsp:trust-key:${id}`;
export const saveTrustKey = (id: number, key: string) => localStorage.setItem(keyName(id), key);
export const loadTrustKey = (id: number) => localStorage.getItem(keyName(id));

/** The owner's public cancel; the key this browser kept at creation authorizes it. */
export async function cancelTrust(id: number, key: string): Promise<void> {
  const res = await fetch(`/api/trusts/${id}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plan-key': key },
    body: '{}',
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(err.message ?? `Cancel failed (${res.status})`);
  }
}

/**
 * Everything public about a trust, read from the chain in this browser through the read-only
 * proxy: the server is asked only for the label and the valuation.
 */
export async function readTrust(contract: string, id: number) {
  const [trust, receipts, enclaves, quoteSigners, chainNow] = await Promise.all([
    nearView<ChainTrust | null>(contract, 'get_trust', { trust_id: id }),
    nearView<ChainTrustReceipt[]>(contract, 'get_receipts', { trust_id: id, limit: 50 }),
    nearView<TrustEnclaveEntry[]>(contract, 'get_enclaves', { limit: 50 }),
    nearView<TrustQuoteSigner[]>(contract, 'get_quote_signers', { limit: 50 }),
    nearChainTimeMs(),
  ]);
  if (!trust) throw new Error(`Trust ${id} is not on ${contract}`);
  const keys = await accessKeys(trust.trust_account);
  return { trust, receipts, enclaves, quoteSigners, chainNow, accountKeys: keys.total };
}

export type TrustOnChain = Awaited<ReturnType<typeof readTrust>>;
