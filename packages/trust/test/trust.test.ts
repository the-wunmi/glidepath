import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  bytesToHex,
  formatNearKey,
  oneclickSignedBytes,
  quoteHash,
  reportDataFor,
  type SealedBox,
  sealTo,
  sha256Hex,
  signSimulatedQuote,
  stableStringify,
} from '@vsp/core';
import { deriveEnclaveKeys, type SealedStore } from '@vsp/enclave';
import { describe, expect, it } from 'vitest';
import { SimulatedTrustEnclave } from '../src/enclave.ts';
import {
  type ChainTrust,
  type ChainTrustReceipt,
  decideRebalance,
  mandateCommitment,
  mandateProblems,
  parseMandate,
  sealedMandateJson,
  type TradeRequest,
  trustActionJson,
  verifyTrustReceipt,
} from '../src/index.ts';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ACCOUNT = 't1.trust.near';
const id = (t: string) => `nep141:${t}.near`;
const SALT = 'ab'.repeat(32);
const QUOTE_SECRET = new Uint8Array(32).fill(44);
const QUOTE_KEY = formatNearKey('ed25519', ed25519.getPublicKey(QUOTE_SECRET));
const HARDWARE = new Uint8Array(32).fill(9);

const mandate = parseMandate({
  version: 1,
  universe: [
    { asset: id('idx'), sector: 'broad' },
    { asset: id('bond'), sector: 'bonds' },
    { asset: id('oil'), sector: 'energy' },
  ],
  excluded_sectors: ['energy'],
  targets: [
    { asset: id('idx'), weight_bps: 6_000 },
    { asset: id('bond'), weight_bps: 4_000 },
  ],
  band_bps: 500,
  max_trade_usd: '500',
  min_trade_usd: '10',
  beneficiary: 'official.near',
  end: new Date(NOW + 365 * DAY).toISOString(),
});

const chain = (over: Partial<ChainTrust> = {}): ChainTrust => ({
  id: 1,
  owner: 'official.near',
  commitment: mandateCommitment(mandate, SALT),
  envelope: {
    excluded_assets: [id('oil')],
    period_ms: DAY,
    max_turnover_usd_e6: '1000000000',
    min_gap_ms: 0,
  },
  beneficiary: 'official.near',
  trust_account: ACCOUNT,
  cooling_off_ms: 600_000,
  start_ms: NOW - 1_000,
  end_ms: NOW + 365 * DAY,
  status: 'active',
  created_at_ms: NOW - 1_000,
  acked_at_ms: null,
  acked_by: null,
  holdings: ['idx.near'],
  next_seq: 0,
  period_index: 0,
  turnover_in_period_usd_e6: '0',
  last_trade_ms: null,
  pending_change: null,
  ended_at_ms: null,
  label: '',
  ...over,
});

const memoryStore = (): SealedStore => {
  const boxes = new Map<string, SealedBox>();
  return { get: async (k) => boxes.get(k) ?? null, put: async (k, b) => void boxes.set(k, b) };
};

const view = {
  holdings: [{ asset: id('idx'), amount: (1_000n * 10n ** 18n).toString(), decimals: 18 }],
  prices: [
    { asset: id('idx'), price_usd_e6: '2000000' },
    { asset: id('bond'), price_usd_e6: '2000000' },
  ],
};

/** A quote 1Click would sign for `request`, in its own format, with tweaks for the bad cases. */
function quoteFor(request: Record<string, unknown>, tweak: Partial<Record<string, unknown>> = {}) {
  const amount = String(request.amount);
  const q = {
    amount,
    amountIn: amount,
    amountInUsd: '500.000000000000',
    amountOut: '249000000000000000000',
    amountOutUsd: '498.000000000000',
    minAmountOut: '246510000000000000000',
    deadline: new Date(NOW + 600_000).toISOString(),
    depositAddress: 'aa'.repeat(32),
    destinationAsset: request.destinationAsset,
    dry: false,
    originAsset: request.originAsset,
    recipient: ACCOUNT,
    refundTo: ACCOUNT,
    swapType: 'EXACT_INPUT',
    depositType: 'ORIGIN_CHAIN',
    recipientType: 'DESTINATION_CHAIN',
    refundType: 'ORIGIN_CHAIN',
    ...tweak,
  };
  const payload = stableStringify(q);
  const signature = formatNearKey(
    'ed25519',
    ed25519.sign(oneclickSignedBytes(payload), QUOTE_SECRET),
  );
  return { payload, signature, correlation_id: 'corr-1' };
}

