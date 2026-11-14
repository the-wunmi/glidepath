import type { Account } from '@glidepath/near';
import { describe, expect, it } from 'vitest';
import { OutLayerClient } from '../src/outlayer.ts';

/** A stand-in relayer account: each one signs with the nonce it cached when it was made. */
function fakeAccount(nonce: number, send: () => Promise<unknown>) {
  const signedNonces: number[] = [];
  const account = {
    accountId: 'relayer.testnet',
    provider: { sendTransactionUntil: send },
    async createSignedTransaction() {
      signedNonces.push(nonce);
      return { transaction: { encode: () => new Uint8Array([nonce++]) } };
    },
  };
  return { account: account as unknown as Account, signedNonces };
}

describe('the OutLayer client', () => {
  it('reads the nonce again after another sender took it', async () => {
    // The first account cached a nonce that other code has since used; the chain refuses it.
    const stale = fakeAccount(100, async () => {
      throw new Error('InvalidNonceError: Invalid nonce (ak: 500, tx: 101)');
    });
    // A fresh account reads the key's current nonce; this send fails for another reason, which
    // ends the run without waiting for an outcome.
    const fresh = fakeAccount(501, async () => {
      throw new Error('boom');
    });
    const made = [stale, fresh];
    let calls = 0;
    const client = new OutLayerClient(() => {
      const next = made[calls++];
      if (!next) throw new Error('no more accounts');
      return next.account;
    }, 'outlayer.testnet');

    await expect(
      client.run({ wasm: { url: 'https://x/y.wasm', sha256: 'ab' } }, {}),
    ).rejects.toThrow('boom');
    expect(calls).toBe(2);
    expect(stale.signedNonces).toEqual([100]);
    expect(fresh.signedNonces).toEqual([501]);
  });
});
