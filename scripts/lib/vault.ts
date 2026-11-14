/**
 * Shared by scripts/vault-deploy.ts and scripts/vault-demo.ts: deploying the vault contract keyless,
 * its deployment record (deployments/vault-testnet.json, no secrets), reading its views, and the
 * local stand-in for the MPC network used by the rehearsals.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { SpendView, VaultConfig, VaultView } from '@vsp/btc';
import { deriveSecretKey, signPayload } from '@vsp/chainsig';
import {
  type Account,
  actions,
  KeyPair,
  type KeyPairString,
  type NearClient,
  teraToGas,
} from '@vsp/near';

export const NEAR = 10n ** 24n;
export const near3 = (y: bigint) => (Number(y / (NEAR / 1000n)) / 1000).toFixed(3);

export const vaultWasm = () =>
  new Uint8Array(readFileSync(new URL('../../contracts/res/btc_vault.wasm', import.meta.url)));

/** What a deployment leaves behind for the demo script, the API and the web page. */
export interface VaultDeployment {
  network: string;
  deployed_at: string;
  rpc: string;
  contract: string;
  signer_contract: string;
  mpc_root_public_key: string;
  min_delay_ms: number;
  wasm_sha256: string;
  near_spent: string;
  /** The vault the demo created and the page shows; null until `vault-demo create`. */
  vault: { id: number; owner: string; address: string; created_tx: string } | null;
}

/** Testnet's record is kept; a local one (git-ignored) describes a sandbox that is gone on restart. */
export const deploymentPath = (network: 'testnet' | 'local') =>
  new URL(
    network === 'testnet'
      ? '../../deployments/vault-testnet.json'
      : '../../deployments/local-vault.json',
    import.meta.url,
  );

export function readDeployment(network: 'testnet' | 'local'): VaultDeployment | null {
  const path = deploymentPath(network);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as VaultDeployment) : null;
}

export const writeDeployment = (network: 'testnet' | 'local', record: VaultDeployment) =>
  writeFileSync(deploymentPath(network), `${JSON.stringify(record, null, 2)}\n`);

export const step = (s: string) => console.log(`▸ ${s}`);

/** Throws with the contract's own error code, so a refusal reads as what the vault said. */
export async function must<T>(
  label: string,
  p: ReturnType<NearClient['send']>,
): Promise<{ txHash: string; value: T }> {
  const out = await p;
  if (!out.ok) throw new Error(`${label} refused: ${out.error}`);
  console.log(`  ✓ ${label}  (tx ${out.txHash})`);
  return { txHash: out.txHash, value: out.value as T };
}

/**
 * Creates `contractId` under the deployer with the vault code, initialises it against `signerId`,
 * then deletes its only key and checks from the chain that it has none: from then on nobody can
 * change the code, and the vault's Bitcoin address answers only to the contract's rules.
 */
export async function deployVault(
  near: NearClient,
  deployer: Account,
  opts: { contractId: string; signerId: string; minDelayMs: number; funding: bigint },
): Promise<void> {
  const key = KeyPair.fromRandom('ed25519');
  await must(
    'create and deploy the vault contract',
    near.send(deployer, opts.contractId, [
      actions.createAccount(),
      actions.transfer(opts.funding),
      actions.addFullAccessKey(key.getPublicKey()),
      actions.deployContract(vaultWasm()),
      actions.functionCall(
        'new',
        { signer_contract: opts.signerId, min_delay_ms: opts.minDelayMs },
        teraToGas(30),
        0n,
      ),
    ]),
  );
  step('Deleting the vault contract’s own key: from here on nobody can change its code');
  await must(
    'delete the contract key',
    near.send(near.account(opts.contractId, key.toString() as KeyPairString), opts.contractId, [
      actions.deleteKey(key.getPublicKey()),
    ]),
  );
  const keys = await near.accessKeyCount(opts.contractId);
  if (keys !== 0) throw new Error(`${opts.contractId} still has ${keys} access keys`);
  console.log(`  ✓ ${opts.contractId} has 0 access keys`);
}

export const wasmSha256 = () => createHash('sha256').update(vaultWasm()).digest('hex');

export const vaultConfig = (near: NearClient, contract: string) =>
  near.view<VaultConfig>(contract, 'get_config');

export async function getVault(near: NearClient, contract: string, id: number) {
  const vault = await near.view<VaultView | null>(contract, 'get_vault', { vault_id: id });
  if (!vault) throw new Error(`Vault ${id} not found on ${contract}`);
  return vault;
}

export async function getSpend(near: NearClient, contract: string, vaultId: number, id: number) {
  const spend = await near.view<SpendView | null>(contract, 'get_spend', {
    vault_id: vaultId,
    spend_id: id,
  });
  if (!spend) throw new Error(`Spend ${id} not found`);
  return spend;
}

/** The MPC root key the vault's address derives from, as the signer itself reports it. */
export const mpcRootKey = (near: NearClient, signerId: string) =>
  near
    .view<string>(signerId, 'public_key', { domain_id: 0 })
    .catch(() => near.view<string>(signerId, 'public_key', {}));

/**
 * Local rehearsals only: plays the MPC network for the signer simulator, signing every pending
 * request with the simulator's root secret plus the request's tweak. Returns a stop function.
 */
export function answerSignatures(
  near: NearClient,
  signerId: string,
  responder: Account,
  rootSecretHex: string,
): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const pending = await near
        .view<{ request: { tweak: string; payload: string; domain_id: number } }[]>(
          signerId,
          'pending_requests',
          {},
        )
        .catch(() => []);
      for (const { request } of pending) {
        const secret = deriveSecretKey(rootSecretHex, BigInt(`0x${request.tweak}`));
        const response = signPayload(secret, hexToBytes(request.payload));
        await near
          .call(responder, signerId, 'respond', { request, response }, { gasTera: 100 })
          .catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
