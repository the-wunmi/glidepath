'use client';

import { type AttestationCheck, SimulatedQuote, verifySimulatedQuote } from '@vsp/core';
import { useEffect, useState } from 'react';
import { registry } from './chain';
import type { ChainEnclave, Meta, OutlayerQuote } from './types';

export const isOutlayerQuote = (q: unknown): q is OutlayerQuote =>
  !!q && typeof q === 'object' && (q as { format?: unknown }).format === 'outlayer-tdx-v1';

/**
 * What this browser can check of a live OutLayer enclave: that the evidence the operator serves
 * names exactly the measurements and quote hash the registry pinned for the key. The TDX quote's
 * Intel signature chain is checked by OutLayer's verifier, not here.
 */
export function outlayerChecks(
  quote: OutlayerQuote,
  quoteHash: string,
  enclave: ChainEnclave,
): AttestationCheck[] {
  const m = quote.measurements;
  const e = enclave.measurements;
  return [
    {
      label: 'Measurements match the ones the registry pinned for this key',
      ok:
        m.mrtd === e.mrtd &&
        m.rtmr0 === e.rtmr0 &&
        m.rtmr1 === e.rtmr1 &&
        m.rtmr2 === e.rtmr2 &&
        m.rtmr3 === e.rtmr3,
    },
    {
      label: 'Quote hash matches the registry’s entry for this key',
      ok: quoteHash === enclave.quote_hash,
    },
  ];
}

export interface AttestationResult {
  ok: boolean;
  /** 'simulated': the browser checked a simulated TDX quote; 'outlayer': a live OutLayer worker. */
  kind: 'simulated' | 'outlayer';
  simulated: boolean;
  checks: AttestationCheck[];
  enclave: ChainEnclave | null;
}

/**
 * Checks the enclave's quote (served by the operator through /api/meta) against the enclave's
 * registration read straight from the registry on-chain. The browser does every computation.
 */
export function checkAttestation(meta: Meta, onChain: ChainEnclave[]): AttestationResult {
  const enclave = onChain.find((x) => x.public_key === meta.enclave.signingKey) ?? null;
  const quote = meta.enclave.quote;
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
    const checks = [
      ...keyChecks,
      ...(enclave ? outlayerChecks(quote, meta.enclave.quoteHash, enclave) : []),
    ];
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
      encryptionKeyHex: meta.enclave.encryptionKeyHex,
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
    registry
      .enclaves(registryId)
      .then((list) => {
        if (!stop) {
          setResult(checkAttestation(meta, list));
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
 * One plain sentence for a failed attestation, naming the likeliest cause first: a measurement
 * mismatch means the enclave runs different code from the version registered on-chain.
 */
export function attestationFailure(checks: { label: string; ok: boolean }[]): string | null {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return null;
  if (failed.some((c) => c.label.startsWith('Measurements match')))
    return 'This enclave’s code differs from the version registered on-chain.';
  if (failed.some((c) => c.label.startsWith('Enclave key is on')))
    return 'This enclave’s key is not on the registry’s allowlist.';
  if (failed.some((c) => c.label.startsWith('Enclave key is active')))
    return 'This enclave’s key is not active yet, or has been revoked.';
  return 'This enclave’s attestation does not match its on-chain registration.';
}
