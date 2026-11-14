'use client';

import Link from 'next/link';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import {
  fundPlan,
  launchFee,
  nearAmount,
  type PlanBudget,
  parseNear,
  SUGGESTED_SALES,
  saleFee,
  suggestedTopUp,
  type WalletCall,
  WalletDeclined,
} from '@/lib/owner-write';
import { useMe } from '@/lib/session';
import { useResource } from '@/lib/use-resource';
import { ErrorNote, Facts, Panel } from './ui';

/** What each registry or token method does, in the owner's words. */
const CALL_WORDS: Record<string, string> = {
  create_plan: 'commits the plan on chain and creates its keyless plan account',
  request_change: 'publishes the plan change and starts its cooling-off',
  request_cancel: 'publishes the cancellation and starts its cooling-off',
  withdraw_change: 'withdraws the pending request',
  ft_transfer_call: 'moves the tokens from your account into the plan',
  ft_transfer: 'moves the tokens from your account into the plan',
  release_evm: 'asks the registry to sign the release of the remainder to the beneficiary',
  resign_evm: 'asks the registry to re-sign the stuck transfer with higher fees',
};

/** NEAR's gas price on testnet is 0.1 nanoNEAR per gas: 1 Tgas costs at most 0.0001 NEAR. */
const NEAR_PER_TGAS = 0.0001;

function depositWords(deposit: string): string {
  const v = BigInt(deposit);
  if (v === 0n) return 'Nothing is attached.';
  if (v === 1n) return 'It attaches 1 yoctoNEAR, the confirmation NEAR asks for; not a payment.';
  return `It attaches ${nearAmount(v)}, paid from your wallet.`;
}

/**
 * The owner's go-ahead for one wallet call, shown before the wallet opens. Says what is signed,
 * what it costs and that the wallet pays.
 */
