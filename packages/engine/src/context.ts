import { fileURLToPath } from 'node:url';
import type { SealedBox } from '@vsp/core';
import { ONECLICK_LIVE_QUOTE_KEY } from '@vsp/core';
import { type Db, enclaveStore, plans } from '@vsp/db';
import { type Enclave, type EnclaveHost, type SealedStore, SimulatedEnclave } from '@vsp/enclave';
import { EvmClient, LOCAL_FUNDER_KEY, launchpadKeyFor, SEPOLIA_CHAIN_ID } from '@vsp/evm';
import { type ChainPlan, type ChainReceipt, type KeyPairString, NearClient } from '@vsp/near';
import {
  createOneClickSimulator,
  OneClickClient,
  type SimAsset,
  simulatorPublicKey,
} from '@vsp/oneclick';
import type { PriceObservation } from '@vsp/planner';
import {
  BinancePriceSource,
  CoinbasePriceSource,
  ListedPriceSource,
  marketKey,
  type PriceSource,
  SimulatedPriceSource,
} from '@vsp/prices';
import { asc, eq } from 'drizzle-orm';
import { createPublicClient, type Hex, http, type PublicClient } from 'viem';
import { type Config, livePricePairs } from './config.ts';
import { createMpcNode } from './mpc-node.ts';
import { buildOutLayerEnclave } from './outlayer.ts';
import { createSimRails } from './rails.ts';
import { readSimSettings, takeOneClickOutcome } from './sim-settings.ts';
import { enclaveHardwareSecret, loadWorld, type WorldConfig } from './world.ts';

export interface Engine {
  config: Config;
  db: Db;
  world: WorldConfig;
  near: NearClient;
  evm: EvmClient;
  enclave: Enclave;
  oneclick: OneClickClient;
  oneclickSim: ReturnType<typeof createOneClickSimulator> | null;
  mpcNode: ReturnType<typeof createMpcNode> | null;
  prices: PriceSource[];
  log: (message: string, data?: Record<string, unknown>) => void;
  registry: Registry;
  /**
   * The public read paths (/api/meta, plan pages, the /rpc/near proxy) on their own paced client,
   * so visitors' reads cannot use up the RPC budget the engine's sales and relays need.
   */
  reads: {
    near: NearClient;
    registry: Registry;
    /** Sepolia: EVM_PROXY_RPC_URL when set, so visitors' EVM reads can use their own endpoint. */
    evmRpcUrl: string;
    evm: PublicClient;
  };
}

/** Public reads' share of a testnet endpoint, beside the engine's NEAR_RPC_MAX_PER_SECOND. */
const READ_RPC_PER_SECOND = 4;
/** Reads queued past this answer 503 at once instead of waiting minutes for their turn. */
const READ_RPC_MAX_WAITING = 100;

/** The registry's views, in one place so every reader decodes them the same way. */
export interface Registry {
  plan(id: number): Promise<ChainPlan | null>;
  plans(): Promise<ChainPlan[]>;
  receipts(id: number, fromSeq?: number): Promise<ChainReceipt[]>;
  receipt(id: number, seq: number): Promise<ChainReceipt | null>;
}

/** The registry pages at 50; plans and receipts are read in pages up to this many. */
const MAX_READ = 500;

export function registryReader(near: NearClient, registry: string): Registry {
  const receipts = async (id: number, fromSeq = 0) => {
    const out: ChainReceipt[] = [];
    for (let from = fromSeq; out.length < MAX_READ; ) {
      const page = await near.view<ChainReceipt[]>(registry, 'get_receipts', {
        plan_id: id,
        from_seq: from,
        limit: 50,
      });
      out.push(...page);
      if (page.length < 50) break;
      from = (page.at(-1)?.seq ?? from) + 1;
    }
    return out;
  };
  return {
    plan: (id) => near.view<ChainPlan | null>(registry, 'get_plan', { plan_id: id }),
    async plans() {
      // list_plans pages by plan id, and ids start at 1.
      const out: ChainPlan[] = [];
      for (let from = 1; out.length < MAX_READ; ) {
        const page = await near.view<ChainPlan[]>(registry, 'list_plans', {
          from_index: from,
          limit: 50,
        });
        out.push(...page);
        if (page.length < 50) break;
        from = (page.at(-1)?.id ?? from) + 1;
      }
      return out;
    },
    receipts,
    async receipt(id, seq) {
      const [r] = await near.view<ChainReceipt[]>(registry, 'get_receipts', {
        plan_id: id,
        from_seq: seq,
        limit: 1,
      });
      return r && r.seq === seq ? r : null;
    },
  };
}

/** 1Click asset id for a plan token, the same form the enclave quotes with. */
export const assetIdFor = (chain: string, address: string) =>
  chain === 'near' ? `nep141:${address}` : `nep141:eth-${address}.omft.near`;

