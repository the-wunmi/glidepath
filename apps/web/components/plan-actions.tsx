'use client';

import { canonicalJson, newSaltHex, planCommitment, sealTo } from '@vsp/core';
import Link from 'next/link';

import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { attestationFailure, useAttestation } from '@/lib/attestation';
import { backupPlan, loadBackup, type PlanBackup, parseBackupFile, saveBackup } from '@/lib/backup';
import { plainTokens, usdE6, wholeTokens } from '@/lib/builder';
import { refusalText } from '@/lib/copy';
import { evmChainName, explorer } from '@/lib/env';
import { DAY_MS, duration, fmtDateTime, tokens } from '@/lib/format';
import { nearAmount, ownerWrite, type PlanBudget } from '@/lib/owner-write';
import type { AttemptResult, Meta, PlanDetail } from '@/lib/types';
import { EnvelopeDiff } from './envelope-diff';
import { useMeta } from './meta';
import { actionError, FeeList, FundForm, useWalletPrompt } from './owner-wallet';
import { PlanKeyNeeded } from './plan-key';
import { Badge, ErrorNote, Field, Hash, Panel } from './ui';

/** One result line under an action: what happened on-chain, with the tx hash. */
function Outcome({ text, txHash, tone }: { text: string; txHash?: string; tone: 'pass' | 'fail' }) {
  const ex = explorer(useMeta().data);
  return (
    <div
      role="status"
      className={`mt-3 rounded-lg px-3 py-2 text-sm ${tone === 'pass' ? 'bg-pass-soft text-pass' : 'bg-fail-soft text-fail'}`}
    >
      {text}
      {txHash && (
        <span className="ml-2 text-ink-2">
          tx <Hash value={txHash} label="transaction hash" href={ex.nearTx(txHash)} />
        </span>
      )}
    </div>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(actionError(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

/**
 * The launch, as one click when this browser built the plan: the builder kept the token name,
 * listing price and allocations in the plan's backup, so nothing is asked twice. Without that
 * copy (another browser), the same details are asked here.
 */
export function LaunchPanel({
  d,
  meta,
  budget,
  onDone,
}: {
  d: PlanDetail;
  meta: Meta | null;
  /** A wallet-owned plan's budget, which pays for the launch; null for the server's own plans. */
  budget: PlanBudget | null;
  onDone: () => void;
}) {
  const uid = useId();
  const symbol = d.summary.token.symbol;
  const dec = d.plan.token_decimals;
  const [name, setName] = useState(`${symbol} Token`);
  const [team, setTeam] = useState('10000000');
  const [founder, setFounder] = useState('1000000');
  const [price, setPrice] = useState('2.40');
  const [sealedTeam, setSealedTeam] = useState<string | null>(null);
  const [fromBuilder, setFromBuilder] = useState(false);
  const [editing, setEditing] = useState(false);
  const [show, setShow] = useState(false);
  const { busy, error, run } = useAction();

  // When this browser sealed the plan, launch exactly the allocation its percentages refer to.
  useEffect(() => {
    const b = loadBackup(d.plan.id, d.plan.commitment);
    const p = backupPlan(b);
    if (p) {
      const t = plainTokens(p.allocation, dec);
      setTeam(t);
      setSealedTeam(t);
    }
    if (b?.launch) {
      if (b.launch.name) setName(b.launch.name);
      if (b.launch.founder_allocation)
        setFounder(plainTokens(BigInt(b.launch.founder_allocation), dec));
      if (b.launch.listing_price_usd) setPrice(b.launch.listing_price_usd);
      setFromBuilder(!!b.launch.name && !!p);
    }
  }, [d.plan.id, d.plan.commitment, dec]);

  const errs = {
    name: name.trim().length < 2 || name.trim().length > 40 ? 'Use 2 to 40 characters' : null,
    team: !wholeTokens(team, dec) ? 'Enter an amount above zero' : null,
    founder: wholeTokens(founder, dec) === null ? 'Enter an amount (0 is fine)' : null,
    price: !usdE6(price) ? 'Enter a price like 2.40' : null,
  };
  const valid = Object.values(errs).every((e) => !e);
  const form = editing || !fromBuilder;
  const chain = d.summary.token.chain;
  const fee = budget
    ? BigInt(chain === 'evm' ? budget.fees.launch_evm : budget.fees.launch_near)
    : 0n;
  // The relayer pays for the launch from the plan's budget, so it must hold the launch fee first.
  const unfunded = !!budget && BigInt(budget.balance) < fee;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setShow(true);
    if (!valid) {
      setEditing(true);
      return;
    }
    const r = await run(() =>
      api<{ txHash: string }>(`/api/plans/${d.plan.id}/launch`, {
        planId: d.plan.id,
        body: {
          actor: d.plan.owner,
          name: name.trim(),
          team_allocation: (wholeTokens(team, dec) ?? 0n).toString(),
          founder_allocation: (wholeTokens(founder, dec) ?? 0n).toString(),
          listing_price_usd: price.trim(),
        },
      }),
    );
    if (r) onDone();
  }

  // On EVM the launchpad (the server's deployer account) receives the owner's share.
  const ownerGets =
    d.summary.token.chain === 'evm'
      ? `the app’s token deployer on ${evmChainName(meta)}`
      : d.plan.owner;
  const priced = meta?.livePriceSymbols.includes(symbol);
  return (
    <section className="panel border-accent/50 px-5 py-4" aria-labelledby={`${uid}-title`}>
      <form onSubmit={submit} noValidate>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-[62ch]">
            <h2 id={`${uid}-title`} className="font-semibold">
              Next: launch {symbol}
            </h2>
            <p className="mt-0.5 text-sm text-ink-2">
              Deploys the token with the team allocation minted straight into the plan, so it never
              passes through anyone’s key.
            </p>
          </div>
          {!form && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)}>
                Edit details
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || unfunded}>
                {busy ? 'Launching…' : `Launch ${symbol}`}
              </button>
            </div>
          )}
        </div>

        {!form ? (
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Name', name],
              ['Into the plan', `${tokens(wholeTokens(team, dec) ?? 0n, dec, 0)} ${symbol}`],
              ['To the owner', `${tokens(wholeTokens(founder, dec) ?? 0n, dec, 0)} ${symbol}`],
              ['Listing price', `$${price}`],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-ink-3">{k}</dt>
                <dd className="num truncate font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {!fromBuilder && (
              <p className="text-sm text-ink-2 sm:col-span-2">
                This browser has no copy of the plan’s launch details, so enter them here.
              </p>
            )}
            <Field label="Token name" htmlFor={`${uid}-n`} error={show ? errs.name : null}>
              <input
                id={`${uid}-n`}
                className="input"
                value={name}
                placeholder="Acme Network"
                onChange={(e) => setName(e.target.value)}
                aria-invalid={show && !!errs.name}
              />
            </Field>
            <Field
              label="Listing price (USD)"
              htmlFor={`${uid}-p`}
              error={show ? errs.price : null}
              hint={
                priced
                  ? `${symbol} has a real market, so this does not set its price.`
                  : 'A new token has no market yet; this sets its simulated price.'
              }
            >
              <input
                id={`${uid}-p`}
                className="input"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                aria-invalid={show && !!errs.price}
              />
            </Field>
            <Field
              label={`Team allocation into the plan (${symbol})`}
              htmlFor={`${uid}-t`}
              error={show ? errs.team : null}
              hint={
                sealedTeam === null
                  ? 'Enter the allocation you sealed, or its percentages will mean something else.'
                  : team.trim() === sealedTeam
                    ? 'The allocation in your sealed plan. Its percentages refer to this amount.'
                    : `Your sealed plan’s percentages refer to ${sealedTeam} ${symbol}. A different amount changes what they mean.`
              }
            >
              <input
                id={`${uid}-t`}
                className="input"
                inputMode="decimal"
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                aria-invalid={show && !!errs.team}
              />
            </Field>
            <Field
              label={`Owner’s own allocation (${symbol})`}
              htmlFor={`${uid}-f`}
              error={show ? errs.founder : null}
              hint={`Minted to ${ownerGets}, outside the plan.`}
            >
              <input
                id={`${uid}-f`}
                className="input"
                inputMode="decimal"
                value={founder}
                onChange={(e) => setFounder(e.target.value)}
                aria-invalid={show && !!errs.founder}
              />
            </Field>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <button type="submit" className="btn btn-primary" disabled={busy || unfunded}>
                {busy ? 'Launching…' : `Launch ${symbol}`}
              </button>
              {fromBuilder && (
                <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                  Done editing
                </button>
              )}
            </div>
          </div>
        )}
        {budget && (
          <p className="mt-3 text-sm text-ink-2">
            Glidepath’s relayer sends the launch and pays {nearAmount(fee)} for it from the plan’s
            budget, which holds {nearAmount(budget.balance)}.
          </p>
        )}
        {error && (
          <div className="mt-3">
            <ErrorNote error={error} />
          </div>
        )}
      </form>
      {budget && unfunded && (
        <div className="mt-4 border-t border-rule-2 pt-4">
          <h3 className="font-semibold">First: fund the plan</h3>
          <p className="mt-0.5 max-w-[68ch] text-sm text-ink-2">
            The relayer’s work for this plan (the launch, each enclave run and sale, closing it) is
            paid from the plan’s budget. Your wallet funds it with a plain NEAR transfer; Glidepath
            never holds your keys.
          </p>
          <div className="mt-3 grid gap-6 lg:grid-cols-2">
            <FundForm
              planId={d.plan.id}
              budget={budget}
              chain={chain}
              launched={false}
              onFunded={onDone}
              cta="Fund the plan"
            />
            <FeeList budget={budget} chain={chain} />
          </div>
        </div>
      )}
    </section>
  );
}

