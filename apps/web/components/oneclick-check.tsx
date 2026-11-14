'use client';

import {
  type OneClickQuoteLike,
  oneclickQuoteMessage,
  oneclickSignedBytes,
  parseNearKey,
} from '@glidepath/core';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useResource } from '@/lib/use-resource';
import { Badge, CheckMark, ErrorNote, LoadingBlock, Panel, ProofDetails } from './ui';

/** GET /api/oneclick/reference (packages/engine/src/reference-quote.ts). */
interface ReferenceQuote {
  response: OneClickQuoteLike & { signature: string; quote: { amountOutFormatted?: string } };
  signerKey: string;
  fetchedAt: string;
}

/**
 * ed25519 through WebCrypto, so the check runs in this browser with no library of ours in the
 * way. The bytes are 1Click's format: the text of base58(sha256(Q)).
 */
async function verifyQuote(r: ReferenceQuote): Promise<boolean> {
  const message = oneclickSignedBytes(oneclickQuoteMessage(r.response));
  const key = await crypto.subtle.importKey(
    'raw',
    parseNearKey(r.signerKey).bytes as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'Ed25519',
    key,
    parseNearKey(r.response.signature).bytes as BufferSource,
    message as BufferSource,
  );
}

/**
 * A live, signed 1Click quote checked in the browser against 1Click's published key. No plan
 * uses it: 1Click has no testnet, so sales settle through the simulator.
 */
export function OneClickCheck() {
  const res = useResource(() => api<ReferenceQuote>('/api/oneclick/reference'), []);
  const [ok, setOk] = useState<boolean | null>(null);
  const r = res.data;
  useEffect(() => {
    if (!r) return;
    setOk(null);
    verifyQuote(r)
      .then(setOk)
      .catch(() => setOk(false));
  }, [r]);

  return (
    <Panel
      level={3}
      title="Live 1Click check"
      description="A real quote from 1Click, its signature checked in this browser against 1Click’s published key."
      actions={<Badge tone="accent">Live</Badge>}
    >
      {res.error && !r ? (
        <ErrorNote error={res.error} retry={res.reload} />
      ) : !r ? (
        <LoadingBlock label="Asking 1Click for a quote" />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="flex items-center gap-2">
              <CheckMark state={ok === null ? 'pending' : ok ? 'pass' : 'fail'} />
              {ok === null
                ? 'Checking the signature…'
                : ok
                  ? 'Signed by 1Click’s key'
                  : 'The signature does not match 1Click’s key'}
            </span>
            <span className="num">
              1 wNEAR ={' '}
              <span className="font-semibold">
                {r.response.quote.amountOutFormatted ?? '?'} USDC
              </span>{' '}
              <span className="text-ink-3">on NEAR mainnet, {fmtDateTime(r.fetchedAt)}</span>
            </span>
          </div>
          <p className="text-ink-2">
            No plan uses this quote. 1Click has no testnet, so plans here settle through a labelled
            simulator. This shows that the quote format and key the enclave and the verifier check
            are 1Click’s real ones.
          </p>
          <ProofDetails summary="The raw quote">
            <p className="mb-2 text-xs text-ink-3">
              Key <span className="mono break-words">{r.signerKey}</span>
            </p>
            <pre className="mono max-h-72 overflow-auto rounded-md border border-rule-2 bg-surface p-3 text-xs">
              {JSON.stringify(r.response, null, 2)}
            </pre>
          </ProofDetails>
        </div>
      )}
    </Panel>
  );
}
