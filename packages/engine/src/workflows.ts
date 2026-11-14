import { signatureParts } from '@vsp/chainsig';
import { DomainError, maxBig, type SealedBox } from '@vsp/core';
import { activity, executions, plans, type Tx } from '@vsp/db';
import type { BackupBox, BackupOutcome } from '@vsp/enclave';
import { SALE_GAS } from '@vsp/evm';
import type { ChainEnclave, ChainPlan, ChainReceipt, KeyPairString } from '@vsp/near';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  type Hex,
  keccak256,
  parseTransaction,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem';
import { chargePlan, isServerAccount, personasOf } from './budget.ts';
import type { Engine } from './context.ts';
import {
  crashPoint,
  DBOS,
  durableEngine,
  effect,
  inTx,
  readStep,
  sleep,
  startOnce,
} from './durable.ts';
import { authorizePlan, type PlanPrincipal } from './guards.ts';
import { ownerCall, revealOnChain } from './plans.ts';
import { record } from './timeline.ts';

/**
 * The engine's durable work, one DBOS workflow per outside job. Each is started under our own key
 * (`deliver:<plan>`, `exec:<plan>:<seq>:<hash>`, …), so starting it twice is a no-op, and resumes
 * from its last checkpoint after a crash. Waiting and polling are durable sleeps inside the
 * workflow; nothing here is a table of jobs.
 */

const NEAR = 10n ** 24n;
/** Covers a receipt's storage (about 1.5 KB) plus a 0.00125 NEAR registration; the rest is refunded. */
const EXECUTE_DEPOSIT = NEAR / 20n;
/** Covers the storage an ack or change adds; the registry refunds what it does not use. */
export const STORAGE_DEPOSIT = NEAR / 20n;
/** A 1Click swap normally settles in seconds; once in doubt it is polled slowly, never dropped. */
const SETTLE_POLL_MS = 3_000;
const IN_DOUBT_POLL_MS = 30_000;
/** How often an unmined EVM transfer is checked. */
const EVM_POLL_MS = 3_000;
/** Waits for something that clears by itself: a pause lifting, a key activating, a signature. */
const TRANSIENT_WAIT_MS = 10_000;
/** Re-signed fees rise by at least an eighth, the registry's minimum bump (12.5%). */
const FEE_BUMP_NUM = 9n;
const FEE_BUMP_DEN = 8n;
/** The registry's own caps on EVM fees; a re-sign never asks for more. */
const MAX_FEE_PER_GAS = 500_000_000_000n;
/** NEAR blocks the registry requires between signatures of the same transfer. */
const RESIGN_SPACING_BLOCKS = 30;

/** Refusals that clear by themselves: the workflow sleeps and tries again instead of giving up. */
const TRANSIENT_REFUSALS = new Set([
  'paused',
  'enclave_not_active',
  'not_started',
  'sign_pending',
  'quote_signer_not_set',
  'quote_signer_not_active',
]);

/** Execution statuses. Once a row exists, only `transition` changes them. */
export type ExecutionStatus =
  | 'signed'
  | 'on_chain'
  | 'broadcast'
  | 'settling'
  | 'settled'
  | 'refunded'
  | 'settlement_failed'
  | 'in_doubt'
  | 'refused'
  | 'failed_on_chain';

/** Moves an execution only from the statuses given, so late or repeated signals cannot undo it. */
export async function transition(
  db: Tx,
  planId: number,
  seq: number,
  from: ExecutionStatus[],
  to: ExecutionStatus,
  set: Partial<typeof executions.$inferInsert> = {},
): Promise<boolean> {
  const rows = await db
    .update(executions)
    .set({ ...set, status: to, updatedAt: new Date() })
    .where(
      and(eq(executions.planId, planId), eq(executions.seq, seq), inArray(executions.status, from)),
    )
    .returning({ id: executions.id });
  return rows.length > 0;
}

const relayer = (e: Engine) =>
  e.near.account(e.world.relayer, e.world.keys[e.world.relayer] as KeyPairString);

/**
 * An execution row as plain JSON values: step results are checkpointed as JSON, so a replayed step
 * must return the same shape a fresh one does (no Date objects).
 */
async function loadExecution(e: Engine, planId: number, seq: number) {
  const [row] = await e.db
    .select()
    .from(executions)
    .where(and(eq(executions.planId, planId), eq(executions.seq, seq)));
  if (!row) return null;
  const { createdAt, updatedAt: _updated, quote: _quote, ...rest } = row;
  return { ...rest, createdAtMs: createdAt.getTime() };
}

/** Puts each backup build's answer on the plan's timeline: whether it can stand in. */
async function recordBackups(planId: number, outcomes: BackupOutcome[] | undefined, what: string) {
  for (const b of outcomes ?? [])
    await inTx(`record backup ${b.signingKey}`, (db) =>
      b.ok
        ? record(
            db,
            planId,
            'backup_ready',
            `A backup enclave build holds its own sealed copy of ${what} and can stand in`,
            { enclaveKey: b.signingKey },
          )
        : record(
            db,
            planId,
            'backup_failed',
            `A backup enclave build could not take ${what}: ${b.reasons.join('; ')}`,
            { enclaveKey: b.signingKey },
          ),
    );
}

