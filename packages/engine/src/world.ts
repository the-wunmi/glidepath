import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { nearSecpKey } from '@vsp/chainsig';
import { base58Encode, bytesToHex, DomainError, hexToBytes, sha256Hex } from '@vsp/core';
import {
  activity,
  type Db,
  dailyUsage,
  enclaveStore,
  executions,
  plans,
  simOneClickQuotes,
  simSettings,
  world,
} from '@vsp/db';
import type { Enclave } from '@vsp/enclave';
import { type EvmNode, startEvmNode } from '@vsp/evm';
import {
  actions,
  KeyPair,
  type KeyPairString,
  type LocalNear,
  NearClient,
  startNearSandbox,
  teraToGas,
} from '@vsp/near';
import { simulatorPublicKey } from '@vsp/oneclick';
import { eq, like } from 'drizzle-orm';
import type { Config } from './config.ts';
import { defaultSimSettings } from './sim-settings.ts';

/**
 * The accounts the engine works with. On the local network every key is a throwaway sandbox key;
 * on testnet the only key is the relayer's (from .env), and the registry has none.
 */
export interface WorldConfig {
  /** Absent on worlds saved before testnet support: those are local. */
  network?: 'local' | 'testnet';
  nearRpcUrl: string;
  evmRpcUrl: string;
  evmChainId: number;
  root: string;
  registry: string;
  signer: string;
  usdc: string;
  dao: string | null;
  governance: string;
  relayer: string;
  solver: string;
  mpcNode: string;
  founder: string;
  /** Sandbox keys of the demo personas; the registry has none (deleted at bootstrap). */
  keys: Record<string, KeyPairString>;
  /** The simulated MPC network's root secret. Real MPC keys are threshold-shared and never whole. */
  mpcRootSecretHex: string;
  mpcRootPublicKey: string;
  /** The 1Click simulator's quote-signing secret. */
  oneclickSecretHex: string;
  registryCodeHash: string;
  /**
   * The demo token's code published once as a global contract (base58 sha256 of the wasm). Token
   * launches then reference it instead of storing their own 172 KB copy. Absent: each launch
   * deploys the code.
   */
  demoTokenCodeHash?: string | null;
}

const WASM = (name: string) =>
  readFileSync(new URL(`../../../contracts/res/${name}.wasm`, import.meta.url));

/** The demo token's wasm, which every NEAR-token launch runs. */
export const demoTokenWasm = () => WASM('demo_token');

/** How NEAR names a global contract by hash: base58 of the code's sha256. */
export const globalCodeHash = (code: Uint8Array) => base58Encode(hexToBytes(sha256Hex(code)));

/** The sandbox advances about 300 ms of chain time per fast-forwarded block (measured). */
export const SANDBOX_MS_PER_BLOCK = 300;

/** Ten minutes: long enough to show a cooling-off timer, short enough to see it end in a demo. */
export const LOCAL_MIN_COOLING_OFF_MS = 600_000;

export interface LocalChains {
  near: LocalNear;
  evm: EvmNode;
  stop: () => Promise<void>;
}

export async function startLocalChains(config: Config): Promise<LocalChains> {
  const [nearStarted, evmStarted] = await Promise.allSettled([
    startNearSandbox(config.NEAR_SANDBOX_PORT),
    startEvmNode(config.EVM_NODE_PORT),
  ]);
  // If one node fails to start, stop the other rather than leave it running without a parent.
  if (nearStarted.status === 'rejected' || evmStarted.status === 'rejected') {
    if (nearStarted.status === 'fulfilled') await nearStarted.value.stop();
    if (evmStarted.status === 'fulfilled') await evmStarted.value.stop();
    throw nearStarted.status === 'rejected'
      ? nearStarted.reason
      : (evmStarted as PromiseRejectedResult).reason;
  }
  const near = nearStarted.value;
  const evm = evmStarted.value;
  /** Never let a stuck node hold shutdown: both are throwaway. */
  const within = (p: Promise<unknown>) =>
    Promise.race([p, new Promise((r) => setTimeout(r, 15_000))]);
  return {
    near,
    evm,
    stop: async () => void (await Promise.all([within(near.stop()), within(evm.stop())])),
  };
}

const NEAR = 10n ** 24n;

