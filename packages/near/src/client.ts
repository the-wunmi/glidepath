import { DomainError, fromBase64 } from '@vsp/core';
import {
  Account,
  type Action,
  actions,
  JsonRpcProvider,
  KeyPair,
  type KeyPairString,
  teraToGas,
} from 'near-api-js';

export { type Account, actions, KeyPair, type KeyPairString, teraToGas };

/** A NEP-297 event a contract logged as EVENT_JSON. */
export interface ChainEvent {
  standard: string;
  version: string;
  event: string;
  data: Record<string, unknown>[];
}

/**
 * What a transaction did, read from its outcome rather than thrown: the red-team script and the
 * UI show the contract's own error code, so a refusal is data, not an exception.
 */
export type TxOutcome<T = unknown> =
  | { ok: true; txHash: string; value: T; logs: string[]; events: ChainEvent[] }
  | {
      ok: false;
      txHash: string;
      error: string;
      code: string;
      logs: string[];
      events: ChainEvent[];
    };

export interface CallOptions {
  gasTera?: number;
  deposit?: bigint;
}

type Status = { SuccessValue?: string; Failure?: unknown } | string;
interface RawOutcome {
  transaction?: { hash: string };
  transaction_outcome?: { id: string; outcome: { logs: string[]; status: Status } };
  receipts_outcome?: { outcome: { logs: string[]; status: Status } }[];
  status: Status;
}

/** The message inside a failure, e.g. "Smart contract panicked: bad_seq" → code "bad_seq". */
function failureText(failure: unknown): string {
  const text = JSON.stringify(failure);
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(text);
  if (panic?.[1]) return panic[1];
  const exec = /"ExecutionError":"([^"]+)"/.exec(text);
  if (exec?.[1]) return exec[1];
  return text.slice(0, 500);
}

/** Short snake_case code if the panic message is one, else a generic code. */
const errorCode = (message: string): string =>
  /^[a-z][a-z0-9_]*$/.test(message.trim()) ? message.trim() : 'chain_error';

function parseEvents(logs: string[]): ChainEvent[] {
  return logs.flatMap((log) => {
    if (!log.startsWith('EVENT_JSON:')) return [];
    try {
      return [JSON.parse(log.slice('EVENT_JSON:'.length)) as ChainEvent];
    } catch {
      return [];
    }
  });
}

export function readOutcome<T>(raw: RawOutcome): TxOutcome<T> {
  const txHash = raw.transaction?.hash ?? raw.transaction_outcome?.id ?? '';
  const logs = [
    ...(raw.transaction_outcome?.outcome.logs ?? []),
    ...(raw.receipts_outcome ?? []).flatMap((r) => r.outcome.logs),
  ];
  const events = parseEvents(logs);
  const status = raw.status;
  if (typeof status === 'object' && status.Failure !== undefined) {
    const error = failureText(status.Failure);
    return { ok: false, txHash, error, code: errorCode(error), logs, events };
  }
  // A later receipt can fail while the transaction itself succeeds (e.g. a callback). Callers that
  // care check events or `innerFailure`.
  const value =
    typeof status === 'object' && status.SuccessValue
      ? (JSON.parse(new TextDecoder().decode(fromBase64(status.SuccessValue))) as T)
      : (undefined as T);
  return { ok: true, txHash, value, logs, events };
}

/** The first failing receipt in a successful transaction, if any. */
export function innerFailure(raw: RawOutcome): string | null {
  for (const r of raw.receipts_outcome ?? []) {
    const s = r.outcome.status;
    if (typeof s === 'object' && s.Failure !== undefined) return failureText(s.Failure);
  }
  return null;
}

/** Largest single sandbox jump: half the 100-block transaction validity window. */
const FAST_FORWARD_STEP = 50;
/** Largest jump when nothing is in flight. */
const UNSETTLED_STEP = 500;
/** How far the final block may trail the head before a jump counts as settled. */
const FINALITY_LAG_BLOCKS = 5;
/** A jump that has not settled by then is left to settle on its own. */
const FINALITY_WAIT_MS = 10_000;

export interface RpcOptions {
  /** More endpoints, tried in order when the first is resting after a refusal or a failure. */
  fallbackUrls?: string[];
  /** Most requests per second to any one endpoint (default: unpaced, for a local node). */
  maxPerSecond?: number;
  /**
   * Most requests queued or in flight; beyond it a request fails at once as `unavailable` rather
   * than queueing for minutes behind a flood of reads (default: unbounded).
   */
  maxWaiting?: number;
  /** How long a request keeps trying endpoints that refuse it (default 90 s). */
  deadlineMs?: number;
}

