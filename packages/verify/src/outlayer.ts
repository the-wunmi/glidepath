/**
 * The checks of a live OutLayer enclave, wherever they run (the browser, the command line). Every
 * check is a computation over bytes the caller reads with the functions it passes in: OutLayer's
 * attestation record, the key-proof run's NEAR transaction output, and Intel's PCS collateral.
 * Where those bytes come from does not matter: the quote must hash to the registry's pinned hash,
 * the output must be the one the quote commits to, and Intel signed the collateral.
 */

import { type AttestationCheck, fromBase64 } from '@glidepath/core';
import type { ChainEnclave } from '@glidepath/near';
import {
  collateralRequest,
  collateralUnavailable,
  type PcsCollateral,
  verifyCollateral,
} from './collateral.ts';
import { type OutlayerAttestationRecord, verifyKeyProof } from './keyproof.ts';
import { parseTdxQuote, verifyTdxQuote } from './tdx.ts';

/**
 * A live OutLayer enclave's evidence (`enclave.quote` in /api/meta when `format` is
 * 'outlayer-tdx-v1'). The Intel TDX quote itself sits behind `attestation_url`.
 */
export interface OutlayerQuote {
  format: 'outlayer-tdx-v1';
  measurements: ChainEnclave['measurements'];
  attestation_url: string;
  /** The testnet transaction of the attested run that proved the key; the registry pinned it then. */
  key_proof_tx: string;
  wasm_url: string;
  wasm_sha256: string;
  worker_registry: string;
}

export const isOutlayerQuote = (q: unknown): q is OutlayerQuote =>
  !!q && typeof q === 'object' && (q as { format?: unknown }).format === 'outlayer-tdx-v1';

/**
 * One row of an enclave's checks. `warn` marks a row that did not fail but is not a pass either
 * (Intel rates the machine's patch level below UpToDate, or its collateral could not be read).
 */
export interface EnclaveCheck extends AttestationCheck {
  warn?: boolean;
  detail?: string;
}

/** How a row counts: a failure, a warning, or a pass. */
export const checkState = (c: EnclaveCheck): 'pass' | 'fail' | 'warn' =>
  !c.ok ? 'fail' : c.warn ? 'warn' : 'pass';

/** Intel's collateral for a quote, or why it could not be read. */
export type CollateralResult = PcsCollateral | { error: string };

/** OutLayer's record of a run, as its attestation API serves it. */
export type OutlayerRecord = OutlayerAttestationRecord & { transaction_hash?: string | null };

/** A key-proof run's evidence: OutLayer's record of it, its quote, and what the chain returned. */
export interface OutlayerEvidence {
  quote: Uint8Array;
  record: OutlayerRecord;
  /** The run's NEAR transaction return value (base64); null if the chain could not be read. */
  keyProofOutput: string | null;
  collateral: CollateralResult;
}

/** The registry's entry for an enclave key: what the checks pin. */
export type PinnedEnclave = Pick<ChainEnclave, 'public_key' | 'measurements' | 'quote_hash'>;

/** Reads `url` (a plain GET). */
export type Fetch = (url: string) => Promise<Response>;

/** How the caller reads the evidence. */
export interface OutlayerReads {
  /** Reads OutLayer's attestation record at the URL the enclave serves. */
  fetch: Fetch;
  /** The NEAR transaction's return value (base64 SuccessValue), or null if it has none. */
  txSuccessValue: (txHash: string, sender: string) => Promise<string | null>;
  /**
   * Reads one of Intel's PCS collateral documents, given its path under a `/api/pcs/` pass-through
   * (`tdx/tcb?fmspc=…`, `tdx/qe-identity`, `pckcrl?ca=…`, `rootcacrl`).
   */
  pcs: Fetch;
}

/** The row for an enclave whose evidence could not be read. */
export const EVIDENCE_UNREAD_LABEL = 'OutLayer’s attestation evidence could be read';

/**
 * OutLayer's attestation record at `url` and the quoted run's transaction output, read from the
 * chain at the hash and caller the record names.
 */
export async function readOutlayerRun(
  url: string,
  reads: Pick<OutlayerReads, 'fetch' | 'txSuccessValue'>,
): Promise<Omit<OutlayerEvidence, 'collateral'>> {
  const res = await reads.fetch(url);
  if (!res.ok)
    throw new Error(`OutLayer’s attestation record could not be read (HTTP ${res.status})`);
  const record = (await res.json()) as OutlayerRecord & { tdx_quote?: unknown };
  if (typeof record.tdx_quote !== 'string')
    throw new Error('OutLayer’s attestation record has no quote');
  const keyProofOutput =
    record.transaction_hash && record.caller_account_id
      ? await reads.txSuccessValue(record.transaction_hash, record.caller_account_id)
      : null;
  return { quote: fromBase64(record.tdx_quote), record, keyProofOutput };
}

/**
 * Intel's PCS collateral for the machine a quote names (`collateralRequest`). Intel's issuer chains
 * come URL-encoded in response headers. Only bytes are read here: `verifyCollateral` checks Intel's
 * signatures up to the pinned root, so a relay cannot change them unnoticed.
 */
