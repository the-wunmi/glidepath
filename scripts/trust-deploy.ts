/**
 * Deploys the blind trust prototype's contract (contracts/blind-trust) to NEAR testnet. A dry run
 * unless --confirm: it checks the deployer's balance and prints every step and its cost first.
 * Mainnet is refused.
 *
 *   pnpm trust:deploy                   # dry run: reads DEPLOY_* from .env, sends nothing
 *   pnpm trust:deploy --confirm         # deploy
 *   pnpm trust:deploy --tokens --confirm   # also the five demo tokens a trust holds
 *   pnpm trust:deploy --local           # rehearse every step on a throwaway local sandbox
 *   pnpm trust:deploy --outlayer        # register the current OutLayer build's key instead
 *
 * Steps: create <TRUST_CONTRACT_NAME>.<deployer> with the contract, initialise it with the deployer
 * as governance and the plan-account code the registry already published as a global contract
 * (trust accounts use it by hash, so nothing more is burnt), register the enclave key and the
 * 1Click simulator's quote key (both act only after the public delay), delete the contract's own
 * key and check it has none. With --tokens, the demo tokens use the demo token's published global
 * code and are owned by the relayer, which plays 1Click's solver on testnet. Before every step that
 * spends, the deployer must keep DEPLOY_MIN_BALANCE_NEAR. Writes deployments/trust-<network>.json.
 *
 * The enclave key: TRUST_ENCLAVE_PUBLIC_KEY / _MEASUREMENTS / _QUOTE_HASH if set; with --outlayer
 * the current OutLayer build in deployments/outlayer-testnet.json; otherwise this machine's
 * simulated enclave, the key the API's simulated trust enclave signs with (as `deploy:testnet`
 * registers it for plans). The current OutLayer build (`3c0571…`, published 2026-11-14) carries the
 * trust operations (trust_accept, trust_tick, trust_trade); running a trust on OutLayer needs that
 * build's key registered here, and the engine wired to `ModuleTrustEnclave` with an OutLayer runner (it takes any
 * `OutLayerRunner`; the tests run it on the local module).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  new Uint8Array(readFileSync(new URL(`../contracts/res/${name}.wasm`, import.meta.url)));
const deployments = (name: string) => new URL(`../deployments/${name}`, import.meta.url);

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
  TRUST_CONTRACT_NAME: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/)
    .default('vsp-trust'),
  /** The contract's minimum cooling-off and its keys' activation delay, as the registry's. */
  DEPLOY_MIN_COOLING_OFF_MS: z.coerce.number().int().min(60_000).default(600_000),
  /** The contract stores its code (about 3.1 NEAR at 311 KB) plus room for trusts' storage. */
  TRUST_CONTRACT_FUNDING_NEAR: z.coerce.bigint().default(5n),
  /** Stop before any step that would leave the deployer below this (the account is shared). */
  DEPLOY_MIN_BALANCE_NEAR: z.coerce.number().default(27),
  TRUST_ENCLAVE_PUBLIC_KEY: z.string().optional(),
  TRUST_ENCLAVE_MEASUREMENTS: z.string().optional(),
  TRUST_ENCLAVE_QUOTE_HASH: z.string().optional(),
  /** Who may mint the demo tokens: the account that plays 1Click's solver (the relayer). */
  RELAYER_ACCOUNT_ID: z.string().optional(),
});
type Env = z.output<typeof Env>;

/** The demo assets, as on the local world (packages/engine/src/trusts/world.ts). */
const TOKENS = [
  { symbol: 'IDX', name: 'Broad market index', sector: 'broad', basePriceE6: '25000000' },
  { symbol: 'BOND', name: 'Treasury bond fund', sector: 'bonds', basePriceE6: '100000000' },
  { symbol: 'GOLD', name: 'Gold', sector: 'commodities', basePriceE6: '40000000' },
  { symbol: 'NRG', name: 'Energy sector', sector: 'energy', basePriceE6: '75000000' },
  { symbol: 'DEFI', name: 'DeFi sector', sector: 'defi', basePriceE6: '12000000' },
];
/** A token account using global code stores only its state; a little NEAR covers registrations. */
const TOKEN_FUNDING = NEAR / 2n;

