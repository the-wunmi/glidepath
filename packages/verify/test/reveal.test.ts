import {
  canonicalJson,
  newSaltHex,
  parseInput,
  planCommitment,
  SealedPlan,
  toBaseUnits,
} from '@glidepath/core';
import type { ChainPlan, ChainReceipt } from '@glidepath/near';
import { describe, expect, it } from 'vitest';
import { verifyReveal } from '../src/index.ts';

const plan = parseInput(SealedPlan, {
  version: 1,
  token: { chain: 'near', address: 'acme.near', symbol: 'ACME', decimals: 18 },
  beneficiary: { near_account: 'founder.near', asset: 'nep141:usdc.near' },
  allocation: toBaseUnits('1000000', 18).toString(),
  period_days: 30,
  max_sell_per_period_bps: 200,
  max_sell_per_tx_bps: 50,
  price_floor_usd: '1.50',
  max_slippage_bps: 100,
  venues: ['1click'],
  schedule: { mode: 'randomized', min_gap_minutes: 0, max_gap_minutes: 60 },
  start: '2026-12-01T00:00:00Z',
  end: '2027-12-01T00:00:00Z',
  on_end: 'release_remaining_to_beneficiary',
  price_sources: ['1click_quote', 'binance', 'coinbase'],
  price_agreement_bps: 100,
});
const salt = newSaltHex();
const chain = {
  commitment: planCommitment(plan, salt),
  token_decimals: 18,
  quote_decimals: 6,
} as ChainPlan;
const start = Date.parse('2026-12-01T00:00:00Z');
const sale = (amountTokens: string, minOutUsdc: string, atMs = start + 3_600_000): ChainReceipt =>
  ({
    kind: 'sale',
    status: 'done',
    amount: toBaseUnits(amountTokens, 18).toString(),
    period_index: 0,
    created_at_ms: atMs,
    settlement: { min_amount_out: toBaseUnits(minOutUsdc, 6).toString() },
  }) as ChainReceipt;
const reveal = (s = salt) => ({ plan_json: canonicalJson(plan), salt: s, revealed_at_ms: 0 });

describe('checking a revealed plan in the browser', () => {
  it('passes when the terms match the commitment and every sale stayed inside them', () => {
    const result = verifyReveal(reveal(), chain, [sale('4000', '6100')]);
    expect(result.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(result.plan?.price_floor_usd).toBe('1.50');
  });

  it('fails when the salt does not open the commitment', () => {
    const result = verifyReveal(reveal(newSaltHex()), chain, []);
    expect(result.checks.find((c) => c.id === 'reveal-commitment')?.status).toBe('fail');
  });

  it('catches a sale above the sealed per-sale limit', () => {
    const result = verifyReveal(reveal(), chain, [sale('6000', '9100')]);
    expect(result.checks.find((c) => c.id === 'reveal-tx')?.status).toBe('fail');
  });

  it('catches a sale guaranteed below the sealed floor', () => {
    const result = verifyReveal(reveal(), chain, [sale('4000', '5000')]);
    expect(result.checks.find((c) => c.id === 'reveal-floor')?.status).toBe('fail');
  });
});
