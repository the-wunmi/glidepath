import { readdirSync, readFileSync } from 'node:fs';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, sha384 } from '@noble/hashes/sha2.js';
import {
  ACK_DOMAIN,
  type AckMessage,
  bytesToHex,
  canonicalJson,
  checkWithinEnvelope,
  DomainError,
  type Envelope,
  Envelope as EnvelopeSchema,
  EXECUTE_DOMAIN,
  type ExecuteAction,
  type ExecuteRequest,
  envelopeJson,
  formatNearKey,
  MAX_REQUEST_JSON_BYTES,
  oneclickQuoteMessage,
  oneclickSignedBytes,
  openSealed,
  parseInput,
  parseNearKey,
  parseQuoteTerms,
  planCommitment,
  planProblems,
  quoteCostWithinBound,
  quoteHash,
  reportDataFor,
  SealedBox,
  SealedPlan,
  SimulatedQuote,
  sealTo,
  signingBytes,
  signSimulatedQuote,
  toBase64,
  toJson,
  utf8ToBytes,
} from '@vsp/core';
import type { ChainPlan } from '@vsp/near';
import type { QuoteRequest, QuoteResponse } from '@vsp/oneclick';
import {
  checkMarket,
  deferSale,
  initialState,
  type PlanState,
  proposeSale,
  type RandomBytes,
  recordSale,
} from '@vsp/planner';
import { z } from 'zod';
import type {
  AcceptResult,
  Enclave,
  EnclaveHost,
  EnclaveIdentity,
  RevealResult,
  SignedMessage,
  TickResult,
} from './types.ts';

/** Untrusted storage on the host. The enclave only ever hands it boxes sealed to itself. */
export interface SealedStore {
  get(key: string): Promise<SealedBox | null>;
  put(key: string, box: SealedBox): Promise<void>;
}

/** A signed request is good for two minutes: long enough to relay, too short to hoard. */
const REQUEST_TTL_MS = 120_000;
/** 1Click quotes are asked to settle within ten minutes of the sale. */
const QUOTE_DEADLINE_MS = 600_000;
/**
 * The registry's cap. Every sale pays a fresh deposit address, and on Sepolia an ERC-20 transfer to
 * a new holder costs about 142k gas (Hardhat's older schedule: about 52k). Unused gas is refunded.
 */
const EVM_GAS_LIMIT = 150_000;

const SealedInput = z.object({ plan: SealedPlan, salt: z.string().regex(/^[0-9a-f]{64}$/) });

const StateJson = z.object({
  periodIndex: z.int(),
  soldInPeriod: z.string(),
  soldTotal: z.string(),
  lastSaleMs: z.int().nullable(),
  nextSaleAtMs: z.int(),
});

const Inflight = z.object({
  seq: z.int(),
  amount: z.string(),
  periodIndex: z.int(),
  issuedAtMs: z.int(),
  expiresAtMs: z.int(),
});

const PlanRecord = z.object({
  plan: SealedPlan,
  salt: z.string(),
  commitment: z.string(),
  envelope: EnvelopeSchema,
  state: StateJson,
  inflight: Inflight.nullable(),
  staged: z
    .object({
      plan: SealedPlan,
      salt: z.string(),
      commitment: z.string(),
      envelope: EnvelopeSchema,
    })
    .nullable(),
});
type PlanRecord = z.output<typeof PlanRecord>;

const toState = (s: z.output<typeof StateJson>): PlanState => ({
  ...s,
  soldInPeriod: BigInt(s.soldInPeriod),
  soldTotal: BigInt(s.soldTotal),
});
const fromState = (s: PlanState) => ({
  ...s,
  soldInPeriod: s.soldInPeriod.toString(),
  soldTotal: s.soldTotal.toString(),
});

/**
 * Hashes the executor's own source, standing in for a TDX build measurement: rebuild the same
 * code and you get the same MRTD, which is what the on-chain allowlist pins.
 */
