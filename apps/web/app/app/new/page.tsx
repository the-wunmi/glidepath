'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { useMeta } from '@/components/meta';
import { useOperator } from '@/components/operator';
import { PlanBuilder } from '@/components/plan-builder';
import { EmptyState, ErrorNote, LoadingBlock, PageHeader } from '@/components/ui';
import { useMe } from '@/lib/session';

/** The operator may also build for the server's own accounts; this browser remembers which. */
const OWNER_KEY = 'vsp-builder-owner';

export default function NewPlanPage() {
  const meta = useMeta();
  const me = useMe();
  const operator = useOperator();
  const router = useRouter();
  const pickId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(localStorage.getItem(OWNER_KEY)), []);

  const account = me.data?.account ?? null;
  const accounts = meta.data?.accounts;
  // The founder signs as their own account. Only the operator may use the server's accounts.
  const options = [
    ...(account ? [{ account, how: 'your wallet' }] : []),
    ...(operator.status === 'operator' && accounts
      ? [
          { account: accounts.founder, how: 'server account' },
          ...(accounts.dao ? [{ account: accounts.dao, how: 'treasury DAO, via proposals' }] : []),
        ]
      : []),
  ];
  const actor = options.find((o) => o.account === picked)?.account ?? options[0]?.account ?? null;
  const walletOwner = !!actor && actor === account;
  const checking = me.loading || operator.status === 'checking';

  return (
    <div>
      <PageHeader
        title="New plan"
        lead={
          actor ? (
            <>
              Write the plan, seal it to the enclave and commit it on-chain. Owner:{' '}
              <span className="mono text-[0.9em]">{actor}</span>
              {walletOwner && '. Your wallet signs and pays; Glidepath never holds your keys'}.
            </>
          ) : (
            'Write the plan, seal it to the enclave and commit it on-chain.'
          )
        }
        meta={
          options.length > 1 && actor ? (
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
              <label htmlFor={pickId} className="shrink-0">
                Owner
              </label>
              <select
                id={pickId}
                className="mono max-w-[15rem] min-w-0 truncate rounded-md border border-rule bg-surface py-1 pr-6 pl-2 text-xs text-ink sm:max-w-none"
                value={actor}
                onChange={(e) => {
                  localStorage.setItem(OWNER_KEY, e.target.value);
                  setPicked(e.target.value);
                }}
              >
                {options.map((o) => (
                  <option key={o.account} value={o.account}>
                    {o.account} ({o.how})
                  </option>
                ))}
              </select>
            </span>
          ) : undefined
        }
        actions={
          <Link href="/app" className="btn btn-ghost">
            Cancel
          </Link>
        }
      />
      {!actor && !checking ? (
        <EmptyState
          title="Sign in with your NEAR wallet"
          action={
            <a href="/sign-in?next=/app/new" className="btn btn-primary">
              Sign in with your NEAR wallet
            </a>
          }
        >
          Your account owns the plan on chain, and your wallet signs every owner action and pays for
          it. Glidepath never holds your keys. Anything you have already written here is kept for
          when you come back.
        </EmptyState>
      ) : (
        <div className="panel px-5 py-6 sm:px-7">
          {meta.error && !meta.data ? (
            <ErrorNote error={meta.error} retry={meta.reload} />
          ) : !meta.data || !actor ? (
            <LoadingBlock label="Loading the enclave and registry" />
          ) : (
            <PlanBuilder
              key={actor}
              meta={meta.data}
              actor={actor}
              walletOwner={walletOwner}
              onDone={(r) => r.planId && router.push(`/app/plans/${r.planId}?created=1`)}
            />
          )}
        </div>
      )}
    </div>
  );
}
