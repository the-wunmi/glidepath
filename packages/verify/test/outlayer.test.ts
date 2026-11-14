import { fromBase64, parseNearKey, toBase64, utf8ToBytes } from '@glidepath/core';
import type { ChainPlan, ChainReceipt } from '@glidepath/near';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { REVOCATION_LABEL, TCB_LABEL_PREFIX } from '../src/collateral.ts';
import { verifyReceipt } from '../src/index.ts';
import {
  checkOutlayerEnclave,
  checkState,
  type EnclaveCheck,
  EVIDENCE_UNREAD_LABEL,
  fetchOutlayerEvidence,
  keyProofChecks,
  type OutlayerReads,
  outlayerChecks,
} from '../src/outlayer.ts';
import { TDX_CHECK_LABELS } from '../src/tdx.ts';
import {
  build,
  collateral,
  enclave,
  evidence,
  file,
  identity,
  KEY_PROOF_TX,
  NOW,
  pcsFiles,
  quoteBytes,
  recordText,
  SIGNATURE_ROWS,
  signedUnderCurrentDomain,
  tx,
} from './outlayer-fixture.ts';

const failing = (rows: EnclaveCheck[]) => rows.filter((c) => !c.ok).map((c) => c.label);
const warnings = (rows: EnclaveCheck[]) => rows.filter((c) => checkState(c) === 'warn');

/** Serves the fixture's files the way OutLayer, NEAR and the site's /api/pcs pass-through do. */
function fixtureReads(over: Partial<OutlayerReads> = {}) {
  const calls: string[] = [];
  const bytes = (path: string) => new Uint8Array(file(path));
  const chain = (path: string) => encodeURIComponent(file(path).toString('utf8'));
  const reads: OutlayerReads = {
    fetch: async (url) => {
      calls.push(`fetch ${url}`);
      return url === identity.quote.attestation_url
        ? new Response(recordText, { headers: { 'content-type': 'application/json' } })
        : new Response('not found', { status: 404 });
    },
    txSuccessValue: async (hash, sender) => {
      calls.push(`tx ${hash} ${sender}`);
      return hash === tx.tx_hash && sender === tx.sender ? tx.success_value : null;
    },
    pcs: async (path) => {
      calls.push(`pcs ${path}`);
      if (path === 'tdx/tcb?fmspc=B0C06F000000')
        return new Response(bytes(pcsFiles.tcbInfo), {
          headers: { 'tcb-info-issuer-chain': chain(pcsFiles.tcbInfoChain) },
        });
      if (path === 'tdx/qe-identity')
        return new Response(bytes(pcsFiles.qeIdentity), {
          headers: { 'sgx-enclave-identity-issuer-chain': chain(pcsFiles.qeIdentityChain) },
        });
      if (path === 'pckcrl?ca=platform') return new Response(bytes(pcsFiles.pckCrl));
      if (path === 'rootcacrl') return new Response(bytes(pcsFiles.rootCaCrl));
      return new Response('unknown', { status: 404 });
    },
    ...over,
  };
  return { reads, calls };
}

describe('the quote and Intel’s collateral', () => {
  it('passes the live quote against its pinned registration and Intel’s signed collateral', () => {
    const rows = outlayerChecks(enclave, quoteBytes, collateral, { now: NOW });
    expect(failing(rows)).toEqual([]);
    // Every TDX check, then revocation and the machine's TCB status.
    const tdx = Object.values(TDX_CHECK_LABELS);
    expect(rows.slice(0, tdx.length).map((r) => r.label)).toEqual(tdx);
    const rest = rows.slice(tdx.length);
    expect(rest.map((r) => r.label)).toContain(REVOCATION_LABEL);
    expect(rest.some((r) => r.label.startsWith(TCB_LABEL_PREFIX))).toBe(true);
  });

  it('fails a quote the registry did not pin, and code other than the measured code', () => {
    expect(
      failing(
        outlayerChecks({ ...enclave, quote_hash: '00'.repeat(32) }, quoteBytes, collateral, {
          now: NOW,
        }),
      ),
    ).toEqual([TDX_CHECK_LABELS.quote_hash]);
    const moved = { ...enclave.measurements, rtmr3: '11'.repeat(48) };
    expect(
      failing(
        outlayerChecks({ ...enclave, measurements: moved }, quoteBytes, collateral, { now: NOW }),
      ).some((l) => l.startsWith('Measurements match')),
    ).toBe(true);
  });

  it('warns, without failing, when Intel’s collateral could not be read', () => {
    const rows = outlayerChecks(enclave, quoteBytes, { error: 'HTTP 503' }, { now: NOW });
    expect(failing(rows)).toEqual([]);
    expect(warnings(rows).length).toBeGreaterThan(0);
    expect(warnings(rows).every((r) => r.detail?.includes('HTTP 503'))).toBe(true);
  });

  it('fails a revocation list that Intel did not sign', () => {
    const pckCrl = collateral.pckCrl.slice();
    pckCrl[pckCrl.length - 10] = (pckCrl[pckCrl.length - 10] ?? 0) ^ 1;
    expect(
      failing(outlayerChecks(enclave, quoteBytes, { ...collateral, pckCrl }, { now: NOW })),
    ).toEqual([REVOCATION_LABEL]);
  });

  it('stops at the quote when its bytes do not parse', () => {
    const rows = outlayerChecks(enclave, quoteBytes.slice(0, 100), collateral, { now: NOW });
    expect(failing(rows).length).toBeGreaterThan(0);
    expect(rows.some((r) => r.label === REVOCATION_LABEL)).toBe(false);
  });
});

