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
  type HeldRecord,
  noSalePossible,
  type OutLayerBuild,
  type OutLayerDeployment,
  OutLayerEnclave,
  type OutLayerStore,
} from '../src/outlayer.ts';
import {
  buildLocalModule,
  type LocalBuild,
  type LocalRun,
  localBuild,
  localClient,
  localDeployment,
  localDeploymentWithBackups,
} from './local-enclave.ts';

/**
 * The OutLayer adapter against the module's own code (see local-enclave.ts), so these tests
 * exercise the real request and record formats.
 */
const SEED_A = '11'.repeat(32);
const SEED_B = '22'.repeat(32);
const QUOTE_SECRET = new Uint8Array(32).fill(3);
const QUOTE_KEY = formatNearKey('ed25519', ed25519.getPublicKey(QUOTE_SECRET));
const DAY = 86_400_000;

function memoryStore(): OutLayerStore & { records: Map<string, HeldRecord> } {
  const records = new Map<string, HeldRecord>();
  const key = (id: number, build: string | null) => `${id}:${build ?? 'legacy'}`;
  return {
    records,
    load: async (id, build) => records.get(key(id, build)) ?? null,
    save: async (id, build, held) => void records.set(key(id, build), held),
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

const deploymentOf = (current: LocalBuild, ...previous: LocalBuild[]) =>
  localDeployment(QUOTE_KEY, current, ...previous);

function harness() {
  const runs: LocalRun[] = [];
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
  const a = localBuild(SEED_A, QUOTE_KEY);
  const b = localBuild(SEED_B, QUOTE_KEY);
  const local = localClient(runs, QUOTE_KEY);
  /** Builds (by wasm hash) whose runs fail, as when OutLayer cannot run them. */
  const down = new Set<string>();
  /** The adapter as a server runs it with `deployment` as its record; all share one store. */
  const enclaveFor = (deployment: OutLayerDeployment) =>
    new OutLayerEnclave({
      store,
      client: {
        run: <T>(build: OutLayerBuild, input: object) =>
          down.has(build.wasm.sha256)
            ? Promise.reject(new Error('The OutLayer run failed'))
            : local.run<T>(build, input),
      },
      deployment,
      host,
      pollMs: 60_000,
      log: () => {},
    });
  const sealFor = (build: LocalBuild, salt = newSaltHex()) => ({
    salt,
    commitment: planCommitment(sealed as never, salt),
    box: sealTo(
      build.encryptionKeyHex,
      JSON.stringify({ plan: JSON.parse(canonicalJson(sealed)), salt }),
    ),
  });
  const first = sealFor(a);
  return {
    runs,
    store,
    down,
    a,
    b,
    enclaveFor,
    sealFor,
    /** Build A alone: the deployment before build B was published. */
    enclave: enclaveFor(deploymentOf(a)),
    box: first.box,
    commitment: first.commitment,
    signingKey: a.signingKey,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

/** Ticks a minute apart until the enclave signs a sale. */
async function untilSale(h: ReturnType<typeof harness>, enclave: OutLayerEnclave, plan: ChainPlan) {
  for (let i = 0; i < 30; i++) {
    const out = await enclave.tick(plan);
    if (out.type === 'execute') return out;
    h.advance(60_000);
  }
  throw new Error('No sale within 30 minutes of a 1–3 minute schedule');
}

describe('the OutLayer enclave adapter', () => {
  beforeAll(buildLocalModule);

  it('a plan it never accepted costs no OutLayer run', async () => {
    const h = harness();
    const out = await h.enclave.tick(chainPlan(h.commitment, 'active'));
    expect(out.type).toBe('idle');
    expect(h.runs).toHaveLength(0);
  });

  it('a plan another enclave key accepted costs no run, even with its record in the store', async () => {
    const h = harness();
    await h.enclave.acceptPlan(chainPlan(h.commitment, 'awaiting_ack'), h.box);
    const before = h.runs.length;
    h.advance(60_000);
    const elsewhere = {
      ...chainPlan(h.commitment, 'active'),
      acked_by: 'ed25519:11111111111111111111111111111111',
    };
    expect(await h.enclave.tick(elsewhere)).toMatchObject({ type: 'idle' });
    expect(h.runs).toHaveLength(before);
  });

  it('a plan an earlier build accepted keeps running on that build’s wasm and key', async () => {
    const h = harness();
    await h.enclave.acceptPlan(chainPlan(h.commitment, 'awaiting_ack'), h.box);
    // Build B is published; A's plan stays with A.
    const both = h.enclaveFor(deploymentOf(h.b, h.a));
    const active = { ...chainPlan(h.commitment, 'active'), acked_by: h.a.signingKey };
    h.advance(60_000);
    const before = h.runs.length;
    const sale = await untilSale(h, both, active);
    expect(sale.request.enclaveKey).toBe(h.a.signingKey);
    expect(new Set(h.runs.slice(before).map((r) => r.build))).toEqual(new Set([SEED_A]));
  });

  it('new plans go to the current build, and a build with no plans due costs nothing', async () => {
    const h = harness();
    const both = h.enclaveFor(deploymentOf(h.b, h.a));
    const fresh = h.sealFor(h.b);
    const accepted = await both.acceptPlan(chainPlan(fresh.commitment, 'awaiting_ack'), fresh.box);
    expect(accepted.ok && accepted.ack.enclaveKey).toBe(h.b.signingKey);
    expect(h.runs.map((r) => r.build)).toEqual([SEED_B]);
    // Before the start, no sale can be due: neither build runs.
    const active = { ...chainPlan(fresh.commitment, 'active'), acked_by: h.b.signingKey };
    expect(await both.tick(active)).toMatchObject({ type: 'idle' });
    expect(h.runs).toHaveLength(1);
  });

  it('a backup build holds its own copy and sells while the main build’s runs keep failing', async () => {
    const h = harness();
    const withBackup = h.enclaveFor(localDeploymentWithBackups(QUOTE_KEY, h.a, [h.b]));
    const salt = newSaltHex();
    const main = h.sealFor(h.a, salt);
    const copy = h.sealFor(h.b, salt);
    const accepted = await withBackup.acceptPlan(
      chainPlan(main.commitment, 'awaiting_ack'),
      main.box,
      [{ signingKey: h.b.signingKey, box: copy.box }],
    );
    expect(accepted.ok && accepted.ack.enclaveKey).toBe(h.a.signingKey);
    expect(accepted.ok && accepted.backups).toEqual([
      { signingKey: h.b.signingKey, ok: true, reasons: [] },
    ]);

    const active = { ...chainPlan(main.commitment, 'active'), acked_by: h.a.signingKey };
    h.down.add(SEED_A);
    h.advance(60_000);
    // One failed run is retried on the main build next time; a second in a row fails over.
    await expect(withBackup.tick(active)).rejects.toThrow('The OutLayer run failed');
    h.advance(60_000);
    const sale = await untilSale(h, withBackup, active);
    expect(sale.request.enclaveKey).toBe(h.b.signingKey);

    // The main build is back: within the probe interval sales stay on the backup; after it, the
    // main build runs the plan again.
    h.down.delete(SEED_A);
    h.advance(31 * 60_000);
    const before = h.runs.length;
    const back = await untilSale(h, withBackup, active);
    expect(back.request.enclaveKey).toBe(h.a.signingKey);
    expect(h.runs.slice(before).some((r) => r.build === SEED_A)).toBe(true);
  });

  it('a backup that does not follow the plan’s current commitment never stands in', async () => {
    const h = harness();
    const withBackup = h.enclaveFor(localDeploymentWithBackups(QUOTE_KEY, h.a, [h.b]));
    const salt = newSaltHex();
    const main = h.sealFor(h.a, salt);
    const copy = h.sealFor(h.b, salt);
    await withBackup.acceptPlan(chainPlan(main.commitment, 'awaiting_ack'), main.box, [
      { signingKey: h.b.signingKey, box: copy.box },
    ]);
    // The plan has since changed, and the backup was not given the change.
    const changed = {
      ...chainPlan('ef'.repeat(32), 'active'),
      acked_by: h.a.signingKey,
    };
    h.down.add(SEED_A);
    for (let i = 0; i < 3; i++) {
      h.advance(60_000);
      await expect(withBackup.tick(changed)).rejects.toThrow('The OutLayer run failed');
    }
    expect(h.runs.some((r) => r.build === SEED_B && r.input.op === 'tick')).toBe(false);
  });

  it('a copy sealed for a key that is not one of this enclave’s backups is reported, not run', async () => {
    const h = harness();
    const withBackup = h.enclaveFor(localDeploymentWithBackups(QUOTE_KEY, h.a, [h.b]));
    const main = h.sealFor(h.a);
    const accepted = await withBackup.acceptPlan(
      chainPlan(main.commitment, 'awaiting_ack'),
      main.box,
      [{ signingKey: 'ed25519:stranger', box: main.box }],
    );
    expect(accepted.ok && accepted.backups?.[0]).toMatchObject({ ok: false });
    expect(h.runs.map((r) => r.build)).toEqual([SEED_A]);
  });

  it('a change the module cannot handle is refused once, not retried at a run each time', async () => {
    const h = harness();
    const both = h.enclaveFor(deploymentOf(h.b, h.a));
    const base = { ...chainPlan(h.commitment, 'active'), acked_by: h.b.signingKey };
    h.store.records.set(`7:${h.b.signingKey}`, { record: 'not a sealed record', staged: null });
    const moved = h.sealFor(h.b);
    const out = await both.stageChange(
      {
        ...base,
        pending_change: {
          kind: 'modify',
          commitment: moved.commitment,
          envelope: base.envelope,
          requested_at_ms: start,
          effective_at_ms: start + 600_000,
        },
      },
      moved.box,
    );
    expect(out.ok).toBe(false);
    expect(h.runs).toHaveLength(1);
  });

  it('reads a record saved before builds were told apart for the build holding the plan', async () => {
    const h = harness();
    await h.enclave.acceptPlan(chainPlan(h.commitment, 'awaiting_ack'), h.box);
    const held = h.store.records.get(`7:${h.a.signingKey}`);
    h.store.records.clear();
    h.store.records.set('7:legacy', { record: held?.record ?? '' });
    h.advance(60_000);
    const sale = await untilSale(h, h.enclaveFor(deploymentOf(h.b, h.a)), {
      ...chainPlan(h.commitment, 'active'),
      acked_by: h.a.signingKey,
    });
    expect(sale.request.enclaveKey).toBe(h.a.signingKey);
  });

  it('an owner moves a plan to the current build with a change; the old build runs it until then', async () => {
    const h = harness();
    await h.enclave.acceptPlan(chainPlan(h.commitment, 'awaiting_ack'), h.box);
    const both = h.enclaveFor(deploymentOf(h.b, h.a));
    const now = h.advance(60_000);
    // The same terms under a new salt, sealed to build B, which never held the plan.
    const moved = h.sealFor(h.b);
    const base = chainPlan(h.commitment, 'active');
    const pending = {
      ...base,
      acked_by: h.a.signingKey,
      pending_change: {
        kind: 'modify' as const,
        commitment: moved.commitment,
        envelope: base.envelope,
        requested_at_ms: now,
        effective_at_ms: now + 3_600_000,
      },
    };
    expect(await both.stageChange(pending, moved.box)).toEqual({ ok: true, reasons: [] });
    expect(h.runs.at(-1)?.build).toBe(SEED_B);

    // During the cooling-off, A keeps selling.
    const during = await untilSale(h, both, pending);
    expect(during.request.enclaveKey).toBe(h.a.signingKey);

    // After it, B acks with its own key.
    h.advance(3_600_000);
    const acked = await both.tick(pending);
    expect(acked).toMatchObject({ type: 'ack_change' });
    expect(acked.type === 'ack_change' && acked.ack.enclaveKey).toBe(h.b.signingKey);

    // Applied: the registry now names B, and B runs the plan from its counters.
    const applied = {
      ...base,
      commitment: moved.commitment,
      acked_by: h.b.signingKey,
      next_seq: 1,
      sold_in_period: during.amount.toString(),
      sold_total: during.amount.toString(),
      last_sale_ms: (JSON.parse(during.request.json) as { issued_at_ms: number }).issued_at_ms,
    };
    const before = h.runs.length;
    h.advance(60_000);
    const after = await untilSale(h, both, applied);
    expect(after.request.enclaveKey).toBe(h.b.signingKey);
    expect(after.seq).toBe(1);
    expect(new Set(h.runs.slice(before).map((r) => r.build))).toEqual(new Set([SEED_B]));
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
    const record = h.store.records.get(`7:${h.signingKey}`)?.record ?? '';
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
