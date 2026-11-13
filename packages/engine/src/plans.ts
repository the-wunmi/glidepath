import { deriveEvmAddress, planPath } from '@vsp/chainsig';
import {
  AccountId,
  concatBytes,
  DomainError,
  Envelope,
  EvmAddress,
  envelopeJson,
  Hex32,
  hexToBytes,
  parseInput,
  SealedBox,
  sha256Hex,
  TokenAmount,
  toBaseUnits,
  UsdDecimal,
  usdToE6,
  utf8ToBytes,
} from '@vsp/core';
import { plans } from '@vsp/db';
import { DEPLOY_GAS } from '@vsp/evm';
import {
  actions,
  innerFailure,
  KeyPair,
  type KeyPairString,
  type RegistryConfig,
  type TxOutcome,
  teraToGas,
} from '@vsp/near';
import { and, eq, ne, sql } from 'drizzle-orm';
import { getContractAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import type { Engine } from './context.ts';
import { DBOS, durableEngine, startOnce } from './durable.ts';
import {
  assertPlanLength,
  assertReserve,
  authorizePlan,
  chargeDaily,
  nearTokensEnabled,
  newOwnerKey,
  type PlanPrincipal,
  spendRelayer,
} from './guards.ts';
import { updateSimSettings } from './sim-settings.ts';
import { record } from './timeline.ts';
import { planBalance } from './views.ts';
import {
  deliverChangeWorkflow,
  deliverPlanWorkflow,
  revealPlanWorkflow,
  STORAGE_DEPOSIT,
  waitForChain,
} from './workflows.ts';
import { CREATE_PLAN_DEPOSIT_YOCTO, demoTokenWasm } from './world.ts';

const NEAR = 10n ** 24n;

/** The personas a local user may act as: the founder, and the treasury DAO they sit on. */
function assertActor(e: Engine, actor: string) {
  const allowed = [e.world.founder, ...(e.world.dao ? [e.world.dao] : [])];
  if (!allowed.includes(actor))
    throw new DomainError('forbidden', 'You cannot act as this account');
}

/** The founder's own signing account (a sandbox key locally, the relayer's key on testnet). */
function founderAccount(e: Engine) {
  return e.near.account(e.world.founder, e.world.keys[e.world.founder] as KeyPairString);
}

/** Sputnik DAO v2 needs this bond attached to add_proposal (its default policy). */
const PROPOSAL_BOND = NEAR;

/**
 * The one path for an owner's action. A personal owner signs directly. The treasury DAO acts the way
 * a DAO does: its council member (the founder) proposes a FunctionCall and approves it, and the
 * DAO itself makes the call, so the registry sees the DAO as the caller.
 */
export async function ownerCall<T = unknown>(
  e: Engine,
  actor: string,
  receiverId: string,
  method: string,
  args: Record<string, unknown>,
  opts: { gasTera?: number; deposit?: bigint } = {},
): Promise<TxOutcome<T> & { proposalId?: number }> {
  assertActor(e, actor);
  if (actor !== e.world.dao)
    return e.near.call<T>(founderAccount(e), receiverId, method, args, opts);
  const kind = {
    FunctionCall: {
      receiver_id: receiverId,
      actions: [
        {
          method_name: method,
          args: Buffer.from(JSON.stringify(args)).toString('base64'),
          deposit: (opts.deposit ?? 0n).toString(),
          gas: (BigInt(opts.gasTera ?? 100) * 10n ** 12n).toString(),
        },
      ],
    },
  };
  const council = founderAccount(e);
  const proposed = await e.near.call<number>(
    council,
    actor,
    'add_proposal',
    { proposal: { description: `${method} on ${receiverId}`, kind } },
    { deposit: PROPOSAL_BOND, gasTera: 50 },
  );
  if (!proposed.ok) return proposed;
  // Current sputnikdao2 needs the proposal kind repeated in act_proposal (read from its source).
  const acted = await e.near.call(
    council,
    actor,
    'act_proposal',
    { id: proposed.value, action: 'VoteApprove', proposal: kind },
    { gasTera: 300 },
  );
  if (!acted.ok) return acted;
  const inner = innerFailure(acted.raw);
  if (inner) {
    const code = /^[a-z][a-z0-9_]*$/.test(inner) ? inner : 'proposal_failed';
    return {
      ok: false,
      txHash: acted.txHash,
      error: inner,
      code,
      logs: acted.logs,
      events: acted.events,
    };
  }
  const created = acted.events.find((ev) => ev.event === 'plan_created')?.data[0]?.plan_id;
  return { ...acted, value: (created ?? acted.value) as T, proposalId: proposed.value };
}

const PlanTokenRef = z.discriminatedUnion('chain', [
  z.object({
    chain: z.literal('near'),
    address: AccountId,
    symbol: z.string().regex(/^[A-Z0-9]{2,8}$/),
    decimals: z.int().min(0).max(24),
  }),
  z.object({
    chain: z.literal('evm'),
    chain_id: z.int().positive(),
    address: EvmAddress,
    symbol: z.string().regex(/^[A-Z0-9]{2,8}$/),
    decimals: z.int().min(0).max(24),
  }),
]);

export const CreatePlanInput = z.object({
  actor: AccountId,
  label: z.string().trim().min(1).max(80),
  token: PlanTokenRef,
  beneficiary: z.object({ near_account: AccountId, evm_address: EvmAddress.optional() }),
  /** The asset proceeds are paid in, pinned on-chain; 1Click quotes must pay exactly this. */
  proceeds_asset: z.string().min(1).max(128),
  envelope: Envelope,
  disclosure: z.discriminatedUnion('type', [
    z.object({ type: z.literal('realtime') }),
    z.object({
      type: z.literal('delayed'),
      delay_ms: z
        .int()
        .min(0)
        .max(365 * 86_400_000),
    }),
    z.object({ type: z.literal('end_reveal') }),
  ]),
  cooling_off_ms: z.int().positive(),
  start_ms: z.int().positive(),
  end_ms: z.int().positive(),
  commitment: Hex32,
  sealed_box: SealedBox,
});

/**
 * Checks a new plan against this server's rules without spending anything, so the API can count
 * a request against its limits only once it is a real plan.
 */
export async function checkNewPlan(e: Engine, input: z.input<typeof CreatePlanInput>) {
  const p = parseInput(CreatePlanInput, input);
  if (p.token.chain === 'evm' && !p.beneficiary.evm_address)
    throw new DomainError('invalid', 'An EVM token needs a beneficiary EVM address');
  if (p.token.chain === 'near' && !nearTokensEnabled(e))
    throw new DomainError(
      'unavailable',
      'NEAR-token plans are off on this server; create a plan for an ERC-20 token instead',
    );
  // The registry's floor test assumes 6-decimal USD proceeds, so only the world's USDC is offered.
  if (p.proceeds_asset !== `nep141:${e.world.usdc}`)
    throw new DomainError('invalid', `Proceeds must be paid in nep141:${e.world.usdc}`);
  assertActor(e, p.actor);
  // The registry's own rules, checked here so a request it would refuse costs no daily budget.
  const env = p.envelope;
  if (env.max_amount_per_tx <= 0n || env.max_amount_per_tx > env.max_amount_per_period)
    throw new DomainError('invalid', 'The per-sale cap must be positive and within the period cap');
  const [registryConfig, nowMs] = await Promise.all([
    e.near.view<RegistryConfig>(e.world.registry, 'get_config'),
    e.near.chainTimeMs(),
  ]);
  if (p.cooling_off_ms < registryConfig.min_cooling_off_ms)
    throw new DomainError(
      'invalid',
      `The cooling-off must be at least ${registryConfig.min_cooling_off_ms / 60_000} minutes`,
    );
  if (p.end_ms <= p.start_ms || p.end_ms <= nowMs)
    throw new DomainError('invalid', 'A plan must end after it starts, and in the future');
  // Plan times are chain times, and the local chain can be fast-forwarded past the wall clock.
  assertPlanLength(e, p.end_ms, nowMs);
  // A plan may not name the proceeds token, or a token another plan launched: finalizing would
  // release whatever of it the plan account holds, and enroll moves the relayer's own balance.
  if (p.token.address === e.world.usdc)
    throw new DomainError('invalid', 'A plan cannot sell the proceeds token');
  const [launched] = await e.db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.launchedToken, p.token.address))
    .limit(1);
  if (launched)
    throw new DomainError('conflict', `Plan #${launched.id} launched this token; choose another`);
  // The enclave asks for prices by symbol and the simulated market keys them by address, so a
  // symbol must name one token: otherwise one plan's listing price could move another's.
  const [clash] = await e.db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.tokenSymbol, p.token.symbol), ne(plans.tokenAddress, p.token.address)))
    .limit(1);
  if (clash)
    throw new DomainError(
      'conflict',
      `Another token already uses the symbol ${p.token.symbol}; choose another`,
    );
  return p;
}

