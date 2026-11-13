import type { EnvelopeJson } from '@vsp/core';

/** The registry's public view of a plan (contracts/plan-registry, `get_plan`). */
export interface ChainPlan {
  id: number;
  owner: string;
  commitment: string;
  asset:
    | { type: 'nep141'; token_id: string }
    | { type: 'evm_erc20'; chain_id: number; token_address: string };
  token_decimals: number;
  quote_decimals: number;
  beneficiary: { near_account: string; evm_address: string | null };
  /** The asset proceeds must be paid in; 1Click quotes are checked against it on-chain. */
  proceeds_asset: string;
  envelope: EnvelopeJson;
  disclosure: { type: 'realtime' } | { type: 'delayed'; delay_ms: number } | { type: 'end_reveal' };
  cooling_off_ms: number;
  start_ms: number;
  end_ms: number;
  status: 'awaiting_ack' | 'active' | 'ended';
  created_at_ms: number;
  acked_at_ms: number | null;
  acked_by: string | null;
  plan_account: string;
  evm_address: string | null;
  evm_nonce: number;
  /** True while an MPC signature is outstanding; the registry signs one EVM tx at a time. */
  evm_sign_pending: boolean;
  evm_pending_sign: { seq: number; started_block_height: number; resign: boolean } | null;
  next_seq: number;
  period_index: number;
  sold_in_period: string;
  sold_total: string;
  last_sale_ms: number | null;
  pending_change: PendingChange | null;
  receipt_count: number;
  label: string;
}

export interface PendingChange {
  kind: 'modify' | 'cancel';
  commitment: string | null;
  envelope: EnvelopeJson | null;
  requested_at_ms: number;
  effective_at_ms: number;
}

/** The MPC signature as the registry stores it: hex big_r (33-byte compressed R), hex s. */
export interface EvmSignature {
  big_r: string;
  s: string;
  recovery_id: number;
}

/** A receipt as the registry stores it: everything needed to re-verify a sale from chain data. */
export interface ChainReceipt {
  plan_id: number;
  seq: number;
  commitment: string;
  period_index: number;
  kind: 'sale' | 'release';
  amount: string;
  receiver: string;
  action_hash: string;
  /** The exact string the enclave signed; null for end-of-plan releases nobody signs. */
  request_json: string | null;
  signature: string | null;
  enclave_key: string | null;
  settlement: {
    venue: string;
    correlation_id: string;
    deposit_address: string;
    min_amount_out: string;
    destination_asset: string;
    quote: { payload: string; signature: string };
  } | null;
  status: 'pending' | 'done' | 'failed';
  evm_nonce: number | null;
  evm_gas_limit: number | null;
  evm_max_fee_per_gas?: string | null;
  evm_max_priority_fee_per_gas?: string | null;
  /** Block height when the current signature landed; re-signs wait 30 blocks after it. */
  evm_signed_at_block?: number | null;
  /** The 1Click quote key this sale's quote was checked against. */
  quote_signer?: string | null;
  evm_unsigned_tx: string | null;
  evm_signature: EvmSignature | null;
  created_at_ms: number;
  finished_at_ms: number | null;
}

export interface EnclaveMeasurements {
  mrtd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
}

export interface ChainEnclave {
  public_key: string;
  measurements: EnclaveMeasurements;
  quote_hash: string;
  registered_at_ms: number;
  active_from_ms: number;
  revoked_at_ms: number | null;
}

export interface RegistryConfig {
  governance: string;
  signer_contract: string;
  min_cooling_off_ms: number;
  enclave_activation_delay_ms: number;
  plan_account_code_hash: string | null;
  paused: boolean;
  plan_account_funding: string;
  quote_signer: string | null;
  quote_signer_active_from_ms: number | null;
  next_plan_id: number;
}
