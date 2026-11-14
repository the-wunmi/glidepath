import { DomainError } from '@vsp/core';
import { type Db, planBudget, plans, type Tx } from '@vsp/db';
import { eq, sql } from 'drizzle-orm';
import type { Engine } from './context.ts';
import { authorizePlan, type PlanPrincipal } from './guards.ts';
import { readWalletTx } from './plans.ts';

const MILLI_NEAR = 10n ** 21n;

/** A database handle, or a transaction inside a durable step. */
type Conn = Db | Tx;

/**
 * What the server's relayer charges a founder's plan for the work it does for it, in yoctoNEAR:
 * the published price of each action, a little above its measured cost (an OutLayer run about
 * 0.002 NEAR, a NEAR execute about 0.002, an MPC-signed EVM execute about 0.044; a NEAR token
 * launch 0.2 NEAR of storage). Plans of the server's own accounts are not charged.
 */
export const FEES = {
  run: 3n * MILLI_NEAR,
  execute: 5n * MILLI_NEAR,
  evm_execute: 50n * MILLI_NEAR,
  finalize: 5n * MILLI_NEAR,
  reveal: 5n * MILLI_NEAR,
  launch_near: 250n * MILLI_NEAR,
  launch_evm: 50n * MILLI_NEAR,
} as const;
export type FeeKind = keyof typeof FEES;

/** The least a plan must hold for a sale to be tried: a run, then its execute. */
export const SALE_RESERVE = FEES.run + FEES.evm_execute;

interface Personas {
  founder: string;
  dao: string | null;
}

/** Whether an account is one of the server's own (its founder persona or treasury DAO). */
export const isServerAccount = (personas: Personas, account: string) =>
  account === personas.founder || (!!personas.dao && account === personas.dao);

/** Whether a plan pays for itself: one owned by a founder's own wallet. */
async function chargeable(db: Conn, planId: number, personas: Personas): Promise<boolean> {
  const [row] = await db.select({ owner: plans.owner }).from(plans).where(eq(plans.id, planId));
  return !!row && row.owner !== personas.founder && row.owner !== personas.dao;
}

export async function budgetBalance(db: Conn, planId: number): Promise<bigint> {
  const [row] = await db
    .select({ sum: sql<string | null>`sum(${planBudget.yocto})` })
    .from(planBudget)
    .where(eq(planBudget.planId, planId));
  return BigInt(row?.sum ?? 0);
}

/** Records the fee for an action the relayer did for a founder's plan. */
export async function chargePlan(
  db: Conn,
  personas: Personas,
  planId: number,
  kind: FeeKind,
  txHash: string | null = null,
): Promise<void> {
  if (!(await chargeable(db, planId, personas))) return;
  await db.insert(planBudget).values({ planId, yocto: (-FEES[kind]).toString(), kind, txHash });
}

/** Whether a founder's plan can pay for this action (always true for the server's own plans). */
export async function canAfford(
  db: Conn,
  personas: Personas,
  planId: number,
  need: bigint,
): Promise<boolean> {
  if (!(await chargeable(db, planId, personas))) return true;
  return (await budgetBalance(db, planId)) >= need;
}

export const personasOf = (e: Engine): Personas => ({
  founder: e.world.founder,
  dao: e.world.dao,
});

/** Refuses an action a founder's plan cannot pay for, saying how to fix it. */
export async function assertAfford(e: Engine, planId: number, kind: FeeKind): Promise<void> {
  if (await canAfford(e.db, personasOf(e), planId, FEES[kind])) return;
  throw new DomainError(
    'conflict',
    'This plan’s budget is too low for that; top it up from your wallet first',
  );
}

/**
 * Credits a plan with its owner's transfer to the relayer, checked on chain: signed by the plan's
 * owner, a single transfer to the relayer, final and successful. A transfer counts once.
 */
export async function fundPlan(
  e: Engine,
  principal: PlanPrincipal,
  planId: number,
  txHash: string,
): Promise<{ balance: string }> {
  const [row] = await e.db.select().from(plans).where(eq(plans.id, planId));
  if (!row) throw new DomainError('not_found', 'Plan not found');
  authorizePlan(row, principal);
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash))
    throw new DomainError('invalid', 'Not a transaction hash');
  const tx = await readWalletTx(e, txHash, row.owner);
  if (!tx)
    throw new DomainError('conflict', 'That transfer is not final yet; try again in a few seconds');
  const [action] = tx.actions;
  if (
    tx.signerId !== row.owner ||
    tx.receiverId !== e.world.relayer ||
    tx.actions.length !== 1 ||
    action?.type !== 'Transfer' ||
    !action.deposit ||
    !tx.outcome.ok
  )
    throw new DomainError('invalid', 'That is not a transfer from the plan’s owner to the relayer');
  const inserted = await e.db
    .insert(planBudget)
    .values({ planId, yocto: action.deposit.toString(), kind: 'credit', txHash })
    .onConflictDoNothing()
    .returning({ id: planBudget.id });
  if (!inserted.length) throw new DomainError('conflict', 'That transfer is already counted');
  return { balance: (await budgetBalance(e.db, planId)).toString() };
}
