'use client';

import { type AttestationCheck, SimulatedQuote, verifySimulatedQuote } from '@glidepath/core';
import {
  collateralRequest,
  type PcsCollateral,
  REVOCATION_LABEL,
  TCB_LABEL_PREFIX,
} from '@glidepath/verify/collateral';
import {
  type CollateralResult,
  checkOutlayerEnclave,
  type EnclaveCheck,
  isOutlayerQuote,
  type OutlayerEvidence,
  readOutlayerRun,
  readPcsCollateral,
} from '@glidepath/verify/outlayer';
import { parseTdxQuote, TDX_CHECK_LABELS } from '@glidepath/verify/tdx';
import { useEffect, useState } from 'react';
import { nearTxSuccessValue, registry } from './chain';
import type { ChainEnclave, Meta } from './types';

export {
  type CollateralResult,
  checkState,
  type EnclaveCheck,
  isOutlayerQuote,
  outlayerChecks,
} from '@glidepath/verify/outlayer';

/** A key-proof run's evidence: OutLayer's record of it, its quote, and what the chain returned. */
export type OutlayerEvidenceData = OutlayerEvidence;

const evidence = new Map<string, Promise<Omit<OutlayerEvidenceData, 'collateral'>>>();
const collaterals = new Map<string, Promise<PcsCollateral>>();

/**
 * Intel's PCS collateral for the machine that made a quote, through the API's pass-through (Intel
 * sends no CORS headers). The API only relays bytes: Intel signed them, and `verifyCollateral`
 * checks those signatures up to the pinned Intel root. Kept per machine; a failure is retried.
 */
