import { concatBytes, hexToBytes, sha256Hex, utf8ToBytes } from '@vsp/core';
import { executions } from '@vsp/db';
import type { ChainEnclave } from '@vsp/near';
import { verifyReceipt } from '@vsp/verify';
import { and, eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oneclickQuoteKey } from '../src/context.ts';
import { OPERATOR } from '../src/guards.ts';
import { enroll, finalizePlan, requestCancel, revealFromBackup } from '../src/plans.ts';
import { planBalance } from '../src/views.ts';
import { SANDBOX_MS_PER_BLOCK } from '../src/world.ts';
import {
  evmRpc,
  mineExpensiveBlocks,
  sealedPlan,
  startWorld,
  turns,
  until,
  updateSim,
  type World,
} from './harness.ts';

let world: World;
beforeAll(async () => {
  world = await startWorld();
}, 600_000);
afterAll(async () => {
  await world?.close();
});

const sale = async (planId: number, seq: number) => {
  const [row] = await world.e.db
    .select()
    .from(executions)
    .where(and(eq(executions.planId, planId), eq(executions.seq, seq)));
  return row;
};

const verifyAll = async (planId: number) => {
  const { e } = world;
  const plan = await e.registry.plan(planId);
  const enclaves = await e.near.view<ChainEnclave[]>(e.world.registry, 'get_enclaves', {});
  const identity = await e.enclave.identity();
  const receipts = await e.registry.receipts(planId);
  return Promise.all(
    receipts.map((r) =>
      verifyReceipt(
        r,
        plan!,
        enclaves,
        { quote: identity.quote, encryptionKeyHex: identity.encryptionKeyHex },
        {
          evmTransaction: async (hash: Hex) => {
            const rc = await e.evm.public.getTransactionReceipt({ hash }).catch(() => null);
            return rc ? { status: rc.status } : null;
          },
        },
        oneclickQuoteKey(e.config, e.world),
      ),
    ),
  );
};

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

describe('the end of a plan', () => {
  it('under end_reveal, the enclave publishes the sealed terms once the plan ends, and they match the commitment', async () => {
    const { e } = world;
    const { planId, ownerKey } = await sealedPlan(e, {
      chain: 'near',
      symbol: 'REVL',
      disclosure: 'end_reveal',
    });
    expect(await e.enclave.revealPlan((await e.registry.plan(planId))!)).toMatchObject({
      ok: false,
    });
    await requestCancel(e, { operator: false, planKey: ownerKey }, planId, {
      actor: e.world.founder,
    });
    // Past the 10-minute cooling-off, in finality-aware steps.
    await e.near.fastForward(Math.ceil(660_000 / SANDBOX_MS_PER_BLOCK));
    await finalizePlan(e, planId);
    await until(
      e,
      'the reveal on-chain',
      async () =>
        e.near.view<{ plan_json: string; salt: string } | null>(e.world.registry, 'get_reveal', {
          plan_id: planId,
        }),
      { planId, advanceBlocks: 0 },
    );
    const reveal = await e.near.view<{ plan_json: string; salt: string }>(
      e.world.registry,
      'get_reveal',
      { plan_id: planId },
    );
    const plan = await e.registry.plan(planId);
    expect(sha256Hex(concatBytes(utf8ToBytes(reveal.plan_json), hexToBytes(reveal.salt)))).toBe(
      plan?.commitment,
    );
    expect(JSON.parse(reveal.plan_json).token.symbol).toBe('REVL');
    // Repeats are refused before any transaction: nothing is left to release or reveal.
    await expect(finalizePlan(e, planId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      revealFromBackup(e, planId, { plan_json: reveal.plan_json, salt: reveal.salt }),
    ).rejects.toMatchObject({ code: 'conflict' });
  }, 400_000);

  it('a backup that does not match the commitment is refused with a clear reason', async () => {
    const { e } = world;
    const { planId, salt } = await sealedPlan(e, { chain: 'near', symbol: 'FAKE' });
    await requestCancel(e, OPERATOR, planId, { actor: e.world.founder });
    await e.near.fastForward(Math.ceil(660_000 / SANDBOX_MS_PER_BLOCK));
    await finalizePlan(e, planId);
    await expect(
      revealFromBackup(e, planId, { plan_json: '{"version":1}', salt }),
    ).rejects.toMatchObject({ code: 'invalid' });
  }, 400_000);
});

describe('enrolling more tokens', () => {
  it('a plan enrolls only the token it launched, and no more than its founder allocation', async () => {
    const { e } = world;
    const founder = e.world.founder;
    const { planId, ownerKey } = await sealedPlan(e, { chain: 'near', symbol: 'ENRL' });
    const key = { operator: false, planKey: ownerKey };
    // The harness launches with a founder allocation of 1,000.
    await expect(enroll(e, key, planId, { actor: founder, amount: '1001' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await enroll(e, key, planId, { actor: founder, amount: '600' });
    await expect(enroll(e, key, planId, { actor: founder, amount: '401' })).rejects.toMatchObject({
      code: 'invalid',
    });
  }, 400_000);

  it('a plan cannot enroll a token it did not launch, nor name one another plan launched', async () => {
    const { e } = world;
    const founder = e.world.founder;
    const foreign = await sealedPlan(e, { chain: 'near', symbol: 'FRGN', launch: false });
    await expect(
      enroll(e, { operator: false, planKey: foreign.ownerKey }, foreign.planId, {
        actor: founder,
        amount: '1',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      sealedPlan(e, { chain: 'near', symbol: 'ENRX', address: `enrl.${e.world.root}` }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      sealedPlan(e, { chain: 'near', symbol: 'USDX', address: e.world.usdc }),
    ).rejects.toMatchObject({ code: 'invalid' });
  }, 400_000);
});

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
