'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { OUTLAYER_LABEL, OutlayerEvidence } from '@/components/enclave-evidence';
import { useMeta } from '@/components/meta';
import { useOperator } from '@/components/operator';
import {
  BypassPanel,
  CancelControl,
  EnrollForm,
  FinalizeControl,
  finalizeReady,
  LaunchPanel,
  PendingChangePanel,
  RevealControl,
} from '@/components/plan-actions';
import { type ChangeContext, PlanBuilder } from '@/components/plan-builder';
import { PlanKeyNeeded, PlanKeyPanel, SavePlanKeyNotice, usePlanKey } from '@/components/plan-key';
import { CommitmentSeal } from '@/components/seal';
import { EXECUTION_STATUS, ExecutionStatusBadge, PlanStatusBadge } from '@/components/status';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Facts,
  Hash,
  LoadingBlock,
  Meter,
  PageHeader,
  Panel,
  ProofDetails,
  SimBadge,
  TabPanel,
  Tabs,
  useHashTab,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { isOutlayerQuote } from '@/lib/attestation';
import { backupPlan, loadBackup, type StoredPlanKey } from '@/lib/backup';
import { plainTokens } from '@/lib/builder';
import { useChainNow } from '@/lib/chain';
import { saleLabel } from '@/lib/copy';
import { type Explorer, evmChainName, explorer, nearChainName, simReason } from '@/lib/env';
import {
  duration,
  fmtDateTime,
  fmtTime,
  pctOf,
  periodWords,
  tokens,
  usdc,
  usdE6,
} from '@/lib/format';
import { failedAmount, soldAmount, tokenLaunched } from '@/lib/plan-state';
import type { Execution, Meta, PlanDetail } from '@/lib/types';
import { useResource } from '@/lib/use-resource';

const TABS = ['overview', 'sales', 'changes', 'proof'] as const;
type Tab = (typeof TABS)[number];

/** EVM hashes start with 0x; NEAR transaction hashes are base58. */
const txHref = (ex: Explorer, hash: string) =>
  hash.startsWith('0x') ? ex.evmTx(hash) : ex.nearTx(hash);

/** Sales whose MPC-signed EVM transfer was mined but reverted, by their EVM tx hash. */
function revertedTxs(d: PlanDetail): Set<string> {
  return new Set(
    d.activity
      .filter((a) => a.kind === 'evm_reverted' && typeof a.data?.evmTxHash === 'string')
      .map((a) => a.data?.evmTxHash as string),
  );
}

const isReverted = (x: Execution, reverted: Set<string>) =>
  !!x.evmTxHash && reverted.has(x.evmTxHash);

function StatusTimeline({ d, chainNow }: { d: PlanDetail; chainNow: number | null }) {
  const p = d.plan;
  const launched = tokenLaunched(d);
  const firstSale = [...d.receipts].sort((a, b) => a.seq - b.seq)[0];
  const ended = p.status === 'ended';
  const steps = [
    { title: 'Sealed and committed', done: true, at: fmtDateTime(p.created_at_ms) },
    {
      title: 'Enclave accepted',
      done: p.acked_at_ms !== null,
      at: p.acked_at_ms ? fmtDateTime(p.acked_at_ms) : 'Checking the sealed plan',
    },
    {
      title: 'Token launched',
      done: launched,
      // The launch time is the server's clock, not chain time like the other steps, so none is shown.
      at: launched ? 'Done' : ended ? 'Never launched' : 'Not yet',
      skipped: !launched && ended,
    },
    {
      title: p.status === 'ended' ? 'Ended' : 'Selling',
      done: !!firstSale || p.status === 'ended',
      at: ended
        ? launched
          ? 'Remainder released to the beneficiary'
          : 'Closed before launch'
        : firstSale
          ? `First sale signed ${fmtDateTime(firstSale.created_at_ms)}`
          : chainNow && chainNow < p.start_ms
            ? `Starts ${fmtDateTime(p.start_ms)}`
            : launched && p.acked_at_ms
              ? 'Waiting for the first sale'
              : 'After the launch',
    },
  ];
  const current = steps.findIndex((s) => !s.done && !('skipped' in s && s.skipped));
  return (
    <ol className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Plan progress">
      {steps.map((s, i) => (
        <li
          key={s.title}
          className={`border-t-2 pt-3 ${s.done ? 'border-accent' : i === current ? 'border-wait' : 'border-rule'}`}
          aria-current={i === current ? 'step' : undefined}
        >
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span
              className={`num inline-flex size-5 items-center justify-center rounded-full text-xs ${s.done ? 'bg-accent text-accent-ink' : i === current ? 'bg-wait-soft text-wait' : 'border border-rule text-ink-3'}`}
            >
              {i + 1}
            </span>
            {s.title}
          </p>
          <p className="num mt-1 text-xs text-ink-3">{s.at}</p>
        </li>
      ))}
    </ol>
  );
}