export function EnrollForm({ d, onDone }: { d: PlanDetail; onDone: () => void }) {
  const uid = useId();
  const [amount, setAmount] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run, setError } = useAction();
  const wallet = useWalletPrompt();
  const symbol = d.summary.token.symbol;
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setDone(null);
        if (!/^\d+(\.\d+)?$/.test(amount.trim()) || Number(amount) === 0) {
          setError('Enter an amount above zero');
          return;
        }
        const r = await run(() =>
          ownerWrite<{ txHash: string }>(
            `/api/plans/${d.plan.id}/enroll`,
            { actor: d.plan.owner, amount: amount.trim() },
            { planId: d.plan.id, confirm: wallet.confirm },
          ),
        );
        if (r) {
          setDone(r.txHash);
          setAmount('');
          onDone();
        }
      }}
    >
      <label className="label" htmlFor={`${uid}-a`}>
        Enroll more {symbol} from {d.plan.owner}
      </label>
      <div className="flex gap-2">
        <input
          id={`${uid}-a`}
          className="input"
          inputMode="decimal"
          placeholder="100000"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <button type="submit" className="btn btn-secondary" disabled={busy}>
          {busy ? 'Enrolling…' : 'Enroll'}
        </button>
      </div>
      <p className="hint mt-1">
        Moves tokens into the plan account. Once there, they follow the plan like the rest.
      </p>
      {wallet.prompt}
      {error && <p className="mt-1 text-xs text-fail">{error}</p>}
      {done && <Outcome tone="pass" text="Enrolled." txHash={done} />}
    </form>
  );
}