/** Backup copies as the API stored them (`signing_key`, `sealed_box`), for the enclave. */
function backupBoxes(stored: unknown): BackupBox[] {
  return ((stored ?? []) as { signing_key: string; sealed_box: SealedBox }[]).map((b) => ({
    signingKey: b.signing_key,
    box: b.sealed_box,
  }));
}

/** The broadcastable transfer the receipt holds now: its unsigned transaction plus MPC signature. */
function signedEvmTransfer(receipt: ChainReceipt): Hex | null {
  if (!receipt.evm_unsigned_tx || !receipt.evm_signature) return null;
  // The registry stores hex without 0x.
  const tx = parseTransaction(
    `0x${receipt.evm_unsigned_tx.replace(/^0x/, '')}` as Hex,
  ) as TransactionSerializableEIP1559;
  return serializeTransaction(
    tx,
    signatureParts({
      scheme: 'Secp256k1',
      big_r: { affine_point: receipt.evm_signature.big_r },
      s: { scalar: receipt.evm_signature.s },
      recovery_id: receipt.evm_signature.recovery_id,
    }),
  );
}

/** Rounds a bump up so it always clears the registry's 12.5% minimum. */
const bumped = (fee: bigint) => (fee * FEE_BUMP_NUM + FEE_BUMP_DEN - 1n) / FEE_BUMP_DEN;

/**
 * A follow-up started before its transaction waits here for the transaction's effect to show on
 * the chain: polled with durable sleeps, given up after `maxMs` (the transaction was refused, or
 * never sent). The start time is checkpointed, so a resumed workflow keeps the same deadline.
 */
export async function waitForChain<T>(
  label: string,
  check: () => Promise<T | null | undefined | false>,
  maxMs = 30 * 60_000,
): Promise<T | null> {
  const started = await readStep(`${label}: started`, async () => Date.now());
  for (;;) {
    const found = await readStep(label, async () => (await check()) || null);
    if (found) return found as T;
    const now = await readStep(`${label}: now`, async () => Date.now());
    if (now - started > maxMs) return null;
    await sleep(5_000);
  }
}

type AckOutcome = { ok: true; txHash: string | null } | { ok: false; code: string; txHash: string };

/**
 * Relays an enclave ack. The step first asks the chain whether this commitment is already acked
 * (a repeat after a crash finds its own earlier ack and sends nothing), then sends it; a refusal
 * that clears by itself makes the workflow sleep and try again.
 */
async function relayAckUntilAnswered(
  planId: number,
  ack: { json: string; signature: string; enclaveKey: string },
  isAcked: (plan: ChainPlan) => boolean,
): Promise<AckOutcome> {
  const e = durableEngine();
  for (;;) {
    const out = await effect('ack_plan', async (): Promise<AckOutcome> => {
      const chain = await e.registry.plan(planId);
      if (chain && isAcked(chain)) return { ok: true, txHash: null };
      // A key still in its public delay would be refused: wait without paying for a refused tx.
      const enclaves = await e.near.view<ChainEnclave[]>(e.world.registry, 'get_enclaves', {
        limit: 50,
      });
      const key = enclaves.find((x) => x.public_key === ack.enclaveKey);
      if (key && key.active_from_ms > (await e.near.chainTimeMs()))
        return { ok: false, code: 'enclave_not_active', txHash: '' };
      const sent = await e.near.call(
        relayer(e),
        e.world.registry,
        'ack_plan',
        {
          plan_id: planId,
          ack_json: ack.json,
          signature: ack.signature,
          enclave_key: ack.enclaveKey,
        },
        { gasTera: 100, deposit: STORAGE_DEPOSIT },
      );
      return sent.ok
        ? { ok: true, txHash: sent.txHash }
        : { ok: false, code: sent.code, txHash: sent.txHash };
    });
    if (out.ok || !TRANSIENT_REFUSALS.has(out.code)) return out;
    await sleep(TRANSIENT_WAIT_MS);
  }
}

// ── deliver_plan ────────────────────────────────────────────────────────────────────────────

/** Hands a new plan's sealed box to the enclave, then relays its ack so the plan goes active. */
async function deliverPlan(planId: number): Promise<string> {
  const e = durableEngine();
  for (;;) {
    const chain = await readStep('read plan', () => e.registry.plan(planId));
    if (!chain) return 'plan not found';
    if (chain.status !== 'awaiting_ack') return 'not awaiting an ack';
    if (chain.asset.type !== 'evm_erc20' || chain.evm_address) break;
    // The Chain Signatures address arrives in a later block.
    await sleep(2_000);
  }
  const accepted = await effect('enclave accept', async () => {
    const [row] = await e.db.select().from(plans).where(eq(plans.id, planId));
    const chain = await e.registry.plan(planId);
    if (!row || !chain) return { ok: false as const, reasons: ['Plan not found'] };
    return e.enclave.acceptPlan(chain, row.sealedBox as SealedBox, backupBoxes(row.backupBoxes));
  });
  if (!accepted.ok) {
    await inTx('record enclave refusal', (db) =>
      record(
        db,
        planId,
        'enclave_refused',
        `The enclave refused the plan: ${accepted.reasons.join('; ')}`,
      ),
    );
    return 'enclave refused';
  }
  await recordBackups(planId, accepted.backups, 'the plan');
  const out = await relayAckUntilAnswered(planId, accepted.ack, (p) => p.status !== 'awaiting_ack');
  crashPoint('deliver:acked');
  await inTx('record ack', (db) =>
    out.ok
      ? record(
          db,
          planId,
          'plan_active',
          'The enclave opened the sealed plan, matched the commitment and envelope, and acknowledged it on-chain',
          { txHash: out.txHash },
        )
      : record(db, planId, 'ack_refused', `The registry refused the enclave's ack: ${out.code}`, {
          txHash: out.txHash,
        }),
  );
  return out.ok ? 'active' : out.code;
}
export const deliverPlanWorkflow = DBOS.registerWorkflow(deliverPlan, { name: 'deliver_plan' });

