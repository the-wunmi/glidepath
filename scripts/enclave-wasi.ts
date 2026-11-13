/**
 * Proves the WASI build of the enclave logic gives the same answers as the TypeScript enclave.
 *
 *   pnpm enclave:wasi
 *
 * 1. Builds enclave-wasi twice for wasm32-wasip1: the production module and the `vectors` test
 *    build (which also accepts a fixed random seed and exposes `sign`).
 * 2. Computes every expected answer with the TypeScript code the simulated enclave runs today
 *    (@vsp/core, @vsp/planner) and writes them to enclave-wasi/vectors.json.
 * 3. Runs each case through wasmtime and compares the JSON answers.
 * 4. Checks the production module refuses a host-chosen random seed and the `sign` operation, and
 *    answers the other cases (commitment, open_plan, check_market, verify_quote) as the test build does.
 *
 * Exits non-zero on any mismatch.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  bytesToHex,
  canonicalJson,
  checkWithinEnvelope,
  type Envelope,
  envelopeJson,
  hexToBytes,
  parseInput,
  planCommitment,
  type SealedPlan,
  SealedPlan as SealedPlanSchema,
  sealTo,
  toBaseUnits,
} from '@vsp/core';
import {
  checkMarket,
  type PlanState,
  type PriceObservation,
  proposeSale,
  type RandomBytes,
  scheduleAfter,
} from '@vsp/planner';

const root = new URL('../enclave-wasi/', import.meta.url);
const path = (p: string) => new URL(p, root).pathname;
const cargo = `${process.env.HOME}/.cargo/bin/cargo`;
const MODULES = {
  production: path('target/production/wasm32-wasip1/release/vsp-enclave.wasm'),
  vectors: path('target/vectors/wasm32-wasip1/release/vsp-enclave.wasm'),
};

/** sha256(seed ‖ u64 counter big-endian) blocks, concatenated; mirrors SeededRandom in lib.rs. */
function seeded(seedHex: string): RandomBytes {
  const seed = hexToBytes(seedHex);
  let counter = 0n;
  let buf = new Uint8Array(0);
  return (n) => {
    while (buf.length < n) {
      const block = new Uint8Array(seed.length + 8);
      block.set(seed);
      new DataView(block.buffer).setBigUint64(seed.length, counter++);
      const next = new Uint8Array(buf.length + 32);
      next.set(buf);
      next.set(sha256(block), buf.length);
      buf = next;
    }
    const out = buf.slice(0, n);
    buf = buf.slice(n);
    return out;
  };
}

const plan = (over: Record<string, unknown> = {}): SealedPlan =>
  parseInput(SealedPlanSchema, {
    version: 1,
    token: { chain: 'near', address: 'acme.near', symbol: 'ACME', decimals: 18 },
    beneficiary: { near_account: 'founder.near', asset: 'nep141:usdc.near' },
    allocation: toBaseUnits('10000000', 18).toString(),
    period_days: 30,
    max_sell_per_period_bps: 200,
    max_sell_per_tx_bps: 25,
    price_floor_usd: '1.50',
    max_slippage_bps: 100,
    venues: ['1click'],
    schedule: { mode: 'randomized', min_gap_minutes: 60, max_gap_minutes: 1440 },
    start: '2026-12-01T00:00:00Z',
    end: '2027-12-01T00:00:00.250Z',
    on_end: 'release_remaining_to_beneficiary',
    price_sources: ['1click_quote', 'binance', 'coinbase'],
    price_agreement_bps: 100,
    ...over,
  });

const PLANS: SealedPlan[] = [
  plan(),
  plan({
    token: {
      chain: 'evm',
      chain_id: 11155111,
      address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
      symbol: 'KITE',
      decimals: 6,
    },
    beneficiary: {
      near_account: 'treasury.sputnik-dao.near',
      evm_address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
      asset: 'nep141:usdc.near',
    },
    allocation: '123456789012',
    period_days: 7,
    max_sell_per_period_bps: 1000,
    max_sell_per_tx_bps: 333,
    price_floor_usd: '0.000125',
    schedule: { mode: 'randomized', min_gap_minutes: 0, max_gap_minutes: 3 },
    start: '2028-02-29T12:34:56.789Z',
    end: '2029-03-01T00:00:00Z',
    price_sources: ['binance', '1click_quote'],
    price_agreement_bps: 250,
  }),
];

