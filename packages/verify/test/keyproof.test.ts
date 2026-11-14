import { readFileSync } from 'node:fs';
import { fromBase64, toBase64 } from '@vsp/core';
import { describe, expect, it } from 'vitest';
import { type KeyProofInput, verifyKeyProof } from '../src/keyproof.ts';
import { parseTdxQuote } from '../src/tdx.ts';

const data = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));

/** The current build's key-proof run: OutLayer's attestation record and the NEAR transaction's output. */
const record = data('data/outlayer/attestation-cxmt7H2q7p83PWaJzR1RWQij8VyhjbjGkkf3ZyZGnVo.json');
const tx = data('data/outlayer/keyproof-tx-cxmt7H2q7p83PWaJzR1RWQij8VyhjbjGkkf3ZyZGnVo.json');
/** The build the fixture belongs to: the record keeps earlier builds in `previous`. */
const record_ = data('deployments/outlayer-testnet.json');
const deployment = [record_, ...record_.previous, ...(record_.backups ?? [])].find(
  (b: { keyProof: { txHash: string } }) =>
    b.keyProof.txHash === 'cxmt7H2q7p83PWaJzR1RWQij8VyhjbjGkkf3ZyZGnVo',
);

const input: KeyProofInput = {
  record,
  quoteReportData: parseTdxQuote(fromBase64(record.tdx_quote)).body.reportData,
  txSuccessValue: tx.success_value,
  registeredKey: deployment.signingKey,
  encryptionKeyHex: deployment.encryptionKeyHex,
  wasmSha256: deployment.wasm.sha256,
};

const failing = (i: KeyProofInput) =>
  verifyKeyProof(i)
    .checks.filter((c) => !c.ok)
    .map((c) => c.label);

describe('the enclave key proof', () => {
  it('ties the live enclave’s encryption key to its quote, through the run and the chain', () => {
    const r = verifyKeyProof(input);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('refuses an encryption key the proof does not name, as a hostile server would serve', () => {
    expect(failing({ ...input, encryptionKeyHex: 'ab'.repeat(32) })).toEqual([
      'Plans are sealed to the encryption key that proof names',
    ]);
  });

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
    expect(failing({ ...input, quoteReportData: '00'.repeat(64) })).toEqual([
      'The quote commits to the run that proved the enclave’s keys',
    ]);
    expect(failing({ ...input, wasmSha256: '11'.repeat(32) })).toEqual([
      'That run executed the published module',
    ]);
  });
});