// ── deliver_change ──────────────────────────────────────────────────────────────────────────

/** Hands a plan change to the enclave, which holds it until the cooling-off is over. */
async function deliverChange(planId: number, commitment: string): Promise<string> {
  const e = durableEngine();
  // Started before the change is sent: wait for it on the chain (a refused change never shows).
  const onChain = await waitForChain('change on chain', async () => {
    const chain = await e.registry.plan(planId);
    return chain?.pending_change?.commitment === commitment || chain?.commitment === commitment;
  });
  if (!onChain) return 'change never reached the chain';
  const staged = await effect('enclave stage change', async () => {
    const [row] = await e.db.select().from(plans).where(eq(plans.id, planId));
    const chain = await e.registry.plan(planId);
    if (!row?.pendingSealedBox || !chain) return null;
    return e.enclave.stageChange(
      chain,
      row.pendingSealedBox as SealedBox,
      backupBoxes(row.pendingBackupBoxes),
    );
  });
  if (!staged) return 'nothing to stage';
  if (staged.ok) await recordBackups(planId, staged.backups, 'the change');
  await inTx('record staged change', (db) =>
    staged.ok
      ? record(
          db,
          planId,
          'change_staged',
          'The enclave holds the new plan; it applies only after the cooling-off',
        )
      : record(
          db,
          planId,
          'enclave_refused',
          `The enclave refused the change: ${staged.reasons.join('; ')}`,
        ),
  );
  return staged.ok ? 'staged' : 'enclave refused';
}
export const deliverChangeWorkflow = DBOS.registerWorkflow(deliverChange, {
  name: 'deliver_change',
});

// ── relay_ack (an applied change) ───────────────────────────────────────────────────────────

export interface ChangeAck {
  planId: number;
  ackJson: string;
  signature: string;
  enclaveKey: string;
}

/** Relays the enclave's ack of a change that has taken effect, then the app follows the chain. */
async function relayAck(input: ChangeAck): Promise<string> {
  const commitment = (JSON.parse(input.ackJson) as { commitment: string }).commitment;
  const out = await relayAckUntilAnswered(
    input.planId,
    { json: input.ackJson, signature: input.signature, enclaveKey: input.enclaveKey },
    (p) => p.commitment === commitment && !p.pending_change,
  );
  if (!out.ok) {
    await inTx('record change ack refusal', (db) =>
      record(db, input.planId, 'ack_refused', `The registry refused the change ack: ${out.code}`, {
        txHash: out.txHash,
      }),
    );
    return out.code;
  }
  await inTx('apply change', async (db) => {
    const [row] = await db.select().from(plans).where(eq(plans.id, input.planId));
    if (row?.pendingSealedBox)
      await db
        .update(plans)
        .set({ commitment, sealedBox: row.pendingSealedBox, pendingSealedBox: null })
        .where(eq(plans.id, input.planId));
    await record(db, input.planId, 'change_applied', 'Cooling-off over: the new plan is in force', {
      txHash: out.txHash,
    });
  });
  return 'applied';
}
export const relayAckWorkflow = DBOS.registerWorkflow(relayAck, { name: 'relay_ack' });

// ── relay_execute ───────────────────────────────────────────────────────────────────────────

type ExecuteOutcome =
  | { kind: 'executed'; txHash: string | null; receiptStatus: string }
  | { kind: 'refused'; code: string; txHash: string };

/**
 * Relays an enclave-signed sale to the registry. The registry's sequence number makes it land at
 * most once; a repeat after a crash first reads the chain, and if the receipt for this seq holds
 * our exact request, the sale already landed and nothing is sent.
 */
