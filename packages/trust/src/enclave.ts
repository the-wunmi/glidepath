import {
  bytesToHex,
  formatNearKey,
  openSealed,
  parseInput,
  SealedBox,
  sealTo,
  signingBytes,
  toBase64,
  toJson,
} from '@glidepath/core';
import { deriveEnclaveKeys, type SealedStore, type SignedMessage } from '@glidepath/enclave';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { z } from 'zod';
import { type AssetPrice, decideRebalance, type Holding, PUBLIC_HOLD_REASONS } from './decide.ts';
import {
  checkMandateEnvelope,
  envelopeOrdered,
  mandateCommitment,
  mandateProblems,
  TrustMandate,
  tokenOf,
} from './mandate.ts';
import {
  type ChainTrust,
  TRUST_ACK_DOMAIN,
  TRUST_PENDING_TTL_MS,
  TRUST_REQUEST_TTL_MS,
  TRUST_TRADE_DOMAIN,
  type TradeRequest,
} from './messages.ts';
import {
  type PendingTrade,
  tradeAttestation,
  tradeQuoteProblems,
  tradeQuoteRequest,
} from './trade.ts';

/**
 * The trust executor: opens a sealed mandate, decides rebalances, and signs trades the contract
 * checks. Two implementations share these steps: the in-process simulator below (the same keys as
 * the simulated plan enclave) and the enclave-wasi module (`trust_accept`, `trust_tick`,
 * `trust_trade`), the code an OutLayer build would run.
 */
export interface TrustEnclave {
  readonly mode: 'mock' | 'live';
  /** The key that signs acks and trades, as the contract's allowlist holds it. */
  signingKey(): Promise<string>;
  accept(chain: ChainTrust, box: SealedBox, nowMs: number): Promise<TrustAcceptResult>;
  tick(chain: ChainTrust, view: TrustMarketView, nowMs: number): Promise<TrustTickResult>;
  trade(chain: ChainTrust, quote: TrustQuote, nowMs: number): Promise<TrustTradeResult>;
}

/** What the host read for a tick: the trust account's balances and prices. Untrusted input. */
export interface TrustMarketView {
  holdings: Holding[];
  prices: AssetPrice[];
}

export interface TrustQuote {
  payload: string;
  signature: string;
  correlation_id: string;
}

export type TrustAcceptResult = { ok: true; ack: SignedMessage } | { ok: false; reasons: string[] };

export type TrustTickResult =
  | { type: 'idle'; reason: string }
  | { type: 'quote'; seq: number; quoteRequest: ReturnType<typeof tradeQuoteRequest> };

export type TrustTradeResult =
  | { type: 'idle'; reason: string }
  | { type: 'skipped' }
  | { type: 'execute'; seq: number; request: SignedMessage };

const SealedMandate = z.object({
  mandate: TrustMandate,
  salt: z.string().regex(/^[0-9a-f]{64}$/),
});

const TrustRecord = z.object({
  mandate: TrustMandate,
  salt: z.string(),
  commitment: z.string(),
  pending: z
    .object({
      seq: z.int(),
      origin: z.string(),
      destination: z.string(),
      amount: z.string(),
      decided_at_ms: z.int(),
    })
    .nullable(),
  inflight: z.object({ seq: z.int(), expires_at_ms: z.int() }).nullable(),
});
type TrustRecord = z.output<typeof TrustRecord>;

/** Opens a box and checks the mandate against the commitment, the envelope and the public facts. */
export function openMandate(
  secret: Uint8Array,
  chain: ChainTrust,
  box: SealedBox,
): { ok: true; mandate: TrustMandate; salt: string } | { ok: false; reasons: string[] } {
  let opened: z.output<typeof SealedMandate>;
  try {
    opened = parseInput(SealedMandate, JSON.parse(openSealed(secret, parseInput(SealedBox, box))));
  } catch {
    return { ok: false, reasons: ['The sealed mandate could not be opened or read'] };
  }
  const reasons = [...mandateProblems(opened.mandate)];
  if (mandateCommitment(opened.mandate, opened.salt) !== chain.commitment)
    reasons.push('The mandate does not match the on-chain commitment');
  for (const c of checkMandateEnvelope(opened.mandate, chain.envelope))
    if (!c.ok) reasons.push(`Outside the public envelope: ${c.rule}`);
  if (opened.mandate.beneficiary !== chain.beneficiary)
    reasons.push('The beneficiary differs from the contract');
  if (Date.parse(opened.mandate.end) !== chain.end_ms)
    reasons.push('The end differs from the contract');
  return reasons.length ? { ok: false, reasons } : { ok: true, ...opened };
}

/** Whether the chain lets the trust trade at all right now. */
function chainIdleReason(chain: ChainTrust, nowMs: number): string | null {
  if (chain.status !== 'active') return `trust_${chain.status}`;
  const cancel = chain.pending_change;
  if (nowMs >= chain.end_ms || (cancel?.kind === 'cancel' && cancel.effective_at_ms <= nowMs))
    return 'ending';
  return null;
}

/** The simulated trust executor, in-process. Labelled simulated wherever its output is shown. */
export class SimulatedTrustEnclave implements TrustEnclave {
  readonly mode = 'mock' as const;
  private readonly keys: ReturnType<typeof deriveEnclaveKeys>;

  constructor(
    hardwareSecret: Uint8Array,
    private readonly store: SealedStore,
    /** 1Click's quote key, fixed in a real build so the host cannot substitute quotes. */
    private readonly quoteSignerKey: string,
  ) {
    this.keys = deriveEnclaveKeys(hardwareSecret);
  }