/** Deploys and seeds a fresh local world. Every step checks its transaction outcome. */
export async function bootstrapLocalWorld(
  chains: LocalChains,
  enclave: Enclave,
  evmChainId: number,
): Promise<WorldConfig> {
  const near = new NearClient(chains.near.rpcUrl);
  const root = near.account(chains.near.rootAccount, chains.near.rootKey);
  const rootId = chains.near.rootAccount;
  const keys: Record<string, KeyPairString> = {};
  const id = (name: string) => `${name}.${rootId}`;

  const must = async (label: string, p: Promise<{ ok: boolean; error?: string }>) => {
    const out = await p;
    if (!out.ok)
      throw new Error(`Bootstrap step failed (${label}): ${(out as { error: string }).error}`);
    return out;
  };

  async function createAccount(name: string, balanceNear: bigint, code?: Uint8Array) {
    const kp = KeyPair.fromRandom('ed25519');
    keys[id(name)] = kp.toString() as KeyPairString;
    const acts = [
      actions.createAccount(),
      actions.transfer(balanceNear * NEAR),
      actions.addFullAccessKey(kp.getPublicKey()),
    ];
    if (code) acts.push(actions.deployContract(code));
    await must(`create ${name}`, near.send(root, id(name), acts));
    return near.account(id(name), kp.toString() as KeyPairString);
  }

  const governance = await createAccount('governance', 200n);
  await createAccount('relayer', 200n);
  const solver = await createAccount('solver', 50n);
  await createAccount('mpc-node', 50n);
  await createAccount('founder', 100n);

  // Simulated MPC network: one root key, the derivation the real network uses (chainsig package).
  const mpcRootSecret = secp256k1.utils.randomSecretKey();
  const mpcRootPublicKey = nearSecpKey(
    secp256k1.Point.fromBytes(secp256k1.getPublicKey(mpcRootSecret, false)),
  );
  const signer = await createAccount('signer', 20n, WASM('mpc_signer_sim'));
  await must(
    'init signer',
    near.call(signer, signer.accountId, 'new', {
      root_public_key: mpcRootPublicKey,
      responder: id('mpc-node'),
    }),
  );

  const usdc = await createAccount('usdc', 20n, WASM('demo_token'));
  await must(
    'init usdc',
    near.call(usdc, usdc.accountId, 'new', {
      owner_id: solver.accountId,
      metadata: { spec: 'ft-1.0.0', name: 'USD Coin (local)', symbol: 'USDC', decimals: 6 },
      allocations: [],
    }),
  );

  // The registry: deployed, initialised, its plan-account code set as a global contract, its
  // enclave registered, and then its own key deleted, so nobody can change or bypass it.
  const registry = await createAccount('registry', 100n, WASM('plan_registry'));
  await must(
    'init registry',
    near.call(registry, registry.accountId, 'new', {
      governance: governance.accountId,
      signer_contract: signer.accountId,
      min_cooling_off_ms: LOCAL_MIN_COOLING_OFF_MS,
      // New enclaves and quote signers are public for a full cooling-off before they can act.
      enclave_activation_delay_ms: LOCAL_MIN_COOLING_OFF_MS,
    }),
  );
  const planAccountWasm = WASM('plan_account');
  await must(
    'plan account code',
    near.send(governance, registry.accountId, [
      actions.functionCall(
        'setup_plan_account_code',
        new Uint8Array(planAccountWasm),
        teraToGas(300),
        BigInt(planAccountWasm.length) * 10n * 10n ** 19n + NEAR,
      ),
    ]),
  );
  const identity = await enclave.identity();
  await must(
    'register enclave',
    near.call(
      governance,
      registry.accountId,
      'register_enclave',
      {
        public_key: identity.signingKey,
        measurements: identity.quote.measurements,
        quote_hash: identity.quoteHash,
      },
      { deposit: NEAR / 10n },
    ),
  );
  // Proceeds are paid in local USDC; the registry ties its decimals to the plan's floor test.
  const proceeds = await near.call(
    governance,
    registry.accountId,
    'set_proceeds_asset',
    { asset_id: `nep141:${usdc.accountId}`, decimals: 6 },
    { deposit: NEAR / 10n },
  );
  // Registries built before the proceeds-asset allowlist have no such method; anything else fails.
  if (!proceeds.ok && !/MethodNotFound|MethodResolveError/.test(proceeds.error))
    throw new Error(`Bootstrap step failed (register proceeds asset): ${proceeds.error}`);
  const oneclickSecret = crypto.getRandomValues(new Uint8Array(32));
  await must(
    'register 1Click quote signer',
    near.call(governance, registry.accountId, 'set_quote_signer', {
      public_key: simulatorPublicKey(oneclickSecret),
    }),
  );
  // Both registrations wait out the activation delay; the local chain skips ahead past it.
  await near.fastForward(Math.ceil(LOCAL_MIN_COOLING_OFF_MS / SANDBOX_MS_PER_BLOCK) + 100, {
    settle: false,
  });
  const registryKey = KeyPair.fromString(keys[registry.accountId] as KeyPairString);
  await must(
    'delete registry key',
    near.send(registry, registry.accountId, [actions.deleteKey(registryKey.getPublicKey())]),
  );
  delete keys[registry.accountId];
  // A treasury DAO (the real Sputnik DAO v2 code the mainnet factory deploys) with the founder as
  // its only council member. Its key is deleted too: it acts only through proposals.
  const dao = await createAccount(
    'treasury-dao',
    40n,
    readFileSync(new URL('../../../contracts/res/third_party/sputnikdao2.wasm', import.meta.url)),
  );
  await must(
    'init dao',
    near.call(
      dao,
      dao.accountId,
      'new',
      {
        config: {
          name: 'treasury',
          purpose: 'Sells treasury tokens under sealed plans',
          metadata: '',
        },
        policy: [id('founder')],
      },
      { gasTera: 100 },
    ),
  );
  const daoKey = KeyPair.fromString(keys[dao.accountId] as KeyPairString);
  await must(
    'delete dao key',
    near.send(dao, dao.accountId, [actions.deleteKey(daoKey.getPublicKey())]),
  );
  delete keys[dao.accountId];

  // The demo token's code, published once (10× storage, burnt; free on the sandbox) so each launch
  // only references it, as testnet does once `deploy:testnet --publish-demo-token` has run.
  const tokenWasm = new Uint8Array(demoTokenWasm());
  await must(
    'publish demo token code',
    near.send(root, rootId, [actions.deployGlobalContract(tokenWasm, 'codeHash')]),
  );

  const registryConfig = await near.view<{ plan_account_code_hash: string }>(
    registry.accountId,
    'get_config',
  );

  return {
    network: 'local',
    nearRpcUrl: chains.near.rpcUrl,
    evmRpcUrl: chains.evm.rpcUrl,
    evmChainId,
    root: rootId,
    registry: registry.accountId,
    signer: signer.accountId,
    usdc: usdc.accountId,
    dao: dao.accountId,
    governance: governance.accountId,
    relayer: id('relayer'),
    solver: solver.accountId,
    mpcNode: id('mpc-node'),
    founder: id('founder'),
    keys: { ...keys, [rootId]: chains.near.rootKey },
    mpcRootSecretHex: bytesToHex(mpcRootSecret),
    mpcRootPublicKey,
    oneclickSecretHex: bytesToHex(oneclickSecret),
    registryCodeHash: registryConfig.plan_account_code_hash,
    demoTokenCodeHash: globalCodeHash(tokenWasm),
  };
}

