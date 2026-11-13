import { HOUR_MS } from './data.ts';
import { type ExecutionResult, execute, type Sale } from './execution.ts';
import type { ImpactModel } from './impact.ts';
import { type Rng, seededRng } from './random.ts';
import { dailyQuoteVolume, dailyVolatility, priceAt, type Series } from './series.ts';

/**
 * One real unlock, told from the chain: ARB's first team/investor cliff on 2024-03-16. Every flow
 * below was read from Arbitrum One through its public RPC (ARB token Transfer logs and receipts,
 * re-checked 2026-11-11); every label says who applied it. Nothing here names a person or firm:
 * no source identifies the beneficiary, only the vesting contracts it released from.
 */

const ARBISCAN_TX = (hash: string) => `https://arbiscan.io/tx/${hash}`;
const ARBISCAN_ADDRESS = (address: string) => `https://arbiscan.io/address/${address}`;

export interface Source {
  label: string;
  url: string;
}

export interface Flow {
  at: string;
  kind: 'release' | 'forward' | 'deposit';
  /** Whole ARB as a decimal string, exact from the Transfer log (18 decimals trimmed). */
  amount: string;
  from: { address: string; label: string };
  to: { address: string; label: string };
  tx: string;
  explorer: string;
}

const VESTING_BENEFICIARY = '0xc530bb3a7476f0186cfd41550960ea3758bad2cb';
const FORWARDED_TO = '0x4c4af1a1769118a077a8f23aed4c21ed4b1302b4';
const DEPOSIT_ADDRESS = '0xe6a9fdbb2b6232f9738b3c95c6258e81557f897b';
const DEPOSIT_LABEL =
  '“Binance Deposit” (Arbiscan public name tag, as shown in Lookonchain’s screenshot; Arbiscan itself was not reachable from our tools)';

const deposit = (at: string, amount: string, tx: string): Flow => ({
  at,
  kind: 'deposit',
  amount,
  from: {
    address: FORWARDED_TO,
    label:
      'Wallet funded by the vesting beneficiary 15 minutes after the releases (Lookonchain calls it a “whale”)',
  },
  to: { address: DEPOSIT_ADDRESS, label: DEPOSIT_LABEL },
  tx,
  explorer: ARBISCAN_TX(tx),
});

