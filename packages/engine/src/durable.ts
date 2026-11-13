import { DBOS, Error as DBOSErrors } from '@dbos-inc/dbos-sdk';
import { DrizzleDataSource } from '@dbos-inc/drizzle-datasource';
import { type createPool, type Db, type Schema, schema, type Tx } from '@vsp/db';
import pg from 'pg';
import type { Engine } from './context.ts';

/**
 * Durable work on DBOS. A workflow's steps are checkpointed in DBOS's system database; a process
 * that dies mid-workflow resumes it from the last completed step when it starts again. Database
 * writes inside a workflow run as transaction steps through the Drizzle data source, so a write and
 * its checkpoint commit together (exactly once). Every outside
 * effect (enclave delivery, a NEAR transaction, an EVM broadcast, a 1Click call) is a step, and
 * each also stays safe to repeat on its own terms, because a step runs again if the process dies
 * between the effect and its checkpoint: the registry's sequence numbers and status checks, the
 * EVM nonce, and reading the chain before sending.
 */

/**
 * Recorded with every workflow; recovery resumes only workflows of the same version. Bump it when a
 * workflow's steps change order or meaning, after finishing or cancelling old pending workflows.
 */
export const WORKFLOW_VERSION = 'vsp-1';

let current: { engine: Engine; ds: DrizzleDataSource<Db>; prefix: string } | undefined;

/** The engine the workflows run against: one per process, as DBOS is. */
export function durableEngine(): Engine {
  if (!current) throw new Error('DBOS is not launched: launch the engine first');
  return current.engine;
}

/** DBOS's system database: its own database next to the app's (`<db>_dbos`), unless set. */
export function systemDatabaseUrl(databaseUrl: string, override?: string): string {
  if (override) return override;
  const url = new URL(databaseUrl);
  url.pathname = `/${url.pathname.slice(1) || 'salesplans'}_dbos`;
  return url.toString();
}

/**
 * Drops DBOS's system database: every workflow it held belonged to a chain that no longer exists
 * (a new genesis hash). Cancelling them would leave history that a later recovery or a version bump
 * could still act on, against accounts and nonces that are gone; dropping it means the new world
 * starts with no workflow history at all. DBOS recreates the database on launch.
 */
