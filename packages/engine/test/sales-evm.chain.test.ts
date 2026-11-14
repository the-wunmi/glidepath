import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { OPERATOR } from '../src/guards.ts';
import { finalizePlan, requestCancel } from '../src/plans.ts';
import { planBalance } from '../src/views.ts';
import { SANDBOX_MS_PER_BLOCK } from '../src/world.ts';
import { evmRpc, mineExpensiveBlocks, sealedPlan, until, updateSim } from './harness.ts';

import { salesWorld } from './sales-world.ts';

const { world, sale, verifyAll } = salesWorld();

describe('a sealed plan on an ERC-20 via Chain Signatures', () => {
  it('sells through an MPC-signed transaction that recovers to the plan address and verifies', async () => {
    const { e } = world;
    const { planId } = await sealedPlan(e, { chain: 'evm', symbol: 'EVMA' });
    const settled = await until(
      e,
      'a settled EVM sale',
      async () => (await sale(planId, 0))?.status === 'settled' && sale(planId, 0),
      { planId },
    );
    expect(settled.evmTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    const [result] = await verifyAll(planId);
    expect(result?.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(result?.checks.find((c) => c.id === 'mpc')?.status).toBe('pass');
    expect(result?.checks.find((c) => c.id === 'broadcast')?.status).toBe('pass');
  }, 300_000);

  it('once it ends, the remainder is MPC-signed to the beneficiary’s address, mined and verifies', async () => {
    const { e } = world;
    const { planId } = await sealedPlan(e, { chain: 'evm', symbol: 'EVMR' });
    const plan = (await e.registry.plan(planId))!;
    if (plan.asset.type !== 'evm_erc20' || !plan.beneficiary.evm_address) throw new Error('setup');
    const token = plan.asset.token_address as Hex;
    const beneficiary = plan.beneficiary.evm_address as Hex;
    const before = await e.evm.tokenBalance(token, beneficiary);
    await requestCancel(e, OPERATOR, planId, { actor: e.world.founder });
    await e.near.fastForward(Math.ceil(660_000 / SANDBOX_MS_PER_BLOCK));
    await finalizePlan(e, planId);
    const release = await until(
      e,
      'the release mined',
      async () => {
        const receipts = await e.registry.receipts(planId);
        const r = receipts.find((x) => x.kind === 'release' && x.status === 'done');
        const left = await planBalance(e, (await e.registry.plan(planId))!);
        return r && left === 0n && r;
      },
      { planId },
    );
    expect(release.receiver.toLowerCase()).toBe(beneficiary.toLowerCase());
    const after = await e.evm.tokenBalance(token, beneficiary);
    expect(after - before).toBe(BigInt(release.amount));
    const results = await verifyAll(planId);
    const checked = results.find((r) => r.seq === release.seq);
    expect(checked?.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    // Nothing is left, so a repeat is refused before any transaction.
    await expect(finalizePlan(e, planId)).rejects.toMatchObject({ code: 'conflict' });
  }, 400_000);

  it('a transfer stuck below the base fee is re-signed with higher fees and then mined', async () => {
    const { e } = world;
    const { planId } = await sealedPlan(e, { chain: 'evm', symbol: 'STUCK' });
    // Transactions now wait in the mempool until a block is mined by hand.
    await evmRpc(e, 'evm_setAutomine', [false]);
    try {
      const sent = await until(
        e,
        'a transfer sent',
        async () => {
          const row = await sale(planId, 0);
          return row?.status === 'on_chain' && row.evmSentAtBlock !== null && row;
        },
        { planId },
      );
      const firstHash = sent.evmTxHash;
      // Blocks get mined, but at a base fee the signed transfer cannot pay: it stays pending.
      await mineExpensiveBlocks(e, 4);
      const resigned = await until(
        e,
        'a re-signed transfer',
        async () => {
          const row = await sale(planId, 0);
          return row && row.evmResigns > 0 && row.evmTxHash !== firstHash && row;
        },
        { planId, advanceBlocks: 40 },
      );
      const receipt = await e.registry.receipt(planId, 0);
      expect(BigInt(receipt?.evm_max_fee_per_gas ?? 0)).toBeGreaterThan(100n * 10n ** 9n);
      // The base fee stays high; the re-signed transfer can pay it and gets mined.
      await mineExpensiveBlocks(e, 1);
      await until(
        e,
        'the re-signed transfer settled',
        async () => (await sale(planId, 0))?.status === 'settled',
        {
          planId,
        },
      );
      expect(await e.evm.receiptOf(resigned.evmTxHash as `0x${string}`)).toEqual({
        status: 'success',
      });
      expect(await e.evm.receiptOf(firstHash as `0x${string}`)).toBeNull();
      const [result] = await verifyAll(planId);
      expect(result?.checks.filter((c) => c.status === 'fail')).toEqual([]);
    } finally {
      await evmRpc(e, 'evm_setAutomine', [true]);
    }
  }, 400_000);

  it('an MPC outage times the signature out, rolls the sale back, and the next sale works', async () => {
    const { e } = world;
    const { planId } = await sealedPlan(e, { chain: 'evm', symbol: 'MPCDN' });
    await updateSim(e, (s) => {
      s.mpcUp = false;
    });
    // Relaying waits for the signature, which never comes; the yield times out after ~200 blocks.
    const failed = await until(
      e,
      'a timed-out signature',
      async () => (await sale(planId, 0))?.status === 'failed_on_chain',
      { advanceBlocks: 0, planId, pump: true, turns: 120 },
    );
    expect(failed).toBe(true);
    // The timed-out sale is rolled back on-chain: its receipt failed and it counts for nothing.
    expect((await e.registry.receipt(planId, 0))?.status).toBe('failed');
    await updateSim(e, (s) => {
      s.mpcUp = true;
    });
    await until(
      e,
      'a sale after the outage',
      async () => (await sale(planId, 1))?.status === 'settled',
      { planId },
    );
    // The next sale reused the rolled-back nonce, and the totals hold only sales that went through.
    // (Workflows run alongside the test, so the next sale may already be in flight when the first
    // fails; these checks read the chain's own record instead of a moment in between.)
    expect((await e.registry.receipt(planId, 1))?.evm_nonce).toBe(0);
    // Plan first, then every sale it had counted by then (done or still pending, never failed).
    const plan = await e.registry.plan(planId);
    const counted = (await e.registry.receipts(planId)).filter(
      (r) => r.kind === 'sale' && r.status !== 'failed' && r.seq < (plan?.next_seq ?? 0),
    );
    expect(plan?.sold_total).toBe(
      counted.reduce((sum, r) => sum + BigInt(r.amount), 0n).toString(),
    );
  }, 400_000);
});