export function measureSources(dirs: string[]): string {
  const files = dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => `${dir}/${f}`),
  );
  const h = sha384.create();
  for (const f of files) h.update(readFileSync(f));
  return bytesToHex(h.digest());
}

/**
 * The enclave's keys, all derived from the hardware secret. Exported for the red-team script,
 * which plays a fully compromised enclave to show what the chain still refuses.
 */
export function deriveEnclaveKeys(hardwareSecret: Uint8Array) {
  const derive = (info: string) => hkdf(sha256, hardwareSecret, undefined, utf8ToBytes(info), 32);
  return {
    signing: derive('vsp/enclave/signing'),
    encryption: derive('vsp/enclave/encryption'),
    sealing: derive('vsp/enclave/sealing'),
  };
}

const label384 = (label: string) => bytesToHex(sha384(utf8ToBytes(label)));

export interface SimulatedEnclaveOptions {
  /** The simulated hardware root. In TDX this never leaves the CPU; here it comes from .data. */
  hardwareSecret: Uint8Array;
  store: SealedStore;
  host: EnclaveHost;
  /** Source directories measured into MRTD. */
  measuredDirs: string[];
  random?: RandomBytes;
  /** Lets the demo operator take the enclave down to rehearse the fail-safe. */
  isUp?: () => Promise<boolean>;
  /**
   * The 1Click quote-signing key ("ed25519:<base58>"). Fixed at build time in a real enclave, so
   * the host cannot substitute quotes of its own.
   */
  quoteSignerKey: string;
}

/**
 * The executor enclave, simulated in-process. It holds the only copy of each plan's plaintext,
 * decides when and how much to sell inside the sealed limits, and signs execution requests the
 * registry checks. Its keys derive from the hardware secret, so the host never holds them.
 */
export class SimulatedEnclave implements Enclave {
  readonly mode = 'mock' as const;
  private readonly signingSecret: Uint8Array;
  private readonly encryptionSecret: Uint8Array;
  private readonly sealingSecret: Uint8Array;
  private readonly random: RandomBytes;
  private cachedIdentity: EnclaveIdentity | null = null;

  constructor(private readonly options: SimulatedEnclaveOptions) {
    const keys = deriveEnclaveKeys(options.hardwareSecret);
    this.signingSecret = keys.signing;
    this.encryptionSecret = keys.encryption;
    this.sealingSecret = keys.sealing;
    this.random = options.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  }

  private async ensureUp(): Promise<void> {
    if (this.options.isUp && !(await this.options.isUp()))
      throw new DomainError('unavailable', 'The enclave is down; no sales happen until it returns');
  }

  /**
   * The enclave's keys and quote. The quote is stored sealed and reused while the measured code
   * and keys are unchanged, so every process presents the quote that was registered on-chain.
   */
  async identity(): Promise<EnclaveIdentity> {
    if (this.cachedIdentity) return this.cachedIdentity;
    const signingKey = formatNearKey('ed25519', ed25519.getPublicKey(this.signingSecret));
    const encryptionKeyHex = bytesToHex(x25519.getPublicKey(this.encryptionSecret));
    const measurements = {
      mrtd: measureSources(this.options.measuredDirs),
      rtmr0: label384('simulated-tdx/firmware/v1'),
      rtmr1: label384('simulated-tdx/kernel/v1'),
      rtmr2: label384(`simulated-tdx/runtime/node-${process.versions.node}`),
      rtmr3: label384('verified-sales-plans/executor/v1'),
    };
    const reportData = reportDataFor(signingKey, encryptionKeyHex);
    const stored = await this.options.store.get('identity');
    let quote: SimulatedQuote | null = null;
    if (stored) {
      // A box sealed by different hardware cannot be opened; it is someone else's identity.
      let opened: unknown = null;
      try {
        opened = JSON.parse(openSealed(this.sealingSecret, stored));
      } catch {
        opened = null;
      }
      const parsed = SimulatedQuote.safeParse(opened);
      if (
        parsed.success &&
        parsed.data.report_data === reportData &&
        canonicalJson(parsed.data.measurements) === canonicalJson(measurements)
      )
        quote = parsed.data;
    }
    if (!quote) {
      quote = signSimulatedQuote({
        format: 'simulated-tdx-v1',
        measurements,
        report_data: reportData,
        issued_at: new Date().toISOString(),
      });
      await this.options.store.put(
        'identity',
        sealTo(this.sealingPublicHex(), JSON.stringify(quote)),
      );
    }
    this.cachedIdentity = {
      mode: 'mock',
      signingKey,
      encryptionKeyHex,
      quote,
      quoteHash: quoteHash(quote),
    };
    return this.cachedIdentity;
  }

