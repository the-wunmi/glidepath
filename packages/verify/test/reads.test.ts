import { describe, expect, it } from 'vitest';
import {
  concurrencyLimit,
  retryAfterMs,
  TransientReadError,
  transientStatus,
  withRetry,
} from '../src/reads.ts';

const noWait = { sleep: async () => {}, random: () => 0.5 };

describe('chain reads from the verifier page', () => {
  it('retry a busy endpoint until it answers', async () => {
    let calls = 0;
    const answer = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new TransientReadError('busy');
      return 'receipt';
    }, noWait);
    expect(answer).toBe('receipt');
    expect(calls).toBe(3);
  });

  it('give up after the last attempt with the endpoint’s own message', async () => {
    let calls = 0;
    const out = withRetry(
      async () => {
        calls++;
        throw new TransientReadError('The EVM RPC is busy');
      },
      { ...noWait, attempts: 4 },
    );
    await expect(out).rejects.toThrow('The EVM RPC is busy');
    expect(calls).toBe(4);
  });

  it('do not retry an answer that is an error', async () => {
    let calls = 0;
    const out = withRetry(async () => {
      calls++;
      throw new Error('AccountDoesNotExistError');
    }, noWait);
    await expect(out).rejects.toThrow('AccountDoesNotExistError');
    expect(calls).toBe(1);
  });

  it('back off exponentially, and wait at least as long as Retry-After asks', async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new TransientReadError('busy');
        if (calls === 2) throw new TransientReadError('busy');
        if (calls === 3) throw new TransientReadError('busy', 5_000);
        return 'ok';
      },
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
        random: () => 0.999,
        baseDelayMs: 500,
      },
    );
    expect(waits[0]).toBeCloseTo(500, -1);
    expect(waits[1]).toBeCloseTo(1_000, -1);
    expect(waits[2]).toBe(5_000);
  });

  it('treat rate limits and gateway failures as transient, and refusals as final', () => {
    for (const s of [429, 502, 503, 504]) expect(transientStatus(s)).toBe(true);
    for (const s of [200, 400, 403, 404]) expect(transientStatus(s)).toBe(false);
    expect(retryAfterMs('2')).toBe(2_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
  });

  it('run at most the limit at once, and every task to the end', async () => {
    const limit = concurrencyLimit(3);
    let open = 0;
    let peak = 0;
    const done = await Promise.all(
      Array.from({ length: 19 }, (_, i) =>
        limit(async () => {
          open++;
          peak = Math.max(peak, open);
          await new Promise((r) => setTimeout(r, 5));
          open--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(done).toEqual(Array.from({ length: 19 }, (_, i) => i));
  });
});
