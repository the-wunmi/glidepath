import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARB_CASE, buildCase, judge, KlineFile, toBars, toSeries } from '../src/index.ts';

const HOUR = 3_600_000;
const load = (name: string) =>
  toSeries(
    toBars(
      KlineFile.parse(
        JSON.parse(readFileSync(new URL(`../../../data/replay/${name}`, import.meta.url), 'utf8')),
      ).candles,
    ),
  );

describe('judging sales the way the registry does', () => {
  const start = Date.parse('2024-03-16T00:00:00Z');
  const allocation = 1_000_000; // per sale 10,000; per period 100,000
  it('applies the per-sale cap first, then the period cap, the gap and the floor', () => {
    const verdicts = judge(
      [
        { at_ms: start, amount: 20_000, price_usd: 2 },
        { at_ms: start + HOUR, amount: 10_000, price_usd: 2 },
        { at_ms: start + HOUR + 60_000, amount: 5_000, price_usd: 2 },
        { at_ms: start + 3 * HOUR, amount: 5_000, price_usd: 1.005 },
      ],
      allocation,
      start,
    ).map((a) => (a.verdict.allowed ? 'allowed' : a.verdict.code));
    expect(verdicts).toEqual(['tx_cap_exceeded', 'allowed', 'gap_too_short', 'below_floor']);
  });

  it('resets the period budget when a new period starts', () => {
    const sales = Array.from({ length: 11 }, (_, i) => ({
      at_ms: start + i * 2 * HOUR,
      amount: 10_000,
      price_usd: 2,
    }));
    sales.push({ at_ms: start + 30 * 24 * HOUR, amount: 10_000, price_usd: 2 });
    const codes = judge(sales, allocation, start).map((a) =>
      a.verdict.allowed ? 'ok' : a.verdict.code,
    );
    expect(codes.slice(9)).toEqual(['ok', 'period_cap_exceeded', 'ok']);
  });
});

describe('the ARB 2024-03-16 case', () => {
  const built = buildCase(load('ARBUSDT-2024-03-16.json'), load('BTCUSDT-2024-03-16.json'), 'x');

  it('uses the deposits read from the chain, which add up to what the wallet sent', () => {
    expect(built.observed.deposited).toBeCloseTo(9_459_777.52, 2);
    expect(ARB_CASE.flows.filter((f) => f.kind === 'deposit')).toHaveLength(4);
  });

  it('refuses every observed deposit as a single sale: each is over the 1% per-sale cap', () => {
    expect(built.observed.attempts.map((a) => a.verdict)).toEqual(
      Array(4).fill({ allowed: false, code: 'tx_cap_exceeded' }),
    );
  });

  it('lets the sealed plan sell within its caps and refuses the sale that would pass the period cap', () => {
    const allowed = built.sealed.attempts.filter((a) => a.verdict.allowed);
    expect(allowed.length).toBeGreaterThan(5);
    expect(built.sealed.allowed_amount).toBeLessThanOrEqual(built.envelope.per_period);
    expect(built.sealed.attempts.at(-1)?.verdict).toEqual({
      allowed: false,
      code: 'period_cap_exceeded',
    });
  });

  it('measures the price move against BTC from the same Binance files', () => {
    expect(built.price.token_change).toBeLessThan(-0.2);
    expect(built.price.btc_change).toBeGreaterThan(-0.1);
  });
});
