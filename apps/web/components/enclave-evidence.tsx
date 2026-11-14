'use client';

import { explorer } from '@/lib/env';
import type { Meta, OutlayerQuote } from '@/lib/types';
import { Hash } from './ui';

/** The live enclave's name wherever its evidence is shown. */
export const OUTLAYER_LABEL = 'OutLayer testnet (TDX)';

/**
 * Where a live OutLayer enclave's evidence lives, and what this browser does not check of its TDX
 * quote: Intel's revocation lists and TCB status, which Intel serves only to servers (no CORS).
 */
export function OutlayerEvidence({ quote, meta }: { quote: OutlayerQuote; meta: Meta | null }) {
  const ex = explorer(meta);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink-2">
        The registry pinned this key after one attested key-proof run. This browser reads that run’s
        TDX quote from OutLayer and checks it up to Intel’s root certificate. It does not check
        whether Intel has revoked the machine’s certificate or rates its firmware out of date (TCB
        status): Intel serves that data only to servers.
      </p>
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[auto_1fr]">
        <dt className="text-ink-3">Attestation</dt>
        <dd>
          <a className="link" href={quote.attestation_url} target="_blank" rel="noreferrer">
            OutLayer’s attestation report
          </a>
        </dd>
        <dt className="text-ink-3">Key-proof run</dt>
        <dd className="min-w-0">
          <Hash
            value={quote.key_proof_tx}
            label="key-proof transaction"
            href={ex.nearTx(quote.key_proof_tx)}
          />
        </dd>
        <dt className="text-ink-3">Enclave code</dt>
        <dd className="min-w-0">
          <a className="link" href={quote.wasm_url} target="_blank" rel="noreferrer">
            WASM module
          </a>
          , sha256 <Hash value={quote.wasm_sha256} label="module sha256" />
        </dd>
        <dt className="text-ink-3">Worker registry</dt>
        <dd className="mono break-words text-[0.8125rem]">{quote.worker_registry}</dd>
      </dl>
    </div>
  );
}
