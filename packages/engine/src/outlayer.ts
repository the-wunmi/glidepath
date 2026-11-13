import { readFileSync } from 'node:fs';
import {
  base58Encode,
  bytesToHex,
  DomainError,
  fromBase64,
  hexToBytes,
  oneclickQuoteMessage,
  type SealedBox,
  type SimulatedQuote,
  sha256Hex,
  utf8ToBytes,
} from '@vsp/core';
import { type Db, enclaveStore, executions, plans } from '@vsp/db';
import type {
  AcceptResult,
  Enclave,
  EnclaveHost,
  EnclaveIdentity,
  RevealResult,
  SignedMessage,
  TickResult,
} from '@vsp/enclave';
import {
  type Account,
  actions,
  type ChainPlan,
  type KeyPairString,
  type NearClient,
  readOutcome,
  teraToGas,
} from '@vsp/near';
import type { QuoteRequest } from '@vsp/oneclick';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { WorldConfig } from './world.ts';

/**
 * The enclave on OutLayer (TDX workers on NEAR testnet). Each operation is one
 * `request_execution` of our wasm, signed by the relayer: the keystore issues the module's keys
 * only to a direct run of that exact build called by that account. OutLayer keeps nothing between
 * runs, so the plan and its schedule travel as a record sealed under a keystore key; this host
 * stores the ciphertext and hands it back. A run's input and output are public on NEAR, and the
 * module (enclave-wasi/src/enclave.rs) puts nothing secret in either.
 */

