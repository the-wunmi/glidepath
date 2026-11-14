/**
 * The demo script end to end against a running API:
 *   pnpm dev   (in another terminal)   then   pnpm demo
 * It creates and seals a NEAR plan and an EVM plan, launches each token with the team allocation
 * minted into the plan, tries to cheat, waits for the enclave to sell, and prints the receipts.
 */
import type { Envelope, SealedPlanInput } from '@vsp/core';
import { api, envelopeBody, type Meta, sealPlan, tokens, waitFor } from './lib/api.ts';

const DAY = 86_400_000;
const say = (s: string) => console.log(`\n▸ ${s}`);
const ok = (s: string) => console.log(`  ✓ ${s}`);

interface PlanDetail {
  plan: {
    status: string;
    next_seq: number;
    pending_change: { effective_at_ms: number } | null;
    evm_address: string | null;
  };
  planAccount: { id: string; accessKeys: number };
  balance: string | null;
  receipts: { seq: number; status: string; action_hash: string }[];
  executions: {
    seq: number;
    status: string;
    settlementStatus: string | null;
    evmTxHash: string | null;
  }[];
}

async function createSealedPlan(
  meta: Meta,
  opts: {
    label: string;
    symbol: string;
    chain: 'near' | 'evm';
    tokenAddress: string;
    beneficiaryEvm?: string;
    /** The owner: the founder, or the treasury DAO acting through a proposal. */
    owner?: string;
  },
) {
  const founder = opts.owner ?? (meta.accounts.founder as string);
  const start = meta.chainTimeMs + 60_000;
  const end = start + 365 * DAY;
  const allocation = tokens('10000000');
  const token =
    opts.chain === 'near'
      ? { chain: 'near' as const, address: opts.tokenAddress, symbol: opts.symbol, decimals: 18 }
      : {
          chain: 'evm' as const,
          chain_id: meta.evmChainId,
          address: opts.tokenAddress,
          symbol: opts.symbol,
          decimals: 18,
        };
  // The sealed plan: 2% a month, 0.25% a sale, never below $1.50, sales 1–3 minutes apart (demo pace).
  const sealed: SealedPlanInput = {
    version: 1,
    token,
    beneficiary: {
      near_account: founder,
      asset: `nep141:${meta.accounts.usdc}`,
      ...(opts.beneficiaryEvm ? { evm_address: opts.beneficiaryEvm } : {}),
    },
    allocation,
    period_days: 30,
    max_sell_per_period_bps: 200,
    max_sell_per_tx_bps: 25,
    price_floor_usd: '1.50',
    max_slippage_bps: 100,
    venues: ['1click'],
    schedule: { mode: 'randomized', min_gap_minutes: 1, max_gap_minutes: 3 },
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    on_end: 'release_remaining_to_beneficiary',
    price_sources: ['1click_quote', 'binance', 'coinbase'],
    price_agreement_bps: 150,
  };
  // The public envelope holders see: looser than the sealed plan, enforced by the contract.
  const envelope: Envelope = {
    period_ms: 30 * DAY,
    max_amount_per_period: BigInt(tokens('500000')),
    max_amount_per_tx: BigInt(tokens('50000')),
    min_price_usd_e6: 1_000_000n,
    min_gap_ms: 30_000,
  };
  const { commitment, box } = sealPlan(meta, sealed);
  const created = await api<{ planId: number; planAccount: string; txHash: string }>('/api/plans', {
    body: {
      actor: founder,
      label: opts.label,
      token,
      beneficiary: {
        near_account: founder,
        ...(opts.beneficiaryEvm ? { evm_address: opts.beneficiaryEvm } : {}),
      },
      proceeds_asset: `nep141:${meta.accounts.usdc}`,
      envelope: envelopeBody(envelope),
      disclosure: { type: 'delayed', delay_ms: 7 * DAY },
      cooling_off_ms: 30 * DAY,
      start_ms: start,
      end_ms: end,
      commitment,
      sealed_box: box,
    },
  });
  ok(`plan #${created.planId} committed: ${commitment.slice(0, 16)}…  (tx ${created.txHash})`);
  return { ...created, founder, envelope, sealed, commitment };
}

const detail = (id: number) => api<PlanDetail>(`/api/plans/${id}`);