interface Inputs {
  /** base58 sha256 of the plan account code, already a global contract on this network. */
  accountCodeHash: string;
  quoteSigner: string;
  demoTokenHash: string | null;
  enclave: { publicKey: string; measurements: z.output<typeof Measurements>; quoteHash: string };
}

const step = (s: string) => console.log(`▸ ${s}`);

/** This machine's simulated enclave: the key the API's simulated trust enclave signs with. */
async function simulatedEnclave(): Promise<Inputs['enclave']> {
  const { createDb, createPool } = await import('@vsp/db');
  const { identityOnlyEnclave, loadConfig } = await import('@vsp/engine');
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  try {
    const identity = await identityOnlyEnclave(config, createDb(pool)).identity();
    return {
      publicKey: identity.signingKey,
      measurements: identity.quote.measurements,
      quoteHash: identity.quoteHash,
    };
  } finally {
    await pool.end();
  }
}

/** The current OutLayer build (deployments/outlayer-testnet.json). */
function outlayerEnclave(): Inputs['enclave'] {
  const outlayer = JSON.parse(readFileSync(deployments('outlayer-testnet.json'), 'utf8')) as {
    signingKey: string;
    attestation: { measurements: z.input<typeof Measurements>; quoteHash: string };
  };
  console.log(
    '  note: only builds published from 2026-11-14 on (3c0571… and later) carry the trust operations; an older current build can never trade',
  );
  return {
    publicKey: outlayer.signingKey,
    measurements: Measurements.parse(outlayer.attestation.measurements),
    quoteHash: outlayer.attestation.quoteHash,
  };
}

/** What a testnet deployment builds on: the registry's record and an enclave key. */
async function testnetInputs(env: Env, useOutlayer: boolean): Promise<Inputs> {
  const registry = JSON.parse(readFileSync(deployments('testnet.json'), 'utf8')) as {
    plan_account_code_hash: string;
    quote_signer: string | null;
    demo_token_global_hash?: string;
  };
  if (!registry.quote_signer) throw new Error('deployments/testnet.json has no quote signer');
  const enclave =
    env.TRUST_ENCLAVE_PUBLIC_KEY && env.TRUST_ENCLAVE_MEASUREMENTS && env.TRUST_ENCLAVE_QUOTE_HASH
      ? {
          publicKey: env.TRUST_ENCLAVE_PUBLIC_KEY,
          measurements: Measurements.parse(JSON.parse(env.TRUST_ENCLAVE_MEASUREMENTS)),
          quoteHash: env.TRUST_ENCLAVE_QUOTE_HASH,
        }
      : useOutlayer
        ? outlayerEnclave()
        : await simulatedEnclave();
  return {
    accountCodeHash: registry.plan_account_code_hash,
    quoteSigner: registry.quote_signer,
    demoTokenHash: registry.demo_token_global_hash ?? null,
    enclave,
  };
}

