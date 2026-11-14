'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { OUTLAYER_LABEL, OutlayerEvidence } from '@/components/enclave-evidence';
import { EnvelopeDiff } from '@/components/envelope-diff';
import { useMeta } from '@/components/meta';
import { CHANGE_LAPSE_MS, pendingPhase } from '@/components/plan-actions';
import { ReceiptCard, revertedTx, useReceiptVerifier } from '@/components/receipts';
import { RevealPanel } from '@/components/reveal';
import { CommitmentSeal } from '@/components/seal';
import { PlanStatusBadge } from '@/components/status';
import {
  Badge,
  CheckMark,
  EmptyState,
  ErrorNote,
  Facts,
  Hash,
  LoadingBlock,
  Meter,
  PageHeader,
  Panel,
  SimBadge,
  TabPanel,
  Tabs,
  useHashTab,
} from '@/components/ui';
import { UnsentSales } from '@/components/unsent-sales';
import { isOutlayerQuote, onEarlierBuild, planEnclave } from '@/lib/attestation';
import {
  accessKeys,
  DEFAULT_NEAR_RPC,
  erc20Balance,
  erc20Symbol,
  ftBalance,
  nearRpcUrl,
  nearView,
  registry,
  setNearRpcUrl,
  useChainNow,
  viewAccount,
} from '@/lib/chain';
import { envelopeLines, toEnvelope } from '@/lib/copy';
import { evmChainName, explorer, simReason } from '@/lib/env';
import { duration, fmtDateTime, pctOf, periodWords, tokens } from '@/lib/format';
import type { ChainPlan, Meta, RegistryConfig } from '@/lib/types';
import { useResource } from '@/lib/use-resource';

/** Everything on this page, read from the chains. The app's own API is not consulted. */
async function readFromChain(registryId: string, id: number) {
  const plan = await registry.plan(registryId, id);
  if (!plan) return null;
  const [config, receipts, enclaves, planKeys, registryKeys, account, quoteSigners, reveal] =
    await Promise.all([
      registry.config(registryId),
      registry.receipts(registryId, id),
      registry.enclaves(registryId),
      accessKeys(plan.plan_account),
      accessKeys(registryId),
      viewAccount(plan.plan_account),
      registry.quoteSigners(registryId),
      registry.reveal(registryId, id),
    ]);
  const balance = await (plan.asset.type === 'nep141'
    ? ftBalance(plan.asset.token_id, plan.plan_account)
    : plan.evm_address
      ? erc20Balance(plan.asset.token_address, plan.evm_address)
      : Promise.resolve(0n)
  ).catch(() => null);
  const symbol = await (plan.asset.type === 'nep141'
    ? nearView<{ symbol: string }>(plan.asset.token_id, 'ft_metadata').then((m) => m.symbol)
    : erc20Symbol(plan.asset.token_address)
  ).catch(() => 'tokens');
  const codeHash = account.global_contract_hash ?? account.code_hash ?? null;
  return {
    plan,
    config,
    receipts,
    enclaves,
    planKeys,
    registryKeys,
    balance,
    symbol,
    codeHash,
    quoteSigners,
    reveal,
  };
}

function KeylessCheck({
  title,
  ok,
  children,
}: {
  title: string;
  ok: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <CheckMark state={ok ? 'pass' : 'fail'} />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <div className="mt-0.5 text-sm text-ink-2">{children}</div>
      </div>
    </div>
  );
}

function DisclosureNote({ plan }: { plan: ChainPlan }) {
  const d = plan.disclosure;
  return (
    <p className="text-sm text-ink-2">
      {d.type === 'realtime'
        ? 'Sale amounts are shown as soon as each receipt is recorded.'
        : d.type === 'delayed'
          ? `Each sale’s compliance is shown at once; its amount ${periodWords(d.delay_ms)} later.`
          : 'Sale amounts are shown as recorded; the full sealed plan is revealed after it ends and checked against the commitment.'}
    </p>
  );
}

