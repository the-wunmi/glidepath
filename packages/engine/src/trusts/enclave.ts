import type { SealedBox } from '@glidepath/core';
import { enclaveStore } from '@glidepath/db';
import type { SealedStore, SignedMessage } from '@glidepath/enclave';
import type { KeyPairString } from '@glidepath/near';
import type { ChainTrust } from '@glidepath/trust';
import {
  SimulatedTrustEnclave,
  type TrustAcceptResult,
  type TrustEnclave,
  type TrustMarketView,
  type TrustQuote,
  type TrustTickResult,
  type TrustTradeResult,
} from '@glidepath/trust/enclave';
import { eq } from 'drizzle-orm';
import type { Engine } from '../context.ts';
import { oneclickQuoteKey } from '../context.ts';
import {
  loadOutLayerDeployment,
  ModuleError,
  type OutLayerBuild,
  OutLayerClient,
  type OutLayerRunner,
} from '../outlayer.ts';
import { enclaveHardwareSecret } from '../world.ts';

/** The host's untrusted storage for enclave boxes and records (the `enclave_store` table). */
function storeOf(e: Engine): SealedStore {
  return {
    async get(key) {
      const [row] = await e.db.select().from(enclaveStore).where(eq(enclaveStore.key, key));
      return (row?.box as SealedBox | undefined) ?? null;
    },
    async put(key, box) {
      await e.db
        .insert(enclaveStore)
        .values({ key, box })
        .onConflictDoUpdate({ target: enclaveStore.key, set: { box, updatedAt: new Date() } });
    },
  };
}

const enclaves = new WeakMap<Engine, TrustEnclave>();

/**
 * The trust executor this engine uses: with ENCLAVE_BACKEND=outlayer the current OutLayer build
 * (the one the plan enclave attests, so the page seals to its key); otherwise the in-process
 * simulator (the simulated plan enclave's keys, so the same attested key signs). Tests set the
 * enclave-wasi module with `useTrustEnclave`.
 */
export function trustEnclaveOf(e: Engine): TrustEnclave {
  let enclave = enclaves.get(e);
  if (!enclave) {
    enclave =
      e.config.ENCLAVE_BACKEND === 'outlayer'
        ? outlayerTrustEnclave(e)
        : new SimulatedTrustEnclave(
            enclaveHardwareSecret(e.config.DATA_DIR),
            storeOf(e) as SealedStore,
            oneclickQuoteKey(e.config, e.world),
          );
    enclaves.set(e, enclave);
  }
  return enclave;
}

/** The trust operations on the current OutLayer build, run by the relayer its keystore binds to. */
function outlayerTrustEnclave(e: Engine): ModuleTrustEnclave {
  const deployment = loadOutLayerDeployment(e.config.DEPLOYMENTS_DIR);
  if (deployment.caller !== e.world.relayer)
    throw new Error(`The OutLayer key belongs to ${deployment.caller}, not ${e.world.relayer}`);
  if (deployment.quoteSignerKey !== oneclickQuoteKey(e.config, e.world))
    throw new Error('The OutLayer module was built for another 1Click quote key');
  const caller = e.near.account(e.world.relayer, e.world.keys[e.world.relayer] as KeyPairString);
  return new ModuleTrustEnclave(e, new OutLayerClient(caller, deployment.contract), deployment);
}

export function useTrustEnclave(e: Engine, enclave: TrustEnclave): void {
  enclaves.set(e, enclave);
}

interface ModuleSigned {
  json: string;
  signature: string;
  enclave_key: string;
}

const signedMessage = (m: ModuleSigned): SignedMessage => ({
  json: m.json,
  signature: m.signature,
  enclaveKey: m.enclave_key,
});

/**
 * The enclave-wasi module's trust operations (`trust_accept`, `trust_tick`, `trust_trade`), run
 * the way OutLayer runs a module: one JSON request in, one answer out, the sealed record carried
 * between runs and kept by the host. Locally the runner is `glidepath-enclave-local`; an OutLayer build
 * of this code would plug in the same way.
 */
export class ModuleTrustEnclave implements TrustEnclave {
  readonly mode = 'live' as const;

  constructor(
    private readonly e: Engine,
    private readonly runner: OutLayerRunner,
    private readonly build: OutLayerBuild,
  ) {}

  async signingKey(): Promise<string> {
    return this.build.signingKey;
  }

  private recordKey = (trustId: number) => `trust:${trustId}:module:${this.build.signingKey}`;

  private async record(trustId: number): Promise<string | null> {
    const box = await storeOf(this.e).get(this.recordKey(trustId));
    return (box as unknown as { record?: string } | null)?.record ?? null;
  }

  private async keep(trustId: number, record: string | null | undefined): Promise<void> {
    if (record)
      await storeOf(this.e).put(this.recordKey(trustId), { record } as unknown as SealedBox);
  }

  private async run<T>(input: object): Promise<T> {
    return (await this.runner.run<T>(this.build, input)).result;
  }

  async accept(chain: ChainTrust, box: SealedBox, nowMs: number): Promise<TrustAcceptResult> {
    try {
      const out = await this.run<
        { ok: true; ack: ModuleSigned; record: string } | { ok: false; reasons: string[] }
      >({ op: 'trust_accept', trust: chain, sealed: box, now_ms: nowMs });
      if (!out.ok) return out;
      await this.keep(chain.id, out.record);
      return { ok: true, ack: signedMessage(out.ack) };
    } catch (error) {
      if (error instanceof ModuleError) return { ok: false, reasons: [error.message] };
      throw error;
    }
  }

  async tick(chain: ChainTrust, view: TrustMarketView, nowMs: number): Promise<TrustTickResult> {
    const record = await this.record(chain.id);
    if (!record) return { type: 'idle', reason: 'no_record' };
    const out = await this.run<
      | { type: 'idle'; reason: string; record: string | null }
      | {
          type: 'quote';
          seq: number;
          quote_request: Extract<TrustTickResult, { type: 'quote' }>['quoteRequest'];
          record: string;
        }
    >({ op: 'trust_tick', trust: chain, record, now_ms: nowMs, ...view });
    await this.keep(chain.id, out.record);
    return out.type === 'quote'
      ? { type: 'quote', seq: out.seq, quoteRequest: out.quote_request }
      : { type: 'idle', reason: out.reason };
  }

  async trade(chain: ChainTrust, quote: TrustQuote, nowMs: number): Promise<TrustTradeResult> {
    const record = await this.record(chain.id);
    if (!record) return { type: 'idle', reason: 'no_record' };
    const out = await this.run<
      | { type: 'idle'; reason: string; record: string | null }
      | { type: 'skipped'; record: string }
      | { type: 'execute'; seq: number; request: ModuleSigned; record: string }
    >({ op: 'trust_trade', trust: chain, record, now_ms: nowMs, quote });
    await this.keep(chain.id, out.record);
    if (out.type === 'execute')
      return { type: 'execute', seq: out.seq, request: signedMessage(out.request) };
    return out.type === 'skipped' ? { type: 'skipped' } : { type: 'idle', reason: out.reason };
  }
}