/**
 * Publishes a sealed plan: the commitment and public bounds go on-chain, the registry creates the
 * keyless plan account, and the enclave gets the ciphertext. The server never sees the plan.
 * Returns the plan's owner key once; only its hash is kept. A repeat of a plan already on chain
 * returns `ownerKey: null`: the key went to the first request.
 */
export async function createPlan(e: Engine, input: z.input<typeof CreatePlanInput>) {
  const p = await checkNewPlan(e, input);
  // A repeat of a plan already on chain under this owner and commitment creates nothing and writes
  // nothing: the commitment is public by then, so the caller may not be its author. The original
  // request's plan_created workflow records the row; the key went to that request.
  const onChain = (await e.registry.plans()).find(
    (x) => x.commitment === p.commitment && x.owner === p.actor,
  );
  if (onChain)
    return { planId: onChain.id, txHash: null, planAccount: onChain.plan_account, ownerKey: null };
  await spendRelayer(e);
  await chargeDaily(e.db, 'plan_created', e.config.MAX_PLANS_PER_DAY);
  const owner = newOwnerKey();
  // Started before the chain call: if this process dies after the plan is created, the workflow
  // finds it on-chain, records it (with the key's hash, never the key) and hands it to the
  // enclave. If the call is refused, it ends.
  await startOnce(planCreatedWorkflow, `created:${p.commitment}`, input, owner.hash);
  const asset =
    p.token.chain === 'near'
      ? { type: 'nep141', token_id: p.token.address }
      : { type: 'evm_erc20', chain_id: p.token.chain_id, token_address: p.token.address };
  const out = await ownerCall<number>(
    e,
    p.actor,
    e.world.registry,
    'create_plan',
    {
      commitment: p.commitment,
      asset,
      token_decimals: p.token.decimals,
      quote_decimals: 6,
      beneficiary: {
        near_account: p.beneficiary.near_account,
        evm_address: p.beneficiary.evm_address ?? null,
      },
      proceeds_asset: p.proceeds_asset,
      envelope: envelopeJson(p.envelope),
      disclosure: p.disclosure,
      cooling_off_ms: p.cooling_off_ms,
      start_ms: p.start_ms,
      end_ms: p.end_ms,
      label: p.label,
    },
    { gasTera: 200, deposit: CREATE_PLAN_DEPOSIT_YOCTO },
  );
  if (!out.ok)
    throw new DomainError('policy_error', `The registry refused the plan: ${out.code}`, {
      code: out.code,
      txHash: out.txHash,
    });
  const recorded = await recordPlan(e, p, out.value, out.txHash, owner.hash);
  await recordProposal(e, out.value, out, 'create the plan');
  return { ...recorded, ownerKey: owner.key };
}

