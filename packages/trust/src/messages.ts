import type { TrustEnvelope } from './mandate.ts';

/** Domain prefixes the trust contract verifies; distinct from the plan registry's. */
export const TRUST_ACK_DOMAIN = 'glidepath/trust-ack/v1\n';
export const TRUST_TRADE_DOMAIN = 'glidepath/trust-trade/v1\n';
/** A signed trade is good for five minutes: a run and the relay take seconds to tens of seconds. */
export const TRUST_REQUEST_TTL_MS = 300_000;
/** 1Click is asked to settle within ten minutes. */
export const TRUST_QUOTE_DEADLINE_MS = 600_000;
/** A decided trade must be quoted within this long, or it is decided again. */
export const TRUST_PENDING_TTL_MS = 300_000;
/** The contract's `MIN_TRADE_USD_E6`: no trade under $10 of 1Click's signed input value. */
export const TRUST_MIN_TRADE_USD_E6 = 10_000_000n;
/** The contract's `TRUST_COST_MAX_BPS`: a quote may cost at most 0.5% of its input, nothing flat. */
export const TRUST_COST_MAX_BPS = 50n;
/** The contract's `MIN_GAP_MS`: trades at least a minute apart. */
export const TRUST_MIN_GAP_MS = 60_000;
/** The contract's `MAX_SLIPPAGE_BPS`: minAmountOut may sit at most 1% under amountOut. */
export const TRUST_MAX_SLIPPAGE_BPS = 100;

export interface TrustAck {
  type: 'trust_ack';
  trust_id: number;
  commitment: string;
  envelope: TrustEnvelope;
  beneficiary: string;
  end_ms: number;
  trust_account: string;
  within_envelope: true;
  issued_at_ms: number;
}

/** The enclave's yes/no statements about a trade. No amounts, no holdings. */
export interface TradeAttestation {
  within_mandate: boolean;
  not_excluded: boolean;
  within_turnover: boolean;
}

export const ATTESTATION_LABELS: Record<keyof TradeAttestation, string> = {
  within_mandate: 'Within the sealed mandate (the enclave’s signed word)',
  not_excluded: 'Not into an excluded asset or sector',
  within_turnover: 'Within the turnover cap',
};

export interface TradeRequest {
  trust_id: number;
  seq: number;
  commitment: string;
  origin_token: string;
  amount: string;
  settlement: {
    venue: '1click';
    correlation_id: string;
    deposit_address: string;
    quote: { payload: string; signature: string };
  };
  attestation: TradeAttestation;
  issued_at_ms: number;
  expires_at_ms: number;
}

/** A trust as the contract's `get_trust` returns it. */
export interface ChainTrust {
  id: number;
  owner: string;
  commitment: string;
  envelope: TrustEnvelope;
  beneficiary: string;
  trust_account: string;
  cooling_off_ms: number;
  start_ms: number;
  end_ms: number;
  status: 'awaiting_ack' | 'active' | 'ended';
  created_at_ms: number;
  acked_at_ms: number | null;
  acked_by: string | null;
  holdings: string[];
  next_seq: number;
  period_index: number;
  turnover_in_period_usd_e6: string;
  last_trade_ms: number | null;
  pending_change: {
    kind: 'envelope' | 'cancel';
    envelope: TrustEnvelope | null;
    requested_at_ms: number;
    effective_at_ms: number;
  } | null;
  ended_at_ms: number | null;
  label: string;
}

export interface ChainTrustReceipt {
  trust_id: number;
  seq: number;
  kind: 'trade' | 'release';
  commitment: string;
  period_index: number;
  token: string;
  amount: string;
  receiver: string;
  destination_asset: string | null;
  turnover_usd_e6: string;
  action_hash: string;
  request_json: string | null;
  signature: string | null;
  enclave_key: string | null;
  quote_signer: string | null;
  /** The trade added the bought token to the holdings (removed again if it failed). */
  added_holding: boolean;
  status: 'pending' | 'done' | 'failed';
  created_at_ms: number;
  finished_at_ms: number | null;
}

/** The JSON the trust account's ft_transfer carries; its sha256 is the receipt's action hash. */
export const trustActionJson = (receiver: string, amount: string, trustId: number, seq: number) =>
  JSON.stringify({ receiver_id: receiver, amount, memo: `glidepath/trust/${trustId}/${seq}` });
