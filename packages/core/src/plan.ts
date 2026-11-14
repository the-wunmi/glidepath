import { z } from 'zod';
import {
  bytesToHex,
  canonicalJson,
  concatBytes,
  hexToBytes,
  sha256Hex,
  utf8ToBytes,
} from './encoding.ts';
import { bpsOfDown, formatAmount, TokenAmount, UsdDecimal, usdToE6 } from './units.ts';

/** NEAR account ids: 2–64 chars of lowercase, digits and separators (protocol rule). */
export const AccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, 'Not a NEAR account id');

export const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Not an EVM address')
  .transform((v) => v.toLowerCase());

export const Hex32 = z.string().regex(/^[0-9a-f]{64}$/, 'Expected 32 bytes of lowercase hex');

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

/** Where the plan's tokens live: a NEP-141 on NEAR, or an ERC-20 on an EVM chain via Chain Signatures. */
export const PlanToken = z.discriminatedUnion('chain', [
  z.object({
    chain: z.literal('near'),
    address: AccountId,
    symbol: z.string().min(1).max(12),
    decimals: z.int().min(0).max(24),
  }),
  z.object({
    chain: z.literal('evm'),
    chain_id: z.int().positive(),
    address: EvmAddress,
    symbol: z.string().min(1).max(12),
    decimals: z.int().min(0).max(24),
  }),
]);
export type PlanToken = z.infer<typeof PlanToken>;

export const PRICE_SOURCES = ['1click_quote', 'binance', 'coinbase'] as const;
export type PriceSourceName = (typeof PRICE_SOURCES)[number];

/**
 * The sealed plan. Never published in plaintext unless revealed after it ends; only
 * sha256(canonical_json(plan) ‖ salt) goes on-chain. Field names are part of the published
 * format, so they stay snake_case.
 */
export const SealedPlan = z.object({
  version: z.literal(1),
  token: PlanToken,
  beneficiary: z.object({
    near_account: AccountId,
    evm_address: EvmAddress.optional(),
    asset: z.string().min(1).max(128),
  }),
  /** The enrolled allocation that percentage limits refer to, in token base units. */
  allocation: TokenAmount,
  period_days: z.int().min(1).max(365),
  max_sell_per_period_bps: z.int().min(1).max(10_000),
  max_sell_per_tx_bps: z.int().min(1).max(10_000),
  price_floor_usd: UsdDecimal,
  /** 1Click's slippageTolerance is in basis points; 10% is far beyond any sane plan. */
  max_slippage_bps: z.int().min(1).max(1_000),
  venues: z.array(z.literal('1click')).min(1),
  schedule: z.object({
    mode: z.literal('randomized'),
    min_gap_minutes: z.int().min(0).max(525_600),
    max_gap_minutes: z.int().min(1).max(525_600),
  }),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  on_end: z.literal('release_remaining_to_beneficiary'),
  price_sources: z.array(z.enum(PRICE_SOURCES)).min(2),
  /** How far apart independent prices may be before the enclave refuses to sell. */
  price_agreement_bps: z.int().min(1).max(2_000),
});
export type SealedPlan = z.output<typeof SealedPlan>;
export type SealedPlanInput = z.input<typeof SealedPlan>;

/**
 * The public bounds the contract enforces on every sale, whatever the enclave says. The sealed
 * plan must sit inside them. Amounts are absolute so the contract needs no price or balance oracle.
 */
export const Envelope = z.object({
  period_ms: z.int().positive(),
  max_amount_per_period: TokenAmount,
  max_amount_per_tx: TokenAmount,
  min_price_usd_e6: TokenAmount,
  min_gap_ms: z.int().min(0),
});
export type Envelope = z.output<typeof Envelope>;

/** The envelope as the contract's JSON (big integers as strings, contract field order). */
export const envelopeJson = (e: Envelope) => ({
  period_ms: e.period_ms,
  max_amount_per_period: e.max_amount_per_period.toString(),
  max_amount_per_tx: e.max_amount_per_tx.toString(),
  min_price_usd_e6: e.min_price_usd_e6.toString(),
  min_gap_ms: e.min_gap_ms,
});
export type EnvelopeJson = ReturnType<typeof envelopeJson>;

export const sameEnvelope = (a: Envelope, b: Envelope): boolean =>
  canonicalJson(envelopeJson(a)) === canonicalJson(envelopeJson(b));

/** Limits that follow from the sealed plan, in base units and milliseconds. */
export function planLimits(plan: SealedPlan) {
  return {
    periodMs: plan.period_days * DAY_MS,
    perPeriod: bpsOfDown(plan.allocation, plan.max_sell_per_period_bps),
    perTx: bpsOfDown(plan.allocation, plan.max_sell_per_tx_bps),
    floorE6: usdToE6(plan.price_floor_usd),
    minGapMs: plan.schedule.min_gap_minutes * MINUTE_MS,
    maxGapMs: plan.schedule.max_gap_minutes * MINUTE_MS,
    startMs: Date.parse(plan.start),
    endMs: Date.parse(plan.end),
  };
}
export type PlanLimits = ReturnType<typeof planLimits>;

export type EnvelopeCheck = { rule: string; ok: boolean };