/** The follow-up of createPlan: waits for the plan on-chain, then records it (safe to run twice). */
async function planCreated(
  input: z.input<typeof CreatePlanInput>,
  ownerKeyHash?: string,
): Promise<string> {
  const e = durableEngine();
  const p = parseInput(CreatePlanInput, input);
  const planId = await waitForChain('plan on chain', async () => {
    const found = (await e.registry.plans()).find(
      (x) => x.commitment === p.commitment && x.owner === p.actor,
    );
    return found ? found.id : null;
  });
  if (planId === null) return 'the plan never reached the chain';
  await recordPlan(e, p, planId, '', ownerKeyHash);
  return 'recorded';
}
export const planCreatedWorkflow = DBOS.registerWorkflow(planCreated, { name: 'plan_created' });

/** A DAO-owned plan's actions are proposals; the timeline names each one. */
async function recordProposal(
  e: Engine,
  planId: number,
  out: { proposalId?: number; txHash: string },
  what: string,
) {
  if (out.proposalId === undefined) return;
  await record(
    e.db,
    planId,
    'dao_proposal',
    `DAO proposal #${out.proposalId} to ${what} was approved by the council and executed by the DAO`,
    { proposalId: out.proposalId, txHash: out.txHash },
  );
}

/** Records a plan that exists on-chain and hands it to the enclave. Safe to run twice. */
async function recordPlan(
  e: Engine,
  p: z.output<typeof CreatePlanInput>,
  planId: number,
  txHash: string,
  /** Undefined only for workflows started before owner keys existed. */
  ownerKeyHash: string | undefined,
) {
  const chain = await e.registry.plan(planId);
  if (!chain)
    throw new DomainError('unavailable', 'The plan was created but cannot be read back yet');
  const inserted = await e.db
    .insert(plans)
    .values({
      id: planId,
      owner: p.actor,
      label: p.label,
      tokenChain: p.token.chain,
      tokenAddress: p.token.address,
      tokenSymbol: p.token.symbol,
      tokenDecimals: p.token.decimals,
      commitment: p.commitment,
      sealedBox: p.sealed_box,
      planAccount: chain.plan_account,
      createTx: txHash,
      ownerKeyHash,
    })
    .onConflictDoNothing()
    .returning({ id: plans.id });
  if (inserted.length)
    await record(e.db, planId, 'plan_created', 'Plan sealed and committed on-chain', {
      txHash,
      commitment: p.commitment,
      planAccount: chain.plan_account,
    });
  await startOnce(deliverPlanWorkflow, `deliver:${planId}`, planId);
  return { planId, txHash, planAccount: chain.plan_account };
}