async function relayExecute(planId: number, seq: number): Promise<string> {
  const e = durableEngine();
  const ex = await readStep('read execution', () => loadExecution(e, planId, seq));
  if (ex?.status !== 'signed') return 'not signed';
  let out: ExecuteOutcome;
  for (;;) {
    out = await effect('execute', async (): Promise<ExecuteOutcome> => {
      const before = await e.registry.receipt(planId, seq);
      if (before?.request_json === ex.requestJson)
        return { kind: 'executed', txHash: null, receiptStatus: before.status };
      const sent = await e.near.call(
        relayer(e),
        e.world.registry,
        'execute',
        {
          plan_id: planId,
          request_json: ex.requestJson,
          signature: ex.signature,
          enclave_key: ex.enclaveKey,
        },
        { gasTera: 300, deposit: EXECUTE_DEPOSIT },
      );
      const receipt = await e.registry.receipt(planId, seq);
      // A lost response can come back as bad_seq; if the chain holds our request, it landed.
      if (receipt?.request_json === ex.requestJson)
        return { kind: 'executed', txHash: sent.txHash, receiptStatus: receipt.status };
      if (sent.ok) return { kind: 'executed', txHash: sent.txHash, receiptStatus: 'failed' };
      return { kind: 'refused', code: sent.code, txHash: sent.txHash };
    });
    if (out.kind === 'refused' && TRANSIENT_REFUSALS.has(out.code)) {
      await sleep(TRANSIENT_WAIT_MS);
      continue;
    }
    break;
  }
  if (out.kind === 'refused') {
    const refused = out;
    await inTx('record refusal', async (db) => {
      await transition(db, planId, seq, ['signed'], 'refused', {
        chainTx: refused.txHash,
        chainError: refused.code,
      });
      await record(
        db,
        planId,
        'sale_refused',
        `The registry refused sale #${seq}: ${refused.code}`,
        {
          txHash: refused.txHash,
        },
      );
    });
    return 'refused';
  }
  // The relayer paid for this execute: a founder's plan pays it back from its budget.
  if (out.txHash) {
    const kind = ex.kind === 'evm_erc20_transfer' ? 'evm_execute' : 'execute';
    const executeTx = out.txHash;
    await inTx('charge execute', (db) => chargePlan(db, personasOf(e), planId, kind, executeTx));
  }
  let status = out.receiptStatus;
  // An EVM sale's receipt stays pending until the MPC signature arrives.
  while (status === 'pending') {
    await sleep(2_000);
    status =
      (await readStep('receipt status', () => e.registry.receipt(planId, seq)))?.status ?? 'failed';
  }
  const txHash = out.txHash;
  if (status !== 'done') {
    await inTx('record failure', async (db) => {
      await transition(db, planId, seq, ['signed'], 'failed_on_chain', {
        chainTx: txHash,
        chainError: 'action_failed',
      });
      await record(
        db,
        planId,
        'sale_failed',
        `Sale #${seq} was accepted but its transfer or signature failed; the registry rolled it back`,
        { txHash },
      );
    });
    return 'failed on chain';
  }
  await inTx('record execution', async (db) => {
    await transition(db, planId, seq, ['signed'], 'on_chain', { chainTx: txHash });
    await record(
      db,
      planId,
      'sale_executed',
      `Sale #${seq} executed by the registry and receipted on-chain`,
      { txHash, seq },
    );
  });
  if (ex.kind === 'evm_erc20_transfer')
    await startOnce(broadcastEvmWorkflow, `broadcast:${planId}:${seq}`, planId, seq);
  else await startOnce(settleWorkflow, `settle:${planId}:${seq}`, planId, seq);
  return 'on chain';
}
export const relayExecuteWorkflow = DBOS.registerWorkflow(relayExecute, { name: 'relay_execute' });

// ── broadcast_evm (and resign_evm) ────────────────────────────────────────────────────────────

/**
 * Sends the MPC-signed ERC-20 transfer and watches it until it is mined. If it sits unmined for
 * EVM_STUCK_BLOCKS (fees too low), it asks the registry (as the plan's owner) to re-sign the same
 * transfer with higher fees and sends that. Whatever the receipt holds now is what gets sent, and
 * a repeated send of the same signed bytes is a no-op on the EVM chain (same nonce, same hash).
 */
async function broadcastEvm(planId: number, seq: number): Promise<string> {
  const e = durableEngine();
  for (;;) {
    const ex = await readStep('read execution', () => loadExecution(e, planId, seq));
    if (ex?.status !== 'on_chain') return 'not on chain';
    const receipt = await readStep('read receipt', () => e.registry.receipt(planId, seq));
    const signed = receipt ? signedEvmTransfer(receipt) : null;
    if (!receipt || !signed) {
      await sleep(EVM_POLL_MS);
      continue;
    }
    const hash = keccak256(signed);
    if (hash !== ex.evmTxHash) {
      // The first send, or the receipt was re-signed (by us or by the owner): send this one.
      const sentAt = await effect('evm send', async () => {
        await e.evm.send(signed);
        return e.evm.blockNumber();
      });
      await inTx('record evm send', (db) =>
        db
          .update(executions)
          .set({ evmTxHash: hash, evmSentAtBlock: sentAt, updatedAt: new Date() })
          .where(and(eq(executions.planId, planId), eq(executions.seq, seq))),
      );
      await sleep(EVM_POLL_MS);
      continue;
    }
    const mined = await readStep('evm receipt', () => e.evm.receiptOf(hash));
    if (mined?.status === 'success') {
      await inTx('record evm mined', async (db) => {
        await transition(db, planId, seq, ['on_chain'], 'broadcast');
        await record(
          db,
          planId,
          'evm_broadcast',
          `MPC-signed ERC-20 transfer for sale #${seq} confirmed on the EVM chain`,
          { evmTxHash: hash },
        );
      });
      await startOnce(settleWorkflow, `settle:${planId}:${seq}`, planId, seq);
      return 'mined';
    }
    if (mined?.status === 'reverted') {
      await inTx('record evm revert', async (db) => {
        await transition(db, planId, seq, ['on_chain'], 'settlement_failed');
        await record(
          db,
          planId,
          'evm_reverted',
          `The signed EVM transfer for sale #${seq} reverted`,
          {
            evmTxHash: hash,
          },
        );
      });
      return 'reverted';
    }
    const block = await readStep('evm block', () => e.evm.blockNumber());
    if (block - (ex.evmSentAtBlock ?? 0) >= e.config.EVM_STUCK_BLOCKS)
      await resignStuck(e, planId, seq, receipt);
    await sleep(EVM_POLL_MS);
  }
}
export const broadcastEvmWorkflow = DBOS.registerWorkflow(broadcastEvm, { name: 'broadcast_evm' });

