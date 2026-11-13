import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPool } from '@vsp/db';
import { type ChainPlan, type ChainReceipt, NearClient } from '@vsp/near';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, clearDurableHistory, systemDatabaseUrl } from '../src/index.ts';
import type { WorldConfig } from '../src/world.ts';
import { prepareWorld } from './harness.ts';

/**
 * Crash tests: a real process is killed (SIGKILL, no cleanup) in the middle of a workflow, then a
 * new process attaches to the same world and databases. DBOS resumes the workflow from its last
 * checkpoint; the test checks the work finished and that no effect happened twice. Each kill lands
 * right after the outside effect and before DBOS records it, the worst place: the resumed step must
 * find its own effect (on the chain, in the enclave) instead of making it again.
 */

const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

let config: Config;
let stopChains: () => Promise<void>;
let db: ReturnType<typeof createPool>;
let system: ReturnType<typeof createPool>;
let near: NearClient;
let world: WorldConfig;

/** The env a child needs to attach to this world: the test databases and the world's ports. */
const childEnv = () => ({
  NEAR_NETWORK: 'local',
  EVM_NETWORK: 'local',
  DATABASE_URL: config.DATABASE_URL,
  DBOS_SYSTEM_DATABASE_URL: systemDatabaseUrl(config.DATABASE_URL, config.DBOS_SYSTEM_DATABASE_URL),
  API_ORIGIN: config.API_ORIGIN,
  NEAR_SANDBOX_PORT: String(config.NEAR_SANDBOX_PORT),
  EVM_NODE_PORT: String(config.EVM_NODE_PORT),
  SETTLE_IN_DOUBT_SECONDS: '2',
  EVM_STUCK_BLOCKS: '3',
  DATA_DIR: config.DATA_DIR,
});

function run(op: string, crashAt?: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>(
    (resolve) => {
      const child = spawn(TSX, [CHILD, op], {
        env: { ...process.env, ...childEnv(), ...(crashAt ? { VSP_CRASH_AT: crashAt } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.stderr.on('data', (d) => {
        out += d;
      });
      child.on('exit', (code, signal) => resolve({ code, signal, out: out.slice(-4000) }));
    },
  );
}

/** Kills a process at `crashAt` during `op`, then boots a fresh one, which must finish the work. */
async function crashThenRecover(op: string, crashAt: string) {
  const crashed = await run(op, crashAt);
  // tsx relays the killed process as exit code 137 (128 + SIGKILL).
  expect(crashed.signal === 'SIGKILL' || crashed.code === 137, crashed.out).toBe(true);
  const recovered = await run('boot');
  expect(recovered.code, recovered.out).toBe(0);
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query(sql, params)).rows[0]?.n ?? 0);

const planIdOf = async (symbol: string) => {
  const rows = (await db.query('select id from plans where token_symbol = $1', [symbol])).rows;
  expect(rows).toHaveLength(1);
  return Number(rows[0]?.id);
};

const timeline = (planId: number, kind: string) =>
  count('select count(*) n from activity where plan_id = $1 and kind = $2', [planId, kind]);

/** Every workflow of this kind for the plan, by status. */
const workflowStatuses = async (kind: string, planId: number) =>
  (
    await system.query(
      'select status from dbos.workflow_status where name = $1 and workflow_uuid like $2',
      [kind, `%:${planId}%`],
    )
  ).rows.map((r) => r.status as string);

const receipts = (planId: number) =>
  near.view<ChainReceipt[]>(world.registry, 'get_receipts', {
    plan_id: planId,
    from_seq: 0,
    limit: 50,
  });

beforeAll(async () => {
  ({ config, stopChains } = await prepareWorld());
  await clearDurableHistory(
    systemDatabaseUrl(config.DATABASE_URL, config.DBOS_SYSTEM_DATABASE_URL),
  );
  db = createPool(config.DATABASE_URL);
  world = (await db.query('select config from world where id = 1')).rows[0]?.config as WorldConfig;
  near = new NearClient(world.nearRpcUrl);
  // The first boot creates DBOS's system database.
  const booted = await run('boot');
  expect(booted.code, booted.out).toBe(0);
  system = createPool(systemDatabaseUrl(config.DATABASE_URL, config.DBOS_SYSTEM_DATABASE_URL));
}, 600_000);

afterAll(async () => {
  await db?.end();
  await system?.end();
  await stopChains?.();
});

describe('a process killed mid-workflow', () => {
  it('plan delivery: the enclave accepts once, the plan is acked once and goes active', async () => {
    await crashThenRecover('deliver', 'effect:enclave accept');
    const planId = await planIdOf('CRD');
    const plan = await near.view<ChainPlan>(world.registry, 'get_plan', { plan_id: planId });
    expect(plan.status).toBe('active');
    expect(plan.acked_at_ms).toBeTruthy();
    expect(await timeline(planId, 'plan_active')).toBe(1);
    expect(await workflowStatuses('deliver_plan', planId)).toEqual(['SUCCESS']);
  }, 600_000);

  it('a sale on NEAR: the registry executes it once, it settles once', async () => {
    await crashThenRecover('execute', 'effect:execute');
    const planId = await planIdOf('CRX');
    const onChain = await receipts(planId);
    expect(onChain.filter((r) => r.kind === 'sale')).toHaveLength(1);
    expect(onChain[0]?.status).toBe('done');
    expect(await count('select count(*) n from executions where plan_id = $1', [planId])).toBe(1);
    expect(
      (await db.query('select status from executions where plan_id = $1', [planId])).rows[0]
        ?.status,
    ).toBe('settled');
    expect(await timeline(planId, 'sale_executed')).toBe(1);
    expect(await timeline(planId, 'sale_settled')).toBe(1);
    expect(await workflowStatuses('relay_execute', planId)).toEqual(['SUCCESS']);
    expect(await workflowStatuses('settle', planId)).toEqual(['SUCCESS']);
  }, 600_000);

  it('an EVM broadcast: the plan address sends one transfer, which is mined and settles once', async () => {
    await crashThenRecover('evm', 'effect:evm send');
    const planId = await planIdOf('CRE');
    const plan = await near.view<ChainPlan>(world.registry, 'get_plan', { plan_id: planId });
    const sent = await fetch(world.evmRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionCount',
        params: [plan.evm_address, 'latest'],
      }),
    }).then((r) => r.json() as Promise<{ result: string }>);
    // One sale signed, one transaction from the plan's address mined (nonce 0 used once).
    expect(Number(sent.result)).toBe(1);
    expect((await receipts(planId)).filter((r) => r.kind === 'sale')).toHaveLength(1);
    expect(await timeline(planId, 'evm_broadcast')).toBe(1);
    expect(await timeline(planId, 'sale_settled')).toBe(1);
    expect(await workflowStatuses('broadcast_evm', planId)).toEqual(['SUCCESS']);
  }, 600_000);

  it('the end-of-plan reveal: published once, recorded once', async () => {
    await crashThenRecover('reveal', 'effect:reveal on chain');
    const planId = await planIdOf('CRV');
    const reveal = await near.view<{ plan_json: string } | null>(world.registry, 'get_reveal', {
      plan_id: planId,
    });
    expect(JSON.parse(reveal?.plan_json ?? '{}').token?.symbol).toBe('CRV');
    expect(await timeline(planId, 'plan_revealed')).toBe(1);
    expect(await workflowStatuses('reveal_plan', planId)).toEqual(['SUCCESS']);
  }, 600_000);
});