export const ARB_CASE = {
  id: 'arb-2024-03-16',
  title: 'ARB’s first team and investor cliff, 16 March 2024',
  symbol: 'ARBUSDT',
  token: 'ARB',
  /** `start()` of the vesting contracts: 0x65f58bbc = 2024-03-16T12:08:28Z (read with eth_call). */
  unlock_at: '2024-03-16T12:08:28Z',
  unlock: {
    amount:
      '1,110,000,000 ARB unlocked for team, future team, advisors and investors (673.5M team side, 438.25M investors), the first cliff after a one-year lock',
    sources: [
      {
        label:
          'Arbitrum Foundation: token distribution (team 26.94%, investors 17.53%, four-year schedule, first unlock after one year)',
        url: 'https://docs.arbitrum.foundation/airdrop-eligibility-distribution',
      },
      {
        label: 'CoinDesk, 2023-08-16: Arbitrum will unlock 1.1B ARB in March 2024',
        url: 'https://www.coindesk.com/markets/2023/08/16/arbitrum-will-unlock-12b-arb-in-march-2024-token-unlocks',
      },
      {
        label: 'FXStreet, 2024-03-13: 673.5M to team and advisors, 438.25M to investors',
        url: 'https://www.fxstreet.com/cryptocurrencies/news/arbitrum-price-readies-for-one-of-the-biggest-token-unlocks-of-2024-202403130200',
      },
    ] satisfies Source[],
  },
  vesting: {
    beneficiary: VESTING_BENEFICIARY,
    contracts: 15,
    released: '10626693.5',
    detail:
      '15 ArbitrumVestingWallet contracts (e.g. 0x64220e…136c8) whose on-chain beneficiary() is 0xc530…d2cb, start() 2024-03-16 12:08:28 UTC and duration() 3 years: one quarter at the cliff, then monthly. The contract code is the Arbitrum Foundation’s; which team member or investor the beneficiary is, no source says.',
    sources: [
      {
        label: 'ArbitrumVestingWallet source (Arbitrum Foundation governance repo)',
        url: 'https://github.com/ArbitrumFoundation/governance/blob/main/src/ArbitrumVestingWallet.sol',
      },
      {
        label: 'One of the 15 vesting contracts',
        url: ARBISCAN_ADDRESS('0x64220e2018b64cb42ffd10ad18df8d8952d136c8'),
      },
      { label: 'The vesting beneficiary', url: ARBISCAN_ADDRESS(VESTING_BENEFICIARY) },
    ] satisfies Source[],
  },
  flows: [
    {
      at: '2024-03-16T12:14:59Z',
      kind: 'release',
      amount: '10626693.5',
      from: {
        address: '0x64220e2018b64cb42ffd10ad18df8d8952d136c8',
        label: '15 ArbitrumVestingWallet contracts (first release shown; all 15 within minutes)',
      },
      to: { address: VESTING_BENEFICIARY, label: 'Their on-chain beneficiary (unnamed)' },
      tx: '0x7aa533b6a017affb20388841f0cae470a6ee3316892c52d7584967f77b3060ee',
      explorer: ARBISCAN_TX('0x7aa533b6a017affb20388841f0cae470a6ee3316892c52d7584967f77b3060ee'),
    },
    {
      at: '2024-03-16T12:30:07Z',
      kind: 'forward',
      amount: '10626691',
      from: { address: VESTING_BENEFICIARY, label: 'The vesting beneficiary' },
      to: { address: FORWARDED_TO, label: 'A wallet Lookonchain lists among unlock “whales”' },
      tx: '0x7c0e62dffb7fcb5e0e38786b3772181c707c308a2ba1ea823bdf835a899e6250',
      explorer: ARBISCAN_TX('0x7c0e62dffb7fcb5e0e38786b3772181c707c308a2ba1ea823bdf835a899e6250'),
    },
    deposit(
      '2024-03-22T00:46:58Z',
      '1469572.2',
      '0xcee22974e8867be9f7330caec148d3c819a562f4a9e6694ad70fc68f24d60051',
    ),
    deposit(
      '2024-03-22T20:26:54Z',
      '1712177',
      '0xf6f37774023f9bff396e76cd638aefa3bbcf1cfb8f7f6e1490af576a4a3cda49',
    ),
    deposit(
      '2024-03-25T21:05:59Z',
      '3424356.04',
      '0xc2b963d48fa8444e24a2f5a4d9698cb7317df70c2277760fcfd2e037f466b830',
    ),
    deposit(
      '2024-03-28T20:20:09Z',
      '2853672.28',
      '0xf3f9514be4a2fdb2985d2601f3c0cdadffa093cf18397ae3631b3ea15b93e243',
    ),
  ] satisfies Flow[],
  /** Third-party reporting that matches the on-chain flows; quoted for its labels, not as proof. */
  reporting: [
    {
      label: 'Lookonchain, 2024-03-18: 11 whales deposited 34M ARB to exchanges after the unlock',
      url: 'https://x.com/lookonchain/status/1769586523639562691',
    },
    {
      label:
        'Lookonchain, 2024-03-23: 4 more whale wallets (including 0x4c4a…02b4) deposited 11.34M ARB to Binance',
      url: 'https://x.com/lookonchain/status/1771589383218475510',
    },
    {
      label: 'Cointelegraph: Arbitrum unlock whales move $58M to exchanges',
      url: 'https://cointelegraph.com/news/arbitrum-unlock-whales-move-58-exchanges',
    },
  ] satisfies Source[],
  caveats: [
    'A deposit to an exchange is not proof of a sale; trades on Binance are off-chain. The modelled costs on this page assume each deposit was sold on its day, and say so.',
    'No source identifies the beneficiary as a particular team member or investor, or names anyone. We describe only what the contracts and transfers show.',
    'The exchange label comes from Arbiscan via Lookonchain’s screenshot; the transfers themselves were checked against the chain.',
    'This one beneficiary deposited about 9.46M ARB, under 1% of the 1.11B unlock; it did not by itself move the price. The whole market also fell over the same days: BTC moved about −6% in the same window.',
  ],
} as const;

