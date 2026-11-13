'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActor } from '@/components/actor';
import { useMeta } from '@/components/meta';
import { PlanBuilder } from '@/components/plan-builder';
import { ErrorNote, LoadingBlock, PageHeader } from '@/components/ui';

export default function NewPlanPage() {
  const meta = useMeta();
  const { actor } = useActor();
  const router = useRouter();
  return (
    <div>
      <PageHeader
        title="New plan"
        lead={
          actor ? (
            <>
              Write the plan, seal it to the enclave and commit it on-chain. Owner:{' '}
              <span className="mono text-[0.9em]">{actor}</span>.
            </>
          ) : (
            'Write the plan, seal it to the enclave and commit it on-chain.'
          )
        }
        actions={
          <Link href="/app" className="btn btn-ghost">
            Cancel
          </Link>
        }
      />
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
            onDone={(r) => r.planId && router.push(`/app/plans/${r.planId}?created=1`)}
          />
        )}
      </div>
    </div>
  );
}
