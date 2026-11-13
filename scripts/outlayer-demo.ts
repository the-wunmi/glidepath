/**
 * One EVM plan on Sepolia sold by the OutLayer enclave, end to end, against an API started with
 * ENCLAVE_BACKEND=outlayer:
 *
 *   VSP_API=http://127.0.0.1:4410 pnpm outlayer:demo
 *
 * Before sealing it checks what the browser would: the API's enclave key is the one the attested
 * key-proof run named (deployments/outlayer-testnet.json, signature checked), and the registry
 * pins it with that run's measurements and quote hash. Then it creates the plan, waits for the
 * OutLayer-signed ack, launches the token into the plan's Chain Signatures address, and waits for
 * a sale the registry accepted.
 */
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  canonicalJson,
  type Envelope,
  fromBase64,
  newSaltHex,
  parseInput,
  parseNearKey,
  planCommitment,
  SealedPlan,
  type SealedPlanInput,
  sealTo,
  utf8ToBytes,
} from '@vsp/core';
import { OutLayerDeployment } from '@vsp/engine';
import { api, envelopeBody, type Meta, tokens, waitFor } from './lib/api.ts';

const DAY = 86_400_000;
const ok = (s: string) => console.log(`  ✓ ${s}`);

interface PlanDetail {
  plan: { status: string; next_seq: number; evm_address: string | null; acked_by: string | null };
  receipts: { seq: number; status: string; enclave_key: string | null }[];
  executions: { seq: number; status: string; chainTx: string | null; evmTxHash: string | null }[];
}
const detail = (id: number) => api<PlanDetail>(`/api/plans/${id}`);

function checkEnclave(meta: Meta): OutLayerDeployment {
  const d = OutLayerDeployment.parse(
    JSON.parse(
      readFileSync(new URL('../deployments/outlayer-testnet.json', import.meta.url), 'utf8'),
    ),
  );
  const proof = JSON.parse(d.keyProof.json) as { signing_key: string; encryption_key_hex: string };
  const signed = ed25519.verify(
    fromBase64(d.keyProof.signature),
    utf8ToBytes(`vsp/key-proof/v1\n${d.keyProof.json}`),
    parseNearKey(proof.signing_key).bytes,
  );
  const onchain = meta.registry.enclaves.find((x) => x.public_key === d.signingKey);
  const checks = [
    { rule: 'key proof signed by the key it names', ok: signed },
    { rule: 'the API presents the attested keys', ok: meta.enclave.signingKey === d.signingKey },
    {
      rule: 'plans seal to the attested key',
      ok: meta.enclave.encryptionKeyHex === proof.encryption_key_hex,
    },
    { rule: 'the registry pins the key', ok: !!onchain },
    { rule: 'with the run’s quote hash', ok: onchain?.quote_hash === d.attestation.quoteHash },
    {
      rule: 'and its measurements',
      ok: canonicalJson(onchain?.measurements ?? {}) === canonicalJson(d.attestation.measurements),
    },
  ];
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.rule}`);
  if (!checks.every((c) => c.ok)) throw new Error('The OutLayer enclave did not check out');
  return d;
}

async function main() {
  const meta = await api<Meta>('/api/meta');
  console.log('▸ Checking the OutLayer enclave');
  const d = checkEnclave(meta);
  console.log(`  attestation ${d.attestation.url}`);

  console.log('▸ Creating and sealing an EVM plan (Sepolia ERC-20, Chain Signatures address)');
  const next = await api<{ evmToken: string; planEvmAddress: string }>('/api/addresses/next');
  const founder = meta.accounts.founder as string;
  const start = meta.chainTimeMs + 60_000;
  const end = start + DAY;
  const token = {
    chain: 'evm' as const,
    chain_id: meta.evmChainId,
    address: next.evmToken,
    symbol: 'GLDE',
    decimals: 18,
  };
  const beneficiaryEvm = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  const input: SealedPlanInput = {
    version: 1,
    token,
    beneficiary: {
      near_account: founder,
      asset: `nep141:${meta.accounts.usdc}`,
      evm_address: beneficiaryEvm,
    },
    allocation: tokens('1000000'),
    period_days: 1,
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
  const envelope: Envelope = {
    period_ms: DAY,
    max_amount_per_period: BigInt(tokens('50000')),
    max_amount_per_tx: BigInt(tokens('5000')),
    min_price_usd_e6: 1_000_000n,
    min_gap_ms: 30_000,
  };
  const plan = parseInput(SealedPlan, input);
  const salt = newSaltHex();
  const commitment = planCommitment(plan, salt);
  const box = sealTo(
    d.encryptionKeyHex,
    JSON.stringify({ plan: JSON.parse(canonicalJson(plan)), salt }),
  );
  const created = await api<{ planId: number; txHash: string }>('/api/plans', {
    body: {
      actor: founder,
      label: 'OutLayer enclave proof',
      token,
      beneficiary: { near_account: founder, evm_address: beneficiaryEvm },
      proceeds_asset: `nep141:${meta.accounts.usdc}`,
      envelope: envelopeBody(envelope),
      disclosure: { type: 'realtime' },
      cooling_off_ms: 600_000,
      start_ms: start,
      end_ms: end,
      commitment,
      sealed_box: box,
    },
  });
  ok(`plan #${created.planId} committed (tx ${created.txHash})`);

  const active = await waitFor(
    'the OutLayer ack',
    async () => {
      const p = await detail(created.planId);
      return p.plan.status === 'active' ? p : null;
    },
    600_000,
  );
  ok(`acked by ${active.plan.acked_by}; Chain Signatures address ${active.plan.evm_address}`);

  await api(`/api/plans/${created.planId}/launch`, {
    body: {
      actor: founder,
      name: 'Glidepath OutLayer proof',
      team_allocation: tokens('1000000'),
      founder_allocation: tokens('1000'),
      listing_price_usd: '2.00',
    },
  });
  ok('GLDE launched on Sepolia into the plan address');

  const sold = await waitFor(
    'a sale signed in OutLayer and accepted by the registry',
    async () => {
      const p = await detail(created.planId);
      const r = p.receipts.find((x) => x.enclave_key === d.signingKey);
      return r ? { r, p } : null;
    },
    1_800_000,
  );
  const ex = sold.p.executions.find((x) => x.seq === sold.r.seq);
  ok(
    `sale #${sold.r.seq} on-chain, signed by ${sold.r.enclave_key} (NEAR tx ${ex?.chainTx ?? '?'})`,
  );
  console.log(JSON.stringify({ planId: created.planId, receipt: sold.r, execution: ex }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