// ── release_evm ─────────────────────────────────────────────────────────────────────────────

/**
 * After an ERC-20 plan ends, moves what its Chain Signatures address still holds to the
 * beneficiary's EVM address: the owner asks the registry (`release_evm`) to have the MPC network
 * sign one transfer of the whole balance, which is then broadcast and watched like a sale's. The
 * plan's latest receipt says where a repeat stands: a release still being signed is waited for, a
 * signed one is sent (a resend is the same bytes and hash), and only then is the balance read and
 * a new release requested, so a crash never asks for two.
 */
async function releaseEvm(planId: number): Promise<string> {
  const e = durableEngine();
  for (;;) {
    const plan = await readStep('read plan', () => e.registry.plan(planId));
    if (plan?.asset.type !== 'evm_erc20' || !plan.evm_address) return 'not an EVM plan';
    if (plan.status !== 'ended') return 'not ended';
    const token = plan.asset.token_address as Hex;
    const holder = plan.evm_address as Hex;
    const last =
      plan.next_seq > 0
        ? await readStep('read last receipt', () => e.registry.receipt(planId, plan.next_seq - 1))
        : null;
    if (last?.kind === 'release' && last.status === 'pending') {
      await sleep(TRANSIENT_WAIT_MS);
      continue;
    }
    const signed = last?.kind === 'release' && last.status === 'done' && signedEvmTransfer(last);
    if (signed) {
      const hash = keccak256(signed);
      const mined = await readStep('evm receipt', () => e.evm.receiptOf(hash));
      if (!mined) {
        const sentAt = await effect('evm send', async () => {
          await e.evm.send(signed);
          return e.evm.blockNumber();
        });
        for (;;) {
          await sleep(EVM_POLL_MS);
          if (await readStep('evm receipt', () => e.evm.receiptOf(hash))) break;
          const block = await readStep('evm block', () => e.evm.blockNumber());
          if (block - sentAt >= e.config.EVM_STUCK_BLOCKS) {
            await resignStuck(e, planId, last.seq, last, `The release (#${last.seq})`);
            break;
          }
        }
        // Mined, or re-signed with higher fees: either way the next round reads the receipt again.
        continue;
      }
      if (mined.status === 'success' && !(await releaseRecorded(e, planId, hash)))
        await inTx('record release mined', (db) =>
          record(
            db,
            planId,
            'evm_released',
            `The remaining tokens were transferred to the beneficiary on the EVM chain (release #${last.seq})`,
            { evmTxHash: hash, seq: last.seq },
          ),
        );
      if (mined.status === 'reverted') {
        await inTx('record release revert', (db) =>
          record(db, planId, 'evm_reverted', `The signed release (#${last.seq}) reverted`, {
            evmTxHash: hash,
          }),
        );
        return 'reverted';
      }
    }
    const left = await readStep('plan token balance', async () =>
      (await e.evm.tokenBalance(token, holder)).toString(),
    );
    if (left === '0') return 'released';
    const fees = await readStep('evm fees', async () => {
      const f = await e.evm.fees();
      return { max: f.maxFeePerGas.toString(), tip: f.maxPriorityFeePerGas.toString() };
    });
    // Sales are funded for their own gas; the release may find the address short after many.
    await effect('fund release gas', async () => {
      const need = SALE_GAS * BigInt(fees.max);
      await e.evm.ensureBalance(holder, need, await e.evm.gasCostWei(SALE_GAS));
      return null;
    });
    // A founder's own plan: only their wallet (or the beneficiary's) may ask for the release, so
    // the timeline says so once and this waits for the request to show on chain.
    if (!isServerAccount(personasOf(e), plan.owner)) {
      await noteOnce(
        planId,
        'release_needed',
        'The plan has ended: the owner or beneficiary signs the release of the remaining tokens',
      );
      await sleep(OWNER_WAIT_MS);
      continue;
    }
    const out = await effect('release_evm', async () => {
      // Someone (the owner or beneficiary, or a repeat of this step) may already have asked.
      const now = await e.registry.plan(planId);
      if (now && now.next_seq !== plan.next_seq) return { ok: true as const, txHash: null };
      return ownerCall(
        e,
        plan.owner,
        e.world.registry,
        'release_evm',
        {
          plan_id: planId,
          amount: left,
          nonce: plan.evm_nonce,
          gas_limit: Number(SALE_GAS),
          max_fee_per_gas: fees.max,
          max_priority_fee_per_gas: fees.tip,
        },
        { gasTera: 300, deposit: EXECUTE_DEPOSIT },
      );
    });
    if (!out.ok) {
      if (TRANSIENT_REFUSALS.has(out.code)) {
        await sleep(TRANSIENT_WAIT_MS);
        continue;
      }
      await inTx('record release refusal', (db) =>
        record(
          db,
          planId,
          'release_refused',
          `The registry refused to release the remaining tokens: ${out.code}`,
          { txHash: out.txHash },
        ),
      );
      return out.code;
    }
    if (out.txHash)
      await inTx('record release request', (db) =>
        record(
          db,
          planId,
          'release_requested',
          'The registry asked the MPC network to sign the release of the remaining tokens',
          { txHash: out.txHash },
        ),
      );
  }
}
export const releaseEvmWorkflow = DBOS.registerWorkflow(releaseEvm, { name: 'release_evm' });

