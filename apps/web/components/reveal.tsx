'use client';

import { describePlan } from '@glidepath/core';
import type { ChainPlan, ChainReceipt } from '@glidepath/near';
import { type ChainReveal, verifyReveal } from '@glidepath/verify';
import { useMemo } from 'react';
import { CheckMark, Panel } from '@/components/ui';
import { plainLines } from '@/lib/copy';
import { fmtDateTime } from '@/lib/format';

/**
 * The end-of-plan reveal, checked in this browser: the published terms and salt must hash to the
 * commitment the plan made on day one, and every sale must have stayed inside those terms.
 */
export function RevealPanel({
  plan,
  reveal,
  receipts,
}: {
  plan: ChainPlan;
  reveal: ChainReveal | null;
  receipts: ChainReceipt[];
}) {
  const result = useMemo(
    () => (reveal ? verifyReveal(reveal, plan, receipts) : null),
    [reveal, plan, receipts],
  );
  if (plan.status !== 'ended') return null;

  if (!reveal || !result) {
    return (
      <Panel
        title="Sealed terms"
        description="The plan has ended. Its terms can now be published and checked against the commitment."
      >
        <p className="text-sm text-ink-2">
          {plan.disclosure.type === 'end_reveal'
            ? 'This plan chose to reveal its terms at the end. The enclave publishes them on-chain shortly after the plan is finalized.'
            : 'This plan did not choose to reveal its terms. The owner may still publish them from their backup file; until then they stay sealed.'}
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Sealed terms, revealed"
      description={`Published ${fmtDateTime(reveal.revealed_at_ms)}. Checked in this browser against the commitment and every receipt.`}
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">What the plan said</h3>
          {result.plan ? (
            <ul className="list-disc space-y-1.5 pl-5 text-sm">
              {plainLines(describePlan(result.plan), result.plan.beneficiary.asset).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fail">The published terms are not a readable plan.</p>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">
            {result.ok ? 'Every check passed' : 'Some checks failed'}
          </h3>
          <ul className="space-y-2">
            {result.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-sm">
                <CheckMark state={c.status} />
                <span>{c.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  );
}
