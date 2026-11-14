import {
  BaseError,
  type Chain,
  createPublicClient,
  fallback,
  HttpRequestError,
  http,
  LimitExceededRpcError,
  type PublicClient,
  TimeoutError,
  type Transport,
} from 'viem';

export interface RpcPacing {
  /** Most request starts per second to any one endpoint (default: unpaced). */
  maxPerSecond?: number;
  /** Most requests in flight to any one endpoint at once (default: unbounded). */
  maxInFlight?: number;
  /**
   * Most requests queued or in flight across all endpoints; beyond it a request fails at once
   * with RpcBusyError rather than queueing behind a flood (default: unbounded).
   */
  maxWaiting?: number;
}

/** Every endpoint is resting or the queue is full; the caller should try again shortly. */
export class RpcBusyError extends Error {
  constructor(message = 'The EVM RPC is busy') {
    super(message);
    this.name = 'RpcBusyError';
  }
}

/**
 * Whether an error means the endpoint could not answer (rate limit, overload, timeout, network)
 * rather than that it answered with an error. Only these move a request to the next endpoint's
 * turn and make an endpoint rest.
 */
export function rpcUnavailable(error: unknown): boolean {
  if (error instanceof RpcBusyError) return true;
  if (!(error instanceof BaseError)) return false;
  const found = error.walk(
    (e) =>
      e instanceof HttpRequestError ||
      e instanceof TimeoutError ||
      e instanceof RpcBusyError ||
      [LimitExceededRpcError.code, 429, -32007].includes((e as { code?: number }).code ?? 0),
  );
  if (found instanceof HttpRequestError) {
    // No status: the request never got an answer (refused, reset, DNS).
    const status = found.status;
    return status === undefined || status === 408 || status === 429 || status >= 500;
  }
  return found !== null;
}

const REST_MS = 1_000;
const MAX_REST_MS = 30_000;
/** One endpoint's answer must come within this long, so a stalled node hands over to the next. */
const ENDPOINT_TIMEOUT_MS = 10_000;

/**
 * One endpoint with its own pacing. After a refusal or failure it rests (1 s, doubling to 30 s)
 * and refuses at once while resting, so the fallback moves on to the next endpoint.
 */
function pacedEndpoint(url: string, pacing: RpcPacing): Transport {
  const spacingMs = pacing.maxPerSecond ? 1000 / pacing.maxPerSecond : 0;
  const maxInFlight = pacing.maxInFlight ?? Number.POSITIVE_INFINITY;
  const base = http(url, { retryCount: 0, timeout: ENDPOINT_TIMEOUT_MS });
  let readyAt = 0;
  let restUntil = 0;
  let strikes = 0;
  let inFlight = 0;
  const queue: (() => void)[] = [];

  // fallback() builds its transports anew for every request, so the state lives out here.
  return (params) => {
    const t = base(params);
    type Request = typeof t.request;
    const request = (async (...args: Parameters<Request>) => {
      if (Date.now() < restUntil) throw new RpcBusyError();
      while (inFlight >= maxInFlight) await new Promise<void>((r) => queue.push(r));
      inFlight++;
      try {
        const now = Date.now();
        const start = Math.max(now, readyAt);
        readyAt = start + spacingMs;
        if (start > now) await new Promise((r) => setTimeout(r, start - now));
        const answer = await t.request(...args);
        strikes = 0;
        return answer;
      } catch (error) {
        if (rpcUnavailable(error)) {
          strikes++;
          restUntil = Date.now() + Math.min(MAX_REST_MS, REST_MS * 2 ** (strikes - 1));
        }
        throw error;
      } finally {
        inFlight--;
        queue.shift()?.();
      }
    }) as Request;
    return { ...t, request };
  };
}

/**
 * Public endpoints in order of preference, each paced on its own; viem's fallback hands a request
 * to the next endpoint on any error but a revert or a rejection, and retries the round twice.
 * Re-sending a signed transaction to another endpoint is safe: it is the same transaction, with the
 * same hash.
 */
export function publicRpcTransport(urls: string[], pacing: RpcPacing = {}): Transport {
  const endpoints = urls.map((u) => pacedEndpoint(u, pacing));
  const inner = fallback(endpoints, { retryCount: 2, retryDelay: 250 });
  const maxWaiting = pacing.maxWaiting ?? Number.POSITIVE_INFINITY;
  let waiting = 0;
  return (params) => {
    const t = inner(params);
    type Request = typeof t.request;
    const request = (async (...args: Parameters<Request>) => {
      if (waiting >= maxWaiting) throw new RpcBusyError();
      waiting++;
      try {
        return await t.request(...args);
      } finally {
        waiting--;
      }
    }) as Request;
    return { ...t, request };
  };
}

/** A read-only client over publicRpcTransport, with its own pacing budget. */
export const publicRpcClient = (
  urls: string[],
  pacing: RpcPacing = {},
  chain?: Chain,
): PublicClient => createPublicClient({ chain, transport: publicRpcTransport(urls, pacing) });
