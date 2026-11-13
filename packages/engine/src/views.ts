import { DomainError } from '@vsp/core';
import { activity, executions, plans } from '@vsp/db';
import type { ChainEnclave, ChainPlan, RegistryConfig } from '@vsp/near';
import { desc, eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import { livePricePairs } from './config.ts';
import { type Engine, oneclickQuoteKey } from './context.ts';
import { serverLimits } from './guards.ts';
import { readSimSettings } from './sim-settings.ts';

/**
 * How each outside system runs, so the UI can label it honestly: `live` is a public network or
 * service, `local` a real node on this machine, `mock` a simulator of the real API.
 */
export function modes(e: Engine) {
  const testnet = e.world.network === 'testnet';
  const c = e.config;
  return {
    near: testnet ? 'live' : 'local',
    evm: c.EVM_NETWORK === 'sepolia' ? 'live' : c.EVM_NETWORK,
    chainSignatures: testnet ? 'live' : 'mock',
    oneclick: c.ONECLICK_MODE,
    enclave: c.ENCLAVE_BACKEND === 'outlayer' ? 'live' : 'mock',
    /** Live for listed tokens (LIVE_PRICE_SYMBOLS); demo tokens have no market. */
    prices: 'mixed',
  } as const;
}

export async function metaView(e: Engine) {
  const near = e.reads.near;
  const [identity, config, enclaves, chainTimeMs, sim, registryKeys] = await Promise.all([
    e.enclave.identity(),
    near.view<RegistryConfig>(e.world.registry, 'get_config'),
    near.view<ChainEnclave[]>(e.world.registry, 'get_enclaves', { limit: 50 }),
    near.chainTimeMs(),
    readSimSettings(e.db),
    near.fullAccessKeyCount(e.world.registry),
  ]);
  return {
    modes: modes(e),
    /** The public server: owner writes need the plan's key, the demo controls the operator's. */
    public: Boolean(e.config.PUBLIC_ORIGIN),
    limits: serverLimits(e),
    network: e.world.network ?? 'local',
    livePriceSymbols: [...livePricePairs(e.config).keys()],
    chainTimeMs,
    accounts: {
      registry: e.world.registry,
      signer: e.world.signer,
      usdc: e.world.usdc,
      founder: e.world.founder,
      governance: e.world.governance,
      relayer: e.world.relayer,
      dao: e.world.dao,
    },
    registry: { config, enclaves, accessKeys: registryKeys },
    enclave: identity,
    mpcRootPublicKey: e.world.mpcRootPublicKey,
    /** The key 1Click quotes are signed with (the simulator's in mock mode), pinned on-chain too. */
    quoteSigner: oneclickQuoteKey(e.config, e.world),
    evmChainId: e.world.evmChainId,
    sim,
  };
}

/** Plan summaries; owner filters to one account's plans. Chain state is the source of truth. */
export async function planList(e: Engine, owner?: string) {
  const [chainPlans, rows] = await Promise.all([
    e.reads.registry.plans(),
    e.db.select().from(plans),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return chainPlans
    .filter((p) => !owner || p.owner === owner)
    .map((p) => summary(p, byId.get(p.id)))
    .reverse();
}

type PlanRow = typeof plans.$inferSelect;

function summary(p: ChainPlan, row: PlanRow | undefined) {
  return {
    id: p.id,
    label: p.label,
    owner: p.owner,
    status: p.status,
    commitment: p.commitment,
    token: row
      ? {
          chain: row.tokenChain,
          address: row.tokenAddress,
          symbol: row.tokenSymbol,
          decimals: row.tokenDecimals,
        }
      : {
          chain: p.asset.type === 'nep141' ? 'near' : 'evm',
          address: p.asset.type === 'nep141' ? p.asset.token_id : p.asset.token_address,
          symbol: '?',
          decimals: p.token_decimals,
        },
    planAccount: p.plan_account,
    evmAddress: p.evm_address,
    pendingChange: p.pending_change,
    receiptCount: p.receipt_count,
    soldTotal: p.sold_total,
    createdAtMs: p.created_at_ms,
    startMs: p.start_ms,
    endMs: p.end_ms,
  };
}

/** Everything the plan page shows, read from the chain plus the app's own timeline. */
export async function planDetail(e: Engine, id: number) {
  const { near, registry } = e.reads;
  const chain = await registry.plan(id);
  if (!chain) throw new DomainError('not_found', 'Plan not found');
  const [[row], receipts, sales, timeline, keyCount, accountState] = await Promise.all([
    e.db.select().from(plans).where(eq(plans.id, id)),
    registry.receipts(id),
    e.db.select().from(executions).where(eq(executions.planId, id)).orderBy(desc(executions.seq)),
    e.db
      .select()
      .from(activity)
      .where(eq(activity.planId, id))
      .orderBy(desc(activity.id))
      .limit(100),
    near.fullAccessKeyCount(chain.plan_account),
    near.accountState(chain.plan_account),
  ]);
  const balance = await planBalance(e, chain).catch(() => null);
  return {
    plan: chain,
    summary: summary(chain, row),
    planAccount: {
      id: chain.plan_account,
      accessKeys: keyCount,
      codeHash:
        (accountState as { global_contract_hash?: string; code_hash?: string })
          .global_contract_hash ??
        (accountState as { code_hash?: string }).code_hash ??
        null,
    },
    balance: balance?.toString() ?? null,
    /**
     * Receipted on-chain but never sold (a reverted EVM transfer, a failed settlement). The
     * registry cannot see EVM outcomes, so its sold_total still counts these: limits only tighten.
     */
    failedTotal: sales
      .filter((s) => s.status === 'settlement_failed')
      .reduce((sum, s) => sum + BigInt(s.amount), 0n)
      .toString(),
    receipts,
    executions: sales.map((s) => ({
      seq: s.seq,
      kind: s.kind,
      amount: s.amount,
      status: s.status,
      chainTx: s.chainTx,
      chainError: s.chainError,
      evmTxHash: s.evmTxHash,
      settlementStatus: s.settlementStatus,
      depositAddress: s.depositAddress,
      minAmountOut: s.minAmountOut,
      amountOut: s.amountOut,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
    activity: timeline.map((a) => ({
      id: a.id,
      kind: a.kind,
      message: a.message,
      data: a.data,
      at: a.at.toISOString(),
    })),
    hasPendingSealedChange: Boolean(row?.pendingSealedBox),
    reveal: await near
      .view<{ plan_json: string; salt: string; revealed_at_ms: number } | null>(
        e.world.registry,
        'get_reveal',
        {
          plan_id: id,
        },
      )
      .catch(() => null),
  };
}

/** Lowercase addresses of the ERC-20 tokens plans sell: the only contracts /rpc/evm may call. */
export async function evmPlanTokens(e: Engine): Promise<Set<string>> {
  const rows = await e.db
    .select({ address: plans.tokenAddress })
    .from(plans)
    .where(eq(plans.tokenChain, 'evm'));
  return new Set(rows.map((r) => r.address.toLowerCase()));
}

export async function planBalance(e: Engine, plan: ChainPlan): Promise<bigint> {
  if (plan.asset.type === 'nep141') {
    const v = await e.reads.near.view<string>(plan.asset.token_id, 'ft_balance_of', {
      account_id: plan.plan_account,
    });
    return BigInt(v);
  }
  if (!plan.evm_address) return 0n;
  return e.evm.tokenBalance(plan.asset.token_address as Hex, plan.evm_address as Hex);
}
