/**
 * Red-team run: scripted attempts to get around a sealed plan, each expected to be refused by the
 * chain. Run against a running stack with at least one active NEAR plan that has sold once
 * (pnpm dev, then pnpm demo, then pnpm redteam).
 *
 * The attacker has the founder's key. From the "fully compromised enclave" section on, it also has
 * the enclave's signing key: the worst case, a fully compromised TEE. Those rows show what the
 * registry still enforces on its own.
 * Writes data/redteam/results.json, which the app's red-team page shows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  ACK_DOMAIN,
  bytesToHex,
  EXECUTE_DOMAIN,
  type ExecuteRequest,
  formatNearKey,
  oneclickQuoteMessage,
  signingBytes,
  toBase64,
} from '@vsp/core';
import { createDb, createPool } from '@vsp/db';
import { deriveEnclaveKeys } from '@vsp/enclave';
import {
  enclaveHardwareSecret,
  loadWorld,
  REPO_DATA_DIR,
  resolveDataDir,
  SANDBOX_MS_PER_BLOCK,
} from '@vsp/engine';
import {
  actions,
  type ChainPlan,
  type ChainReceipt,
  KeyPair,
  type KeyPairString,
  NearClient,
} from '@vsp/near';
import type { QuoteResponse } from '@vsp/oneclick';
import { API, api, type Meta, sealPlan, waitFor } from './lib/api.ts';

const NEAR = 10n ** 24n;

interface Attempt {
  attack: string;
  attacker: string;
  expected: string;
  got: string;
  refused: boolean;
  txHash: string;
}

async function main() {
  const pool = createPool(process.env.DATABASE_URL);
  const w = await loadWorld(createDb(pool));
  await pool.end();
  const near = new NearClient(w.nearRpcUrl);
  const founder = near.account(w.founder, w.keys[w.founder] as KeyPairString);
  const plans = await near.view<ChainPlan[]>(w.registry, 'list_plans', { limit: 50 });
  const plan = plans.find(
    (p) => p.status === 'active' && p.asset.type === 'nep141' && p.owner === w.founder,
  );
  if (!plan) throw new Error('Needs an active NEAR plan owned by the founder: run pnpm demo first');
  const receipts = await near.view<ChainReceipt[]>(w.registry, 'get_receipts', {
    plan_id: plan.id,
    limit: 50,
  });
  const sold = receipts.find((r) => r.request_json);
  if (!sold)
    throw new Error('Needs at least one sale on the plan: wait for the enclave, then rerun');
  if (plan.asset.type !== 'nep141') throw new Error('unreachable');
  const token = plan.asset.token_id;

  const log: Attempt[] = [];
  const attempt = async (
    attack: string,
    attacker: string,
    expected: string,
    run: () => Promise<{ ok: boolean; code?: string; txHash?: string }>,
  ) => {
    let got: string;
    let refused: boolean;
    let txHash = '';
    try {
      const out = await run();
      refused = !out.ok;
      got = out.ok ? 'ACCEPTED' : (out.code ?? 'refused');
      txHash = out.txHash ?? '';
    } catch (error) {
      // Only NEAR refusing a transaction for lack of an access key is a refusal; anything else
      // (a failed fetch, a bug in this script) is an error and fails the run.
      const text = error instanceof Error ? error.message : String(error);
      // NEAR's own words for a transaction signed with a key the account does not have.
      const noKey = /access key|AccessKeyDoesNotExist/i.test(text);
      refused = noKey;
      got = noKey ? 'no_access_key' : `error: ${text.slice(0, 80)}`;
    }
    log.push({ attack, attacker, expected, got, refused, txHash });
    console.log(
      `${refused ? '✓ refused' : got.startsWith('error') ? '✗ ERROR' : '✗ ACCEPTED'}  ${attack}  →  ${got}`,
    );
  };
  const execute = (signer: typeof founder, request: string, signature: string, key: string) =>
    near.call(
      signer,
      w.registry,
      'execute',
      { plan_id: plan.id, request_json: request, signature, enclave_key: key },
      {
        gasTera: 300,
        deposit: NEAR / 20n,
      },
    );

  // ── The insider, with their own key ─────────────────────────────────────────
  await attempt(
    'Move tokens straight out of the plan account',
    'founder key',
    'only_registry',
    () =>
      near.call(
        founder,
        plan.plan_account,
        'send',
        { token, receiver_id: w.founder, amount: '1', memo: null, register_receiver: false },
        { deposit: 1n },
      ),
  );
  await attempt(
    'Release the plan account balance to themselves',
    'founder key',
    'only_registry',
    () => near.call(founder, plan.plan_account, 'release', { token, receiver_id: w.founder }),
  );
  await attempt('Add their own key to the plan account', 'founder key', 'no_access_key', () => {
    const k = KeyPair.fromString(w.keys[w.founder] as KeyPairString);
    return near.send(
      near.account(plan.plan_account, k.toString() as KeyPairString),
      plan.plan_account,
      [actions.addFullAccessKey(k.getPublicKey())],
    );
  });
  await attempt('Redeploy the registry with new code', 'founder key', 'no_access_key', () => {
    const k = KeyPair.fromString(w.keys[w.founder] as KeyPairString);
    return near.send(near.account(w.registry, k.toString() as KeyPairString), w.registry, [
      actions.deployContract(new Uint8Array([0])),
    ]);
  });
  const ownKey = ed25519.utils.randomSecretKey();
  const ownKeyId = formatNearKey('ed25519', ed25519.getPublicKey(ownKey));
  await attempt('Register their own "enclave" key', 'founder key', 'only_governance', () =>
    near.call(
      founder,
      w.registry,
      'register_enclave',
      {
        public_key: ownKeyId,
        measurements: {
          mrtd: '0'.repeat(96),
          rtmr0: '0'.repeat(96),
          rtmr1: '0'.repeat(96),
          rtmr2: '0'.repeat(96),
          rtmr3: '0'.repeat(96),
        },
        quote_hash: '0'.repeat(64),
      },
      { deposit: NEAR / 10n },
    ),
  );

  const fresh = await near.view<ChainPlan>(w.registry, 'get_plan', { plan_id: plan.id });
  let now = await near.chainTimeMs();
  const base = JSON.parse(sold.request_json as string) as ExecuteRequest;
  const request = (
    patch: Partial<ExecuteRequest>,
    actionPatch: Record<string, unknown> = {},
  ): ExecuteRequest => ({
    ...base,
    seq: fresh.next_seq,
    commitment: fresh.commitment,
    issued_at_ms: now,
    expires_at_ms: now + 120_000,
    ...patch,
    action: { ...base.action, ...actionPatch } as ExecuteRequest['action'],
  });
  const sign = (secret: Uint8Array, json: string, domain = EXECUTE_DOMAIN) =>
    toBase64(ed25519.sign(signingBytes(domain, json), secret));

  await attempt(
    'Sign a sale with a key that is not on the allowlist',
    'founder key',
    'unknown_enclave',
    () => {
      const json = JSON.stringify(request({}));
      return execute(founder, json, sign(ownKey, json), ownKeyId);
    },
  );
  await attempt('Replay an earlier enclave-signed sale', 'anyone', 'bad_seq', () =>
    execute(
      founder,
      sold.request_json as string,
      sold.signature as string,
      sold.enclave_key as string,
    ),
  );
  await attempt('Change the amount in a genuine signed sale', 'anyone', 'bad_signature', () => {
    const tampered = (sold.request_json as string).replace(
      `"amount":"${base.action.amount}"`,
      `"amount":"${BigInt(base.action.amount) * 2n}"`,
    );
    return execute(founder, tampered, sold.signature as string, sold.enclave_key as string);
  });
  await attempt('Claim the enclave key with a forged signature', 'anyone', 'bad_signature', () => {
    const json = JSON.stringify(request({}));
    return execute(founder, json, sign(ownKey, json), sold.enclave_key as string);
  });

  // ── A fully compromised enclave: the attacker holds its signing key ──────────
  const enclaveKey = deriveEnclaveKeys(
    enclaveHardwareSecret(resolveDataDir(process.env.DATA_DIR ?? REPO_DATA_DIR)),
  ).signing;
  const enclaveKeyId = formatNearKey('ed25519', ed25519.getPublicKey(enclaveKey));
  /**
   * Signs and submits as the compromised enclave, at the plan's current sequence number: the real
   * enclave keeps selling while these rows run, so a seq read earlier may be gone. If a real sale
   * lands between the read and the submit, the registry answers bad_seq before reaching the rule
   * under test; then the row is sent again at the new seq.
   */
  const signed = async (r: ExecuteRequest) => {
    for (let i = 0; ; i++) {
      const latest = await near.view<ChainPlan>(w.registry, 'get_plan', { plan_id: plan.id });
      const json = JSON.stringify({ ...r, seq: latest.next_seq });
      const out = await execute(founder, json, sign(enclaveKey, json), enclaveKeyId);
      if (out.ok || out.code !== 'bad_seq' || i >= 3) return out;
    }
  };
  /**
   * A genuine 1Click quote for whatever the attacker asks: quotes are free to request. Building
   * the sale on a real quote isolates the rule under test from the quote-binding checks.
   */
  const realQuoteSale = async (
    amount: bigint,
    slippageBps: number,
    recipient = fresh.beneficiary.near_account,
    refundTo = plan.plan_account,
    appFees?: { recipient: string; fee: number }[],
  ) => {
    const res = await fetch(`${API}/sim/1click/v0/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: slippageBps,
        originAsset: `nep141:${token}`,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: fresh.proceeds_asset,
        amount: amount.toString(),
        refundTo,
        refundType: 'ORIGIN_CHAIN',
        recipient,
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(now + 600_000).toISOString(),
        ...(appFees ? { appFees } : {}),
      }),
    });
    const quote = (await res.json()) as QuoteResponse;
    const deposit = quote.quote.depositAddress as string;
    return request(
      {
        settlement: {
          ...base.settlement,
          correlation_id: quote.correlationId,
          deposit_address: deposit,
          min_amount_out: quote.quote.minAmountOut,
          // 1Click's own format: Q and its ed25519:<base58> signature, exactly as 1Click returns them.
          quote: { payload: oneclickQuoteMessage(quote), signature: quote.signature },
        },
      },
      { amount: amount.toString(), receiver_id: deposit },
    );
  };
  const small = BigInt(fresh.envelope.max_amount_per_tx) / 10n;
  // A real sale may have just happened; move past the public minimum gap so each row below is
  // refused for its own rule, not for gap_too_short. Small steps keep in-flight txs valid.
  const gapBlocks = Math.ceil((fresh.envelope.min_gap_ms + 10_000) / SANDBOX_MS_PER_BLOCK);
  await near.fastForward(gapBlocks);
  now = await near.chainTimeMs();

  await attempt(
    'Sell more than the public per-sale cap in one go',
    'compromised enclave',
    'tx_cap_exceeded',
    async () => signed(await realQuoteSale(BigInt(fresh.envelope.max_amount_per_tx) + 1n, 100)),
  );
  await attempt(
    'Sell on a genuine quote whose guaranteed price is under the public floor',
    'compromised enclave',
    'below_floor',
    async () => signed(await realQuoteSale(small, 9_900)),
  );
  await attempt(
    'Send the proceeds to the attacker (genuine quote, attacker as recipient)',
    'compromised enclave',
    'quote_mismatch',
    async () =>
      signed(
        await realQuoteSale(
          small,
          100,
          w.founder === fresh.beneficiary.near_account ? w.relayer : w.founder,
        ),
      ),
  );
  await attempt(
    'Have a failed swap refund to the attacker (genuine quote, attacker as refund address)',
    'compromised enclave',
    'quote_mismatch',
    async () => signed(await realQuoteSale(small, 100, fresh.beneficiary.near_account, w.relayer)),
  );
  await attempt(
    'Invent a quote with a high guaranteed price (edit minAmountOut in a real 1Click-format quote)',
    'compromised enclave',
    'bad_quote_signature',
    async () => {
      const r = await realQuoteSale(small, 100);
      const payload = r.settlement.quote.payload.replace(
        `"minAmountOut":"${r.settlement.min_amount_out}"`,
        '"minAmountOut":"999999999999999"',
      );
      return signed({
        ...r,
        settlement: {
          ...r.settlement,
          min_amount_out: '999999999999999',
          quote: { ...r.settlement.quote, payload },
        },
      });
    },
  );
  await attempt(
    'Tamper with a genuine 1Click-format quote: swap in the attacker as recipient',
    'compromised enclave',
    'bad_quote_signature',
    async () => {
      const r = await realQuoteSale(small, 100);
      const attacker = w.founder === fresh.beneficiary.near_account ? w.relayer : w.founder;
      const payload = r.settlement.quote.payload.replace(
        `"recipient":"${fresh.beneficiary.near_account}"`,
        `"recipient":"${attacker}"`,
      );
      return signed({
        ...r,
        settlement: { ...r.settlement, quote: { ...r.settlement.quote, payload } },
      });
    },
  );
  await attempt(
    'Skim the sale through an app fee to the attacker (1Click signs it; 3% fee)',
    'compromised enclave',
    'quote_fee_too_high',
    async () =>
      signed(
        await realQuoteSale(small, 100, fresh.beneficiary.near_account, plan.plan_account, [
          { recipient: w.relayer, fee: 300 },
        ]),
      ),
  );
  await attempt(
    'Pay the sale to an address other than the 1Click deposit',
    'compromised enclave',
    'receiver_mismatch',
    () => signed(request({}, { receiver_id: w.founder })),
  );
  await attempt(
    'Submit a sale whose own compliance answers say no',
    'compromised enclave',
    'not_compliant',
    () => signed(request({ compliance: { ...base.compliance, above_floor: false } })),
  );

  // A genuine quote that already paid for a sale: still signed, still before its deadline.
  await attempt(
    'Reuse the 1Click quote of an earlier sale for a new one',
    'compromised enclave',
    'quote_used',
    () => signed(request({ settlement: base.settlement }, { amount: base.action.amount })),
  );

  // Governance colludes: registers a fresh enclave key and waits out only the registry-wide delay.
  await attempt(
    'Use a newly registered enclave key on a plan with a longer cooling-off',
    'governance (colluding) + new key',
    'key_too_new_for_plan',
    async () => {
      const governance = near.account(w.governance, w.keys[w.governance] as KeyPairString);
      const fresh2 = ed25519.utils.randomSecretKey();
      const fresh2Id = formatNearKey('ed25519', ed25519.getPublicKey(fresh2));
      const hex96 = '0'.repeat(96);
      const reg = await near.call(
        governance,
        w.registry,
        'register_enclave',
        {
          public_key: fresh2Id,
          measurements: { mrtd: hex96, rtmr0: hex96, rtmr1: hex96, rtmr2: hex96, rtmr3: hex96 },
          quote_hash: '0'.repeat(64),
        },
        { deposit: NEAR / 10n },
      );
      if (!reg.ok) return reg;
      const config = await near.view<{ enclave_activation_delay_ms: number }>(
        w.registry,
        'get_config',
      );
      await near.fastForward(
        Math.ceil((config.enclave_activation_delay_ms + 30_000) / SANDBOX_MS_PER_BLOCK),
      );
      now = await near.chainTimeMs();
      const latest = await near.view<ChainPlan>(w.registry, 'get_plan', { plan_id: plan.id });
      const json = JSON.stringify(
        request({
          seq: latest.next_seq,
          commitment: latest.commitment,
          issued_at_ms: now,
          expires_at_ms: now + 120_000,
        }),
      );
      return execute(founder, json, sign(fresh2, json), fresh2Id);
    },
  );

  // A rushed plan change: requested now, then acked and used at once by the compromised enclave.
  // Any new commitment will do: the registry never sees the plan behind it.
  const rushed = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  // Start from a plan with no change pending (the demo leaves one), so this row tests a fresh change.
  if (fresh.pending_change)
    await near.call(founder, w.registry, 'withdraw_change', { plan_id: plan.id });
  const changed = await near.call(
    founder,
    w.registry,
    'request_change',
    { plan_id: plan.id, commitment: rushed, envelope: fresh.envelope },
    { deposit: NEAR / 20n },
  );
  log.push({
    attack: 'Request a plan change (allowed: it starts a public cooling-off)',
    attacker: 'founder key',
    expected: 'accepted',
    got: changed.ok ? 'accepted' : (changed.code ?? '?'),
    refused: false,
    txHash: changed.txHash,
  });
  await attempt(
    'Apply the change before the cooling-off ends',
    'compromised enclave',
    'cooling_off',
    () => {
      const ack = JSON.stringify({
        type: 'ack',
        plan_id: plan.id,
        commitment: rushed,
        envelope: fresh.envelope,
        within_envelope: true,
        issued_at_ms: now + 1000,
      });
      return near.call(
        founder,
        w.registry,
        'ack_plan',
        {
          plan_id: plan.id,
          ack_json: ack,
          signature: sign(enclaveKey, ack, ACK_DOMAIN),
          enclave_key: enclaveKeyId,
        },
        { deposit: NEAR / 20n },
      );
    },
  );
  await attempt(
    'Sell under the new plan before it takes effect',
    'compromised enclave',
    'commitment_mismatch',
    () => signed(request({ commitment: rushed })),
  );
  await near.call(founder, w.registry, 'withdraw_change', { plan_id: plan.id });
  await attempt(
    'Cancel and take the tokens back at once',
    'founder key',
    'cooling_off',
    async () => {
      const c = await near.call(
        founder,
        w.registry,
        'request_cancel',
        { plan_id: plan.id },
        { deposit: NEAR / 20n },
      );
      if (!c.ok) return c;
      const out = await near.call(
        founder,
        w.registry,
        'finalize',
        { plan_id: plan.id },
        { gasTera: 200 },
      );
      await near.call(founder, w.registry, 'withdraw_change', { plan_id: plan.id });
      return out;
    },
  );

  // A cancel that has taken effect is final: withdrawing it would resume sales with no notice.
  // A fresh plan with the shortest cooling-off the registry allows makes this quick to reach.
  await attempt(
    'Withdraw a cancel after it took effect, to resume selling at once',
    'founder key',
    'cancel_effective',
    async () => {
      const meta = await api<Meta>('/api/meta');
      const config = await near.view<{ min_cooling_off_ms: number }>(w.registry, 'get_config');
      const start = (await near.chainTimeMs()) + 60_000;
      // A token of its own, never launched: a plan may not name a token another plan launched.
      const tokenRef = {
        chain: 'near' as const,
        address: `rtcx.${w.root}`,
        symbol: 'RTCX',
        decimals: 18,
      };
      const sealed = sealPlan(meta, {
        version: 1,
        token: tokenRef,
        beneficiary: { near_account: w.founder, asset: fresh.proceeds_asset },
        allocation: '1000000000000000000000000',
        period_days: 30,
        max_sell_per_period_bps: 100,
        max_sell_per_tx_bps: 10,
        price_floor_usd: '1.50',
        max_slippage_bps: 100,
        venues: ['1click'],
        schedule: { mode: 'randomized', min_gap_minutes: 60, max_gap_minutes: 120 },
        start: new Date(start).toISOString(),
        end: new Date(start + 365 * 86_400_000).toISOString(),
        on_end: 'release_remaining_to_beneficiary',
        price_sources: ['1click_quote', 'binance', 'coinbase'],
        price_agreement_bps: 150,
      });
      const created = await api<{ planId: number }>('/api/plans', {
        body: {
          actor: w.founder,
          label: 'Red-team cancel check',
          token: tokenRef,
          beneficiary: { near_account: w.founder },
          proceeds_asset: fresh.proceeds_asset,
          envelope: fresh.envelope,
          disclosure: { type: 'realtime' },
          cooling_off_ms: config.min_cooling_off_ms,
          start_ms: start,
          end_ms: start + 365 * 86_400_000,
          commitment: sealed.commitment,
          sealed_box: sealed.box,
        },
      });
      await waitFor(
        'red-team plan active',
        async () =>
          (await near.view<ChainPlan>(w.registry, 'get_plan', { plan_id: created.planId }))
            .status === 'active',
      );
      const c = await near.call(
        founder,
        w.registry,
        'request_cancel',
        { plan_id: created.planId },
        { deposit: NEAR / 20n },
      );
      if (!c.ok) return c;
      const blocks = Math.ceil((config.min_cooling_off_ms + 30_000) / SANDBOX_MS_PER_BLOCK);
      await near.fastForward(blocks);
      return near.call(founder, w.registry, 'withdraw_change', { plan_id: created.planId });
    },
  );

  // Re-signing an EVM transfer can change only its fees, and only the owner or beneficiary may.
  await attempt(
    "Re-sign someone else's EVM transfer with different fees",
    'relayer (an outsider)',
    'only_owner_or_beneficiary',
    async () => {
      const evmPlan = plans.find((p) => p.asset.type === 'evm_erc20' && p.status === 'active');
      if (!evmPlan) throw new Error('Needs an active EVM plan with a sale: run pnpm demo first');
      const evmReceipts = await near.view<ChainReceipt[]>(w.registry, 'get_receipts', {
        plan_id: evmPlan.id,
        limit: 50,
      });
      const last = evmReceipts.filter((r) => r.evm_signature).at(-1);
      if (!last) throw new Error('Needs a signed EVM sale: wait for one, then rerun');
      const relayer = near.account(w.relayer, w.keys[w.relayer] as KeyPairString);
      return near.call(
        relayer,
        w.registry,
        'resign_evm',
        {
          plan_id: evmPlan.id,
          seq: last.seq,
          max_fee_per_gas: '400000000000',
          max_priority_fee_per_gas: '400000000000',
        },
        { gasTera: 200, deposit: NEAR / 10n },
      );
    },
  );

  const verdict = (a: Attempt): 'refused' | 'accepted' | 'unexpected' => {
    if (a.expected === 'accepted') return a.got === 'accepted' ? 'accepted' : 'unexpected';
    return a.refused && a.got === a.expected ? 'refused' : 'unexpected';
  };
  const results = {
    generated_at: new Date().toISOString(),
    network: w.network ?? 'local',
    plan_id: plan.id,
    registry: w.registry,
    attempts: log.map((a) => ({
      attack: a.attack,
      attacker: a.attacker,
      expected: a.expected,
      got: a.got,
      verdict: verdict(a),
      tx_hash: a.txHash ?? null,
    })),
  };
  const out = new URL('../data/redteam/results.json', import.meta.url);
  mkdirSync(new URL('./', out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  const failures = log.filter((a) =>
    a.expected === 'accepted' ? a.got !== 'accepted' : !a.refused || a.got !== a.expected,
  );
  console.log(
    `\n${log.length} attempts; ${failures.length} not refused with the expected code. Wrote data/redteam/results.json`,
  );
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
