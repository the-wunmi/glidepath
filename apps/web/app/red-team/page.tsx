'use client';

import Link from 'next/link';
import { useMeta } from '@/components/meta';
import { Badge, EmptyState, ErrorNote, Hash, LoadingBlock, PageHeader } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { refusalText } from '@/lib/copy';
import { explorer } from '@/lib/env';
import { fmtDateTime } from '@/lib/format';
import type { RedteamResults } from '@/lib/types';
import { useResource } from '@/lib/use-resource';

const VERDICT = {
  refused: { label: 'Refused, as expected', tone: 'pass' },
  accepted: { label: 'Allowed, as expected', tone: 'neutral' },
  unexpected: { label: 'Unexpected answer', tone: 'fail' },
} as const;

/** The registry's answer in words, with its refusal code for anyone matching it to the chain. */
const answer = (code: string) =>
  code === 'accepted' ? (
    'Accepted'
  ) : (
    <>
      {refusalText(code)} <span className="mono text-xs text-ink-3">{code}</span>
    </>
  );

export default function RedTeamPage() {
  const meta = useMeta().data;
  const res = useResource(() => api<RedteamResults>('/api/redteam'), []);
  const r = res.data;
  const missing = res.error instanceof ApiError && res.error.status === 404;
  // Transactions open in an explorer only when the run was against this app's own registry.
  const ours = !!r && !!meta && r.registry === meta.accounts.registry;
  const ex = explorer(ours ? meta : null);
  const unexpected = r?.attempts.filter((a) => a.verdict === 'unexpected').length ?? 0;

  return (
    <div>
      <PageHeader
        title="Red team"
        lead="Scripted attempts to get around a sealed plan, run against the registry: who tried what, and what the registry answered."
      />
      {missing ? (
        <EmptyState
          title="No red-team run published yet"
          action={
            <Link href="/verify" className="btn btn-secondary">
              Verify a plan instead
            </Link>
          }
        >
          Once someone runs the attack script against this deployment, every attempt and the
          registry’s answer appear here.
        </EmptyState>
      ) : res.error && !r ? (
        <ErrorNote error={res.error} retry={res.reload} />
      ) : !r ? (
        <div className="panel px-5 py-5">
          <LoadingBlock label="Loading the red-team run" />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
            <Badge tone={unexpected === 0 ? 'pass' : 'fail'} dot>
              {unexpected === 0
                ? `All ${r.attempts.length} attempts answered as expected`
                : `${unexpected} of ${r.attempts.length} answered unexpectedly`}
            </Badge>
            <span>
              Run {fmtDateTime(r.generated_at)} against plan #{r.plan_id} on{' '}
              <span className="mono">{r.registry}</span> ({r.network}).
            </span>
          </div>
          {!ours && meta && (
            <p className="rounded-lg border border-wait/40 bg-wait-soft px-4 py-3 text-sm text-wait">
              This run used a different registry from the one this app reads now, so its
              transactions cannot be opened from here.
            </p>
          )}
          <ol className="panel divide-y divide-rule-2">
            {r.attempts.map((a) => {
              const v = VERDICT[a.verdict];
              return (
                <li
                  key={`${a.attack}|${a.attacker}|${a.tx_hash ?? a.got}`}
                  className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
                >
                  <div className="min-w-0">
                    <p className="font-semibold">{a.attack}</p>
                    <p className="mt-0.5 text-sm text-ink-2">Tried by {a.attacker}</p>
                  </div>
                  <div className="min-w-0 text-sm">
                    <Badge tone={v.tone} dot>
                      {v.label}
                    </Badge>
                    <p className="mt-1.5">
                      <span className="text-ink-3">Registry answered: </span>
                      {answer(a.got)}
                    </p>
                    {a.verdict === 'unexpected' && (
                      <p className="mt-0.5 text-ink-2">
                        <span className="text-ink-3">Expected: </span>
                        {answer(a.expected)}
                      </p>
                    )}
                    <p className="mt-0.5 text-ink-2">
                      {a.tx_hash ? (
                        <>
                          <span className="text-ink-3">Transaction </span>
                          <Hash
                            value={a.tx_hash}
                            label="transaction"
                            href={
                              a.tx_hash.startsWith('0x')
                                ? ex.evmTx(a.tx_hash)
                                : ex.nearTx(a.tx_hash)
                            }
                          />
                        </>
                      ) : (
                        <span className="text-xs text-ink-3">
                          No transaction: nothing could sign one.
                        </span>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