/** How often a workflow waiting on the owner's wallet looks at the chain again. */
const OWNER_WAIT_MS = 60_000;

/** Records a timeline entry unless it is already the plan's latest one (a durable step). */
async function noteOnce(planId: number, kind: string, message: string) {
  await inTx(`note ${kind}`, async (db) => {
    const [last] = await db
      .select({ kind: activity.kind })
      .from(activity)
      .where(eq(activity.planId, planId))
      .orderBy(desc(activity.id))
      .limit(1);
    if (last?.kind !== kind) await record(db, planId, kind, message);
  });
}

/** Whether a mined release is already on the timeline, so a repeated run of the workflow (a later
 * finalize) does not record it twice. */
async function releaseRecorded(e: Engine, planId: number, evmTxHash: string): Promise<boolean> {
  return readStep('release recorded', async () => {
    const rows = await e.db
      .select({ id: activity.id })
      .from(activity)
      .where(
        and(
          eq(activity.planId, planId),
          eq(activity.kind, 'evm_released'),
          sql`${activity.data}->>'evmTxHash' = ${evmTxHash}`,
        ),
      );
    return rows.length > 0;
  });
}

/**
 * Asks the registry (as the plan's owner) to re-sign a stuck transfer: same recipient, amount and
 * nonce, fees at least 12.5% higher and at least what the network wants now, never above the caps.
 * A repeat after a crash is skipped by the 30-block spacing, which the registry also enforces, so it
 * never re-signs twice in a row; the next loop sends whatever the receipt then holds.
 */
async function resignStuck(
  e: Engine,
  planId: number,
  seq: number,
  receipt: ChainReceipt,
  /** Subject of the activity messages; the release passes its own. */
  what = `Sale #${seq}`,
) {
  const head = await readStep(
    'near head',
    async () => (await e.near.provider.viewBlock({ finality: 'final' })).header.height,
  );
  if (receipt.evm_signed_at_block && head - receipt.evm_signed_at_block < RESIGN_SPACING_BLOCKS)
    return;
  const plan = await readStep('read plan', () => e.registry.plan(planId));
  if (!plan) return;
  // Only the owner's wallet (or the beneficiary's) may re-sign a founder's own plan's transfer.
  if (!isServerAccount(personasOf(e), plan.owner)) {
    await noteOnce(
      planId,
      'evm_resign_needed',
      `${what} is stuck below the network's fees: the owner signs a re-sign with higher fees`,
    );
    return;
  }
  const network = await readStep('evm fees', async () => {
    const f = await e.evm.fees();
    return { max: f.maxFeePerGas.toString(), tip: f.maxPriorityFeePerGas.toString() };
  });
  const maxFee = maxBig(bumped(BigInt(receipt.evm_max_fee_per_gas ?? '0')), BigInt(network.max));
  const tip = maxBig(
    bumped(BigInt(receipt.evm_max_priority_fee_per_gas ?? '0')),
    BigInt(network.tip),
  );
  if (maxFee > MAX_FEE_PER_GAS || tip > maxFee) {
    await inTx('record evm stuck', (db) =>
      record(
        db,
        planId,
        'evm_stuck',
        `${what} is stuck and its fees cannot rise further within the registry's caps`,
      ),
    );
    return;
  }
  const out = await effect('resign_evm', () =>
    ownerCall(
      e,
      plan.owner,
      e.world.registry,
      'resign_evm',
      {
        plan_id: planId,
        seq,
        max_fee_per_gas: maxFee.toString(),
        max_priority_fee_per_gas: tip.toString(),
      },
      { gasTera: 200, deposit: STORAGE_DEPOSIT },
    ),
  );
  if (!out.ok) return;
  await inTx('record resign', async (db) => {
    await db
      .update(executions)
      .set({ evmResigns: sql`${executions.evmResigns} + 1`, updatedAt: new Date() })
      .where(and(eq(executions.planId, planId), eq(executions.seq, seq)));
    await record(
      db,
      planId,
      'evm_resigned',
      `${what} was not mined; the registry re-signed it with higher fees`,
      { txHash: out.txHash, maxFeePerGas: maxFee.toString() },
    );
  });
}