describe('the key proof', () => {
  it('passes every row that does not need the proof’s signature', () => {
    const rows = keyProofChecks(enclave, identity, evidence);
    expect(rows).toHaveLength(5);
    expect(failing(rows).filter((l) => !SIGNATURE_ROWS.includes(l))).toEqual([]);
  });

  it.runIf(signedUnderCurrentDomain)('ties the encryption key to the quote, end to end', () => {
    expect(failing(checkOutlayerEnclave(enclave, identity, evidence, { now: NOW }))).toEqual([]);
  });

  it.runIf(signedUnderCurrentDomain)('refuses an encryption key the proof does not name', () => {
    expect(
      failing(
        keyProofChecks(enclave, { ...identity, encryptionKeyHex: 'ab'.repeat(32) }, evidence),
      ),
    ).toEqual(['Plans are sealed to the encryption key that proof names']);
  });

  it.skipIf(signedUnderCurrentDomain)(
    'fails only the signature rows for a proof signed under another domain',
    () => {
      expect(failing(keyProofChecks(enclave, identity, evidence))).toEqual(SIGNATURE_ROWS);
      // The proof on file is genuine: the registered key signed it under the product's first domain.
      const out = JSON.parse(new TextDecoder().decode(fromBase64(tx.success_value)));
      expect(
        ed25519.verify(
          fromBase64(out.result.signature),
          utf8ToBytes(`vsp/key-proof/v1\n${out.result.json}`),
          parseNearKey(build.signingKey).bytes,
        ),
      ).toBe(true);
    },
  );

  it('refuses a proof the registered key did not sign', () => {
    const other = {
      ...enclave,
      public_key: 'ed25519:5HrfcRs5fLyx3MGib9UoQqbrZGVqivQsvEKCCg5BbEY9',
    };
    expect(failing(keyProofChecks(other, identity, evidence))).toEqual(SIGNATURE_ROWS);
  });

  it('refuses an output other than the run’s, a missing output, and another module', () => {
    const out = fromBase64(tx.success_value);
    out[out.length - 3] = (out[out.length - 3] ?? 0) ^ 1;
    expect(
      failing(keyProofChecks(enclave, identity, { ...evidence, keyProofOutput: toBase64(out) })),
    ).toContain('Its output is what the NEAR transaction returned');
    expect(
      failing(keyProofChecks(enclave, identity, { ...evidence, keyProofOutput: null })),
    ).toContain('Its output is what the NEAR transaction returned');
    expect(
      failing(
        keyProofChecks(
          enclave,
          { ...identity, quote: { ...identity.quote, wasm_sha256: '11'.repeat(32) } },
          evidence,
        ),
      ),
    ).toContain('That run executed the published module');
  });
});

describe('every check of a build', () => {
  it('fails with one row when the key has no registry entry or no evidence', () => {
    expect(checkOutlayerEnclave(null, identity, evidence)).toEqual([
      { label: EVIDENCE_UNREAD_LABEL, ok: false },
    ]);
    expect(checkOutlayerEnclave(enclave, identity, null)).toEqual([
      { label: EVIDENCE_UNREAD_LABEL, ok: false },
    ]);
    expect(checkOutlayerEnclave(enclave, identity, { error: 'HTTP 502' })).toEqual([
      { label: EVIDENCE_UNREAD_LABEL, ok: false, detail: 'HTTP 502' },
    ]);
  });

  it('runs the quote, collateral and key-proof rows in order', () => {
    const rows = checkOutlayerEnclave(enclave, identity, evidence, { now: NOW });
    const quoteRows = outlayerChecks(enclave, quoteBytes, collateral, { now: NOW });
    expect(rows).toEqual([...quoteRows, ...keyProofChecks(enclave, identity, evidence)]);
  });
});