async function acceptedEnclave() {
  const enclave = new SimulatedTrustEnclave(HARDWARE, memoryStore(), QUOTE_KEY);
  const keys = deriveEnclaveKeys(HARDWARE);
  const box = sealTo(
    bytesToHex(x25519.getPublicKey(keys.encryption)),
    sealedMandateJson(mandate, SALT),
  );
  const accepted = await enclave.accept(chain({ status: 'awaiting_ack' }), box, NOW);
  return { enclave, accepted, keys };
}

describe('the mandate', () => {
  it('a target in an excluded sector is refused', () => {
    expect(mandateProblems({ ...mandate, excluded_sectors: ['bonds'] })).toEqual([
      'A target is in an excluded sector',
    ]);
  });

  it('a decision never buys an asset the envelope excludes', () => {
    const decision = decideRebalance({
      mandate,
      envelope: { ...chain().envelope, excluded_assets: [id('oil'), id('bond')] },
      counters: chain(),
      holdings: [
        { asset: id('idx'), amount: (600n * 10n ** 18n).toString(), decimals: 18 },
        { asset: id('bond'), amount: (400n * 10n ** 18n).toString(), decimals: 18 },
      ],
      prices: view.prices,
      now_ms: NOW,
    });
    expect(decision).toMatchObject({ type: 'trade', origin: id('bond'), destination: id('idx') });
  });
});

describe('the simulated trust enclave', () => {
  it('opens the sealed mandate, decides a trade and signs it with yes/no statements only', async () => {
    const { enclave, accepted } = await acceptedEnclave();
    expect(accepted.ok).toBe(true);
    const tick = await enclave.tick(chain(), view, NOW);
    expect(tick.type).toBe('quote');
    if (tick.type !== 'quote') return;
    expect(tick.quoteRequest).toMatchObject({
      originAsset: id('idx'),
      destinationAsset: id('bond'),
      recipient: ACCOUNT,
      refundTo: ACCOUNT,
    });
    const traded = await enclave.trade(chain(), quoteFor(tick.quoteRequest), NOW + 1_000);
    expect(traded.type).toBe('execute');
    if (traded.type !== 'execute') return;
    const request = JSON.parse(traded.request.json) as TradeRequest;
    expect(request.attestation).toEqual({
      within_mandate: true,
      not_excluded: true,
      within_turnover: true,
    });
    expect(request.origin_token).toBe('idx.near');
  });

  it('a quote paying outside the trust is skipped without saying why', async () => {
    const { enclave } = await acceptedEnclave();
    const tick = await enclave.tick(chain(), view, NOW);
    if (tick.type !== 'quote') throw new Error('expected a trade');
    const out = await enclave.trade(
      chain(),
      quoteFor(tick.quoteRequest, { recipient: 'official.near' }),
      NOW,
    );
    expect(out).toEqual({ type: 'skipped' });
  });

  it('a mandate for another beneficiary is refused', async () => {
    const enclave = new SimulatedTrustEnclave(HARDWARE, memoryStore(), QUOTE_KEY);
    const keys = deriveEnclaveKeys(HARDWARE);
    const box = sealTo(
      bytesToHex(x25519.getPublicKey(keys.encryption)),
      sealedMandateJson(mandate, SALT),
    );
    const out = await enclave.accept(
      chain({ status: 'awaiting_ack', beneficiary: 'someone-else.near' }),
      box,
      NOW,
    );
    expect(out).toEqual({ ok: false, reasons: ['The beneficiary differs from the contract'] });
  });
});

