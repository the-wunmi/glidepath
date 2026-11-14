/**
 * How the verifier page reads chains through public endpoints: a few requests at a time, each
 * retried with backoff while the endpoint says it is busy, then a plain failure the page can show.
 */

/** A read that failed in a way a later attempt may not (rate limit, overload, network, timeout). */
export class TransientReadError extends Error {
  constructor(
    message: string,
    /** The endpoint's Retry-After, when it gave one. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'TransientReadError';
  }
}

/** HTTP statuses that mean "not now" rather than "no". */
export const transientStatus = (status: number) =>
  status === 408 || status === 429 || status === 502 || status === 503 || status === 504;

/** Retry-After in ms (seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export interface RetryOptions {
  /** Tries in all, the first included. */
  attempts?: number;
  /** The first wait; each later one doubles, up to maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1); spreads retries so a page's requests do not return in lockstep. */
  random?: () => number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `read`, retrying a TransientReadError with exponential backoff (or the endpoint's
 * Retry-After when longer). Any other error, and the last transient one, is thrown as it is.
 */
export async function withRetry<T>(read: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 8_000,
    sleep = wait,
    random = Math.random,
  } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof TransientReadError) || attempt >= attempts) throw error;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = backoff / 2 + random() * (backoff / 2);
      await sleep(Math.max(jittered, Math.min(error.retryAfterMs ?? 0, maxDelayMs)));
    }
  }
}

/** Wraps tasks so at most `max` run at once; the rest wait their turn in order. */
export function concurrencyLimit(max: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    while (running >= max) await new Promise<void>((r) => queue.push(r));
    running++;
    try {
      return await task();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
}
