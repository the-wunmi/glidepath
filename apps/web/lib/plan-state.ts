import type { Execution, PlanDetail } from './types';

/** Whether the plan's token was launched, from the app's own timeline or a non-zero balance. */
export const tokenLaunched = (d: PlanDetail) =>
  d.activity.some((a) => a.kind === 'token_launched') ||
  (d.balance !== null && d.balance !== '0') ||
  d.receipts.length > 0;

const sumOf = (d: PlanDetail, status: Execution['status']) =>
  d.executions.filter((x) => x.status === status).reduce((sum, x) => sum + BigInt(x.amount), 0n);

/**
 * Receipted amounts that never sold: failed settlements (the API's failedTotal, or summed here
 * when an older API lacks it) plus swaps 1Click refunded to the plan.
 */
export function failedAmount(d: PlanDetail): bigint {
  const failed =
    d.failedTotal !== undefined ? BigInt(d.failedTotal) : sumOf(d, 'settlement_failed');
  return failed + sumOf(d, 'refunded');
}

/** What actually sold: the registry's total minus the receipted amounts that never sold. */
export const soldAmount = (d: PlanDetail): bigint => BigInt(d.summary.soldTotal) - failedAmount(d);

export type NextAction =
  | { kind: 'wait_ack'; text: string }
  | { kind: 'launch'; text: string }
  | { kind: 'cooling_off'; text: string; effectiveAtMs: number; cancel: boolean }
  | { kind: 'finalize'; text: string }
  | { kind: 'selling'; text: string }
  | { kind: 'not_started'; text: string; startMs: number }
  | { kind: 'ended'; text: string };

/** The one thing a founder should do (or wait for) next on a plan. */
export function nextAction(d: PlanDetail, chainNow: number | null): NextAction {
  const p = d.plan;
  if (p.status === 'ended') return { kind: 'ended', text: 'Plan ended; remainder released' };
  if (p.status === 'awaiting_ack')
    return { kind: 'wait_ack', text: 'Waiting for the enclave to acknowledge' };
  const now = chainNow ?? 0;
  if (p.pending_change) {
    const cancel = p.pending_change.kind === 'cancel';
    if (cancel && now >= p.pending_change.effective_at_ms)
      return { kind: 'finalize', text: 'Cancellation in force: finalize' };
    return {
      kind: 'cooling_off',
      text: cancel ? 'Cancellation cooling off' : 'Change cooling off',
      effectiveAtMs: p.pending_change.effective_at_ms,
      cancel,
    };
  }
  if (now >= p.end_ms) return { kind: 'finalize', text: 'Plan period over: finalize' };
  if (!tokenLaunched(d)) return { kind: 'launch', text: 'Launch the token into the plan' };
  if (now < p.start_ms)
    return { kind: 'not_started', text: 'Sales start soon', startMs: p.start_ms };
  return { kind: 'selling', text: 'Selling at random times' };
}
