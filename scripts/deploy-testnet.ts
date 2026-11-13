/**
 * Deploys the registry to NEAR testnet (or, with --local, rehearses the exact same steps against a
 * throwaway local sandbox). Mainnet is refused.
 *
 *   pnpm deploy:testnet            # reads DEPLOY_* from .env
 *   pnpm deploy:testnet --local    # dry run end to end on a local sandbox, then stops it
 *   pnpm deploy:testnet --register-enclave   # register this machine's current enclave on the
 *                                  # already deployed registry (governance only)
 *   pnpm deploy:testnet --publish-demo-token [--confirm]   # publish the demo token's code as a
 *                                  # global contract (~17 NEAR burnt) so NEAR-token launches
 *                                  # reference it; without --confirm it only prints the cost
 *
 * Steps: create the stand-in USDC `vusdc.<deployer>` unless DEPLOY_PROCEEDS_ASSET names another,
 * create <name>.<deployer> with the registry code, initialise it with the deployer as governance,
 * publish the plan-account code as a global contract, allowlist the proceeds asset, register this
 * machine's simulated enclave and the 1Click simulator's quote key (1Click has no testnet), then
 * delete the registry's own key so nobody can change it. Before every step that spends, the
 * deployer must keep DEPLOY_MIN_BALANCE_NEAR. Writes deployments/<network>.json (no secrets).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { nearSecpKey } from '@vsp/chainsig';
import { base58Encode } from '@vsp/core';
import {
  actions,
  KeyPair,
  type KeyPairString,
  NearClient,
  startNearSandbox,
  teraToGas,
} from '@vsp/near';
import { z } from 'zod';

const NEAR = 10n ** 24n;
const wasm = (name: string) =>
  readFileSync(new URL(`../contracts/res/${name}.wasm`, import.meta.url));

const Measurements = z.object({
  mrtd: z.string(),
  rtmr0: z.string(),
  rtmr1: z.string(),
  rtmr2: z.string(),
  rtmr3: z.string(),
});

const Env = z.object({
  DEPLOY_NEAR_RPC_URL: z.string().url().default('https://test.rpc.fastnear.com'),
  DEPLOY_ACCOUNT_ID: z
    .string()
    .regex(/\.testnet$/, 'Use a .testnet account; mainnet is out of scope'),
  DEPLOY_PRIVATE_KEY: z.string().startsWith('ed25519:'),
  DEPLOY_REGISTRY_NAME: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/)
    .default('vsp-registry'),
  /** Real Chain Signatures signer on testnet. */
  DEPLOY_SIGNER_ACCOUNT_ID: z.string().default('v1.signer-prod.testnet'),
  /**
   * The registry's minimum cooling-off, also the activation delay of new keys. A real deployment
   * would use 30 days; the testnet demo uses 10 minutes so a change can be watched to the end, and
   * the app says so.
   */
  DEPLOY_MIN_COOLING_OFF_MS: z.coerce.number().int().min(60_000).default(600_000),
  /** Empty: deploy the stand-in `vusdc.<deployer>` (no real USDC on testnet can be minted to). */
  DEPLOY_PROCEEDS_ASSET: z.string().optional(),
  DEPLOY_PROCEEDS_DECIMALS: z.coerce.number().int().min(0).max(24).default(6),
  DEPLOY_REGISTRY_FUNDING_NEAR: z.coerce.bigint().default(5n),
  /** Stop before any step that would leave the deployer below this (the account is shared). */
  DEPLOY_MIN_BALANCE_NEAR: z.coerce.number().default(27),
  DEPLOY_ENCLAVE_PUBLIC_KEY: z.string().optional(),
  DEPLOY_ENCLAVE_MEASUREMENTS: z.string().optional(),
  DEPLOY_ENCLAVE_QUOTE_HASH: z.string().optional(),
  /**
   * Empty means the 1Click simulator's key (.data/oneclick-sim.key): 1Click has no testnet, so a
   * testnet registry can only ever see simulated quotes. 1Click's real key is for mainnet.
   */
  DEPLOY_QUOTE_SIGNER_KEY: z.string().optional(),
});
type Env = z.output<typeof Env>;

const step = (s: string) => console.log(`▸ ${s}`);