async function fetchCollateral(quoteBytes: Uint8Array): Promise<CollateralResult> {
  try {
    const req = collateralRequest(parseTdxQuote(quoteBytes));
    const key = `${req.fmspc}:${req.ca}`;
    let p = collaterals.get(key);
    if (!p) {
      p = readPcsCollateral(req, (path) => fetch(`/api/pcs/${path}`));
      p.catch(() => collaterals.delete(key));
      collaterals.set(key, p);
    }
    return await p;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * OutLayer's attestation record (CORS-open) and the quoted run's transaction output, read from the
 * chain through the read-only proxy, at the hash and caller the record names. Where they come from
 * does not matter: the checks bind the quote to the registry's pinned hash and the output to the
 * quote. Kept per URL, since a record never changes; a failed fetch is forgotten so a retry
 * fetches again.
 */
export function fetchOutlayerEvidence(url: string): Promise<OutlayerEvidenceData> {
  return baseEvidence(url).then(async (ev) => ({
    ...ev,
    collateral: await fetchCollateral(ev.quote),
  }));
}

function baseEvidence(url: string): Promise<Omit<OutlayerEvidenceData, 'collateral'>> {
  let p = evidence.get(url);
  if (!p) {
    p = readOutlayerRun(url, { fetch: (u) => fetch(u), txSuccessValue: nearTxSuccessValue });
    p.catch(() => evidence.delete(url));
    evidence.set(url, p);
  }
  return p;
}

/** The one-line summary of a passing list: warnings are counted apart, never as passes. */
export function passedSummary(checks: EnclaveCheck[]): string {
  const warnings = checks.filter((c) => c.ok && c.warn).length;
  const passed = checks.filter((c) => c.ok && !c.warn).length;
  if (warnings === 0) return `All ${passed} checks passed`;
  return `${passed} checks passed, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`;
}

/** Whether the plan runs on an earlier build of this server's enclave than the current one. */
export function onEarlierBuild(meta: Meta | null, ackedBy: string | null): boolean {
  return (
    !!meta &&
    !!ackedBy &&
    ackedBy !== meta.enclave.signingKey &&
    (meta.pastEnclaves ?? []).some((x) => x.signingKey === ackedBy)
  );
}

/**
 * The enclave build that accepted a plan: the current one, or an earlier build still served. A plan
 * not yet accepted goes to the current build. Null when the key that accepted it has no attestation
 * served here (an enclave this server no longer runs), so nothing is claimed for it.
 */
export function planEnclave(meta: Meta, ackedBy: string | null): Meta['enclave'] | null {
  if (!ackedBy) return meta.enclave;
  return [meta.enclave, ...(meta.pastEnclaves ?? [])].find((x) => x.signingKey === ackedBy) ?? null;
}

export interface AttestationResult {
  ok: boolean;
  /** 'simulated': the browser checked a simulated TDX quote; 'outlayer': a live OutLayer worker. */
  kind: 'simulated' | 'outlayer';
  simulated: boolean;
  checks: EnclaveCheck[];
  enclave: ChainEnclave | null;
}

/**
 * Checks the enclave's quote against the enclave's registration read straight from the registry
 * on-chain. A simulated quote is served by the operator through /api/meta; a live one is the raw
 * TDX quote from OutLayer (`quoteBytes`). The browser does every computation.
 */
export function checkAttestation(
  meta: Meta,
  onChain: ChainEnclave[],
  ev: OutlayerEvidenceData | null,
  /** The build to check: the current one unless a backup build is named. */
  identity: Meta['enclave'] = meta.enclave,
): AttestationResult {
  const enclave = onChain.find((x) => x.public_key === identity.signingKey) ?? null;
  const quote = identity.quote;
  const keyChecks: AttestationCheck[] = [
    { label: 'Enclave key is on the registry’s on-chain allowlist', ok: !!enclave },
    {
      // A new key only acts after the registry's public delay; until then it is listed, not active.
      label: 'Enclave key is active (its public delay is over) and not revoked',
      ok: !!enclave && enclave.revoked_at_ms === null && enclave.active_from_ms <= meta.chainTimeMs,
    },
  ];
  // A live enclave's quote is not a simulated one: never run the simulated verifier on it.
  if (isOutlayerQuote(quote)) {
    const checks = [...keyChecks, ...checkOutlayerEnclave(enclave, { ...identity, quote }, ev)];
    return {
      ok: !!enclave && checks.every((c) => c.ok),
      kind: 'outlayer',
      simulated: false,
      checks,
      enclave,
    };
  }
  const parsed = SimulatedQuote.safeParse(quote);
  const checks: AttestationCheck[] = [
    ...keyChecks,
    { label: 'Quote is well-formed', ok: parsed.success },
  ];
  if (enclave && parsed.success) {
    const r = verifySimulatedQuote(parsed.data, {
      signingKey: enclave.public_key,
      encryptionKeyHex: identity.encryptionKeyHex,
      measurements: enclave.measurements,
      quoteHash: enclave.quote_hash,
    });
    checks.push(...r.checks);
  }
  return { ok: checks.every((c) => c.ok), kind: 'simulated', simulated: true, checks, enclave };
}

export function useAttestation(meta: Meta | null) {
  const [result, setResult] = useState<AttestationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const registryId = meta?.accounts.registry;
  const key = meta?.enclave.signingKey;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check only when the enclave or registry changes.
  useEffect(() => {
    if (!meta || !registryId) return;
    let stop = false;
    const quote = meta.enclave.quote;
    Promise.all([
      registry.enclaves(registryId),
      isOutlayerQuote(quote) ? fetchOutlayerEvidence(quote.attestation_url) : null,
    ])
      .then(([list, ev]) => {
        if (!stop) {
          setResult(checkAttestation(meta, list, ev));
          setError(null);
        }
      })
      .catch((e: Error) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [registryId, key]);
  return { result, error };
}

/**
 * The backup builds' attestations, checked like the current build's. A plan is sealed only to the
 * backups that pass; the others are left out.
 */
export function useBackupAttestations(meta: Meta | null) {
  const [results, setResults] = useState<
    { identity: Meta['enclave']; result: AttestationResult }[]
  >([]);
  const registryId = meta?.accounts.registry;
  const keys = (meta?.backupEnclaves ?? []).map((b) => b.signingKey).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check only when the backups or registry change.
  useEffect(() => {
    const backups = meta?.backupEnclaves ?? [];
    if (!meta || !registryId || backups.length === 0) return setResults([]);
    let stop = false;
    registry
      .enclaves(registryId)
      .then((list) =>
        Promise.all(
          backups.map(async (identity) => {
            const quote = identity.quote;
            const ev = isOutlayerQuote(quote)
              ? await fetchOutlayerEvidence(quote.attestation_url).catch(() => null)
              : null;
            return { identity, result: checkAttestation(meta, list, ev, identity) };
          }),
        ),
      )
      .then((r) => !stop && setResults(r))
      .catch(() => !stop && setResults([]));
    return () => {
      stop = true;
    };
  }, [registryId, keys]);
  return results;
}

const INTEL_LABELS = new Set<string>([
  TDX_CHECK_LABELS.pck_chain,
  TDX_CHECK_LABELS.qe_report_signature,
  TDX_CHECK_LABELS.attestation_key,
  TDX_CHECK_LABELS.quote_signature,
]);

/**
 * One plain sentence for a failed attestation, naming the likeliest cause first: a measurement
 * mismatch means the enclave runs different code from the version registered on-chain.
 */
export function attestationFailure(checks: { label: string; ok: boolean }[]): string | null {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return null;
  if (failed.some((c) => c.label.startsWith('Plans are sealed to the encryption key')))
    return 'The encryption key this server offers is not the one the enclave proved it holds.';
  if (failed.some((c) => c.label.startsWith('OutLayer’s attestation evidence could be read')))
    return 'OutLayer’s attestation evidence could not be read, so the enclave could not be checked.';
  if (failed.some((c) => c.label.startsWith('Attestation quote available')))
    return 'This server serves no attestation for the signing key, so nothing here ties it to measured code.';
  if (failed.some((c) => c.label.startsWith('Measurements match')))
    return 'This enclave’s code differs from the version registered on-chain.';
  if (failed.some((c) => c.label.startsWith('Enclave key is on')))
    return 'This enclave’s key is not on the registry’s allowlist.';
  if (failed.some((c) => c.label.startsWith('Enclave key is active')))
    return 'This enclave’s key is not active yet, or has been revoked.';
  if (failed.some((c) => c.label === TDX_CHECK_LABELS.quote_hash))
    return 'OutLayer’s quote for this enclave is not the one the registry pinned.';
  if (failed.some((c) => INTEL_LABELS.has(c.label)))
    return 'This enclave’s quote does not carry a valid Intel signature.';
  if (failed.some((c) => c.label === REVOCATION_LABEL))
    return 'Intel’s revocation lists could not vouch for this machine’s certificates: a certificate is revoked, or the lists do not verify.';
  if (failed.some((c) => c.label.startsWith(TCB_LABEL_PREFIX)))
    return 'Intel rates this machine’s patch level as revoked, or Intel’s data on it does not verify.';
  return 'This enclave’s attestation does not match its on-chain registration.';
}
