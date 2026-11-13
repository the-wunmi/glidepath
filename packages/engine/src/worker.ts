/**
 * The loops that are not durable work: the enclave's wake-ups (its schedule and state live sealed
 * inside the enclave, so a missed tick only means it decides at the next one), and the simulated
 * MPC network and 1Click. Everything a tick decides to do outside (relay a sale, relay an ack) is
 * started as a DBOS workflow under its own key (workflows.ts).
 */
import { sha256Hex } from '@vsp/core';
import { executions } from '@vsp/db';
import { and, eq } from 'drizzle-orm';
import type { Engine } from './context.ts';
import { startOnce, wfId } from './durable.ts';
import { readSimSettings } from './sim-settings.ts';
import { record } from './timeline.ts';
import { relayAckWorkflow, relayExecuteWorkflow, revealPlanWorkflow } from './workflows.ts';

async function evmTransferInFlight(e: Engine, planId: number): Promise<boolean> {
  const rows = await e.db
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.planId, planId), eq(executions.status, 'on_chain')))
    .limit(1);
  return rows.length > 0;
}

/** Plans whose enclave wake-up is running, so one plan's ticks never overlap. */
const ticking = new Set<number>();
/** Remembers the last reason a plan skipped, so the timeline is not flooded with repeats. */
const lastSkip = new Map<number, string>();

/** Reveal workflows this process has already started (world-prefixed ids: plan ids repeat). */
const revealsStarted = new Set<string>();

/** One enclave wake-up for every active plan (or only those `only` names, in tests). */
export async function tickPlans(e: Engine, only?: number[]): Promise<void> {
  const all = await e.registry.plans();
  // Anyone may finalize a plan, not only this app: an end_reveal plan that ended without us still
  // gets its terms published (the workflow is keyed by plan, so this is a no-op if it exists).
  for (const p of all) {
    if (p.status !== 'ended' || p.disclosure.type !== 'end_reveal') continue;
    const id = wfId(`reveal:${p.id}`);
    if (revealsStarted.has(id)) continue;
    revealsStarted.add(id);
    await startOnce(revealPlanWorkflow, `reveal:${p.id}`, p.id);
  }
  const active = all.filter((p) => p.status === 'active' && (!only || only.includes(p.id)));
  await Promise.all(
    active.map(async (plan) => {
      if (ticking.has(plan.id)) return;
      // EVM nonces are ordered and the registry re-signs only the latest transfer, so an ERC-20
      // plan takes no new sale while its previous transfer is still unmined.
      if (plan.asset.type !== 'nep141' && (await evmTransferInFlight(e, plan.id))) return;
      ticking.add(plan.id);
      try {
        const result = await e.enclave.tick(plan);
        if (result.type === 'execute') {
          const kind = plan.asset.type === 'nep141' ? 'nep141_transfer' : 'evm_erc20_transfer';
          const request = JSON.parse(result.request.json) as {
            settlement: { deposit_address: string; min_amount_out: string };
          };
          const inserted = await e.db
            .insert(executions)
            .values({
              planId: plan.id,
              seq: result.seq,
              kind,
              amount: result.amount.toString(),
              correlationId: result.quote.correlationId,
              depositAddress: request.settlement.deposit_address,
              minAmountOut: request.settlement.min_amount_out,
              quote: result.quote,
              requestJson: result.request.json,
              signature: result.request.signature,
              enclaveKey: result.request.enclaveKey,
              status: 'signed',
            })
            // A sale the registry refused leaves its seq unused; the enclave signs that seq again,
            // and the new request replaces the refused one instead of being dropped.
            .onConflictDoUpdate({
              target: [executions.planId, executions.seq],
              set: {
                amount: result.amount.toString(),
                correlationId: result.quote.correlationId,
                depositAddress: request.settlement.deposit_address,
                minAmountOut: request.settlement.min_amount_out,
                quote: result.quote,
                requestJson: result.request.json,
                signature: result.request.signature,
                enclaveKey: result.request.enclaveKey,
                status: 'signed',
                chainTx: null,
                chainError: null,
                updatedAt: new Date(),
              },
              setWhere: eq(executions.status, 'refused'),
            })
            .returning({ id: executions.id });
          if (inserted.length) {
            await record(
              e.db,
              plan.id,
              'sale_signed',
              `The enclave signed sale #${result.seq} inside the sealed plan`,
              { seq: result.seq },
            );
            await startOnce(
              relayExecuteWorkflow,
              `exec:${plan.id}:${result.seq}:${sha256Hex(result.request.json).slice(0, 16)}`,
              plan.id,
              result.seq,
            );
          }
          lastSkip.delete(plan.id);
        } else if (result.type === 'ack_change') {
          const commitment = (JSON.parse(result.ack.json) as { commitment: string }).commitment;
          await startOnce(relayAckWorkflow, `ack:${plan.id}:${commitment}`, {
            planId: plan.id,
            ackJson: result.ack.json,
            signature: result.ack.signature,
            enclaveKey: result.ack.enclaveKey,
          });
        } else if (result.type === 'skipped') {
          // The reasons (price under the floor, sources disagreeing) would reveal the sealed plan,
          // so they stay inside the enclave; the timeline only says a sale was skipped.
          if (lastSkip.get(plan.id) !== 'skipped') {
            lastSkip.set(plan.id, 'skipped');
            await record(
              e.db,
              plan.id,
              'sale_skipped',
              'A scheduled sale was skipped; the enclave will try again at a random later time',
            );
          }
        }
      } catch (error) {
        // Only the first line reaches the plan's timeline; the full error goes to the log.
        const full = error instanceof Error ? error.message : String(error);
        const reason = full.split('\n')[0]?.slice(0, 200) ?? '';
        // Block heights and numbers change every tick; compare the message without them.
        if (lastSkip.get(plan.id) !== reason.replace(/\d+/g, '#')) {
          lastSkip.set(plan.id, reason.replace(/\d+/g, '#'));
          e.log('enclave tick failed', { planId: plan.id, error: full });
          await record(e.db, plan.id, 'enclave_unavailable', reason);
        }
      } finally {
        ticking.delete(plan.id);
      }
    }),
  );
}

export interface Worker {
  stop: () => Promise<void>;
}

/** Starts the loops: enclave ticks, and the simulated MPC network and 1Click. */
export function startWorker(e: Engine): Worker {
  const timers: NodeJS.Timeout[] = [];
  const loops: Promise<void>[] = [];
  let stopping = false;
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let running = false;
    timers.push(
      setInterval(() => {
        if (running || stopping) return;
        running = true;
        const p = fn()
          .then(() => undefined)
          .catch((error) =>
            e.log(`${name} failed`, {
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          .finally(() => {
            running = false;
          });
        loops.push(p);
      }, ms),
    );
  };
  every(e.config.ENCLAVE_TICK_SECONDS * 1_000, 'enclave', () => tickPlans(e));
  if (e.mpcNode) {
    const node = e.mpcNode;
    every(1_000, 'mpc', async () => {
      if ((await readSimSettings(e.db)).mpcUp) await node.pass();
    });
  }
  if (e.oneclickSim) {
    const sim = e.oneclickSim;
    every(2_000, '1click-sim', () => sim.advance());
  }
  return {
    stop: async () => {
      stopping = true;
      for (const t of timers) clearInterval(t);
      await Promise.allSettled(loops);
    },
  };
}
