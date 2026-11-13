import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type Candle,
  DAY_MS,
  DEFAULT_PARAMS,
  dataWindow,
  EVENTS,
  evenSchedule,
  fileName,
  HOUR_MS,
  type ImpactModel,
  impactFraction,
  KlineFile,
  MARKET_SYMBOL,
  percentile,
  randomSchedule,
  runStudy,
  type StudyData,
  type StudyParams,
  seededRng,
  UnlockEvent,
  unlockMs,
} from '../src/index.ts';

const MODEL: ImpactModel = { coefficient: 1, dailyVolatility: 0.05, maxFraction: 0.5 };
const FAST: StudyParams = {
  ...DEFAULT_PARAMS,
  seeds: 50,
  sensitivity_coefficients: [0.5, 2],
  sensitivity_sell_fractions_bps: [1000],
};

const hoursOf = (startMs: number, count: number) =>
  Array.from({ length: count }, (_, i) => startMs + i * HOUR_MS);

const fixtureEvent = UnlockEvent.parse({
  id: 'test-2025-01-01',
  token: 'Test (TST)',
  symbol: 'TSTUSDT',
  unlock_date: '2025-01-01',
  unlock_amount: '100000000',
  insider_amount: '100000000',
  recipients: 'Team and investors',
  share_of_supply: { pct: 10, basis: 'total' },
  share_of_supply_notes: 'Fixture',
  verification: 'confirmed',
  verification_notes: 'Fixture',
  sources: [{ url: 'https://example.com/unlock', fetched_at: '2026-11-11', supports: 'Fixture' }],
});

/** Hourly candles for the fixture window: a small hourly wiggle so volatility is non-zero. */
function fixtureFile(
  symbol: string,
  price: (t: number) => number,
  quotePerHour: number,
): KlineFile {
  const { startMs, endMs } = dataWindow(fixtureEvent.unlock_date);
  const candles: Candle[] = hoursOf(startMs, (endMs - startMs) / HOUR_MS).map((t, i) => {
    const p = price(t) * (i % 2 === 0 ? 1.01 : 0.99);
    const base = quotePerHour / p;
    const s = p.toFixed(6);
    return { t, o: s, h: s, l: s, c: s, v: base.toFixed(6), qv: quotePerHour.toFixed(6) };
  });
  return KlineFile.parse({
    symbol,
    event_id: fixtureEvent.id,
    source_url: 'https://example.com/klines',
    fallback_source_url: 'https://example.com/mirror',
    fetched_at: '2026-11-11T00:00:00.000Z',
    interval: '1h',
    start_ms: startMs,
    end_ms: endMs,
    candles,
  });
}

function fixtureData(price: (t: number) => number): StudyData {
  return {
    [fileName('TSTUSDT', fixtureEvent.unlock_date)]: fixtureFile('TSTUSDT', price, 1_000_000),
    [fileName(MARKET_SYMBOL, fixtureEvent.unlock_date)]: fixtureFile(
      MARKET_SYMBOL,
      () => 50_000,
      1e9,
    ),
  };
}

describe('sale schedules', () => {
  it('selling over randomized times never sells more than the plan quantity', () => {
    const hours = hoursOf(0, 90 * 24);
    for (let seed = 0; seed < 500; seed++) {
      const quantity = BigInt(1 + seed * 7_919);
      const sales = randomSchedule(hours, quantity, 1 + (seed % 120), seededRng(seed));
      const sold = sales.reduce((s, x) => s + x.quantity, 0n);
      expect(sold).toBe(quantity);
      for (const sale of sales) expect(sale.quantity >= 0n).toBe(true);
    }
  });

  it('a random plan only sells inside its window', () => {
    const hours = hoursOf(1_000 * HOUR_MS, 48);
    const sales = randomSchedule(hours, 1_000n, 30, seededRng(7));
    for (const sale of sales) expect(hours).toContain(sale.t);
  });

  it('the same seed draws the same plan, and different seeds draw different ones', () => {
    const hours = hoursOf(0, 2_000);
    const a = randomSchedule(hours, 10_000n, 20, seededRng(42));
    const b = randomSchedule(hours, 10_000n, 20, seededRng(42));
    const c = randomSchedule(hours, 10_000n, 20, seededRng(43));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('an even schedule sells exactly the quantity, remainder to the earliest hours', () => {
    const sales = evenSchedule(hoursOf(0, 3), 10n);
    expect(sales.map((s) => s.quantity)).toEqual([4n, 3n, 3n]);
  });
});

describe('impact model', () => {
  it('impact is monotonic in size', () => {
    let previous = 0;
    for (const notional of [1, 1e3, 1e5, 1e6, 1e7, 5e7]) {
      const f = impactFraction(MODEL, notional, 1e8);
      expect(f).toBeGreaterThan(previous);
      previous = f;
    }
  });

  it('selling into more volume costs less', () => {
    expect(impactFraction(MODEL, 1e6, 1e9)).toBeLessThan(impactFraction(MODEL, 1e6, 1e8));
  });

  it('follows the square root: four times the size doubles the price concession', () => {
    expect(impactFraction(MODEL, 4e6, 1e8)).toBeCloseTo(2 * impactFraction(MODEL, 1e6, 1e8), 12);
  });

  it('never charges more than the cap, and nothing for no sale', () => {
    expect(impactFraction(MODEL, 1e12, 1)).toBe(0.5);
    expect(impactFraction(MODEL, 0, 1e8)).toBe(0);
  });
});

describe('percentiles', () => {
  it('interpolates between ranks', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([0, 10], 10)).toBeCloseTo(1, 12);
  });
});

