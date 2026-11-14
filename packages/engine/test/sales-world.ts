import { executions } from '@glidepath/db';
import type { ChainEnclave } from '@glidepath/near';
import { verifyReceipt } from '@glidepath/verify';
import { and, eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import { afterAll, beforeAll } from 'vitest';
import { oneclickQuoteKey } from '../src/context.ts';
import { startWorld, type World } from './harness.ts';

/**
 * One local world per sales test file, and the helpers they share. The world is read through a
 * getter, so tests can use `world.e` once `beforeAll` has started it.
 */
export function salesWorld() {
  const ref: { world?: World } = {};
  beforeAll(async () => {
    ref.world = await startWorld();
  }, 600_000);
  afterAll(async () => {
    await ref.world?.close();
  });
  const world = {
    get e() {
      if (!ref.world) throw new Error('The test world is not started');
      return ref.world.e;
    },
  } as World;

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

  return { world, sale, verifyAll };
}
