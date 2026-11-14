import { fileURLToPath } from 'node:url';
import {
  ACK_DOMAIN,
  canonicalJson,
  concatBytes,
  type Envelope,
  EXECUTE_DOMAIN,
  envelopeJson,
  formatNearKey,
  fromBase64,
  hexToBytes,
  newSaltHex,
  oneclickQuoteMessage,
  oneclickSignedBytes,
  parseInput,
  parseNearKey,
  planCommitment,
  type SealedBox,
  SealedPlan,
  type SealedPlanInput,
  sealTo,
  sha256Hex,
  signingBytes,
  toBaseUnits,
  utf8ToBytes,
  verifySimulatedQuote,
} from '@glidepath/core';
import type { ChainPlan } from '@glidepath/near';
import type { QuoteRequest, QuoteResponse } from '@glidepath/oneclick';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { type EnclaveHost, type SealedStore, SimulatedEnclave } from '../src/index.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-12-01T00:00:00Z');
const tokens = (n: string) => toBaseUnits(n, 18);

const sealed: SealedPlanInput = {
  version: 1,
  token: { chain: 'near', address: 'acme.sandbox', symbol: 'ACME', decimals: 18 },
  beneficiary: { near_account: 'founder.sandbox', asset: 'nep141:usdc.sandbox' },
  allocation: tokens('1000000').toString(),
  period_days: 30,
  max_sell_per_period_bps: 200,
  max_sell_per_tx_bps: 50,
  price_floor_usd: '1.50',
  max_slippage_bps: 100,
  venues: ['1click'],
  schedule: { mode: 'randomized', min_gap_minutes: 0, max_gap_minutes: 1 },
  start: new Date(NOW).toISOString(),
  end: new Date(NOW + 365 * DAY).toISOString(),
  on_end: 'release_remaining_to_beneficiary',
  price_sources: ['1click_quote', 'binance', 'coinbase'],
  price_agreement_bps: 200,
};

const envelope: Envelope = {
  period_ms: 30 * DAY,
  max_amount_per_period: tokens('50000'),
  max_amount_per_tx: tokens('10000'),
  min_price_usd_e6: 1_000_000n,
  min_gap_ms: 0,
};

function chainPlan(commitment: string, overrides: Partial<ChainPlan> = {}): ChainPlan {
  return {
    id: 1,
    owner: 'founder.sandbox',
    commitment,
    asset: { type: 'nep141', token_id: 'acme.sandbox' },
    token_decimals: 18,
    quote_decimals: 6,
    beneficiary: { near_account: 'founder.sandbox', evm_address: null },
    proceeds_asset: 'nep141:usdc.sandbox',
    envelope: envelopeJson(envelope),
    disclosure: { type: 'realtime' },
    cooling_off_ms: 600_000,
    start_ms: NOW,
    end_ms: NOW + 365 * DAY,
    status: 'awaiting_ack',
    created_at_ms: NOW,
    acked_at_ms: null,
    acked_by: null,
    plan_account: 'p1.registry.sandbox',
    evm_address: null,
    evm_nonce: 0,
    evm_sign_pending: false,
    evm_pending_sign: null,
    next_seq: 0,
    period_index: 0,
    sold_in_period: '0',
    sold_total: '0',
    last_sale_ms: null,
    pending_change: null,
    receipt_count: 0,
    label: 'test',
    ...overrides,
  };
}

/** The fake 1Click's quote-signing key. */
const QUOTE_SECRET = new Uint8Array(32).fill(5);
const QUOTE_KEY = formatNearKey('ed25519', ed25519.getPublicKey(QUOTE_SECRET));

