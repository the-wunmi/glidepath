import type { SealedBox, SimulatedQuote } from '@vsp/core';
import type { ChainPlan, ChainReceipt } from '@vsp/near';
import type { QuoteRequest, QuoteResponse } from '@vsp/oneclick';
import type { PriceObservation } from '@vsp/planner';

/** What the enclave publishes about itself; the verifier checks all of it. */
export interface EnclaveIdentity {
  mode: 'mock' | 'live';
  /** ed25519 key that signs acks and execution requests ("ed25519:<base58>"). */
  signingKey: string;
  /** X25519 key plans are sealed to (hex). */
  encryptionKeyHex: string;
  quote: SimulatedQuote;
  quoteHash: string;
}

/**
 * Everything the enclave asks of the outside world. In OutLayer these are outbound HTTPS calls
 * made from inside the TEE; here the engine provides them. The enclave treats every answer as
 * untrusted input and re-checks it against the chain and the sealed plan.
 */
export interface EnclaveHost {
  chainTimeMs(): Promise<number>;
  planBalance(plan: ChainPlan): Promise<bigint>;
  receipt(planId: number, seq: number): Promise<ChainReceipt | null>;
  prices(symbol: string, sources: string[], atMs: number): Promise<PriceObservation[]>;
  quote(request: QuoteRequest): Promise<QuoteResponse>;
  evmFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

/** Signed output, relayed to the registry by anyone. */
export interface SignedMessage {
  json: string;
  signature: string;
  enclaveKey: string;
}

export type AcceptResult = { ok: true; ack: SignedMessage } | { ok: false; reasons: string[] };

export type RevealResult =
  | { ok: true; planJson: string; salt: string }
  | { ok: false; reason: string };

export type TickResult =
  | { type: 'idle'; reason: string; untilMs: number | null }
  | { type: 'ack_change'; ack: SignedMessage }
  | {
      type: 'execute';
      request: SignedMessage;
      seq: number;
      amount: bigint;
      quote: QuoteResponse;
    }
  | { type: 'skipped'; reasons: string[] };

/** The executor, behind one interface so a live OutLayer worker can replace the simulator. */
export interface Enclave {
  readonly mode: 'mock' | 'live';
  identity(): Promise<EnclaveIdentity>;
  /** Opens a newly sealed plan, checks it against the on-chain commitment and envelope, acks. */
  acceptPlan(plan: ChainPlan, box: SealedBox): Promise<AcceptResult>;
  /** Stores a changed plan; it is acked only once the on-chain cooling-off has passed. */
  stageChange(plan: ChainPlan, box: SealedBox): Promise<{ ok: boolean; reasons: string[] }>;
  /**
   * The sealed terms and salt, released only once the chain shows the plan has ended and only
   * under the end_reveal policy. Anyone can then check them against the on-chain commitment.
   */
  revealPlan(plan: ChainPlan): Promise<RevealResult>;
  /** One wake-up for one plan: maybe a change ack, maybe a signed sale, usually nothing. */
  tick(plan: ChainPlan): Promise<TickResult>;
}
