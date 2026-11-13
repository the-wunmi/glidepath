# Unlock replay study: method and results

This study replays four large, publicly scheduled team and investor token unlocks using real hourly
Binance prices. It asks two questions:

- **A. Observed:** what did prices do around each public unlock date? This measures the window in which
  a public schedule can be front-run.
- **B. Modelled:** if a holder sold the same quantity either all at once just after the unlock, or
  through a sealed plan at random hours over 90 days, how would proceeds compare? We **measure** the
  price-path part from real prices. The market-impact part is an **estimate** from a stated model.

Results are in `results.json`, built by `packages/replay/scripts/build.ts` from the kline files in this
folder. The build is offline and deterministic: the same files always give the same numbers.

## Events

The amounts below come from the pages we fetched on 2026-11-11. T is 00:00 UTC on the unlock date.
Sources give dates, not times.

| Event | Unlocked | Team/investor part (the part replayed) | Share of supply | Recipients | Sources |
|---|---|---|---|---|---|
| ARB 2024-03-16 | 1.11B ARB | 1.11B | 11.1% of the 10B supply cap (76.62% of circulating, per FXStreet) | Team/contributors/advisors and investors; investors 438.25M | [CoinDesk](https://www.coindesk.com/markets/2023/08/16/arbitrum-will-unlock-12b-arb-in-march-2024-token-unlocks), [FXStreet](https://www.fxstreet.com/cryptocurrencies/news/arbitrum-price-readies-for-one-of-the-biggest-token-unlocks-of-2024-202403130200), [Arbitrum docs](https://docs.arbitrum.foundation/airdrop-eligibility-distribution) |
| OP 2023-05-31 | >386M OP (386M used) | 386M | 9% of total supply | Core contributors and investors (their first unlock) | [Cointelegraph](https://cointelegraph.com/news/optimism-unlock-millions-op-token-may-price-pressure), [The Block](https://www.theblock.co/post/232511/optimism-sui-set-for-large-token-unlocks-worth-a-combined-650-million) |
| APT 2023-11-12 | 24.84M APT | 20.30M (core contributors 11.88M plus investors 8.42M; **our sum**) | About 10% of circulating supply | The other 4.54M went to the community and the foundation | [The Block](https://www.theblock.co/news/ecosystems/2023-11-01-aptos-avalanche-dominate-450-million-november-token-unlocks-260336), [The Daily Hodl](https://dailyhodl.com/2023/11/13/over-181000000-worth-of-aptos-apt-tokens-unlocked-distributed-to-four-major-cohorts/) |
| STRK 2024-04-15 | 64M STRK | 64M | 0.64% of the 10B supply | Early contributors and investors | [Cointelegraph](https://cointelegraph.com/news/starkware-changes-controversial-investor-starknet-token-unlock-schedule) |

Caveats on the sources:

- No fetched source gave the OP split between core contributors and investors, so we do not record one.
- For ARB, only the investor part (438.25M) was read directly. The team part (about 672M) is the
  remainder.
- STRK's April 2024 unlock is small because StarkWare cut it from about 1.3B after public criticism. We
  kept it as a contrast case.
- We considered SUI and WLD and dropped them. The sources we found did not give a single dated cliff
  with a confirmed team/investor amount: SUI's 2023 unlock was mostly an airdrop, and WLD's team and
  investor tokens unlock linearly.

## Data

- **Source:** Binance spot klines, `GET https://api.binance.com/api/v3/klines`, `interval=1h`. The
  fallback mirror is `https://data-api.binance.vision/api/v3/klines`. No API key is needed. Fetched on
  2026-11-11 by `scripts/replay-fetch.ts`.
- **Files:** `<SYMBOL>-<date>.json`, one per token per event, plus `BTCUSDT-<date>.json` for the same
  window as a market reference. Each file covers T-35d to T+95d: 3,120 hourly candles, none missing.
  Each file records `source_url`, `fetched_at`, `interval` and the raw candles. Prices are stored as
  the decimal strings Binance returned.
- **Hourly price used for a sale:** Binance's own VWAP for that hour (quote volume / base volume).
- **Daily volume used for impact:** the sum of the hourly quote (USDT) volumes for that UTC day, on
  Binance only.

## Method

### Part A: observed price behaviour

All of these are measured directly; no model is involved.

- A price "at T-30d" is the close of the hourly candle that ends at that instant.
- **Returns:**
  - T-30d to T-1d: the window in which a public schedule can be front-run.
  - T-1d to T+7d.
  - T-1d to T+30d.
- **Excess return:** the token's return minus BTC's return over the same window. This is a crude
  control for moves across the whole market, not a full event-study abnormal return.
- **Max drawdown:** the largest peak-to-trough fall in hourly closes from T-30d to T+30d.
- **Volume ratio:** average daily Binance volume over [T, T+7d) divided by the average over
  [T-30d, T).

### Part B: simulated sealed plan against a benchmark

- **Quantity:** 10% of the team/investor part, in whole tokens. No source tells us what insiders
  actually sold. 10% is material without assuming a full dump. We also show 5% and 25%.
- **Benchmark (public unlock, sell fast):** the quantity is split evenly across all 72 hours of
  [T, T+3d).
- **Sealed plan:**
  - 90 sales at hours drawn uniformly from [T, T+90d).
  - Each sale's size is the average times a random weight in [0.5, 1.5).
  - Sizes are integers, floored, with the remainder added to the last sale. The plan sells exactly the
    quantity and never more; a test checks this.
  - We run 1,000 seeded plans per event (seeded so results are reproducible) and report the 10th
    percentile, median and 90th percentile.
- **Public TWAP:** the same quantity split evenly over every hour of [T, T+90d). It separates the
  gain from spreading sales out from the gain from randomising them.
- **Gross proceeds (observed prices):** each sale × the VWAP of its hour.
- **Impact cost (model estimate):**
  - Sales on the same UTC day form one order of notional Q against that day's Binance quote volume V.
  - Cost = Q × Y × σ × √(Q / V), capped at 50% of Q. The cap was never reached in these runs.
  - σ is the token's daily volatility, from hourly log returns in [T-30d, T). This is something a
    seller would know in advance.
  - The square-root law is the standard empirical form (Almgren et al. 2005; Tóth et al. 2011 report
    Y of order 1). We use Y = 1 as the base and show Y = 0.5 and Y = 2.
- **Comparison:**
  - *Impact avoided (modelled)* = benchmark impact cost − sealed impact cost.
  - *Price-path difference (observed)* = sealed gross − benchmark gross.
  - *Net difference* = the sum of the two.
  - All three are in basis points (bps) of the benchmark's proceeds.

## Results

### A. Observed (Binance prices; returns as %; BTC in brackets)

| Event | T-30d → T-1d | Excess vs BTC | T-1d → T+7d | Excess | T-1d → T+30d | Excess | Max drawdown T-30d..T+30d | Volume, week after / month before |
|---|---|---|---|---|---|---|---|---|
| ARB | −4.5% (BTC +37.8%) | **−42.4%** | −20.4% (BTC −10.6%) | −9.8% | −41.5% | −33.5% | −58.8% | 1.67× |
| OP | −29.7% (BTC −5.1%) | **−24.6%** | −1.9% (BTC −1.8%) | −0.1% | −19.9% | −29.7% | −51.5% | 1.90× |
| APT | +54.9% (BTC +39.4%) | **+15.5%** | −5.6% (BTC −2.0%) | −3.7% | +4.0% | −6.6% | −17.5% | 1.33× |
| STRK | −35.3% (BTC −8.0%) | **−27.3%** | −7.7% (BTC +1.6%) | −9.3% | −19.0% | −15.3% | −53.0% | 0.57× |

What the observed numbers show:

- **Before the unlock:** in three of the four events (ARB, OP, STRK), the token did 24 to 42
  percentage points worse than BTC in the 30 days before the public unlock date. APT did 15.5 points
  better.
- **Week after:** all four did worse than BTC, by 0.1 to 9.8 points.
- **Month after:** all four did worse than BTC, by 6.6 to 33.5 points.

This fits the pattern that a public schedule invites selling ahead of the date. However, four events
cannot show that the unlock caused these moves: each token also had its own news over the same weeks.

### B. Modelled: sealed plan (90 random sales over 90 days) against the benchmark (sell in 3 days)

The base case is Y = 1 and 10% of the team/investor part. Spread figures are the median, with the
10th to 90th percentile across 1,000 seeded plans in brackets. Impact figures are **model estimates**.

| Event | Quantity (≈ USD at T-1d) | Benchmark impact | Sealed impact | **Impact avoided (modelled)** | Price-path difference (observed) | Net difference | Sealed vs public 90-day TWAP |
|---|---|---|---|---|---|---|---|
| ARB | 111M ARB (≈ $224M) | 256 bps | 99 bps (93–107) | **185 bps (180–190) ≈ $3.6M** | −2,906 bps (−3,104 to −2,690) | −2,791 bps (−2,994 to −2,575) | −36 bps (−317 to +262) |
| OP | 38.6M OP (≈ $59M) | 304 bps | 88 bps (83–94) | **216 bps (210–221) ≈ $1.2M** | −3 bps (−169 to +170) | +221 bps (+50 to +396) | −28 bps (−194 to +143) |
| APT | 2.03M APT (≈ $15M) | 166 bps | 57 bps (54–61) | **102 bps (97–106) ≈ $0.16M** | +1,232 bps (+1,047 to +1,408) | +1,358 bps (+1,169 to +1,533) | −13 bps (−179 to +142) |
| STRK | 6.4M STRK (≈ $9M) | 156 bps | 53 bps (50–56) | **115 bps (111–118) ≈ $0.10M** | −2,063 bps (−2,366 to −1,776) | −1,979 bps (−2,286 to −1,690) | −2 bps (−385 to +359) |

How to read this:

- **Impact avoided:** under the model, spreading the sale over 90 days instead of 3 cuts the
  estimated impact cost by about 1.0% to 2.2% of proceeds (Y = 1). Its size depends directly on the
  model.
- **Price-path difference:** this is set by the market, not by the plan. ARB and STRK kept falling for
  months after their unlocks, so any seller who waited got less. APT rose, so waiting got more. A
  90-day plan swaps the risk of selling into a crowded unlock for exposure to the next three months'
  price path.
- **Sealed vs public TWAP:** the median difference is close to zero (−2 to −36 bps), with a wide
  range. Random timing puts more volume on some days, which costs slightly more modelled impact than a
  perfectly even TWAP. This model **does not credit** the sealed plan for being unpredictable; that
  benefit is the subject of part A.
- **Benchmark participation:** in the benchmark, the seller would have been up to 26% (ARB), 62% (OP),
  13% (APT) and 8% (STRK) of a day's Binance volume. Real volume across all venues is higher, so the
  modelled impact is probably overstated for both strategies.

### Sensitivity: modelled impact avoided, median bps of benchmark proceeds

| Event | 5% of tranche, Y = 0.5 / 1 / 2 | 10%, Y = 0.5 / 1 / 2 | 25%, Y = 0.5 / 1 / 2 |
|---|---|---|---|
| ARB | 65 / 131 / 262 | 92 / 185 / 370 | 146 / 292 / 585 |
| OP | 76 / 153 / 305 | 108 / 216 / 432 | 171 / 341 / 682 |
| APT | 36 / 72 / 144 | 51 / 102 / 204 | 81 / 161 / 322 |
| STRK | 41 / 81 / 162 | 57 / 115 / 229 | 91 / 181 / 362 |

Impact avoided scales linearly with Y and roughly with the square root of the sale size. The 10th–90th
percentile ranges for every cell are in `results.json` under `events[].simulation.sensitivity`.

## Assumptions

- The unlock is at 00:00 UTC on the published date.
- The hypothetical seller sells 10% of the team/investor part (5% and 25% in the sensitivity table).
- Binance spot TOKEN/USDT stands in for the whole market, and USDT is treated as USD.
- The cost of selling follows the square-root impact law with Y between 0.5 and 2.
  - Impact is charged per UTC day.
  - There is no permanent impact and no carry-over between days.
  - The historical price path is taken as given: we do not model how these sales or other traders'
    reactions would have moved later prices.
- Daily volatility is measured over the 30 days before the unlock and held fixed.
- Prices and proceeds are floats, because this is statistical analysis rather than accounting. Token
  quantities are integers (`bigint`).

## Limitations

- **Sample:** four events, chosen because they are large, well known and well sourced, not at random.
  This is a case study. It does not show that unlocks cause price falls, or how large such falls
  typically are.
- **Observed returns:** these mix the unlock with everything else that happened to each token and to
  the market. Subtracting BTC is only a rough control.
- **Price-path difference:** this is one historical path. It is not a property of sealed plans, and in
  a rising market it would have the opposite sign.
- **Impact numbers:** these are model outputs. They would change under a different impact model, a
  different Y or a multi-venue volume measure.
- **What the model credits:** the model only rewards spreading sales out, and a public 90-day TWAP gets
  about the same saving. The sealed plan's main claim is that nobody outside can see when sales will
  happen, which prevents front-running of the schedule itself. This replay does not quantify that
  claim. Part A only shows the size of the window a public schedule leaves open.
- **Amounts:** these are as reported by the cited articles and docs, some of them rounded.

## Reproduce

```bash
pnpm install
pnpm replay                                  # refetch klines into data/replay (optional; files are committed)
pnpm --filter @vsp/replay build:results      # rebuild data/replay/results.json
cd packages/replay && npx vitest run         # includes a check that results.json matches a fresh run
```
