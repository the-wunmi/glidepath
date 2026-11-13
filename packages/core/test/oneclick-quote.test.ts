import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  base58Decode,
  ONECLICK_LIVE_QUOTE_KEY,
  oneclickQuoteMessage,
  oneclickSignedBytes,
  parseNearKey,
  parseQuoteTerms,
  quoteCostWithinBound,
  stableStringify,
} from '../src/index.ts';

const root = new URL('../../../', import.meta.url);
const live = JSON.parse(
  readFileSync(new URL('data/oneclick/live-quote-2026-11-11.json', root), 'utf8'),
);
const vectors = JSON.parse(
  readFileSync(new URL('contracts/res/oneclick-quote-vectors.json', root), 'utf8'),
);
const verify = (q: string, signature: string, key: string) =>
  ed25519.verify(
    base58Decode(signature.slice('ed25519:'.length)),
    oneclickSignedBytes(q),
    parseNearKey(key).bytes,
  );

describe("1Click's quote signature", () => {
  it('rebuilds the exact message a live 1Click quote was signed over', () => {
    const q = oneclickQuoteMessage(live);
    expect(q).toBe(vectors.live.q);
    expect(new TextDecoder().decode(oneclickSignedBytes(q))).toBe(vectors.live.signed_message);
    expect(verify(q, live.signature, ONECLICK_LIVE_QUOTE_KEY)).toBe(true);
  });

  it('rejects the live signature on a tampered copy', () => {
    expect(verify(vectors.live.tampered_q, live.signature, ONECLICK_LIVE_QUOTE_KEY)).toBe(false);
  });

  it('leaves appFees out of the message: it is not covered by the signature', () => {
    expect(live.quoteRequest.appFees).toBeDefined();
    expect(vectors.live.q).not.toContain('appFees');
  });

  it('verifies the simulator-key vectors the registry tests use', () => {
    for (const c of [vectors.sim.ordinary, vectors.sim.too_costly])
      expect(verify(c.q, c.signature, vectors.sim.public_key)).toBe(true);
  });

  it('bounds the cost at 50 bps of the input value plus $1.00', () => {
    // Live: $3.65 in, $3.6389 out, a 30 bps cost.
    expect(quoteCostWithinBound(parseQuoteTerms(vectors.live.q))).toBe(true);
    expect(quoteCostWithinBound({ amountInUsd: '1000', amountOutUsd: '994.000001' })).toBe(true);
    expect(quoteCostWithinBound({ amountInUsd: '1000', amountOutUsd: '993.999999' })).toBe(false);
    expect(quoteCostWithinBound({ amountInUsd: '2', amountOutUsd: '0.99' })).toBe(true);
    expect(quoteCostWithinBound(parseQuoteTerms(vectors.sim.too_costly.q))).toBe(false);
  });

  it('stable-stringifies with sorted keys and drops undefined members', () => {
    expect(stableStringify({ b: 1, a: [2, undefined], c: undefined, d: { z: 'x', y: null } })).toBe(
      '{"a":[2,null],"b":1,"d":{"y":null,"z":"x"}}',
    );
  });
});
