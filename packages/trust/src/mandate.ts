import {
  AccountId,
  bytesToHex,
  canonicalJson,
  concatBytes,
  hexToBytes,
  parseInput,
  sha256Hex,
  UsdDecimal,
  usdToE6,
  utf8ToBytes,
} from '@glidepath/core';
import { z } from 'zod';

/**
 * The blind trust's sealed mandate and public envelope. The official writes the mandate in the
 * browser, which seals it to the attested enclave key; after that only the enclave can read it.
 * The envelope is public and enforced by the trust contract (contracts/blind-trust) on every trade.
 */

/** A diversified mandate fits in a dozen assets; the contract holds at most 12 tokens. */
export const MAX_MANDATE_ASSETS = 12;
/** The contract's cap on the public exclusion list. */
export const MAX_EXCLUDED_ASSETS = 32;

/** 1Click's id for a NEAR token, `nep141:<account>`: the form quotes and the contract use. */
export const AssetId = z
  .string()
  .max(128)
  .refine((v) => v.startsWith('nep141:') && AccountId.safeParse(v.slice(7)).success, {
    message: 'Expected nep141:<NEAR account>',
  });

/** A sector label such as "energy" or "defi". */
export const Sector = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'Use a short lowercase sector name');

export const TrustMandate = z.object({
  version: z.literal(1),
  /** Every asset the trust may hold, each tagged with its sector. */
  universe: z
    .array(z.object({ asset: AssetId, sector: Sector }))
    .min(1)
    .max(MAX_MANDATE_ASSETS),
  /** Sectors the trust must never buy, e.g. the one the official regulates. */
  excluded_sectors: z.array(Sector).max(MAX_MANDATE_ASSETS),
  /** Target weights in basis points; they add up to 10,000. */
  targets: z
    .array(z.object({ asset: AssetId, weight_bps: z.int().min(1).max(10_000) }))
    .min(1)
    .max(MAX_MANDATE_ASSETS),
  /** Rebalance only when a holding is further than this from its target (share of the total). */
  band_bps: z.int().min(1).max(5_000),
  /** Size limits of a single trade, in USD. */
  max_trade_usd: UsdDecimal,
  min_trade_usd: UsdDecimal,
  /** Public facts the mandate must agree with, so a box cannot be replayed onto another trust. */
  beneficiary: AccountId,
  end: z.iso.datetime(),
});
export type TrustMandate = z.output<typeof TrustMandate>;
export type TrustMandateInput = z.input<typeof TrustMandate>;

export const parseMandate = (input: unknown): TrustMandate => parseInput(TrustMandate, input);

/** The contract's public envelope, in its JSON form (amounts as decimal strings). */
export const TrustEnvelope = z.object({
  excluded_assets: z.array(AssetId).max(MAX_EXCLUDED_ASSETS),
  period_ms: z.int().min(1),
  max_turnover_usd_e6: z.string().regex(/^\d{1,30}$/),
  min_gap_ms: z.int().min(0),
});
export type TrustEnvelope = z.output<typeof TrustEnvelope>;

/** Key order as the contract serialises it, so an ack carries the envelope the way it reads. */
export const envelopeOrdered = (e: TrustEnvelope): TrustEnvelope => ({
  excluded_assets: e.excluded_assets,
  period_ms: e.period_ms,
  max_turnover_usd_e6: e.max_turnover_usd_e6,
  min_gap_ms: e.min_gap_ms,
});

/**
 * Rules the schema cannot express on single fields. The texts are part of the enclave's output
 * and are produced identically by the Rust module (enclave-wasi/src/trust.rs).
 */
export function mandateProblems(m: TrustMandate): string[] {
  const problems: string[] = [];
  const weights = m.targets.reduce((sum, t) => sum + t.weight_bps, 0);
  if (weights !== 10_000) problems.push('Target weights must add up to 100%');
  const universe = m.universe.map((u) => u.asset);
  const targets = m.targets.map((t) => t.asset);
  if (new Set(universe).size !== universe.length || new Set(targets).size !== targets.length)
    problems.push('An asset appears twice');
  if (!targets.every((a) => universe.includes(a)))
    problems.push('Every target must be in the allowed universe');
  const excluded = new Set(m.excluded_sectors);
  if (m.universe.some((u) => targets.includes(u.asset) && excluded.has(u.sector)))
    problems.push('A target is in an excluded sector');
  const max = usdToE6(m.max_trade_usd);
  if (usdToE6(m.min_trade_usd) > max)
    problems.push('The smallest trade cannot be larger than the largest');
  if (max === 0n) problems.push('The largest trade must be above zero');
  return problems;
}

export type EnvelopeCheck = { rule: string; ok: boolean };

/** Whether the sealed mandate sits inside the public envelope; yes or no per rule, nothing else. */
export function checkMandateEnvelope(m: TrustMandate, e: TrustEnvelope): EnvelopeCheck[] {
  return [
    {
      rule: 'No target is on the public exclusion list',
      ok: m.targets.every((t) => !e.excluded_assets.includes(t.asset)),
    },
    {
      rule: 'The largest trade fits the turnover cap',
      ok: usdToE6(m.max_trade_usd) <= BigInt(e.max_turnover_usd_e6),
    },
  ];
}

/** The salted commitment published on-chain: hex sha256(canonical_json(mandate) ‖ salt). */
export function mandateCommitment(m: TrustMandate, saltHex: string): string {
  const salt = hexToBytes(saltHex);
  if (salt.length !== 32) throw new Error('Salt must be 32 bytes');
  return sha256Hex(concatBytes(utf8ToBytes(canonicalJson(m)), salt));
}

export const newTrustSalt = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

/** The token account behind a `nep141:` asset id. */
export const tokenOf = (asset: string): string => asset.replace(/^nep141:/, '');

/** The JSON the browser seals to the enclave: `{mandate, salt}`, the mandate in canonical form. */
export const sealedMandateJson = (mandate: TrustMandate, salt: string): string =>
  JSON.stringify({ mandate: JSON.parse(canonicalJson(mandate)), salt });
