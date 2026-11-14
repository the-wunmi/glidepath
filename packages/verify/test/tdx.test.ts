import { readFileSync } from 'node:fs';
import { p256 } from '@noble/curves/nist.js';
import { bytesToHex, fromBase64, sha256Hex } from '@vsp/core';
import { describe, expect, it } from 'vitest';
import {
  INTEL_SGX_ROOT_CA_PUBLIC_KEY,
  parseCertificate,
  parseTdxQuote,
  pemCertificates,
  type TdxCheckId,
  type TdxPinned,
  verifyTdxQuote,
} from '../src/tdx.ts';

const data = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));

/** The current build's key-proof run, as OutLayer serves it (fetched 2026-11-14). */
const record = data('data/outlayer/attestation-cxmt7H2q7p83PWaJzR1RWQij8VyhjbjGkkf3ZyZGnVo.json');
/** The build the fixture belongs to: the record keeps earlier builds in `previous`. */
const record_ = data('deployments/outlayer-testnet.json');
const deployment = [record_, ...record_.previous, ...(record_.backups ?? [])].find(
  (b: { keyProof: { txHash: string } }) =>
    b.keyProof.txHash === 'cxmt7H2q7p83PWaJzR1RWQij8VyhjbjGkkf3ZyZGnVo',
);
const quote: Uint8Array = fromBase64(record.tdx_quote);
const pinned: TdxPinned = {
  measurements: deployment.attestation.measurements,
  quoteHash: deployment.attestation.quoteHash,
};
const NOW = new Date('2026-11-14T00:00:00Z');

/** The quote with one byte flipped; the pinned hash moves with it, so only the target check fails. */
function tampered(at: number): { bytes: Uint8Array; pinned: TdxPinned } {
  const bytes = quote.slice();
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  return { bytes, pinned: { ...pinned, quoteHash: sha256Hex(bytes) } };
}

const failed = (r: ReturnType<typeof verifyTdxQuote>): TdxCheckId[] =>
  r.checks.filter((c) => !c.ok).map((c) => c.id);

// Offsets in the live quote: header 48, TD report 584, signature length 4, then the signature data.
const SIG_DATA = 636;
const QE_REPORT = SIG_DATA + 134;
const MRTD = 48 + 136;
const REPORT_DATA = 48 + 520;
const TD_ATTRIBUTES = 48 + 120;