async function deploy(env: Env, network: string) {
  const near = new NearClient(env.DEPLOY_NEAR_RPC_URL);
  const deployer = near.account(env.DEPLOY_ACCOUNT_ID, env.DEPLOY_PRIVATE_KEY as KeyPairString);
  const registryId = `${env.DEPLOY_REGISTRY_NAME}.${env.DEPLOY_ACCOUNT_ID}`;
  const must = async (label: string, p: ReturnType<NearClient['send']>) => {
    const out = await p;
    if (!out.ok) throw new Error(`${label} failed: ${out.error}`);
    console.log(`  ✓ ${label}  (tx ${out.txHash})`);
    return out;
  };

  // Global contract code costs 10x storage and is burnt; the rest is the registry's own storage.
  const planAccountWasm = wasm('plan_account');
  const globalCost = BigInt(planAccountWasm.length) * 10n * 10n ** 19n + NEAR;
  const tokenWasm = wasm('demo_token');
  // A token account needs its code's storage (1 byte = 10^19 yocto) and a little for balances.
  const tokenFunding = BigInt(tokenWasm.length) * 10n ** 19n + NEAR / 5n;
  const usdcId = `vusdc.${env.DEPLOY_ACCOUNT_ID}`;
  const proceedsAsset = env.DEPLOY_PROCEEDS_ASSET ?? `nep141:${usdcId}`;
  const createUsdc = !env.DEPLOY_PROCEEDS_ASSET && !(await near.accountExists(usdcId));
  const required =
    env.DEPLOY_REGISTRY_FUNDING_NEAR * NEAR + globalCost + (createUsdc ? tokenFunding : 0n) + NEAR;
  const floor = BigInt(Math.round(env.DEPLOY_MIN_BALANCE_NEAR * 1000)) * (NEAR / 1000n);
  const near3 = (y: bigint) => (Number(y / (NEAR / 1000n)) / 1000).toFixed(3);
  /** Refuses a step that would leave the deployer under the floor. */
  const guard = async (label: string, cost: bigint) => {
    const balance = BigInt((await near.accountState(env.DEPLOY_ACCOUNT_ID)).amount);
    if (balance - cost < floor)
      throw new Error(
        `${label} would leave ${env.DEPLOY_ACCOUNT_ID} with ${near3(balance - cost)} NEAR, under the ${env.DEPLOY_MIN_BALANCE_NEAR} NEAR floor`,
      );
    return balance;
  };
  step(`Checking ${env.DEPLOY_ACCOUNT_ID}`);
  const startBalance = await guard('The whole deployment', required);
  console.log(
    `  balance ${near3(startBalance)} NEAR; this deployment needs about ${near3(required)}`,
  );
  if (await near.accountExists(registryId))
    throw new Error(`${registryId} already exists; choose another DEPLOY_REGISTRY_NAME`);

  if (createUsdc) {
    step(`Creating the stand-in USDC ${usdcId} (6 decimals; the 1Click simulator mints payouts)`);
    await guard('Creating the stand-in USDC', tokenFunding);
    await must(
      'create stand-in USDC',
      near.send(deployer, usdcId, [
        actions.createAccount(),
        actions.transfer(tokenFunding),
        actions.deployContract(new Uint8Array(tokenWasm)),
        actions.functionCall(
          'new',
          {
            owner_id: env.DEPLOY_ACCOUNT_ID,
            metadata: {
              spec: 'ft-1.0.0',
              name: 'USD Coin stand-in (testnet, Glidepath)',
              symbol: 'vUSDC',
              decimals: 6,
            },
            allocations: [],
          },
          teraToGas(100),
          0n,
        ),
      ]),
    );
  }

  step(`Creating ${registryId} with the registry code`);
  await guard('Creating the registry', env.DEPLOY_REGISTRY_FUNDING_NEAR * NEAR);
  const registryKey = KeyPair.fromRandom('ed25519');
  await must(
    'create and deploy registry',
    near.send(deployer, registryId, [
      actions.createAccount(),
      actions.transfer(env.DEPLOY_REGISTRY_FUNDING_NEAR * NEAR),
      actions.addFullAccessKey(registryKey.getPublicKey()),
      actions.deployContract(new Uint8Array(wasm('plan_registry'))),
      actions.functionCall(
        'new',
        {
          governance: env.DEPLOY_ACCOUNT_ID,
          signer_contract: env.DEPLOY_SIGNER_ACCOUNT_ID,
          min_cooling_off_ms: env.DEPLOY_MIN_COOLING_OFF_MS,
          enclave_activation_delay_ms: env.DEPLOY_MIN_COOLING_OFF_MS,
        },
        teraToGas(50),
        0n,
      ),
    ]),
  );

  step('Publishing the plan-account code as a global contract (10× storage, burnt)');
  await guard('Publishing the plan-account code', globalCost);
  await must(
    'setup_plan_account_code',
    near.send(deployer, registryId, [
      actions.functionCall(
        'setup_plan_account_code',
        new Uint8Array(planAccountWasm),
        teraToGas(300),
        globalCost,
      ),
    ]),
  );

  step(`Allowlisting proceeds asset ${proceedsAsset}`);
  await must(
    'set_proceeds_asset',
    near.call(
      deployer,
      registryId,
      'set_proceeds_asset',
      {
        asset_id: proceedsAsset,
        decimals: env.DEPLOY_PROCEEDS_DECIMALS,
      },
      { deposit: NEAR / 10n },
    ),
  );

  if (
    env.DEPLOY_ENCLAVE_PUBLIC_KEY &&
    env.DEPLOY_ENCLAVE_MEASUREMENTS &&
    env.DEPLOY_ENCLAVE_QUOTE_HASH
  ) {
    step('Registering the enclave key (active after the public delay)');
    await must(
      'register_enclave',
      near.call(
        deployer,
        registryId,
        'register_enclave',
        {
          public_key: env.DEPLOY_ENCLAVE_PUBLIC_KEY,
          measurements: Measurements.parse(JSON.parse(env.DEPLOY_ENCLAVE_MEASUREMENTS)),
          quote_hash: env.DEPLOY_ENCLAVE_QUOTE_HASH,
        },
        { deposit: NEAR / 10n },
      ),
    );
  } else {
    console.log(
      '  – no enclave key given (DEPLOY_ENCLAVE_*); register one later with register_enclave',
    );
  }
  if (env.DEPLOY_QUOTE_SIGNER_KEY) {
    step('Registering the quote signer (active after the public delay)');
    await must(
      'set_quote_signer',
      near.call(deployer, registryId, 'set_quote_signer', {
        public_key: env.DEPLOY_QUOTE_SIGNER_KEY,
      }),
    );
  } else {
    console.log(
      '  – no quote signer given (DEPLOY_QUOTE_SIGNER_KEY); no sale can execute until one is set',
    );
  }

  step('Deleting the registry’s own key: from here on nobody can change its code');
  await must(
    'delete registry key',
    near.send(near.account(registryId, registryKey.toString() as KeyPairString), registryId, [
      actions.deleteKey(registryKey.getPublicKey()),
    ]),
  );

  step('Checking the result from the chain');
  const config = await near.view<Record<string, unknown>>(registryId, 'get_config');
  const keys = await near.accessKeyCount(registryId);
  if (keys !== 0) throw new Error(`${registryId} still has ${keys} access keys`);
  console.log(
    `  ✓ ${registryId}: 0 access keys, plan-account code ${String(config.plan_account_code_hash)}`,
  );

  // The MPC root key the plan addresses derive from, as the signer itself reports it.
  const mpcRootPublicKey = await near
    .view<string>(env.DEPLOY_SIGNER_ACCOUNT_ID, 'public_key', { domain_id: 0 })
    .catch(() => near.view<string>(env.DEPLOY_SIGNER_ACCOUNT_ID, 'public_key', {}));
  const endBalance = BigInt((await near.accountState(env.DEPLOY_ACCOUNT_ID)).amount);
  console.log(
    `  spent ${near3(startBalance - endBalance)} NEAR; ${env.DEPLOY_ACCOUNT_ID} now holds ${near3(endBalance)} NEAR`,
  );
  const record = {
    network,
    deployed_at: new Date().toISOString(),
    rpc: env.DEPLOY_NEAR_RPC_URL,
    registry: registryId,
    governance: env.DEPLOY_ACCOUNT_ID,
    signer_contract: env.DEPLOY_SIGNER_ACCOUNT_ID,
    mpc_root_public_key: mpcRootPublicKey,
    min_cooling_off_ms: env.DEPLOY_MIN_COOLING_OFF_MS,
    proceeds_asset: proceedsAsset,
    usdc: proceedsAsset.replace(/^nep141:/, ''),
    enclave_key: env.DEPLOY_ENCLAVE_PUBLIC_KEY ?? null,
    quote_signer: env.DEPLOY_QUOTE_SIGNER_KEY ?? null,
    near_spent: near3(startBalance - endBalance),
    plan_account_code_hash: config.plan_account_code_hash,
    sha256sums: readFileSync(new URL('../contracts/res/SHA256SUMS', import.meta.url), 'utf8'),
  };
  mkdirSync(new URL('../deployments/', import.meta.url), { recursive: true });
  writeFileSync(
    new URL(`../deployments/${network}.json`, import.meta.url),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.log(
    `\nWrote deployments/${network}.json. Set NEAR_NETWORK=testnet to run the app against it.`,
  );
}

/**
 * The same deployment against a local sandbox: a funded stand-in for the testnet account, the
 * signer simulator in place of v1.signer-prod.testnet, and throwaway enclave and quote keys.
 */
async function rehearseLocally() {
  step('Starting a throwaway local sandbox');
  const sandbox = await startNearSandbox();
  try {
    const near = new NearClient(sandbox.rpcUrl);
    const root = near.account(sandbox.rootAccount, sandbox.rootKey);
    const deployerKey = KeyPair.fromRandom('ed25519');
    const deployerId = `deployer.${sandbox.rootAccount}`;
    await near.send(root, deployerId, [
      actions.createAccount(),
      actions.transfer(50n * NEAR),
      actions.addFullAccessKey(deployerKey.getPublicKey()),
    ]);
    const signerId = `signer.${sandbox.rootAccount}`;
    const signerKey = KeyPair.fromRandom('ed25519');
    const rootPublic = nearSecpKey(
      secp256k1.Point.fromBytes(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false)),
    );
    await near.send(root, signerId, [
      actions.createAccount(),
      actions.transfer(10n * NEAR),
      actions.addFullAccessKey(signerKey.getPublicKey()),
      actions.deployContract(new Uint8Array(wasm('mpc_signer_sim'))),
      actions.functionCall(
        'new',
        { root_public_key: rootPublic, responder: signerId },
        teraToGas(30),
        0n,
      ),
    ]);
    const enclaveKey = KeyPair.fromRandom('ed25519');
    const quoteKey = KeyPair.fromRandom('ed25519');
    const hex96 = '0'.repeat(96);
    // The sandbox's accounts end in the root name, not .testnet; the check is relaxed only here.
    const env = Env.extend({ DEPLOY_ACCOUNT_ID: z.string() }).parse({
      DEPLOY_NEAR_RPC_URL: sandbox.rpcUrl,
      DEPLOY_ACCOUNT_ID: deployerId,
      DEPLOY_PRIVATE_KEY: deployerKey.toString(),
      DEPLOY_SIGNER_ACCOUNT_ID: signerId,
      DEPLOY_MIN_COOLING_OFF_MS: '600000',
      DEPLOY_ENCLAVE_PUBLIC_KEY: enclaveKey.getPublicKey().toString(),
      DEPLOY_ENCLAVE_MEASUREMENTS: JSON.stringify({
        mrtd: hex96,
        rtmr0: hex96,
        rtmr1: hex96,
        rtmr2: hex96,
        rtmr3: hex96,
      }),
      DEPLOY_ENCLAVE_QUOTE_HASH: '0'.repeat(64),
      DEPLOY_QUOTE_SIGNER_KEY: quoteKey.getPublicKey().toString(),
    });
    await deploy(env, 'local-rehearsal');
    await publishDemoToken(env, 'local-rehearsal', true);
  } finally {
    step('Stopping the local sandbox');
    await sandbox.stop();
  }
}