export const ChangeInput = z.object({
  actor: AccountId,
  commitment: Hex32,
  envelope: Envelope,
  sealed_box: SealedBox,
});

/** Starts a public cooling-off: the change is visible now and can act only after it ends. */
export async function requestChange(
  e: Engine,
  principal: PlanPrincipal,
  planId: number,
  input: z.input<typeof ChangeInput>,
) {
  const p = parseInput(ChangeInput, input);
  const row = await loadPlanRow(e, principal, planId, p.actor);
  await spendRelayer(e);
  // The box is kept first, and the delivery workflow started before the chain call: a crash after
  // the call still leaves the enclave its new plan, delivered once the change shows on-chain.
  await e.db.update(plans).set({ pendingSealedBox: p.sealed_box }).where(eq(plans.id, row.id));
  await startOnce(deliverChangeWorkflow, `change:${planId}:${p.commitment}`, planId, p.commitment);
  const out = await ownerCall(
    e,
    p.actor,
    e.world.registry,
    'request_change',
    {
      plan_id: planId,
      commitment: p.commitment,
      envelope: envelopeJson(p.envelope),
    },
    { deposit: STORAGE_DEPOSIT },
  );
  if (!out.ok) {
    // Put back whatever was pending before (a refusal may be change_pending for an earlier change).
    await e.db
      .update(plans)
      .set({ pendingSealedBox: row.pendingSealedBox })
      .where(eq(plans.id, row.id));
    throw refusal('The registry refused the change', out);
  }
  await recordProposal(e, planId, out, 'change the plan');
  const chain = await e.registry.plan(planId);
  await record(e.db, planId, 'change_requested', 'Plan change requested; cooling-off started', {
    txHash: out.txHash,
    effectiveAtMs: chain?.pending_change?.effective_at_ms,
  });
  return { txHash: out.txHash, effectiveAtMs: chain?.pending_change?.effective_at_ms ?? null };
}

const ActorOnly = z.object({ actor: AccountId });

export async function requestCancel(
  e: Engine,
  principal: PlanPrincipal,
  planId: number,
  input: z.input<typeof ActorOnly>,
) {
  const p = parseInput(ActorOnly, input);
  await loadPlanRow(e, principal, planId, p.actor);
  await spendRelayer(e);
  const out = await ownerCall(
    e,
    p.actor,
    e.world.registry,
    'request_cancel',
    { plan_id: planId },
    { deposit: STORAGE_DEPOSIT },
  );
  if (!out.ok) throw refusal('The registry refused the cancellation', out);
  await recordProposal(e, planId, out, 'cancel the plan');
  const chain = await e.registry.plan(planId);
  await record(e.db, planId, 'cancel_requested', 'Cancellation requested; cooling-off started', {
    txHash: out.txHash,
    effectiveAtMs: chain?.pending_change?.effective_at_ms,
  });
  return { txHash: out.txHash, effectiveAtMs: chain?.pending_change?.effective_at_ms ?? null };
}

export async function withdrawChange(
  e: Engine,
  principal: PlanPrincipal,
  planId: number,
  input: z.input<typeof ActorOnly>,
) {
  const p = parseInput(ActorOnly, input);
  await loadPlanRow(e, principal, planId, p.actor);
  await spendRelayer(e);
  const out = await ownerCall(e, p.actor, e.world.registry, 'withdraw_change', {
    plan_id: planId,
  });
  if (!out.ok) throw refusal('The registry refused to withdraw the change', out);
  await recordProposal(e, planId, out, 'withdraw the pending change');
  await e.db.update(plans).set({ pendingSealedBox: null }).where(eq(plans.id, planId));
  await record(
    e.db,
    planId,
    'change_withdrawn',
    'Pending change withdrawn; the current plan stays',
    { txHash: out.txHash },
  );
  return { txHash: out.txHash };
}

/**
 * Anyone may finalize once the plan has ended or a cancellation's cooling-off is over. The
 * registry's state is read first, so a request it would refuse, or a repeat with nothing left to
 * release, costs the relayer nothing. Once ended, finalize only retries the release of a NEAR
 * token balance still in the plan account.
 */
