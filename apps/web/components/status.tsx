import type { ChainPlan, ExecutionStatus, Mode, PendingChange } from '@/lib/types';
import { Badge, SimBadge, type Tone } from './ui';

export function PlanStatusBadge({
  status,
  pending,
  chainNow = null,
}: {
  status: ChainPlan['status'];
  pending?: PendingChange | null;
  /** Chain time; once a pending change's cooling-off is over the badge says what it waits for. */
  chainNow?: number | null;
}) {
  const over = !!pending && chainNow !== null && chainNow >= pending.effective_at_ms;
  if (status === 'ended')
    return (
      <Badge tone="neutral" dot>
        Ended
      </Badge>
    );
  if (status === 'awaiting_ack')
    return (
      <Badge tone="wait" dot>
        Waiting for enclave
      </Badge>
    );
  if (pending?.kind === 'cancel')
    return (
      <Badge tone="wait" dot>
        {over ? 'Cancelled, ready to finalize' : 'Cancelling'}
      </Badge>
    );
  if (pending?.kind === 'modify')
    return (
      <Badge tone="wait" dot>
        {over ? 'Change waiting for the enclave' : 'Change pending'}
      </Badge>
    );
  return (
    <Badge tone="pass" dot>
      Active
    </Badge>
  );
}

/** Every execution status, in plain words. in_doubt is never shown as a failure. */
export const EXECUTION_STATUS: Record<
  ExecutionStatus,
  { label: string; tone: Tone; explain: string }
> = {
  signed: {
    label: 'Signed',
    tone: 'wait',
    explain:
      'The enclave signed the sale inside the sealed plan; it is on its way to the registry.',
  },
  on_chain: {
    label: 'Recorded on-chain',
    tone: 'wait',
    explain:
      'The registry checked the signature and the public limits, recorded a receipt and sent the tokens to the 1Click deposit address.',
  },
  broadcast: {
    label: 'Broadcast',
    tone: 'wait',
    explain:
      'The MPC network signed the EVM transfer the registry built, and it was sent to the EVM chain.',
  },
  settling: {
    label: 'Settling',
    tone: 'wait',
    explain: '1Click received the deposit and is swapping it for the proceeds asset.',
  },
  settled: {
    label: 'Settled',
    tone: 'pass',
    explain: 'The swap finished and the proceeds reached the beneficiary.',
  },
  refunded: {
    label: 'Refunded',
    tone: 'neutral',
    explain:
      '1Click could not fill the swap and returned the tokens to the plan account. Nothing was sold.',
  },
  settlement_failed: {
    label: 'Not sold',
    tone: 'fail',
    explain:
      'Recorded on-chain, but nothing was sold: 1Click reported the swap as failed. It is not counted as sold.',
  },
  in_doubt: {
    label: 'In doubt',
    tone: 'wait',
    explain:
      'No final answer from 1Click yet. It is still being checked and is never assumed to have failed.',
  },
  refused: {
    label: 'Refused',
    tone: 'fail',
    explain:
      'The registry refused the signed request (for example, it fell outside the public limits). Nothing moved.',
  },
  failed_on_chain: {
    label: 'Failed on-chain',
    tone: 'fail',
    explain: 'The registry transaction failed. Nothing moved.',
  },
};

/** A sale whose MPC-signed EVM transfer was mined but reverted: nothing left the plan's address. */
export const REVERTED = {
  label: 'Transfer reverted',
  tone: 'fail' as Tone,
  explain:
    'The registry recorded the sale and the MPC network signed the transfer, but the transfer reverted on the EVM chain. No tokens moved and nothing was sold.',
};

export function ExecutionStatusBadge({
  status,
  reverted = false,
}: {
  status: ExecutionStatus;
  /** The execution's EVM transfer reverted; shown instead of its settlement status. */
  reverted?: boolean;
}) {
  const s = reverted
    ? REVERTED
    : (EXECUTION_STATUS[status] ?? { label: status, tone: 'neutral' as Tone, explain: '' });
  return (
    <Badge tone={s.tone} dot title={s.explain}>
      {s.label}
    </Badge>
  );
}

export function ModeBadge({ mode }: { mode: Mode }) {
  if (mode === 'mock') return <SimBadge />;
  if (mode === 'local')
    return (
      <Badge tone="neutral" dot>
        Local node
      </Badge>
    );
  if (mode === 'off')
    return (
      <Badge tone="neutral" dot>
        Off
      </Badge>
    );
  if (mode === 'mixed')
    return (
      <Badge tone="wait" dot>
        Live for listed tokens
      </Badge>
    );
  return (
    <Badge tone="pass" dot>
      Live
    </Badge>
  );
}
