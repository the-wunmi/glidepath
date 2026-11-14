import { type Envelope, parseInput, SealedPlan, toBaseUnits } from '@glidepath/core';
import { describe, expect, it } from 'vitest';
import {
  checkMarket,
  initialState,
  proposeSale,
  type RandomBytes,
  randomBelow,
  recordSale,
  saleSize,
} from '../src/index.ts';

const T0 = Date.parse('2026-12-01T00:00:00Z');
const HOUR = 3_600_000;
const tokens = (n: string) => toBaseUnits(n, 18);

const plan = parseInput(SealedPlan, {
  version: 1,
  token: { chain: 'near', address: 'acme.test.near', symbol: 'ACME', decimals: 18 },
  beneficiary: { near_account: 'founder.test.near', asset: 'nep141:usdc.test.near' },
  allocation: tokens('1000000').toString(),
  period_days: 30,
  max_sell_per_period_bps: 200,
  max_sell_per_tx_bps: 50,
  price_floor_usd: '1.50',
  max_slippage_bps: 100,
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
  max_amount_per_period: tokens('50000'),
  max_amount_per_tx: tokens('10000'),
  min_price_usd_e6: 1_000_000n,
  min_gap_ms: HOUR,
};

/** A deterministic byte stream so schedules are reproducible in tests. */
function seeded(seed: number): RandomBytes {
  let x = seed;
  return (n) =>
    Uint8Array.from({ length: n }, () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return x & 0xff;
    });
}

describe('randomised schedule', () => {
  it('never sells before the drawn time, and draws gaps inside the plan window', () => {
    const random = seeded(1);
    let state = initialState(plan, random);
    expect(
      proposeSale(plan, envelope, state, state.nextSaleAtMs - 1, tokens('1000000'), random),
    ).toMatchObject({ type: 'wait', reason: 'not_scheduled_yet' });
    const due = proposeSale(plan, envelope, state, state.nextSaleAtMs, tokens('1000000'), random);
    if (due.type !== 'sell') throw new Error('expected a sale');
    state = recordSale(plan, state, due.amount, due.periodIndex, state.nextSaleAtMs, random);
    const gap = state.nextSaleAtMs - (state.lastSaleMs ?? 0);
    expect(gap).toBeGreaterThanOrEqual(6 * HOUR);
    expect(gap).toBeLessThanOrEqual(96 * HOUR);
  });

  it('keeps every sale within the per-sale cap and the period budget', () => {
    const random = seeded(7);
    let state = { ...initialState(plan, random), nextSaleAtMs: T0 };
    let now = T0;
    let sold = 0n;
    for (let i = 0; i < 50; i++) {
      const p = proposeSale(plan, envelope, state, now, tokens('1000000'), random);
      if (p.type === 'sell') {
        expect(p.amount).toBeLessThanOrEqual(tokens('5000'));
        sold += p.amount;
        state = recordSale(plan, state, p.amount, p.periodIndex, now, random);
      }
      now = Math.max(now + HOUR, state.nextSaleAtMs);
      if (now >= T0 + 30 * 86_400_000) break;
    }
    expect(sold).toBeLessThanOrEqual(tokens('20000'));
  });

  it('waits for the next period once the budget is used', () => {
    const random = seeded(3);
    const state = {
      ...initialState(plan, random),
      soldInPeriod: tokens('20000'),
      nextSaleAtMs: T0,
    };
    expect(proposeSale(plan, envelope, state, T0 + HOUR, tokens('1000000'), random)).toMatchObject({
      type: 'wait',
      reason: 'period_budget_used',
      untilMs: T0 + 30 * 86_400_000,
    });
  });

  it('sells a period out in whole sales, never a tail of shrinking dust sales', () => {
    // Plan 3 on testnet sold 611, then 32, 8.6, 2.5, 1.4, 0.17, 0.006 GLDE: each draw took half
    // or more of what the period had left. Every sale but the last must now be at least half the cap.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const random = seeded(seed);
      let state = { ...initialState(plan, random), nextSaleAtMs: T0 };
      let now = T0;
      const sales: bigint[] = [];
      for (let i = 0; i < 40; i++) {
        const p = proposeSale(plan, envelope, state, now, tokens('1000000'), random);
        if (p.type !== 'sell') break;
        sales.push(p.amount);
        state = recordSale(plan, state, p.amount, p.periodIndex, now, random);
        now = state.nextSaleAtMs;
      }
      expect(sales.reduce((a, b) => a + b, 0n)).toBe(tokens('20000'));
      for (const amount of sales) {
        expect(amount).toBeGreaterThanOrEqual(tokens('2500'));
        expect(amount).toBeLessThanOrEqual(tokens('5000'));
      }
    }
  });

  it('sells a remainder smaller than one sale in one go', () => {
    expect(saleSize(tokens('5000'), tokens('1'), seeded(1))).toBe(tokens('1'));
    expect(saleSize(tokens('5000'), tokens('4000'), seeded(1))).toBe(tokens('4000'));
    // Just over one sale: leave exactly the smallest sale, so the next one is not dust.
    for (const seed of [1, 2, 3, 4]) {
      const amount = saleSize(tokens('5000'), tokens('6000'), seeded(seed));
      expect(tokens('6000') - amount).toBeGreaterThanOrEqual(tokens('2500'));
      expect(amount).toBeLessThanOrEqual(tokens('5000'));
    }
  });

  it('draws uniformly without modulo bias in range', () => {
    const random = seeded(11);
    for (let i = 0; i < 200; i++) expect(randomBelow(7n, random)).toBeLessThan(7n);
  });
});