/**
 * The public envelope we give the same allocation for the comparison. It is our illustration, not
 * anyone's real plan: 10% of the allocation a month, at most 1% in one sale, an hour between sales,
 * never below $1.00 guaranteed. Holders would have seen exactly these numbers on-chain.
 */
export const CASE_ENVELOPE = {
  period_days: 30,
  max_per_period_bps: 1000,
  max_per_sale_bps: 100,
  min_gap_hours: 1,
  floor_usd: 1,
  slippage_bps: 100,
} as const;

export type Verdict =
  | { allowed: true }
  | {
      allowed: false;
      code: 'tx_cap_exceeded' | 'period_cap_exceeded' | 'gap_too_short' | 'below_floor';
    };

export interface Attempt {
  at_ms: number;
  amount: number;
  price_usd: number;
  verdict: Verdict;
}

/**
 * The registry's envelope rules in its own order (execute.rs): per-sale cap, per-period cap,
 * minimum gap, then the floor on the guaranteed output (price less the slippage allowance).
 */
export function judge(
  attempts: { at_ms: number; amount: number; price_usd: number }[],
  allocation: number,
  startMs: number,
): Attempt[] {
  const e = CASE_ENVELOPE;
  const perSale = (allocation * e.max_per_sale_bps) / 10_000;
  const perPeriod = (allocation * e.max_per_period_bps) / 10_000;
  const periodMs = e.period_days * 24 * HOUR_MS;
  let period = -1;
  let sold = 0;
  let last: number | null = null;
  return attempts.map((a) => {
    const p = Math.floor((a.at_ms - startMs) / periodMs);
    if (p !== period) {
      period = p;
      sold = 0;
    }
    const guaranteed = a.price_usd * (1 - e.slippage_bps / 10_000);
    let verdict: Verdict = { allowed: true };
    if (a.amount > perSale) verdict = { allowed: false, code: 'tx_cap_exceeded' };
    else if (sold + a.amount > perPeriod) verdict = { allowed: false, code: 'period_cap_exceeded' };
    else if (last !== null && a.at_ms - last < e.min_gap_hours * HOUR_MS)
      verdict = { allowed: false, code: 'gap_too_short' };
    else if (guaranteed < e.floor_usd) verdict = { allowed: false, code: 'below_floor' };
    if (verdict.allowed) {
      sold += a.amount;
      last = a.at_ms;
    }
    return { ...a, verdict };
  });
}

/**
 * A sealed plan's sales over the same window: random hours at least the minimum gap apart (1 to 18
 * hours, standing in for the enclave's secret schedule), random sizes between half the per-sale cap
 * and the cap, until the next sale would pass the period cap. The last attempt shows that refusal.
 */