/** A market where both exchanges and 1Click agree on $2.00; `tamper` edits the quote after signing. */
function host(
  priceE6 = 2_000_000n,
  tamper: (q: QuoteResponse) => QuoteResponse = (q) => q,
  depositAddress = 'a'.repeat(64),
): EnclaveHost & { quotes: QuoteRequest[] } {
  const quotes: QuoteRequest[] = [];
  return {
    quotes,
    chainTimeMs: async () => NOW + 2 * 60_000,
    planBalance: async () => tokens('1000000'),
    receipt: async () => null,
    prices: async () => [
      { source: 'binance', priceE6 },
      { source: 'coinbase', priceE6 },
    ],
    quote: async (req) => {
      quotes.push(req);
      const amountOut = (BigInt(req.amount) * priceE6) / 10n ** 18n;
      const response: QuoteResponse = {
        correlationId: 'c-1',
        timestamp: new Date(NOW).toISOString(),
        signature: '',
        quoteRequest: req,
        quote: {
          amountIn: req.amount,
          amountInFormatted: '',
          amountInUsd: '100.000000000000',
          minAmountIn: req.amount,
          amountOut: amountOut.toString(),
          amountOutFormatted: '',
          amountOutUsd: '99.700000000000',
          minAmountOut: ((amountOut * 9_950n) / 10_000n).toString(),
          timeEstimate: 20,
          depositAddress,
          deadline: new Date(NOW + DAY).toISOString(),
        },
      };
      const message = oneclickSignedBytes(oneclickQuoteMessage(response));
      response.signature = formatNearKey('ed25519', ed25519.sign(message, QUOTE_SECRET));
      return tamper(response);
    },
    evmFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
  };
}

function memoryStore(): SealedStore & { rows: Map<string, SealedBox> } {
  const rows = new Map<string, SealedBox>();
  return { rows, get: async (k) => rows.get(k) ?? null, put: async (k, v) => void rows.set(k, v) };
}

function enclave(h = host(), store = memoryStore()) {
  return new SimulatedEnclave({
    hardwareSecret: new Uint8Array(32).fill(7),
    store,
    host: h,
    measuredDirs: [fileURLToPath(new URL('../src', import.meta.url))],
    quoteSignerKey: QUOTE_KEY,
    random: (n) => new Uint8Array(n).fill(1),
  });
}

async function seal(e: SimulatedEnclave, input: SealedPlanInput = sealed) {
  const plan = parseInput(SealedPlan, input);
  const salt = newSaltHex();
  const box = sealTo(
    (await e.identity()).encryptionKeyHex,
    JSON.stringify({ plan: JSON.parse(canonicalJson(plan)), salt }),
  );
  return { box, commitment: planCommitment(plan, salt) };
}

