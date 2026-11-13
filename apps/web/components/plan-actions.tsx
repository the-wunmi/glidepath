'use client';

import { canonicalJson } from '@vsp/core';
import Link from 'next/link';

import { type FormEvent, useEffect, useId, useState } from 'react';
import { api, errorMessage, refusalCode } from '@/lib/api';
import { backupPlan, loadBackup, type PlanBackup, parseBackupFile } from '@/lib/backup';
import { plainTokens, usdE6, wholeTokens } from '@/lib/builder';
import { refusalText } from '@/lib/copy';
import { evmChainName, explorer } from '@/lib/env';
import { DAY_MS, duration, fmtDateTime, tokens } from '@/lib/format';
import type { AttemptResult, Meta, PlanDetail } from '@/lib/types';
import { EnvelopeDiff } from './envelope-diff';
import { useMeta } from './meta';
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
      const code = refusalCode(e);
      setError(code ? `${errorMessage(e)}` : errorMessage(e));
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
  onDone,
}: {
  d: PlanDetail;
  meta: Meta | null;
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
              <button type="submit" className="btn btn-primary" disabled={busy}>
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
              <button type="submit" className="btn btn-primary" disabled={busy}>
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
        {error && (
          <div className="mt-3">
            <ErrorNote error={error} />
          </div>
        )}
      </form>
    </section>
  );
}

export function EnrollForm({ d, onDone }: { d: PlanDetail; onDone: () => void }) {
  const uid = useId();
  const [amount, setAmount] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run, setError } = useAction();
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
          api<{ txHash: string }>(`/api/plans/${d.plan.id}/enroll`, {
            planId: d.plan.id,
            body: { actor: d.plan.owner, amount: amount.trim() },
          }),
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
      {error && <p className="mt-1 text-xs text-fail">{error}</p>}
      {done && <Outcome tone="pass" text="Enrolled." txHash={done} />}
    </form>
  );
}

/** A change the enclave has not applied this long after it takes effect lapses (registry rule). */
export const CHANGE_LAPSE_MS = 7 * DAY_MS;

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
                api(`/api/plans/${d.plan.id}/withdraw-change`, {
                  planId: d.plan.id,
                  body: { actor: d.plan.owner },
                }),
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
                api(`/api/plans/${d.plan.id}/cancel`, {
                  planId: d.plan.id,
                  body: { actor: d.plan.owner },
                }),
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
  const [tx, setTx] = useState<string | null>(null);
  const p = d.plan;
  const ready = finalizeReady(d, chainNow);
  const finalize = async () => {
    const r = await run(() =>
      api<{ txHash: string }>(`/api/plans/${d.plan.id}/finalize`, { body: {} }),
    );
    if (r) {
      setTx(r.txHash);
      onDone();
    }
  };
  if (prominent)
    return (
      <section className="panel flex flex-wrap items-center justify-between gap-4 border-accent/50 px-5 py-4">
        <div className="max-w-[62ch]">
          <h2 className="font-semibold">Next: finalize the plan</h2>
          <p className="mt-0.5 text-sm text-ink-2">
            {p.pending_change?.kind === 'cancel'
              ? 'The cancellation is in force.'
              : 'The plan’s end date has passed.'}{' '}
            Finalizing releases whatever is left to the beneficiary and closes the plan.
          </p>
          {error && <p className="mt-2 text-xs text-fail">{error}</p>}
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={finalize}>
          {busy ? 'Finalizing…' : 'Finalize plan'}
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
      {tx && <Outcome tone="pass" text="Finalized." txHash={tx} />}
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
