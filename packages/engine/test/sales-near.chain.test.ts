import { executions } from '@glidepath/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { planBalance } from '../src/views.ts';
import { sealedPlan, turns, until, updateSim } from './harness.ts';

import { salesWorld } from './sales-world.ts';

const { world, sale, verifyAll } = salesWorld();

describe('a sealed plan on a NEAR token', () => {
  it('sells inside the plan, settles through 1Click, and every receipt verifies', async () => {
    const { e } = world;
    const { planId } = await sealedPlan(e, { chain: 'near', symbol: 'NEARA' });
    expect(await e.near.accessKeyCount((await e.registry.plan(planId))!.plan_account)).toBe(0);
    const settled = await until(
      e,
      'a settled sale',
      async () => (await sale(planId, 0))?.status === 'settled' && sale(planId, 0),
      { planId },
    );
    expect(settled.settlementStatus).toBe('SUCCESS');
    const usdc = await e.near.view<string>(e.world.usdc, 'ft_balance_of', {
      account_id: e.world.founder,
    });
    expect(BigInt(usdc)).toBeGreaterThan(0n);
    const [result] = await verifyAll(planId);
    expect(result?.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(result?.ok).toBe(true);
  }, 300_000);

  it('a refunded swap returns the tokens to the plan account and is recorded as refunded', async () => {
    const { e } = world;
    await updateSim(e, (s) => {
      s.oneclickOutcomes = ['refund'];
    });
    const { planId } = await sealedPlan(e, { chain: 'near', symbol: 'REFND' });
    const before = await planBalance(e, (await e.registry.plan(planId))!);
    await until(e, 'a refunded sale', async () => (await sale(planId, 0))?.status === 'refunded', {
      planId,
    });
    // Later sales may have gone out meanwhile; the refunded one must have come back in full.
    // Workflows run alongside the test, so compare at a moment when no sale is between the
    // enclave's signature and the chain (a `signed` row has not moved tokens yet).
    const consistent = await until(
      e,
      'a settled view of the plan balance',
      async () => {
        const rows = await e.db.select().from(executions).where(eq(executions.planId, planId));
        if (rows.some((x) => x.status === 'signed')) return false;
        const stillOut = rows
          .filter(
            (x) => x.seq !== 0 && !['refunded', 'refused', 'failed_on_chain'].includes(x.status),
          )
          .reduce((sum, x) => sum + BigInt(x.amount), 0n);
        const balance = await planBalance(e, (await e.registry.plan(planId))!);
        return balance === before - stillOut ? { balance, stillOut } : false;
      },
      { planId, advanceBlocks: 0, turns: 20 },
    );
    expect(consistent.balance).toBe(before - consistent.stillOut);
  }, 300_000);

  it('a swap with no final answer is held in doubt and keeps being checked, never marked failed', async () => {
    const { e } = world;
    await updateSim(e, (s) => {
      s.oneclickOutcomes = ['stall'];
    });
    const { planId } = await sealedPlan(e, { chain: 'near', symbol: 'STALL' });
    await until(e, 'an in-doubt sale', async () => (await sale(planId, 0))?.status === 'in_doubt', {
      advanceBlocks: 100,
      planId,
    });
    const row = await sale(planId, 0);
    expect(row?.settlementStatus).toBe('PROCESSING');
    // The on-chain receipt stands: the registry did its part; only settlement is unknown.
    expect((await e.registry.receipt(planId, 0))?.status).toBe('done');
  }, 300_000);

  it('a failed swap is recorded as a settlement failure, not as a refund', async () => {
    const { e } = world;
    await updateSim(e, (s) => {
      s.oneclickOutcomes = ['fail'];
    });
    const { planId } = await sealedPlan(e, { chain: 'near', symbol: 'FAILD' });
    await until(
      e,
      'a failed settlement',
      async () => (await sale(planId, 0))?.status === 'settlement_failed',
      { planId },
    );
  }, 300_000);

  it('no sale happens while the enclave is down, and selling resumes when it returns', async () => {
    const { e } = world;
    const { planId } = await sealedPlan(e, { chain: 'near', symbol: 'DOWN' });
    await updateSim(e, (s) => {
      s.enclaveUp = false;
    });
    await turns(e, planId, 5);
    expect((await e.registry.plan(planId))?.next_seq).toBe(0);
    await updateSim(e, (s) => {
      s.enclaveUp = true;
    });
    await until(
      e,
      'a sale after recovery',
      async () => (await sale(planId, 0))?.status === 'settled',
      { planId },
    );
  }, 300_000);

  it('a manipulated price feed stops the sale instead of selling at the wrong price', async () => {
    const { e } = world;
    const { planId } = await sealedPlan(e, { chain: 'near', symbol: 'MANIP' });
    await updateSim(e, (s) => {
      s.market.sourceOffsetsBps = { coinbase: 2_000 };
    });
    await turns(e, planId, 4);
    expect((await e.registry.plan(planId))?.next_seq).toBe(0);
    await updateSim(e, (s) => {
      s.market.sourceOffsetsBps = {};
    });
  }, 300_000);

  it('the enclave refuses to sell below the sealed floor even when every source agrees', async () => {
    const { e } = world;
    const { planId } = await sealedPlan(e, {
      chain: 'near',
      symbol: 'FLOOR',
      listing: '0.80',
      floor: '1.00',
    });
    await turns(e, planId, 4);
    expect((await e.registry.plan(planId))?.next_seq).toBe(0);
  }, 300_000);
});