export async function clearDurableHistory(systemUrl: string): Promise<void> {
  const name = new URL(systemUrl).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unexpected system database name: ${name}`);
  const admin = new URL(systemUrl);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`drop database if exists ${name} with (force)`);
  } finally {
    await client.end();
  }
}

/**
 * Launches DBOS for this engine. Interrupted workflows from a previous process of the same world
 * resume in the background as soon as DBOS launches. Workflow ids carry the world's genesis hash, so
 * a fresh world never meets an old world's ids.
 */
export async function launchDurable(
  engine: Engine,
  opts: { systemUrl: string; clearHistory: boolean; logLevel?: string },
): Promise<void> {
  if (current) throw new Error('DBOS is already launched in this process');
  await import('./workflows.ts');
  if (opts.clearHistory) await clearDurableHistory(opts.systemUrl);
  const ds = new DrizzleDataSource<Db>(
    'app',
    (engine.db as Db & { $client: ReturnType<typeof createPool> }).$client,
    schema as Schema,
  );
  // Ids carry the world: the sandbox's genesis hash locally (a new one every start), the registry
  // on testnet (pruned nodes do not serve the genesis block, and a registry is one world).
  const prefix =
    engine.world.network === 'testnet'
      ? engine.world.registry
      : (await engine.near.genesisHash()).slice(0, 10);
  current = { engine, ds, prefix };
  DBOS.setConfig({
    name: 'salesplans',
    systemDatabaseUrl: opts.systemUrl,
    applicationVersion: WORKFLOW_VERSION,
    logLevel: opts.logLevel ?? 'warn',
  });
  await DBOS.launch();
  // Every workflow start goes through one queue whose start rate is capped: a restart that
  // resumes many workflows at once, or a burst of sales, cannot flood a public testnet RPC. No
  // concurrency cap: some workflows wait minutes (an MPC signature, a 1Click swap) and must not
  // hold a slot others need.
  await DBOS.registerQueue(CHAIN_QUEUE, { rateLimit: { limitPerPeriod: 5, periodSec: 1 } });
}

/** The queue every workflow starts on (see launchDurable). */
export const CHAIN_QUEUE = 'chain';

export async function shutdownDurable(): Promise<void> {
  if (!current) return;
  current = undefined;
  await DBOS.shutdown();
}

/** A workflow id from our own idempotency key, prefixed with the world, so a repeat is a no-op. */
export function wfId(key: string): string {
  if (!current) throw new Error('DBOS is not launched');
  return `${current.prefix}:${key}`;
}

/**
 * Starts a workflow once under our key and does not wait for it: a second start with the same key
 * returns the first run. The workflow runs, sleeps and retries on its own, and resumes after a
 * restart.
 */
export async function startOnce<Args extends unknown[], R>(
  workflow: (...args: Args) => Promise<R>,
  key: string,
  ...args: Args
): Promise<void> {
  await DBOS.startWorkflow(workflow, { workflowID: wfId(key), queueName: CHAIN_QUEUE })(...args);
}

/**
 * Runs `fn` in an app-database transaction. Inside a workflow it is a DBOS transaction step: its
 * writes and its checkpoint commit together, so it happens exactly once.
 */
export function inTx<T>(name: string, fn: (db: Tx) => Promise<T>): Promise<T> {
  if (!current) throw new Error('DBOS is not launched');
  const { ds } = current;
  return ds.runTransaction(() => fn(ds.client as unknown as Tx), {
    name,
    isolationLevel: 'read committed',
  });
}

/** A read of the chain, the enclave or the database, checkpointed so a replay sees what it saw. */
export function readStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return DBOS.runStep(fn, { name, retriesAllowed: true, maxAttempts: 5, intervalSeconds: 1 });
}

/**
 * An outside effect as a step. A thrown error (no answer) is never a failure: the workflow sleeps
 * and runs the step again, and the step itself checks the outside world first, so a repeat after
 * an effect that did land does not send it twice. Only DBOS's own control errors pass through.
 */
export async function effect<T>(name: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await DBOS.runStep(
        async () => {
          const value = await fn();
          crashPoint(`effect:${name}`);
          return value;
        },
        { name },
      );
    } catch (err) {
      if (isWorkflowControl(err)) throw err;
      current?.engine.log('effect in doubt; trying again', { effect: name, error: String(err) });
      await DBOS.sleep(Math.min(30_000, 1_000 * 2 ** i));
    }
  }
}

/** A durable pause: the workflow's sleep survives a restart (it wakes at the same wall time). */
export const sleep = (ms: number) => DBOS.sleep(ms);

/** DBOS signals cancellation and recovery with its own errors; those must pass through. */
export function isWorkflowControl(err: unknown): boolean {
  return (
    err instanceof DBOSErrors.DBOSError && !(err instanceof DBOSErrors.DBOSMaxStepRetriesError)
  );
}

/**
 * A test hook: kill the process at a named point, as a crash would (SIGKILL, no cleanup). Points
 * named `effect:<name>` fire right after an effect and before its checkpoint, the worst place.
 */
export function crashPoint(name: string): void {
  const at = process.env.VSP_CRASH_AT;
  if (!at || at !== name) return;
  process.kill(process.pid, 'SIGKILL');
}

/** Workflows of this world that have not finished, for diagnostics and the crash tests. */
export async function unfinishedWorkflows(): Promise<
  { id: string; name: string; status: string }[]
> {
  const rows = await DBOS.listWorkflows({ status: ['PENDING', 'ENQUEUED'] });
  return rows.map((w) => ({ id: w.workflowID, name: w.workflowName, status: w.status }));
}

export { DBOS };
