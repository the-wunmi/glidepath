import { DAY_MS, fileName, type KlineFile, toBars, unlockMs } from './data.ts';
import type { UnlockEvent } from './events.ts';
import { MARKET_SYMBOL } from './events.ts';
import {
  type ExecutionResult,
  evenSchedule,
  execute,
  randomSchedule,
  type Sale,
} from './execution.ts';
import type { ImpactModel } from './impact.ts';
import { type ObservedStats, observedStats } from './observed.ts';
import { hashSeed, seededRng } from './random.ts';
import { dailyQuoteVolume, type Series, toSeries } from './series.ts';
import { type Spread, spread } from './stats.ts';

export interface StudyParams {
  /** Share of the team/investor tranche the hypothetical seller sells, in basis points. */
  sell_fraction_bps: number;
  /** Days after the unlock over which the sealed plan (and the public TWAP) spread their sales. */
  plan_days: number;
  /** Days after the unlock over which the benchmark sells everything. */
  benchmark_days: number;
  /** Number of sales the sealed plan makes at random hours. */
  sealed_sales: number;
  /** Number of seeds (independent random plans) per event. */
  seeds: number;
  /** Base impact coefficient Y. */
  impact_coefficient: number;
  /** Cap on the modelled price concession per day. */
  max_impact_fraction: number;
  sensitivity_coefficients: number[];
  sensitivity_sell_fractions_bps: number[];
}

/**
 * Defaults. 10% of the tranche: no source says how much insiders actually sold, so we pick a size
 * that is material without assuming a full dump, and show 5% and 25% alongside. 3 days: a seller who
 * wants out as soon as the public schedule allows. 90 sales over 90 days: about one a day on
 * average, within the planner's example gap bounds (6 hours to 4 days). Y = 1: the order of
 * magnitude the square-root impact literature reports.
 */
export const DEFAULT_PARAMS: StudyParams = {
  sell_fraction_bps: 1000,
  plan_days: 90,
  benchmark_days: 3,
  sealed_sales: 90,
  seeds: 1000,
  impact_coefficient: 1,
  max_impact_fraction: 0.5,
  sensitivity_coefficients: [0.5, 1, 2],
  sensitivity_sell_fractions_bps: [500, 1000, 2500],
};

/** Kline files keyed by `<SYMBOL>-<date>.json`, as written by scripts/replay-fetch.ts. */
export type StudyData = Record<string, KlineFile>;

export interface StrategySummary {
  gross_usd: number;
  impact_cost_usd: number;
  net_usd: number;
  impact_bps: number;
  avg_price_usd: number;
  max_daily_participation: number;
  sale_count: number;
  active_days: number;
}

export interface SealedSummary {
  gross_usd: Spread;
  impact_cost_usd: Spread;
  net_usd: Spread;
  impact_bps: Spread;
  avg_price_usd: Spread;
  max_daily_participation: Spread;
}

export interface Comparison {
  /** Modelled: benchmark impact cost minus sealed-plan impact cost. */
  impact_avoided_usd: Spread;
  impact_avoided_bps: Spread;
  /** Observed prices only: sealed gross minus benchmark gross (depends on the market path). */
  price_path_difference_usd: Spread;
  price_path_difference_bps: Spread;
  /** Sum of the two, as USD and as bps of benchmark net proceeds. */
  net_difference_usd: Spread;
  net_difference_bps: Spread;
  /** Sealed plan versus a public, deterministic TWAP over the same window, in bps of TWAP net. */
  sealed_vs_public_twap_net_bps: Spread;
}

export interface SensitivityRow {
  impact_coefficient: number;
  sell_fraction_bps: number;
  sell_quantity: string;
  benchmark_impact_bps: number;
  sealed_impact_bps_median: number;
  impact_avoided_usd: Spread;
  impact_avoided_bps: Spread;
  net_difference_bps: Spread;
}

export interface EventResult {
  event: UnlockEvent;
  data: {
    token_file: string;
    market_file: string;
    source_url: string;
    fetched_at: string;
    interval: '1h';
    candles: number;
    first_open: string;
    last_open: string;
  };
  observed: ObservedStats;
  simulation: {
    sell_quantity: string;
    sell_fraction_of_insider_bps: number;
    notional_at_t_minus_1d_usd: number;
    impact_model: ImpactModel;
    benchmark: StrategySummary;
    public_twap: StrategySummary;
    sealed: SealedSummary;
    comparison: Comparison;
    sensitivity: SensitivityRow[];
  };
}

export interface StudyResult {
  params: StudyParams;
  events: EventResult[];
}

const summarise = (r: ExecutionResult): StrategySummary => ({
  gross_usd: r.gross_usd,
  impact_cost_usd: r.impact_cost_usd,
  net_usd: r.net_usd,
  impact_bps: r.impact_bps,
  avg_price_usd: r.avg_price_usd,
  max_daily_participation: r.max_daily_participation,
  sale_count: r.sale_count,
  active_days: r.active_days,
});

const hoursIn = (series: Series, fromMs: number, toMs: number): number[] =>
  series.bars.filter((b) => b.t >= fromMs && b.t < toMs).map((b) => b.t);

interface Context {
  token: Series;
  volume: Map<number, number>;
  planHours: number[];
  benchmarkHours: number[];
  seedBase: number;
}