/** Plan accounts get 0.1 NEAR (registry constant) plus storage; the registry refunds the rest. */
export const CREATE_PLAN_DEPOSIT_YOCTO = NEAR / 2n;

/**
 * Records the world the engine runs against. Returns true when it is a new world (a new genesis
 * hash, or the first), so the caller also clears DBOS's workflow history from the old one. Rows
 * from a previous world (plans, executions, sealed plan state, simulator quotes, the activity log)
 * describe chains that no longer exist, so they go.
 */
export async function saveWorld(
  db: Db,
  genesisHash: string,
  config: WorldConfig,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(world).where(eq(world.id, 1));
    const fresh = !existing || existing.genesisHash !== genesisHash;
    if (existing && existing.genesisHash !== genesisHash) {
      await tx.delete(plans);
      await tx.delete(executions);
      // The enclave's own identity survives; only per-plan state belonged to the old chain.
      await tx.delete(enclaveStore).where(like(enclaveStore.key, 'plan:%'));
      await tx.delete(simOneClickQuotes);
      await tx.delete(activity);
      // The caps count spending on a chain that is gone (always the local sandbox).
      await tx.delete(dailyUsage);
    }
    await tx
      .insert(world)
      .values({ id: 1, genesisHash, config })
      .onConflictDoUpdate({
        target: world.id,
        set: { genesisHash, config, createdAt: new Date() },
      });
    // A restart on the same world (always testnet) keeps the settings: they hold the listing
    // prices of launched demo tokens, which the simulated market and 1Click need.
    const defaults = defaultSimSettings(config.usdc);
    const reset = tx.insert(simSettings).values({ id: 1, data: defaults });
    await (fresh
      ? reset.onConflictDoUpdate({ target: simSettings.id, set: { data: defaults } })
      : reset.onConflictDoNothing());
    return fresh;
  });
}