export function sealedSchedule(
  token: Series,
  allocation: number,
  fromMs: number,
  toMs: number,
  rng: Rng,
): { at_ms: number; amount: number; price_usd: number }[] {
  const perSale = (allocation * CASE_ENVELOPE.max_per_sale_bps) / 10_000;
  const out: { at_ms: number; amount: number; price_usd: number }[] = [];
  let t = Math.ceil(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  let sold = 0;
  const perPeriod = (allocation * CASE_ENVELOPE.max_per_period_bps) / 10_000;
  while (t < toMs) {
    const amount = Math.floor(perSale * (0.5 + rng() / 2));
    const bar = token.byTime.get(t);
    if (bar) {
      out.push({ at_ms: t, amount, price_usd: bar.vwap });
      sold += amount;
      if (sold > perPeriod) break;
    }
    t += (1 + Math.floor(rng() * 18)) * HOUR_MS;
  }
  return out;
}

const hourOf = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

export interface CaseResult {
  case: typeof ARB_CASE;
  envelope: typeof CASE_ENVELOPE & { allocation: number; per_sale: number; per_period: number };
  price: {
    source_url: string;
    window: { from: string; to: string };
    token_change: number;
    btc_change: number;
    unlock_hour_close: number;
    series: { t: number; close: number }[];
  };
  observed: {
    deposited: number;
    attempts: (Attempt & { tx: string; explorer: string })[];
    model: ExecutionResult;
  };
  sealed: {
    attempts: Attempt[];
    allowed_amount: number;
    model: ExecutionResult;
    periods_to_sell_deposited: number;
  };
  model: { coefficient: number; daily_volatility: number; label: string };
}

/**
 * Builds the side-by-side: (a) the dated deposits judged as if each had been a sale through the
 * registry, and (b) what a sealed plan with the public envelope above would have sold over the same
 * window, both priced at Binance's hourly VWAP and charged the replay study's impact model.
 */
export function buildCase(
  token: Series,
  btc: Series,
  sourceUrl: string,
  seed = 20240316,
): CaseResult {
  const c = ARB_CASE;
  const startMs = Date.parse(c.unlock_at);
  const allocation = Number(c.vesting.released);
  const deposits = c.flows.filter((f) => f.kind === 'deposit');
  const lastDeposit = Date.parse(deposits[deposits.length - 1]?.at ?? c.unlock_at);
  const windowFrom = Date.parse('2024-03-09T00:00:00Z');
  const windowTo = Date.parse('2024-03-24T00:00:00Z');
  const change = (s: Series) => priceAt(s, windowTo) / priceAt(s, windowFrom) - 1;

  const model: ImpactModel = {
    coefficient: 1,
    dailyVolatility: dailyVolatility(token, startMs - 30 * 24 * HOUR_MS, hourOf(startMs)),
    maxFraction: 0.5,
  };
  const volume = dailyQuoteVolume(token);
  const priceOf = (ms: number) => token.byTime.get(hourOf(ms))?.vwap ?? Number.NaN;

  const observedAttempts = judge(
    deposits.map((d) => ({
      at_ms: Date.parse(d.at),
      amount: Number(d.amount),
      price_usd: priceOf(Date.parse(d.at)),
    })),
    allocation,
    startMs,
  ).map((a, i) => ({ ...a, tx: deposits[i]?.tx ?? '', explorer: deposits[i]?.explorer ?? '' }));
  const asSales = (xs: { at_ms: number; amount: number }[]): Sale[] =>
    xs.map((x) => ({ t: hourOf(x.at_ms), quantity: BigInt(Math.floor(x.amount)) }));

  const sealedAttempts = judge(
    sealedSchedule(token, allocation, startMs, lastDeposit, seededRng(seed)),
    allocation,
    startMs,
  );
  const allowed = sealedAttempts.filter((a) => a.verdict.allowed);
  const deposited = deposits.reduce((s, d) => s + Number(d.amount), 0);
  const perPeriod = (allocation * CASE_ENVELOPE.max_per_period_bps) / 10_000;

  return {
    case: c,
    envelope: {
      ...CASE_ENVELOPE,
      allocation,
      per_sale: (allocation * CASE_ENVELOPE.max_per_sale_bps) / 10_000,
      per_period: perPeriod,
    },
    price: {
      source_url: sourceUrl,
      window: { from: new Date(windowFrom).toISOString(), to: new Date(windowTo).toISOString() },
      token_change: change(token),
      btc_change: change(btc),
      unlock_hour_close: token.byTime.get(hourOf(startMs))?.close ?? Number.NaN,
      series: token.bars
        .filter((b) => b.t >= windowFrom && b.t < Date.parse('2024-04-01T00:00:00Z'))
        .map((b) => ({ t: b.t, close: b.close })),
    },
    observed: {
      deposited,
      attempts: observedAttempts,
      model: execute(asSales(observedAttempts), token, volume, model),
    },
    sealed: {
      attempts: sealedAttempts,
      allowed_amount: allowed.reduce((s, a) => s + a.amount, 0),
      model: execute(asSales(allowed), token, volume, model),
      periods_to_sell_deposited: Math.ceil(deposited / perPeriod),
    },
    model: {
      coefficient: model.coefficient,
      daily_volatility: model.dailyVolatility,
      label:
        'Model estimate (square-root impact, coefficient 1, volatility from the 30 days before the unlock, Binance volume only). Not an observation.',
    },
  };
}
