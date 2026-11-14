/**
 * Ties an OutLayer enclave's encryption key to its TDX quote, in the browser.
 *
 * The quote's REPORTDATA is not the enclave's key: OutLayer puts there a hash of the run (its wasm,
 * input, output, caller and time). The key-proof run's output is the module's signed statement of
 * its own keys. So the chain is: the quote commits to the run, the run's output is what the NEAR
 * transaction returned, and that output is the key proof, signed by the key the registry pinned and
 * naming the encryption key. Without this a server could hand the browser its own encryption key
 * while every quote check still passed.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { fromBase64, parseNearKey, sha256Hex, utf8ToBytes } from '@vsp/core';

export const KEY_PROOF_DOMAIN = 'vsp/key-proof/v1\n';

/** The fields of OutLayer's attestation record that its report data commits to. */
export interface OutlayerAttestationRecord {
  task_id: number;
  task_type: string;
  output_hash: string;
  timestamp: number;
  caller_account_id?: string | null;
  block_height?: number | null;
  build_target?: string | null;
  wasm_hash?: string | null;
  executed_wasm_sha256?: string | null;
  input_hash?: string | null;
  project_id?: string | null;
  secrets_ref?: string | null;
  attached_usd?: string | null;
}

/**
 * The REPORTDATA OutLayer's worker puts in a run's quote: sha256 over the run's fields in its
 * order (little-endian integers), then 32 zero bytes. Matches packages/engine `taskReportData`.
 */
export function taskReportData(a: OutlayerAttestationRecord): string {
  const le = (n: number | bigint) => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(n)), true);
    return out;
  };
  const parts: Uint8Array[] = [utf8ToBytes(a.task_type), le(a.task_id)];
  for (const v of [a.build_target, a.wasm_hash, a.input_hash]) if (v) parts.push(utf8ToBytes(v));
  parts.push(utf8ToBytes(a.output_hash));
  if (a.block_height !== null && a.block_height !== undefined) parts.push(le(a.block_height));
  for (const v of [a.caller_account_id, a.project_id, a.secrets_ref])
    if (v) parts.push(utf8ToBytes(v));
  parts.push(le(a.timestamp));
  if (a.attached_usd !== null && a.attached_usd !== undefined)
    parts.push(utf8ToBytes(a.attached_usd));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return sha256Hex(all) + '00'.repeat(32);
}

export interface KeyProofCheck {
  label: string;
  ok: boolean;
}

export interface KeyProofInput {
  record: OutlayerAttestationRecord;
  /** REPORTDATA parsed from the quote whose hash the registry pinned (hex). */
  quoteReportData: string;
  /** The key-proof transaction's return value, as the chain gives it (base64 SuccessValue). */
  txSuccessValue: string;
  /** The enclave key the registry pinned ("ed25519:…"). */
  registeredKey: string;
  /** The X25519 key a plan is about to be sealed to (hex). */
  encryptionKeyHex: string;
  /** The published module the run should have executed (sha256 hex). */
  wasmSha256: string;
}

/** Checks that the encryption key is the one the attested module proved it holds. */
export function verifyKeyProof(i: KeyProofInput): { ok: boolean; checks: KeyProofCheck[] } {
  const output = fromBase64(i.txSuccessValue);
  let proof: { signing_key?: string; encryption_key_hex?: string } | null = null;
  let signed = false;
  try {
    const out = JSON.parse(new TextDecoder().decode(output)) as {
      ok: boolean;
      result: { json: string; signature: string; enclave_key: string };
    };
    const { json, signature } = out.result;
    signed = ed25519.verify(
      fromBase64(signature),
      utf8ToBytes(KEY_PROOF_DOMAIN + json),
      parseNearKey(i.registeredKey).bytes,
    );
    proof = JSON.parse(json);
  } catch {
    proof = null;
  }
  const executed = i.record.executed_wasm_sha256 ?? i.record.wasm_hash;
  const checks: KeyProofCheck[] = [
    {
      label: 'The quote commits to the run that proved the enclave’s keys',
      ok: i.quoteReportData.toLowerCase() === taskReportData(i.record),
    },
    { label: 'That run executed the published module', ok: executed === i.wasmSha256 },
    {
      label: 'Its output is what the NEAR transaction returned',
      ok: sha256Hex(output) === i.record.output_hash,
    },
    { label: 'The output is a key proof signed by the registered key', ok: signed },
    {
      label: 'Plans are sealed to the encryption key that proof names',
      ok:
        signed &&
        proof?.signing_key === i.registeredKey &&
        proof?.encryption_key_hex?.toLowerCase() === i.encryptionKeyHex.toLowerCase(),
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