export async function loadWorld(db: Db): Promise<WorldConfig> {
  const [row] = await db.select().from(world).where(eq(world.id, 1));
  if (!row) throw new DomainError('unavailable', 'The local world has not been set up');
  return row.config as WorldConfig;
}

/** The simulated enclave's hardware secret, kept in the data dir so restarts keep its identity. */
export function enclaveHardwareSecret(dataDir: string): Uint8Array {
  const path = `${dataDir}/enclave-hardware.key`;
  try {
    return hexToBytes(readFileSync(path, 'utf8').trim());
  } catch {
    mkdirSync(dataDir, { recursive: true });
    const secret = crypto.getRandomValues(new Uint8Array(32));
    writeFileSync(path, bytesToHex(secret), { mode: 0o600 });
    return secret;
  }
}

/** What `pnpm deploy:testnet` recorded (deployments/testnet.json); no secrets. */
export interface Deployment {
  network: string;
  rpc: string;
  registry: string;
  governance: string;
  signer_contract: string;
  mpc_root_public_key: string;
  min_cooling_off_ms: number;
  proceeds_asset: string;
  usdc: string;
  quote_signer: string | null;
  plan_account_code_hash: string;
  /** Set by `pnpm deploy:testnet --publish-demo-token`; launches use the global code once it is. */
  demo_token_global_hash?: string;
}

export function loadDeployment(config: Config, network = 'testnet'): Deployment {
  const path = `${config.DEPLOYMENTS_DIR}/${network}.json`;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Deployment;
  } catch {
    throw new Error(`No ${path}: run pnpm deploy:testnet first`);
  }
}

/**
 * The 1Click simulator's quote-signing secret, kept in the data dir like the enclave's, so the key
 * the testnet registry pins (set by deploy:testnet) is the key the running simulator signs with.
 * 1Click has no testnet; this key signs simulated quotes only.
 */
export function oneclickSimSecret(dataDir: string): Uint8Array {
  const path = `${dataDir}/oneclick-sim.key`;
  try {
    return hexToBytes(readFileSync(path, 'utf8').trim());
  } catch {
    mkdirSync(dataDir, { recursive: true });
    const secret = crypto.getRandomValues(new Uint8Array(32));
    writeFileSync(path, bytesToHex(secret), { mode: 0o600 });
    return secret;
  }
}

/** The public quote key of a simulator secret, as the registry stores it. */
export const simulatorQuoteKey = (secret: Uint8Array) => simulatorPublicKey(secret);

/**
 * The testnet world: the deployed registry and stand-in USDC, the real Chain Signatures signer, and
 * the relayer account from .env, which also plays the founder and the simulated 1Click's solver
 * (it owns the stand-in USDC, so it can mint payouts). EVM stays on the given node.
 */
export function testnetWorld(
  config: Config,
  d: Deployment,
  evm: { rpcUrl: string; chainId: number },
): WorldConfig {
  const relayer = config.RELAYER_ACCOUNT_ID as string;
  return {
    network: 'testnet',
    nearRpcUrl: config.NEAR_RPC_URL,
    evmRpcUrl: evm.rpcUrl,
    evmChainId: evm.chainId,
    root: relayer,
    registry: d.registry,
    signer: d.signer_contract,
    usdc: d.usdc,
    dao: null,
    governance: d.governance,
    relayer,
    solver: relayer,
    mpcNode: '',
    founder: relayer,
    keys: { [relayer]: config.RELAYER_PRIVATE_KEY as KeyPairString },
    mpcRootSecretHex: '',
    mpcRootPublicKey: d.mpc_root_public_key,
    oneclickSecretHex: bytesToHex(oneclickSimSecret(config.DATA_DIR)),
    registryCodeHash: d.plan_account_code_hash,
    demoTokenCodeHash: d.demo_token_global_hash ?? null,
  };
}