const envelopeFor = (p: SealedPlan, loosen = true): Envelope => {
  const allocation = p.allocation;
  return {
    period_ms: p.period_days * 86_400_000,
    max_amount_per_period:
      (allocation * BigInt(p.max_sell_per_period_bps + (loosen ? 50 : -1))) / 10_000n,
    max_amount_per_tx: (allocation * BigInt(p.max_sell_per_tx_bps + (loosen ? 25 : 0))) / 10_000n,
    min_price_usd_e6: toBaseUnits(p.price_floor_usd, 6) / (loosen ? 2n : 1n),
    min_gap_ms: p.schedule.min_gap_minutes * 60_000,
  };
};

const stateJson = (s: PlanState) => ({
  period_index: s.periodIndex,
  sold_in_period: s.soldInPeriod.toString(),
  sold_total: s.soldTotal.toString(),
  last_sale_ms: s.lastSaleMs,
  next_sale_at_ms: s.nextSaleAtMs,
});

interface Case {
  name: string;
  build: 'production' | 'vectors';
  env?: Record<string, string>;
  input: Record<string, unknown>;
  expected: { ok: true; result: unknown } | { ok: false; error: string };
}
const cases: Case[] = [];
const add = (
  name: string,
  input: Record<string, unknown>,
  result: unknown,
  extra: Partial<Case> = {},
) => cases.push({ name, build: 'vectors', input, expected: { ok: true, result }, ...extra });

// Commitments.
PLANS.forEach((p, i) => {
  for (const salt of ['00'.repeat(32), 'ab'.repeat(32), bytesToHex(sha256(new Uint8Array([i])))]) {
    add(
      `commitment plan ${i} salt ${salt.slice(0, 4)}`,
      { op: 'commitment', plan: JSON.parse(canonicalJson(p)), salt },
      {
        commitment: planCommitment(p, salt),
      },
    );
  }
});

// Opening a sealed plan the way the browser seals it, then the commitment and envelope checks.
const enclaveSecret = sha256(new TextEncoder().encode('vsp test enclave'));
const enclavePublicHex = bytesToHex(x25519.getPublicKey(enclaveSecret));
const secretEnv = { VSP_ENCLAVE_SECRET_HEX: bytesToHex(enclaveSecret) };
PLANS.forEach((p, i) => {
  const salt = bytesToHex(sha256(new TextEncoder().encode(`salt ${i}`)));
  const sealed = sealTo(
    enclavePublicHex,
    JSON.stringify({ plan: JSON.parse(canonicalJson(p)), salt }),
  );
  for (const [label, envelope, commitment] of [
    ['inside', envelopeFor(p), planCommitment(p, salt)],
    ['outside', envelopeFor(p, false), planCommitment(p, salt)],
    ['wrong commitment', envelopeFor(p), planCommitment(p, '11'.repeat(32))],
  ] as const) {
    const checks = checkWithinEnvelope(p, envelope);
    add(
      `open_plan plan ${i} ${label}`,
      { op: 'open_plan', sealed, commitment, envelope: envelopeJson(envelope) },
      {
        commitment_ok: commitment === planCommitment(p, salt),
        within_envelope: checks.every((c) => c.ok),
        checks: checks.map((c) => ({ rule: c.rule, ok: c.ok })),
      },
      { env: secretEnv },
    );
  }
  add(
    'open_plan with another enclave key',
    { op: 'open_plan', sealed, commitment: '', envelope: envelopeJson(envelopeFor(p)) },
    null,
    {
      env: { VSP_ENCLAVE_SECRET_HEX: '07'.repeat(32) },
      expected: { ok: false, error: 'the box does not open with this key' },
    },
  );
});