describe('the simulated enclave', () => {
  it('publishes a quote that binds its keys and verifies against its own registration', async () => {
    const e = enclave();
    const id = await e.identity();
    const result = verifySimulatedQuote(id.quote, {
      signingKey: id.signingKey,
      encryptionKeyHex: id.encryptionKeyHex,
      measurements: id.quote.measurements,
      quoteHash: id.quoteHash,
    });
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it('acks a plan that matches its commitment and sits inside the envelope, with a valid signature', async () => {
    const e = enclave();
    const { box, commitment } = await seal(e);
    const result = await e.acceptPlan(chainPlan(commitment), box);
    if (!result.ok) throw new Error(result.reasons.join('; '));
    const ack = JSON.parse(result.ack.json);
    expect(ack).toMatchObject({ type: 'ack', plan_id: 1, commitment, within_envelope: true });
    expect(
      ed25519.verify(
        fromBase64(result.ack.signature),
        signingBytes(ACK_DOMAIN, result.ack.json),
        parseNearKey(result.ack.enclaveKey).bytes,
      ),
    ).toBe(true);
  });

  it('refuses a plan that does not match the on-chain commitment', async () => {
    const e = enclave();
    const { box } = await seal(e);
    const result = await e.acceptPlan(chainPlan('ab'.repeat(32)), box);
    expect(result).toMatchObject({
      ok: false,
      reasons: ['The plan does not match the on-chain commitment'],
    });
  });

  it('refuses a sealed plan looser than the public envelope', async () => {
    const e = enclave();
    const { box, commitment } = await seal(e, { ...sealed, price_floor_usd: '0.50' });
    const result = await e.acceptPlan(chainPlan(commitment), box);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reasons).toContain(
        'Outside the public envelope: Price floor at or above the public floor',
      );
  });

  it('refuses a plan whose token differs from what the registry recorded', async () => {
    const e = enclave();
    const { box, commitment } = await seal(e);
    const result = await e.acceptPlan(
      chainPlan(commitment, { asset: { type: 'nep141', token_id: 'other.sandbox' } }),
      box,
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a box sealed to a different enclave', async () => {
    const other = new SimulatedEnclave({
      hardwareSecret: new Uint8Array(32).fill(9),
      store: memoryStore(),
      host: host(),
      measuredDirs: [fileURLToPath(new URL('../src', import.meta.url))],
      quoteSignerKey: QUOTE_KEY,
    });
    const { box, commitment } = await seal(other);
    const result = await enclave().acceptPlan(chainPlan(commitment), box);
    expect(result).toMatchObject({
      ok: false,
      reasons: ['The sealed plan could not be opened or read'],
    });
  });

  it('never stores the plan in plaintext', async () => {
    const store = memoryStore();
    const e = enclave(host(), store);
    const { box, commitment } = await seal(e);
    await e.acceptPlan(chainPlan(commitment), box);
    expect(JSON.stringify([...store.rows.values()])).not.toContain('price_floor_usd');
  });

  it('signs a sale with yes/no compliance only, paying the 1Click deposit address', async () => {
    const h = host();
    const e = enclave(h);
    const { box, commitment } = await seal(e);
    await e.acceptPlan(chainPlan(commitment), box);
    const tick = await e.tick(chainPlan(commitment, { status: 'active' }));
    if (tick.type !== 'execute') throw new Error(`expected a sale, got ${JSON.stringify(tick)}`);
    const request = JSON.parse(tick.request.json);
    expect(request.action).toMatchObject({ type: 'nep141_transfer', receiver_id: 'a'.repeat(64) });
    expect(Object.values(request.compliance).every((v) => v === true)).toBe(true);
    expect(tick.request.json).not.toContain('1.50');
    expect(
      ed25519.verify(
        fromBase64(tick.request.signature),
        signingBytes(EXECUTE_DOMAIN, tick.request.json),
        parseNearKey(tick.request.enclaveKey).bytes,
      ),
    ).toBe(true);
    expect(BigInt(request.action.amount)).toBeLessThanOrEqual(tokens('5000'));
  });

  it('gives an ERC-20 sale enough gas for a first transfer to a new holder', async () => {
    const token = `0x${'7'.repeat(40)}`;
    const deposit = `0x${'cd'.repeat(20)}`;
    const e = enclave(host(2_000_000n, (q) => q, deposit));
    const { box, commitment } = await seal(e, {
      ...sealed,
      token: { chain: 'evm', chain_id: 11155111, address: token, symbol: 'ACME', decimals: 18 },
      beneficiary: { ...sealed.beneficiary, evm_address: `0x${'b'.repeat(40)}` },
    });
    const evmPlan = {
      asset: { type: 'evm_erc20' as const, chain_id: 11155111, token_address: token },
      beneficiary: { near_account: 'founder.sandbox', evm_address: `0x${'b'.repeat(40)}` },
      evm_address: `0x${'e'.repeat(40)}`,
    };
    await e.acceptPlan(chainPlan(commitment, evmPlan), box);
    const tick = await e.tick(chainPlan(commitment, { ...evmPlan, status: 'active' }));
    if (tick.type !== 'execute') throw new Error(`expected a sale, got ${JSON.stringify(tick)}`);
    const action = JSON.parse(tick.request.json).action;
    expect(action).toMatchObject({ type: 'evm_erc20_transfer', to: deposit });
    // Measured on Sepolia: 142,134 gas to a new holder. The registry refuses more than 150,000.
    expect(action.gas_limit).toBeGreaterThanOrEqual(142_134);
    expect(action.gas_limit).toBeLessThanOrEqual(150_000);
  });

  it('skips the sale when the market is below the sealed floor', async () => {
    const e = enclave(host(1_200_000n));
    const { box, commitment } = await seal(e);
    await e.acceptPlan(chainPlan(commitment), box);
    const tick = await e.tick(chainPlan(commitment, { status: 'active' }));
    expect(tick).toMatchObject({ type: 'skipped' });
  });

  it('skips a quote that was not signed by 1Click', async () => {
    const e = enclave(
      host(2_000_000n, (q) => ({
        ...q,
        signature: formatNearKey(
          'ed25519',
          ed25519.sign(new Uint8Array(1), new Uint8Array(32).fill(8)),
        ),
      })),
    );
    const { box, commitment } = await seal(e);
    await e.acceptPlan(chainPlan(commitment), box);
    const tick = await e.tick(chainPlan(commitment, { status: 'active' }));
    expect(tick).toMatchObject({ type: 'skipped' });
    if (tick.type === 'skipped')
      expect(tick.reasons).toContain('The quote is not signed by 1Click');
  });

  it('skips a genuinely signed quote that pays someone other than the beneficiary', async () => {
    const h = host();
    const real = h.quote;
    h.quote = async (req) => real({ ...req, recipient: 'operator.sandbox' });
    const e = enclave(h);
    const { box, commitment } = await seal(e);
    await e.acceptPlan(chainPlan(commitment), box);
    const tick = await e.tick(chainPlan(commitment, { status: 'active' }));
    if (tick.type !== 'skipped') throw new Error(`expected a skip, got ${tick.type}`);
    expect(tick.reasons).toContain('The quote pays someone other than the beneficiary');
  });

  it('skips a genuinely signed quote whose cost is above the fee bound', async () => {
    // 1Click signs it, but $100 in for $90 out is a 10% cost: far above 50 bps + $1.00.
    const costly = (q: QuoteResponse): QuoteResponse => {
      const r = { ...q, quote: { ...q.quote, amountOutUsd: '90.000000000000' } };
      const message = oneclickSignedBytes(oneclickQuoteMessage(r));
      return { ...r, signature: formatNearKey('ed25519', ed25519.sign(message, QUOTE_SECRET)) };
    };
    const e = enclave(host(2_000_000n, costly));
    const { box, commitment } = await seal(e);
    await e.acceptPlan(chainPlan(commitment), box);
    const tick = await e.tick(chainPlan(commitment, { status: 'active' }));
    if (tick.type !== 'skipped') throw new Error(`expected a skip, got ${tick.type}`);
    expect(tick.reasons).toContain('The quote costs more than the fee bound allows');
  });

  it('does not sign a second sale while the first is still on its way to the chain', async () => {
    const e = enclave();
    const { box, commitment } = await seal(e);
    await e.acceptPlan(chainPlan(commitment), box);
    expect((await e.tick(chainPlan(commitment, { status: 'active' }))).type).toBe('execute');
    expect(await e.tick(chainPlan(commitment, { status: 'active' }))).toMatchObject({
      type: 'idle',
    });
  });

  it('will not ack a staged change before the on-chain cooling-off ends', async () => {
    const e = enclave();
    const { box, commitment } = await seal(e);
    await e.acceptPlan(chainPlan(commitment), box);
    const changed = await seal(e, { ...sealed, max_sell_per_period_bps: 100 });
    const pending = {
      kind: 'modify' as const,
      commitment: changed.commitment,
      envelope: envelopeJson(envelope),
      requested_at_ms: NOW,
      effective_at_ms: NOW + 30 * DAY,
    };
    const active = chainPlan(commitment, { status: 'active', pending_change: pending });
    expect((await e.stageChange(active, changed.box)).ok).toBe(true);
    expect((await e.tick(active)).type).not.toBe('ack_change');
  });

  it('takes over a plan another build accepted through a change, counting that build’s sales', async () => {
    let now = NOW + 60_000;
    const h = host();
    const e = enclave({ ...h, chainTimeMs: async () => now });
    // The same terms under a new salt, sealed to this enclave, which never held the plan.
    const moved = await seal(e);
    const pending = {
      kind: 'modify' as const,
      commitment: moved.commitment,
      envelope: envelopeJson(envelope),
      requested_at_ms: NOW,
      effective_at_ms: NOW + 600_000,
    };
    const earlier = chainPlan('cd'.repeat(32), {
      status: 'active',
      acked_by: 'ed25519:earlier',
      pending_change: pending,
    });
    expect(await e.stageChange(earlier, moved.box)).toEqual({ ok: true, reasons: [] });
    expect((await e.tick(earlier)).type).toBe('idle');
    now = NOW + 600_000;
    expect((await e.tick(earlier)).type).toBe('ack_change');

    // Applied. The earlier build already sold this period's whole sealed cap (2% of 1M).
    const applied = chainPlan(moved.commitment, {
      status: 'active',
      next_seq: 3,
      sold_in_period: tokens('20000').toString(),
      sold_total: tokens('20000').toString(),
      last_sale_ms: NOW + 500_000,
    });
    expect(await e.tick(applied)).toMatchObject({ type: 'idle', reason: 'Taking the plan over' });
    now += 10 * 60_000;
    expect(await e.tick(applied)).toMatchObject({ type: 'idle', reason: 'period_budget_used' });
    // The next period: a sale is decided (and quoted) for the next sequence number.
    now = NOW + 30 * DAY + 60_000;
    expect(h.quotes).toHaveLength(0);
    await e.tick(applied);
    expect(h.quotes).toHaveLength(1);
  });

  it('as a backup, counts sales another build made from the registry before selling', async () => {
    let now = NOW + 60_000;
    const h = host();
    const e = enclave({ ...h, chainTimeMs: async () => now });
    const { box, commitment } = await seal(e);
    // Sealed to this build too when the plan was made; the primary's ack is the one sent.
    expect((await e.acceptPlan(chainPlan(commitment), box)).ok).toBe(true);
    // The primary has since sold this period's whole sealed cap (2% of 1M) as seqs 0-2.
    const sold = chainPlan(commitment, {
      status: 'active',
      acked_by: 'ed25519:primary',
      next_seq: 3,
      sold_in_period: tokens('20000').toString(),
      sold_total: tokens('20000').toString(),
      last_sale_ms: NOW + 50_000,
    });
    now = NOW + 10 * 60_000;
    expect(await e.tick(sold)).toMatchObject({ type: 'idle', reason: 'period_budget_used' });
    expect(h.quotes).toHaveLength(0);
    // The next period: it sells, at the registry's next sequence number.
    now = NOW + 30 * DAY + 60_000;
    await e.tick(sold);
    expect(h.quotes).toHaveLength(1);
  });

  it('reveals the sealed terms only after the plan has ended, and only under end_reveal', async () => {
    const e = enclave();
    const { box, commitment } = await seal(e);
    await e.acceptPlan(chainPlan(commitment), box);
    const reveal = { type: 'end_reveal' as const };
    expect(
      await e.revealPlan(chainPlan(commitment, { status: 'active', disclosure: reveal })),
    ).toMatchObject({
      ok: false,
      reason: 'The plan has not ended',
    });
    expect(await e.revealPlan(chainPlan(commitment, { status: 'ended' }))).toMatchObject({
      ok: false,
      reason: 'The plan did not choose end_reveal',
    });
    const out = await e.revealPlan(chainPlan(commitment, { status: 'ended', disclosure: reveal }));
    if (!out.ok) throw new Error(out.reason);
    expect(sha256Hex(concatBytes(utf8ToBytes(out.planJson), hexToBytes(out.salt)))).toBe(
      commitment,
    );
  });

  it('stops everything when it is down', async () => {
    const e = new SimulatedEnclave({
      hardwareSecret: new Uint8Array(32).fill(7),
      store: memoryStore(),
      host: host(),
      measuredDirs: [fileURLToPath(new URL('../src', import.meta.url))],
      quoteSignerKey: QUOTE_KEY,
      isUp: async () => false,
    });
    await expect(e.tick(chainPlan('ab'.repeat(32), { status: 'active' }))).rejects.toThrow(
      'The enclave is down',
    );
  });
});
