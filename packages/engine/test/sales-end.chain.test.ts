import { concatBytes, hexToBytes, sha256Hex, utf8ToBytes } from '@glidepath/core';
import { describe, expect, it } from 'vitest';
import { OPERATOR } from '../src/guards.ts';
import { enroll, finalizePlan, requestCancel, revealFromBackup } from '../src/plans.ts';
import { SANDBOX_MS_PER_BLOCK } from '../src/world.ts';
import { sealedPlan, until } from './harness.ts';

import { salesWorld } from './sales-world.ts';

const { world } = salesWorld();

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
      sealedPlan(e, { chain: 'near', symbol: 'ENRL', address: `enrl.${e.world.root}` }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      sealedPlan(e, { chain: 'near', symbol: 'USDX', address: e.world.usdc }),
    ).rejects.toMatchObject({ code: 'invalid' });
  }, 400_000);
});