describe('receipt verification', () => {
  it('a receipt verifies from chain data, and a changed amount fails it', async () => {
    const { enclave, keys } = await acceptedEnclave();
    const tick = await enclave.tick(chain(), view, NOW);
    if (tick.type !== 'quote') throw new Error('expected a trade');
    const traded = await enclave.trade(chain(), quoteFor(tick.quoteRequest), NOW);
    if (traded.type !== 'execute') throw new Error('expected a signed trade');
    const request = JSON.parse(traded.request.json) as TradeRequest;
    const receipt: ChainTrustReceipt = {
      trust_id: 1,
      seq: 0,
      kind: 'trade',
      commitment: request.commitment,
      period_index: 0,
      token: request.origin_token,
      amount: request.amount,
      receiver: request.settlement.deposit_address,
      destination_asset: id('bond'),
      turnover_usd_e6: '500000000',
      action_hash: sha256Hex(
        trustActionJson(request.settlement.deposit_address, request.amount, 1, 0),
      ),
      request_json: traded.request.json,
      signature: traded.request.signature,
      enclave_key: traded.request.enclaveKey,
      quote_signer: QUOTE_KEY,
      added_holding: true,
      status: 'done',
      created_at_ms: NOW,
      finished_at_ms: NOW,
    };
    const signingKey = traded.request.enclaveKey;
    const encryptionKeyHex = bytesToHex(x25519.getPublicKey(keys.encryption));
    const measurements = {
      mrtd: 'aa'.repeat(48),
      rtmr0: 'bb'.repeat(48),
      rtmr1: 'cc'.repeat(48),
      rtmr2: 'dd'.repeat(48),
      rtmr3: 'ee'.repeat(48),
    };
    const quote = signSimulatedQuote({
      format: 'simulated-tdx-v1',
      measurements,
      report_data: reportDataFor(signingKey, encryptionKeyHex),
      issued_at: new Date(NOW).toISOString(),
    });
    const enclaves = [
      {
        public_key: signingKey,
        measurements,
        quote_hash: quoteHash(quote),
        active_from_ms: NOW - DAY,
        revoked_at_ms: null,
      },
    ];
    const signers = [{ public_key: QUOTE_KEY, active_from_ms: NOW - DAY, replaced_at_ms: null }];
    const attestation = { quote, encryptionKeyHex };
    const good = verifyTrustReceipt(receipt, chain(), enclaves, attestation, signers);
    expect(good.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    const forged = verifyTrustReceipt(
      { ...receipt, amount: '1' },
      chain(),
      enclaves,
      attestation,
      signers,
    );
    expect(forged.ok).toBe(false);
    expect(forged.checks.filter((c) => c.status === 'fail').map((c) => c.id)).toEqual(
      expect.arrayContaining(['binding', 'quote-bound', 'action']),
    );
  });
});

describe('the enclave signs only quotes the contract would take', () => {
  for (const [label, tweak] of [
    ['a refund inside intents', { refundType: 'INTENTS' }],
    ['a payout inside intents', { recipientType: 'INTENTS' }],
    ['60 bps of fees', { amountOutUsd: '497.000000000000' }],
    ['a trade under $10', { amountInUsd: '9.990000000000', amountOutUsd: '9.980000000000' }],
  ] as const) {
    it(`skips ${label}`, async () => {
      const { enclave } = await acceptedEnclave();
      const tick = await enclave.tick(chain(), view, NOW);
      if (tick.type !== 'quote') throw new Error('expected a trade');
      expect(await enclave.trade(chain(), quoteFor(tick.quoteRequest, tweak), NOW)).toEqual({
        type: 'skipped',
      });
    });
  }

  it('the ack names the beneficiary, the end and the trust account', async () => {
    const { accepted } = await acceptedEnclave();
    if (!accepted.ok) throw new Error('expected an ack');
    expect(JSON.parse(accepted.ack.json)).toMatchObject({
      beneficiary: 'official.near',
      end_ms: chain().end_ms,
      trust_account: ACCOUNT,
    });
  });
});