  private sign(domain: string, json: string): SignedMessage {
    return {
      json,
      signature: toBase64(ed25519.sign(signingBytes(domain, json), this.signingSecret)),
      enclaveKey: formatNearKey('ed25519', ed25519.getPublicKey(this.signingSecret)),
    };
  }

  private sealingPublicHex = () => bytesToHex(x25519.getPublicKey(this.sealingSecret));

  private async load(planId: number): Promise<PlanRecord | null> {
    const box = await this.options.store.get(`plan:${planId}`);
    if (!box) return null;
    return parseInput(PlanRecord, JSON.parse(openSealed(this.sealingSecret, box)));
  }

  private async save(planId: number, record: PlanRecord): Promise<void> {
    await this.options.store.put(`plan:${planId}`, sealTo(this.sealingPublicHex(), toJson(record)));
  }

  /** Opens a founder's box and checks the plan against everything public about it. */
  private openForPlan(
    plan: ChainPlan,
    box: SealedBox,
    expected: { commitment: string; envelope: Envelope },
  ) {
    let opened: z.output<typeof SealedInput>;
    try {
      opened = parseInput(
        SealedInput,
        JSON.parse(openSealed(this.encryptionSecret, parseInput(SealedBox, box))),
      );
    } catch {
      return { ok: false as const, reasons: ['The sealed plan could not be opened or read'] };
    }
    const reasons = [...planProblems(opened.plan)];
    if (planCommitment(opened.plan, opened.salt) !== expected.commitment)
      reasons.push('The plan does not match the on-chain commitment');
    for (const c of checkWithinEnvelope(opened.plan, expected.envelope))
      if (!c.ok) reasons.push(`Outside the public envelope: ${c.rule}`);
    reasons.push(...this.publicFactProblems(plan, opened.plan));
    return reasons.length
      ? { ok: false as const, reasons }
      : { ok: true as const, plan: opened.plan, salt: opened.salt };
  }

  /** The sealed plan must agree with the public facts the registry recorded at creation. */
  private publicFactProblems(chain: ChainPlan, plan: SealedPlan): string[] {
    const problems: string[] = [];
    const token = plan.token;
    if (chain.asset.type === 'nep141') {
      if (token.chain !== 'near' || token.address !== chain.asset.token_id)
        problems.push('The plan names a different token than the registry');
    } else if (
      token.chain !== 'evm' ||
      token.address !== chain.asset.token_address ||
      token.chain_id !== chain.asset.chain_id
    ) {
      problems.push('The plan names a different token than the registry');
    }
    if (token.decimals !== chain.token_decimals)
      problems.push('Token decimals differ from the registry');
    if (plan.beneficiary.near_account !== chain.beneficiary.near_account)
      problems.push('The beneficiary differs from the registry');
    if (Date.parse(plan.start) !== chain.start_ms || Date.parse(plan.end) !== chain.end_ms)
      problems.push('Start or end differs from the registry');
    return problems;
  }

