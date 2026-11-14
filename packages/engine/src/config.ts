import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The repo's .data directory, whatever the working directory of the process. */
export const REPO_DATA_DIR = fileURLToPath(new URL('../../../.data', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A DATA_DIR as the app uses it: relative paths are taken from the repo root, not the cwd. */
export const resolveDataDir = (dir: string): string =>
  isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir);

export const LOCAL_DATABASE_URL = 'postgres://salesplans:salesplans@localhost:5437/salesplans';

const Mode = z.enum(['mock', 'live']).default('mock');

/** `KEY=` in .env means unset, not an empty value. */
const unsetIfEmpty = <S extends z.ZodType>(schema: S) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

/**
 * Where the plans live: the public testnet by default; `local` runs nodes on this machine
 * (near-sandbox, Hardhat) for tests and offline work.
 */
export const NearNetwork = z.enum(['local', 'testnet']).default('testnet');
/** `off` serves no EVM plans (a server never starts Hardhat); `sepolia` needs a funded key. */
export const EvmNetwork = z.enum(['local', 'sepolia', 'off']).default('sepolia');

/** The repo's deployments directory (`pnpm deploy:testnet` writes testnet.json there). */
export const REPO_DEPLOYMENTS_DIR = fileURLToPath(new URL('../../../deployments', import.meta.url));

/**
 * Configuration. Systems we have real access to run for real: NEAR (a local node, or testnet with
 * the real Chain Signatures signer), EVM (a local Hardhat node, or Sepolia), and exchange
 * prices for listed tokens. Two stay simulated because there is no testnet to reach: 1Click
 * (mainnet only) and the OutLayer enclave (paid in mainnet USDC). Both are labelled wherever they
 * appear.
 */
export const Config = z.object({
  /** The docker-compose Postgres (project glidepath, port 5437) unless set. */
  DATABASE_URL: z.string().min(1).default(LOCAL_DATABASE_URL),
  /** DBOS's system database (workflow checkpoints); default `<DATABASE_URL's db>_dbos`. */
  DBOS_SYSTEM_DATABASE_URL: z.string().optional(),
  DBOS_LOG_LEVEL: z.string().optional(),
  API_PORT: z.coerce.number().int().default(4400),
  /**
   * Loopback by default: founder actions sign with keys this process holds. A container sets
   * 0.0.0.0 and publishes the port on the host's loopback instead.
   */
  API_HOST: z.string().default('127.0.0.1'),
  /**
   * The public https URL behind the reverse proxy. When set, writes from any other origin are
   * refused, X-Forwarded-For is trusted and writes are rate-limited per client address.
   */
  PUBLIC_ORIGIN: z
    .string()
    .optional()
    .transform((v) => v?.replace(/\/$/, '') || undefined),
  WEB_ORIGIN: z.string().default('http://localhost:3400'),
  /**
   * API only: `Authorization: Bearer <token>` manages any plan and the demo controls, and lets a
   * script write without an Origin. Unset, nobody is the operator.
   */
  OPERATOR_TOKEN: unsetIfEmpty(z.string().min(24).optional()),
  /** Testnet only: spending actions answer busy while the relayer holds less NEAR than this. */
  NEAR_RESERVE: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default('2'),
  /** Sepolia only: EVM launches answer busy while the funder holds less ETH than this. */
  EVM_RESERVE: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default('0.05'),
  /**
   * NEAR-token plans (each launch deploys a NEP-141 token). Unset: on locally; on testnet only
   * when deployments/testnet.json records a published global demo token (else ~1.9 NEAR a launch).
   */
  NEAR_TOKEN_LAUNCHES: unsetIfEmpty(z.enum(['on', 'off']).optional()),
  /** Where the API serves itself to its own simulators (1Click routes live under /sim). */
  API_ORIGIN: z.string().default('http://127.0.0.1:4400'),

  NEAR_NETWORK: NearNetwork,
  NEAR_SANDBOX_PORT: z.coerce.number().int().default(4420),
  /** Testnet RPC. FastNEAR's public endpoint; any NEAR testnet RPC works. */
  NEAR_RPC_URL: z.string().default('https://test.rpc.fastnear.com'),
  /** Further public endpoints, comma-separated, used while the first rests after a 429. */
  NEAR_RPC_FALLBACK_URLS: z.string().default('https://near-testnet.drpc.org'),
  /** Requests per second to any one public endpoint. */
  NEAR_RPC_MAX_PER_SECOND: z.coerce.number().positive().default(8),
  /** The account that relays enclave-signed requests and, on testnet, acts as the demo founder. */
  RELAYER_ACCOUNT_ID: unsetIfEmpty(z.string().optional()),
  RELAYER_PRIVATE_KEY: unsetIfEmpty(z.string().optional()),
  DEPLOYMENTS_DIR: z.string().default(REPO_DEPLOYMENTS_DIR),

  EVM_NETWORK: EvmNetwork,
  EVM_NODE_PORT: z.coerce.number().int().default(4430),
  /** The local node's chain id; Sepolia is always 11155111. */
  EVM_CHAIN_ID: z.coerce.number().int().default(31337),
  /** Sepolia only (local uses its own node). */
  EVM_RPC_URL: z.string().default('https://ethereum-sepolia-rpc.publicnode.com'),
  EVM_RPC_FALLBACK_URLS: z
    .string()
    .default('https://1rpc.io/sepolia,https://sepolia.gateway.tenderly.co,https://0xrpc.io/sep'),
  /** Sepolia only: tried first for visitors' reads (/rpc/evm, next addresses), then EVM_RPC_URL's list. */
  EVM_PROXY_RPC_URL: unsetIfEmpty(z.string().url().optional()),
  /**
   * Sepolia only: pays for token deployments and each plan address's gas. The launchpad key that
   * deploys tokens is derived from it.
   */
  EVM_FUNDER_PRIVATE_KEY: unsetIfEmpty(
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
  ),

  /** 1Click has no testnet: `live` is mainnet only and refused on testnet. */
  ONECLICK_MODE: Mode,
  ONECLICK_BASE_URL: z.string().default('https://1click.chaindefuser.com'),
  ONECLICK_JWT: unsetIfEmpty(z.string().optional()),
  /** Overrides 1Click's published quote key in live mode (default: ONECLICK_LIVE_QUOTE_KEY). */
  ONECLICK_QUOTE_KEY: unsetIfEmpty(z.string().optional()),

  /**
   * Tokens priced from Binance and Coinbase (keyless), as `SYMBOL:PAIR` pairs. Any other token (a
   * demo token has no market) is priced on the simulated market the 1Click simulator also uses.
   */
  LIVE_PRICE_SYMBOLS: z.string().default('NEAR:NEAR,wNEAR:NEAR'),

  /** Seconds between enclave wake-ups. The enclave still decides whether a sale is due. */
  ENCLAVE_TICK_SECONDS: z.coerce.number().int().min(1).default(5),
  /**
   * `outlayer` runs the module recorded in deployments/outlayer-testnet.json on OutLayer's TDX
   * workers, paid by the relayer (testnet only); `simulated` runs the enclave in-process. Unset,
   * see `loadConfig`.
   */
  ENCLAVE_BACKEND: z.enum(['simulated', 'outlayer']).default('simulated'),
  /**
   * OutLayer only: least seconds between runs for one plan. Each run is a paid transaction (about
   * 0.002 NEAR), so a sale can come up to this late.
   */
  OUTLAYER_TICK_SECONDS: z.coerce.number().int().min(10).default(600),
  /**
   * A swap with no final 1Click status this long after its deposit is shown as in doubt. It is
   * still polled until 1Click answers; "in doubt" is never treated as failed.
   */
  SETTLE_IN_DOUBT_SECONDS: z.coerce.number().int().min(1).default(600),
  /** EVM blocks an MPC-signed transfer may sit unmined before the engine re-signs it with higher fees. */
  EVM_STUCK_BLOCKS: z.coerce.number().int().min(1).default(12),
  /**
   * Directory for local, non-chain state (the simulated enclave hardware secret). A relative path is
   * taken from the repo root, so the API (run from apps/api) and the scripts (run from the root)
   * share one secret.
   */
  DATA_DIR: z.string().default(REPO_DATA_DIR).transform(resolveDataDir),
});
export type Config = z.output<typeof Config>;

/** Listed symbols as a map from our symbol to the exchange pair's base symbol. */
export const livePricePairs = (c: Config): Map<string, string> =>
  new Map(
    c.LIVE_PRICE_SYMBOLS.split(',')
      .map((x) => x.trim().split(':'))
      .filter((x): x is [string, string] => !!x[0] && !!x[1])
      .map(([ours, pair]) => [ours, pair]),
  );

/** Say exactly what is missing for the chosen networks rather than failing later. */
export function liveModeProblems(c: Config): string[] {
  const problems: string[] = [];
  if (c.NEAR_NETWORK === 'testnet') {
    for (const key of ['RELAYER_ACCOUNT_ID', 'RELAYER_PRIVATE_KEY'] as const)
      if (!c[key]) problems.push(`NEAR_NETWORK=testnet needs ${key} in .env`);
    if (c.ONECLICK_MODE === 'live')
      problems.push(
        '1Click has no testnet: ONECLICK_MODE=live is for mainnet, which is out of scope',
      );
  }
  if (c.ENCLAVE_BACKEND === 'outlayer' && c.NEAR_NETWORK !== 'testnet')
    problems.push('ENCLAVE_BACKEND=outlayer needs NEAR_NETWORK=testnet: OutLayer runs there');
  if (c.EVM_NETWORK === 'off' && c.NEAR_NETWORK === 'local')
    problems.push(
      'EVM_NETWORK=off is for NEAR testnet: the local world always runs a Hardhat node',
    );
  if (c.EVM_NETWORK === 'sepolia' && !c.EVM_FUNDER_PRIVATE_KEY)
    problems.push('EVM_NETWORK=sepolia needs EVM_FUNDER_PRIVATE_KEY in .env');
  if (c.EVM_NETWORK === 'sepolia' && c.NEAR_NETWORK === 'local')
    problems.push('Sepolia needs NEAR testnet: the real Chain Signatures signer lives there');
  if (c.NEAR_NETWORK === 'local' && c.ONECLICK_MODE === 'live')
    problems.push('Live 1Click needs a public NEAR network: the sandbox cannot reach it');
  return problems;
}

/**
 * Unless ENCLAVE_BACKEND is set, a production server on testnet uses the real enclave (and needs its
 * OutLayer deployment record); development, tests and the local world use the simulator, since every
 * OutLayer run spends testnet NEAR.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Config.parse(env);
  if (env.ENCLAVE_BACKEND) return parsed;
  const productionTestnet = env.NODE_ENV === 'production' && parsed.NEAR_NETWORK === 'testnet';
  if (!productionTestnet) return parsed;
  // A public server must never fall back to the simulator unnoticed: without the OutLayer record
  // it refuses to start unless ENCLAVE_BACKEND=simulated is set on purpose.
  if (!existsSync(`${parsed.DEPLOYMENTS_DIR}/outlayer-testnet.json`))
    throw new Error(
      `No ${parsed.DEPLOYMENTS_DIR}/outlayer-testnet.json: run pnpm outlayer:enclave, or set ENCLAVE_BACKEND=simulated to run the labelled simulator`,
    );
  return { ...parsed, ENCLAVE_BACKEND: 'outlayer' };
}