export async function finalizePlan(e: Engine, planId: number) {
  const chain = await e.registry.plan(planId);
  if (!chain) throw new DomainError('not_found', 'Plan not found');
  const ended = chain.status === 'ended';
  if (!ended) {
    const now = await e.near.chainTimeMs();
    const cancel = chain.pending_change;
    const cancelled = cancel?.kind === 'cancel' && cancel.effective_at_ms <= now;
    if (now < chain.end_ms && !cancelled)
      throw new DomainError(
        'conflict',
        'A plan can be finalized only after it ends or a cancellation takes effect',
      );
  } else if (chain.asset.type !== 'nep141' || (await planBalance(e, chain)) === 0n)
    throw new DomainError('conflict', 'This plan is already finalized and released');
  await spendRelayer(e);
  // Started first, so a crash after finalizing still publishes an end_reveal plan's terms.
  await startOnce(revealPlanWorkflow, `reveal:${planId}`, planId);
  const relayer = e.near.account(e.world.relayer, e.world.keys[e.world.relayer] as KeyPairString);
  const out = await e.near.call(
    relayer,
    e.world.registry,
    'finalize',
    { plan_id: planId },
    { gasTera: 200 },
  );
  if (!out.ok) throw refusal('The registry refused to finalize', out);
  await record(
    e.db,
    planId,
    ended ? 'release_retried' : 'plan_ended',
    ended
      ? 'Release of the remaining tokens retried'
      : 'Plan ended; remaining tokens released to the beneficiary',
    { txHash: out.txHash },
  );
  return { txHash: out.txHash };
}

/** Largest revealed plan the registry stores; a real plan is well under 1 KB of JSON. */
const MAX_REVEAL_JSON = 4096;