  private ack(
    plan: ChainPlan,
    commitment: string,
    envelope: Envelope,
    nowMs: number,
  ): SignedMessage {
    const message: AckMessage = {
      type: 'ack',
      plan_id: plan.id,
      commitment,
      envelope: envelopeJson(envelope),
      within_envelope: true,
      issued_at_ms: nowMs,
    };
    return this.sign(ACK_DOMAIN, JSON.stringify(message));
  }

  async acceptPlan(plan: ChainPlan, box: SealedBox): Promise<AcceptResult> {
    await this.ensureUp();
    if (plan.status !== 'awaiting_ack')
      return { ok: false, reasons: ['The plan is not awaiting an ack'] };
    const envelope = parseInput(EnvelopeSchema, plan.envelope);
    const opened = this.openForPlan(plan, box, { commitment: plan.commitment, envelope });
    if (!opened.ok) return opened;
    const existing = await this.load(plan.id);
    const state =
      existing?.commitment === plan.commitment
        ? existing.state
        : fromState(initialState(opened.plan, this.random));
    await this.save(plan.id, {
      plan: opened.plan,
      salt: opened.salt,
      commitment: plan.commitment,
      envelope,
      state,
      inflight: null,
      staged: null,
    });
    const now = await this.options.host.chainTimeMs();
    return { ok: true, ack: this.ack(plan, plan.commitment, envelope, now) };
  }

  async revealPlan(plan: ChainPlan): Promise<RevealResult> {
    await this.ensureUp();
    // Only what the chain says counts: the plan must have ended, and its owner must have chosen
    // end_reveal when creating it. Under other policies the owner reveals from their own backup.
    if (plan.status !== 'ended') return { ok: false, reason: 'The plan has not ended' };
    if (plan.disclosure.type !== 'end_reveal')
      return { ok: false, reason: 'The plan did not choose end_reveal' };
    const record = await this.load(plan.id);
    if (!record) return { ok: false, reason: 'The enclave does not hold this plan' };
    if (record.commitment !== plan.commitment)
      return { ok: false, reason: 'The held plan is not the committed one' };
    return { ok: true, planJson: canonicalJson(record.plan), salt: record.salt };
  }

  async stageChange(plan: ChainPlan, box: SealedBox): Promise<{ ok: boolean; reasons: string[] }> {
    await this.ensureUp();
    const change = plan.pending_change;
    if (change?.kind !== 'modify' || !change.commitment || !change.envelope)
      return { ok: false, reasons: ['No plan change is pending on-chain'] };
    const record = await this.load(plan.id);
    if (!record) return { ok: false, reasons: ['The enclave does not hold this plan'] };
    const envelope = parseInput(EnvelopeSchema, change.envelope);
    const opened = this.openForPlan(plan, box, { commitment: change.commitment, envelope });
    if (!opened.ok) return { ok: false, reasons: opened.reasons };
    await this.save(plan.id, {
      ...record,
      staged: { plan: opened.plan, salt: opened.salt, commitment: change.commitment, envelope },
    });
    return { ok: true, reasons: [] };
  }