/**
 * Whether the sealed plan sits inside the public envelope. The enclave runs this before it acks,
 * and its signed ack says only "within: yes", never the values.
 */
export function checkWithinEnvelope(plan: SealedPlan, envelope: Envelope): EnvelopeCheck[] {
  const l = planLimits(plan);
  return [
    { rule: 'Same period length', ok: l.periodMs === envelope.period_ms },
    {
      rule: 'Per-period limit within the public cap',
      ok: l.perPeriod <= envelope.max_amount_per_period,
    },
    { rule: 'Per-sale limit within the public cap', ok: l.perTx <= envelope.max_amount_per_tx },
    {
      rule: 'Price floor at or above the public floor',
      ok: l.floorE6 >= envelope.min_price_usd_e6,
    },
    {
      rule: 'Gap between sales at least the public minimum',
      ok: l.minGapMs >= envelope.min_gap_ms,
    },
  ];
}

export const isWithinEnvelope = (plan: SealedPlan, envelope: Envelope): boolean =>
  checkWithinEnvelope(plan, envelope).every((c) => c.ok);

/** Structural rules zod cannot express on single fields. Empty when the plan is coherent. */
export function planProblems(plan: SealedPlan): string[] {
  const l = planLimits(plan);
  const problems: string[] = [];
  if (!(l.endMs > l.startMs)) problems.push('The plan must end after it starts');
  if (plan.max_sell_per_tx_bps > plan.max_sell_per_period_bps)
    problems.push('A single sale cannot be larger than the per-period limit');
  if (plan.schedule.min_gap_minutes > plan.schedule.max_gap_minutes)
    problems.push('The shortest gap between sales cannot be longer than the longest');
  if (l.perTx === 0n) problems.push('The per-sale limit rounds to zero tokens');
  if (plan.token.chain === 'evm' && !plan.beneficiary.evm_address)
    problems.push('An EVM token needs a beneficiary EVM address for the end-of-plan release');
  return problems;
}

/** The salted commitment published on-chain: hex sha256(canonical_json(plan) ‖ salt). */
export function planCommitment(plan: SealedPlan, saltHex: string): string {
  const salt = hexToBytes(saltHex);
  if (salt.length !== 32) throw new Error('Salt must be 32 bytes');
  return sha256Hex(concatBytes(utf8ToBytes(canonicalJson(plan)), salt));
}

export const newSaltHex = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
const day = (iso: string) => iso.slice(0, 10);
/** A plan's start and end: dates, or UTC times as well when both fall on the same day. */
const span = (start: string, end: string): [string, string] =>
  day(start) === day(end)
    ? [`${start.slice(0, 16).replace('T', ' ')} UTC`, `${end.slice(0, 16).replace('T', ' ')} UTC`]
    : [day(start), day(end)];

export function gapText(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0)
    return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function periodText(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} day${ms === DAY_MS ? '' : 's'}`;
  // Never round a public bound up: 30 s must not read as "1 minute".
  if (ms % MINUTE_MS !== 0) return `${Math.floor(ms / 1000)} seconds`;
  return gapText(ms / MINUTE_MS);
}

/** The plain-English preview the founder reads before sealing. Every line comes from a field. */
export function describePlan(plan: SealedPlan): string[] {
  const l = planLimits(plan);
  const sym = plan.token.symbol;
  const d = plan.token.decimals;
  const [from, to] = span(plan.start, plan.end);
  return [
    `Sell at most ${pct(plan.max_sell_per_period_bps)} of the ${formatAmount(plan.allocation, d)} ${sym} allocation every ${plan.period_days} days (${formatAmount(l.perPeriod, d)} ${sym}).`,
    `No single sale is larger than ${formatAmount(l.perTx, d)} ${sym} (${pct(plan.max_sell_per_tx_bps)}).`,
    `Never sell below $${plan.price_floor_usd} per ${sym}, and accept at most ${pct(plan.max_slippage_bps)} slippage.`,
    `Sales happen at random times, ${gapText(plan.schedule.min_gap_minutes)} to ${gapText(plan.schedule.max_gap_minutes)} apart.`,
    `Prices from ${plan.price_sources.join(', ')} must agree within ${pct(plan.price_agreement_bps)}, or the sale waits.`,
    `Proceeds go to ${plan.beneficiary.near_account} as ${plan.beneficiary.asset}.`,
    `Runs from ${from} to ${to}; anything left then goes to the beneficiary.`,
  ];
}

/** Plain-English lines for the public envelope, shown to holders. */
export function describeEnvelope(e: Envelope, symbol: string, decimals: number): string[] {
  return [
    `At most ${formatAmount(e.max_amount_per_period, decimals)} ${symbol} sold every ${periodText(e.period_ms)}.`,
    `No single sale above ${formatAmount(e.max_amount_per_tx, decimals)} ${symbol}.`,
    `No sale guaranteed less than $${formatAmount(e.min_price_usd_e6, 6, 6)} per ${symbol}.`,
    e.min_gap_ms > 0
      ? `At least ${periodText(e.min_gap_ms)} between sales.`
      : 'No minimum gap between sales.',
  ];
}
