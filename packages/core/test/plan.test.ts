import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  base58Decode,
  base58Encode,
  bytesToHex,
  canonicalJson,
  checkWithinEnvelope,
  describePlan,
  type Envelope,
  formatAmount,
  isWithinEnvelope,
  meetsFloor,
  openSealed,
  parseInput,
  planCommitment,
  planLimits,
  planProblems,
  SealedPlan,
  sealTo,
  toBaseUnits,
} from '../src/index.ts';

const plan = parseInput(SealedPlan, {
  version: 1,
  token: { chain: 'near', address: 'acme.test.near', symbol: 'ACME', decimals: 18 },
  beneficiary: { near_account: 'founder.test.near', asset: 'nep141:usdc.test.near' },
  allocation: toBaseUnits('10000000', 18).toString(),
  period_days: 30,
  max_sell_per_period_bps: 200,
  max_sell_per_tx_bps: 25,
  price_floor_usd: '1.50',
  max_slippage_bps: 75,
  venues: ['1click'],
  schedule: { mode: 'randomized', min_gap_minutes: 360, max_gap_minutes: 5760 },
  start: '2026-12-01T00:00:00Z',
  end: '2027-12-01T00:00:00Z',
  on_end: 'release_remaining_to_beneficiary',
  price_sources: ['1click_quote', 'binance', 'coinbase'],
  price_agreement_bps: 100,
});

const envelope: Envelope = {
  period_ms: 30 * 86_400_000,
  max_amount_per_period: toBaseUnits('500000', 18),
  max_amount_per_tx: toBaseUnits('50000', 18),
  min_price_usd_e6: 1_000_000n,
  min_gap_ms: 3_600_000,
};

describe('sealed plan', () => {
  it('derives absolute limits from percentages, rounding down', () => {
    const l = planLimits(plan);
    expect(l.perPeriod).toBe(toBaseUnits('200000', 18));
    expect(l.perTx).toBe(toBaseUnits('25000', 18));
    expect(l.floorE6).toBe(1_500_000n);
    expect(planProblems(plan)).toEqual([]);
  });

  it('reads as plain English', () => {
    const lines = describePlan(plan);
    expect(lines[0]).toContain('2% of the 10,000,000 ACME allocation every 30 days');
    expect(lines[3]).toContain('6 hours to 4 days apart');
  });

  it('commits to the plan and the salt, independent of key order', () => {
    const salt = 'ab'.repeat(32);
    const shuffled = parseInput(SealedPlan, JSON.parse(canonicalJson({ ...plan, version: 1 })));
    expect(planCommitment(shuffled, salt)).toBe(planCommitment(plan, salt));
    expect(planCommitment(plan, 'cd'.repeat(32))).not.toBe(planCommitment(plan, salt));
  });

  it('sits inside a looser public envelope and outside a tighter one', () => {
    expect(isWithinEnvelope(plan, envelope)).toBe(true);
    const tight = { ...envelope, min_price_usd_e6: 2_000_000n };
    const failed = checkWithinEnvelope(plan, tight).filter((c) => !c.ok);
    expect(failed.map((c) => c.rule)).toEqual(['Price floor at or above the public floor']);
  });
});

describe('sealing to the enclave key', () => {
  it('opens only with the enclave secret key', () => {
    const sk = x25519.utils.randomSecretKey();
    const box = sealTo(bytesToHex(x25519.getPublicKey(sk)), 'secret plan');
    expect(openSealed(sk, box)).toBe('secret plan');
    expect(() => openSealed(x25519.utils.randomSecretKey(), box)).toThrow();
  });
});

describe('units', () => {
  it('formats and checks the floor without floating point', () => {
    expect(formatAmount(toBaseUnits('1234567.891', 18), 18)).toBe('1,234,567.89');
    const amount = toBaseUnits('1000', 18);
    expect(meetsFloor(amount, 1_500_000_000n, 1_500_000n, 18, 6)).toBe(true);
    expect(meetsFloor(amount, 1_499_999_999n, 1_500_000n, 18, 6)).toBe(false);
  });

  it('round-trips base58 with leading zeros', () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });
});