const rateLimited = (err: unknown) =>
  /429|rate limit/i.test(String((err as Error)?.message ?? err));
const transportFailure = (err: unknown) =>
  /Internal server error|Timeout error|Bad Gateway|unavailable|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|RetriesExceeded|socket hang up/i.test(
    `${String((err as Error)?.message ?? err)} ${(err as { type?: string })?.type ?? ''}`,
  );

/** Whether an RPC error means no endpoint could answer, rather than that the node answered with an error. */
export const nearRpcUnavailable = (err: unknown): boolean =>
  rateLimited(err) || transportFailure(err);

interface Endpoint {
  url: string;
  rpc: JsonRpcProvider;
  /** When the next request may go out (pacing). */
  readyAt: number;
  /** Until when it rests after a refusal or failure. */
  restUntil: number;
  /** Refusals in a row, for a longer rest each time. */
  strikes: number;
}

/**
 * A provider for public endpoints that rate-limit. Requests to one endpoint are spaced out; an
 * endpoint that answers 429 or fails at the transport rests (1 s, doubling to 30 s) while the next
 * endpoint takes the request. A request fails only after every endpoint has refused it for the
 * deadline (90 s unless set).
 * Contract and protocol errors are answers and return at once. Re-sending a signed transaction
 * to another endpoint is safe: it is the same transaction, with the same hash.
 */
class PacedProvider extends JsonRpcProvider {
  private readonly endpoints: Endpoint[];
  private readonly spacingMs: number;
  private waiting = 0;

  constructor(
    urls: string[],
    maxPerSecond?: number,
    private readonly maxWaiting = Number.POSITIVE_INFINITY,
    private readonly deadlineMs = 90_000,
  ) {
    super({ url: urls[0] ?? '' });
    // The library would wait up to ~30 s on a 429; here an endpoint gets two quick tries, then the
    // next one takes over.
    this.endpoints = urls.map((url) => ({
      url,
      rpc: new JsonRpcProvider({ url }, { retries: 2, wait: 200, backoff: 1.5 }),
      readyAt: 0,
      restUntil: 0,
      strikes: 0,
    }));
    this.spacingMs = maxPerSecond ? 1000 / maxPerSecond : 0;
  }

  /** The first endpoint not resting; if all rest, the one that wakes soonest. */
  private choose(): Endpoint {
    const now = Date.now();
    const awake = this.endpoints.filter((ep) => ep.restUntil <= now);
    const pool = awake.length ? awake : this.endpoints;
    const free = (ep: Endpoint) => Math.max(ep.readyAt, ep.restUntil);
    return pool.reduce((best, ep) => (free(ep) < free(best) ? ep : best));
  }

  override sendJsonRpc: JsonRpcProvider['sendJsonRpc'] = async (method, params) => {
    if (this.waiting >= this.maxWaiting)
      throw new DomainError('unavailable', 'The NEAR RPC is busy; try again shortly');
    this.waiting++;
    try {
      return await this.paced(method, params);
    } finally {
      this.waiting--;
    }
  };

  private paced: JsonRpcProvider['sendJsonRpc'] = async (method, params) => {
    const started = Date.now();
    for (;;) {
      const ep = this.choose();
      const now = Date.now();
      const start = Math.max(now, ep.readyAt, ep.restUntil);
      ep.readyAt = start + this.spacingMs;
      if (start > now) await new Promise((r) => setTimeout(r, start - now));
      try {
        // Forwarded unchanged; the base signature is generic over the RPC method map.
        const answer = await ep.rpc.sendJsonRpc(method as never, params as never);
        ep.strikes = 0;
        return answer as never;
      } catch (err) {
        if (!rateLimited(err) && !transportFailure(err)) throw err;
        ep.strikes++;
        ep.restUntil = Date.now() + Math.min(30_000, 1_000 * 2 ** (ep.strikes - 1));
        if (Date.now() - started > this.deadlineMs) throw err;
      }
    }
  };
}

/** Read-only and signing access to one NEAR RPC. */
export class NearClient {
  readonly provider: JsonRpcProvider;
  /** One transaction at a time per signing account, so two never take the same nonce. */
  private readonly sending = new Map<string, Promise<unknown>>();