/** A change the enclave has not applied this long after it takes effect lapses (registry rule). */
export const CHANGE_LAPSE_MS = 7 * DAY_MS;

/**
 * Moves a plan from the enclave build that accepted it to the current one: the same sealed terms
 * from this browser's backup, under a new salt, sealed to the current build as a plan change. It
 * cools off like any change; the current build then acks it and runs the plan.
 */
export function MoveEnclavePanel({
  d,
  meta,
  canManage,
  onDone,
  onWriteTerms,
}: {
  d: PlanDetail;
  meta: Meta;
  canManage: boolean;
  onDone: () => void;
  /** Opens the change form, for an owner whose browser has no copy of the terms. */
  onWriteTerms: () => void;
}) {
  const uid = useId();
  const p = d.plan;
  const [backup, setBackup] = useState<PlanBackup | null | undefined>(undefined);
  const { result: attestation, error: attestationError } = useAttestation(meta);
  const { busy, error, run } = useAction();
  const wallet = useWalletPrompt();
  useEffect(() => setBackup(loadBackup(p.id, p.commitment)), [p.id, p.commitment]);
  const plan = backupPlan(backup ?? null);
  const moveBody = useRef<Record<string, unknown> | null>(null);
  const attestationNote = attestationError
    ? 'The current enclave’s attestation could not be checked, so nothing is sealed to it yet.'
    : attestation && !attestation.ok
      ? attestationFailure(attestation.checks)
      : null;

  async function move() {
    if (!plan || !attestation?.ok) return;
    // One sealed request per move, so a retry after the wallet signed sends the same body again.
    if (!moveBody.current) {
      const salt = newSaltHex();
      const terms = JSON.parse(canonicalJson(plan));
      const commitment = planCommitment(plan, salt);
      // Kept first: the owner's copy of the new commitment must outlive a lost response.
      saveBackup(p.id, {
        kind: 'verified-sales-plan-backup',
        commitment,
        salt,
        plan: terms,
        envelope: p.envelope,
        created_at: new Date().toISOString(),
      });
      moveBody.current = {
        actor: p.owner,
        commitment,
        envelope: p.envelope,
        sealed_box: sealTo(meta.enclave.encryptionKeyHex, JSON.stringify({ plan: terms, salt })),
      };
    }
    const body = moveBody.current;
    const r = await run(() =>
      ownerWrite(`/api/plans/${p.id}/change`, body, { planId: p.id, confirm: wallet.confirm }),
    );
    if (r) {
      moveBody.current = null;
      onDone();
    }
  }

  return (
    <section className="panel border-accent/50 px-5 py-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-[68ch]">
          <h2 id={`${uid}-title`} className="font-semibold">
            This plan runs on an earlier enclave build
          </h2>
          <p className="mt-0.5 text-sm text-ink-2">
            The build that accepted it still sells under the sealed terms. Moving re-seals the same
            terms to the current build as a plan change: public at once, applied after the
            cooling-off, then sold by the current build.
          </p>
        </div>
        {canManage && plan && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !attestation?.ok}
            onClick={() => void move()}
          >
            {busy ? 'Sealing…' : 'Move to the current enclave'}
          </button>
        )}
      </div>
      {!canManage ? (
        <div className="mt-3">
          <PlanKeyNeeded planId={p.id} />
        </div>
      ) : backup === null || (backup !== undefined && !plan) ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-ink-2">
            This browser has no copy of the plan’s terms to re-seal. Writing the same terms again as
            a plan change moves it too.
          </p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onWriteTerms}>
            Write the terms again
          </button>
        </div>
      ) : (
        attestationNote && <p className="mt-2 text-sm text-fail">{attestationNote}</p>
      )}
      {wallet.prompt}
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
    </section>
  );
}