/** What `scripts/outlayer-enclave.ts` recorded about the deployed module (no secrets). */
export const OutLayerDeployment = z.object({
  network: z.literal('testnet'),
  contract: z.string(),
  api: z.string().url(),
  workerRegistry: z.string(),
  caller: z.string(),
  wasm: z.object({ url: z.string().url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  signingKey: z.string().startsWith('ed25519:'),
  encryptionKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  quoteSignerKey: z.string(),
  keyProof: z.object({ txHash: z.string(), json: z.string(), signature: z.string() }),
  attestation: z.object({
    url: z.string().url(),
    measurements: z.object({
      mrtd: z.string(),
      rtmr0: z.string(),
      rtmr1: z.string(),
      rtmr2: z.string(),
      rtmr3: z.string(),
    }),
    quoteHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  registerTx: z.string().nullable(),
});
export type OutLayerDeployment = z.output<typeof OutLayerDeployment>;

export function loadOutLayerDeployment(dir: string): OutLayerDeployment {
  const path = `${dir}/outlayer-testnet.json`;
  try {
    return OutLayerDeployment.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new Error(`No usable ${path} (run scripts/outlayer-enclave.ts): ${String(error)}`);
  }
}

/**
 * The attached deposit. OutLayer charges for what the run used (about 0.0015 NEAR measured) and
 * refunds the rest; `estimate_execution_cost` for these limits is 0.007 NEAR.
 */
const RUN_DEPOSIT_YOCTO = 10n ** 22n;
/** The settlement callback alone takes 50 Tgas of what is attached. */
const RUN_GAS_TERA = 300;
/** Ten times what a sale decision uses, measured; the run is charged for what it uses. */
const RESOURCE_LIMITS = {
  max_instructions: 1_000_000_000,
  max_memory_mb: 128,
  max_execution_seconds: 30,
};
/** A run resolves within the 200-block yield window (~4 minutes); allow the chain some slack. */
const RUN_TIMEOUT_MS = 300_000;
/** Another process signs with the same relayer key (the main API), so nonces can collide. */
const NONCE_RETRIES = 6;

export interface RunResult<T> {
  txHash: string;
  /** The guest's stdout exactly as the chain returned it (what the attestation's output hash covers). */
  outputBytes: Uint8Array;
  inputData: string;
  result: T;
}

type ModuleOutput<T> = { ok: true; result: T } | { ok: false; error: string };

/** Sends `request_execution` transactions for one wasm build and reads the module's answer. */
export class OutLayerClient {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly caller: Account,
    private readonly contract: string,
    private readonly wasm: { url: string; sha256: string },
  ) {}

  /** One run; queued, so this process never signs two of them with the same nonce. */
  run<T>(input: object): Promise<RunResult<T>> {
    const next = this.queue.catch(() => undefined).then(() => this.runNow<T>(input));
    this.queue = next;
    return next;
  }

  private async runNow<T>(input: object): Promise<RunResult<T>> {
    const inputData = JSON.stringify(input);
    const action = actions.functionCall(
      'request_execution',
      {
        source: {
          WasmUrl: { url: this.wasm.url, hash: this.wasm.sha256, build_target: 'wasm32-wasip2' },
        },
        resource_limits: RESOURCE_LIMITS,
        input_data: inputData,
        response_format: 'Json',
      },
      teraToGas(RUN_GAS_TERA),
      RUN_DEPOSIT_YOCTO,
    );
    const provider = this.caller.provider;
    let txHash = '';
    for (let attempt = 0; ; attempt++) {
      const signed = await this.caller.createSignedTransaction({
        receiverId: this.contract,
        actions: [action],
      });
      txHash = base58Encode(hexToBytes(sha256Hex(signed.transaction.encode())));
      try {
        // Wait for inclusion: an async broadcast that loses a nonce race is dropped silently.
        await provider.sendTransactionUntil(signed, 'INCLUDED');
        break;
      } catch (error) {
        if (attempt < NONCE_RETRIES && /InvalidNonce|nonce/i.test(String(error))) {
          await sleep(500 + attempt * 500);
          continue;
        }
        // The RPC gave up waiting, not the chain: the outcome is read by polling below.
        if (/timeout/i.test(String(error))) break;
        throw error;
      }
    }
    return this.outcome<T>(txHash, inputData);
  }

  /** The module's answer to a run already sent (also how a run is re-read after a restart). */
  async outcome<T>(txHash: string, inputData: string): Promise<RunResult<T>> {
    const raw = await this.waitFinal(txHash);
    const outcome = readOutcome<ModuleOutput<T> | null>(raw as never);
    const status = (raw as { status: { SuccessValue?: string } }).status;
    const outputBytes = fromBase64(status.SuccessValue ?? '');
    if (!outcome.ok)
      throw new DomainError('unavailable', `OutLayer refused the run: ${outcome.error}`);
    const out = outcome.value;
    if (!out) throw new DomainError('unavailable', `The OutLayer run failed (tx ${txHash})`);
    if (!out.ok) throw new DomainError('unavailable', `The enclave refused: ${out.error}`);
    return { txHash, outputBytes, inputData, result: out.result };
  }

  /** Polls until the yield is resumed and every receipt is final. */
  private async waitFinal(txHash: string): Promise<unknown> {
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    for (;;) {
      try {
        const raw = await this.caller.provider.viewTransactionStatus({
          txHash,
          accountId: this.caller.accountId,
          waitUntil: 'FINAL',
        });
        const status = (raw as unknown as { status: unknown }).status;
        if (status && typeof status === 'object') return raw;
      } catch (error) {
        // UNKNOWN_TRANSACTION before it lands, TIMEOUT_ERROR while the yield is pending.
        if (Date.now() > deadline)
          throw new DomainError('unavailable', `No final outcome for ${txHash}: ${String(error)}`);
      }
      if (Date.now() > deadline)
        throw new DomainError('unavailable', `No final outcome for ${txHash}`);
      await sleep(3_000);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Attestation ────────────────────────────────────────────────────────────────────────────────

const AttestationRecord = z.object({
  task_id: z.number(),
  task_type: z.string(),
  tdx_quote: z.string(),
  worker_measurement: z.string(),
  caller_account_id: z.string().nullish(),
  transaction_hash: z.string().nullish(),
  block_height: z.number().nullish(),
  build_target: z.string().nullish(),
  wasm_hash: z.string().nullish(),
  executed_wasm_sha256: z.string().nullish(),
  input_hash: z.string().nullish(),
  output_hash: z.string(),
  project_id: z.string().nullish(),
  secrets_ref: z.string().nullish(),
  attached_usd: z.string().nullish(),
  timestamp: z.number(),
});

export type Measurements = OutLayerDeployment['attestation']['measurements'];

/** TDX quote v4: a 48-byte header, then the TD report (offsets per Intel's TDX DCAP layout). */
const TD_REPORT = 48;
const field = (q: Uint8Array, offset: number, len: number) =>
  bytesToHex(q.slice(TD_REPORT + offset, TD_REPORT + offset + len));

export function quoteMeasurements(quote: Uint8Array): Measurements & { reportData: string } {
  if (quote.length < TD_REPORT + 584) throw new Error('Not a TDX quote');
  return {
    mrtd: field(quote, 136, 48),
    rtmr0: field(quote, 328, 48),
    rtmr1: field(quote, 376, 48),
    rtmr2: field(quote, 424, 48),
    rtmr3: field(quote, 472, 48),
    reportData: field(quote, 520, 64),
  };
}

/**
 * The worker's per-run report data: sha256 over the task's fields, absent ones skipped, integers
 * little-endian (worker/src/tdx_attestation.rs `generate_task_attestation`), then 32 zero bytes.
 */
export function taskReportData(a: z.output<typeof AttestationRecord>): string {
  const le = (n: number | bigint, bytes: number) => {
    const out = new Uint8Array(bytes);
    new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(n)), true);
    return out;
  };
  const parts: Uint8Array[] = [utf8ToBytes(a.task_type), le(a.task_id, 8)];
  for (const v of [a.build_target, a.wasm_hash, a.input_hash]) if (v) parts.push(utf8ToBytes(v));
  parts.push(utf8ToBytes(a.output_hash));
  if (a.block_height !== null && a.block_height !== undefined) parts.push(le(a.block_height, 8));
  for (const v of [a.caller_account_id, a.project_id, a.secrets_ref])
    if (v) parts.push(utf8ToBytes(v));
  parts.push(le(a.timestamp, 8));
  if (a.attached_usd !== null && a.attached_usd !== undefined)
    parts.push(utf8ToBytes(a.attached_usd));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return sha256Hex(all) + '00'.repeat(32);
}

export interface AttestationCheck {
  url: string;
  measurements: Measurements;
  quoteHash: string;
  checks: { rule: string; ok: boolean }[];
}

/**
 * Checks one run's attestation: the quote's measurements are on OutLayer's on-chain approved list,
 * its report data commits to this run's wasm, input, output and caller, and those match what we
 * sent and what the chain returned. Not checked here: the quote's Intel signature chain
 * (OutLayer's `outlayer-verify` does that against Intel's collateral).
 */
export async function checkAttestation(
  view: <T>(contract: string, method: string, args?: Record<string, unknown>) => Promise<T>,
  d: Pick<OutLayerDeployment, 'api' | 'workerRegistry' | 'caller' | 'wasm'>,
  run: Pick<RunResult<unknown>, 'txHash' | 'inputData' | 'outputBytes'>,
): Promise<AttestationCheck> {
  const url = `${d.api}/attestations/by-tx/${run.txHash}`;
  let record: z.output<typeof AttestationRecord> | null = null;
  // The worker uploads the attestation just after it resumes the yield.
  for (let i = 0; i < 20 && !record; i++) {
    const res = await fetch(url);
    if (res.ok) record = AttestationRecord.parse(await res.json());
    else await sleep(3_000);
  }
  if (!record) throw new Error(`No attestation at ${url}`);
  const quote = fromBase64(record.tdx_quote);
  const { reportData, ...measurements } = quoteMeasurements(quote);
  const approved = await view<Measurements[]>(d.workerRegistry, 'get_approved_measurements');
  const same = (m: Measurements) =>
    (['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3'] as const).every((k) => m[k] === measurements[k]);
  const checks = [
    { rule: 'Measurements on OutLayer’s approved list', ok: approved.some(same) },
    { rule: 'Report data commits to this run', ok: reportData === taskReportData(record) },
    { rule: 'Ran our wasm', ok: record.wasm_hash === d.wasm.sha256 },
    {
      rule: 'Executed bytes hash to our wasm',
      ok: (record.executed_wasm_sha256 ?? d.wasm.sha256) === d.wasm.sha256,
    },
    { rule: 'Called by our relayer', ok: record.caller_account_id === d.caller },
    { rule: 'Input is what we sent', ok: record.input_hash === sha256Hex(run.inputData) },
    {
      rule: 'Output is what the chain returned',
      ok: record.output_hash === sha256Hex(run.outputBytes),
    },
    {
      rule: 'Worker measurement is the quote’s RTMR3',
      ok: record.worker_measurement === measurements.rtmr3,
    },
  ];
  return { url, measurements, quoteHash: sha256Hex(quote), checks };
}

// ── The Enclave ────────────────────────────────────────────────────────────────────────────────

interface Signed {
  json: string;
  signature: string;
  enclave_key: string;
}
const toSigned = (s: Signed): SignedMessage => ({
  json: s.json,
  signature: s.signature,
  enclaveKey: s.enclave_key,
});

type TickOutput =
  | { type: 'idle'; reason: string; until_ms: number | null; record: string | null }
  | { type: 'ack_change'; ack: Signed; record: string | null }
  | {
      type: 'quote';
      seq: number;
      amount: string;
      quote_request: QuoteRequest;
      record: string;
    };

type SellOutput =
  | { type: 'idle'; reason: string; record: string | null }
  | { type: 'skipped'; record: string }
  | { type: 'execute'; seq: number; amount: string; request: Signed; record: string };

/** Exchange feeds the host offers; the sealed plan names which ones count. */
const PRICE_FEEDS = ['binance', 'coinbase'];

/** Where the host keeps each plan's sealed record, and the public facts it reads about a plan. */
export interface OutLayerStore {
  load(planId: number): Promise<string | null>;
  save(planId: number, record: string): Promise<void>;
  /** The token symbol the plan was created with (public), to ask the price feeds. */
  symbol(planId: number): Promise<string>;
  /** Whether a sale the enclave signed is still waiting to reach the registry. */
  saleInFlight(planId: number): Promise<boolean>;
}

/** Sealed records live beside the simulator's, under keys a new world clears (`plan:%`). */
const recordKey = (planId: number) => `plan:${planId}:outlayer`;

export function dbOutLayerStore(db: Db): OutLayerStore {
  return {
    async load(planId) {
      const [row] = await db
        .select()
        .from(enclaveStore)
        .where(eq(enclaveStore.key, recordKey(planId)));
      return (row?.box as { record?: string } | undefined)?.record ?? null;
    },
    async save(planId, record) {
      const box = { record };
      await db
        .insert(enclaveStore)
        .values({ key: recordKey(planId), box })
        .onConflictDoUpdate({ target: enclaveStore.key, set: { box, updatedAt: new Date() } });
    },
    async symbol(planId) {
      const [row] = await db
        .select({ symbol: plans.tokenSymbol })
        .from(plans)
        .where(eq(plans.id, planId));
      if (!row) throw new DomainError('not_found', 'Plan not found');
      return row.symbol;
    },
    async saleInFlight(planId) {
      const rows = await db
        .select({ id: executions.id })
        .from(executions)
        .where(and(eq(executions.planId, planId), eq(executions.status, 'signed')))
        .limit(1);
      return rows.length > 0;
    },
  };
}

/**
 * Why the public envelope rules out any sale right now, or null if one could be due. Checked from
 * public chain state before paying for a run; the module still decides when within what is left.
 */
export function noSalePossible(plan: ChainPlan, nowMs: number): string | null {
  if (nowMs < plan.start_ms) return 'The plan has not started';
  if (nowMs >= plan.end_ms) return 'The plan has ended';
  const env = plan.envelope;
  if (plan.last_sale_ms !== null && nowMs - plan.last_sale_ms < env.min_gap_ms)
    return 'The minimum gap since the last sale has not passed';
  const period = Math.floor((nowMs - plan.start_ms) / env.period_ms);
  if (
    period === plan.period_index &&
    BigInt(plan.sold_in_period) >= BigInt(env.max_amount_per_period)
  )
    return 'This period’s cap is used up';
  return null;
}

export interface OutLayerEnclaveOptions {
  store: OutLayerStore;
  client: Pick<OutLayerClient, 'run'>;
  deployment: OutLayerDeployment;
  host: EnclaveHost;
  /**
   * Least time between runs for one plan. Every run is a paid NEAR transaction, so the engine's
   * five-second wake-ups cannot each be one; the module still decides whether a sale is due.
   */
  pollMs: number;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export class OutLayerEnclave implements Enclave {
  readonly mode = 'live' as const;
  private readonly lastRun = new Map<number, number>();

  constructor(private readonly o: OutLayerEnclaveOptions) {}

  /**
   * The keys from the attested key-proof run. `quote` is OutLayer's attestation, not a simulated
   * quote: the shared identity type predates live enclaves, and `format` tells them apart.
   */
  async identity(): Promise<EnclaveIdentity> {
    const d = this.o.deployment;
    const quote = {
      format: 'outlayer-tdx-v1',
      measurements: d.attestation.measurements,
      attestation_url: d.attestation.url,
      key_proof_tx: d.keyProof.txHash,
      wasm_url: d.wasm.url,
      wasm_sha256: d.wasm.sha256,
      worker_registry: d.workerRegistry,
    };
    return {
      mode: 'live',
      signingKey: d.signingKey,
      encryptionKeyHex: d.encryptionKeyHex,
      quote: quote as unknown as SimulatedQuote,
      quoteHash: d.attestation.quoteHash,
    };
  }

  private load(planId: number): Promise<string | null> {
    return this.o.store.load(planId);
  }

  private async save(planId: number, record: string | null): Promise<void> {
    if (record) await this.o.store.save(planId, record);
  }

  private async run<T>(op: string, planId: number, input: object): Promise<T> {
    const out = await this.o.client.run<T>({ op, ...input });
    this.o.log('outlayer run', { op, planId, txHash: out.txHash });
    return out.result;
  }

  async acceptPlan(plan: ChainPlan, box: SealedBox): Promise<AcceptResult> {
    if (plan.status !== 'awaiting_ack')
      return { ok: false, reasons: ['The plan is not awaiting an ack'] };
    const out = await this.run<
      { ok: true; ack: Signed; record: string } | { ok: false; reasons: string[] }
    >('accept', plan.id, { plan, sealed: box, now_ms: await this.o.host.chainTimeMs() });
    if (!out.ok) return out;
    await this.save(plan.id, out.record);
    return { ok: true, ack: toSigned(out.ack) };
  }

  async stageChange(plan: ChainPlan, box: SealedBox): Promise<{ ok: boolean; reasons: string[] }> {
    const record = await this.load(plan.id);
    if (!record) return { ok: false, reasons: ['The enclave does not hold this plan'] };
    const out = await this.run<{ ok: true; record: string } | { ok: false; reasons: string[] }>(
      'stage',
      plan.id,
      { plan, sealed: box, record },
    );
    if (!out.ok) return out;
    await this.save(plan.id, out.record);
    return { ok: true, reasons: [] };
  }

  async revealPlan(plan: ChainPlan): Promise<RevealResult> {
    if (plan.status !== 'ended') return { ok: false, reason: 'The plan has not ended' };
    if (plan.disclosure.type !== 'end_reveal')
      return { ok: false, reason: 'The plan did not choose end_reveal' };
    const record = await this.load(plan.id);
    if (!record) return { ok: false, reason: 'The enclave does not hold this plan' };
    const out = await this.run<
      { ok: true; plan_json: string; salt: string } | { ok: false; reason: string }
    >('reveal', plan.id, { plan, record });
    return out.ok ? { ok: true, planJson: out.plan_json, salt: out.salt } : out;
  }

  async tick(plan: ChainPlan): Promise<TickResult> {
    const record = await this.load(plan.id);
    // Plans this enclave never accepted (another enclave's) cost nothing to skip.
    if (!record)
      return { type: 'idle', reason: 'The enclave does not hold this plan', untilMs: null };
    if (plan.status !== 'active')
      return { type: 'idle', reason: `Plan is ${plan.status}`, untilMs: null };
    const now = await this.o.host.chainTimeMs();
    if (now - (this.lastRun.get(plan.id) ?? 0) < this.o.pollMs)
      return { type: 'idle', reason: 'waiting', untilMs: null };
    this.lastRun.set(plan.id, now);

    const host = this.o.host;
    const balance = await host.planBalance(plan);
    // Each run is paid, so a plan that cannot sell now gets none, unless a change has taken
    // effect: only a run can ack it.
    const change = plan.pending_change;
    const changeDue = change?.kind === 'modify' && change.effective_at_ms <= now;
    if (!changeDue) {
      const reason =
        noSalePossible(plan, now) ??
        (balance === 0n ? 'The plan holds no tokens (not launched, or sold out)' : null) ??
        ((await this.o.store.saleInFlight(plan.id)) ? 'A signed sale is still in flight' : null);
      if (reason) return { type: 'idle', reason, untilMs: null };
    }
    const last = plan.next_seq > 0 ? await host.receipt(plan.id, plan.next_seq - 1) : null;
    const decided = await this.run<TickOutput>('tick', plan.id, {
      plan,
      record,
      now_ms: now,
      balance: balance.toString(),
      last_receipt: last ? { seq: last.seq, status: last.status } : null,
    });
    await this.save(plan.id, decided.record);
    if (decided.type === 'idle')
      return { type: 'idle', reason: decided.reason, untilMs: decided.until_ms };
    if (decided.type === 'ack_change') return { type: 'ack_change', ack: toSigned(decided.ack) };

    // The module chose the amount; 1Click (the simulator on testnet) quotes it through the host.
    const symbol = await this.o.store.symbol(plan.id);
    const [quote, prices, fees] = await Promise.all([
      host.quote(decided.quote_request),
      host.prices(symbol, PRICE_FEEDS, Date.now()),
      plan.asset.type === 'nep141' ? null : host.evmFees(),
    ]);
    const sold = await this.run<SellOutput>('sell', plan.id, {
      plan,
      record: decided.record,
      now_ms: await host.chainTimeMs(),
      quote: {
        payload: oneclickQuoteMessage(quote),
        signature: quote.signature,
        correlation_id: quote.correlationId,
      },
      prices: prices.map((p) => ({ source: p.source, price_e6: p.priceE6.toString() })),
      evm_fees: fees && {
        max_fee_per_gas: fees.maxFeePerGas.toString(),
        max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
      },
    });
    await this.save(plan.id, sold.record);
    if (sold.type === 'idle') return { type: 'idle', reason: sold.reason, untilMs: null };
    // Skip reasons stay inside the module: they would reveal the floor.
    if (sold.type === 'skipped') return { type: 'skipped', reasons: [] };
    return {
      type: 'execute',
      request: toSigned(sold.request),
      seq: sold.seq,
      amount: BigInt(sold.amount),
      quote,
    };
  }
}

/** The OutLayer enclave for this world, refusing a record made for another relayer or quote key. */
export function buildOutLayerEnclave(
  config: Config,
  db: Db,
  near: NearClient,
  w: WorldConfig,
  host: EnclaveHost,
  quoteSignerKey: string,
  log: OutLayerEnclaveOptions['log'],
): OutLayerEnclave {
  const deployment = loadOutLayerDeployment(config.DEPLOYMENTS_DIR);
  // The keystore binds the module's keys to the calling account, and the quote key is built in.
  if (deployment.caller !== w.relayer)
    throw new Error(`The OutLayer key belongs to ${deployment.caller}, not ${w.relayer}`);
  if (deployment.quoteSignerKey !== quoteSignerKey)
    throw new Error('The OutLayer module was built for another 1Click quote key');
  const caller = near.account(w.relayer, w.keys[w.relayer] as KeyPairString);
  return new OutLayerEnclave({
    store: dbOutLayerStore(db),
    client: new OutLayerClient(caller, deployment.contract, deployment.wasm),
    deployment,
    host,
    pollMs: config.OUTLAYER_TICK_SECONDS * 1_000,
    log,
  });
}