  async tick(plan: ChainPlan): Promise<TickResult> {
    await this.ensureUp();
    const host = this.options.host;
    let record = await this.load(plan.id);
    if (!record)
      return { type: 'idle', reason: 'The enclave does not hold this plan', untilMs: null };
    if (plan.status !== 'active')
      return { type: 'idle', reason: `Plan is ${plan.status}`, untilMs: null };
    const now = await host.chainTimeMs();

    // A staged change the chain has now applied becomes the plan the enclave follows.
    if (record.staged && plan.commitment === record.staged.commitment) {
      record = { ...record, ...record.staged, staged: null, inflight: null };
      await this.save(plan.id, record);
    }
    if (plan.commitment !== record.commitment)
      return {
        type: 'idle',
        reason: 'The on-chain commitment is not the sealed plan',
        untilMs: null,
      };

    const change = plan.pending_change;
    if (
      record.staged &&
      change?.kind === 'modify' &&
      change.commitment === record.staged.commitment &&
      now >= change.effective_at_ms
    ) {
      return {
        type: 'ack_change',
        ack: this.ack(plan, record.staged.commitment, record.staged.envelope, now),
      };
    }

    // Settle what happened to the last signed request using the chain, not the host's word.
    let state = toState(record.state);
    if (record.inflight) {
      const inflight = record.inflight;
      if (plan.next_seq > inflight.seq) {
        const receipt = await host.receipt(plan.id, inflight.seq);
        state =
          receipt && receipt.status !== 'failed'
            ? recordSale(
                record.plan,
                state,
                BigInt(inflight.amount),
                inflight.periodIndex,
                inflight.issuedAtMs,
                this.random,
              )
            : deferSale(record.plan, state, now, this.random);
        record = { ...record, state: fromState(state), inflight: null };
        await this.save(plan.id, record);
      } else if (now <= inflight.expiresAtMs) {
        return {
          type: 'idle',
          reason: 'Waiting for the last signed sale to reach the chain',
          untilMs: inflight.expiresAtMs,
        };
      } else {
        record = { ...record, inflight: null };
        await this.save(plan.id, record);
      }
    }

    const balance = await host.planBalance(plan);
    const proposal = proposeSale(record.plan, record.envelope, state, now, balance, this.random);
    if (proposal.type === 'wait')
      return { type: 'idle', reason: proposal.reason, untilMs: proposal.untilMs };

    const sealed = record.plan;
    const quoteRequest = this.quoteRequestFor(plan, sealed, proposal.amount, now);
    const [quote, prices] = await Promise.all([
      host.quote(quoteRequest),
      host.prices(
        sealed.token.symbol,
        sealed.price_sources.filter((s) => s !== '1click_quote'),
        now,
      ),
    ]);
    const market = checkMarket(
      sealed,
      record.envelope,
      proposal.amount,
      prices,
      {
        amountIn: BigInt(quote.quote.amountIn),
        amountOut: BigInt(quote.quote.amountOut),
        minAmountOut: BigInt(quote.quote.minAmountOut),
      },
      plan.quote_decimals,
    );
    const depositAddress = quote.quote.depositAddress;
    const quoteProblems = this.quoteProblems(plan, sealed, proposal.amount, quote, now);
    if (!market.ok || quoteProblems.length || !depositAddress) {
      const deferred = deferSale(sealed, state, now, this.random);
      await this.save(plan.id, { ...record, state: fromState(deferred) });
      return { type: 'skipped', reasons: [...market.reasons, ...quoteProblems] };
    }
    const action = await this.actionFor(plan, depositAddress, proposal.amount);
    const request: ExecuteRequest = {
      plan_id: plan.id,
      seq: plan.next_seq,
      commitment: record.commitment,
      action,
      settlement: {
        venue: '1click',
        correlation_id: quote.correlationId,
        deposit_address: depositAddress,
        min_amount_out: quote.quote.minAmountOut,
        destination_asset: sealed.beneficiary.asset,
        quote: { payload: oneclickQuoteMessage(quote), signature: quote.signature },
      },
      compliance: market.compliance,
      issued_at_ms: now,
      expires_at_ms: now + REQUEST_TTL_MS,
    };
    const json = JSON.stringify(request);
    if (utf8ToBytes(json).length > MAX_REQUEST_JSON_BYTES)
      return { type: 'skipped', reasons: ['The request would be too large for the registry'] };
    await this.save(plan.id, {
      ...record,
      inflight: {
        seq: plan.next_seq,
        amount: proposal.amount.toString(),
        periodIndex: proposal.periodIndex,
        issuedAtMs: now,
        expiresAtMs: request.expires_at_ms,
      },
    });
    return {
      type: 'execute',
      request: this.sign(EXECUTE_DOMAIN, json),
      seq: plan.next_seq,
      amount: proposal.amount,
      quote,
    };
  }

