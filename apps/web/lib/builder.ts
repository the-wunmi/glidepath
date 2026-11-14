import {
  type Envelope,
  minBig,
  PRICE_SOURCES,
  type PriceSourceName,
  SealedPlan,
  type SealedPlanInput,
  toBaseUnits,
} from '@glidepath/core';
import { DAY_MS } from './format';

/** Everything the founder types, as typed. Converted to base units only when it parses. */
export interface PlanForm {
  chain: 'near' | 'evm';
  symbol: string;
  name: string;
  label: string;
  allocation: string;
  founderAllocation: string;
  listingPrice: string;
  periodPct: string;
  periodDays: string;
  perSalePct: string;
  floorUsd: string;
  slippagePct: string;
  gapMinMinutes: string;
  gapMaxMinutes: string;
  sources: PriceSourceName[];
  agreementPct: string;
  start: string;
  end: string;
  beneficiaryNear: string;
  beneficiaryEvm: string;
  envPerPeriod: string;
  envPerSale: string;
  envMinPrice: string;
  envMinGapMinutes: string;
  envTouched: boolean;
  envSeed: [number, number, number];
  disclosure: 'realtime' | 'delayed' | 'end_reveal';
  delayDays: string;
  coolingValue: string;
  coolingUnit: 'minutes' | 'days';
}

export const DECIMALS = 18;

export const NUM = /^\d+(\.\d+)?$/;
const INT = /^\d+$/;

/** "2.5" percent to basis points (250), or null if it is not a number with ≤ 2 decimals. */
export function pctToBps(v: string): number | null {
  const t = v.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Number(toBaseUnits(t, 2));
}

export function wholeTokens(v: string, decimals = DECIMALS): bigint | null {
  const t = v.trim().replaceAll(',', '');
  if (!NUM.test(t)) return null;
  try {
    return toBaseUnits(t, decimals);
  } catch {
    return null;
  }
}

export const usdE6 = (v: string): bigint | null => {
  const t = v.trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(t)) return null;
  return toBaseUnits(t, 6);
};

/** datetime-local text to ms in the browser's zone. */
export const localToMs = (v: string): number => (v ? new Date(v).getTime() : Number.NaN);

export function msToLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A new NEAR token's account: a sub-account of the world's root, which creates it at launch. */
export const tokenAddressFor = (symbol: string, root: string) => `${symbol.toLowerCase()}.${root}`;

export type Errors = Partial<Record<keyof PlanForm, string>>;

export function tokenErrors(f: PlanForm): Errors {
  const e: Errors = {};
  if (!/^[A-Z0-9]{2,8}$/.test(f.symbol)) e.symbol = 'Use 2 to 8 capital letters or digits';
  if (f.name.trim().length < 2 || f.name.trim().length > 40) e.name = 'Use 2 to 40 characters';
  if (!f.label.trim() || f.label.trim().length > 80) e.label = 'Use 1 to 80 characters';
  const a = wholeTokens(f.allocation);
  if (a === null || a === 0n) e.allocation = 'Enter a whole number of tokens above zero';
  if (wholeTokens(f.founderAllocation) === null)
    e.founderAllocation = 'Enter a number of tokens (0 is fine)';
  if (usdE6(f.listingPrice) === null || usdE6(f.listingPrice) === 0n)
    e.listingPrice = 'Enter a price like 2.40';
  return e;
}