function WalletPrompt({
  call,
  note,
  onSign,
  onCancel,
}: {
  call: WalletCall;
  note?: ReactNode;
  onSign: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const gas = Number(call.gasTera);
  return (
    <section
      className="mt-4 rounded-lg border border-accent/50 bg-accent-soft/40 px-4 py-3 text-sm"
      aria-labelledby={id}
    >
      <h3 id={id} className="font-semibold">
        Sign with your wallet
      </h3>
      <p className="mt-1 text-ink-2">
        Your wallet signs <span className="mono text-ink">{call.method}</span> on{' '}
        <span className="mono text-ink">{call.receiverId}</span>, which{' '}
        {CALL_WORDS[call.method] ?? 'makes this change'}. {depositWords(call.deposit)}
      </p>
      <p className="mt-1 text-ink-2">
        Gas: up to {gas} Tgas, at most about {(gas * NEAR_PER_TGAS).toFixed(4)} NEAR; unused gas
        comes back. Glidepath never holds your keys: the transaction is yours.
      </p>
      {note && <div className="mt-1 text-ink-2">{note}</div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" onClick={onSign}>
          Open the wallet
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Not now
        </button>
      </div>
    </section>
  );
}

/**
 * Asks before the wallet opens: `confirm` (pass it to `ownerWrite`) resolves when the owner chooses
 * to sign and rejects with `WalletDeclined` otherwise; render `prompt` where the action is.
 */
export function useWalletPrompt(note?: ReactNode) {
  const [pending, setPending] = useState<{
    call: WalletCall;
    resolve: () => void;
    reject: (e: Error) => void;
  } | null>(null);
  const confirm = useCallback(
    (call: WalletCall) =>
      new Promise<void>((resolve, reject) => setPending({ call, resolve, reject })),
    [],
  );
  const prompt = pending ? (
    <WalletPrompt
      call={pending.call}
      note={note}
      onSign={() => {
        pending.resolve();
        setPending(null);
      }}
      onCancel={() => {
        pending.reject(new WalletDeclined());
        setPending(null);
      }}
    />
  ) : null;
  return { confirm, prompt, call: pending?.call ?? null };
}

/** An error to show for an owner action; a declined prompt is not one. */
export const actionError = (e: unknown): string | null =>
  e instanceof WalletDeclined ? null : errorMessage(e);

export function usePlanBudget(planId: number, enabled: boolean) {
  return useResource(
    enabled ? () => api<PlanBudget>(`/api/plans/${planId}/budget`) : null,
    [planId, enabled],
    enabled ? 15_000 : undefined,
  );
}

/** The relayer's published prices, in plain words. */
export function FeeList({
  budget,
  chain,
  launched = false,
}: {
  budget: PlanBudget;
  chain: 'near' | 'evm';
  launched?: boolean;
}) {
  const f = budget.fees;
  const rows: [string, string][] = [
    ...(launched
      ? []
      : [['Launching the token', nearAmount(launchFee(budget, chain))] as [string, string]]),
    ['Each enclave run that decides a sale', nearAmount(f.run)],
    [
      chain === 'evm' ? 'Sending each sale (an MPC-signed EVM transfer)' : 'Sending each sale',
      nearAmount(chain === 'evm' ? f.evm_execute : f.execute),
    ],
    ['Finalizing the plan', nearAmount(f.finalize)],
    ['Revealing the sealed terms', nearAmount(f.reveal)],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-2">{k}</dt>
          <dd className="num sm:text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A top-up of a plan's budget from the owner's wallet: a plain NEAR transfer to the relayer, which
 * the API credits to this plan once it reads it on chain.
 */
export function FundForm({
  planId,
  budget,
  chain,
  launched,
  onFunded,
  cta = 'Send from your wallet',
}: {
  planId: number;
  budget: PlanBudget;
  chain: 'near' | 'evm';
  launched: boolean;
  onFunded: (balance: string) => void;
  cta?: string;
}) {
  const id = useId();
  const suggested = suggestedTopUp(budget, chain, launched);
  const [amount, setAmount] = useState(() => nearAmount(suggested).replace(' NEAR', ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const yocto = parseNear(amount);
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (!yocto) {
          setError('Enter an amount of NEAR above zero, like 0.5');
          return;
        }
        setBusy(true);
        setError(null);
        setDone(null);
        try {
          const r = await fundPlan(planId, budget.relayer, yocto);
          setDone(
            r.claimedEarlier
              ? `Your earlier transfer is now counted. The budget holds ${nearAmount(r.balance)}; send again to add more.`
              : `Added. The budget holds ${nearAmount(r.balance)}.`,
          );
          onFunded(r.balance);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="label" htmlFor={`${id}-amount`}>
        Amount
      </label>
      <div className="flex flex-wrap gap-2">
        <div className="relative max-w-[12rem] flex-1">
          <input
            id={`${id}-amount`}
            className="input pr-14"
            inputMode="decimal"
            value={amount}
            aria-invalid={error && !yocto ? true : undefined}
            onChange={(e) => setAmount(e.target.value)}
          />
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-ink-3">
            NEAR
          </span>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          {busy ? 'Waiting for the wallet…' : cta}
        </button>
      </div>
      <p className="hint mt-1">
        Suggested: {nearAmount(suggested)}, {launched ? '' : 'the launch, '}about {SUGGESTED_SALES}{' '}
        sales ({nearAmount(saleFee(budget, chain))} each) and closing the plan. Your wallet sends it
        to Glidepath’s relayer <span className="mono">{budget.relayer}</span>, which spends it only
        on this plan’s work. Top up again any time.
      </p>
      {error && (
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
      )}
      {done && (
        <p role="status" className="mt-2 rounded-lg bg-pass-soft px-3 py-2 text-sm text-pass">
          {done}
        </p>
      )}
    </form>
  );
}

/** The owner's view of a plan's budget: balance, prices and a top-up. */
export function BudgetPanel({
  planId,
  chain,
  launched,
  budget,
  onFunded,
}: {
  planId: number;
  chain: 'near' | 'evm';
  launched: boolean;
  budget: ReturnType<typeof usePlanBudget>;
  onFunded: () => void;
}) {
  const b = budget.data;
  const low = b ? BigInt(b.balance) < BigInt(b.saleReserve) : false;
  return (
    <Panel
      title="Plan budget"
      description="Glidepath’s relayer runs the enclave and sends each sale for this plan. It is paid from this budget, which you fund from your wallet."
    >
      {budget.error && !b ? (
        <ErrorNote error={budget.error} retry={budget.reload} />
      ) : !b ? (
        <p className="text-sm text-ink-3">Reading the budget…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <Facts
              items={[
                [
                  'Balance',
                  <span key="b" className={`num font-semibold ${low ? 'text-wait' : ''}`}>
                    {nearAmount(b.balance)}
                  </span>,
                ],
                [
                  'Sales run while it holds',
                  <span key="r">at least {nearAmount(b.saleReserve)}</span>,
                ],
              ]}
            />
            {low && (
              <p className="text-sm text-wait">
                {launched
                  ? 'Below that, so sales wait until you top up.'
                  : 'Fund the budget before the launch.'}
              </p>
            )}
            <FundForm
              planId={planId}
              budget={b}
              chain={chain}
              launched={launched}
              onFunded={() => onFunded()}
              cta="Top up"
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold">What the relayer charges</p>
            <FeeList budget={b} chain={chain} launched={launched} />
          </div>
        </div>
      )}
    </Panel>
  );
}

/** For a wallet-owned plan someone else is looking at: who manages it, and how to sign in as them. */
export function OwnerOnlyNote({ owner, path }: { owner: string; path: string }) {
  const me = useMe();
  if (me.loading && !me.data) return null;
  return (
    <p className="text-sm text-ink-2">
      {me.data ? (
        <>
          You are signed in as <span className="mono">{me.data.account}</span>. Only{' '}
          <span className="mono">{owner}</span> manages this plan, from its own wallet.
        </>
      ) : (
        <>
          Only <span className="mono">{owner}</span> manages this plan, from its own wallet.{' '}
          <Link className="link" href={`/sign-in?next=${encodeURIComponent(path)}`}>
            Sign in
          </Link>{' '}
          if that is you.
        </>
      )}
    </p>
  );
}

/**
 * The step after a wallet-owned plan is committed: fund its budget so the relayer can launch the
 * token and run the plan. The owner can skip it and fund later from the plan page.
 */
export function FundStep({
  planId,
  chain,
  onDone,
}: {
  planId: number;
  chain: 'near' | 'evm';
  onDone: () => void;
}) {
  const budget = usePlanBudget(planId, true);
  const b = budget.data;
  const ready = !!b && BigInt(b.balance) >= launchFee(b, chain);
  return (
    <div className="space-y-5">
      <p
        role="status"
        className="rounded-lg border border-accent/40 bg-accent-soft px-4 py-3 text-sm"
      >
        Plan #{planId} is committed on chain, owned by your account.
      </p>
      <div className="max-w-[70ch] space-y-2 text-sm text-ink-2">
        <p>
          Glidepath’s relayer does this plan’s routine work: it launches the token, runs the enclave
          that decides each sale, sends the sales, and closes the plan at the end. It is paid from
          the plan’s own budget, which your wallet funds with a plain NEAR transfer. Nothing else is
          taken, and Glidepath never holds your keys.
        </p>
      </div>
      {budget.error && !b ? (
        <ErrorNote error={budget.error} retry={budget.reload} />
      ) : !b ? (
        <p className="text-sm text-ink-3">Reading the plan’s budget…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <p className="text-sm">
              Budget now: <span className="num font-semibold">{nearAmount(b.balance)}</span>
            </p>
            <FundForm
              planId={planId}
              budget={b}
              chain={chain}
              launched={false}
              onFunded={() => void budget.reload()}
              cta="Fund the plan"
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold">What the relayer charges</p>
            <FeeList budget={b} chain={chain} />
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-rule pt-5">
        {!ready && (
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            Fund it later
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={onDone}>
          Continue to the launch
        </button>
      </div>
    </div>
  );
}
