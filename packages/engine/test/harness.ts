import { createServer } from 'node:net';
import {
  canonicalJson,
  type Envelope,
  envelopeJson,
  newSaltHex,
  parseInput,
  planCommitment,
  SealedPlan,
  type SealedPlanInput,
  sealTo,
  toBaseUnits,
} from '@glidepath/core';
import { createDb, createPool } from '@glidepath/db';
import { runMigrations } from '@glidepath/db/migrate';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  bootstrapLocalWorld,
  type Config,
  createEngine,
  type Engine,
  identityOnlyEnclave,
  launchDurable,
  loadConfig,
  loadWorld,
  readSimSettings,
  type SimSettings,
  saveWorld,
  shutdownDurable,
  startLocalChains,
  systemDatabaseUrl,
  tickPlans,
  unfinishedWorkflows,
  writeSimSettings,
} from '../src/index.ts';
import { createPlan, launchToken, predictEvmTokenAddress } from '../src/plans.ts';

const DAY = 86_400_000;
export const tokens = (n: string) => toBaseUnits(n, 18);

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

export interface World {
  e: Engine;
  close: () => Promise<void>;
}

/** The test settings every engine in a test world shares (test processes and crash children). */
export const testEnv = (ports: { api: number; near: number; evm: number }) => ({
  // Tests always run on local nodes, whatever .env chooses for the app.
  NEAR_NETWORK: 'local',
  EVM_NETWORK: 'local',
  API_ORIGIN: `http://127.0.0.1:${ports.api}`,
  NEAR_SANDBOX_PORT: String(ports.near),
  EVM_NODE_PORT: String(ports.evm),
  SETTLE_IN_DOUBT_SECONDS: '2',
  EVM_STUCK_BLOCKS: '3',
  // Each test file (vitest worker) has its own data folder, so files can run side by side.
  DATA_DIR: `${process.env.TMPDIR ?? '/tmp'}/glidepath-engine-test-${process.env.VITEST_POOL_ID ?? 0}`,
  ...workerDatabase(),
});

/**
 * This test file's own database and DBOS system database, made from the suite's: test files run
 * in parallel, each with its own chains, so they must not share rows or workflows either.
 */
function workerDatabase() {
  const base = process.env.DATABASE_URL;
  if (!base) return {};
  const id = process.env.VITEST_POOL_ID ?? '0';
  const url = new URL(base);
  url.pathname = `${url.pathname}_w${id}`;
  const system = new URL(base);
  system.pathname = `${url.pathname}_dbos`;
  return { DATABASE_URL: url.toString(), DBOS_SYSTEM_DATABASE_URL: system.toString() };
}

/** Creates this file's database afresh (and drops its DBOS system database) before a world starts. */
export async function resetWorkerDatabase(databaseUrl: string): Promise<void> {
  const target = new URL(databaseUrl);
  const name = target.pathname.slice(1);
  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';
  const pool = createPool(admin.toString());
  try {
    await pool.query(`drop database if exists "${name}" with (force)`);
    await pool.query(`create database "${name}"`);
    await pool.query(`drop database if exists "${name}_dbos" with (force)`);
  } finally {
    await pool.end();
  }
}

/**
 * Starts the local chains, deploys everything and records the world in the test database. Returns
 * the config and a stop function; engines attach to the world with `attachEngine`.
 */
export async function prepareWorld(): Promise<{
  config: Config;
  stopChains: () => Promise<void>;
}> {
  const ports = { api: await freePort(), near: await freePort(), evm: await freePort() };
  const config = loadConfig({ ...process.env, ...testEnv(ports) });
  await resetWorkerDatabase(config.DATABASE_URL);
  await runMigrations(config.DATABASE_URL);
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  const chains = await startLocalChains(config);
  const { NearClient } = await import('@glidepath/near');
  const genesis = await new NearClient(chains.near.rpcUrl).genesisHash();
  const world = await bootstrapLocalWorld(
    chains,
    identityOnlyEnclave(config, db),
    config.EVM_CHAIN_ID,
  );
  await saveWorld(db, genesis, world);
  await pool.end();
  return { config, stopChains: () => chains.stop() };
}

/**
 * An engine on an existing world, as one server process would run it: DBOS launched (resuming any
 * workflow an earlier process left), the 1Click simulator served over HTTP so the engine talks to
 * it exactly as it would to the real API, and the simulated MPC network and 1Click moving on their
 * own. `clearHistory` drops DBOS's history first (a new world); a restarted process keeps it.
 */
