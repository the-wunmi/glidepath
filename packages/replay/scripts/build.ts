/**
 * Builds data/replay/results.json from the fetched kline files. Offline and deterministic: the same
 * files always give the same output. Run `pnpm replay` first to fetch data.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSUMPTIONS,
  buildCase,
  EVENTS,
  type EventResult,
  fileName,
  KlineFile,
  LIMITATIONS,
  MARKET_SYMBOL,
  METHOD,
  runStudy,
  type StudyData,
  toBars,
  toSeries,
} from '../src/index.ts';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'replay');

/** Eight significant digits is far below the noise in any of these estimates. */
const round = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number')
    return Number.isInteger(value) ? value : Number(value.toPrecision(8));
  if (Array.isArray(value)) return value.map(round);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)]));
  }
  return value;
};

function loadData(): StudyData {
  const data: StudyData = {};
  for (const event of EVENTS) {
    for (const symbol of [event.symbol, MARKET_SYMBOL]) {
      const name = fileName(symbol, event.unlock_date);
      data[name] = KlineFile.parse(JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')));
    }
  }
  return data;
}

const headline = (r: EventResult) => ({
  event_id: r.event.id,
  token: r.event.token,
  unlock_date: r.event.unlock_date,
  unlock_amount: r.event.unlock_amount,
  insider_amount: r.event.insider_amount,
  share_of_supply: r.event.share_of_supply,
  verification: r.event.verification,
  observed: {
    return_t_minus_30d_to_t_minus_1d: r.observed.return_t_minus_30d_to_t_minus_1d,
    excess_return_t_minus_30d_to_t_minus_1d: r.observed.excess_return_t_minus_30d_to_t_minus_1d,
    return_t_minus_1d_to_t_plus_7d: r.observed.return_t_minus_1d_to_t_plus_7d,
    excess_return_t_minus_1d_to_t_plus_7d: r.observed.excess_return_t_minus_1d_to_t_plus_7d,
    max_drawdown_t_minus_30d_to_t_plus_30d: r.observed.max_drawdown_t_minus_30d_to_t_plus_30d,
    volume_ratio_week_after_vs_month_before: r.observed.volume_ratio_week_after_vs_month_before,
  },
  modelled: {
    sell_quantity: r.simulation.sell_quantity,
    notional_at_t_minus_1d_usd: r.simulation.notional_at_t_minus_1d_usd,
    benchmark_impact_bps: r.simulation.benchmark.impact_bps,
    sealed_impact_bps: r.simulation.sealed.impact_bps,
    impact_avoided_usd: r.simulation.comparison.impact_avoided_usd,
    impact_avoided_bps: r.simulation.comparison.impact_avoided_bps,
    price_path_difference_bps: r.simulation.comparison.price_path_difference_bps,
    net_difference_bps: r.simulation.comparison.net_difference_bps,
    sealed_vs_public_twap_net_bps: r.simulation.comparison.sealed_vs_public_twap_net_bps,
  },
});

function main() {
  const data = loadData();
  const study = runStudy(EVENTS, data);
  const fetchedAt = Object.values(data)
    .map((f) => f.fetched_at)
    .sort();
  const results = {
    study: 'unlock-replay',
    version: 1,
    data_fetched_from: fetchedAt[0],
    data_fetched_to: fetchedAt[fetchedAt.length - 1],
    units: {
      returns: 'fraction (-0.12 = -12%)',
      bps: 'basis points of benchmark proceeds unless stated',
      usd: 'USDT on Binance, treated as USD',
      quantities: 'whole tokens, decimal strings',
      spread: '{ p10, median, p90 } across seeded sealed plans',
    },
    labels: {
      observed: 'Measured from historical Binance prices; no model.',
      price_path_difference: 'Observed prices, hypothetical sale times; reflects one market path.',
      impact: 'Model estimate (square-root impact); depends on the stated coefficient.',
    },
    params: study.params,
    method: METHOD,
    assumptions: ASSUMPTIONS,
    limitations: LIMITATIONS,
    data_sources: Object.entries(data).map(([file, f]) => ({
      file: `data/replay/${file}`,
      symbol: f.symbol,
      event_id: f.event_id,
      source_url: f.source_url,
      fallback_source_url: f.fallback_source_url,
      fetched_at: f.fetched_at,
      interval: f.interval,
      candles: f.candles.length,
    })),
    headline: study.events.map(headline),
    events: study.events,
  };
  const path = join(DATA_DIR, 'results.json');
  writeFileSync(path, `${JSON.stringify(round(results), null, 2)}\n`);
  console.log(`wrote ${path}`);
  for (const h of results.headline) console.log(JSON.stringify(round(h)));

  // The demo's real-unlock case: ARB, 2024-03-16, built from the same hourly files.
  const arb = data[fileName('ARBUSDT', '2024-03-16')] as KlineFile;
  const btc = data[fileName(MARKET_SYMBOL, '2024-03-16')] as KlineFile;
  const series = (f: KlineFile) => toSeries(toBars(f.candles));
  const built = buildCase(series(arb), series(btc), arb.source_url);
  const casePath = join(DATA_DIR, `case-${built.case.id}.json`);
  writeFileSync(casePath, `${JSON.stringify(round(built), null, 2)}\n`);
  console.log(`wrote ${casePath}`);
  console.log(
    JSON.stringify(
      round({
        token_change: built.price.token_change,
        btc_change: built.price.btc_change,
        observed: built.observed.attempts.map((a) => [a.amount, a.price_usd, a.verdict]),
        observed_impact_bps: built.observed.model.impact_bps,
        observed_participation: built.observed.model.max_daily_participation,
        sealed_allowed: built.sealed.allowed_amount,
        sealed_sales: built.sealed.attempts.length,
        sealed_last: built.sealed.attempts.at(-1)?.verdict,
        sealed_impact_bps: built.sealed.model.impact_bps,
        sealed_participation: built.sealed.model.max_daily_participation,
        periods: built.sealed.periods_to_sell_deposited,
      }),
    ),
  );
}

main();
