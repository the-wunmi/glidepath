// One process of a crash test (crash.test.ts): attaches an engine to the test's world (which
// resumes any workflow a killed process left), then runs one operation. VSP_CRASH_AT makes the
// process kill itself (SIGKILL) at a named point inside that operation.

import { OPERATOR } from '../src/guards.ts';
import { loadConfig, unfinishedWorkflows } from '../src/index.ts';
import { finalizePlan, requestCancel } from '../src/plans.ts';
import { SANDBOX_MS_PER_BLOCK } from '../src/world.ts';
import { attachEngine, sealedPlan, until } from './harness.ts';

const op = process.argv[2] ?? 'boot';
const world = await attachEngine(loadConfig(process.env), { clearHistory: false });
const { e } = world;

/** Moves the world on until the process is killed; reaching the end means no crash happened. */
const runUntilKilled = (planId: number) =>
  until(e, 'a crash that never came', async () => false, { planId, turns: 120 });

switch (op) {
  case 'boot': {
    // Whatever the killed process left resumes on launch; wait until all of it has finished.
    const deadline = Date.now() + 240_000;
    while ((await unfinishedWorkflows()).length > 0) {
      if (Date.now() > deadline) throw new Error('recovered workflows did not finish');
      await new Promise((r) => setTimeout(r, 1_000));
    }
    break;
  }
  case 'deliver':
    // Killed in deliver_plan, right after the enclave accepted the plan.
    await sealedPlan(e, { chain: 'near', symbol: 'CRD' });
    break;
  case 'execute': {
    // Killed in relay_execute, right after the sale landed on NEAR.
    const { planId } = await sealedPlan(e, { chain: 'near', symbol: 'CRX' });
    await runUntilKilled(planId);
    break;
  }
  case 'evm': {
    // Killed in broadcast_evm, right after the signed transfer went to the EVM node.
    const { planId } = await sealedPlan(e, { chain: 'evm', symbol: 'CRE' });
    await runUntilKilled(planId);
    break;
  }
  case 'reveal': {
    // Killed in reveal_plan, right after the terms were published on NEAR.
    const { planId } = await sealedPlan(e, {
      chain: 'near',
      symbol: 'CRV',
      disclosure: 'end_reveal',
    });
    await requestCancel(e, OPERATOR, planId, { actor: e.world.founder });
    await e.near.fastForward(Math.ceil(660_000 / SANDBOX_MS_PER_BLOCK));
    await finalizePlan(e, planId);
    await new Promise((r) => setTimeout(r, 120_000));
    break;
  }
  default:
    throw new Error(`unknown op ${op}`);
}

await world.close();
process.exit(0);
