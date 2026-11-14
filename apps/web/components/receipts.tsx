'use client';

import { type ReceiptVerification, verifyReceipt } from '@glidepath/verify';
import { useState } from 'react';
import {
  attestationFailure,
  checkState,
  fetchOutlayerEvidence,
  isOutlayerQuote,
  outlayerChecks,
} from '@/lib/attestation';
import { evmTransactionStatus, type QuoteSignerEntry } from '@/lib/chain';
import { saleLabel } from '@/lib/copy';
import type { Explorer } from '@/lib/env';
import { fmtDate, fmtDateTime, tokens } from '@/lib/format';
import type { ChainEnclave, ChainPlan, ChainReceipt, Meta } from '@/lib/types';
import { Badge, CheckList, Hash } from './ui';

/** Whether this page shows a receipt's amount yet, under the plan's disclosure policy. */
export function amountVisible(plan: ChainPlan, r: ChainReceipt, chainNow: number | null) {
  if (plan.disclosure.type !== 'delayed') return { visible: true, at: null as number | null };
  const at = r.created_at_ms + plan.disclosure.delay_ms;
  return { visible: chainNow !== null && chainNow >= at, at };
}

type Result = ReceiptVerification | 'running' | { error: string };

/**
 * The EVM transaction hash of a receipt whose signed transfer was mined but reverted, from the
 * verifier's broadcast check; null when it has not been checked or did not revert.
 */
export function revertedTx(result: Result | undefined): string | null {
  if (!result || result === 'running' || 'error' in result) return null;
  const c = result.checks.find((x) => x.id === 'broadcast');
  return c?.status === 'fail' ? (c.detail ?? '') : null;
}

export function useReceiptVerifier(
  plan: ChainPlan | null,
  enclaves: ChainEnclave[] | null,
  meta: Meta | null,
  /** The 1Click quote signer(s) registered on-chain, never the operator's word. */
  quoteSigner: string | QuoteSignerEntry[] | null,
) {
  const [results, setResults] = useState<Record<number, Result>>({});
  const run = async (r: ChainReceipt) => {
    if (!plan || !enclaves) return;
    setResults((x) => ({ ...x, [r.seq]: 'running' }));
    try {
      // The quote is served by the operator; it is checked against the key's on-chain entry.
      const served =
        [meta?.enclave, ...(meta?.backupEnclaves ?? []), ...(meta?.pastEnclaves ?? [])].find(
          (x) => x?.signingKey === r.enclave_key,
        ) ?? null;
      const live = served && isOutlayerQuote(served.quote) ? served.quote : null;
      const out = await verifyReceipt(
        r,
        plan,
        enclaves,
        // verifyReceipt knows only the simulated quote; a live OutLayer key is checked below.
        served && !live ? { quote: served.quote, encryptionKeyHex: served.encryptionKeyHex } : null,
        { evmTransaction: (hash: `0x${string}`) => evmTransactionStatus(hash) },
        quoteSigner,
      );
      const enclave = enclaves.find((x) => x.public_key === r.enclave_key);
      if (live && enclave) {
        const ev = await fetchOutlayerEvidence(live.attestation_url);
        const checks = out.checks.flatMap((c) =>
          c.id === 'attestation'
            ? outlayerChecks(enclave, ev.quote, ev.collateral).map((x, i) => ({
                id: `attestation-outlayer-${i}`,
                label: x.label,
                status: checkState(x),
                ...(x.detail ? { detail: x.detail } : {}),
              }))
            : [c],
        );
        out.checks = checks;
        out.ok = checks.every((c) => c.status !== 'fail');
        out.simulatedAttestation = false;
      }
      setResults((x) => ({ ...x, [r.seq]: out }));
    } catch (e) {
      setResults((x) => ({
        ...x,
        [r.seq]: { error: e instanceof Error ? e.message : String(e) },
      }));
    }
  };
  return { results, run };
}

