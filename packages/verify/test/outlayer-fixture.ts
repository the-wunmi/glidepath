/**
 * One OutLayer key-proof run, as served live, and the enclave build it belongs to. To move the
 * tests to another run, change `KEY_PROOF_TX` and `DEPLOYMENT` (and save the run's two files in
 * data/outlayer; a run on another machine also needs that machine's Intel collateral in
 * data/intel-pcs and its `NOW`). Nothing here is signed by the tests: the signatures are the
 * enclave's and Intel's own.
 */
import { readFileSync } from 'node:fs';
import { fromBase64, parseNearKey, utf8ToBytes } from '@glidepath/core';
import type { ChainEnclave } from '@glidepath/near';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { PcsCollateral } from '../src/collateral.ts';
import { KEY_PROOF_DOMAIN } from '../src/keyproof.ts';
import type { OutlayerEvidence, OutlayerQuote, OutlayerRecord } from '../src/outlayer.ts';

/** The key-proof run's NEAR transaction. */
export const KEY_PROOF_TX = 'DbCE4nU9ytaDcr2s5CubQvwn7MTWZDWTC5fAqhDPkn45';
/** The deployment record that names the build (its `previous` and `backups` are searched too). */
export const DEPLOYMENT = 'deployments/outlayer-testnet.json';
/** After Intel issued the collateral in data/intel-pcs (2026-11-14 17:40 UTC), before it lapses. */
export const NOW = new Date('2026-11-14T18:00:00Z');

export const file = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url));
const text = (path: string) => file(path).toString('utf8');
const json = (path: string) => JSON.parse(text(path));

interface Build {
  signingKey: string;
  encryptionKeyHex: string;
  wasm: { url: string; sha256: string };
  keyProof: { txHash: string };
  attestation: { url: string; measurements: ChainEnclave['measurements']; quoteHash: string };
}

const deployment = json(DEPLOYMENT) as Build & { previous?: Build[]; backups?: Build[] };
const found = [deployment, ...(deployment.previous ?? []), ...(deployment.backups ?? [])].find(
  (b) => b.keyProof.txHash === KEY_PROOF_TX,
);
if (!found) throw new Error(`${DEPLOYMENT} names no build proved by ${KEY_PROOF_TX}`);
export const build: Build = found;

/** OutLayer's attestation record of the run, byte for byte as its API served it. */
export const recordText = text(`data/outlayer/attestation-${KEY_PROOF_TX}.json`);
export const record = JSON.parse(recordText) as OutlayerRecord & { tdx_quote: string };
/** The run's transaction as NEAR returned it. */
export const tx = json(`data/outlayer/keyproof-tx-${KEY_PROOF_TX}.json`) as {
  tx_hash: string;
  sender: string;
  success_value: string;
};
export const quoteBytes = fromBase64(record.tdx_quote);

/** The registry's entry for the build's key. */
export const enclave: ChainEnclave = {
  public_key: build.signingKey,
  measurements: build.attestation.measurements,
  quote_hash: build.attestation.quoteHash,
  registered_at_ms: 0,
  active_from_ms: 0,
  revoked_at_ms: null,
};

/** What /api/meta serves for the build. */
export const identity: { signingKey: string; encryptionKeyHex: string; quote: OutlayerQuote } = {
  signingKey: build.signingKey,
  encryptionKeyHex: build.encryptionKeyHex,
  quote: {
    format: 'outlayer-tdx-v1',
    measurements: build.attestation.measurements,
    attestation_url: build.attestation.url,
    key_proof_tx: KEY_PROOF_TX,
    wasm_url: build.wasm.url,
    wasm_sha256: build.wasm.sha256,
    worker_registry: 'worker.outlayer.testnet',
  },
};

/** Intel's PCS responses for the machine the quote names (FMSPC B0C06F000000). */
export const pcsFiles = {
  tcbInfo: 'data/intel-pcs/tdx-tcb-info-B0C06F000000.json',
  tcbInfoChain: 'data/intel-pcs/tdx-tcb-info-issuer-chain.pem',
  qeIdentity: 'data/intel-pcs/tdx-qe-identity.json',
  qeIdentityChain: 'data/intel-pcs/tdx-qe-identity-issuer-chain.pem',
  pckCrl: 'data/intel-pcs/pck-crl-platform.der',
  rootCaCrl: 'data/intel-pcs/root-ca-crl.der',
};
export const collateral: PcsCollateral = {
  tcbInfo: { body: text(pcsFiles.tcbInfo), issuerChain: text(pcsFiles.tcbInfoChain) },
  qeIdentity: { body: text(pcsFiles.qeIdentity), issuerChain: text(pcsFiles.qeIdentityChain) },
  pckCrl: new Uint8Array(file(pcsFiles.pckCrl)),
  rootCaCrl: new Uint8Array(file(pcsFiles.rootCaCrl)),
};

export const evidence: OutlayerEvidence = {
  quote: quoteBytes,
  record,
  keyProofOutput: tx.success_value,
  collateral,
};

/**
 * Whether the run's key proof is signed under the domain the code uses today. The run on file was
 * signed under the product's first domain, so the proof's signature rows fail until a run of a
 * build signing under `KEY_PROOF_DOMAIN` replaces it.
 */
export const signedUnderCurrentDomain = (() => {
  try {
    const out = JSON.parse(new TextDecoder().decode(fromBase64(tx.success_value))) as {
      result: { json: string; signature: string };
    };
    return ed25519.verify(
      fromBase64(out.result.signature),
      utf8ToBytes(KEY_PROOF_DOMAIN + out.result.json),
      parseNearKey(build.signingKey).bytes,
    );
  } catch {
    return false;
  }
})();

/** The rows that need the proof's signature to verify under `KEY_PROOF_DOMAIN`. */
export const SIGNATURE_ROWS = [
  'The output is a key proof signed by the registered key',
  'Plans are sealed to the encryption key that proof names',
];
