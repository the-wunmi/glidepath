'use client';

import Link from 'next/link';
import { ActorSwitcher, useActor } from '@/components/actor';
import { useMeta } from '@/components/meta';
import { PlanStatusBadge } from '@/components/status';
import { EmptyState, ErrorNote, LoadingBlock, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { useChainNow } from '@/lib/chain';
import { duration, fmtDate, tokens } from '@/lib/format';
import { failedAmount, nextAction, soldAmount } from '@/lib/plan-state';
import type { PlanDetail, PlanSummary } from '@/lib/types';
import { useResource } from '@/lib/use-resource';

async function loadPlans(owner: string): Promise<PlanDetail[]> {
  const list = await api<PlanSummary[]>(`/api/plans?owner=${encodeURIComponent(owner)}`);
  return Promise.all(list.map((p) => api<PlanDetail>(`/api/plans/${p.id}`)));
}

function PlanRow({ d, chainNow }: { d: PlanDetail; chainNow: number | null }) {
  const s = d.summary;
  const next = nextAction(d, chainNow);
  const dec = s.token.decimals;
  return (
    <li className="border-b border-rule-2 last:border-0">
      <Link
        href={`/app/plans/${s.id}`}
        className="grid grid-cols-2 gap-3 px-5 py-4 hover:bg-surface-2 focus-visible:bg-surface-2 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] sm:items-center"
      >
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{s.label}</span>
            <PlanStatusBadge status={s.status} pending={s.pendingChange} />
          </div>
          <div className="mt-0.5 text-xs text-ink-3">
            Plan #{s.id} · created {fmtDate(s.createdAtMs)}
          </div>
        </div>
        <div>
          <div className="text-xs text-ink-3 sm:hidden">Token</div>
          <div className="font-medium">{s.token.symbol}</div>
          <div className="text-xs text-ink-3">
            {s.token.chain === 'near' ? 'NEAR (NEP-141)' : 'EVM (ERC-20)'}
          </div>
        </div>
        <div>
          <div className="text-xs text-ink-3 sm:hidden">Sold</div>
          <div className="num font-medium">
            {tokens(soldAmount(d), dec)} {s.token.symbol}
          </div>
          <div className="num text-xs text-ink-3">
            {failedAmount(d) > 0n
              ? `${tokens(failedAmount(d), dec)} not sold (failed)`
              : `${tokens(d.balance, dec, 0)} still held`}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <div className="text-xs text-ink-3 sm:hidden">Next</div>
          <div
            className={`text-sm ${next.kind === 'launch' || next.kind === 'finalize' ? 'font-semibold text-accent-text' : 'text-ink-2'}`}
          >
            {next.text}
          </div>
          {next.kind === 'cooling_off' && chainNow && (
            <div className="num text-xs text-ink-3">
              {duration(next.effectiveAtMs - chainNow)} left
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}

export default function FounderDashboard() {
  const meta = useMeta();
  const owner = useActor().actor;
  const chainNow = useChainNow();
  const plans = useResource(owner ? () => loadPlans(owner) : null, [owner], 6000);

  return (
    <div>
      <PageHeader
        title="Your plans"
        lead="Each plan is sealed, enforced on-chain and checkable by anyone."
        meta={<ActorSwitcher />}
        actions={
          <Link href="/app/new" className="btn btn-primary">
            New plan
          </Link>
        }
      />
      {meta.data && !meta.data.sim.enclaveUp && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-wait/40 bg-wait-soft px-4 py-3 text-sm text-wait"
        >
          The enclave is unavailable, so every plan’s sales are paused. Nothing can be sold without
          it; it resumes where it stopped when it is back.
        </div>
      )}
      {plans.error && plans.data && (
        <div className="mb-4">
          <ErrorNote error={`Showing the last successful load. ${plans.error.message}`} />
        </div>
      )}
      {plans.error && !plans.data ? (
        <ErrorNote error={plans.error} retry={plans.reload} />
      ) : !plans.data ? (
        <div className="panel px-5 py-4">
          <LoadingBlock label="Loading plans" />
        </div>
      ) : plans.data.length === 0 ? (
        <EmptyState
          title="No plans yet"
          action={
            <Link href="/app/new" className="btn btn-primary">
              Create your first plan
            </Link>
          }
        >
          Write a selling plan, seal it to the enclave and launch a token whose team allocation is
          minted straight into it.
        </EmptyState>
      ) : (
        <div className="panel overflow-hidden">
          <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] gap-3 border-b border-rule bg-surface-2 px-5 py-2 text-xs font-semibold text-ink-2 sm:grid">
            <span>Plan</span>
            <span>Token</span>
            <span>Sold so far</span>
            <span>Next</span>
          </div>
          <ul>
            {plans.data.map((d) => (
              <PlanRow key={d.summary.id} d={d} chainNow={chainNow} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