/**
 * Where a pending change or cancellation stands. Once the cooling-off is over, a change still needs
 * the enclave to apply it; until then the current plan keeps running.
 */
export function pendingPhase(
  p: NonNullable<PlanDetail['plan']['pending_change']>,
  chainNow: number | null,
): 'cooling' | 'awaiting_enclave' | 'cancel_in_force' {
  if (chainNow === null || chainNow < p.effective_at_ms) return 'cooling';
  return p.kind === 'cancel' ? 'cancel_in_force' : 'awaiting_enclave';
}

export function PendingChangePanel({
  d,
  chainNow,
  enclaveUp,
  canManage,
  onDone,
}: {
  d: PlanDetail;
  chainNow: number | null;
  enclaveUp: boolean;
  /** This browser holds the plan key (or the operator token), so it may withdraw. */
  canManage: boolean;
  onDone: () => void;
}) {
  const p = d.plan.pending_change;
  const { busy, error, run } = useAction();
  const wallet = useWalletPrompt();
  if (!p) return null;
  const phase = pendingPhase(p, chainNow);
  const left = chainNow ? p.effective_at_ms - chainNow : null;
  const total = p.effective_at_ms - p.requested_at_ms;
  const pct = left === null ? 0 : Math.min(100, Math.max(0, ((total - left) / total) * 100));
  const title =
    phase === 'cooling'
      ? p.kind === 'cancel'
        ? 'Cancellation is cooling off'
        : 'Plan change is cooling off'
      : phase === 'cancel_in_force'
        ? 'Cancellation is in force'
        : enclaveUp
          ? 'Cooling-off over: waiting for the enclave to apply the new plan'
          : 'Cooling-off over, but the enclave is unavailable';
  return (
    <section
      className="panel border-wait/40 bg-wait-soft/40 px-5 py-4"
      aria-labelledby="pending-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-[70ch]">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="pending-title" className="font-semibold">
              {title}
            </h2>
            <Badge tone="wait" dot>
              Public
            </Badge>
          </div>
          <p className="mt-1 text-sm text-ink-2">
            {phase === 'cooling'
              ? p.kind === 'cancel'
                ? 'Anyone can see the cancellation now. The plan keeps selling until it takes effect; then the plan can be finalized and the remaining tokens go to the beneficiary.'
                : 'Anyone can see the new commitment and public bounds now. The current plan keeps running until the change takes effect.'
              : phase === 'cancel_in_force'
                ? 'The cooling-off is over. Finalize the plan to release the remaining tokens to the beneficiary.'
                : `The current plan keeps running until the enclave applies the new one. If it is not applied by ${fmtDateTime(p.effective_at_ms + CHANGE_LAPSE_MS)} (chain time), the change lapses and the current plan stays.${enclaveUp ? '' : ' Sales are paused while the enclave is down.'}`}
          </p>
        </div>
        {phase === 'cooling' && (
          <div className="text-right">
            <p className="num text-2xl font-semibold">{left === null ? '…' : duration(left)}</p>
            <p className="text-xs text-ink-3">
              left, takes effect {fmtDateTime(p.effective_at_ms)} (chain time)
            </p>
          </div>
        )}
      </div>
      {phase === 'cooling' && (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-rule-2"
          role="progressbar"
          aria-label="Cooling-off elapsed"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full bg-wait" style={{ width: `${pct}%` }} />
        </div>
      )}
      {p.commitment && (
        <p className="mt-3 text-sm">
          New commitment <Hash value={p.commitment} label="new commitment" head={12} />
        </p>
      )}
      {p.envelope && (
        <EnvelopeDiff
          current={d.plan.envelope}
          pending={p.envelope}
          symbol={d.summary.token.symbol}
          decimals={d.plan.token_decimals}
        />
      )}
      {phase !== 'cancel_in_force' && canManage && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={async () => {
              const r = await run(() =>
                ownerWrite(
                  `/api/plans/${d.plan.id}/withdraw-change`,
                  { actor: d.plan.owner },
                  { planId: d.plan.id, confirm: wallet.confirm },
                ),
              );
              if (r) onDone();
            }}
          >
            {busy ? 'Withdrawing…' : `Withdraw ${p.kind === 'cancel' ? 'cancellation' : 'change'}`}
          </button>
          <span className="text-xs text-ink-3">
            Withdrawing keeps the current plan. It does not speed anything up.
          </span>
        </div>
      )}
      {wallet.prompt}
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
    </section>
  );
}