/** Proceeds for one sale: nothing for a sale that never sold. */
function Proceeds({ x, failed }: { x: Execution; failed: boolean }) {
  if (failed) return <span className="text-ink-3">None</span>;
  if (x.amountOut) return <>{usdc(x.amountOut)}</>;
  if (x.minAmountOut) return <span className="text-ink-3">≥ {usdc(x.minAmountOut)}</span>;
  return <>—</>;
}

function SalesTable({ d, ex }: { d: PlanDetail; ex: Explorer }) {
  const dec = d.plan.token_decimals;
  const symbol = d.summary.token.symbol;
  const reverted = revertedTxs(d);
  if (d.executions.length === 0)
    return (
      <EmptyState title="No sales yet">
        The enclave sells at random times inside the sealed plan, once the token is launched and the
        start time has passed.
      </EmptyState>
    );
  const failed = (x: Execution) =>
    x.status === 'settlement_failed' || x.status === 'refunded' || isReverted(x, reverted);
  const txCell = (x: Execution) =>
    x.evmTxHash ? (
      <Hash value={x.evmTxHash} label="EVM transaction" href={ex.evmTx(x.evmTxHash)} />
    ) : x.chainTx ? (
      <Hash value={x.chainTx} label="NEAR transaction" href={ex.nearTx(x.chainTx)} />
    ) : (
      '—'
    );
  return (
    <>
      <ul className="-mx-5 divide-y divide-rule-2 border-y border-rule-2 sm:hidden">
        {d.executions.map((x) => (
          <li key={x.seq} className="px-5 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{saleLabel(x.seq)}</span>
              <ExecutionStatusBadge status={x.status} reverted={isReverted(x, reverted)} />
            </div>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-ink-3">Amount</dt>
              <dd className={`num text-right ${failed(x) ? 'text-ink-3 line-through' : ''}`}>
                {tokens(x.amount, dec)} {symbol}
              </dd>
              <dt className="text-ink-3">Proceeds</dt>
              <dd className="num text-right">
                <Proceeds x={x} failed={failed(x)} />
              </dd>
              <dt className="text-ink-3">Transaction</dt>
              <dd className="min-w-0 text-right">{txCell(x)}</dd>
            </dl>
          </li>
        ))}
      </ul>
      <div className="-mx-5 hidden overflow-x-auto sm:block">
        <table className="table min-w-[680px]">
          <thead>
            <tr>
              <th scope="col">Sale</th>
              <th scope="col" className="r">
                Amount
              </th>
              <th scope="col">Status</th>
              <th scope="col" className="r">
                Proceeds
              </th>
              <th scope="col">Transaction</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {d.executions.map((x) => (
              <tr key={x.seq}>
                <td className="num font-medium whitespace-nowrap">{saleLabel(x.seq)}</td>
                <td
                  className={`num r whitespace-nowrap ${failed(x) ? 'text-ink-3 line-through' : ''}`}
                >
                  {tokens(x.amount, dec)} {symbol}
                </td>
                <td>
                  <ExecutionStatusBadge status={x.status} reverted={isReverted(x, reverted)} />
                  {x.chainError && <p className="mt-1 text-xs text-fail">{x.chainError}</p>}
                </td>
                <td className="num r whitespace-nowrap">
                  <Proceeds x={x} failed={failed(x)} />
                </td>
                <td>{txCell(x)}</td>
                <td className="num text-xs text-ink-3">{fmtTime(x.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EnclaveDownNote() {
  return (
    <div
      role="status"
      className="rounded-lg border border-wait/40 bg-wait-soft px-4 py-3 text-sm text-wait"
    >
      The enclave is unavailable, so sales are paused. Nobody can sell on its behalf; it resumes
      where it stopped.
    </div>
  );
}

function changeContext(d: PlanDetail): ChangeContext {
  const p = d.plan;
  const dec = p.token_decimals;
  const launch = d.activity.find((a) => a.kind === 'token_launched');
  const team = (launch?.data as { teamAllocation?: string } | null)?.teamAllocation ?? null;
  const env = p.pending_change?.envelope ?? p.envelope;
  return {
    planId: p.id,
    current: backupPlan(loadBackup(p.id, p.commitment)),
    token:
      p.asset.type === 'nep141'
        ? {
            chain: 'near',
            address: p.asset.token_id,
            symbol: d.summary.token.symbol,
            decimals: dec,
          }
        : {
            chain: 'evm',
            chain_id: p.asset.chain_id,
            address: p.asset.token_address,
            symbol: d.summary.token.symbol,
            decimals: dec,
          },
    beneficiaryNear: p.beneficiary.near_account,
    beneficiaryEvm: p.beneficiary.evm_address,
    startMs: p.start_ms,
    endMs: p.end_ms,
    periodMs: p.envelope.period_ms,
    envelope: {
      perPeriod: plainTokens(BigInt(env.max_amount_per_period), dec),
      perSale: plainTokens(BigInt(env.max_amount_per_tx), dec),
      minPrice: plainTokens(BigInt(env.min_price_usd_e6), 6),
      minGapMinutes: String(Math.round((env.min_gap_ms / 60_000) * 100) / 100),
    },
    allocation: team ? plainTokens(BigInt(team), dec) : null,
  };
}

/** One activity line. Long engine messages (raw client errors) are cut to their first line. */
function ActivityLog({ d, ex }: { d: PlanDetail; ex: Explorer }) {
  if (d.activity.length === 0) return <p className="text-sm text-ink-3">Nothing yet.</p>;
  return (
    <ol className="relative space-y-3 border-l border-rule pl-5">
      {d.activity.map((a) => {
        const tx =
          typeof a.data?.evmTxHash === 'string'
            ? a.data.evmTxHash
            : typeof a.data?.txHash === 'string'
              ? a.data.txHash
              : null;
        const firstLine = a.message.split('\n')[0] ?? a.message;
        const text = firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
        return (
          <li key={a.id} className="relative">
            <span
              aria-hidden="true"
              className={`absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-surface ${
                /refused|fail|skipped|unavailable|reverted/.test(a.kind) ? 'bg-wait' : 'bg-accent'
              }`}
            />
            {a.kind === 'dao_proposal' ? (
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                <Badge tone="accent">
                  DAO proposal
                  {typeof a.data?.proposalId === 'number' || typeof a.data?.proposalId === 'string'
                    ? ` #${a.data.proposalId}`
                    : ''}
                </Badge>
                {text}
              </p>
            ) : a.kind === 'sale_skipped' ? (
              <p className="text-sm">
                A scheduled sale was skipped.{' '}
                <span className="text-ink-3">The reason stays inside the enclave.</span>
              </p>
            ) : (
              <p className="text-sm break-words" title={a.message}>
                {text}
              </p>
            )}
            <p className="num flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
              {fmtDateTime(a.at)}
              {tx && <Hash value={tx} label="transaction hash" href={txHref(ex, tx)} />}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function OverviewTab({
  d,
  meta,
  chainNow,
  goTo,
}: {
  d: PlanDetail;
  meta: Meta | null;
  chainNow: number | null;
  goTo: (t: Tab) => void;
}) {
  const p = d.plan;
  const dec = p.token_decimals;
  const symbol = d.summary.token.symbol;
  const ex = explorer(meta);
  const periodCap = BigInt(p.envelope.max_amount_per_period);
  const counted = BigInt(p.sold_in_period);
  const failed = failedAmount(d);
  const launched = tokenLaunched(d);
  return (
    <>
      <Panel>
        <StatusTimeline d={d} chainNow={chainNow} />
      </Panel>

      {/* A cancellation in force is the finalize card's job above the tabs, so it is not repeated here. */}
      {p.pending_change && !finalizeReady(d, chainNow) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-wait/40 bg-wait-soft px-4 py-3 text-sm text-wait">
          <span>
            {p.pending_change.kind === 'cancel' ? 'A cancellation' : 'A change'} is pending.{' '}
            {chainNow !== null && chainNow >= p.pending_change.effective_at_ms
              ? 'Its cooling-off is over; the enclave applies it next.'
              : `It takes effect ${fmtDateTime(p.pending_change.effective_at_ms)}.`}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => goTo('changes')}
          >
            {p.pending_change.kind === 'cancel' ? 'See the cancellation' : 'See the change'}
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {p.receipt_count > 0 ? (
          <Panel
            title="Selling"
            description={`Period ${p.period_index + 1}; each period lasts ${periodWords(p.envelope.period_ms)}.`}
          >
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 flex flex-wrap justify-between gap-2 text-sm">
                  <span>Counted against this period’s cap</span>
                  <span className="num">
                    <span className="font-semibold">{tokens(counted, dec)}</span>
                    <span className="text-ink-3">
                      {' '}
                      of {tokens(periodCap, dec)} {symbol}
                    </span>
                  </span>
                </div>
                <Meter
                  value={pctOf(counted, periodCap)}
                  label="Share of the public per-period cap used"
                  tone={pctOf(counted, periodCap) > 90 ? 'wait' : 'accent'}
                />
                {failed > 0n && (
                  <p className="hint mt-1.5">
                    The registry counts every receipted sale, including ones that never sold, so the
                    cap only gets tighter.
                  </p>
                )}
              </div>
              <Facts
                items={[
                  [
                    'Sold',
                    <span key="t" className="num font-semibold">
                      {tokens(soldAmount(d), dec)} {symbol}
                    </span>,
                  ],
                  ...(failed > 0n
                    ? ([
                        [
                          'Not sold',
                          <span key="f" className="num">
                            {tokens(failed, dec)} {symbol}{' '}
                            <button
                              type="button"
                              className="link text-xs"
                              onClick={() => goTo('sales')}
                            >
                              see sales
                            </button>
                          </span>,
                        ],
                      ] as [string, ReactNode][])
                    : []),
                  [
                    'Held by the plan',
                    <span key="b" className="num">
                      {tokens(d.balance, dec)} {symbol}
                    </span>,
                  ],
                  ['Last sale', p.last_sale_ms ? fmtDateTime(p.last_sale_ms) : 'None yet'],
                ]}
              />
            </div>
          </Panel>
        ) : (
          <Panel title="Selling">
            <p className="text-sm text-ink-2">
              {launched
                ? `No sales yet. The first comes at a time only the enclave knows, after ${fmtDateTime(p.start_ms)}.`
                : p.status === 'ended' || finalizeReady(d, chainNow)
                  ? 'The plan closed before its token was launched; nothing was sold.'
                  : 'Sales start once the token is launched into the plan.'}
            </p>
            {launched && (
              <p className="mt-3 text-sm">
                Held by the plan:{' '}
                <span className="num font-semibold">
                  {tokens(d.balance, dec)} {symbol}
                </span>
              </p>
            )}
          </Panel>
        )}

        <Panel
          title="Terms everyone can see"
          description="The registry enforces these on every sale."
        >
          <Facts
            items={[
              [
                'Caps',
                <span key="c" className="num">
                  {tokens(p.envelope.max_amount_per_period, dec)} {symbol} per{' '}
                  {periodWords(p.envelope.period_ms)}, {tokens(p.envelope.max_amount_per_tx, dec)}{' '}
                  per sale
                </span>,
              ],
              [
                'Price floor',
                <span key="f" className="num">
                  {usdE6(p.envelope.min_price_usd_e6)}
                </span>,
              ],
              [
                'Runs',
                <span key="r" className="num">
                  {fmtDateTime(p.start_ms)} to {fmtDateTime(p.end_ms)}
                </span>,
              ],
              ['Cooling-off', duration(p.cooling_off_ms)],
              [
                'Beneficiary',
                <Hash
                  key="bn"
                  value={p.beneficiary.near_account}
                  label="beneficiary"
                  full
                  href={ex.nearAccount(p.beneficiary.near_account)}
                />,
              ],
            ]}
          />
        </Panel>
      </div>

      <ProofDetails summary={`Activity log (${d.activity.length})`}>
        <div className="pt-2">
          <ActivityLog d={d} ex={ex} />
        </div>
      </ProofDetails>
    </>
  );
}

function ProofTab({
  d,
  meta,
  canManage,
  planKey,
}: {
  d: PlanDetail;
  meta: Meta | null;
  canManage: boolean;
  planKey: StoredPlanKey | null;
}) {
  const p = d.plan;
  const ex = explorer(meta);
  return (
    <>
      <CommitmentSeal commitment={p.commitment} committedAtMs={p.created_at_ms} />
      {planKey?.saved && <PlanKeyPanel planId={p.id} stored={planKey} />}
      <Panel
        title="Plan account"
        description="Where the tokens are held, as this app reads it. The public page reads the chain itself."
        actions={
          <Link href={`/verify/${p.id}`} className="btn btn-secondary btn-sm">
            Check it yourself
          </Link>
        }
      >
        <Facts
          items={[
            [
              'Account',
              <Hash
                key="a"
                value={d.planAccount.id}
                label="plan account"
                full
                href={ex.nearAccount(d.planAccount.id)}
              />,
            ],
            [
              'Keys',
              <span key="k" className="flex flex-wrap items-center gap-2">
                <span className="num">{d.planAccount.accessKeys} full-access keys</span>
                {d.planAccount.accessKeys === 0 ? (
                  <Badge tone="pass" dot>
                    Nobody can sign for it
                  </Badge>
                ) : (
                  <Badge tone="fail" dot>
                    Has keys
                  </Badge>
                )}
              </span>,
            ],
            [
              'Runs code',
              d.planAccount.codeHash ? (
                <Hash key="c" value={d.planAccount.codeHash} label="code hash" head={10} />
              ) : (
                '—'
              ),
            ],
            ...(p.evm_address
              ? ([
                  [
                    `Address on ${evmChainName(meta)}`,
                    <span key="e">
                      <Hash
                        value={p.evm_address}
                        label="EVM address"
                        head={10}
                        tail={8}
                        href={ex.evmAddress(p.evm_address)}
                      />
                      <span className="block text-xs text-ink-3">
                        Chain Signatures path plan/{p.id}; only the registry can have it signed
                      </span>
                    </span>,
                  ],
                ] as [string, ReactNode][])
              : []),
          ]}
        />
      </Panel>
      {meta && isOutlayerQuote(meta.enclave.quote) && (
        <Panel title="Enclave" actions={<Badge tone="accent">{OUTLAYER_LABEL}</Badge>}>
          <OutlayerEvidence quote={meta.enclave.quote} meta={meta} />
        </Panel>
      )}
      {canManage && (
        <BypassPanel d={d} daoOwned={meta?.accounts.dao === p.owner} onDone={() => undefined} />
      )}
      <p className="text-sm text-ink-2">
        More attempts to get around a plan, and what the registry answered, are on the{' '}
        <Link href="/red-team" className="link">
          red-team page
        </Link>
        .
      </p>
    </>
  );
}

export default function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const [justCreated, setJustCreated] = useState(false);
  useEffect(() => setJustCreated(new URLSearchParams(window.location.search).has('created')), []);
  const meta = useMeta();
  const chainNow = useChainNow();
  const [changing, setChanging] = useState(false);
  const [tab, setTab] = useHashTab(TABS);
  const detail = useResource(() => api<PlanDetail>(`/api/plans/${id}`), [id], 4000);
  const d = detail.data;
  const planKey = usePlanKey(Number(id));
  const operator = useOperator();

  if (detail.error && !d)
    return detail.error instanceof ApiError && detail.error.status === 404 ? (
      <EmptyState
        title="Plan not found"
        action={
          <Link href="/app" className="btn btn-secondary">
            Back to your plans
          </Link>
        }
      >
        There is no plan #{id} owned by an account you can act as here.
      </EmptyState>
    ) : (
      <div className="space-y-4">
        <ErrorNote error={detail.error} retry={detail.reload} />
        <Link href="/app" className="link text-sm">
          Back to your plans
        </Link>
      </div>
    );
  if (!d)
    return (
      <div className="panel px-5 py-5">
        <LoadingBlock label="Loading plan" />
      </div>
    );

  const p = d.plan;
  const s = d.summary;
  const symbol = s.token.symbol;
  const launched = tokenLaunched(d);
  const reload = () => void detail.reload();
  const canChange = p.status === 'active' && !p.pending_change;
  const enclaveUp = meta.data?.sim.enclaveUp ?? true;
  const ex = explorer(meta.data);
  // Once a cancellation is in force (or the plan is over), finalizing is the only next step.
  const needsLaunch = !launched && p.status !== 'ended' && !finalizeReady(d, chainNow);
  const oneclickSim = simReason(meta.data, 'oneclick');
  const dao = meta.data?.accounts.dao === p.owner;
  // Owner actions need this plan's key or the operator's token; the API refuses them otherwise.
  const canManage = !!planKey || operator.status === 'operator';

  return (
    <div>
      <PageHeader
        meta={
          <>
            <Link href="/app" className="link text-sm">
              Your plans
            </Link>
            <span className="text-ink-3" aria-hidden="true">
              /
            </span>
            <span className="text-sm text-ink-3">Plan #{p.id}</span>
          </>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {p.label}
            <PlanStatusBadge status={p.status} pending={p.pending_change} chainNow={chainNow} />
          </span>
        }
        lead={
          <>
            {symbol} on{' '}
            {s.token.chain === 'near' ? nearChainName(meta.data) : evmChainName(meta.data)}. Owned
            by <span className="mono text-[0.9em]">{p.owner}</span>
            {dao ? ', acting through DAO proposals' : ''}.
          </>
        }
        actions={
          <Link href={`/verify/${p.id}`} className="btn btn-secondary">
            Public page
          </Link>
        }
      />

      <div className="space-y-4">
        {justCreated && p.status === 'awaiting_ack' && (
          <div
            className="rounded-lg border border-accent/40 bg-accent-soft px-4 py-3 text-sm"
            role="status"
          >
            Plan committed. The enclave is checking the sealed plan against the commitment and the
            public terms, then accepts it on-chain.
          </div>
        )}
        {planKey && !planKey.saved && <SavePlanKeyNotice planId={p.id} stored={planKey} />}
        {!enclaveUp && p.status === 'active' && <EnclaveDownNote />}
        {needsLaunch &&
          (canManage ? (
            <LaunchPanel d={d} meta={meta.data} onDone={reload} />
          ) : (
            <section className="panel px-5 py-4" aria-label={`Launch ${symbol}`}>
              <h2 className="font-semibold">Next: launch {symbol}</h2>
              <div className="mt-0.5">
                <PlanKeyNeeded planId={p.id} />
              </div>
            </section>
          ))}
        {!needsLaunch && finalizeReady(d, chainNow) && (
          <FinalizeControl d={d} chainNow={chainNow} onDone={reload} prominent />
        )}
      </div>

      <div className="mt-6">
        <Tabs
          idBase="plan"
          label="Plan sections"
          current={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            {
              id: 'sales',
              label: 'Sales',
              note: d.executions.length > 0 ? d.executions.length : undefined,
            },
            {
              id: 'changes',
              label: 'Changes',
              note: !p.pending_change
                ? undefined
                : chainNow !== null && chainNow >= p.pending_change.effective_at_ms
                  ? 'in force'
                  : 'pending',
            },
            { id: 'proof', label: 'Proof' },
          ]}
        />

        <TabPanel idBase="plan" id="overview" current={tab}>
          <OverviewTab d={d} meta={meta.data} chainNow={chainNow} goTo={setTab} />
        </TabPanel>

        <TabPanel idBase="plan" id="sales" current={tab}>
          <Panel
            title="Sales"
            description="Each sale the enclave signed, and where it is now."
            actions={
              p.receipt_count > 0 ? (
                <Link href={`/verify/${p.id}#receipts`} className="btn btn-secondary btn-sm">
                  Verify receipts
                </Link>
              ) : undefined
            }
          >
            {oneclickSim && d.executions.length > 0 && (
              <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-ink-2">
                <SimBadge>Simulated 1Click</SimBadge>
                Swaps settle through a 1Click simulator: {oneclickSim}.
              </p>
            )}
            <SalesTable d={d} ex={ex} />
            {d.executions.length > 0 && (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium text-ink-2">
                  What each status means
                </summary>
                <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {(Object.keys(EXECUTION_STATUS) as (keyof typeof EXECUTION_STATUS)[]).map((k) => (
                    <div key={k} className="flex gap-3 text-sm">
                      <dt className="w-36 shrink-0">
                        <ExecutionStatusBadge status={k} />
                      </dt>
                      <dd className="text-ink-2">{EXECUTION_STATUS[k].explain}</dd>
                    </div>
                  ))}
                  {s.token.chain === 'evm' && (
                    <div className="flex gap-3 text-sm">
                      <dt className="w-36 shrink-0">
                        <ExecutionStatusBadge status="settlement_failed" reverted />
                      </dt>
                      <dd className="text-ink-2">
                        The transfer reverted on {evmChainName(meta.data)}. No tokens moved and
                        nothing was sold.
                      </dd>
                    </div>
                  )}
                </dl>
              </details>
            )}
          </Panel>
        </TabPanel>

        <TabPanel idBase="plan" id="changes" current={tab}>
          <PendingChangePanel
            d={d}
            chainNow={chainNow}
            enclaveUp={enclaveUp}
            canManage={canManage}
            onDone={reload}
          />
          {p.status === 'ended' ? (
            <Panel title="The plan has ended" description="Nothing more can change or sell.">
              <RevealControl d={d} onDone={reload} />
            </Panel>
          ) : !canManage ? (
            <Panel
              title="Manage the plan"
              description={`Every change is public at once and waits ${duration(p.cooling_off_ms)} before it applies.`}
            >
              <div className="grid gap-6 md:grid-cols-2">
                {needsLaunch ? (
                  <p className="text-sm text-ink-2">
                    Owner actions need this plan’s key; paste it above.
                  </p>
                ) : (
                  <PlanKeyNeeded planId={p.id} />
                )}
                {!finalizeReady(d, chainNow) && (
                  <FinalizeControl d={d} chainNow={chainNow} onDone={reload} />
                )}
              </div>
            </Panel>
          ) : (
            <Panel
              title="Manage the plan"
              description={`Every change is public at once and waits ${duration(p.cooling_off_ms)} before it applies.`}
            >
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <p className="text-sm font-semibold">Change the plan</p>
                  <p className="mt-0.5 text-sm text-ink-2">
                    Write new sealed terms. The current plan keeps running meanwhile.
                  </p>
                  <button
                    type="button"
                    className="btn btn-secondary mt-2"
                    disabled={!canChange}
                    aria-expanded={changing}
                    aria-controls="change-plan"
                    onClick={() => setChanging((v) => !v)}
                  >
                    {changing ? 'Close' : 'Change plan'}
                  </button>
                  {p.pending_change && (
                    <p className="hint mt-1">Withdraw the pending request first.</p>
                  )}
                </div>
                <CancelControl d={d} onDone={reload} />
                {s.token.chain === 'near' ? (
                  launched && <EnrollForm d={d} onDone={reload} />
                ) : (
                  <div>
                    <p className="text-sm font-semibold">Add more tokens</p>
                    <p className="mt-0.5 text-sm text-ink-2">
                      Send them to the plan’s address on {evmChainName(meta.data)} (Proof tab). Once
                      there, they follow the plan like the rest.
                    </p>
                  </div>
                )}
                {!finalizeReady(d, chainNow) && (
                  <FinalizeControl d={d} chainNow={chainNow} onDone={reload} />
                )}
              </div>
            </Panel>
          )}
          {changing && meta.data && canChange && canManage && (
            <section id="change-plan" className="panel px-5 py-6 sm:px-7" aria-label="Change plan">
              <PlanBuilder
                meta={meta.data}
                actor={p.owner}
                change={changeContext(d)}
                onDone={() => {
                  setChanging(false);
                  reload();
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              />
            </section>
          )}
        </TabPanel>

        <TabPanel idBase="plan" id="proof" current={tab}>
          <ProofTab d={d} meta={meta.data} canManage={canManage} planKey={planKey} />
        </TabPanel>
      </div>
    </div>
  );
}