describe('reading the evidence', () => {
  it('reads the record, the run’s output at the hash and caller it names, and Intel’s collateral', async () => {
    const { reads, calls } = fixtureReads();
    const ev = await fetchOutlayerEvidence(identity.quote.attestation_url, reads);
    expect(ev.quote).toEqual(quoteBytes);
    expect(ev.keyProofOutput).toBe(tx.success_value);
    expect(ev.collateral).toEqual(collateral);
    expect(calls).toContain(`tx ${KEY_PROOF_TX} ${tx.sender}`);
    expect(calls.filter((c) => c.startsWith('pcs ')).sort()).toEqual([
      'pcs pckcrl?ca=platform',
      'pcs rootcacrl',
      'pcs tdx/qe-identity',
      'pcs tdx/tcb?fmspc=B0C06F000000',
    ]);
    expect(checkOutlayerEnclave(enclave, identity, ev, { now: NOW })).toEqual(
      checkOutlayerEnclave(enclave, identity, evidence, { now: NOW }),
    );
  });

  it('keeps unreadable collateral as its reason, which the checks show as a warning', async () => {
    const { reads } = fixtureReads({ pcs: async () => new Response('busy', { status: 503 }) });
    const ev = await fetchOutlayerEvidence(identity.quote.attestation_url, reads);
    expect(ev.collateral).toEqual({ error: 'Intel’s collateral could not be read (HTTP 503)' });
    const rows = outlayerChecks(enclave, ev.quote, ev.collateral, { now: NOW });
    expect(failing(rows)).toEqual([]);
    expect(warnings(rows).length).toBeGreaterThan(0);
  });

  it('throws when the record cannot be read or carries no quote', async () => {
    await expect(
      fetchOutlayerEvidence('https://example.invalid/x', fixtureReads().reads),
    ).rejects.toThrow('OutLayer’s attestation record could not be read (HTTP 404)');
    const { reads } = fixtureReads({
      fetch: async () => Response.json({ ...JSON.parse(recordText), tdx_quote: undefined }),
    });
    await expect(fetchOutlayerEvidence(identity.quote.attestation_url, reads)).rejects.toThrow(
      'OutLayer’s attestation record has no quote',
    );
  });
});

describe('a receipt signed by an OutLayer build', () => {
  // The receipt is checked only as far as its attestation rows: its other rows have their own tests.
  const receipt = {
    plan_id: 1,
    seq: 0,
    kind: 'sale',
    // Unreadable on purpose: verification stops right after the attestation rows.
    request_json: 'unreadable',
    signature: toBase64(new Uint8Array(64)),
    enclave_key: enclave.public_key,
    created_at_ms: 1,
    status: 'done',
  } as unknown as ChainReceipt;
  const plan = {} as ChainPlan;
  const attestationRows = async (rows: EnclaveCheck[]) =>
    (await verifyReceipt(receipt, plan, [enclave], { outlayer: rows })).checks.filter((c) =>
      c.id.startsWith('attestation'),
    );

  it('carries the build’s rows in, with warnings as warnings', async () => {
    const rows = outlayerChecks(enclave, quoteBytes, { error: 'HTTP 503' }, { now: NOW });
    const out = await attestationRows(rows);
    expect(out.map((c) => c.label)).toEqual(rows.map((r) => r.label));
    expect(out.map((c) => c.status)).toEqual(rows.map(checkState));
    expect(out.every((c, i) => c.id === `attestation-outlayer-${i}`)).toBe(true);
    expect(out.filter((c) => c.status === 'warn').every((c) => c.detail)).toBe(true);
    const result = await verifyReceipt(receipt, plan, [enclave], { outlayer: rows });
    expect(result.simulatedAttestation).toBe(false);
  });

  it('fails the receipt on a failed row', async () => {
    const rows = checkOutlayerEnclave(enclave, identity, { error: 'HTTP 502' });
    expect(await attestationRows(rows)).toEqual([
      {
        id: 'attestation-outlayer-0',
        label: EVIDENCE_UNREAD_LABEL,
        status: 'fail',
        detail: 'HTTP 502',
      },
    ]);
  });

  it('fails when no rows came with the key, or the key is not on the allowlist', async () => {
    expect((await attestationRows([])).map((c) => c.label)).toEqual([
      'Attestation quote available for the signing key',
    ]);
    const unlisted = await verifyReceipt(receipt, plan, [], {
      outlayer: [{ label: 'x', ok: true }],
    });
    expect(unlisted.checks.find((c) => c.id === 'attestation')?.status).toBe('fail');
  });
});