describe('market checks', () => {
  const amount = tokens('1000');
  const quote = { amountIn: amount, amountOut: 1_800_000_000n, minAmountOut: 1_785_000_000n };
  const agreeing = [
    { source: 'binance' as const, priceE6: 1_801_000n },
    { source: 'coinbase' as const, priceE6: 1_799_000n },
  ];

  it('passes when independent prices agree and the guaranteed output clears the floor', () => {
    const check = checkMarket(plan, envelope, amount, agreeing, quote, 6);
    expect(check.reasons).toEqual([]);
    expect(Object.values(check.compliance).every(Boolean)).toBe(true);
  });

  it('refuses when one source is manipulated away from the others', () => {
    const skewed = [agreeing[0]!, { source: 'coinbase' as const, priceE6: 2_200_000n }];
    expect(checkMarket(plan, envelope, amount, skewed, quote, 6).reasons).toContain(
      'Price sources disagree',
    );
  });

  it('refuses a sale below the sealed floor even if every source agrees', () => {
    const low = { amountIn: amount, amountOut: 1_400_000_000n, minAmountOut: 1_390_000_000n };
    const lowPrices = agreeing.map((p) => ({ ...p, priceE6: 1_400_000n }));
    expect(checkMarket(plan, envelope, amount, lowPrices, low, 6).reasons).toContain(
      'Price is below the floor',
    );
  });

  it('refuses when a source does not answer', () => {
    expect(checkMarket(plan, envelope, amount, [agreeing[0]!], quote, 6).reasons).toContain(
      'No price from coinbase',
    );
  });

  it('accepts a quote whose minimum is exactly the plan slippage, rounded down', () => {
    const exact = { ...quote, minAmountOut: (quote.amountOut * 9_900n) / 10_000n };
    expect(checkMarket(plan, envelope, amount, agreeing, exact, 6).ok).toBe(true);
  });

  it('refuses a quote with more slippage than the plan allows', () => {
    const loose = { ...quote, minAmountOut: 1_700_000_000n };
    expect(checkMarket(plan, envelope, amount, agreeing, loose, 6).ok).toBe(false);
  });
});