export function createEngine(config: Config, db: Db, w: WorldConfig, log: Engine['log']): Engine {
  // A public testnet RPC answers bursts with 429: pace each endpoint and fail over to the next.
  const fallbackUrls = config.NEAR_RPC_FALLBACK_URLS.split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const testnet = w.network === 'testnet';
  const near = testnet
    ? new NearClient(w.nearRpcUrl, { fallbackUrls, maxPerSecond: config.NEAR_RPC_MAX_PER_SECOND })
    : new NearClient(w.nearRpcUrl);
  const readNear = testnet
    ? new NearClient(w.nearRpcUrl, {
        fallbackUrls,
        maxPerSecond: READ_RPC_PER_SECOND,
        maxWaiting: READ_RPC_MAX_WAITING,
      })
    : near;
  const funder = config.EVM_FUNDER_PRIVATE_KEY as Hex | undefined;
  const evm =
    w.evmChainId === SEPOLIA_CHAIN_ID && funder
      ? new EvmClient(w.evmRpcUrl, w.evmChainId, funder, {
          fallbackUrls: config.EVM_RPC_FALLBACK_URLS.split(',')
            .map((u) => u.trim())
            .filter(Boolean),
          launchpadKey: launchpadKeyFor(funder),
        })
      : new EvmClient(w.evmRpcUrl, w.evmChainId, LOCAL_FUNDER_KEY);
  const readEvmUrl =
    w.evmChainId === SEPOLIA_CHAIN_ID && config.EVM_PROXY_RPC_URL
      ? config.EVM_PROXY_RPC_URL
      : w.evmRpcUrl;
  const registry = registryReader(near, w.registry);
  const settings = () => readSimSettings(db);

  // Live exchange prices for listed tokens; the simulated market for tokens with no market.
  const pairs = livePricePairs(config);
  const market = async () => (await settings()).market;
  const binance = new BinancePriceSource();
  const prices: PriceSource[] = [
    new ListedPriceSource(binance, new SimulatedPriceSource('binance', market), pairs),
    new ListedPriceSource(
      new CoinbasePriceSource(),
      new SimulatedPriceSource('coinbase', market),
      pairs,
    ),
  ];

  let oneclickSim: Engine['oneclickSim'] = null;
  if (config.ONECLICK_MODE === 'mock') {
    oneclickSim = createOneClickSimulator({
      db,
      assets: () => simAssets(db, w),
      market: async () => (await settings()).market,
      takeOutcome: () => takeOneClickOutcome(db),
      rails: createSimRails(near, evm, w),
      now: () => Date.now(),
      signingSecret: Buffer.from(w.oneclickSecretHex, 'hex'),
      // A listed token is quoted at its live price, so the quote agrees with the live feeds.
      listedPriceE6: async (symbol) => {
        const pair = pairs.get(symbol);
        return pair ? binance.priceE6(pair) : null;
      },
    });
  }
  const oneclick = new OneClickClient(
    config.ONECLICK_MODE === 'mock' ? `${config.API_ORIGIN}/sim/1click` : config.ONECLICK_BASE_URL,
    config.ONECLICK_MODE,
    config.ONECLICK_JWT,
  );

  const host: EnclaveHost = {
    chainTimeMs: () => near.chainTimeMs(),
    async planBalance(plan) {
      // A token that is not launched yet has no contract: the plan simply holds nothing.
      if (plan.asset.type === 'nep141' && !(await near.accountExists(plan.asset.token_id)))
        return 0n;
      if (plan.asset.type === 'nep141')
        return BigInt(
          await near.view<string>(plan.asset.token_id, 'ft_balance_of', {
            account_id: plan.plan_account,
          }),
        );
      if (!plan.evm_address) return 0n;
      if (!(await evm.hasCode(plan.asset.token_address as Hex))) return 0n;
      return evm.tokenBalance(plan.asset.token_address as Hex, plan.evm_address as Hex);
    },
    receipt: (planId, seq) => registry.receipt(planId, seq),
    async prices(symbol, sources) {
      // Markets run on wall-clock time, like the 1Click quote they are compared with; chain time
      // can be ahead after a sandbox fast-forward, which would compare prices from different moments.
      const atMs = Date.now();
      // The enclave names its token by symbol; the simulated market keys it by address. A symbol
      // maps to one address: createPlan refuses a symbol another token already uses.
      const key = pairs.has(symbol) ? symbol : await marketKeyForSymbol(db, symbol);
      const out: PriceObservation[] = [];
      for (const s of prices) {
        if (!sources.includes(s.name)) continue;
        try {
          out.push({ source: s.name, priceE6: await s.priceE6(key, atMs) });
        } catch (error) {
          log('price source failed', { source: s.name, error: String(error) });
        }
      }
      return out;
    },
    quote: (request) => oneclick.quote(request),
    evmFees: () => evm.fees(),
  };

  const enclave =
    config.ENCLAVE_BACKEND === 'outlayer'
      ? buildOutLayerEnclave(config, db, near, w, host, oneclickQuoteKey(config, w), log)
      : buildEnclave(config, db, host, oneclickQuoteKey(config, w));

  // On the local network a simulated MPC node answers the signer simulator; on testnet the real
  // Chain Signatures network answers v1.signer-prod.testnet, and there is nothing to run.
  const mpcNode =
    w.network !== 'testnet'
      ? createMpcNode(
          near,
          w.signer,
          near.account(w.mpcNode, w.keys[w.mpcNode] as KeyPairString),
          w.mpcRootSecretHex,
        )
      : null;

  return {
    config,
    db,
    world: w,
    near,
    evm,
    enclave,
    oneclick,
    oneclickSim,
    mpcNode,
    prices,
    log,
    registry,
    reads: {
      near: readNear,
      registry: readNear === near ? registry : registryReader(readNear, w.registry),
      evmRpcUrl: readEvmUrl,
      evm:
        readEvmUrl === w.evmRpcUrl
          ? evm.public
          : createPublicClient({ chain: evm.chain, transport: http(readEvmUrl) }),
    },
  };
}