describe('Intel TDX quote verification', () => {
  it('a live OutLayer quote passes every check against the registry’s pinned values', () => {
    const r = verifyTdxQuote(pinned, quote, { now: NOW });
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([
      ['quote_hash', true],
      ['measurements', true],
      ['production_td', true],
      ['quoting_enclave', true],
      ['pck_chain', true],
      ['qe_report_signature', true],
      ['attestation_key', true],
      ['quote_signature', true],
    ]);
    expect(r.ok).toBe(true);
  });

  it('parses the quote as OutLayer’s worker produced it', () => {
    const q = parseTdxQuote(quote);
    expect(q.version).toBe(4);
    expect(q.body.rtmr3).toBe(record.worker_measurement);
    // OutLayer's per-run report data: a sha256 over the task fields, then 32 zero bytes.
    expect(q.body.reportData.slice(64)).toBe('00'.repeat(32));
    // The QE auth data is Intel's default: the bytes 0..31.
    expect(bytesToHex(q.qeAuthData)).toBe(bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i)));
    const certs = pemCertificates(q.pckChainPem).map(parseCertificate);
    expect(certs.map((c) => c.subjectCn)).toEqual([
      'Intel SGX PCK Certificate',
      'Intel SGX PCK Platform CA',
      'Intel SGX Root CA',
    ]);
    expect(bytesToHex(certs[2]!.publicKey)).toBe(INTEL_SGX_ROOT_CA_PUBLIC_KEY);
  });

  it('a quote other than the one the registry pinned fails the hash check', () => {
    const r = verifyTdxQuote({ ...pinned, quoteHash: '00'.repeat(32) }, quote, { now: NOW });
    expect(failed(r)).toEqual(['quote_hash']);
  });

  it('a changed measurement in the TD report breaks the pinned measurements and the quote signature', () => {
    const t = tampered(MRTD);
    expect(failed(verifyTdxQuote(t.pinned, t.bytes, { now: NOW }))).toEqual([
      'measurements',
      'quote_signature',
    ]);
  });

  it('a TD in debug mode fails, even with every signature over it valid', () => {
    const t = tampered(TD_ATTRIBUTES);
    expect(failed(verifyTdxQuote(t.pinned, t.bytes, { now: NOW }))).toEqual([
      'production_td',
      'quote_signature',
    ]);
  });

  it('a quote from another quoting enclave than Intel’s TDX one fails', () => {
    const t = tampered(QE_REPORT + 128);
    expect(failed(verifyTdxQuote(t.pinned, t.bytes, { now: NOW }))).toEqual([
      'quoting_enclave',
      'qe_report_signature',
    ]);
  });

  it('changed report data breaks the quote signature', () => {
    const t = tampered(REPORT_DATA);
    expect(failed(verifyTdxQuote(t.pinned, t.bytes, { now: NOW }))).toEqual(['quote_signature']);
  });

  it('a flipped bit in the quote signature fails it', () => {
    const t = tampered(SIG_DATA + 10);
    expect(failed(verifyTdxQuote(t.pinned, t.bytes, { now: NOW }))).toEqual(['quote_signature']);
  });

  it('a swapped attestation key fails both the QE binding and the quote signature', () => {
    const t = tampered(SIG_DATA + 70);
    expect(failed(verifyTdxQuote(t.pinned, t.bytes, { now: NOW }))).toEqual([
      'attestation_key',
      'quote_signature',
    ]);
  });

  it('a changed QE report fails its PCK signature', () => {
    const t = tampered(QE_REPORT + 64);
    expect(failed(verifyTdxQuote(t.pinned, t.bytes, { now: NOW }))).toEqual([
      'qe_report_signature',
    ]);
  });

  it('a changed QE report data fails its signature and the attestation key binding', () => {
    const t = tampered(QE_REPORT + 320);
    expect(failed(verifyTdxQuote(t.pinned, t.bytes, { now: NOW }))).toEqual([
      'qe_report_signature',
      'attestation_key',
    ]);
  });

  it('a changed certificate in the PCK chain fails the chain', () => {
    const q = parseTdxQuote(quote);
    // A base64 character inside the leaf certificate's signed part, swapped for another.
    const pemAt =
      bytesToHex(quote).indexOf(bytesToHex(new TextEncoder().encode(q.pckChainPem))) / 2;
    const at = pemAt + 400;
    const bytes = quote.slice();
    bytes[at] = bytes[at] === 0x41 ? 0x42 : 0x41;
    const r = verifyTdxQuote({ ...pinned, quoteHash: sha256Hex(bytes) }, bytes, { now: NOW });
    expect(failed(r)).toEqual(['pck_chain', 'qe_report_signature']);
  });

  it('a chain that does not end at the pinned Intel root fails', () => {
    const other = bytesToHex(p256.getPublicKey(p256.utils.randomSecretKey(), false));
    const r = verifyTdxQuote(pinned, quote, { now: NOW, rootKeyHex: other });
    expect(failed(r)).toEqual(['pck_chain', 'qe_report_signature']);
    expect(r.checks.find((c) => c.id === 'pck_chain')?.detail).toMatch(/not Intel’s SGX root/);
  });

  it('an expired or not yet valid PCK certificate fails the chain', () => {
    for (const now of [new Date('2034-01-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z')]) {
      const r = verifyTdxQuote(pinned, quote, { now });
      expect(failed(r)).toEqual(['pck_chain', 'qe_report_signature']);
      expect(r.checks.find((c) => c.id === 'pck_chain')?.detail).toMatch(/is valid/);
    }
  });

  it('a truncated quote fails every check and does not throw', () => {
    const bytes = quote.slice(0, 1000);
    const r = verifyTdxQuote({ ...pinned, quoteHash: sha256Hex(bytes) }, bytes, { now: NOW });
    expect(failed(r)).toEqual([
      'measurements',
      'production_td',
      'quoting_enclave',
      'pck_chain',
      'qe_report_signature',
      'attestation_key',
      'quote_signature',
    ]);
  });

  it('data after the signature data other than zero padding is refused', () => {
    const t = tampered(quote.length - 1);
    expect(verifyTdxQuote(t.pinned, t.bytes, { now: NOW }).ok).toBe(false);
  });
});