// Sale proposals across the plan's life, with seeded randomness drawn identically in both.
PLANS.forEach((p, i) => {
  const start = Date.parse(p.start);
  const envelope = envelopeFor(p);
  const perPeriod = (p.allocation * BigInt(p.max_sell_per_period_bps)) / 10_000n;
  const base: PlanState = {
    periodIndex: 0,
    soldInPeriod: 0n,
    soldTotal: 0n,
    lastSaleMs: null,
    nextSaleAtMs: start + 1000,
  };
  const scenarios: [string, PlanState, number, bigint][] = [
    ['before start', base, start - 1, p.allocation],
    ['not scheduled yet', base, start + 10, p.allocation],
    ['first sale', base, start + 5_000, p.allocation],
    [
      'gap too short',
      { ...base, lastSaleMs: start + 2_000, nextSaleAtMs: start + 2_500 },
      start + 3_000,
      p.allocation,
    ],
    [
      'period budget used',
      { ...base, soldInPeriod: perPeriod },
      start + 3_600_000 * 2,
      p.allocation,
    ],
    [
      'new period resets the budget',
      { ...base, soldInPeriod: perPeriod },
      start + p.period_days * 86_400_000 + 1,
      p.allocation,
    ],
    ['nearly empty', base, start + 3_600_000 * 3, 3n],
    ['empty', base, start + 3_600_000 * 3, 0n],
    ['after the end', base, Date.parse(p.end), p.allocation],
  ];
  for (const [label, state, now, balance] of scenarios) {
    for (const seed of ['01', 'c0ffee']) {
      const proposal = proposeSale(p, envelope, state, now, balance, seeded(seed));
      add(
        `propose_sale plan ${i} ${label} seed ${seed}`,
        {
          op: 'propose_sale',
          plan: JSON.parse(canonicalJson(p)),
          envelope: envelopeJson(envelope),
          state: stateJson(state),
          now_ms: now,
          balance: balance.toString(),
          random_seed_hex: seed,
        },
        proposal.type === 'sell'
          ? { type: 'sell', amount: proposal.amount.toString(), period_index: proposal.periodIndex }
          : { type: 'wait', reason: proposal.reason, until_ms: proposal.untilMs },
      );
    }
  }
  for (const seed of ['02', 'deadbeef', 'ff'.repeat(32)]) {
    add(
      `schedule_after plan ${i} seed ${seed.slice(0, 8)}`,
      {
        op: 'schedule_after',
        plan: JSON.parse(canonicalJson(p)),
        now_ms: start + 42,
        random_seed_hex: seed,
      },
      { next_sale_at_ms: scheduleAfter(p, start + 42, seeded(seed)) },
    );
  }
});

// Market checks: agreement, floor, missing sources, slippage.
PLANS.forEach((p, i) => {
  const envelope = envelopeFor(p);
  const d = p.token.decimals;
  const amount = (p.allocation * BigInt(p.max_sell_per_tx_bps)) / 10_000n / 2n;
  const out = (priceE6: bigint) => (amount * priceE6) / 10n ** BigInt(d); // USDC 6 decimals
  const markets: [
    string,
    PriceObservation[],
    { amountIn: bigint; amountOut: bigint; minAmountOut: bigint },
  ][] = [];
  const at = (usd: string) => toBaseUnits(usd, 6);
  const good = at(i === 0 ? '2.00' : '0.0002');
  const quote = (priceE6: bigint, slipBps = 50n) => ({
    amountIn: amount,
    amountOut: out(priceE6),
    minAmountOut: (out(priceE6) * (10_000n - slipBps)) / 10_000n,
  });
  markets.push([
    'all agree',
    [
      { source: 'binance', priceE6: good },
      { source: 'coinbase', priceE6: good + 1n },
    ],
    quote(good),
  ]);
  markets.push([
    'sources disagree',
    [
      { source: 'binance', priceE6: good },
      { source: 'coinbase', priceE6: (good * 12n) / 10n },
    ],
    quote(good),
  ]);
  markets.push(['missing binance', [{ source: 'coinbase', priceE6: good }], quote(good)]);
  markets.push([
    'below the floor',
    [
      { source: 'binance', priceE6: good / 4n },
      { source: 'coinbase', priceE6: good / 4n },
    ],
    quote(good / 4n),
  ]);
  markets.push([
    'too much slippage',
    [
      { source: 'binance', priceE6: good },
      { source: 'coinbase', priceE6: good },
    ],
    quote(good, 500n),
  ]);
  markets.push([
    'quote for another amount',
    [
      { source: 'binance', priceE6: good },
      { source: 'coinbase', priceE6: good },
    ],
    { ...quote(good), amountIn: amount + 1n },
  ]);
  for (const [label, prices, q] of markets) {
    const r = checkMarket(p, envelope, amount, prices, q, 6);
    add(
      `check_market plan ${i} ${label}`,
      {
        op: 'check_market',
        plan: JSON.parse(canonicalJson(p)),
        envelope: envelopeJson(envelope),
        amount: amount.toString(),
        prices: prices.map((x) => ({ source: x.source, price_e6: x.priceE6.toString() })),
        quote: {
          amount_in: q.amountIn.toString(),
          amount_out: q.amountOut.toString(),
          min_amount_out: q.minAmountOut.toString(),
        },
        quote_decimals: 6,
      },
      {
        ok: r.ok,
        reasons: r.reasons,
        reference_price_e6: r.referencePriceE6.toString(),
        compliance: r.compliance,
      },
    );
  }
});