export const RevealInput = z.object({
  plan_json: z.string().min(2).max(MAX_REVEAL_JSON),
  salt: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Publishes a finished plan's sealed terms from the owner's backup file. Anyone may: the registry
 * accepts only terms that hash, with the salt, to the plan's commitment. Checked here first so a
 * wrong file gets a clear answer instead of a refused transaction.
 */
export async function revealFromBackup(
  e: Engine,
  planId: number,
  input: z.input<typeof RevealInput>,
) {
  const p = parseInput(RevealInput, input);
  const chain = await e.registry.plan(planId);
  if (!chain) throw new DomainError('not_found', 'Plan not found');
  if (chain.status !== 'ended')
    throw new DomainError('conflict', 'A plan can be revealed only after it ends');
  const digest = sha256Hex(concatBytes(utf8ToBytes(p.plan_json), hexToBytes(p.salt)));
  if (digest !== chain.commitment)
    throw new DomainError('invalid', 'These terms and salt do not match the plan’s commitment');
  if (await e.near.view(e.world.registry, 'get_reveal', { plan_id: planId }))
    throw new DomainError('conflict', 'This plan’s terms are already revealed');
  await spendRelayer(e);
  return submitReveal(e, planId, p.plan_json, p.salt, 'owner backup');
}

/** The one call that publishes a reveal on-chain; the registry accepts it once, against the commitment. */
export async function revealOnChain(e: Engine, planId: number, planJson: string, salt: string) {
  const relayer = e.near.account(e.world.relayer, e.world.keys[e.world.relayer] as KeyPairString);
  const out = await e.near.call(
    relayer,
    e.world.registry,
    'reveal_plan',
    { plan_id: planId, plan_json: planJson, salt },
    { gasTera: 100, deposit: STORAGE_DEPOSIT },
  );
  return out.ok
    ? { ok: true as const, txHash: out.txHash as string | null }
    : { ok: false as const, code: out.code, txHash: out.txHash };
}

/** Publishes a reveal and records it (the owner's path; the enclave's runs in reveal_plan). */
export async function submitReveal(
  e: Engine,
  planId: number,
  planJson: string,
  salt: string,
  source: string,
) {
  const out = await revealOnChain(e, planId, planJson, salt);
  if (!out.ok)
    throw new DomainError('policy_error', `The registry refused the reveal: ${out.code}`, {
      code: out.code,
      txHash: out.txHash,
    });
  await record(
    e.db,
    planId,
    'plan_revealed',
    `The sealed terms were published from the ${source} and match the commitment`,
    { txHash: out.txHash },
  );
  return { txHash: out.txHash };
}

/**
 * The founder tries to move tokens straight out of the plan account. The plan account's code
 * accepts only the registry, so this is refused on-chain; the result is shown, not thrown.
 */
export async function tryDirectTransfer(
  e: Engine,
  principal: PlanPrincipal,
  planId: number,
  input: z.input<typeof ActorOnly>,
) {
  const p = parseInput(ActorOnly, input);
  const row = await loadPlanRow(e, principal, planId, p.actor);
  await spendRelayer(e);
  if (row.tokenChain !== 'near')
    throw new DomainError('invalid', 'Direct transfer applies to NEAR tokens');
  // The insider acts alone with their own key, even when a DAO owns the plan.
  const out = await e.near.call(
    founderAccount(e),
    row.planAccount,
    'send',
    {
      token: row.tokenAddress,
      receiver_id: p.actor,
      amount: '1',
      memo: null,
      register_receiver: false,
    },
    { deposit: 1n },
  );
  await record(
    e.db,
    planId,
    'bypass_refused',
    `Direct transfer attempt: ${out.ok ? 'accepted (unexpected)' : `refused (${out.code})`}`,
    {
      txHash: out.txHash,
    },
  );
  return attemptView(out);
}

/**
 * The founder tries to add their own key to the plan account. The account has no key to sign
 * with, so NEAR itself rejects the transaction before any code runs.
 */
export async function tryAddKey(
  e: Engine,
  principal: PlanPrincipal,
  planId: number,
  input: z.input<typeof ActorOnly>,
) {
  const p = parseInput(ActorOnly, input);
  const row = await loadPlanRow(e, principal, planId, p.actor);
  const founderKey = KeyPair.fromString(e.world.keys[e.world.founder] as KeyPairString);
  const asPlanAccount = e.near.account(row.planAccount, founderKey.toString() as KeyPairString);
  let outcome: { ok: boolean; code: string; error: string; txHash: string };
  try {
    const out = await e.near.send(asPlanAccount, row.planAccount, [
      actions.addFullAccessKey(founderKey.getPublicKey()),
    ]);
    outcome = out.ok
      ? { ok: true, code: 'accepted', error: '', txHash: out.txHash }
      : { ok: false, code: out.code, error: out.error, txHash: out.txHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome = { ok: false, code: 'no_access_key', error: message.slice(0, 300), txHash: '' };
  }
  await record(
    e.db,
    planId,
    'bypass_refused',
    `Add-key attempt: ${outcome.ok ? 'accepted (unexpected)' : 'refused: the plan account has no keys'}`,
    {},
  );
  return { refused: !outcome.ok, code: outcome.code, error: outcome.error, txHash: outcome.txHash };
}

const attemptView = (out: TxOutcome) =>
  out.ok
    ? { refused: false, code: 'accepted', error: '', txHash: out.txHash }
    : { refused: true, code: out.code, error: out.error, txHash: out.txHash };

export const LaunchInput = z.object({
  actor: AccountId,
  name: z.string().trim().min(2).max(40),
  team_allocation: TokenAmount,
  founder_allocation: TokenAmount,
  listing_price_usd: UsdDecimal,
});

/**
 * Launches the plan's token with the team allocation minted straight into the plan account (NEAR)
 * or the plan's Chain Signatures address (EVM), so it never sits under an insider's key.
 */
export async function launchToken(
  e: Engine,
  principal: PlanPrincipal,
  planId: number,
  input: z.input<typeof LaunchInput>,
) {
  const p = parseInput(LaunchInput, input);
  const row = await loadPlanRow(e, principal, planId, p.actor);
  const chain = await e.registry.plan(planId);
  if (!chain) throw new DomainError('not_found', 'Plan not found');
  if (row.tokenChain === 'near' && !nearTokensEnabled(e))
    throw new DomainError('unavailable', 'NEAR token launches are off on this server');
  return withLaunchLock(e, planId, row.tokenChain === 'evm', async () => {
    // Checked before anything is written: a plan naming a token that already exists (someone
    // else's) must not get to set its price.
    const launched =
      row.tokenChain === 'near'
        ? await e.near.accountExists(row.tokenAddress)
        : await e.evm.hasCode(row.tokenAddress as Hex);
    if (launched) throw new DomainError('conflict', 'This token is already launched');
    if (row.tokenChain === 'evm') {
      if (!chain.evm_address)
        throw new DomainError('conflict', 'The plan has no Chain Signatures address yet');
      if ((await predictEvmTokenAddress(e)) !== row.tokenAddress)
        throw new DomainError('conflict', 'The launchpad address moved on; create the plan again');
    }
    // A NEAR launch is paid by the relayer; an EVM launch by the Sepolia funder.
    await (row.tokenChain === 'near' ? spendRelayer(e) : assertReserve(e, 'evm'));
    await chargeDaily(e.db, 'token_launched', e.config.MAX_LAUNCHES_PER_DAY);
    // The simulated market learns the listing price first: a crash after the launch must not
    // leave a token the 1Click simulator cannot price (a no-op for listed tokens, priced live).
    await updateSimSettings(e.db, (s) => {
      s.market.assets[row.tokenAddress.toLowerCase()] = {
        basePriceE6: usdToE6(p.listing_price_usd).toString(),
      };
    });
    const txHash =
      row.tokenChain === 'near'
        ? await launchNearToken(e, row, chain.plan_account, p)
        : await launchEvmToken(e, row, chain, p);
    // From now on this plan alone may enroll this token, and only up to what it minted the founder.
    await e.db
      .update(plans)
      .set({ launchedToken: row.tokenAddress, founderAllocation: p.founder_allocation.toString() })
      .where(eq(plans.id, planId));
    await record(
      e.db,
      planId,
      'token_launched',
      `${row.tokenSymbol} launched; team allocation minted into the plan account`,
      { txHash, teamAllocation: p.team_allocation.toString() },
    );
    return { txHash };
  });
}

type PlanRow = typeof plans.$inferSelect;
type Launch = z.output<typeof LaunchInput>;

/**
 * Creates the NEP-141 account. With the demo token's code published as a global contract the
 * account only references it and needs storage for its state; otherwise it stores its own copy.
 */
async function launchNearToken(e: Engine, row: PlanRow, planAccount: string, p: Launch) {
  const root = e.near.account(e.world.root, e.world.keys[e.world.root] as KeyPairString);
  const globalHash = e.world.demoTokenCodeHash;
  const wasm = globalHash ? null : demoTokenWasm();
  // Storage is 1 byte = 10^19 yocto; 0.2 NEAR covers the token's state and balances. More would
  // only sit there (on testnet it comes out of a shared, finite account).
  const funding = BigInt(wasm?.length ?? 0) * 10n ** 19n + NEAR / 5n;
  const out = await e.near.send(root, row.tokenAddress, [
    actions.createAccount(),
    actions.transfer(funding),
    globalHash
      ? actions.useGlobalContract({ codeHash: globalHash })
      : actions.deployContract(new Uint8Array(wasm as Buffer)),
    actions.functionCall(
      'new',
      {
        owner_id: p.actor,
        metadata: {
          spec: 'ft-1.0.0',
          name: p.name,
          symbol: row.tokenSymbol,
          decimals: row.tokenDecimals,
        },
        allocations: [
          [planAccount, p.team_allocation.toString()],
          [p.actor, p.founder_allocation.toString()],
        ],
      },
      teraToGas(100),
      0n,
    ),
  ]);
  if (!out.ok) throw refusal('The token launch failed', out);
  return out.txHash;
}

/** Deploys the ERC-20 from the launchpad and funds the plan address's gas, both at today's fees. */
async function launchEvmToken(
  e: Engine,
  row: PlanRow,
  chain: { evm_address: string | null; envelope: { max_amount_per_tx: string } },
  p: Launch,
) {
  const planAddress = chain.evm_address as Hex;
  const launchpad = privateKeyToAccount(e.evm.launchpadKey).address;
  // Topping up does not move the launchpad's nonce, so the predicted token address stays valid.
  const deployCost = await e.evm.gasCostWei(DEPLOY_GAS);
  await e.evm.ensureBalance(launchpad, deployCost, 2n * deployCost);
  const deployed = await e.evm.deployLaunchTokenFrom(e.evm.launchpadKey, p.name, row.tokenSymbol, [
    { holder: planAddress, amount: p.team_allocation },
    { holder: launchpad, amount: p.founder_allocation },
  ]);
  if (deployed.address !== row.tokenAddress)
    throw new DomainError('conflict', 'The token deployed at an unexpected address');
  // Selling the allocation takes at least this many sales (the public per-sale cap, rounded up);
  // gasAllowanceWei funds at most 20 of them.
  const perSale = BigInt(chain.envelope.max_amount_per_tx);
  const sales = perSale > 0n ? (p.team_allocation + perSale - 1n) / perSale : 1n;
  const allowance = await e.evm.gasAllowanceWei(Number(sales > 1000n ? 1000n : sales));
  await e.evm.fundGas(planAddress, allowance);
  return deployed.txHash;
}

/**
 * The address the next launchpad deployment will get (CREATE: deployer and nonce). `forVisitor`
 * reads through the public read clients, so page views never use the engine's RPC budget.
 */
export async function predictEvmTokenAddress(e: Engine, forVisitor = false): Promise<Hex> {
  const from = privateKeyToAccount(e.evm.launchpadKey).address;
  const nonce = forVisitor
    ? await e.reads.evm.getTransactionCount({ address: from, blockTag: 'pending' })
    : await e.evm.nonceOf(from);
  return getContractAddress({ from, nonce: BigInt(nonce) }).toLowerCase() as Hex;
}

/** The Chain Signatures address a new EVM plan will control, before the plan exists. */
export async function predictPlanEvmAddress(e: Engine, forVisitor = false): Promise<Hex> {
  const near = forVisitor ? e.reads.near : e.near;
  const config = await near.view<{ next_plan_id: number }>(e.world.registry, 'get_config');
  return deriveEvmAddress(
    e.world.mpcRootPublicKey,
    e.world.registry,
    planPath(config.next_plan_id),
  );
}

export const EnrollInput = z.object({
  actor: AccountId,
  amount: z.string().regex(/^\d+(\.\d+)?$/),
});

/** Moves more of the owner's tokens into the plan account (NEAR tokens). */
export async function enroll(
  e: Engine,
  principal: PlanPrincipal,
  planId: number,
  input: z.input<typeof EnrollInput>,
) {
  const p = parseInput(EnrollInput, input);
  const row = await loadPlanRow(e, principal, planId, p.actor);
  if (row.tokenChain !== 'near')
    throw new DomainError('invalid', 'Top-ups through the app are for NEAR tokens');
  // The persona's balance is the relayer's on testnet and holds other tokens (the proceeds float,
  // other plans' allocations), so a plan may enroll only the token it launched itself.
  if (row.launchedToken !== row.tokenAddress || row.founderAllocation === null)
    throw new DomainError('invalid', 'Only the token this plan launched can be enrolled');
  const amount = toBaseUnits(p.amount, row.tokenDecimals);
  if (amount <= 0n) throw new DomainError('invalid', 'Enroll a positive amount');
  await spendRelayer(e);
  // Reserved before the transfer in one statement, so concurrent requests cannot together pass
  // the founder allocation; given back if the transfer is refused.
  const reserve = (delta: bigint) =>
    e.db
      .update(plans)
      .set({ enrolled: sql`${plans.enrolled} + ${delta.toString()}::numeric` })
      .where(
        and(
          eq(plans.id, planId),
          sql`${plans.enrolled} + ${delta.toString()}::numeric <= ${plans.founderAllocation}`,
        ),
      )
      .returning({ id: plans.id });
  if (!(await reserve(amount)).length)
    throw new DomainError(
      'invalid',
      'That is more than the founder allocation this plan launched with',
    );
  const out = await ownerCall(
    e,
    p.actor,
    row.tokenAddress,
    'ft_transfer',
    { receiver_id: row.planAccount, amount: amount.toString(), memo: `enroll plan ${planId}` },
    { deposit: 1n, gasTera: 50 },
  );
  if (!out.ok) {
    await reserve(-amount);
    throw refusal('The transfer was refused', out);
  }
  await recordProposal(e, planId, out, 'enroll more tokens');
  await record(e.db, planId, 'enrolled', `Enrolled ${p.amount} ${row.tokenSymbol}`, {
    txHash: out.txHash,
  });
  return { txHash: out.txHash };
}

/**
 * The plan an owner action is for, once the principal may manage it: the operator, or whoever
 * holds the plan's key. `actor` then only has to be the persona that owns it on chain.
 */
async function loadPlanRow(e: Engine, principal: PlanPrincipal, planId: number, actor: string) {
  const [row] = await e.db.select().from(plans).where(eq(plans.id, planId));
  if (!row) throw new DomainError('not_found', 'Plan not found');
  authorizePlan(row, principal);
  if (row.owner !== actor) throw new DomainError('not_found', 'Plan not found');
  return row;
}

/** Namespace of the per-plan advisory locks taken around a token launch ("lnch"). */
const LAUNCH_LOCK = 0x6c6e6368;

/** The lock every EVM launch also takes: they share the launchpad's nonce. */
const LAUNCHPAD_LOCK_ID = 0;

/**
 * Runs `fn` holding this plan's launch lock, so two concurrent launches cannot both deploy and
 * fund, and for an EVM launch the launchpad's too, since each deployment takes its next nonce.
 * Transaction-scoped advisory locks: released however `fn` ends, crash included.
 */
async function withLaunchLock<T>(
  e: Engine,
  planId: number,
  evm: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  return e.db.transaction(async (tx) => {
    const take = async (id: number) => {
      const [row] = (
        await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(${LAUNCH_LOCK}::int, ${id}::int) as locked`,
        )
      ).rows;
      return Boolean(row?.locked);
    };
    if (!(await take(planId)))
      throw new DomainError('conflict', 'This plan’s token is already launching');
    if (evm && !(await take(LAUNCHPAD_LOCK_ID)))
      throw new DomainError('conflict', 'Another token is launching; try again in a minute');
    return fn();
  });
}

function refusal(message: string, out: TxOutcome): DomainError {
  if (out.ok) return new DomainError('conflict', message);
  return new DomainError('policy_error', `${message}: ${out.code}`, {
    code: out.code,
    txHash: out.txHash,
  });
}
