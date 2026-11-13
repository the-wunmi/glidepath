import { utf8ToBytes } from './encoding.ts';
import type { EnvelopeJson } from './plan.ts';

/**
 * Messages the enclave signs with its ed25519 key. The contract verifies the signature over
 * DOMAIN ‖ the exact JSON string it receives, so no canonical form is needed: the bytes signed are
 * the bytes stored in the receipt, and anyone can re-check them from chain data alone.
 */
export const ACK_DOMAIN = 'vsp/ack/v1\n';
export const EXECUTE_DOMAIN = 'vsp/execute/v1\n';

/**
 * The registry refuses execute requests longer than this (MAX_EXECUTE_JSON_BYTES in execute.rs), so
 * the enclave never builds one. It carries 1Click's quote message Q, escaped, inside the request.
 */
export const MAX_REQUEST_JSON_BYTES = 8192;

export interface AckMessage {
  type: 'ack';
  plan_id: number;
  commitment: string;
  envelope: EnvelopeJson;
  within_envelope: true;
  issued_at_ms: number;
}

export type ExecuteAction =
  | {
      type: 'nep141_transfer';
      receiver_id: string;
      amount: string;
      register_receiver: boolean;
    }
  | {
      type: 'evm_erc20_transfer';
      to: string;
      amount: string;
      nonce: number;
      gas_limit: number;
      max_fee_per_gas: string;
      max_priority_fee_per_gas: string;
    };

export interface Settlement {
  venue: '1click';
  correlation_id: string;
  deposit_address: string;
  min_amount_out: string;
  destination_asset: string;
  /**
   * The 1Click-signed quote the registry checks, so price and destination are bound on-chain:
   * `payload` is Q, the exact string 1Click signs (oneclick-quote.ts), and `signature` is 1Click's
   * own `ed25519:<base58>` signature over base58(sha256(Q)).
   */
  quote: { payload: string; signature: string };
}

/** Yes/no answers only: a receipt proves compliance without publishing the plan's numbers. */
export interface Compliance {
  within_period_budget: boolean;
  within_tx_cap: boolean;
  above_floor: boolean;
  venue_allowed: boolean;
  prices_agree: boolean;
  schedule_ok: boolean;
}

export const COMPLIANCE_LABELS: Record<keyof Compliance, string> = {
  within_period_budget: 'Within the period budget',
  within_tx_cap: 'Within the per-sale cap',
  above_floor: 'Above the price floor',
  venue_allowed: 'Venue allowed by the plan',
  prices_agree: 'Independent prices agreed',
  schedule_ok: 'At a scheduled time',
};

export interface ExecuteRequest {
  plan_id: number;
  seq: number;
  commitment: string;
  action: ExecuteAction;
  settlement: Settlement;
  compliance: Compliance;
  issued_at_ms: number;
  expires_at_ms: number;
}

export const signingBytes = (domain: string, json: string): Uint8Array =>
  utf8ToBytes(domain + json);