// ── reveal_plan ─────────────────────────────────────────────────────────────────────────────

/** After a plan ends under end_reveal, the enclave releases the terms and they go on-chain. */
async function revealPlan(planId: number): Promise<string> {
  const e = durableEngine();
  // Started before the plan is finalized (or by the tick for a plan someone else finalized):
  // wait until it has ended.
  const ended = await waitForChain('plan ended', async () => {
    const chain = await e.registry.plan(planId);
    if (chain?.disclosure.type !== 'end_reveal') return 'no reveal';
    return chain.status === 'ended' ? 'ended' : null;
  });
  if (ended !== 'ended') return ended ?? 'plan did not end';
  for (;;) {
    const chain = await readStep('read plan', () => e.registry.plan(planId));
    if (!chain) return 'plan not found';
    if (chain.disclosure.type !== 'end_reveal') return 'not end_reveal';
    const terms = await effect('enclave reveal', () => e.enclave.revealPlan(chain));
    if (!terms.ok) {
      await sleep(TRANSIENT_WAIT_MS);
      continue;
    }
    const out = await effect('reveal on chain', async () => {
      // A repeat after a crash finds its own reveal on the chain and sends nothing.
      if (await e.near.view(e.world.registry, 'get_reveal', { plan_id: planId }))
        return { ok: true as const, txHash: null };
      return revealOnChain(e, planId, terms.planJson, terms.salt);
    });
    if (!out.ok) return out.code;
    await inTx('record reveal', async (db) => {
      await record(
        db,
        planId,
        'plan_revealed',
        'The sealed terms were published from the enclave and match the commitment',
        { txHash: out.txHash },
      );
      if (out.txHash) await chargePlan(db, personasOf(e), planId, 'reveal', out.txHash);
    });
    return 'revealed';
  }
}
export const revealPlanWorkflow = DBOS.registerWorkflow(revealPlan, { name: 'reveal_plan' });

// ── settle ──────────────────────────────────────────────────────────────────────────────────

/**
 * Follows a sale through 1Click until a final answer. No answer, or a pending status past the
 * deadline, is never a failure: the sale is marked in doubt and polled until 1Click says.
 */
async function settle(planId: number, seq: number): Promise<string> {
  const e = durableEngine();
  const ex = await readStep('read execution', () => loadExecution(e, planId, seq));
  if (!ex || ['settled', 'refunded', 'settlement_failed'].includes(ex.status)) return 'final';
  if (ex.status === 'on_chain' || ex.status === 'broadcast') {
    await effect('submit deposit', () =>
      e.oneclick
        .submitDeposit({
          txHash: ex.evmTxHash ?? ex.chainTx ?? '',
          depositAddress: ex.depositAddress,
        })
        .then(() => true)
        // Submitting only speeds detection up; 1Click finds the deposit without it.
        .catch(() => false),
    );
    await inTx('mark settling', (db) =>
      transition(db, planId, seq, ['on_chain', 'broadcast'], 'settling'),
    );
  }
  let inDoubt = ex.status === 'in_doubt';
  for (;;) {
    const answer = await readStep('1click status', async () => {
      try {
        const s = await e.oneclick.status(ex.depositAddress);
        return {
          status: s.status as string,
          amountOut: s.swapDetails.amountOut ?? null,
          refundReason: s.swapDetails.refundReason ?? null,
        };
      } catch {
        return null;
      }
    });
    if (answer) {
      const final = await inTx('record 1click status', async (db) => {
        await db
          .update(executions)
          .set({ settlementStatus: answer.status, updatedAt: new Date() })
          .where(and(eq(executions.planId, planId), eq(executions.seq, seq)));
        if (answer.status === 'SUCCESS') {
          const out = BigInt(answer.amountOut ?? '0');
          if (out < BigInt(ex.minAmountOut))
            await record(
              db,
              planId,
              'settlement_short',
              `Sale #${seq} settled below its guaranteed minimum; report it to 1Click`,
              { amountOut: out.toString(), minAmountOut: ex.minAmountOut },
            );
          await transition(db, planId, seq, ['settling', 'in_doubt'], 'settled', {
            amountOut: answer.amountOut,
          });
          await record(
            db,
            planId,
            'sale_settled',
            `Sale #${seq} settled: proceeds paid to the beneficiary`,
            {
              amountOut: answer.amountOut,
            },
          );
          return true;
        }
        if (answer.status === 'REFUNDED' || answer.status === 'INCOMPLETE_DEPOSIT') {
          await transition(db, planId, seq, ['settling', 'in_doubt'], 'refunded');
          await record(
            db,
            planId,
            'sale_refunded',
            `Sale #${seq} was refunded to the plan account (${answer.refundReason ?? answer.status})`,
          );
          return true;
        }
        if (answer.status === 'FAILED') {
          await transition(db, planId, seq, ['settling', 'in_doubt'], 'settlement_failed');
          await record(
            db,
            planId,
            'sale_failed',
            `1Click reported sale #${seq} as failed; tokens are held at the deposit address pending 1Click's refund`,
          );
          return true;
        }
        return false;
      });
      if (final) return answer.status;
    }
    if (!inDoubt) {
      const overdue = await readStep(
        'overdue',
        async () => Date.now() - ex.createdAtMs > e.config.SETTLE_IN_DOUBT_SECONDS * 1_000,
      );
      if (overdue) {
        inDoubt = await inTx('mark in doubt', async (db) => {
          if (await transition(db, planId, seq, ['settling'], 'in_doubt'))
            await record(
              db,
              planId,
              'sale_in_doubt',
              `Sale #${seq} has no final answer from 1Click; it stays open and is checked until it does`,
            );
          return true;
        });
      }
    }
    await sleep(inDoubt ? IN_DOUBT_POLL_MS : SETTLE_POLL_MS);
  }
}
export const settleWorkflow = DBOS.registerWorkflow(settle, { name: 'settle' });