export async function attachEngine(
  config: Config,
  opts: { clearHistory: boolean },
): Promise<World> {
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  const logs: string[] = [];
  const e = createEngine(config, db, await loadWorld(db), (m, d) =>
    logs.push(`${m} ${JSON.stringify(d ?? {})}`),
  );
  await launchDurable(e, {
    systemUrl: systemDatabaseUrl(config.DATABASE_URL, config.DBOS_SYSTEM_DATABASE_URL),
    clearHistory: opts.clearHistory,
    logLevel: 'error',
  });
  const app = new Hono();
  if (e.oneclickSim) app.route('/sim/1click', e.oneclickSim.routes);
  const server = serve({
    fetch: app.fetch,
    port: Number(new URL(config.API_ORIGIN).port),
    hostname: '127.0.0.1',
  });
  // The MPC network and 1Click answer on their own, as in the real worker: a call that waits on a
  // signature (execute, resign_evm) holds its turn until then.
  const mpc = setInterval(() => {
    void (async () => {
      if (e.mpcNode && (await readSimSettings(e.db)).mpcUp) await e.mpcNode.pass();
    })().catch(() => undefined);
  }, 1_000);
  const oneclick = setInterval(() => void e.oneclickSim?.advance().catch(() => undefined), 2_000);
  return {
    e,
    close: async () => {
      clearInterval(mpc);
      clearInterval(oneclick);
      await shutdownDurable();
      server.close();
      await pool.end();
    },
  };
}

/** One local world per test file: fresh chains, the contracts deployed, and an engine on them. */
export async function startWorld(): Promise<World> {
  const { config, stopChains } = await prepareWorld();
  const world = await attachEngine(config, { clearHistory: true });
  return {
    e: world.e,
    close: async () => {
      await world.close();
      await stopChains();
    },
  };
}

/**
 * One turn of the outside world, in a fixed order: the plan under test wakes (so plans from earlier
 * tests cannot take queued simulator outcomes), the MPC network and 1Click move on, and the
 * workflows (running on their own under DBOS) get a moment to follow.
 */
export async function turn(e: Engine, planId?: number): Promise<void> {
  await tickPlans(e, planId === undefined ? undefined : [planId]);
  if (e.mpcNode && (await readSimSettings(e.db)).mpcUp) await e.mpcNode.pass();
  await e.oneclickSim?.advance();
  await new Promise((r) => setTimeout(r, 500));
}

/** Runs turns until the condition holds, moving the chain a minute forward each time. */
export async function until<T>(
  e: Engine,
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  {
    turns = 40,
    advanceBlocks = 200,
    planId,
    pump = false,
  }: { turns?: number; advanceBlocks?: number; planId?: number; pump?: boolean } = {},
): Promise<T> {
  // A relay waiting on a yield (an MPC signature) holds its turn until blocks pass; pumping moves
  // the chain on in the background so a timeout can actually happen.
  // The sandbox's transaction validity window is 100 blocks, so pump in small steps or in-flight
  // transactions expire.
  const pumping = pump
    ? setInterval(() => void e.near.fastForward(5).catch(() => undefined), 250)
    : null;
  try {
    for (let i = 0; i < turns; i++) {
      const v = await fn();
      if (v) return v;
      if (advanceBlocks) await e.near.fastForward(advanceBlocks);
      await turn(e, planId);
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    if (pumping) clearInterval(pumping);
  }
  throw new Error(`Timed out: ${label}\n${await pendingJobs(e, planId)}`);
}

/** Workflows still running, so a timeout explains itself. */
async function pendingJobs(_e: Engine, planId?: number): Promise<string> {
  const rows = await unfinishedWorkflows();
  return rows
    .filter((r) => planId === undefined || r.id.includes(`:${planId}`))
    .map((r) => `  ${r.name} ${r.id} [${r.status}]`)
    .join('\n');
}

/** Several turns for one plan, the chain moving forward between them. */
export async function turns(e: Engine, planId: number, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await e.near.fastForward(300);
    await turn(e, planId);
  }
}

export async function updateSim(e: Engine, patch: (s: SimSettings) => void): Promise<void> {
  const s = await readSimSettings(e.db);
  patch(s);
  await writeSimSettings(e.db, s);
}

export interface PlanSetup {
  planId: number;
  /** The owner key createPlan handed out once, as the browser would keep it. */
  ownerKey: string;
  /** The salt the browser would keep in the owner's backup file. */
  salt: string;
  sealed: SealedPlanInput;
  envelope: Envelope;
}