  constructor(
    readonly rpcUrl: string,
    options: RpcOptions = {},
  ) {
    this.provider = new PacedProvider(
      [rpcUrl, ...(options.fallbackUrls ?? [])],
      options.maxPerSecond,
      options.maxWaiting,
      options.deadlineMs,
    );
  }

  async view<T>(
    contractId: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return (await this.provider.callFunction({ contractId, method, args })) as T;
  }

  account(accountId: string, key: KeyPairString): Account {
    return new Account(accountId, this.provider, key);
  }

  async send<T = unknown>(
    signer: Account,
    receiverId: string,
    txActions: Action[],
  ): Promise<TxOutcome<T> & { raw: RawOutcome }> {
    const previous = this.sending.get(signer.accountId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const raw = (await signer.signAndSendTransaction({
          receiverId,
          actions: txActions,
          throwOnFailure: false,
          waitUntil: 'FINAL',
        })) as unknown as RawOutcome;
        return { ...readOutcome<T>(raw), raw };
      });
    this.sending.set(signer.accountId, run);
    try {
      return await run;
    } finally {
      if (this.sending.get(signer.accountId) === run) this.sending.delete(signer.accountId);
    }
  }

  call<T = unknown>(
    signer: Account,
    contractId: string,
    method: string,
    args: object,
    options: CallOptions = {},
  ) {
    return this.send<T>(signer, contractId, [
      actions.functionCall(method, args, teraToGas(options.gasTera ?? 100), options.deposit ?? 0n),
    ]);
  }

  /** Full-access keys only: the ones that could move funds or replace code. */
  async fullAccessKeyCount(accountId: string): Promise<number> {
    const list = await this.provider.viewAccessKeyList({ accountId });
    return list.keys.filter((k) => k.access_key.permission === 'FullAccess').length;
  }

  async accessKeyCount(accountId: string): Promise<number> {
    const list = await this.provider.viewAccessKeyList({ accountId });
    return list.keys.length;
  }

  async accountState(accountId: string) {
    return this.provider.viewAccount({ accountId });
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.provider.viewAccount({ accountId });
      return true;
    } catch {
      return false;
    }
  }

  /** Chain time in ms from the latest final block: the enclave trusts this, not the host clock. */
  async chainTimeMs(): Promise<number> {
    const block = await this.provider.viewBlock({ finality: 'final' });
    return Math.floor(Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n));
  }

  async genesisHash(): Promise<string> {
    const block = await this.provider.viewBlock({ blockId: 0 } as never).catch(() => null);
    if (block) return block.header.hash;
    const status = (await this.provider.viewNodeStatus()) as unknown as {
      genesis_hash?: string;
      sync_info: { earliest_block_hash: string };
    };
    return status.genesis_hash ?? status.sync_info.earliest_block_hash;
  }

  /**
   * Sandbox only: moves the chain forward n blocks (and time with it). The sandbox's transaction
   * validity window is 100 blocks and transactions are signed against the final block, so it jumps
   * at most 50 blocks at a time and lets finality catch up after each; otherwise transactions
   * signed around the jump expire.
   */
  async fastForward(blocks: number, options: { settle?: boolean } = {}): Promise<void> {
    // With nothing in flight (a fresh bootstrap) there is nothing to protect: big jumps, no waits.
    // They are still split so no single request runs long enough to time out on a busy machine.
    if (options.settle === false) {
      for (let left = blocks; left > 0; left -= UNSETTLED_STEP)
        await this.jump(Math.min(UNSETTLED_STEP, left));
      return;
    }
    for (let left = blocks; left > 0; left -= FAST_FORWARD_STEP) {
      await this.jump(Math.min(FAST_FORWARD_STEP, left));
      await this.awaitFinality();
    }
  }

  private async jump(step: number): Promise<void> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ff',
        method: 'sandbox_fast_forward',
        params: { delta_height: step },
      }),
    });
    const body = (await res.json()) as { error?: unknown };
    if (body.error) throw new Error(`sandbox_fast_forward failed: ${JSON.stringify(body.error)}`);
  }

  /** Waits (briefly) until the final block is close to the head again. */
  private async awaitFinality(): Promise<void> {
    const deadline = Date.now() + FINALITY_WAIT_MS;
    while (Date.now() < deadline) {
      const [head, final] = await Promise.all([
        this.provider.viewBlock({ finality: 'optimistic' }),
        this.provider.viewBlock({ finality: 'final' }),
      ]);
      if (head.header.height - final.header.height <= FINALITY_LAG_BLOCKS) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
