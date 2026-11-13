import { execFileSync, spawnSync } from 'node:child_process';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  base58Encode,
  canonicalJson,
  EXECUTE_DOMAIN,
  formatNearKey,
  fromBase64,
  newSaltHex,
  oneclickQuoteMessage,
  oneclickSignedBytes,
  parseNearKey,
  planCommitment,
  type SealedPlanInput,
  sealTo,
  signingBytes,
} from '@vsp/core';
import type { EnclaveHost } from '@vsp/enclave';
import type { ChainPlan } from '@vsp/near';
import type { QuoteResponse } from '@vsp/oneclick';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  noSalePossible,
  OutLayerEnclave,
  type OutLayerStore,
  type RunResult,
} from '../src/outlayer.ts';

/**
 * The OutLayer adapter against the module's own code: `vsp-enclave-local` runs the same
 * operations as the OutLayer build (enclave-wasi/src/enclave.rs) with keys from a local seed
 * instead of the keystore, so these tests exercise the real request and record formats.
 */
const crate = new URL('../../../enclave-wasi/', import.meta.url).pathname;
const binary = `${crate}target/release/vsp-enclave-local`;
const SEED = '11'.repeat(32);
const QUOTE_SECRET = new Uint8Array(32).fill(3);
const QUOTE_KEY = formatNearKey('ed25519', ed25519.getPublicKey(QUOTE_SECRET));
const DAY = 86_400_000;

type Run = { input: Record<string, unknown> };

/** Runs the module locally the way OutLayer would: JSON on stdin, JSON on stdout. */
function localClient(runs: Run[]) {
  return {
    async run<T>(input: object): Promise<RunResult<T>> {
      runs.push({ input: input as Record<string, unknown> });
      const inputData = JSON.stringify(input);
      const out = spawnSync(binary, {
        input: inputData,
        env: { VSP_LOCAL_ENCLAVE_SEED_HEX: SEED, VSP_QUOTE_SIGNER_KEY: QUOTE_KEY },
      });
      const parsed = JSON.parse(out.stdout.toString()) as
        | { ok: true; result: T }
        | { ok: false; error: string };
      if (!parsed.ok) throw new Error(parsed.error);
      return { txHash: 'local', inputData, outputBytes: out.stdout, result: parsed.result };
    },
  };
}

function memoryStore(): OutLayerStore & { records: Map<number, string> } {
  const records = new Map<number, string>();
  return {
    records,
    load: async (id) => records.get(id) ?? null,
    save: async (id, r) => void records.set(id, r),
    symbol: async () => 'ACME',
    saleInFlight: async () => false,
  };
}

const start = Date.parse('2027-01-15T08:00:00.000Z');
const sealed: SealedPlanInput = {
  version: 1,
  token: { chain: 'near', address: 'acme.testnet', symbol: 'ACME', decimals: 6 },
  beneficiary: { near_account: 'founder.testnet', asset: 'nep141:vusdc.testnet' },
  allocation: '1000000000',
  period_days: 1,
  max_sell_per_period_bps: 1000,
  max_sell_per_tx_bps: 100,
  price_floor_usd: '0.50',
  max_slippage_bps: 100,
  venues: ['1click'],
  schedule: { mode: 'randomized', min_gap_minutes: 1, max_gap_minutes: 3 },
  start: new Date(start).toISOString(),
  end: new Date(start + 30 * DAY).toISOString(),
  on_end: 'release_remaining_to_beneficiary',
  price_sources: ['1click_quote', 'binance'],
  price_agreement_bps: 500,
};

function chainPlan(commitment: string, status: ChainPlan['status'], nextSeq = 0): ChainPlan {
  return {
    id: 7,
    owner: 'founder.testnet',
    commitment,
    asset: { type: 'nep141', token_id: 'acme.testnet' },
    token_decimals: 6,
    quote_decimals: 6,
    beneficiary: { near_account: 'founder.testnet', evm_address: null },
    proceeds_asset: 'nep141:vusdc.testnet',
    envelope: {
      period_ms: DAY,
      max_amount_per_period: '200000000',
      max_amount_per_tx: '20000000',
      min_price_usd_e6: '100000',
      min_gap_ms: 0,
    },
    disclosure: { type: 'realtime' },
    cooling_off_ms: 600_000,
    start_ms: start,
    end_ms: start + 30 * DAY,
    status,
    created_at_ms: start - DAY,
    acked_at_ms: null,
    acked_by: null,
    plan_account: '7.vsp-registry.testnet',
    evm_address: null,
    evm_nonce: 0,
    evm_sign_pending: false,
    evm_pending_sign: null,
    next_seq: nextSeq,
    period_index: 0,
    sold_in_period: '0',
    sold_total: '0',
    last_sale_ms: null,
    pending_change: null,
    receipt_count: 0,
    label: 'test',
  } as ChainPlan;
}

/** A 1Click-format quote for exactly what the module asked, at $1 a token, signed by QUOTE_KEY. */
function quoteFor(request: Record<string, unknown>, nowMs: number): QuoteResponse {
  const amount = String(request.amount);
  const response: QuoteResponse = {
    correlationId: 'corr-1',
    timestamp: new Date(nowMs).toISOString(),
    signature: '',
    quoteRequest: request,
    quote: {
      amountIn: amount,
      amountInFormatted: amount,
      amountInUsd: '10.000000',
      minAmountIn: amount,
      amountOut: amount,
      amountOutFormatted: amount,
      amountOutUsd: '9.990000',
      minAmountOut: ((BigInt(amount) * 995n) / 1000n).toString(),
      timeEstimate: 10,
      depositAddress: 'deposit.testnet',
      deadline: new Date(nowMs + 600_000).toISOString(),
    },
  };
  const signature = ed25519.sign(oneclickSignedBytes(oneclickQuoteMessage(response)), QUOTE_SECRET);
  return { ...response, signature: `ed25519:${base58Encode(signature)}` };
}