/** Lets a holder read from their own NEAR node instead of the operator's proxy. */
function RpcSetting() {
  const uid = useId();
  const [value, setValue] = useState('');
  const [current, setCurrent] = useState(DEFAULT_NEAR_RPC);
  useEffect(() => {
    setCurrent(nearRpcUrl());
    setValue(nearRpcUrl());
  }, []);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setNearRpcUrl(value.trim() || null);
        window.location.reload();
      }}
    >
      <div className="min-w-56 flex-1">
        <label htmlFor={`${uid}-rpc`} className="label">
          NEAR RPC endpoint this page reads from
        </label>
        <input
          id={`${uid}-rpc`}
          className="input mono text-[0.8125rem]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={DEFAULT_NEAR_RPC}
        />
      </div>
      <button type="submit" className="btn btn-secondary">
        Use this endpoint
      </button>
      {current !== DEFAULT_NEAR_RPC && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setNearRpcUrl(null);
            window.location.reload();
          }}
        >
          Reset to {DEFAULT_NEAR_RPC}
        </button>
      )}
      <p className="hint w-full">
        Now: <span className="mono">{current}</span>
        {current === DEFAULT_NEAR_RPC
          ? ', a read-only proxy run by the operator. Point this at your own node to stop trusting it.'
          : ', your own choice.'}
      </p>
    </form>
  );
}

function NotGuaranteed({ config, meta }: { config: RegistryConfig; meta: Meta | null }) {
  const enclaveSim = simReason(meta, 'enclave');
  const oneclickSim = simReason(meta, 'oneclick');
  return (
    <Panel
      title="What this does not guarantee"
      description="The limits of what this page can prove, stated plainly."
    >
      <ul className="list-disc space-y-2 pl-5 text-sm">
        <li>
          After a cancellation’s cooling-off, or at the end date, the unsold tokens go back to the
          beneficiary. A plan limits how tokens are sold while it runs; it does not lock them
          forever.
        </li>
        <li>
          A change can loosen the public bounds, but only after a public cooling-off. Holders see
          the new bounds before they apply.
        </li>
        <li>
          The governance account <span className="mono">{config.governance}</span> can pause the
          registry and add enclave or quote-signer keys. New keys act only after the public
          activation delay ({duration(config.enclave_activation_delay_ms)}). Pausing stops sales; it
          opens no way to take the tokens.
        </li>
        <li>
          This page reads through an RPC endpoint. A dishonest endpoint could lie about chain state,
          so you can use your own.
        </li>
        {/* A live enclave's evidence panel already says this. */}
        {!isOutlayerQuote(meta?.enclave.quote) && (
          <li>
            The enclave’s attestation quote is served by the operator. The browser checks it against
            the quote hash registered on-chain.
          </li>
        )}
        {enclaveSim && (
          <li>
            Here the enclave is simulated ({enclaveSim}), so this server’s operator could read the
            sealed plans. With a real TEE, nobody outside the enclave can.
          </li>
        )}
        {oneclickSim && (
          <li>
            Quotes use 1Click’s real signature format, but here a simulator signs them with its own
            key ({oneclickSim}).
          </li>
        )}
        <li>
          It proves how enrolled tokens were handled, not what the owner does with tokens outside
          the plan or with derivatives.
        </li>
      </ul>
    </Panel>
  );
}

const TABS = ['overview', 'receipts', 'proof'] as const;

