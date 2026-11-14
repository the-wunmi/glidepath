'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { useMeta } from '@/components/meta';
import { PlanStatusBadge } from '@/components/status';
import { EmptyState, ErrorNote, Hash, LoadingBlock, PageHeader } from '@/components/ui';
import { registry } from '@/lib/chain';
import { evmChainName } from '@/lib/env';
import { fmtDate } from '@/lib/format';
import { useResource } from '@/lib/use-resource';

export default function VerifyIndex() {
  const meta = useMeta();
  const router = useRouter();
  const uid = useId();
  const [lookup, setLookup] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const registryId = meta.data?.accounts.registry;
  const plans = useResource(
    registryId ? () => registry.plans(registryId) : null,
    [registryId],
    10_000,
  );

  return (
    <div>
      <PageHeader
        title="Public verifier"
        lead="Check any plan yourself. Your browser reads the registry on NEAR directly, not the operator’s database, and verifies every receipt."
      />
      <form
        className="panel mb-6 flex flex-wrap items-end gap-3 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(lookup.trim().replace(/^#/, ''));
          if (!Number.isInteger(n) || n <= 0) {
            setLookupError('Enter a plan number, like 1');
            return;
          }
          router.push(`/verify/${n}`);
        }}
      >
        <div className="min-w-48 flex-1">
          <label htmlFor={`${uid}-plan`} className="label">
            Plan number
          </label>
          <input
            id={`${uid}-plan`}
            className="input"
            inputMode="numeric"
            placeholder="1"
            value={lookup}
            aria-invalid={lookupError ? true : undefined}
            aria-describedby={lookupError ? `${uid}-plan-error` : undefined}
            onChange={(e) => {
              setLookup(e.target.value);
              setLookupError(null);
            }}
          />
          {lookupError && (
            <p id={`${uid}-plan-error`} className="mt-1 text-xs text-fail">
              {lookupError}
            </p>
          )}
        </div>
        <button type="submit" className="btn btn-primary">
          Check plan
        </button>
        {registryId && (
          <p className="w-full text-xs text-ink-3">
            Registry <span className="mono break-words">{registryId}</span>
          </p>
        )}
      </form>

      {plans.error && plans.data && (
        <div className="mb-4">
          <ErrorNote
            error={`Showing the last successful read. ${plans.error.message}. Retrying.`}
          />
        </div>
      )}
      {plans.error && !plans.data ? (
        <ErrorNote error={plans.error} retry={plans.reload} />
      ) : !plans.data ? (
        <div className="panel px-5 py-4">
          <LoadingBlock label="Reading the registry" />
        </div>
      ) : plans.data.length === 0 ? (
        <EmptyState title="No plans in the registry yet">
          Plans appear here as soon as they are committed on-chain.
        </EmptyState>
      ) : (
        <>
          {/* Stacked on a phone, so no column is scrolled out of view. */}
          <ul className="panel divide-y divide-rule-2 md:hidden">
            {[...plans.data].reverse().map((p) => (
              <li key={p.id} className="space-y-1.5 px-4 py-3 text-sm">
                <p className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/verify/${p.id}`} className="link font-semibold">
                    {p.label}
                  </Link>
                  <PlanStatusBadge status={p.status} pending={p.pending_change} />
                </p>
                <p className="text-xs text-ink-3">
                  #{p.id}, owner <span className="mono">{p.owner}</span>, created{' '}
                  {fmtDate(p.created_at_ms)}
                </p>
                <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-2">
                  <Hash value={p.commitment} label="commitment" />
                  <span>
                    {p.receipt_count} receipt{p.receipt_count === 1 ? '' : 's'}
                  </span>
                </p>
              </li>
            ))}
          </ul>
          <div className="panel hidden overflow-x-auto md:block">
            <table className="table min-w-[680px]">
              <caption className="sr-only">Plans in the registry</caption>
              <thead>
                <tr>
                  <th scope="col">Plan</th>
                  <th scope="col">Status</th>
                  <th scope="col">Commitment</th>
                  <th scope="col">Asset</th>
                  <th scope="col" className="r">
                    Receipts
                  </th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {[...plans.data].reverse().map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/verify/${p.id}`} className="link font-semibold">
                        {p.label}
                      </Link>
                      <div className="text-xs text-ink-3">
                        #{p.id}, owner <span className="mono">{p.owner}</span>
                      </div>
                    </td>
                    <td>
                      <PlanStatusBadge status={p.status} pending={p.pending_change} />
                    </td>
                    <td>
                      <Hash value={p.commitment} label="commitment" />
                    </td>
                    <td className="text-sm">
                      {p.asset.type === 'nep141' ? (
                        <span className="mono text-[0.8125rem]">{p.asset.token_id}</span>
                      ) : (
                        <span>
                          ERC-20 on{' '}
                          {meta.data && p.asset.chain_id === meta.data.evmChainId
                            ? evmChainName(meta.data)
                            : `chain ${p.asset.chain_id}`}
                        </span>
                      )}
                    </td>
                    <td className="num r">{p.receipt_count}</td>
                    <td className="num text-sm">{fmtDate(p.created_at_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