  async signingKey(): Promise<string> {
    return formatNearKey('ed25519', ed25519.getPublicKey(this.keys.signing));
  }

  private sign(domain: string, json: string): SignedMessage {
    return {
      json,
      signature: toBase64(ed25519.sign(signingBytes(domain, json), this.keys.signing)),
      enclaveKey: formatNearKey('ed25519', ed25519.getPublicKey(this.keys.signing)),
    };
  }

  private async load(trustId: number): Promise<TrustRecord | null> {
    const box = await this.store.get(`trust:${trustId}`);
    if (!box) return null;
    return parseInput(TrustRecord, JSON.parse(openSealed(this.keys.sealing, box)));
  }

  private async save(trustId: number, record: TrustRecord): Promise<void> {
    const sealingPublic = bytesToHex(x25519.getPublicKey(this.keys.sealing));
    await this.store.put(`trust:${trustId}`, sealTo(sealingPublic, toJson(record)));
  }

  async accept(chain: ChainTrust, box: SealedBox, nowMs: number): Promise<TrustAcceptResult> {
    if (chain.status !== 'awaiting_ack')
      return { ok: false, reasons: ['The trust is not awaiting an ack'] };
    const opened = openMandate(this.keys.encryption, chain, box);
    if (!opened.ok) return opened;
    await this.save(chain.id, {
      mandate: opened.mandate,
      salt: opened.salt,
      commitment: chain.commitment,
      pending: null,
      inflight: null,
    });
    const ack = {
      type: 'trust_ack',
      trust_id: chain.id,
      commitment: chain.commitment,
      envelope: envelopeOrdered(chain.envelope),
      beneficiary: chain.beneficiary,
      end_ms: chain.end_ms,
      trust_account: chain.trust_account,
      within_envelope: true,
      issued_at_ms: nowMs,
    };
    return { ok: true, ack: this.sign(TRUST_ACK_DOMAIN, JSON.stringify(ack)) };
  }

  async tick(chain: ChainTrust, view: TrustMarketView, nowMs: number): Promise<TrustTickResult> {
    const idle = chainIdleReason(chain, nowMs);
    if (idle) return { type: 'idle', reason: idle };
    const record = await this.load(chain.id);
    if (!record || record.commitment !== chain.commitment)
      return { type: 'idle', reason: 'commitment_mismatch' };
    // Settle the last signed trade from the chain, not the host's word.
    if (record.inflight) {
      if (chain.next_seq <= record.inflight.seq && nowMs <= record.inflight.expires_at_ms)
        return { type: 'idle', reason: 'waiting' };
      record.inflight = null;
    }
    record.pending = null;
    const decision = decideRebalance({
      mandate: record.mandate,
      envelope: chain.envelope,
      counters: chain,
      holdings: view.holdings,
      prices: view.prices,
      now_ms: nowMs,
    });
    if (decision.type === 'hold') {
      await this.save(chain.id, record);
      // Hold reasons beyond what the chain shows would hint at the mandate's bands and limits.
      const reason = PUBLIC_HOLD_REASONS.includes(decision.reason) ? decision.reason : 'waiting';
      return { type: 'idle', reason };
    }
    const pending: PendingTrade = {
      seq: chain.next_seq,
      origin: decision.origin,
      destination: decision.destination,
      amount: decision.amount,
      decided_at_ms: nowMs,
    };
    record.pending = pending;
    await this.save(chain.id, record);
    return {
      type: 'quote',
      seq: chain.next_seq,
      quoteRequest: tradeQuoteRequest(chain, pending, nowMs),
    };
  }

  async trade(chain: ChainTrust, quote: TrustQuote, nowMs: number): Promise<TrustTradeResult> {
    const record = await this.load(chain.id);
    const pending = record?.pending;
    if (!record || !pending) return { type: 'idle', reason: 'waiting' };
    record.pending = null;
    const fresh =
      pending.seq === chain.next_seq &&
      nowMs >= pending.decided_at_ms &&
      nowMs - pending.decided_at_ms <= TRUST_PENDING_TTL_MS &&
      chainIdleReason(chain, nowMs) === null &&
      chain.commitment === record.commitment;
    if (!fresh) {
      await this.save(chain.id, record);
      return { type: 'idle', reason: 'waiting' };
    }
    const { problems, terms } = tradeQuoteProblems(
      this.quoteSignerKey,
      chain,
      pending,
      quote,
      nowMs,
    );
    const attestation = terms
      ? tradeAttestation(record.mandate, chain, pending, terms.amountInUsd, nowMs)
      : null;
    if (!terms || !attestation || problems.length || !Object.values(attestation).every(Boolean)) {
      // Why stays inside: it would reveal the mandate's targets and limits.
      await this.save(chain.id, record);
      return { type: 'skipped' };
    }
    const request: TradeRequest = {
      trust_id: chain.id,
      seq: chain.next_seq,
      commitment: record.commitment,
      origin_token: tokenOf(pending.origin),
      amount: pending.amount,
      settlement: {
        venue: '1click',
        correlation_id: quote.correlation_id,
        deposit_address: terms.depositAddress ?? '',
        quote: { payload: quote.payload, signature: quote.signature },
      },
      attestation,
      issued_at_ms: nowMs,
      expires_at_ms: nowMs + TRUST_REQUEST_TTL_MS,
    };
    record.inflight = { seq: chain.next_seq, expires_at_ms: nowMs + TRUST_REQUEST_TTL_MS };
    await this.save(chain.id, record);
    return {
      type: 'execute',
      seq: chain.next_seq,
      request: this.sign(TRUST_TRADE_DOMAIN, JSON.stringify(request)),
    };
  }
}