/**
 * The owner's own release of an ended ERC-20 plan's remainder (a founder's plan: only their wallet
 * or the beneficiary's may ask). Answers with the call to sign, then checks the signed one; the
 * release_evm workflow sends the signed transfer and watches it as for the server's plans.
 */
export async function ownerReleaseEvm(e: Engine, principal: PlanPrincipal, planId: number) {
  const plan = await e.registry.plan(planId);
  if (!plan) throw new DomainError('not_found', 'Plan not found');
  await authorizeOwner(e, principal, planId);
  if (plan.status !== 'ended' || plan.asset.type !== 'evm_erc20' || !plan.evm_address)
    throw new DomainError('conflict', 'Only an ended ERC-20 plan releases its remainder');
  const token = plan.asset.token_address as Hex;
  const holder = plan.evm_address as Hex;
  const left = await e.evm.tokenBalance(token, holder);
  if (left === 0n) throw new DomainError('conflict', 'Nothing is left to release');
  const fees = await e.evm.fees();
  await e.evm.ensureBalance(holder, SALE_GAS * fees.maxFeePerGas, await e.evm.gasCostWei(SALE_GAS));
  const out = await ownerCall(
    e,
    plan.owner,
    e.world.registry,
    'release_evm',
    {
      plan_id: planId,
      amount: left.toString(),
      nonce: plan.evm_nonce,
      gas_limit: Number(SALE_GAS),
      max_fee_per_gas: fees.maxFeePerGas.toString(),
      max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
    },
    { gasTera: 300, deposit: EXECUTE_DEPOSIT },
    principal,
  );
  if (!out.ok)
    throw new DomainError('policy_error', `The registry refused the release: ${out.code}`, {
      code: out.code,
      txHash: out.txHash,
    });
  await record(
    e.db,
    planId,
    'release_requested',
    'The registry asked the MPC network to sign the release of the remaining tokens',
    { txHash: out.txHash },
  );
  await startOnce(releaseEvmWorkflow, `release:${planId}:${plan.next_seq}`, planId);
  return { txHash: out.txHash };
}

/**
 * The owner's own re-sign of the plan's latest EVM transfer when it is stuck below the network's
 * fees: both fees at least 12.5% higher and at least what the network wants now.
 */
export async function ownerResignEvm(e: Engine, principal: PlanPrincipal, planId: number) {
  const plan = await e.registry.plan(planId);
  if (!plan) throw new DomainError('not_found', 'Plan not found');
  await authorizeOwner(e, principal, planId);
  const seq = plan.next_seq - 1;
  const receipt = seq >= 0 ? await e.registry.receipt(planId, seq) : null;
  if (!receipt?.evm_signature)
    throw new DomainError('conflict', 'This plan has no signed EVM transfer to re-sign');
  const network = await e.evm.fees();
  const maxFee = maxBig(bumped(BigInt(receipt.evm_max_fee_per_gas ?? '0')), network.maxFeePerGas);
  const tip = maxBig(
    bumped(BigInt(receipt.evm_max_priority_fee_per_gas ?? '0')),
    network.maxPriorityFeePerGas,
  );
  if (maxFee > MAX_FEE_PER_GAS || tip > maxFee)
    throw new DomainError('conflict', 'Its fees cannot rise further within the registry’s caps');
  const out = await ownerCall(
    e,
    plan.owner,
    e.world.registry,
    'resign_evm',
    {
      plan_id: planId,
      seq,
      max_fee_per_gas: maxFee.toString(),
      max_priority_fee_per_gas: tip.toString(),
    },
    { gasTera: 200, deposit: STORAGE_DEPOSIT },
    principal,
  );
  if (!out.ok)
    throw new DomainError('policy_error', `The registry refused to re-sign: ${out.code}`, {
      code: out.code,
      txHash: out.txHash,
    });
  await record(
    e.db,
    planId,
    'evm_resigned',
    `Transfer #${seq} was re-signed with higher fees by its owner`,
    { txHash: out.txHash, maxFeePerGas: maxFee.toString() },
  );
  return { txHash: out.txHash };
}

async function authorizeOwner(e: Engine, principal: PlanPrincipal, planId: number) {
  const [row] = await e.db.select().from(plans).where(eq(plans.id, planId));
  if (!row) throw new DomainError('not_found', 'Plan not found');
  authorizePlan(row, principal);
}