export function termsErrors(f: PlanForm, chainNow: number | null, lockDates: boolean): Errors {
  const e: Errors = {};
  const per = pctToBps(f.periodPct);
  const sale = pctToBps(f.perSalePct);
  if (per === null || per < 1 || per > 10_000) e.periodPct = 'Enter 0.01 to 100';
  if (sale === null || sale < 1 || sale > 10_000) e.perSalePct = 'Enter 0.01 to 100';
  else if (per !== null && sale > per) e.perSalePct = 'A sale cannot exceed the per-period limit';
  if (!INT.test(f.periodDays) || Number(f.periodDays) < 1 || Number(f.periodDays) > 365)
    e.periodDays = 'Enter 1 to 365 days';
  if (usdE6(f.floorUsd) === null || usdE6(f.floorUsd) === 0n)
    e.floorUsd = 'Enter a price like 1.50';
  const slip = pctToBps(f.slippagePct);
  if (slip === null || slip < 1 || slip > 1000) e.slippagePct = 'Enter 0.01 to 10';
  const gmin = Number(f.gapMinMinutes);
  const gmax = Number(f.gapMaxMinutes);
  if (!INT.test(f.gapMinMinutes) || gmin > 525_600) e.gapMinMinutes = 'Enter whole minutes';
  if (!INT.test(f.gapMaxMinutes) || gmax < 1 || gmax > 525_600)
    e.gapMaxMinutes = 'Enter whole minutes, at least 1';
  else if (!e.gapMinMinutes && gmin > gmax)
    e.gapMaxMinutes = 'The longest gap must be at least the shortest';
  if (f.sources.length < 2) e.sources = 'Pick at least two independent sources';
  const agree = pctToBps(f.agreementPct);
  if (agree === null || agree < 1 || agree > 2000) e.agreementPct = 'Enter 0.01 to 20';
  const s = localToMs(f.start);
  const en = localToMs(f.end);
  if (Number.isNaN(s)) e.start = 'Pick a start time';
  else if (!lockDates && chainNow && s < chainNow + 30_000)
    e.start = 'Start at least a minute from now (chain time)';
  if (Number.isNaN(en)) e.end = 'Pick an end time';
  else if (!Number.isNaN(s) && en <= s) e.end = 'The plan must end after it starts';
  if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(f.beneficiaryNear))
    e.beneficiaryNear = 'Not a NEAR account id';
  if (f.chain === 'evm' && !/^0x[0-9a-fA-F]{40}$/.test(f.beneficiaryEvm.trim()))
    e.beneficiaryEvm = 'An EVM token needs an EVM address for the end-of-plan release';
  else if (f.beneficiaryEvm.trim() && !/^0x[0-9a-fA-F]{40}$/.test(f.beneficiaryEvm.trim()))
    e.beneficiaryEvm = 'Not an EVM address';
  return e;
}

export function envelopeErrors(f: PlanForm): Errors {
  const e: Errors = {};
  const p = wholeTokens(f.envPerPeriod);
  const s = wholeTokens(f.envPerSale);
  if (p === null || p === 0n) e.envPerPeriod = 'Enter a token amount above zero';
  if (s === null || s === 0n) e.envPerSale = 'Enter a token amount above zero';
  if (usdE6(f.envMinPrice) === null) e.envMinPrice = 'Enter a price like 1.00';
  if (!/^\d+(\.\d{1,2})?$/.test(f.envMinGapMinutes)) e.envMinGapMinutes = 'Enter minutes';
  return e;
}

export function disclosureErrors(f: PlanForm, minCoolingMs: number): Errors {
  const e: Errors = {};
  if (f.disclosure === 'delayed' && (!INT.test(f.delayDays) || Number(f.delayDays) > 365))
    e.delayDays = 'Enter 0 to 365 days';
  const ms = coolingMs(f);
  if (ms === null) e.coolingValue = 'Enter a whole number';
  else if (ms < minCoolingMs)
    e.coolingValue = `The registry requires at least ${Math.round(minCoolingMs / 60_000)} minutes`;
  return e;
}

export function coolingMs(f: PlanForm): number | null {
  if (!INT.test(f.coolingValue)) return null;
  return Number(f.coolingValue) * (f.coolingUnit === 'days' ? DAY_MS : 60_000);
}

export type TokenRef =
  | { chain: 'near'; address: string; symbol: string; decimals: number }
  | { chain: 'evm'; chain_id: number; address: string; symbol: string; decimals: number };