export function CancelControl({ d, onDone }: { d: PlanDetail; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const wallet = useWalletPrompt();
  const disabled = d.plan.status !== 'active' || !!d.plan.pending_change;
  return (
    <div>
      <p className="text-sm font-semibold">Cancel the plan</p>
      <p className="mt-0.5 text-sm text-ink-2">
        Starts the public cooling-off. Sales continue until it ends; there is no instant exit.
      </p>
      {!confirming ? (
        <button
          type="button"
          className="btn btn-danger mt-2"
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          Cancel plan
        </button>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={async () => {
              const r = await run(() =>
                ownerWrite(
                  `/api/plans/${d.plan.id}/cancel`,
                  { actor: d.plan.owner },
                  { planId: d.plan.id, confirm: wallet.confirm },
                ),
              );
              if (r) {
                setConfirming(false);
                onDone();
              }
            }}
          >
            {busy ? 'Requesting…' : 'Yes, start the cooling-off'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
            Keep the plan
          </button>
        </div>
      )}
      {wallet.prompt}
      {d.plan.status === 'ended' && <p className="hint mt-1">The plan has ended.</p>}
      {error && <p className="mt-2 text-xs text-fail">{error}</p>}
    </div>
  );
}

/** Finalizing is allowed once the plan's end has passed or a cancellation is in force. */
export function finalizeReady(d: PlanDetail, chainNow: number | null): boolean {
  const p = d.plan;
  if (p.status !== 'active' || chainNow === null) return false;
  return (
    chainNow >= p.end_ms ||
    (p.pending_change?.kind === 'cancel' && chainNow >= p.pending_change.effective_at_ms)
  );
}

/** An ended plan whose account or address still holds tokens; for an ERC-20, its release has not been mined yet. */
export function releaseOwed(d: PlanDetail): boolean {
  return d.plan.status === 'ended' && !!d.balance && BigInt(d.balance) > 0n;
}

/** The latest receipt is a release, so the transfer is being signed or sent right now. */
export function releaseInFlight(d: PlanDetail): boolean {
  const latest = d.receipts.reduce<PlanDetail['receipts'][number] | null>(
    (a, r) => (!a || r.seq > a.seq ? r : a),
    null,
  );
  return releaseOwed(d) && latest?.kind === 'release' && latest.status !== 'failed';
}

export function FinalizeControl({
  d,
  chainNow,
  onDone,
  prominent = false,
}: {
  d: PlanDetail;
  chainNow: number | null;
  onDone: () => void;
  /** The page's primary action: a panel with the main button. */
  prominent?: boolean;
}) {
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<{ txHash: string | null } | null>(null);
  const p = d.plan;
  const ready = finalizeReady(d, chainNow);
  const owed = releaseOwed(d);
  const finalize = async () => {
    const r = await run(() =>
      api<{ txHash: string | null }>(`/api/plans/${d.plan.id}/finalize`, { body: {} }),
    );
    if (r) {
      setDone(r);
      onDone();
    }
  };
  if (prominent && owed && releaseInFlight(d))
    return (
      <section className="panel px-5 py-4" role="status">
        <h2 className="font-semibold">Releasing the remaining tokens</h2>
        <p className="mt-0.5 max-w-[62ch] text-sm text-ink-2">
          The registry asked the MPC network to sign one transfer of what is left to the
          beneficiary’s address. It is sent as soon as it is signed.
        </p>
      </section>
    );
  if (prominent)
    return (
      <section className="panel flex flex-wrap items-center justify-between gap-4 border-accent/50 px-5 py-4">
        <div className="max-w-[62ch]">
          <h2 className="font-semibold">
            {owed ? 'Next: release the remaining tokens' : 'Next: finalize the plan'}
          </h2>
          <p className="mt-0.5 text-sm text-ink-2">
            {owed
              ? 'The plan has ended, and its address still holds tokens. Releasing has the registry sign one transfer of them to the beneficiary. Anyone may do this.'
              : `${p.pending_change?.kind === 'cancel' ? 'The cancellation is in force.' : 'The plan’s end date has passed.'} Finalizing releases whatever is left to the beneficiary and closes the plan.`}
          </p>
          {error && <p className="mt-2 text-xs text-fail">{error}</p>}
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={finalize}>
          {busy
            ? owed
              ? 'Releasing…'
              : 'Finalizing…'
            : owed
              ? 'Release to the beneficiary'
              : 'Finalize plan'}
        </button>
      </section>
    );
  const why =
    p.status === 'ended'
      ? 'The plan has ended.'
      : p.pending_change?.kind === 'cancel'
        ? `Available when the cancellation takes effect (${fmtDateTime(p.pending_change.effective_at_ms)}).`
        : `Available when the plan ends (${fmtDateTime(p.end_ms)}) or a cancellation takes effect.`;
  return (
    <div>
      <p className="text-sm font-semibold">Finalize</p>
      <p className="mt-0.5 text-sm text-ink-2">
        Releases whatever is left to the beneficiary and closes the plan. Anyone may do this once it
        is allowed.
      </p>
      <button
        type="button"
        className="btn btn-secondary mt-2"
        disabled={!ready || busy}
        onClick={finalize}
      >
        {busy ? 'Finalizing…' : 'Finalize plan'}
      </button>
      {!ready && <p className="hint mt-1">{why}</p>}
      {error && <p className="mt-2 text-xs text-fail">{error}</p>}
      {done && <Outcome tone="pass" text="Finalized." txHash={done.txHash ?? undefined} />}
    </div>
  );
}

/**
 * Publishes a finished plan's sealed terms from the owner's backup (this browser's copy or the
 * downloaded file). The registry accepts them only if they hash, with the salt, to the commitment.
 */
export function RevealControl({ d, onDone }: { d: PlanDetail; onDone: () => void }) {
  const { busy, error, run, setError } = useAction();
  const [tx, setTx] = useState<string | null>(null);
  const p = d.plan;
  if (p.status !== 'ended') return null;
  if (d.reveal)
    return (
      <div>
        <p className="text-sm font-semibold">Sealed terms revealed</p>
        <p className="mt-0.5 text-sm text-ink-2">
          Published {fmtDateTime(d.reveal.revealed_at_ms)} and checked on-chain against the
          commitment. Holders can re-check every sale against them on the{' '}
          <Link className="link" href={`/verify/${p.id}`}>
            public page
          </Link>
          .
        </p>
        {tx && <Outcome tone="pass" text="Terms published and checked on-chain." txHash={tx} />}
      </div>
    );
  const submit = async (b: PlanBackup | null) => {
    const plan = backupPlan(b);
    if (!b || !plan || b.commitment !== p.commitment) {
      setError('That backup is not the sealed plan this commitment was made for.');
      return;
    }
    const r = await run(() =>
      api<{ txHash: string }>(`/api/plans/${p.id}/reveal`, {
        body: { plan_json: canonicalJson(plan), salt: b.salt },
      }),
    );
    if (r) {
      setTx(r.txHash);
      onDone();
    }
  };
  const local = loadBackup(p.id, p.commitment);
  return (
    <div>
      <p className="text-sm font-semibold">Reveal the sealed terms</p>
      <p className="mt-0.5 text-sm text-ink-2">
        {p.disclosure.type === 'end_reveal'
          ? 'This plan chose to reveal at the end; the enclave publishes the terms itself. You can also publish them from your backup now.'
          : 'Optional. Publishing the terms lets holders check every sale against them. Anyone can verify they match the commitment.'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {local && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void submit(local)}
          >
            {busy ? 'Publishing…' : 'Publish from this browser’s backup'}
          </button>
        )}
        <label className="btn btn-ghost cursor-pointer">
          Load backup file
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={async (ev) => {
              const file = ev.target.files?.[0];
              if (file) await submit(parseBackupFile(await file.text()));
            }}
          />
        </label>
      </div>
      {error && <p className="mt-2 text-xs text-fail">{error}</p>}
      {tx && <Outcome tone="pass" text="Terms published and checked on-chain." txHash={tx} />}
    </div>
  );
}

const ATTEMPTS = [
  {
    path: 'direct-transfer',
    title: 'Move tokens out directly',
    text: 'The founder’s key calls the plan account’s send method to take 1 base unit.',
    nearOnly: true,
  },
  {
    path: 'add-key',
    title: 'Add a key to the plan account',
    text: 'The founder signs a transaction as the plan account to add their own full-access key.',
    nearOnly: false,
  },
] as const;

/** Lets the founder try to cheat and shows the chain refusing. */
export function BypassPanel({
  d,
  daoOwned,
  onDone,
}: {
  d: PlanDetail;
  /** A DAO-owned plan: the attempt is still the founder's key, acting outside the DAO. */
  daoOwned: boolean;
  onDone: () => void;
}) {
  const [results, setResults] = useState<Record<string, AttemptResult | string>>({});
  const ex = explorer(useMeta().data);
  const [busy, setBusy] = useState<string | null>(null);
  const near = d.summary.token.chain === 'near';
  const who = daoOwned
    ? 'the founder’s own key (a council member acting alone, not the DAO)'
    : 'the founder’s own key';
  return (
    <Panel
      title="Try to bypass the plan"
      description={
        near
          ? `Both attempts use ${who}. The chain should refuse them.`
          : `The attempt uses ${who}. The chain should refuse it. Taking tokens directly does not apply to an EVM plan: see below.`
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        {ATTEMPTS.filter((a) => near || !a.nearOnly).map((a) => {
          const r = results[a.path];
          return (
            <div key={a.path} className="well p-4">
              <p className="text-sm font-semibold">{a.title}</p>
              <p className="mt-0.5 text-sm text-ink-2">{a.text}</p>
              <button
                type="button"
                className="btn btn-danger btn-sm mt-3"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(a.path);
                  try {
                    const out = await api<AttemptResult>(
                      `/api/plans/${d.plan.id}/attempts/${a.path}`,
                      { planId: d.plan.id, body: { actor: d.plan.owner } },
                    );
                    setResults((x) => ({ ...x, [a.path]: out }));
                    onDone();
                  } catch (e) {
                    setResults((x) => ({ ...x, [a.path]: errorMessage(e) }));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === a.path ? 'Trying…' : 'Try it'}
              </button>
              {typeof r === 'string' && (
                <p className="mt-2 text-xs text-fail" role="alert">
                  {r}
                </p>
              )}
              {r && typeof r !== 'string' && (
                <div
                  role="status"
                  className={`mt-3 rounded-md px-3 py-2 text-sm ${r.refused ? 'bg-pass-soft' : 'bg-fail-soft'}`}
                >
                  <p className={`font-semibold ${r.refused ? 'text-pass' : 'text-fail'}`}>
                    {r.refused ? 'Refused by the chain' : 'Accepted. This should never happen.'}
                  </p>
                  {r.refused && <p className="mt-1 text-ink">{refusalText(r.code)}</p>}
                  <p className="mt-1 text-ink-2">
                    Code <span className="mono text-ink">{r.code}</span>
                  </p>
                  {r.txHash ? (
                    <p className="mt-0.5 text-ink-2">
                      Transaction{' '}
                      <Hash value={r.txHash} label="transaction hash" href={ex.nearTx(r.txHash)} />
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-ink-3">
                      No transaction exists: the account has no key that could sign one.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!near && d.plan.evm_address && (
          <div className="well p-4">
            <p className="text-sm font-semibold">Why the EVM tokens cannot be taken</p>
            <p className="mt-1 text-sm text-ink-2">
              <Hash value={d.plan.evm_address} label="plan EVM address" head={10} tail={8} /> holds{' '}
              <span className="num font-medium text-ink">
                {tokens(d.balance, d.plan.token_decimals)} {d.summary.token.symbol}
              </span>
              . No private key for it exists anywhere. It is derived from the registry account and
              the path <span className="mono">plan/{d.plan.id}</span>, and the MPC network signs for
              it only when the registry itself asks. A signature requested by anyone else, including
              the founder, derives a different key and cannot move these tokens.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Whether the newest timeline entry of `kind` is newer than every entry of `clearedBy`. */
function stillNeeded(d: PlanDetail, kind: string, clearedBy: string[]): boolean {
  // The timeline is newest first.
  const at = d.activity.findIndex((a) => a.kind === kind);
  if (at === -1) return false;
  const cleared = d.activity.findIndex((a) => clearedBy.includes(a.kind));
  return cleared === -1 || at < cleared;
}

/** An ended ERC-20 plan of the owner's wallet, waiting for the owner to ask for the release. */
export const releaseNeeded = (d: PlanDetail): boolean =>
  releaseOwed(d) && !releaseInFlight(d) && d.activity.some((a) => a.kind === 'release_needed');

/** A sale's EVM transfer is stuck below the network's fees and only the owner's wallet may re-sign it. */
export const resignNeeded = (d: PlanDetail): boolean =>
  stillNeeded(d, 'evm_resign_needed', ['evm_resigned']) &&
  d.executions.some((x) => x.status === 'broadcast' || x.status === 'signed');

/** A plan action the owner's wallet must sign, as a banner above the plan's tabs. */
function OwnerCallBanner({
  title,
  children,
  button,
  busyText,
  path,
  d,
  onDone,
}: {
  title: string;
  children: ReactNode;
  button: string;
  busyText: string;
  path: string;
  d: PlanDetail;
  onDone: () => void;
}) {
  const { busy, error, run } = useAction();
  const wallet = useWalletPrompt();
  return (
    <section className="panel border-accent/50 px-5 py-4" aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-[62ch]">
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-0.5 text-sm text-ink-2">{children}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            const r = await run(() =>
              ownerWrite(path, {}, { planId: d.plan.id, confirm: wallet.confirm }),
            );
            if (r) onDone();
          }}
        >
          {busy ? busyText : button}
        </button>
      </div>
      {wallet.prompt}
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
    </section>
  );
}

export function ReleaseNeededPanel({ d, onDone }: { d: PlanDetail; onDone: () => void }) {
  return (
    <OwnerCallBanner
      d={d}
      onDone={onDone}
      path={`/api/plans/${d.plan.id}/release`}
      title="Action needed: release the remaining tokens"
      button="Release to the beneficiary"
      busyText="Releasing…"
    >
      The plan has ended and its address still holds {tokens(d.balance, d.plan.token_decimals)}{' '}
      {d.summary.token.symbol}. Your wallet asks the registry to sign one transfer of all of it to
      the beneficiary; Glidepath then sends it and watches it like a sale.
    </OwnerCallBanner>
  );
}

export function ResignNeededPanel({ d, onDone }: { d: PlanDetail; onDone: () => void }) {
  return (
    <OwnerCallBanner
      d={d}
      onDone={onDone}
      path={`/api/plans/${d.plan.id}/resign`}
      title="Action needed: re-sign with higher fees"
      button="Re-sign with higher fees"
      busyText="Re-signing…"
    >
      A sale’s transfer is waiting below the network’s current fees. Your wallet asks the registry
      to sign the same transfer again with fees at least 12.5% higher; nothing else about it
      changes.
    </OwnerCallBanner>
  );
}

/** Sales wait while a wallet-owned plan's budget is below the cost of one sale. */
export function BudgetLowBanner({
  d,
  budget,
  onFunded,
}: {
  d: PlanDetail;
  budget: PlanBudget;
  onFunded: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      className="rounded-lg border border-wait/40 bg-wait-soft px-4 py-3 text-sm"
      aria-label="Plan budget is low"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-wait">
          Sales are paused: the plan’s budget holds {nearAmount(budget.balance)}, less than the{' '}
          {nearAmount(budget.saleReserve)} sales need to run. They resume once you top it up from
          your wallet.
        </p>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Close' : 'Top up'}
        </button>
      </div>
      {open && (
        <div className="mt-3 rounded-lg bg-surface px-4 py-3">
          <FundForm
            planId={d.plan.id}
            budget={budget}
            chain={d.summary.token.chain}
            launched
            onFunded={onFunded}
            cta="Top up"
          />
        </div>
      )}
    </section>
  );
}
