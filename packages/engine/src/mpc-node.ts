import { deriveSecretKey, signPayload } from '@glidepath/chainsig';
import { hexToBytes } from '@glidepath/core';
import type { Account, NearClient } from '@glidepath/near';

interface PendingRequest {
  request: { tweak: string; payload: string; domain_id: number };
  yield_ids: string[];
  predecessor: string;
  path: string;
  block_height: number;
}

/** Each pass answers at most this many requests, so one slow pass never piles up. */
const MAX_PER_PASS = 10;

/**
 * The simulated MPC network. The real network's nodes watch v1.signer for sign requests and
 * answer with a threshold signature; this single node watches the signer simulator and signs
 * with root secret + tweak, which yields the same signature a correct threshold run would.
 */
export function createMpcNode(
  near: NearClient,
  signerContract: string,
  node: Account,
  rootSecretHex: string,
) {
  const answering = new Set<string>();

  async function pass(): Promise<number> {
    const pending = await near.view<PendingRequest[]>(signerContract, 'pending_requests', {
      limit: MAX_PER_PASS,
    });
    let answered = 0;
    for (const p of pending) {
      const key = `${p.request.tweak}:${p.request.payload}`;
      if (answering.has(key)) continue;
      answering.add(key);
      try {
        const secret = deriveSecretKey(rootSecretHex, BigInt(`0x${p.request.tweak}`));
        const response = signPayload(secret, hexToBytes(p.request.payload));
        await near.call(
          node,
          signerContract,
          'respond',
          { request: p.request, response },
          { gasTera: 100 },
        );
        answered += 1;
      } finally {
        answering.delete(key);
      }
    }
    return answered;
  }

  return { pass };
}
