/** Plain-language method, written into results.json so the web app can show it next to the numbers. */
export const METHOD = {
  summary:
    "We replay four publicly scheduled team/investor unlocks with real hourly Binance prices. Part A reports what prices did around each public unlock date (observed). Part B compares two hypothetical ways of selling the same quantity: all of it in the first 3 days after the unlock (the benchmark), or a sealed plan that sells at random hours over 90 days. Proceeds at observed prices are measured; the cost of the seller's own price impact is estimated with a square-root impact model.",
  steps: [
    'T is 00:00 UTC on the unlock date. Prices are the close of the hourly Binance spot candle ending at the stated time.',
    'Observed: returns T-30d to T-1d (the window in which a public schedule can be front-run), T-1d to T+7d and T-1d to T+30d; the same returns for BTC; their difference ("excess return"); the largest peak-to-trough fall of hourly closes from T-30d to T+30d; and Binance volume in the week after T versus the month before.',
    'Sell quantity: 10% of the team/investor tranche (5% and 25% in the sensitivity table), in whole tokens.',
    'Benchmark: the quantity split evenly across every hour of [T, T+3d).',
    'Sealed plan: 90 sales at hours drawn uniformly from [T, T+90d), each sized by a random weight in [0.5, 1.5) of the average; sizes are floored to whole tokens and the remainder added to the last sale. 1,000 seeded plans per event; we report the 10th percentile, median and 90th percentile.',
    'Public TWAP: the quantity split evenly across every hour of [T, T+90d). It isolates what spreading out buys from what randomising buys.',
    "Each sale is priced at Binance's VWAP for its hour (quote volume / base volume). Gross proceeds use these observed prices with no impact.",
    "Impact: sales on the same UTC day are one metaorder of notional Q against that day's Binance quote volume V. Cost = Q x Y x sigma x sqrt(Q / V), capped at 50% of Q. sigma is the daily volatility from hourly log returns in [T-30d, T) (known before the unlock). Base Y = 1; sensitivity Y = 0.5 and 2.",
    'Impact avoided (modelled) = benchmark impact cost - sealed impact cost. Price-path difference (observed) = sealed gross - benchmark gross. Net difference = the sum.',
  ],
} as const;

export const ASSUMPTIONS: string[] = [
  'The unlock happens at 00:00 UTC on the published date; sources give dates, not times.',
  'The hypothetical seller sells 10% of the team/investor tranche. No source tells us what insiders actually sold.',
  'Binance spot (TOKEN/USDT) stands in for the whole market. Real volume across all venues is larger, so the modelled impact is likely an overestimate for both strategies.',
  'The square-root impact law with Y between 0.5 and 2 describes the cost of selling. Impact is charged per day and does not carry over between days (no permanent impact, no decay model).',
  'The historical price path is taken as given: we do not model how the hypothetical sales would have changed later prices, or how other traders would have reacted.',
  'Daily volatility is measured over the 30 days before the unlock and held fixed afterwards.',
  'Floats are used for prices and proceeds because this is statistical price analysis; token quantities are integers (bigint) so the plan never sells more than its quantity.',
];

export const LIMITATIONS: string[] = [
  'Four events, chosen because they are large, well known and well sourced, not at random. This is a case study, not a statistically representative sample, and it cannot establish that unlocks cause price falls.',
  'The observed returns mix the unlock with everything else that happened to each token and to the market. Subtracting BTC is a crude control.',
  'The price-path difference between strategies is driven by where the market went after each unlock (for example, prices that kept falling for months make any later sale look worse). It is one historical path, not a property of sealed plans.',
  'The impact numbers are model outputs. They scale with Y and with the square root of the sale size, and they would change under another impact model.',
  'The model only captures the benefit of spreading sales out. A public 90-day TWAP gets roughly the same modelled impact saving. What the sealed plan adds, that nobody can see when the sales will come and front-run them, is not captured by this model; part A shows the window in which a public schedule is exposed.',
  'Recorded amounts are as reported by the cited articles and docs, some rounded (for example OP "more than 386 million"). The APT insider amount is our sum of two reported cohorts.',
];
