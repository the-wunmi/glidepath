import {
  canonicalJson,
  envelopeJson,
  newSaltHex,
  parseInput,
  planCommitment,
  SealedPlan,
  sealTo,
} from '@vsp/core';
import type { ChainEnclave, KeyPairString } from '@vsp/near';
import { verifyReceipt } from '@vsp/verify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oneclickQuoteKey } from '../src/context.ts';
import { dbOutLayerStore, type OutLayerDeployment, OutLayerEnclave } from '../src/outlayer.ts';
import { requestChange } from '../src/plans.ts';
import { LOCAL_MIN_COOLING_OFF_MS, SANDBOX_MS_PER_BLOCK } from '../src/world.ts';
import { sealedPlan, startWorld, until, type World } from './harness.ts';
import {
  buildLocalModule,
  type LocalBuild,
  type LocalRun,
  localBuild,
  localClient,
  localDeployment,
  localEvidence,
} from './local-enclave.ts';

let world: World;
beforeAll(async () => {
  buildLocalModule();
  world = await startWorld();
}, 600_000);
afterAll(async () => {
  await world?.close();
});

/** Registers a build's key with the registry, as governance does after its key-proof run. */
async function register(b: LocalBuild): Promise<void> {
  const { e } = world;
  const governance = e.near.account(
    e.world.governance,
    e.world.keys[e.world.governance] as KeyPairString,
  );
  const { measurements, quoteHash } = localEvidence(b);
  const out = await e.near.call(
    governance,
    e.world.registry,
    'register_enclave',
    { public_key: b.signingKey, measurements, quote_hash: quoteHash },
    { deposit: 10n ** 23n },
  );
  expect(out.ok).toBe(true);
}

describe('moving a plan between enclave builds', () => {
  it('a plan acked by an earlier build moves to the current one through a change, and both builds’ receipts verify', async () => {
    const { e } = world;
    const quoteKey = oneclickQuoteKey(e.config, e.world);
    const a = localBuild('aa'.repeat(32), quoteKey);
    const b = localBuild('bb'.repeat(32), quoteKey);
    await register(a);
    await register(b);
    await e.near.fastForward(Math.ceil(LOCAL_MIN_COOLING_OFF_MS / SANDBOX_MS_PER_BLOCK) + 100);

    const runs: LocalRun[] = [];
    const store = dbOutLayerStore(e.db);
    const serve = (deployment: OutLayerDeployment) => {
      e.enclave = new OutLayerEnclave({
        store,
        client: localClient(runs, quoteKey),
        deployment,
        host: e.host,
        pollMs: 0,
        log: e.log,
      });
    };
    const receiptsBy = async (planId: number, key: string) =>
      (await e.registry.receipts(planId)).filter(
        (r) => r.enclave_key === key && r.status === 'done',
      );

    // Build A is the only build: it accepts the plan and sells.
    serve(localDeployment(quoteKey, a));
    const setup = await sealedPlan(e, { chain: 'near', symbol: 'MOVE' });
    const { planId } = setup;
    expect((await e.registry.plan(planId))?.acked_by).toBe(a.signingKey);
    await until(
      e,
      'a sale by build A',
      async () => (await receiptsBy(planId, a.signingKey)).length > 0,
      {
        planId,
      },
    );

    // Build B is published. The owner re-seals the same terms to it under a new salt.
    serve(localDeployment(quoteKey, b, a));
    const plan = parseInput(SealedPlan, setup.sealed);
    const salt = newSaltHex();
    const commitment = planCommitment(plan, salt);
    await requestChange(e, { operator: false, planKey: setup.ownerKey }, planId, {
      actor: e.world.founder,
      commitment,
      envelope: envelopeJson(setup.envelope),
      sealed_box: sealTo(
        b.encryptionKeyHex,
        JSON.stringify({ plan: JSON.parse(canonicalJson(plan)), salt }),
      ),
    });

    // After the public cooling-off, B acks the change and the registry names it.
    const moved = await until(
      e,
      'build B holds the plan',
      async () => {
        const p = await e.registry.plan(planId);
        return p?.acked_by === b.signingKey && p;
      },
      { planId },
    );
    expect(moved.commitment).toBe(commitment);
    const fromA = runs.length;
    await until(
      e,
      'a sale by build B',
      async () => (await receiptsBy(planId, b.signingKey)).length > 0,
      {
        planId,
      },
    );
    // Once B holds the plan, only B runs it.
    expect(new Set(runs.slice(fromA).map((r) => r.build))).toEqual(new Set([b.wasm.sha256]));

    const chain = await e.registry.plan(planId);
    const enclaves = await e.near.view<ChainEnclave[]>(e.world.registry, 'get_enclaves', {});
    const sales = (await e.registry.receipts(planId)).filter((r) => r.status === 'done');
    expect(new Set(sales.map((r) => r.enclave_key))).toEqual(new Set([a.signingKey, b.signingKey]));
    for (const r of sales) {
      // The TDX evidence of an OutLayer key is checked against the registry by the web page.
      const out = await verifyReceipt(r, chain!, enclaves, null, {}, quoteKey);
      const failed = out.checks.filter((c) => c.id !== 'attestation' && c.status !== 'pass');
      expect(failed, `receipt ${r.seq} signed by ${r.enclave_key}`).toEqual([]);
    }
  });
});