// Signatures, from the vectors the registry itself produced (contracts/res/test-vectors.json).
const shared = JSON.parse(
  readFileSync(new URL('../contracts/res/test-vectors.json', import.meta.url), 'utf8'),
);
const se = shared.signed_execute;
add(
  'sign execute request (registry vector)',
  { op: 'sign', seed_hex: se.enclave_secret_seed_hex, domain: se.domain, json: se.request_json },
  {
    public_key: se.enclave_public_key,
    signature: se.signature_base64,
  },
);
// 1Click quote signatures in 1Click's own format, including a real live quote.
const oc = JSON.parse(
  readFileSync(new URL('../contracts/res/oneclick-quote-vectors.json', import.meta.url), 'utf8'),
);
const quoteCase = (
  name: string,
  public_key: string,
  payload: string,
  signature: string,
  valid: boolean,
) => add(name, { op: 'verify_quote', public_key, payload, signature }, { valid });
quoteCase('verify the live 1Click quote', oc.live.public_key, oc.live.q, oc.live.signature, true);
quoteCase(
  'refuse the live signature on a tampered quote',
  oc.live.public_key,
  oc.live.tampered_q,
  oc.live.signature,
  false,
);
quoteCase(
  'verify a simulator-key quote',
  oc.sim.public_key,
  oc.sim.ordinary.q,
  oc.sim.ordinary.signature,
  true,
);
quoteCase(
  'refuse a simulator-key quote under the live key',
  oc.live.public_key,
  oc.sim.ordinary.q,
  oc.sim.ordinary.signature,
  false,
);

// What the production module must refuse.
cases.push({
  name: 'production refuses a host-chosen random seed',
  build: 'production',
  input: (cases.find((c) => c.input.op === 'propose_sale') as Case).input,
  expected: { ok: false, error: 'random_seed_hex is accepted only by the test build' },
});
cases.push({
  name: 'production refuses to sign host-supplied JSON',
  build: 'production',
  input: {
    op: 'sign',
    seed_hex: se.enclave_secret_seed_hex,
    domain: se.domain,
    json: se.request_json,
  },
  expected: { ok: false, error: 'sign is available only in the test build' },
});
for (const c of cases.filter(
  (x) =>
    x.build === 'vectors' &&
    ['commitment', 'check_market', 'verify_quote', 'open_plan'].includes(String(x.input.op)),
)) {
  cases.push({ ...c, name: `${c.name} (production build)`, build: 'production' });
}

writeFileSync(
  path('vectors.json'),
  `${JSON.stringify({ about: 'Generated by scripts/enclave-wasi.ts from the TypeScript enclave logic.', cases }, null, 1)}\n`,
);

// Build both modules (2 jobs, to keep the machine light), then run every case under wasmtime.
for (const [name, features] of [
  ['production', []],
  ['vectors', ['--features', 'vectors']],
] as const) {
  execFileSync(
    cargo,
    [
      'build',
      '--release',
      '--target',
      'wasm32-wasip1',
      '--target-dir',
      path(`target/${name}`),
      ...features,
    ],
    {
      cwd: path('.'),
      env: { ...process.env, CARGO_BUILD_JOBS: '2' },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
}
const wasmtimeVersion = execFileSync('wasmtime', ['--version'], { encoding: 'utf8' }).trim();
let failures = 0;
for (const c of cases) {
  const envArgs = Object.entries(c.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const run = spawnSync('wasmtime', ['run', ...envArgs, MODULES[c.build]], {
    input: JSON.stringify(c.input),
    encoding: 'utf8',
  });
  let got: unknown;
  try {
    got = JSON.parse(run.stdout);
  } catch {
    got = { unparsable: run.stdout, stderr: run.stderr };
  }
  if (!isDeepStrictEqual(got, c.expected)) {
    failures++;
    console.log(
      `✗ ${c.name}\n  expected ${JSON.stringify(c.expected)}\n  got      ${JSON.stringify(got)}`,
    );
  }
}
const size = (f: string) => `${Math.round(readFileSync(f).length / 1024)} KiB`;
console.log(
  `${cases.length - failures}/${cases.length} cases match under ${wasmtimeVersion} (production module ${size(MODULES.production)}, test build ${size(MODULES.vectors)})`,
);
if (failures > 0) process.exit(1);