/**
 * Creates, seals and launches a plan the way the browser does, with a fast schedule (sales a
 * minute apart at most) so a test sees sales without waiting.
 */
export async function sealedPlan(
  e: Engine,
  opts: {
    chain: 'near' | 'evm';
    symbol: string;
    listing?: string;
    floor?: string;
    disclosure?: 'realtime' | 'end_reveal';
    /** A NEAR token address other than the default `<symbol>.<root>`. */
    address?: string;
    /** False: create and seal the plan but launch nothing. */
    launch?: boolean;
  } = {
    chain: 'near',
    symbol: 'TST',
  },
): Promise<PlanSetup> {
  const identity = await e.enclave.identity();
  const now = await e.near.chainTimeMs();
  const founder = e.world.founder;
  const address =
    opts.chain === 'near'
      ? (opts.address ?? `${opts.symbol.toLowerCase()}.${e.world.root}`)
      : await predictEvmTokenAddress(e);
  const token =
    opts.chain === 'near'
      ? { chain: 'near' as const, address, symbol: opts.symbol, decimals: 18 }
      : {
          chain: 'evm' as const,
          chain_id: e.world.evmChainId,
          address,
          symbol: opts.symbol,
          decimals: 18,
        };
  const beneficiaryEvm =
    opts.chain === 'evm' ? { evm_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' } : {};
  const sealed: SealedPlanInput = {
    version: 1,
    token,
    beneficiary: { near_account: founder, asset: `nep141:${e.world.usdc}`, ...beneficiaryEvm },
    allocation: tokens('1000000').toString(),
    period_days: 30,
    max_sell_per_period_bps: 500,
    max_sell_per_tx_bps: 50,
    price_floor_usd: opts.floor ?? '1.00',
    max_slippage_bps: 100,
    venues: ['1click'],
    schedule: { mode: 'randomized', min_gap_minutes: 0, max_gap_minutes: 1 },
    start: new Date(now).toISOString(),
    end: new Date(now + 365 * DAY).toISOString(),
    on_end: 'release_remaining_to_beneficiary',
    price_sources: ['1click_quote', 'binance', 'coinbase'],
    price_agreement_bps: 200,
  };
  const envelope: Envelope = {
    period_ms: 30 * DAY,
    max_amount_per_period: tokens('100000'),
    max_amount_per_tx: tokens('10000'),
    min_price_usd_e6: 500_000n,
    min_gap_ms: 0,
  };
  const plan = parseInput(SealedPlan, sealed);
  const salt = newSaltHex();
  const box = sealTo(
    identity.encryptionKeyHex,
    JSON.stringify({ plan: JSON.parse(canonicalJson(plan)), salt }),
  );
  const { planId, ownerKey } = await createPlan(e, {
    actor: founder,
    label: `${opts.symbol} test plan`,
    token,
    beneficiary: { near_account: founder, ...beneficiaryEvm },
    proceeds_asset: `nep141:${e.world.usdc}`,
    envelope: envelopeJson(envelope),
    disclosure: { type: opts.disclosure ?? 'realtime' },
    cooling_off_ms: 600_000,
    start_ms: Date.parse(sealed.start),
    end_ms: Date.parse(sealed.end),
    commitment: planCommitment(plan, salt),
    sealed_box: box,
  });
  await until(
    e,
    'plan acknowledged',
    async () => (await e.registry.plan(planId))?.status === 'active',
    { advanceBlocks: 0, planId },
  );
  if (!ownerKey) throw new Error('A new plan comes with its owner key');
  if (opts.launch === false) return { planId, ownerKey, sealed, envelope, salt };
  await launchToken(e, { operator: false, planKey: ownerKey }, planId, {
    actor: founder,
    name: `${opts.symbol} token`,
    team_allocation: tokens('1000000').toString(),
    founder_allocation: tokens('1000').toString(),
    listing_price_usd: opts.listing ?? '2.00',
  });
  return { planId, ownerKey, sealed, envelope, salt };
}

/** Talks to the local Hardhat node directly, to stall and release transactions in tests. */
export async function evmRpc(e: Engine, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(e.world.evmRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** Mines n EVM blocks with a base fee no sane transfer would pay, so pending ones stay stuck. */
export async function mineExpensiveBlocks(e: Engine, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await evmRpc(e, 'hardhat_setNextBlockBaseFeePerGas', [`0x${(100n * 10n ** 9n).toString(16)}`]);
    await evmRpc(e, 'evm_mine');
  }
}