/**
 * This machine's simulated enclave (the identity the API will present) and the 1Click simulator's
 * quote key, so the testnet registry knows exactly the keys the app runs with.
 */
async function localKeys() {
  const { createDb, createPool } = await import('@vsp/db');
  const { identityOnlyEnclave, loadConfig, oneclickSimSecret, simulatorQuoteKey } = await import(
    '@vsp/engine'
  );
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  try {
    const identity = await identityOnlyEnclave(config, createDb(pool)).identity();
    return {
      DEPLOY_ENCLAVE_PUBLIC_KEY: identity.signingKey,
      DEPLOY_ENCLAVE_MEASUREMENTS: JSON.stringify(identity.quote.measurements),
      DEPLOY_ENCLAVE_QUOTE_HASH: identity.quoteHash,
      DEPLOY_QUOTE_SIGNER_KEY: simulatorQuoteKey(oneclickSimSecret(config.DATA_DIR)),
    };
  } finally {
    await pool.end();
  }
}

/**
 * Registers this machine's current simulated enclave on the deployed testnet registry (after its
 * measured code changed, or its hardware secret was rotated). Governance only; the key acts after
 * the registry's activation delay.
 */
async function registerEnclave() {
  const env = Env.parse({ ...(await localKeys()), ...stripEmpty(process.env) });
  const path = new URL('../deployments/testnet.json', import.meta.url);
  const record = JSON.parse(readFileSync(path, 'utf8')) as {
    registry: string;
    enclave_key: string;
  };
  const near = new NearClient(env.DEPLOY_NEAR_RPC_URL);
  const governance = near.account(env.DEPLOY_ACCOUNT_ID, env.DEPLOY_PRIVATE_KEY as KeyPairString);
  step(`Registering enclave ${env.DEPLOY_ENCLAVE_PUBLIC_KEY} on ${record.registry}`);
  const out = await near.call(
    governance,
    record.registry,
    'register_enclave',
    {
      public_key: env.DEPLOY_ENCLAVE_PUBLIC_KEY,
      measurements: Measurements.parse(JSON.parse(env.DEPLOY_ENCLAVE_MEASUREMENTS ?? '{}')),
      quote_hash: env.DEPLOY_ENCLAVE_QUOTE_HASH,
    },
    { deposit: NEAR / 10n },
  );
  if (!out.ok) throw new Error(`register_enclave failed: ${out.error}`);
  console.log(`  ✓ register_enclave  (tx ${out.txHash}); active after the activation delay`);
  record.enclave_key = env.DEPLOY_ENCLAVE_PUBLIC_KEY as string;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Publishes the demo token's code once as a global contract (by hash), from the deployer, and
 * records the hash in deployments/<network>.json as `demo_token_global_hash`. Launches then
 * reference it (about 0.2 NEAR of state each) instead of storing their own copy (about 1.9 NEAR).
 * Global code costs 10× its storage, burnt: about 17 NEAR for the 172 KB token.
 */
async function publishDemoToken(env: Env, network: string, confirmed: boolean) {
  const path = new URL(`../deployments/${network}.json`, import.meta.url);
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const code = new Uint8Array(wasm('demo_token'));
  const hash = base58Encode(createHash('sha256').update(code).digest());
  const cost = BigInt(code.length) * 10n * 10n ** 19n;
  const near = new NearClient(env.DEPLOY_NEAR_RPC_URL);
  const near3 = (y: bigint) => (Number(y / (NEAR / 1000n)) / 1000).toFixed(3);
  step(`Publishing demo_token.wasm (${code.length} bytes, hash ${hash}) as a global contract`);
  if (record.demo_token_global_hash === hash) {
    console.log('  already published and recorded');
    return;
  }
  const balance = BigInt((await near.accountState(env.DEPLOY_ACCOUNT_ID)).amount);
  const floor = BigInt(Math.round(env.DEPLOY_MIN_BALANCE_NEAR * 1000)) * (NEAR / 1000n);
  console.log(
    `  burns about ${near3(cost)} NEAR; ${env.DEPLOY_ACCOUNT_ID} holds ${near3(balance)}`,
  );
  if (balance - cost - NEAR < floor)
    throw new Error(
      `Publishing would leave the deployer under the ${env.DEPLOY_MIN_BALANCE_NEAR} NEAR floor`,
    );
  if (!confirmed) {
    console.log('  not sent: rerun with --confirm to publish');
    return;
  }
  const deployer = near.account(env.DEPLOY_ACCOUNT_ID, env.DEPLOY_PRIVATE_KEY as KeyPairString);
  const out = await near.send(deployer, env.DEPLOY_ACCOUNT_ID, [
    actions.deployGlobalContract(code, 'codeHash'),
  ]);
  if (!out.ok) throw new Error(`Publishing the demo token failed: ${out.error}`);
  console.log(`  ✓ published (tx ${out.txHash})`);
  record.demo_token_global_hash = hash;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`  recorded demo_token_global_hash in deployments/${network}.json`);
}

async function main() {
  if (process.argv.includes('--local')) return rehearseLocally();
  if (process.argv.includes('--register-enclave')) return registerEnclave();
  if (process.argv.includes('--publish-demo-token')) {
    const env = Env.parse(stripEmpty(process.env));
    return publishDemoToken(env, 'testnet', process.argv.includes('--confirm'));
  }
  const env = Env.parse({ ...(await localKeys()), ...stripEmpty(process.env) });
  await deploy(env, 'testnet');
}

/** `.env` lines left empty mean "use the default", not "use the empty string". */
const stripEmpty = (e: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined && v !== ''));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