/** The sealed plan, if every field parses; otherwise null. */
export function buildPlan(
  f: PlanForm,
  token: TokenRef,
  proceedsAsset: string,
): ReturnType<typeof SealedPlan.parse> | null {
  const allocation = wholeTokens(f.allocation);
  const s = localToMs(f.start);
  const en = localToMs(f.end);
  if (allocation === null || Number.isNaN(s) || Number.isNaN(en)) return null;
  const input: SealedPlanInput = {
    version: 1,
    token,
    beneficiary: {
      near_account: f.beneficiaryNear,
      ...(f.beneficiaryEvm.trim() ? { evm_address: f.beneficiaryEvm.trim() } : {}),
      asset: proceedsAsset,
    },
    allocation: allocation.toString(),
    period_days: Number(f.periodDays),
    max_sell_per_period_bps: pctToBps(f.periodPct) ?? 0,
    max_sell_per_tx_bps: pctToBps(f.perSalePct) ?? 0,
    price_floor_usd: f.floorUsd.trim(),
    max_slippage_bps: pctToBps(f.slippagePct) ?? 0,
    venues: ['1click'],
    schedule: {
      mode: 'randomized',
      min_gap_minutes: Number(f.gapMinMinutes),
      max_gap_minutes: Number(f.gapMaxMinutes),
    },
    start: new Date(s).toISOString(),
    end: new Date(en).toISOString(),
    on_end: 'release_remaining_to_beneficiary',
    price_sources: PRICE_SOURCES.filter((x) => f.sources.includes(x)),
    price_agreement_bps: pctToBps(f.agreementPct) ?? 0,
  };
  const parsed = SealedPlan.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function buildEnvelope(f: PlanForm): Envelope | null {
  const p = wholeTokens(f.envPerPeriod);
  const s = wholeTokens(f.envPerSale);
  const price = usdE6(f.envMinPrice);
  if (p === null || s === null || price === null || !/^\d+(\.\d{1,2})?$/.test(f.envMinGapMinutes))
    return null;
  return {
    period_ms: Number(f.periodDays) * DAY_MS,
    max_amount_per_period: p,
    max_amount_per_tx: s,
    min_price_usd_e6: price,
    min_gap_ms: Math.round(Number(f.envMinGapMinutes) * 60_000),
  };
}

const trimDecimal = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

/** Whole-token text for a base-unit amount, without grouping (for inputs). */
export function plainTokens(v: bigint, decimals = DECIMALS): string {
  const s = v.toString().padStart(decimals + 1, '0');
  return trimDecimal(`${s.slice(0, -decimals)}.${s.slice(-decimals)}`);
}

/** Three random draws in [0, 1), fixed per draft so the suggestion does not jump while typing. */
export const newEnvelopeSeed = (): [number, number, number] => {
  const r = crypto.getRandomValues(new Uint32Array(3));
  return [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0].map((n) => n / 2 ** 32) as [number, number, number];
};

/** The smallest of 1, 2, 2.5 or 5 × 10^k that is at least x (x > 0, in whole tokens). */
function roundUpNice(x: bigint): bigint {
  if (x <= 1n) return 1n;
  for (let p = 1n; ; p *= 10n)
    for (const [m, d] of [
      [1n, 1n],
      [2n, 1n],
      [5n, 2n],
      [5n, 1n],
    ] as const) {
      const v = (p * m) / d;
      if ((p * m) % d === 0n && v >= x) return v;
    }
}

/** A price rounded down to a round step: $1 above $10, 25 cents above $1, 5 cents above 10 cents. */
function roundDownPriceE6(p: bigint): bigint {
  const step =
    p >= 10_000_000n ? 1_000_000n : p >= 1_000_000n ? 250_000n : p >= 100_000n ? 50_000n : 10_000n;
  const v = (p / step) * step;
  return v > 0n ? v : step;
}

/** Whole tokens of a base-unit amount, rounded up. */
const ceilTokens = (v: bigint, decimals: number) => {
  const unit = 10n ** BigInt(decimals);
  return (v + unit - 1n) / unit;
};

/**
 * A suggested public envelope that gives the sealed plan away as little as possible: fixed
 * multipliers could simply be divided out, so each bound gets random slack and is then rounded to a
 * round figure. Caps are 1.5–3× the sealed limit, rounded up (never above the allocation); the floor
 * is 50–80% of the sealed floor, rounded down; the gap is at most the sealed gap, rounded down.
 */
export function suggestEnvelope(f: PlanForm): Partial<PlanForm> {
  const allocation = wholeTokens(f.allocation);
  const per = pctToBps(f.periodPct);
  const sale = pctToBps(f.perSalePct);
  const floor = usdE6(f.floorUsd);
  const [a, b, c] = f.envSeed;
  const out: Partial<PlanForm> = {};
  const cap = (bps: number, draw: number) => {
    if (allocation === null) return '';
    const perMille = BigInt(1500 + Math.floor(draw * 1500));
    const loose = (allocation * BigInt(bps) * perMille) / 10_000_000n;
    const nice = roundUpNice(ceilTokens(loose, DECIMALS)) * 10n ** BigInt(DECIMALS);
    return plainTokens(minBig(nice, allocation));
  };
  if (per !== null) out.envPerPeriod = cap(per, a);
  if (sale !== null) out.envPerSale = cap(sale, b);
  if (floor !== null) {
    const perMille = BigInt(500 + Math.floor(c * 300));
    out.envMinPrice = plainTokens(roundDownPriceE6((floor * perMille) / 1000n), 6);
  }
  if (/^\d+$/.test(f.gapMinMinutes)) {
    const gap = Number(f.gapMinMinutes);
    out.envMinGapMinutes = String(
      gap >= 120 ? Math.floor(gap / 60) * 60 : gap >= 10 ? Math.floor(gap / 5) * 5 : gap,
    );
  }
  return out;
}

/** Form fields from a sealed plan, for a change that starts from the founder's backup. */
export function formFromPlan(p: ReturnType<typeof SealedPlan.parse>): Partial<PlanForm> {
  const pct = (bps: number) => trimDecimal((bps / 100).toFixed(2));
  return {
    allocation: plainTokens(p.allocation, p.token.decimals),
    periodPct: pct(p.max_sell_per_period_bps),
    periodDays: String(p.period_days),
    perSalePct: pct(p.max_sell_per_tx_bps),
    floorUsd: p.price_floor_usd,
    slippagePct: pct(p.max_slippage_bps),
    gapMinMinutes: String(p.schedule.min_gap_minutes),
    gapMaxMinutes: String(p.schedule.max_gap_minutes),
    sources: [...p.price_sources],
    agreementPct: pct(p.price_agreement_bps),
  };
}

/** Plain warnings about a plan that is valid but probably not what the founder meant. */
export function planWarnings(f: PlanForm): string[] {
  const out: string[] = [];
  const floor = usdE6(f.floorUsd);
  const listing = usdE6(f.listingPrice);
  if (floor !== null && listing !== null && listing > 0n && floor > listing)
    out.push(
      `The floor ($${f.floorUsd}) is above the listing price ($${f.listingPrice}). Until the price rises past the floor, this plan sells nothing.`,
    );
  const per = pctToBps(f.periodPct);
  const sale = pctToBps(f.perSalePct);
  const gmin = Number(f.gapMinMinutes);
  const gmax = Number(f.gapMaxMinutes);
  const days = Number(f.periodDays);
  if (per && sale && sale > 0 && gmax >= gmin && days > 0) {
    const sales = Math.ceil(per / sale);
    const minutes = sales * ((gmin + gmax) / 2);
    if (minutes < (days * 1440) / 10)
      out.push(
        `At these gaps the whole period budget (about ${sales} sales) is used in about ${minutes < 120 ? `${Math.round(minutes)} minutes` : `${Math.round(minutes / 60)} hours`}; then sales stop until the next period. Longer gaps spread selling more evenly.`,
      );
  }
  return out;
}
