import { createDb, createPool } from '@glidepath/db';
import { runMigrations } from '@glidepath/db/migrate';
import {
  bootstrapLocalWorld,
  bootstrapTrustWorld,
  createEngine,
  identityOnlyEnclave,
  launchDurable,
  liveModeProblems,
  loadConfig,
  loadDeployment,
  loadTrustDeployment,
  saveWorld,
  seedTrustMarket,
  shutdownDurable,
  startLocalChains,
  startTrustWorker,
  startWorker,
  systemDatabaseUrl,
  testnetWorld,
  type WorldConfig,
} from '@glidepath/engine';
import { SEPOLIA_CHAIN_ID, startEvmNode } from '@glidepath/evm';
import { NearClient } from '@glidepath/near';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';

/** Nothing listens here: a stray EVM call fails at once instead of reaching some other host. */
const EVM_OFF_RPC_URL = 'http://127.0.0.1:9';

const log = (message: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...data }));

const config = loadConfig();
const problems = liveModeProblems(config);
if (problems.length) {
  for (const p of problems) log('configuration problem', { problem: p });
  process.exit(1);
}

await runMigrations(config.DATABASE_URL);
const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);

let world: WorldConfig;
let worldId: string;
let stopChains: () => Promise<unknown>;
if (config.NEAR_NETWORK === 'testnet') {
  // NEAR is the public testnet (the deployed registry, the real Chain Signatures signer). EVM is
  // Sepolia, off, or a local Hardhat node on a developer machine (never on a server).
  const deployment = loadDeployment(config);
  log('using NEAR testnet', {
    registry: deployment.registry,
    rpc: new URL(config.NEAR_RPC_URL).host,
    evm: config.EVM_NETWORK,
  });
  const evm =
    config.EVM_NETWORK === 'local'
      ? await startEvmNode(config.EVM_NODE_PORT)
      : {
          // With EVM off the client still needs a URL; the API refuses every EVM route first.
          rpcUrl: config.EVM_NETWORK === 'sepolia' ? config.EVM_RPC_URL : EVM_OFF_RPC_URL,
          stop: async () => {},
        };
  world = testnetWorld(config, deployment, {
    rpcUrl: evm.rpcUrl,
    chainId: config.EVM_NETWORK === 'sepolia' ? SEPOLIA_CHAIN_ID : config.EVM_CHAIN_ID,
  });
  // The blind trust prototype (Labs), where `pnpm trust:deploy` has deployed it.
  world.trust = loadTrustDeployment(config.DEPLOYMENTS_DIR);
  // Pruned testnet nodes do not serve block 0, so the world is named by its registry.
  worldId = `testnet:${deployment.registry}`;
  stopChains = () => evm.stop();
} else {
  log('starting local chains', { near: config.NEAR_SANDBOX_PORT, evm: config.EVM_NODE_PORT });
  const chains = await startLocalChains(config);
  worldId = await new NearClient(chains.near.rpcUrl).genesisHash();
  log('deploying contracts and seeding the local world');
  const enclaveIdentity = identityOnlyEnclave(config, db);
  world = await bootstrapLocalWorld(chains, enclaveIdentity, config.EVM_CHAIN_ID);
  // The blind trust prototype (Labs) on the same local world.
  world.trust = await bootstrapTrustWorld(
    new NearClient(chains.near.rpcUrl),
    world,
    await enclaveIdentity.identity(),
  );
  stopChains = () => chains.stop();
}
const freshWorld = await saveWorld(db, worldId, world);
if (world.trust) await seedTrustMarket(db, world.trust);
const e = createEngine(config, db, world, log);
// DBOS resumes any workflow an earlier process of this same world left unfinished. A new world
// (new genesis) starts with no workflow history: the old one acted on a chain that is gone.
await launchDurable(e, {
  systemUrl: systemDatabaseUrl(config.DATABASE_URL, config.DBOS_SYSTEM_DATABASE_URL),
  clearHistory: freshWorld,
  logLevel: config.DBOS_LOG_LEVEL,
});
const worker = startWorker(e);
const stopTrustWorker = startTrustWorker(e);

const server = serve(
  { fetch: createApp(e).fetch, port: config.API_PORT, hostname: config.API_HOST },
  (info) => log('api listening', { port: info.port, registry: world.registry }),
);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  log('shutting down');
  server.close();
  // A job can be waiting on a chain call (an MPC signature); shutdown must not wait for it.
  const within = (p: Promise<unknown>, ms: number) =>
    Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  stopTrustWorker();
  await within(worker.stop(), 5_000);
  await within(shutdownDurable(), 5_000);
  await within(stopChains(), 20_000);
  await within(pool.end(), 5_000);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
