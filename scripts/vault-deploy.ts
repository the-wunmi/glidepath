/**
 * Deploys the Bitcoin vault contract (contracts/btc-vault, prototype) to NEAR testnet. Mainnet is
 * refused. Without --confirm it only checks the account and prints what it would spend.
 *
 *   pnpm vault:deploy              # dry run: balance, floor, cost, the account it would create
 *   pnpm vault:deploy --confirm    # create <VAULT_CONTRACT_NAME>.<DEPLOY_ACCOUNT_ID>, keyless
 *
 * Steps: create the account with the vault code, initialise it against the real Chain Signatures
 * signer, delete its key and check it has none, then write deployments/vault-testnet.json (no
 * secrets). The deployer must keep DEPLOY_MIN_BALANCE_NEAR after every step, as with
 * deploy-testnet.ts. Rehearse the whole flow first on a local sandbox: `pnpm vault:demo --local`.
 */
import { type KeyPairString, NearClient } from '@glidepath/near';
import { z } from 'zod';
import {
  deployVault,
  mpcRootKey,
  NEAR,
  near3,
  readDeployment,
  step,
  vaultConfig,
  vaultWasm,
  wasmSha256,
  writeDeployment,
} from './lib/vault.ts';

const Env = z.object({
  DEPLOY_NEAR_RPC_URL: z.string().url().default('https://test.rpc.fastnear.com'),
  DEPLOY_ACCOUNT_ID: z
    .string()
    .regex(/\.testnet$/, 'Use a .testnet account; mainnet is out of scope'),
  DEPLOY_PRIVATE_KEY: z.string().startsWith('ed25519:'),
  /** Real Chain Signatures signer on testnet. */
  DEPLOY_SIGNER_ACCOUNT_ID: z.string().default('v1.signer-prod.testnet'),
  /** Stop before any step that would leave the deployer below this (the account is shared). */
  DEPLOY_MIN_BALANCE_NEAR: z.coerce.number().default(27),
  VAULT_CONTRACT_NAME: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/)
    .default('btc-vault'),
  /**
   * The shortest delay any vault on this contract may choose. Five minutes keeps the testnet demo
   * watchable; a vault guarding real savings would use days. The contract refuses under a minute.
   */
  VAULT_MIN_DELAY_MS: z.coerce.number().int().min(60_000).default(300_000),
  /**
   * NEAR sent to the contract account: its code's storage (1 byte = 10^19 yocto) plus headroom.
   * Vault creators and callers pay for the storage they add.
   */
  VAULT_FUNDING_NEAR: z.coerce.bigint().default(3n),
});

async function main() {
  const env = Env.parse(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== '')),
  );
  const confirmed = process.argv.includes('--confirm');
  const near = new NearClient(env.DEPLOY_NEAR_RPC_URL);
  const contractId = `${env.VAULT_CONTRACT_NAME}.${env.DEPLOY_ACCOUNT_ID}`;
  const codeBytes = BigInt(vaultWasm().length);
  const funding = env.VAULT_FUNDING_NEAR * NEAR;
  if (funding < codeBytes * 10n ** 19n + NEAR / 10n)
    throw new Error(`VAULT_FUNDING_NEAR must cover the code's ${codeBytes} bytes of storage`);
  // Funding plus gas for two transactions, rounded well up.
  const cost = funding + NEAR / 20n;
  const floor = BigInt(Math.round(env.DEPLOY_MIN_BALANCE_NEAR * 1000)) * (NEAR / 1000n);

  step(`Checking ${env.DEPLOY_ACCOUNT_ID}`);
  const existing = readDeployment('testnet');
  if (existing)
    throw new Error(`deployments/vault-testnet.json already names ${existing.contract}`);
  if (await near.accountExists(contractId))
    throw new Error(`${contractId} already exists; choose another VAULT_CONTRACT_NAME`);
  const balance = BigInt((await near.accountState(env.DEPLOY_ACCOUNT_ID)).amount);
  console.log(
    `  balance ${near3(balance)} NEAR; the deployment needs about ${near3(cost)} (${near3(funding)} to the contract for ${codeBytes} bytes of code, the rest gas)`,
  );
  if (balance - cost < floor)
    throw new Error(
      `Deploying would leave ${env.DEPLOY_ACCOUNT_ID} with ${near3(balance - cost)} NEAR, under the ${env.DEPLOY_MIN_BALANCE_NEAR} NEAR floor`,
    );
  const rootKey = await mpcRootKey(near, env.DEPLOY_SIGNER_ACCOUNT_ID);
  console.log(`  signer ${env.DEPLOY_SIGNER_ACCOUNT_ID}, root key ${rootKey}`);
  console.log(`  would create ${contractId} (minimum delay ${env.VAULT_MIN_DELAY_MS / 1000} s)`);
  if (!confirmed) {
    console.log('\nDry run: nothing sent. Rerun with --confirm to deploy.');
    return;
  }

  step(`Creating ${contractId} with the vault code`);
  const deployer = near.account(env.DEPLOY_ACCOUNT_ID, env.DEPLOY_PRIVATE_KEY as KeyPairString);
  await deployVault(near, deployer, {
    contractId,
    signerId: env.DEPLOY_SIGNER_ACCOUNT_ID,
    minDelayMs: env.VAULT_MIN_DELAY_MS,
    funding,
  });
  const config = await vaultConfig(near, contractId);
  const after = BigInt((await near.accountState(env.DEPLOY_ACCOUNT_ID)).amount);
  writeDeployment('testnet', {
    network: 'testnet',
    deployed_at: new Date().toISOString(),
    rpc: env.DEPLOY_NEAR_RPC_URL,
    contract: contractId,
    signer_contract: config.signer_contract,
    mpc_root_public_key: rootKey,
    min_delay_ms: config.min_delay_ms,
    wasm_sha256: wasmSha256(),
    near_spent: near3(balance - after),
    vault: null,
  });
  console.log(
    `\nSpent ${near3(balance - after)} NEAR. Wrote deployments/vault-testnet.json. Next: pnpm vault:demo create`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