async function main() {
  const meta = await api<Meta>('/api/meta');
  say('Create and seal a NEAR plan (ACME, team allocation minted into the plan account)');
  const near = await createSealedPlan(meta, {
    label: 'ACME team allocation',
    symbol: 'ACME',
    chain: 'near',
    tokenAddress: `acme.${meta.accounts.root}`,
  });
  const active = await waitFor('enclave ack', async () =>
    (await detail(near.planId)).plan.status === 'active' ? detail(near.planId) : null,
  );
  ok(
    `enclave acknowledged; plan account ${active.planAccount.id} has ${active.planAccount.accessKeys} access keys`,
  );
  await api(`/api/plans/${near.planId}/launch`, {
    body: {
      actor: near.founder,
      name: 'Acme Network',
      team_allocation: tokens('10000000'),
      founder_allocation: tokens('1000000'),
      listing_price_usd: '2.40',
    },
  });
  ok(`ACME launched; plan account balance ${(await detail(near.planId)).balance}`);

  say('Try to cheat');
  const direct = await api<{ refused: boolean; code: string }>(
    `/api/plans/${near.planId}/attempts/direct-transfer`,
    { body: { actor: near.founder } },
  );
  ok(
    `direct transfer: ${direct.refused ? `refused (${direct.code})` : 'ACCEPTED — this is a bug'}`,
  );
  const addKey = await api<{ refused: boolean; code: string }>(
    `/api/plans/${near.planId}/attempts/add-key`,
    { body: { actor: near.founder } },
  );
  ok(`add key: ${addKey.refused ? `refused (${addKey.code})` : 'ACCEPTED — this is a bug'}`);

  say('Create and seal an EVM plan (BOLT ERC-20 on the local EVM chain, via Chain Signatures)');
  const next = await api<{ evmToken: string; planEvmAddress: string }>('/api/addresses/next');
  const evm = await createSealedPlan(meta, {
    label: 'BOLT investor allocation',
    symbol: 'BOLT',
    chain: 'evm',
    tokenAddress: next.evmToken,
    beneficiaryEvm: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  });
  const evmActive = await waitFor('EVM plan ack', async () =>
    (await detail(evm.planId)).plan.status === 'active' ? detail(evm.planId) : null,
  );
  ok(`Chain Signatures address ${evmActive.plan.evm_address} (predicted ${next.planEvmAddress})`);
  await api(`/api/plans/${evm.planId}/launch`, {
    body: {
      actor: evm.founder,
      name: 'Bolt Protocol',
      team_allocation: tokens('10000000'),
      founder_allocation: tokens('1000000'),
      listing_price_usd: '2.00',
    },
  });
  ok(`BOLT launched; derived address balance ${(await detail(evm.planId)).balance}`);

  say('A treasury DAO adopts a sealed plan through a Sputnik proposal');
  const root = meta.accounts.root;
  const dao = await createSealedPlan(meta, {
    label: 'Treasury diversification',
    symbol: 'TRSY',
    chain: 'near',
    tokenAddress: `trsy.${root}`,
    owner: meta.accounts.dao as string,
  });
  await waitFor('DAO plan ack', async () =>
    (await detail(dao.planId)).plan.status === 'active' ? true : null,
  );
  ok(
    `plan #${dao.planId} is owned by ${meta.accounts.dao}, a DAO with no keys, and proceeds go to the treasury`,
  );

  say('Wait for the enclave to sell (random times inside the sealed plan)');
  for (const id of [near.planId, evm.planId]) {
    const settled = await waitFor(
      `a settled sale on plan ${id}`,
      async () => {
        const d = await detail(id);
        return d.executions.find((x) => x.status === 'settled') ? d : null;
      },
      420_000,
    );
    const sale = settled.executions.find((x) => x.status === 'settled');
    ok(
      `plan #${id}: sale #${sale?.seq} settled (1Click ${sale?.settlementStatus}${sale?.evmTxHash ? `, EVM tx ${sale.evmTxHash}` : ''})`,
    );
  }

  say('Edit the NEAR plan: a public cooling-off starts');
  const changed = sealPlan(meta, { ...near.sealed, max_sell_per_period_bps: 150 });
  const change = await api<{ effectiveAtMs: number }>(`/api/plans/${near.planId}/change`, {
    body: {
      actor: near.founder,
      commitment: changed.commitment,
      envelope: envelopeBody(near.envelope),
      sealed_box: changed.box,
    },
  });
  ok(
    `change takes effect at ${new Date(change.effectiveAtMs).toISOString()}; the old plan keeps running until then`,
  );

  console.log(
    `\nOpen http://localhost:3400/verify/${near.planId} and /verify/${evm.planId} to check the receipts in the browser.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