/** Runs the benchmark, public TWAP and `seeds` sealed plans for one size and coefficient. */
function simulate(ctx: Context, quantity: bigint, model: ImpactModel, params: StudyParams) {
  const run = (s: Sale[]) => execute(s, ctx.token, ctx.volume, model);
  const benchmark = run(evenSchedule(ctx.benchmarkHours, quantity));
  const twap = run(evenSchedule(ctx.planHours, quantity));
  const sealed: ExecutionResult[] = [];
  for (let i = 0; i < params.seeds; i++) {
    const rng = seededRng((ctx.seedBase + i) >>> 0);
    sealed.push(run(randomSchedule(ctx.planHours, quantity, params.sealed_sales, rng)));
  }
  const of = (f: (r: ExecutionResult) => number) => spread(sealed.map(f));
  const comparison: Comparison = {
    impact_avoided_usd: of((r) => benchmark.impact_cost_usd - r.impact_cost_usd),
    impact_avoided_bps: of(
      (r) => ((benchmark.impact_cost_usd - r.impact_cost_usd) / benchmark.gross_usd) * 10_000,
    ),
    price_path_difference_usd: of((r) => r.gross_usd - benchmark.gross_usd),
    price_path_difference_bps: of(
      (r) => ((r.gross_usd - benchmark.gross_usd) / benchmark.gross_usd) * 10_000,
    ),
    net_difference_usd: of((r) => r.net_usd - benchmark.net_usd),
    net_difference_bps: of((r) => ((r.net_usd - benchmark.net_usd) / benchmark.net_usd) * 10_000),
    sealed_vs_public_twap_net_bps: of((r) => ((r.net_usd - twap.net_usd) / twap.net_usd) * 10_000),
  };
  const summary: SealedSummary = {
    gross_usd: of((r) => r.gross_usd),
    impact_cost_usd: of((r) => r.impact_cost_usd),
    net_usd: of((r) => r.net_usd),
    impact_bps: of((r) => r.impact_bps),
    avg_price_usd: of((r) => r.avg_price_usd),
    max_daily_participation: of((r) => r.max_daily_participation),
  };
  return { benchmark, twap, sealed: summary, comparison };
}

const fractionOf = (amount: bigint, bps: number): bigint => (amount * BigInt(bps)) / 10_000n; // rounds down

function loadFile(data: StudyData, symbol: string, date: string): [string, KlineFile] {
  const name = fileName(symbol, date);
  const file = data[name];
  if (!file) throw new Error(`Missing data file ${name}`);
  return [name, file];
}

export function runEvent(
  event: UnlockEvent,
  data: StudyData,
  params: StudyParams = DEFAULT_PARAMS,
): EventResult {
  const [tokenName, tokenFile] = loadFile(data, event.symbol, event.unlock_date);
  const [marketName, marketFile] = loadFile(data, MARKET_SYMBOL, event.unlock_date);
  const token = toSeries(toBars(tokenFile.candles));
  const market = toSeries(toBars(marketFile.candles));
  const t = unlockMs(event.unlock_date);
  const observed = observedStats(token, market, t);
  const ctx: Context = {
    token,
    volume: dailyQuoteVolume(token),
    planHours: hoursIn(token, t, t + params.plan_days * DAY_MS),
    benchmarkHours: hoursIn(token, t, t + params.benchmark_days * DAY_MS),
    seedBase: hashSeed(event.id),
  };
  const modelFor = (coefficient: number): ImpactModel => ({
    coefficient,
    dailyVolatility: observed.daily_volatility_t_minus_30d_to_t,
    maxFraction: params.max_impact_fraction,
  });
  const insider = BigInt(event.insider_amount);
  const quantity = fractionOf(insider, params.sell_fraction_bps);
  const model = modelFor(params.impact_coefficient);
  const base = simulate(ctx, quantity, model, params);

  const sensitivity: SensitivityRow[] = [];
  for (const bps of params.sensitivity_sell_fractions_bps) {
    for (const y of params.sensitivity_coefficients) {
      const q = fractionOf(insider, bps);
      const r = simulate(ctx, q, modelFor(y), params);
      sensitivity.push({
        impact_coefficient: y,
        sell_fraction_bps: bps,
        sell_quantity: q.toString(),
        benchmark_impact_bps: r.benchmark.impact_bps,
        sealed_impact_bps_median: r.sealed.impact_bps.median,
        impact_avoided_usd: r.comparison.impact_avoided_usd,
        impact_avoided_bps: r.comparison.impact_avoided_bps,
        net_difference_bps: r.comparison.net_difference_bps,
      });
    }
  }

  const first = tokenFile.candles[0];
  const last = tokenFile.candles[tokenFile.candles.length - 1];
  return {
    event,
    data: {
      token_file: tokenName,
      market_file: marketName,
      source_url: tokenFile.source_url,
      fetched_at: tokenFile.fetched_at,
      interval: tokenFile.interval,
      candles: tokenFile.candles.length,
      first_open: new Date(first?.t ?? 0).toISOString(),
      last_open: new Date(last?.t ?? 0).toISOString(),
    },
    observed,
    simulation: {
      sell_quantity: quantity.toString(),
      sell_fraction_of_insider_bps: params.sell_fraction_bps,
      notional_at_t_minus_1d_usd: Number(quantity) * observed.prices.t_minus_1d,
      impact_model: model,
      benchmark: summarise(base.benchmark),
      public_twap: summarise(base.twap),
      sealed: base.sealed,
      comparison: base.comparison,
      sensitivity,
    },
  };
}

/** Runs the whole study. Pure: same events, data and params always give the same result. */
export function runStudy(
  events: UnlockEvent[],
  data: StudyData,
  params: StudyParams = DEFAULT_PARAMS,
): StudyResult {
  return { params, events: events.map((e) => runEvent(e, data, params)) };
}