async function deploy(
  env: Env,
  inputs: Inputs,
  network: string,
  opts: { confirm: boolean; tokens: boolean },
) {
  const near = new NearClient(env.DEPLOY_NEAR_RPC_URL);
  const deployer = near.account(env.DEPLOY_ACCOUNT_ID, env.DEPLOY_PRIVATE_KEY as KeyPairString);
  const contract = `${env.TRUST_CONTRACT_NAME}.${env.DEPLOY_ACCOUNT_ID}`;
  const code = wasm('blind_trust');
  const tokenOwner = env.RELAYER_ACCOUNT_ID ?? env.DEPLOY_ACCOUNT_ID;
  if (opts.tokens && !inputs.demoTokenHash)
    throw new Error(
      '--tokens needs the demo token published first: pnpm deploy:testnet --publish-demo-token --confirm',
    );
  const funding = env.TRUST_CONTRACT_FUNDING_NEAR * NEAR;
  // Registrations and fees: two 0.1 NEAR storage deposits and gas, rounded up.
  const required = funding + NEAR / 2n + (opts.tokens ? TOKEN_FUNDING * BigInt(TOKENS.length) : 0n);
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
  const must = async (label: string, p: ReturnType<NearClient['send']>) => {
    const out = await p;
    if (!out.ok) throw new Error(`${label} failed: ${out.error}`);
    console.log(`  ✓ ${label}  (tx ${out.txHash})`);
    return out;
  };

  step(`Checking ${env.DEPLOY_ACCOUNT_ID} on ${network}`);
  const balance = await guard('The whole deployment', required);
  console.log(`  balance ${near3(balance)} NEAR; this deployment needs about ${near3(required)}`);
  if (await near.accountExists(contract))
    throw new Error(`${contract} already exists; choose another TRUST_CONTRACT_NAME`);
  const plan = [
    `create ${contract} with blind_trust.wasm (${code.length} bytes) and ${near3(funding)} NEAR`,
    `new(governance ${env.DEPLOY_ACCOUNT_ID}, cooling-off ${env.DEPLOY_MIN_COOLING_OFF_MS} ms, trust account code ${inputs.accountCodeHash})`,
    `register_enclave ${inputs.enclave.publicKey}`,
    `set_quote_signer ${inputs.quoteSigner}`,
    `delete ${contract}'s key and check it has none`,
    ...(opts.tokens
      ? TOKENS.map(
          (t) =>
            `create labs-${t.symbol.toLowerCase()}.${env.DEPLOY_ACCOUNT_ID} (${t.symbol}, owner ${tokenOwner})`,
        )
      : []),
  ];
  for (const p of plan) console.log(`  · ${p}`);
  if (!opts.confirm) {
    console.log('\nDry run: nothing sent. Rerun with --confirm to deploy.');
    return;
  }

  step(`Creating ${contract}`);
  await guard('Creating the contract', funding);
  const key = KeyPair.fromRandom('ed25519');
  await must(
    'create and deploy',
    near.send(deployer, contract, [
      actions.createAccount(),
      actions.transfer(funding),
      actions.addFullAccessKey(key.getPublicKey()),
      actions.deployContract(code),
      actions.functionCall(
        'new',
        {
          governance: env.DEPLOY_ACCOUNT_ID,
          min_cooling_off_ms: env.DEPLOY_MIN_COOLING_OFF_MS,
          enclave_activation_delay_ms: env.DEPLOY_MIN_COOLING_OFF_MS,
          account_code_hash: inputs.accountCodeHash,
        },
        teraToGas(50),
        0n,
      ),
    ]),
  );
  step('Registering the enclave key and the quote key (active after the public delay)');
  await must(
    'register_enclave',
    near.call(
      deployer,
      contract,
      'register_enclave',
      {
        public_key: inputs.enclave.publicKey,
        measurements: inputs.enclave.measurements,
        quote_hash: inputs.enclave.quoteHash,
      },
      { deposit: NEAR / 10n },
    ),
  );
  await must(
    'set_quote_signer',
    near.call(deployer, contract, 'set_quote_signer', { public_key: inputs.quoteSigner }),
  );
  step('Deleting the contract’s key');
  const self = near.account(contract, key.toString() as KeyPairString);
  await must('delete key', near.send(self, contract, [actions.deleteKey(key.getPublicKey())]));
  const keys = await near.accessKeyCount(contract);
  if (keys !== 0) throw new Error(`${contract} still has ${keys} keys`);
  console.log('  ✓ the contract has no keys');

  const tokens = [];
  if (opts.tokens && inputs.demoTokenHash) {
    for (const t of TOKENS) {
      const account = `labs-${t.symbol.toLowerCase()}.${env.DEPLOY_ACCOUNT_ID}`;
      step(`Creating ${t.symbol} (${account})`);
      await guard(`Creating ${t.symbol}`, TOKEN_FUNDING);
      await must(
        `create ${t.symbol}`,
        near.send(deployer, account, [
          actions.createAccount(),
          actions.transfer(TOKEN_FUNDING),
          actions.useGlobalContract({ codeHash: inputs.demoTokenHash }),
          actions.functionCall(
            'new',
            {
              owner_id: tokenOwner,
              metadata: { spec: 'ft-1.0.0', name: t.name, symbol: t.symbol, decimals: 18 },
              allocations: [],
            },
            teraToGas(50),
            0n,
          ),
        ]),
      );
      tokens.push({ ...t, account, decimals: 18 });
    }
  }

  const record = {
    network,
    deployed_at: new Date().toISOString(),
    rpc: env.DEPLOY_NEAR_RPC_URL,
    contract,
    governance: env.DEPLOY_ACCOUNT_ID,
    min_cooling_off_ms: env.DEPLOY_MIN_COOLING_OFF_MS,
    account_code_hash: inputs.accountCodeHash,
    enclave_key: inputs.enclave.publicKey,
    quote_signer: inputs.quoteSigner,
    blind_trust_wasm_sha256: createHash('sha256').update(code).digest('hex'),
    tokens,
    near_spent: near3(balance - BigInt((await near.accountState(env.DEPLOY_ACCOUNT_ID)).amount)),
  };
  mkdirSync(deployments(''), { recursive: true });
  // A rehearsal's record is git-ignored (deployments/local-*.json).
  const file = network === 'testnet' ? 'trust-testnet.json' : `local-trust-${network}.json`;
  writeFileSync(deployments(file), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nWrote deployments/${file}.`);
}

/**
 * The same steps on a throwaway sandbox: a deployer account, the plan account code published as a
 * global contract (the registry does this on testnet), and made-up enclave and quote keys.
 */
async function rehearseLocally() {
  step('Starting a throwaway NEAR sandbox');
  const sandbox = await startNearSandbox();
  try {
    const near = new NearClient(sandbox.rpcUrl);
    const root = near.account(sandbox.rootAccount, sandbox.rootKey);
    const deployerKey = KeyPair.fromRandom('ed25519');
    const deployerId = `deployer.${sandbox.rootAccount}`;
    const created = await near.send(root, deployerId, [
      actions.createAccount(),
      actions.transfer(100n * NEAR),
      actions.addFullAccessKey(deployerKey.getPublicKey()),
    ]);
    if (!created.ok) throw new Error(`create deployer: ${created.error}`);
    const published = await near.send(root, sandbox.rootAccount, [
      actions.deployGlobalContract(wasm('plan_account'), 'codeHash'),
    ]);
    if (!published.ok) throw new Error(`publish plan account code: ${published.error}`);
    const tokenPublished = await near.send(root, sandbox.rootAccount, [
      actions.deployGlobalContract(wasm('demo_token'), 'codeHash'),
    ]);
    if (!tokenPublished.ok) throw new Error(`publish demo token code: ${tokenPublished.error}`);
    const { base58Encode } = await import('@vsp/core');
    const hash = (bytes: Uint8Array) =>
      base58Encode(new Uint8Array(createHash('sha256').update(bytes).digest()));
    const env = Env.extend({ DEPLOY_ACCOUNT_ID: z.string() }).parse({
      DEPLOY_NEAR_RPC_URL: sandbox.rpcUrl,
      DEPLOY_ACCOUNT_ID: deployerId,
      DEPLOY_PRIVATE_KEY: deployerKey.toString(),
      DEPLOY_MIN_BALANCE_NEAR: '1',
    });
    await deploy(
      env,
      {
        accountCodeHash: hash(wasm('plan_account')),
        quoteSigner: KeyPair.fromRandom('ed25519').getPublicKey().toString(),
        demoTokenHash: hash(wasm('demo_token')),
        enclave: {
          publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(),
          measurements: {
            mrtd: 'aa'.repeat(48),
            rtmr0: 'bb'.repeat(48),
            rtmr1: 'cc'.repeat(48),
            rtmr2: 'dd'.repeat(48),
            rtmr3: 'ee'.repeat(48),
          },
          quoteHash: 'ab'.repeat(32),
        },
      },
      'local-rehearsal',
      { confirm: true, tokens: true },
    );
  } finally {
    await sandbox.stop();
  }
}

const stripEmpty = (e: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined && v !== ''));

async function main() {
  if (process.argv.includes('--local')) return rehearseLocally();
  if (!existsSync(deployments('testnet.json')))
    throw new Error(
      'No deployments/testnet.json: the trust contract builds on the deployed registry',
    );
  const env = Env.parse(stripEmpty(process.env));
  await deploy(env, await testnetInputs(env, process.argv.includes('--outlayer')), 'testnet', {
    confirm: process.argv.includes('--confirm'),
    tokens: process.argv.includes('--tokens'),
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