const RECEIPT_STATUS: Record<
  ChainReceipt['status'],
  { label: string; tone: 'pass' | 'wait' | 'fail' }
> = {
  done: { label: 'Done', tone: 'pass' },
  pending: { label: 'Pending', tone: 'wait' },
  failed: { label: 'Failed', tone: 'fail' },
};

export function ReceiptCard({
  plan,
  receipt: r,
  symbol,
  chainNow,
  result,
  onVerify,
  ex,
  evmName,
}: {
  plan: ChainPlan;
  receipt: ChainReceipt;
  symbol: string;
  chainNow: number | null;
  result: Result | undefined;
  onVerify: () => void;
  ex: Explorer;
  /** The EVM chain's name, for a reverted transfer. */
  evmName: string;
}) {
  const shown = amountVisible(plan, r, chainNow);
  const release = r.kind === 'release';
  const st = RECEIPT_STATUS[r.status];
  const done = result && result !== 'running' && !('error' in result) ? result : null;
  const errored = result && result !== 'running' && 'error' in result ? result.error : null;
  const reverted = revertedTx(result);
  return (
    <li id={`receipt-${r.seq}`} className="well scroll-mt-28 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">
              {release ? 'End-of-plan release' : saleLabel(r.seq)}
            </span>
            {/* "Done" is the normal case; only an unusual registry status earns a badge. */}
            {reverted === null && r.status !== 'done' && (
              <Badge tone={st.tone} dot>
                {st.label}
              </Badge>
            )}
            {reverted !== null ? (
              <Badge tone="fail" dot>
                Transfer reverted: not sold
              </Badge>
            ) : (
              done && (
                <Badge tone={!done.ok ? 'fail' : done.complete ? 'pass' : 'wait'}>
                  {!done.ok
                    ? 'Verification failed'
                    : done.complete
                      ? 'Verified in this browser'
                      : 'Verified so far'}
                </Badge>
              )
            )}
          </p>
          <p className="num mt-0.5 text-xs text-ink-3">
            {fmtDateTime(r.created_at_ms)}, period {r.period_index + 1}
            {r.commitment !== plan.commitment ? ', under an earlier commitment' : ''}
          </p>
        </div>
        {/* Below the title on a phone, so the amount and venue align left like the lines above. */}
        <div className="w-full sm:w-auto sm:text-right">
          {shown.visible ? (
            <p
              className={`num font-semibold ${reverted !== null ? 'text-ink-3 line-through' : ''}`}
            >
              {tokens(r.amount, plan.token_decimals)} {symbol}
            </p>
          ) : (
            <p className="text-sm text-ink-2">
              Amount disclosed after{' '}
              <span className="num">{shown.at ? fmtDate(shown.at) : '…'}</span>
            </p>
          )}
          {r.settlement && (
            <p className="text-xs text-ink-3">
              via {r.settlement.venue === '1click' ? '1Click' : r.settlement.venue}
            </p>
          )}
        </div>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        <div className="flex min-w-0 items-center gap-2">
          <dt className="shrink-0 text-ink-3">Action hash</dt>
          <dd className="min-w-0">
            <Hash value={r.action_hash} label="action hash" />
          </dd>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <dt className="shrink-0 text-ink-3">Signed by</dt>
          <dd className="min-w-0">
            {r.enclave_key ? (
              <Hash value={r.enclave_key} label="enclave key" head={14} />
            ) : (
              'No enclave (release)'
            )}
          </dd>
        </div>
        {r.receiver !== r.settlement?.deposit_address && (
          <div className="flex min-w-0 items-center gap-2">
            <dt className="shrink-0 text-ink-3">Receiver</dt>
            <dd className="min-w-0">
              <Hash value={r.receiver} label="receiver" head={12} />
            </dd>
          </div>
        )}
        {r.settlement && (
          <div className="flex min-w-0 items-center gap-2">
            <dt className="shrink-0 text-ink-3">1Click deposit</dt>
            <dd className="min-w-0">
              <Hash value={r.settlement.deposit_address} label="deposit address" head={10} />
            </dd>
          </div>
        )}
      </dl>
      {done?.checks.some((c) => c.id.startsWith('attestation') && c.status === 'fail') && (
        <p className="mt-3 rounded-md bg-fail-soft px-3 py-2 text-sm text-fail">
          {attestationFailure(
            done.checks
              .filter((c) => c.id.startsWith('attestation'))
              .map((c) => ({ label: c.label, ok: c.status !== 'fail' })),
          )}{' '}
          The other checks below are judged on their own.
        </p>
      )}
      {reverted !== null && (
        <p className="mt-3 rounded-md bg-fail-soft px-3 py-2 text-sm text-fail">
          The registry recorded this sale and the MPC network signed its transfer, but the transfer
          reverted on {evmName}, so no tokens moved and nothing was sold. The registry still counts
          it against the caps.{' '}
          {reverted && ex.evmTx(reverted) && (
            <a className="link" href={ex.evmTx(reverted)} target="_blank" rel="noreferrer">
              See the transaction
            </a>
          )}
        </p>
      )}
      {release && (
        <p className="mt-3 text-sm text-ink-2">
          {plan.asset.type === 'evm_erc20'
            ? 'Releases need no enclave signature: once the plan has ended, the registry has the MPC network sign one transfer of what is left, and only to the beneficiary’s address.'
            : 'Releases need no enclave signature: the registry pays the remainder to the beneficiary on its own once the plan has ended.'}
        </p>
      )}
      <div className="mt-3">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onVerify}
          disabled={result === 'running'}
          aria-controls={`receipt-${r.seq}-checks`}
        >
          {result === 'running'
            ? 'Verifying…'
            : done
              ? 'Verify again'
              : errored
                ? 'Try again'
                : 'Verify in browser'}
        </button>
        <div id={`receipt-${r.seq}-checks`} aria-live="polite">
          {errored && (
            <p className="mt-2 text-sm text-fail">Could not finish the checks: {errored}</p>
          )}
          {done && (
            <details
              className="mt-3 rounded-md border border-rule-2 bg-surface px-3"
              // A reverted transfer is explained above; open for other failures and for warnings.
              open={done.checks.some(
                (c) => (c.status === 'fail' && c.id !== 'broadcast') || c.status === 'warn',
              )}
            >
              <summary className="cursor-pointer py-2 text-sm">
                {done.ok && !done.complete ? (
                  <span className="text-wait">
                    {done.checks.filter((c) => c.status === 'pass').length} checks passed so far;
                    some cannot be checked yet
                  </span>
                ) : done.ok && done.checks.some((c) => c.status === 'warn') ? (
                  <span className="text-wait">
                    {done.checks.filter((c) => c.status === 'pass').length} checks passed,{' '}
                    {done.checks.filter((c) => c.status === 'warn').length} with a warning
                  </span>
                ) : done.ok ? (
                  <span className="text-pass">
                    All {done.checks.filter((c) => c.status === 'pass').length} checks passed
                  </span>
                ) : (
                  <span className="text-fail">
                    {done.checks.filter((c) => c.status === 'fail').length} check(s) failed
                  </span>
                )}
                {done.checks.some((c) => c.status === 'skip') && (
                  <span className="text-ink-3">
                    , {done.checks.filter((c) => c.status === 'skip').length} not applicable
                  </span>
                )}
                <span className="text-ink-3">. Show each check</span>
              </summary>
              <CheckList
                checks={done.checks.map((c) => ({
                  // The page says once, above the receipts, that the TDX quote is simulated.
                  label: c.label.replace(' (simulated TDX)', ''),
                  state: c.status,
                  detail: c.detail,
                }))}
              />
            </details>
          )}
        </div>
      </div>
    </li>
  );
}