export default function VerifyPlanPage() {
  const { id } = useParams<{ id: string }>();
  const planId = Number(id);
  const meta = useMeta();
  const registryId = meta.data?.accounts.registry;
  const chainNow = useChainNow();
  const [tab, setTab] = useHashTab(TABS);
  const data = useResource(
    registryId && Number.isInteger(planId) && planId > 0
      ? () => readFromChain(registryId, planId)
      : null,
    [registryId, planId],
    5000,
  );
  const d = data.data;
  const verifier = useReceiptVerifier(
    d?.plan ?? null,
    d?.enclaves ?? null,
    meta.data,
    d?.quoteSigners ?? d?.config.quote_signer ?? null,
  );

  // An EVM sale is only a sale if its signed transfer succeeded, which the chain alone cannot say
  // without checking each one; so EVM receipts are checked as soon as they load, once each.
  const autoChecked = useRef(new Set<number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when new receipts arrive.
  useEffect(() => {
    if (d?.plan.asset.type !== 'evm_erc20') return;
    for (const r of d.receipts) {
      if (r.kind !== 'sale' || !r.request_json || autoChecked.current.has(r.seq)) continue;
      autoChecked.current.add(r.seq);
      void verifier.run(r);
    }
  }, [d?.receipts.length, d?.plan.asset.type, d?.enclaves]);

  if (!Number.isInteger(planId) || planId <= 0)
    return <ErrorNote error={`“${id}” is not a plan number`} />;
  if ((data.error || meta.error) && !d)
    return (
      <div className="space-y-3">
        <ErrorNote
          error={data.error ?? meta.error ?? 'Could not read the chain'}
          retry={data.reload}
        />
        <p className="text-sm text-ink-3">This page keeps retrying every few seconds.</p>
      </div>
    );
  if (!data.data && data.loading)
    return (
      <div className="panel px-5 py-5">
        <LoadingBlock label="Reading the registry" />
      </div>
    );
  if (!d)
    return (
      <EmptyState
        title={`Plan #${planId} is not in the registry`}
        action={
          <Link href="/verify" className="btn btn-secondary">
            See all plans
          </Link>
        }
      >
        The registry on this chain has no plan with that number.
      </EmptyState>
    );

  const { plan, symbol, config } = d;
  const m = meta.data;
  const ex = explorer(m);
  const evmName = evmChainName(m);
  const dec = plan.token_decimals;
  const envelope = toEnvelope(plan.envelope);
  const pending = plan.pending_change;
  const phase = pending ? pendingPhase(pending, chainNow) : null;
  const left = pending && chainNow ? pending.effective_at_ms - chainNow : null;
  const keyless = d.planKeys.fullAccess === 0;
  const codeMatches = !!d.codeHash && d.codeHash === config.plan_account_code_hash;
  const sales = d.receipts.filter((r) => r.kind === 'sale');
  const delayed = plan.disclosure.type === 'delayed';
  const disclosed =
    delayed && chainNow
      ? sales.filter(
          (r) => r.created_at_ms + (plan.disclosure as { delay_ms: number }).delay_ms <= chainNow,
        )
      : sales;
  const allHidden = delayed && disclosed.length < sales.length;
  // Sales carry the enclave's signed request; releases carry none and are checked against the plan
  // and the registry receipt.
  const verifiable = d.receipts.filter((r) => r.kind === 'release' || r.request_json);
  const reverted = sales.filter((r) => revertedTx(verifier.results[r.seq]) !== null);
  const revertedAmount = reverted.reduce((sum, r) => sum + BigInt(r.amount), 0n);
  const finished = verifiable.flatMap((r) => {
    const x = verifier.results[r.seq];
    return x && x !== 'running' && !('error' in x) ? [x] : [];
  });
  const verifiedCount = finished.filter((x) => x.ok && x.complete).length;
  const soFarCount = finished.filter((x) => x.ok && !x.complete).length;
  const failedCount = finished.filter((x) => !x.ok).length - reverted.length;
  const unchecked = verifiable.filter((r) => {
    const x = verifier.results[r.seq];
    return x && x !== 'running' && 'error' in x;
  });
  const anyRunning = Object.values(verifier.results).some((x) => x === 'running');
  const enclaveSim = simReason(m, 'enclave');
  const planBuild = m ? planEnclave(m, plan.acked_by) : null;
  const planQuote = planBuild?.quote ?? null;
  // Accepted by an enclave whose attestation this server does not serve.
  const unservedKey = m && !planBuild ? plan.acked_by : null;
  const liveQuote = isOutlayerQuote(planQuote) ? planQuote : null;
  const oneclickSim = simReason(m, 'oneclick');
  const mpcSim = simReason(m, 'chainSignatures');
  const custody = [keyless, codeMatches, d.registryKeys.total === 0, !!config.quote_signer];

  return (
    <div>
      <PageHeader
        meta={
          <>
            <Link href="/verify" className="link text-sm">
              Public verifier
            </Link>
            <span className="text-ink-3" aria-hidden="true">
              /
            </span>
            <span className="text-sm text-ink-3">Plan #{plan.id}</span>
          </>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {plan.label}
            <PlanStatusBadge status={plan.status} pending={pending} chainNow={chainNow} />
          </span>
        }
        lead={
          <>
            Owned by <span className="mono text-[0.9em]">{plan.owner}</span>. Your browser reads
            everything here from the chain, not from the operator. The plan’s terms stay sealed.
          </>
        }
      />

      {data.error && (
        <div className="mb-4">
          <ErrorNote
            error={`Showing the last successful read. ${data.error.message}. Retrying.`}
            retry={data.reload}
          />
        </div>
      )}

      <Tabs
        idBase="verify"
        label="Plan sections"
        current={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          {
            id: 'receipts',
            label: 'Receipts',
            note: d.receipts.length > 0 ? d.receipts.length : undefined,
          },
          { id: 'proof', label: 'Proof' },
        ]}
      />

      <TabPanel idBase="verify" id="overview" current={tab}>
        {pending && (
          <section className="panel border-wait/40 px-5 py-4" aria-labelledby="cooling">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-[70ch]">
                <h2 id="cooling" className="font-semibold">
                  {pending.kind === 'cancel'
                    ? phase === 'cancel_in_force'
                      ? 'This plan is cancelled; its cooling-off is over'
                      : 'The owner asked to cancel this plan'
                    : phase === 'awaiting_enclave'
                      ? 'A change is past its cooling-off and waits for the enclave to apply it'
                      : 'The owner asked to change this plan'}
                </h2>
                <p className="mt-1 text-sm text-ink-2">
                  Requested {fmtDateTime(pending.requested_at_ms)}.{' '}
                  {phase === 'cooling'
                    ? `Until the cooling-off ends, the current plan stays in force and the ${pending.kind === 'cancel' ? 'cancellation' : 'new plan'} cannot act.`
                    : phase === 'cancel_in_force'
                      ? 'Anyone can now finalize the plan, which releases the unsold tokens to the beneficiary.'
                      : `The current plan keeps running until then. If the enclave has not applied it by ${fmtDateTime(pending.effective_at_ms + CHANGE_LAPSE_MS)}, the change lapses.`}
                </p>
                {pending.commitment && (
                  <p className="mt-2 text-sm">
                    New commitment{' '}
                    <Hash value={pending.commitment} label="new commitment" head={12} />
                  </p>
                )}
              </div>
              {phase === 'cooling' && (
                <div className="text-right">
                  <p className="num text-2xl font-semibold">
                    {left === null ? '…' : duration(left)}
                  </p>
                  <p className="text-xs text-ink-3">
                    left; effective {fmtDateTime(pending.effective_at_ms)}
                  </p>
                </div>
              )}
            </div>
            {pending.envelope && (
              <EnvelopeDiff
                current={plan.envelope}
                pending={pending.envelope}
                symbol={symbol}
                decimals={dec}
              />
            )}
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <Panel
            title="Can anyone move these tokens outside the plan?"
            description={
              custody.every(Boolean)
                ? 'No. Each answer below was read from the chain just now.'
                : 'Some checks failed. Read each answer below.'
            }
          >
            <div className="space-y-4">
              <KeylessCheck
                title={keyless ? 'The plan account has no keys' : 'The plan account has keys'}
                ok={keyless}
              >
                <span className="mono break-words">{plan.plan_account}</span>{' '}
                {keyless
                  ? 'has no key anyone could sign with. It acts only through its code.'
                  : `holds ${d.planKeys.fullAccess} full-access key(s).`}
              </KeylessCheck>
              <KeylessCheck title="It runs the registry’s plan-account code" ok={codeMatches}>
                {codeMatches
                  ? 'Its code hash is the one the registry pins.'
                  : 'Its code hash differs from the registry’s.'}
              </KeylessCheck>
              <KeylessCheck
                title={
                  d.registryKeys.total === 0
                    ? 'The registry’s code cannot change'
                    : `The registry has ${d.registryKeys.total} access key(s)`
                }
                ok={d.registryKeys.total === 0}
              >
                No keys and no upgrade method. Governance can pause it and add keys, only after a
                public delay.
              </KeylessCheck>
              <KeylessCheck
                title="Every sale needs a signed 1Click quote"
                ok={!!config.quote_signer}
              >
                {config.quote_signer
                  ? 'The quote binds the amount, the minimum output and who gets paid.'
                  : 'No quote signer is registered, so no sale can execute.'}
                {oneclickSim && (
                  <span className="mt-1 flex flex-wrap items-center gap-2">
                    <SimBadge>Simulated 1Click</SimBadge>
                    <span className="text-xs text-ink-3">{oneclickSim}.</span>
                  </span>
                )}
              </KeylessCheck>
              {plan.evm_address && (
                <KeylessCheck title={`Tokens on ${evmName} sit at a keyless address`} ok>
                  Derived through Chain Signatures from the registry; only the registry can have it
                  signed.
                  {mpcSim && (
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <SimBadge>Simulated MPC</SimBadge>
                      <span className="text-xs text-ink-3">
                        {mpcSim.charAt(0).toUpperCase()}
                        {mpcSim.slice(1)}.
                      </span>
                    </span>
                  )}
                </KeylessCheck>
              )}
            </div>
          </Panel>

          <Panel
            title="Public limits"
            description="The registry refuses any sale outside these, whatever the enclave asks."
          >
            <ul className="list-disc space-y-1.5 pl-5 text-sm">
              {envelopeLines(envelope, symbol, dec).map((l) => (
                <li key={l}>{l}</li>
              ))}
              <li>
                Runs {fmtDateTime(plan.start_ms)} to {fmtDateTime(plan.end_ms)}; the remainder then
                goes to <span className="mono break-words">{plan.beneficiary.near_account}</span>.
              </li>
              <li>Any change or cancellation waits {duration(plan.cooling_off_ms)} in public.</li>
            </ul>
            <div className="mt-4 border-t border-rule-2 pt-4">
              <div className="mb-1.5 flex flex-wrap justify-between gap-2 text-sm">
                <span>Counted in period {plan.period_index + 1}</span>
                {allHidden ? (
                  <span className="text-ink-3">Disclosed after the delay</span>
                ) : (
                  <span className="num">
                    <span className="font-semibold">{tokens(plan.sold_in_period, dec)}</span>
                    <span className="text-ink-3">
                      {' '}
                      of {tokens(envelope.max_amount_per_period, dec)} {symbol}
                    </span>
                  </span>
                )}
              </div>
              {!allHidden && (
                <Meter
                  value={pctOf(BigInt(plan.sold_in_period), envelope.max_amount_per_period)}
                  label="Share of the per-period cap used"
                />
              )}
              <p className="mt-2 text-sm text-ink-2">
                {allHidden
                  ? `${sales.length} sale${sales.length === 1 ? '' : 's'} recorded; amounts are disclosed after the delay.`
                  : `${sales.length - reverted.length} sale${sales.length - reverted.length === 1 ? '' : 's'}, ${tokens(BigInt(plan.sold_total) - revertedAmount, dec)} ${symbol} sent to 1Click to sell. A swap 1Click refunds returns its tokens to the plan, as the balance below shows.`}
                {reverted.length > 0 &&
                  (allHidden
                    ? ` ${reverted.length} of them reverted on ${evmName} and sold nothing; the registry still counts ${reverted.length === 1 ? 'it' : 'them'} against the caps.`
                    : ` ${reverted.length} more ${reverted.length === 1 ? 'was' : 'were'} recorded but reverted on ${evmName}, so nothing sold; the registry still counts ${reverted.length === 1 ? 'it' : 'them'} against the caps.`)}
              </p>
              {!allHidden && (
                <p className="mt-1 text-sm text-ink-2">
                  Held by the plan:{' '}
                  <span className="num font-semibold text-ink">
                    {d.balance === null ? 'unavailable' : `${tokens(d.balance, dec)} ${symbol}`}
                  </span>
                </p>
              )}
            </div>
          </Panel>
        </div>
      </TabPanel>

      <TabPanel idBase="verify" id="receipts" current={tab}>
        <RevealPanel plan={plan} reveal={d.reveal} receipts={d.receipts} />
        {plan.status === 'active' && <UnsentSales planId={plan.id} canSend={false} />}
        <Panel
          id="receipts"
          title="Receipt trail"
          description={`One receipt per sale${d.receipts.some((r) => r.kind === 'release') ? ', and one for the end-of-plan release' : ''}. Each sale’s receipt proves, with yes/no answers, that it followed the sealed plan.`}
          actions={
            verifiable.length > 0 ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={anyRunning}
                onClick={() => {
                  for (const r of verifiable) void verifier.run(r);
                }}
              >
                {anyRunning ? 'Verifying…' : 'Verify all'}
              </button>
            ) : undefined
          }
        >
          <div className="mb-4 space-y-2">
            <DisclosureNote plan={plan} />
            {liveQuote && d.receipts.length > 0 ? (
              <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
                <Badge tone="accent">{OUTLAYER_LABEL}</Badge>
                <span>
                  Enclave on OutLayer. Its attestation evidence is under{' '}
                  <button type="button" className="link" onClick={() => setTab('proof')}>
                    Proof
                  </button>
                  .
                </span>
              </p>
            ) : unservedKey && d.receipts.length > 0 ? (
              <p className="text-sm text-ink-2">
                The enclave key that accepted this plan (
                <Hash value={unservedKey} label="enclave key" head={14} />) has no attestation this
                server can show, so its receipts cannot be tied to measured code and fail that
                check. Every other check still runs.
              </p>
            ) : (
              enclaveSim &&
              d.receipts.length > 0 && (
                <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
                  <SimBadge>Simulated TDX</SimBadge>
                  Attestation checks run on a simulated TDX quote: {enclaveSim}.
                </p>
              )
            )}
            {verifiable.length > 0 && finished.length > 0 && (
              <p className="flex flex-wrap gap-2">
                <Badge tone={verifiedCount === verifiable.length ? 'pass' : 'neutral'} dot>
                  {verifiedCount} of {verifiable.length} verified in this browser
                </Badge>
                {soFarCount > 0 && (
                  <Badge tone="wait" dot>
                    {soFarCount} verified so far, waiting on the chain
                  </Badge>
                )}
                {reverted.length > 0 && (
                  <Badge tone="fail" dot>
                    {reverted.length} transfer{reverted.length === 1 ? '' : 's'} reverted: not sold
                  </Badge>
                )}
                {failedCount > 0 && (
                  <Badge tone="fail" dot>
                    {failedCount} failed verification
                  </Badge>
                )}
              </p>
            )}
            {unchecked.length > 0 && !anyRunning && (
              <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
                <Badge tone="wait" dot>
                  {unchecked.length} could not be checked
                </Badge>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    for (const r of unchecked) void verifier.run(r);
                  }}
                >
                  Try {unchecked.length === 1 ? 'it' : 'them'} again
                </button>
              </p>
            )}
          </div>
          {d.receipts.length === 0 ? (
            <EmptyState title={plan.status === 'ended' ? 'No sales' : 'No receipts yet'}>
              {plan.status === 'ended'
                ? 'This plan ended without selling anything.'
                : 'The first receipt appears with the first sale, at a time nobody outside the enclave can predict.'}
            </EmptyState>
          ) : (
            <ol className="space-y-3">
              {[...d.receipts].reverse().map((r) => (
                <ReceiptCard
                  key={r.seq}
                  plan={plan}
                  receipt={r}
                  symbol={symbol}
                  chainNow={chainNow}
                  result={verifier.results[r.seq]}
                  onVerify={() => void verifier.run(r)}
                  ex={ex}
                  evmName={evmName}
                />
              ))}
            </ol>
          )}
          {delayed && (
            <p className="mt-5 border-t border-rule-2 pt-4 text-xs text-ink-3">
              Delayed disclosure governs what this page shows. Each transfer to 1Click is an
              ordinary on-chain transaction and the registry’s totals are public, so anyone reading
              the chain directly can see amounts sooner.
            </p>
          )}
        </Panel>
      </TabPanel>

      <TabPanel idBase="verify" id="proof" current={tab}>
        <CommitmentSeal commitment={plan.commitment} committedAtMs={plan.created_at_ms} />
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <div className="space-y-6">
            <Panel title="Chain facts" description="The raw values behind the overview’s answers.">
              <Facts
                items={[
                  [
                    'Registry',
                    <Hash
                      key="r"
                      value={m?.accounts.registry ?? ''}
                      label="registry"
                      full
                      href={ex.nearAccount(m?.accounts.registry ?? '')}
                    />,
                  ],
                  [
                    'Plan account',
                    <Hash
                      key="a"
                      value={plan.plan_account}
                      label="plan account"
                      full
                      href={ex.nearAccount(plan.plan_account)}
                    />,
                  ],
                  [
                    'Plan account code',
                    d.codeHash ? <Hash key="c" value={d.codeHash} label="code hash" /> : 'none',
                  ],
                  [
                    'Code the registry pins',
                    config.plan_account_code_hash ? (
                      <Hash
                        key="p"
                        value={config.plan_account_code_hash}
                        label="pinned code hash"
                      />
                    ) : (
                      'none'
                    ),
                  ],
                  ...(plan.evm_address
                    ? ([
                        [
                          `Address on ${evmName}`,
                          <span key="e">
                            <Hash
                              value={plan.evm_address}
                              label="EVM address"
                              head={10}
                              tail={8}
                              href={ex.evmAddress(plan.evm_address)}
                            />
                            <span className="block text-xs text-ink-3">
                              Chain Signatures path plan/{plan.id}
                            </span>
                          </span>,
                        ],
                      ] as [string, ReactNode][])
                    : []),
                  ...(config.quote_signer
                    ? ([
                        [
                          '1Click quote key',
                          <Hash
                            key="q"
                            value={config.quote_signer}
                            label="quote signer"
                            head={14}
                          />,
                        ],
                      ] as [string, ReactNode][])
                    : []),
                  [
                    'Enclave accepted',
                    plan.acked_at_ms ? fmtDateTime(plan.acked_at_ms) : 'not yet',
                  ],
                  ...(plan.acked_by
                    ? ([
                        [
                          'Enclave key',
                          <span key="k">
                            <Hash value={plan.acked_by} label="enclave key" head={14} />
                            {onEarlierBuild(m, plan.acked_by) && (
                              <span className="block text-xs text-ink-3">
                                An earlier build of the enclave; the plan runs there
                              </span>
                            )}
                          </span>,
                        ],
                      ] as [string, ReactNode][])
                    : []),
                ]}
              />
            </Panel>
            <Panel
              title="Where this page reads from"
              description="Every check uses chain data your browser fetches through this endpoint."
            >
              <RpcSetting />
            </Panel>
          </div>
          <div className="space-y-6">
            {liveQuote && (
              <Panel title="Enclave" actions={<Badge tone="accent">{OUTLAYER_LABEL}</Badge>}>
                <OutlayerEvidence quote={liveQuote} meta={m} />
              </Panel>
            )}
            <NotGuaranteed config={config} meta={m} />
          </div>
        </div>
      </TabPanel>
    </div>
  );
}
