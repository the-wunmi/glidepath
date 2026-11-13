import { describeEnvelope, type Envelope, type EnvelopeJson } from '@vsp/core';
import { fmtDate } from './format';

/** The registry's and plan account's refusal codes, in one plain sentence each. */
const REFUSALS: Record<string, string> = {
  only_registry: 'Only the registry can move these tokens.',
  no_access_key: 'The account has no key, so no transaction can be signed for it.',
  only_owner: 'Only the plan’s owner can do this.',
  cooling_off: 'A change is still cooling off; it cannot act yet.',
  change_pending: 'A change or cancellation is already pending.',
  no_pending_change: 'There is no pending change to withdraw.',
  not_active: 'The plan is not active.',
  not_ended: 'The plan has not ended and no cancellation is in force yet.',
  not_started: 'The plan has not started yet.',
  plan_ended: 'The plan has already ended.',
  paused: 'The registry is paused by governance.',
  not_compliant: 'The sale falls outside the public envelope.',
  envelope_mismatch: 'The sealed plan does not fit the public envelope.',
  commitment_mismatch: 'The commitment does not match.',
  unknown_enclave: 'The signing key is not on the registry’s allowlist.',
  enclave_revoked: 'The signing key has been revoked.',
  bad_quote: 'The 1Click quote is malformed or missing a field the registry binds.',
  bad_quote_signature: 'The 1Click quote is not signed by the registered quote key.',
  quote_mismatch: 'The 1Click quote does not match this sale, beneficiary or plan.',
  quote_fee_too_high: 'The 1Click quote costs more than 0.5% + $1 of its value in fees.',
  quote_used: 'This 1Click quote was already used for a sale.',
  quote_expired: 'The 1Click quote has expired.',
  quote_deadline_too_far: 'The 1Click quote is valid for more than 7 days.',
  key_too_new_for_plan:
    'This key was registered after the plan and has not yet waited its cooling-off.',
  already_revealed: 'The plan’s terms have already been revealed.',
  wrong_asset: 'The proceeds asset is not the plan’s.',
  bad_seq: 'The request is out of sequence (a replay or a stale request).',
  bad_nonce: 'The EVM nonce is wrong.',
  invalid_times: 'Start and end times are not valid.',
  insufficient_deposit: 'Not enough NEAR was attached for storage.',
  plan_not_found: 'The registry has no such plan.',
  only_governance: 'Only the governance account can do this, and only after a public delay.',
  bad_signature: 'The signature does not match the signed request.',
  tx_cap_exceeded: 'The sale is larger than the public per-sale cap.',
  below_floor: 'The quote’s guaranteed price is under the public floor.',
  receiver_mismatch: 'The tokens must go to the 1Click deposit address named in the quote.',
  cancel_effective: 'The cancellation has taken effect and can no longer be withdrawn.',
  only_owner_or_beneficiary: 'Only the plan’s owner or beneficiary can do this.',
};

export const refusalText = (code: string) => REFUSALS[code] ?? 'The chain refused the transaction.';

const SOURCE_NAMES: Record<string, string> = {
  '1click_quote': '1Click quote',
  binance: 'Binance',
  coinbase: 'Coinbase',
};

/** "1.50%" to "1.5%", "2.00%" to "2%". */
const trimPct = (s: string) =>
  s.replace(/(\d+)\.(\d*?)0+%/g, (_m, a: string, b: string) => (b ? `${a}.${b}%` : `${a}%`));

/**
 * The core package writes previews with ids (1click_quote, nep141:usdc.sandbox) and ISO dates.
 * Holders and founders read plain names, so the UI rewrites them here.
 */
export function plainLines(lines: string[], proceedsAsset?: string): string[] {
  return lines.map((l) => {
    let out = l.replace(/\b(1click_quote|binance|coinbase)\b/g, (m) => SOURCE_NAMES[m] ?? m);
    if (proceedsAsset) out = out.replaceAll(proceedsAsset, 'USDC');
    out = out.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (m) => fmtDate(m));
    out = out.replace(
      /\$(\d[\d,]*)(\.\d+)?(?= )/g,
      (_m, w: string, f?: string) => `$${w}.${(f ?? '.').slice(1).padEnd(2, '0')}`,
    );
    return trimPct(out);
  });
}

export const toEnvelope = (e: EnvelopeJson): Envelope => ({
  period_ms: e.period_ms,
  max_amount_per_period: BigInt(e.max_amount_per_period),
  max_amount_per_tx: BigInt(e.max_amount_per_tx),
  min_price_usd_e6: BigInt(e.min_price_usd_e6),
  min_gap_ms: e.min_gap_ms,
});

export const envelopeLines = (e: Envelope, symbol: string, decimals: number) =>
  plainLines(describeEnvelope(e, symbol, decimals));

/** A sale's ordinal for people: the registry counts from 0. */
export const saleLabel = (seq: number) => (seq === 0 ? 'Sale #0 (first)' : `Sale #${seq}`);