function harness() {
  const runs: Run[] = [];
  const store = memoryStore();
  let now = start - 60_000;
  const host: EnclaveHost = {
    chainTimeMs: async () => now,
    planBalance: async () => 1_000_000_000n,
    receipt: async () => null,
    prices: async () => [{ source: 'binance', priceE6: 1_000_000n }],
    quote: async (request) => quoteFor(request as unknown as Record<string, unknown>, now),
    evmFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
  };
  const enclave = new OutLayerEnclave({
    store,
    client: localClient(runs),
    deployment: {} as never,
    host,
    pollMs: 60_000,
    log: () => {},
  });
  const keyProof = JSON.parse(
    JSON.parse(
      spawnSync(binary, {
        input: '{"op":"key_proof"}',
        env: { VSP_LOCAL_ENCLAVE_SEED_HEX: SEED, VSP_QUOTE_SIGNER_KEY: QUOTE_KEY },
      }).stdout.toString(),
    ).result.json,
  ) as { signing_key: string; encryption_key_hex: string };
  const salt = newSaltHex();
  const commitment = planCommitment(sealed as never, salt);
  const box = sealTo(
    keyProof.encryption_key_hex,
    JSON.stringify({ plan: JSON.parse(canonicalJson(sealed)), salt }),
  );
  return {
    runs,
    store,
    enclave,
    box,
    commitment,
    signingKey: keyProof.signing_key,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

describe('the OutLayer enclave adapter', () => {
  beforeAll(() => {
    execFileSync(
      `${process.env.HOME}/.cargo/bin/cargo`,
      ['build', '--release', '--bin', 'vsp-enclave-local'],
      { cwd: crate, stdio: 'ignore' },
    );
  });

  it('a plan it never accepted costs no OutLayer run', async () => {
    const h = harness();
    const out = await h.enclave.tick(chainPlan(h.commitment, 'active'));
    expect(out.type).toBe('idle');
    expect(h.runs).toHaveLength(0);
  });

  it('acks a sealed plan without the plan ever appearing in a run input or output', async () => {
    const h = harness();
    const accepted = await h.enclave.acceptPlan(chainPlan(h.commitment, 'awaiting_ack'), h.box);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(
      ed25519.verify(
        fromBase64(accepted.ack.signature),
        signingBytes('vsp/ack/v1\n', accepted.ack.json),
        parseNearKey(h.signingKey).bytes,
      ),
    ).toBe(true);
    const record = h.store.records.get(7) ?? '';
    const everything = JSON.stringify(h.runs) + record + accepted.ack.json;
    for (const secret of ['price_floor_usd', '0.50', 'max_sell_per_tx_bps', 'min_gap_minutes'])
      expect(everything).not.toContain(secret);
  });

  it('signs a sale inside the module and runs at most once per poll interval', async () => {
    const h = harness();
    await h.enclave.acceptPlan(chainPlan(h.commitment, 'awaiting_ack'), h.box);
    const active = chainPlan(h.commitment, 'active');
    h.advance(60_000);
    let sale = null;
    for (let i = 0; i < 30 && !sale; i++) {
      const before = h.runs.length;
      const out = await h.enclave.tick(active);
      // A second wake-up inside the interval is free.
      expect((await h.enclave.tick(active)).type).toBe('idle');
      expect(h.runs.length - before).toBeLessThanOrEqual(2);
      if (out.type === 'execute') sale = out;
      else {
        expect(out).toMatchObject({ type: 'idle', untilMs: null });
        h.advance(60_000);
      }
    }
    expect(sale).not.toBeNull();
    if (!sale) return;
    const request = JSON.parse(sale.request.json);
    expect(request).toMatchObject({ plan_id: 7, seq: 0, action: { type: 'nep141_transfer' } });
    expect(BigInt(request.action.amount)).toBe(sale.amount);
    expect(
      ed25519.verify(
        fromBase64(sale.request.signature),
        signingBytes(EXECUTE_DOMAIN, sale.request.json),
        parseNearKey(h.signingKey).bytes,
      ),
    ).toBe(true);
    expect(sale.request.enclaveKey).toBe(h.signingKey);
  });

  it('pays for no run while the public envelope rules out a sale', async () => {
    const h = harness();
    await h.enclave.acceptPlan(chainPlan(h.commitment, 'awaiting_ack'), h.box);
    const now = h.advance(10 * 60_000);
    const gap = {
      ...chainPlan(h.commitment, 'active'),
      last_sale_ms: now - 60_000,
      envelope: { ...chainPlan(h.commitment, 'active').envelope, min_gap_ms: 3_600_000 },
    };
    const before = h.runs.length;
    expect(await h.enclave.tick(gap)).toMatchObject({ type: 'idle' });
    expect(h.runs.length).toBe(before);
  });

  it('knows from public state alone when no sale can be due', () => {
    const plan = chainPlan('00', 'active');
    expect(noSalePossible(plan, start - 1)).toMatch(/not started/);
    expect(noSalePossible(plan, start + 31 * DAY)).toMatch(/ended/);
    expect(
      noSalePossible(
        { ...plan, last_sale_ms: start, envelope: { ...plan.envelope, min_gap_ms: 60_000 } },
        start + 30_000,
      ),
    ).toMatch(/gap/);
    const capped = { ...plan, sold_in_period: plan.envelope.max_amount_per_period };
    expect(noSalePossible(capped, start + 1_000)).toMatch(/cap/);
    // The next period starts with a fresh cap.
    expect(noSalePossible(capped, start + DAY + 1_000)).toBeNull();
    expect(noSalePossible(plan, start + 1_000)).toBeNull();
  });
});