/** The simulated-market key of the token a plan sells under this symbol (see `marketKey`). */
async function marketKeyForSymbol(db: Db, symbol: string): Promise<string> {
  const [row] = await db
    .select({ address: plans.tokenAddress })
    .from(plans)
    .where(eq(plans.tokenSymbol, symbol))
    .orderBy(asc(plans.id))
    .limit(1);
  if (!row) return symbol;
  return marketKey((await readSimSettings(db)).market, row.address, symbol);
}

const sourceDir = (pkg: string) => fileURLToPath(new URL(`../../${pkg}/src`, import.meta.url));

/** The simulated enclave: keys from the local hardware secret, state in sealed rows. */
export function buildEnclave(
  config: Config,
  db: Db,
  host: EnclaveHost,
  quoteSignerKey: string,
): Enclave {
  const store: SealedStore = {
    async get(key) {
      const [row] = await db.select().from(enclaveStore).where(eq(enclaveStore.key, key));
      return (row?.box as SealedBox | undefined) ?? null;
    },
    async put(key, box) {
      await db
        .insert(enclaveStore)
        .values({ key, box })
        .onConflictDoUpdate({ target: enclaveStore.key, set: { box, updatedAt: new Date() } });
    },
  };
  return new SimulatedEnclave({
    hardwareSecret: enclaveHardwareSecret(config.DATA_DIR),
    store,
    host,
    measuredDirs: [sourceDir('enclave'), sourceDir('planner'), sourceDir('core')],
    isUp: async () => (await readSimSettings(db)).enclaveUp,
    quoteSignerKey,
  });
}

/** The enclave before the world exists: enough to read its identity for registration. */
export function identityOnlyEnclave(config: Config, db: Db): Enclave {
  const unavailable = async (): Promise<never> => {
    throw new Error('The enclave has no host before the world is set up');
  };
  // The quote key is irrelevant here: an identity-only enclave never trades.
  return buildEnclave(
    config,
    db,
    {
      chainTimeMs: unavailable,
      planBalance: unavailable,
      receipt: unavailable,
      prices: unavailable,
      quote: unavailable,
      evmFees: unavailable,
    },
    'ed25519:11111111111111111111111111111111',
  );
}

/**
 * The key 1Click signs quotes with. Both modes use 1Click's own signature format (verified
 * 2026-11-11). In mock mode the key is the simulator's; in live mode it is
 * 1Click's published key, unless ONECLICK_QUOTE_KEY overrides it (for a key rotation).
 */
export function oneclickQuoteKey(config: Config, w: WorldConfig): string {
  if (config.ONECLICK_MODE === 'live') return config.ONECLICK_QUOTE_KEY ?? ONECLICK_LIVE_QUOTE_KEY;
  return simulatorPublicKey(Buffer.from(w.oneclickSecretHex, 'hex'));
}

/** Assets the 1Click simulator quotes: local USDC plus every launched plan token. */
async function simAssets(db: Db, w: WorldConfig): Promise<SimAsset[]> {
  const rows = await db.select().from(plans);
  const tokens = new Map<string, SimAsset>();
  tokens.set(`nep141:${w.usdc}`, {
    assetId: `nep141:${w.usdc}`,
    symbol: 'USDC',
    decimals: 6,
    blockchain: 'near',
    contractAddress: w.usdc,
  });
  for (const r of rows) {
    const assetId = assetIdFor(r.tokenChain, r.tokenAddress);
    tokens.set(assetId, {
      assetId,
      symbol: r.tokenSymbol,
      decimals: r.tokenDecimals,
      blockchain: r.tokenChain === 'near' ? 'near' : 'eth',
      contractAddress: r.tokenAddress,
    });
  }
  return [...tokens.values()];
}

export async function openEngine(config: Config, db: Db, log: Engine['log']): Promise<Engine> {
  return createEngine(config, db, await loadWorld(db), log);
}