  /**
   * The quote comes through the host, so the enclave checks it is genuine and is the quote it
   * asked for: signed by 1Click, paying the plan's beneficiary in the plan's asset, for exactly this
   * sale, refunding to the plan, still valid. The registry repeats the binding checks on-chain.
   */
  private quoteProblems(
    plan: ChainPlan,
    sealed: SealedPlan,
    amount: bigint,
    quote: QuoteResponse,
    now: number,
  ): string[] {
    const problems: string[] = [];
    const q = oneclickQuoteMessage(quote);
    const t = parseQuoteTerms(q);
    let signed = false;
    try {
      signed = ed25519.verify(
        parseNearKey(quote.signature).bytes,
        oneclickSignedBytes(q),
        parseNearKey(this.options.quoteSignerKey).bytes,
      );
    } catch {
      signed = false;
    }
    if (!signed) problems.push('The quote is not signed by 1Click');
    if (t.dry !== false || t.swapType !== 'EXACT_INPUT')
      problems.push('The quote is not a live exact-input quote');
    if (!t.depositAddress) problems.push('1Click gave no deposit address');
    if (t.recipient !== sealed.beneficiary.near_account)
      problems.push('The quote pays someone other than the beneficiary');
    if (t.destinationAsset !== sealed.beneficiary.asset)
      problems.push('The quote pays out in a different asset');
    if (t.amountIn !== amount.toString() || t.amount !== amount.toString())
      problems.push('The quote is for a different amount');
    if (sealed.token.chain === 'near' && t.originAsset !== originAssetId(sealed))
      problems.push('The quote sells a different token');
    const expectedRefund =
      sealed.token.chain === 'evm' ? (plan.evm_address ?? '') : plan.plan_account;
    if (t.refundTo.toLowerCase() !== expectedRefund.toLowerCase())
      problems.push('The quote refunds somewhere other than the plan');
    const deadline = Date.parse(t.deadline);
    if (!(deadline > now)) problems.push('The quote has expired');
    let costOk = false;
    try {
      costOk = quoteCostWithinBound(t);
    } catch {
      costOk = false;
    }
    if (!costOk) problems.push('The quote costs more than the fee bound allows');
    return problems;
  }

  private quoteRequestFor(
    plan: ChainPlan,
    sealed: SealedPlan,
    amount: bigint,
    now: number,
  ): QuoteRequest {
    const evm = sealed.token.chain === 'evm';
    return {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: sealed.max_slippage_bps,
      originAsset: originAssetId(sealed),
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: sealed.beneficiary.asset,
      amount: amount.toString(),
      refundTo: evm ? (plan.evm_address ?? '') : plan.plan_account,
      refundType: 'ORIGIN_CHAIN',
      recipient: sealed.beneficiary.near_account,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(now + QUOTE_DEADLINE_MS).toISOString(),
    };
  }

  private async actionFor(
    plan: ChainPlan,
    depositAddress: string,
    amount: bigint,
  ): Promise<ExecuteAction> {
    if (plan.asset.type === 'nep141')
      return {
        type: 'nep141_transfer',
        receiver_id: depositAddress,
        amount: amount.toString(),
        register_receiver: true,
      };
    const fees = await this.options.host.evmFees();
    return {
      type: 'evm_erc20_transfer',
      to: depositAddress.toLowerCase(),
      amount: amount.toString(),
      nonce: plan.evm_nonce,
      gas_limit: EVM_GAS_LIMIT,
      max_fee_per_gas: fees.maxFeePerGas.toString(),
      max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
    };
  }
}

/**
 * The 1Click asset id for the plan's token. NEAR tokens are nep141:<contract>; bridged EVM tokens
 * follow the observed nep141:<chain>-<address>.omft.near form.
 */
export function originAssetId(plan: SealedPlan): string {
  return plan.token.chain === 'near'
    ? `nep141:${plan.token.address}`
    : `nep141:eth-${plan.token.address}.omft.near`;
}