describe('study on a fixture', () => {
  const t = unlockMs(fixtureEvent.unlock_date);

  it('with flat prices, spreading sales over 90 days avoids modelled impact and nothing else', () => {
    const study = runStudy(
      [fixtureEvent],
      fixtureData(() => 2),
      FAST,
    );
    const r = study.events[0]!;
    expect(r.observed.return_t_minus_30d_to_t_minus_1d).toBeCloseTo(0, 10);
    expect(r.simulation.sell_quantity).toBe('10000000');
    const c = r.simulation.comparison;
    expect(c.impact_avoided_usd.p10).toBeGreaterThan(0);
    expect(r.simulation.benchmark.impact_bps).toBeGreaterThan(r.simulation.sealed.impact_bps.p90);
    // The +-1% hourly wiggle is the only price-path effect left.
    expect(Math.abs(c.price_path_difference_bps.median)).toBeLessThan(150);
    expect(r.simulation.benchmark.sale_count).toBe(72);
    expect(r.simulation.public_twap.sale_count).toBe(90 * 24);
  });

  it('a falling market after the unlock shows up as a price-path loss, not as impact', () => {
    const falling = (ms: number) =>
      ms < t ? 2 : 2 * (1 - 0.5 * Math.min(1, (ms - t) / (90 * DAY_MS)));
    const r = runStudy([fixtureEvent], fixtureData(falling), FAST).events[0]!;
    expect(r.simulation.comparison.price_path_difference_bps.p90).toBeLessThan(0);
    expect(r.simulation.comparison.impact_avoided_usd.p10).toBeGreaterThan(0);
    expect(r.observed.return_t_minus_1d_to_t_plus_30d).toBeLessThan(0);
  });

  it('impact avoided grows with the impact coefficient', () => {
    const r = runStudy(
      [fixtureEvent],
      fixtureData(() => 2),
      FAST,
    ).events[0]!;
    const [low, high] = r.simulation.sensitivity;
    expect(low!.impact_coefficient).toBe(0.5);
    expect(high!.impact_avoided_usd.median).toBeGreaterThan(low!.impact_avoided_usd.median);
  });

  it('the same inputs always give the same results', () => {
    const data = fixtureData(() => 2);
    expect(runStudy([fixtureEvent], data, FAST)).toEqual(runStudy([fixtureEvent], data, FAST));
  });

  it('refuses to run without the data file', () => {
    expect(() => runStudy([fixtureEvent], {}, FAST)).toThrow('Missing data file');
  });
});

describe('committed replay data', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'replay');
  const resultsPath = join(dir, 'results.json');

  it.runIf(existsSync(resultsPath))('results.json matches a fresh run of the study', () => {
    const data: StudyData = {};
    for (const e of EVENTS) {
      for (const symbol of [e.symbol, MARKET_SYMBOL]) {
        const name = fileName(symbol, e.unlock_date);
        data[name] = KlineFile.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      }
    }
    const fresh = runStudy(EVENTS, data);
    const committed = JSON.parse(readFileSync(resultsPath, 'utf8')) as {
      headline: { event_id: string; modelled: { impact_avoided_bps: { median: number } } }[];
    };
    for (const [i, r] of fresh.events.entries()) {
      const h = committed.headline[i]!;
      expect(h.event_id).toBe(r.event.id);
      expect(h.modelled.impact_avoided_bps.median).toBeCloseTo(
        r.simulation.comparison.impact_avoided_bps.median,
        3,
      );
      for (const c of data[fileName(r.event.symbol, r.event.unlock_date)]!.candles) {
        expect(c.t % HOUR_MS).toBe(0);
      }
    }
  });
});