export async function readPcsCollateral(
  req: { fmspc: string; ca: string },
  pcs: Fetch,
): Promise<PcsCollateral> {
  const get = async (path: string) => {
    const res = await pcs(path);
    if (!res.ok) throw new Error(`Intel’s collateral could not be read (HTTP ${res.status})`);
    return res;
  };
  const [tcb, qe, pck, root] = await Promise.all([
    get(`tdx/tcb?fmspc=${req.fmspc}`),
    get('tdx/qe-identity'),
    get(`pckcrl?ca=${req.ca}`),
    get('rootcacrl'),
  ]);
  return {
    tcbInfo: {
      body: await tcb.text(),
      issuerChain: decodeURIComponent(tcb.headers.get('tcb-info-issuer-chain') ?? ''),
    },
    qeIdentity: {
      body: await qe.text(),
      issuerChain: decodeURIComponent(qe.headers.get('sgx-enclave-identity-issuer-chain') ?? ''),
    },
    pckCrl: new Uint8Array(await pck.arrayBuffer()),
    rootCaCrl: new Uint8Array(await root.arrayBuffer()),
  };
}

/** Intel's collateral for a quote, or why it could not be read (never throws). */
export async function readCollateral(
  quoteBytes: Uint8Array,
  pcs: Fetch,
): Promise<CollateralResult> {
  try {
    return await readPcsCollateral(collateralRequest(parseTdxQuote(quoteBytes)), pcs);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Everything an OutLayer enclave's checks need, read once with no caching. The record and the
 * quote must be readable (else this throws); unreadable collateral is kept as its reason.
 */
export async function fetchOutlayerEvidence(
  url: string,
  reads: OutlayerReads,
): Promise<OutlayerEvidence> {
  const run = await readOutlayerRun(url, reads);
  return { ...run, collateral: await readCollateral(run.quote, reads.pcs) };
}

/**
 * The checks over the raw quote bytes: they hash to the quote hash the registry pinned for the key,
 * carry the pinned measurements, and are signed by an attestation key that Intel's certificate
 * chain vouches for, up to Intel's pinned root. Then Intel's collateral: no certificate in that
 * chain is revoked, and the machine's TCB status. A status below UpToDate is a warning, Revoked a
 * failure; unreadable collateral is a warning that says it was not checked.
 */
export function outlayerChecks(
  enclave: PinnedEnclave,
  quoteBytes: Uint8Array,
  collateral: CollateralResult,
  opts: { now?: Date } = {},
): EnclaveCheck[] {
  const v = verifyTdxQuote(
    { measurements: enclave.measurements, quoteHash: enclave.quote_hash },
    quoteBytes,
    opts,
  );
  const rows: EnclaveCheck[] = v.checks.map(({ label, ok }) => ({ label, ok }));
  if (!v.quote) return rows;
  const extra =
    'error' in collateral
      ? collateralUnavailable(collateral.error)
      : verifyCollateral(v.quote, collateral, opts).checks;
  return [
    ...rows,
    ...extra.map(({ label, ok, warn, detail }) => ({
      label,
      ok,
      ...(warn ? { warn } : {}),
      ...(detail ? { detail } : {}),
    })),
  ];
}

/**
 * Whether the encryption key a plan would be sealed to is the one the attested module proved it
 * holds: the quote commits to the key-proof run, whose output on-chain is that proof, signed by the
 * registered key. Without it a server could serve its own key while every quote check passed.
 */
export function keyProofChecks(
  enclave: PinnedEnclave,
  identity: { encryptionKeyHex: string; quote: Pick<OutlayerQuote, 'wasm_sha256'> },
  ev: Pick<OutlayerEvidence, 'quote' | 'record' | 'keyProofOutput'>,
): EnclaveCheck[] {
  let reportData = '';
  try {
    reportData = parseTdxQuote(ev.quote).body.reportData;
  } catch {
    reportData = '';
  }
  return verifyKeyProof({
    record: ev.record,
    quoteReportData: reportData,
    txSuccessValue: ev.keyProofOutput ?? '',
    registeredKey: enclave.public_key,
    encryptionKeyHex: identity.encryptionKeyHex,
    wasmSha256: identity.quote.wasm_sha256,
  }).checks;
}

/**
 * Every check of one OutLayer build: the quote and Intel's collateral, then the key proof. With no
 * registry entry for the key or no evidence, one failed row says the evidence could not be read
 * (with the reason, when the caller has one).
 */
export function checkOutlayerEnclave(
  enclave: PinnedEnclave | null,
  identity: { encryptionKeyHex: string; quote: Pick<OutlayerQuote, 'wasm_sha256'> },
  ev: OutlayerEvidence | { error: string } | null,
  opts: { now?: Date } = {},
): EnclaveCheck[] {
  if (!enclave || !ev || 'error' in ev)
    return [
      {
        label: EVIDENCE_UNREAD_LABEL,
        ok: false,
        ...(ev && 'error' in ev ? { detail: ev.error } : {}),
      },
    ];
  return [
    ...outlayerChecks(enclave, ev.quote, ev.collateral, opts),
    ...keyProofChecks(enclave, identity, ev),
  ];
}
