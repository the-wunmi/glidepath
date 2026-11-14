import { fromBase64, toBase64 } from '@glidepath/core';
import { describe, expect, it } from 'vitest';
import { type KeyProofInput, verifyKeyProof } from '../src/keyproof.ts';
import { parseTdxQuote } from '../src/tdx.ts';
import { build, record, SIGNATURE_ROWS, signedUnderCurrentDomain, tx } from './outlayer-fixture.ts';

/** The key-proof run on file (outlayer-fixture.ts) and the build it proved. */
const input: KeyProofInput = {
  record,
  quoteReportData: parseTdxQuote(fromBase64(record.tdx_quote)).body.reportData,
  txSuccessValue: tx.success_value,
  registeredKey: build.signingKey,
  encryptionKeyHex: build.encryptionKeyHex,
  wasmSha256: build.wasm.sha256,
};

/** Rows other than the proof's signature, for a run on file signed under another domain. */
const unsigned = (labels: string[]) =>
  signedUnderCurrentDomain ? labels : labels.filter((l) => !SIGNATURE_ROWS.includes(l));

const failing = (i: KeyProofInput) =>
  verifyKeyProof(i)
    .checks.filter((c) => !c.ok)
    .map((c) => c.label);

describe('the enclave key proof', () => {
  it.runIf(signedUnderCurrentDomain)(
    'ties the live enclave’s encryption key to its quote, through the run and the chain',
    () => {
      const r = verifyKeyProof(input);
      expect(r.checks.filter((c) => !c.ok)).toEqual([]);
      expect(r.ok).toBe(true);
    },
  );

  it.runIf(signedUnderCurrentDomain)(
    'refuses an encryption key the proof does not name, as a hostile server would serve',
    () => {
      expect(failing({ ...input, encryptionKeyHex: 'ab'.repeat(32) })).toEqual([
        'Plans are sealed to the encryption key that proof names',
      ]);
    },
  );

  it('refuses a proof the registered key did not sign', () => {
    const other = 'ed25519:5HrfcRs5fLyx3MGib9UoQqbrZGVqivQsvEKCCg5BbEY9';
    expect(failing({ ...input, registeredKey: other })).toEqual([
      'The output is a key proof signed by the registered key',
      'Plans are sealed to the encryption key that proof names',
    ]);
  });

  it('refuses an output other than the one the quoted run produced', () => {
    const out = fromBase64(input.txSuccessValue);
    out[out.length - 3] = (out[out.length - 3] ?? 0) ^ 1;
    expect(failing({ ...input, txSuccessValue: toBase64(out) })).toContain(
      'Its output is what the NEAR transaction returned',
    );
  });

  it('refuses a quote from another run, and a run of another module', () => {
    expect(unsigned(failing({ ...input, quoteReportData: '00'.repeat(64) }))).toEqual([
      'The quote commits to the run that proved the enclave’s keys',
    ]);
    expect(unsigned(failing({ ...input, wasmSha256: '11'.repeat(32) }))).toEqual([
      'That run executed the published module',
    ]);
  });
});
