'use client';

import { assembleSpend, type SpendView, type VaultView, vaultAddress } from '@vsp/btc';
import { api } from './api';
import { nearChainTimeMs, nearView } from './chain';

/** GET /api/vault: which vault contract and vault this server's network has, or null. */
export interface VaultDeployment {
  network: 'testnet' | 'local';
  contract: string;
  signer_contract: string;
  mpc_root_public_key: string;
  min_delay_ms: number;
  deployed_at: string;
  vault: { id: number; owner: string; address: string; created_tx: string } | null;
}

export const vaultDeployment = () =>
  api<{ deployment: VaultDeployment | null }>('/api/vault').then((r) => r.deployment);

/**
 * Read from the chain, never from the server's record: the record only names the contract.
 * `chainOffsetMs` is chain time minus this browser's clock: delays end in chain time, which can
 * differ from the visitor's clock (a local sandbox runs ahead after fast-forwards).
 */
export async function readVault(d: VaultDeployment, id: number) {
  const [vault, spends, chainNow, rootKey] = await Promise.all([
    nearView<VaultView | null>(d.contract, 'get_vault', { vault_id: id }),
    nearView<SpendView[]>(d.contract, 'list_spends', { vault_id: id, limit: 50 }),
    nearChainTimeMs(),
    signerRootKey(d.signer_contract),
  ]);
  if (!vault) throw new Error(`Vault ${id} is not on ${d.contract}`);
  return { vault, spends, rootKey, chainOffsetMs: chainNow - Date.now() };
}

/** The MPC root key as the signer contract itself reports it, not as this server says. */
const signerRootKey = (signer: string) =>
  nearView<string>(signer, 'public_key', { domain_id: 0 }).catch(() =>
    nearView<string>(signer, 'public_key', {}),
  );

/** True when the address the contract shows is the one the signer's root key gives for it. */
export const addressMatchesDerivation = (rootKey: string, contract: string, vault: VaultView) =>
  !!vault.address && vaultAddress(rootKey, contract, vault.path) === vault.address;

/**
 * For a signed spend: the transaction rebuilt in this browser from the contract's record, with
 * every MPC signature checked against the vault key. `error` says what failed.
 */
export function signedTransaction(spend: SpendView, publicKey: string | null) {
  if (spend.status !== 'signed' || !publicKey) return null;
  try {
    return { ok: true as const, ...assembleSpend(spend, publicKey) };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

/** "150,000 sats"; satoshi amounts arrive as decimal strings and stay integers. */
export const sats = (value: string | bigint) => `${BigInt(value).toLocaleString('en-US')} sats`;

/** "0.0015 BTC", by integer division: no floating point on amounts. */
export function btc(value: string | bigint): string {
  const v = BigInt(value);
  const whole = v / 100_000_000n;
  const frac = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} BTC`;
}
