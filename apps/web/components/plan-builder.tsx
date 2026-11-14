'use client';

import {
  canonicalJson,
  checkWithinEnvelope,
  describePlan,
  envelopeJson,
  newSaltHex,
  PRICE_SOURCES,
  type PriceSourceName,
  planCommitment,
  planProblems,
  sealTo,
} from '@glidepath/core';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import {
  attestationFailure,
  checkState,
  isOutlayerQuote,
  passedSummary,
  useAttestation,
  useBackupAttestations,
} from '@/lib/attestation';
import {
  backupPlan,
  type PlanBackup,
  parseBackupFile,
  parsePlanKey,
  saveBackup,
  savePlanKey,
} from '@/lib/backup';
import {
  buildEnvelope,
  buildPlan,
  coolingMs,
  DECIMALS,
  disclosureErrors,
  type Errors,
  envelopeErrors,
  formFromPlan,
  msToLocal,
  newEnvelopeSeed,
  type PlanForm,
  planWarnings,
  suggestEnvelope,
  type TokenRef,
  termsErrors,
  tokenAddressFor,
  tokenErrors,
  wholeTokens,
} from '@/lib/builder';
import { nearAccountExists, useChainNow } from '@/lib/chain';
import { envelopeLines, plainLines } from '@/lib/copy';
import { evmChainName, simReason } from '@/lib/env';
import { DAY_MS, duration, fmtDateTime, periodWords, tokens } from '@/lib/format';
import { ownerWrite, type PlanBudget } from '@/lib/owner-write';
import type { Meta } from '@/lib/types';
import { useResource } from '@/lib/use-resource';
import { OUTLAYER_LABEL, OutlayerEvidence } from './enclave-evidence';
import { DownloadIcon, LockIcon } from './icons';
import { actionError, FeeList, FundStep, useWalletPrompt } from './owner-wallet';
import { Badge, CheckList, ErrorNote, Field, Hash, Panel, SimBadge } from './ui';

type StepId = 'token' | 'terms' | 'envelope' | 'disclosure' | 'review';

const STEP_TITLES: Record<StepId, string> = {
  token: 'Token',
  terms: 'Sealed terms',
  envelope: 'Public envelope',
  disclosure: 'Disclosure',
  review: 'Review and seal',
};

const SOURCE_NAMES: Record<PriceSourceName, string> = {
  '1click_quote': '1Click quote',
  binance: 'Binance',
  coinbase: 'Coinbase',
};

export interface ChangeContext {
  planId: number;
  token: TokenRef;
  beneficiaryNear: string;
  beneficiaryEvm: string | null;
  startMs: number;
  endMs: number;
  periodMs: number;
  envelope: { perPeriod: string; perSale: string; minPrice: string; minGapMinutes: string };
  allocation: string | null;
  /** The current sealed plan from this browser's backup, so a change starts from its terms. */
  current: ReturnType<typeof backupPlan>;
}

/** A new plan runs a year by default. */
const defaultEnd = (start: number) => start + 365 * DAY_MS;

/** False when this server takes only EVM-token plans. */
const nearTokensOffered = (meta: Meta) => meta.limits.nearTokens;

/**
 * An unfinished new plan survives a reload in this tab, and signing in on the way; it holds no salt
 * and no key. It notes whose it was, so a default beneficiary follows the account.
 */
const DRAFT_KEY = 'glidepath-builder-draft';

interface Draft {
  actor: string;
  form: PlanForm;
}

function defaults(
  meta: Meta,
  actor: string,
  chainNow: number | null,
  change?: ChangeContext,
): PlanForm {
  if (!change) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null;
      if (saved?.form) {
        const form = { ...saved.form, envSeed: newEnvelopeSeed() };
        // The beneficiary was the account then; the account now takes its place.
        if (
          saved.actor !== actor &&
          (!form.beneficiaryNear || form.beneficiaryNear === saved.actor)
        )
          form.beneficiaryNear = actor;
        return form;
      }
    } catch {
      // A broken draft just means starting over.
    }
  }
  const start =
    change?.startMs ?? Math.ceil(((chainNow ?? Date.now()) + 3 * 60_000) / 60_000) * 60_000;
  const f: PlanForm = {
    chain: change?.token.chain ?? (nearTokensOffered(meta) ? 'near' : 'evm'),
    symbol: change?.token.symbol ?? '',
    name: '',
    label: '',
    allocation: change?.allocation ?? '10000000',
    founderAllocation: '1000000',
    listingPrice: '2.40',
    periodPct: '2',
    periodDays: change ? String(Math.round(change.periodMs / DAY_MS)) : '30',
    perSalePct: '0.25',
    floorUsd: '1.50',
    slippagePct: '1',
    gapMinMinutes: '1',
    gapMaxMinutes: '3',
    sources: ['1click_quote', 'binance', 'coinbase'],
    agreementPct: '1.5',
    start: msToLocal(start),
    end: msToLocal(change?.endMs ?? defaultEnd(start)),
    beneficiaryNear: change?.beneficiaryNear ?? actor,
    beneficiaryEvm: change?.beneficiaryEvm ?? '',
    envPerPeriod: '',
    envPerSale: '',
    envMinPrice: '',
    envMinGapMinutes: '',
    envTouched: !!change,
    envSeed: newEnvelopeSeed(),
    disclosure: 'delayed',
    delayDays: '7',
    coolingValue: '30',
    coolingUnit: 'days',
  };
  if (change) {
    f.envPerPeriod = change.envelope.perPeriod;
    f.envPerSale = change.envelope.perSale;
    f.envMinPrice = change.envelope.minPrice;
    f.envMinGapMinutes = change.envelope.minGapMinutes;
    return change.current ? { ...f, ...formFromPlan(change.current) } : f;
  }
  return { ...f, ...suggestEnvelope(f) };
}

function TextInput({
  id,
  value,
  onChange,
  error,
  hint,
  label,
  suffix,
  prefix,
  inputMode,
  type = 'text',
  disabled,
  placeholder,
  autoFocus,
  min,
  max,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: ReactNode;
  label: ReactNode;
  suffix?: string;
  prefix?: string;
  inputMode?: 'decimal' | 'numeric' | 'text';
  type?: string;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  min?: string;
  max?: string;
}) {
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-3">
            {prefix}
          </span>
        )}
        <input
          id={id}
          type={type}
          className={`input ${prefix ? 'pl-7' : ''} ${suffix ? 'pr-16' : ''}`}
          value={value}
          inputMode={inputMode}
          disabled={disabled}
          placeholder={placeholder}
          min={min}
          max={max}
          // biome-ignore lint/a11y/noAutofocus: the first field of a step the user just opened.
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && (
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-ink-3">
            {suffix}
          </span>
        )}
      </div>
    </Field>
  );
}

function Steps({
  steps,
  current,
  reached,
  onPick,
}: {
  steps: StepId[];
  current: number;
  reached: number;
  onPick: (i: number) => void;
}) {
  return (
    <nav aria-label="Plan builder steps" className="mb-6">
      <ol className="flex flex-wrap gap-x-1 gap-y-2">
        {steps.map((s, i) => {
          const state = i === current ? 'current' : i < current || i <= reached ? 'done' : 'todo';
          return (
            <li key={s} className="flex items-center">
              <button
                type="button"
                disabled={i > reached}
                aria-current={i === current ? 'step' : undefined}
                onClick={() => onPick(i)}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ${
                  state === 'current'
                    ? 'bg-accent-soft font-semibold text-accent-text'
                    : state === 'done'
                      ? 'text-ink hover:bg-surface-2'
                      : 'text-ink-3'
                }`}
              >
                <span
                  className={`num inline-flex size-5 items-center justify-center rounded-full text-xs ${
                    state === 'current'
                      ? 'bg-accent text-accent-ink'
                      : state === 'done'
                        ? 'bg-ink-2 text-surface'
                        : 'border border-rule'
                  }`}
                >
                  {i + 1}
                </span>
                {STEP_TITLES[s]}
              </button>
              {i < steps.length - 1 && (
                <span aria-hidden="true" className="mx-1 h-px w-4 bg-rule" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface BuilderResult {
  planId?: number;
  effectiveAtMs?: number | null;
}

export function PlanBuilder({
  meta,
  actor,
  walletOwner = false,
  change,
  onDone,
}: {
  meta: Meta;
  /**
   * The plan owner: the signed-in account, whose wallet signs; or, for the operator, the server's
   * founder account or its treasury DAO acting through a proposal.
   */
  actor: string;
  /** The owner's own wallet signs and pays; its relayer work is paid from the plan's budget. */
  walletOwner?: boolean;
  change?: ChangeContext;
  onDone: (r: BuilderResult) => void;
}) {
  const uid = useId();
  const chainNow = useChainNow();
  const steps: StepId[] = change
    ? ['terms', 'envelope', 'review']
    : ['token', 'terms', 'envelope', 'disclosure', 'review'];
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [form, setForm] = useState<PlanForm>(() => defaults(meta, actor, chainNow, change));
  /** The relayer's prices, shown before the founder signs anything. */
  const fees = useResource(() => api<Omit<PlanBudget, 'balance'>>('/api/fees'), []);
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [evmNext, setEvmNext] = useState<{ evmToken: string; planEvmAddress: string } | null>(null);
  const [evmError, setEvmError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [skipBackup, setSkipBackup] = useState(false);
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const [evmSymbols, setEvmSymbols] = useState<string[]>([]);
  /** A committed wallet-owned plan, at its funding step. */
  const [created, setCreated] = useState<number | null>(null);
  /** The sealed request for one commitment, so a retry after the wallet signed sends it again. */
  const sealed = useRef<{ commitment: string; body: Record<string, unknown> } | null>(null);
  const wallet = useWalletPrompt(
    change ? undefined : (
      <>
        Next, you fund the plan’s budget from your wallet: it pays Glidepath’s relayer for the
        launch, each sale and closing the plan.
      </>
    ),
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const { result: attestation, error: attestationError } = useAttestation(meta);
  // Backups that pass the same checks get their own sealed copy; the others are left out.
  const backups = useBackupAttestations(meta).filter((b) => b.result.ok);
  const id = steps[step] as StepId;

  // Keep an unfinished new plan across reloads of this tab.
  useEffect(() => {
    if (!change) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ actor, form } satisfies Draft));
  }, [form, change, actor]);

  // EVM symbols already used by plans, so a second token cannot share one.
  useEffect(() => {
    if (change) return;
    api<{ token: { chain: string; symbol: string } }[]>('/api/plans')
      .then((list) =>
        setEvmSymbols(list.filter((p) => p.token.chain === 'evm').map((p) => p.token.symbol)),
      )
      .catch(() => undefined);
  }, [change]);

  // The start default comes from the chain clock, which arrives after the first render.
  const startTouched = useRef(false);
  useEffect(() => {
    if (change || !chainNow || startTouched.current) return;
    startTouched.current = true;
    const start = Math.ceil((chainNow + 3 * 60_000) / 60_000) * 60_000;
    const end = defaultEnd(start);
    setForm((f) => ({ ...f, start: msToLocal(start), end: msToLocal(end) }));
  }, [chainNow, change]);

  const set = (patch: Partial<PlanForm>) =>
    setForm((f) => {
      const next = { ...f, ...patch };
      // The envelope follows the sealed terms until the founder edits it by hand.
      return next.envTouched ? next : { ...next, ...suggestEnvelope(next) };
    });

  // Is the token account for this symbol free? Asked of the chain directly, after typing pauses.
  const tokenAccount = change
    ? change.token.address
    : form.chain === 'near'
      ? tokenAddressFor(form.symbol || 'x', meta.accounts.root)
      : (evmNext?.evmToken ?? '');
  useEffect(() => {
    if (change || form.chain !== 'near' || !/^[A-Z0-9]{2,8}$/.test(form.symbol)) {
      setNameAvailable(null);
      return;
    }
    let stop = false;
    setNameAvailable(null);
    const t = setTimeout(() => {
      nearAccountExists(tokenAccount)
        .then((exists) => !stop && setNameAvailable(!exists))
        .catch(() => !stop && setNameAvailable(null));
    }, 300);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [form.symbol, form.chain, tokenAccount, change]);

  useEffect(() => {
    if (change || form.chain !== 'evm') return;
    let stop = false;
    api<{ evmToken: string; planEvmAddress: string }>('/api/addresses/next')
      .then((r) => {
        if (!stop) {
          setEvmNext(r);
          setEvmError(null);
        }
      })
      .catch((e) => !stop && setEvmError(errorMessage(e)));
    return () => {
      stop = true;
    };
  }, [form.chain, change]);

  const token: TokenRef | null = change
    ? change.token
    : form.chain === 'near'
      ? { chain: 'near', address: tokenAccount, symbol: form.symbol, decimals: DECIMALS }
      : evmNext
        ? {
            chain: 'evm',
            chain_id: meta.evmChainId,
            address: evmNext.evmToken,
            symbol: form.symbol,
            decimals: DECIMALS,
          }
        : null;

  const proceedsAsset = `nep141:${meta.accounts.usdc}`;
  const evmOff = meta.modes.evm === 'off';
  const nearOff = !nearTokensOffered(meta) && !evmOff;
  const chains = evmOff
    ? (['near'] as const)
    : nearOff
      ? (['evm'] as const)
      : (['near', 'evm'] as const);
  const enclaveSim = simReason(meta, 'enclave');
  const liveQuote = isOutlayerQuote(meta.enclave.quote) ? meta.enclave.quote : null;
  // A saved draft may predate EVM being switched off on this server.
  useEffect(() => {
    if (evmOff && !change) setForm((f) => (f.chain === 'evm' ? { ...f, chain: 'near' } : f));
    if (nearOff && !change) setForm((f) => (f.chain === 'near' ? { ...f, chain: 'evm' } : f));
  }, [evmOff, nearOff, change]);
  const minCooling = meta.registry.config.min_cooling_off_ms;
  const errors: Errors = {
    token: {
      ...tokenErrors(form),
      ...(form.chain === 'near' && nameAvailable === false
        ? { symbol: `${tokenAccount} is already taken` }
        : {}),
      ...(form.chain === 'evm' && evmSymbols.includes(form.symbol)
        ? { symbol: `A plan already uses an EVM token called ${form.symbol}` }
        : {}),
    },
    terms: termsErrors(form, chainNow, !!change),
    envelope: envelopeErrors(form),
    disclosure: disclosureErrors(form, minCooling),
    review: {},
  }[id];

  const plan = token ? buildPlan(form, token, proceedsAsset) : null;
  const envelope = buildEnvelope(form);
  const within = plan && envelope ? checkWithinEnvelope(plan, envelope) : [];
  // The EVM beneficiary problem is already shown on its field.
  const problems = plan
    ? planProblems(plan).filter((p) => !p.startsWith('An EVM token needs a beneficiary'))
    : [];
  const warnings = planWarnings(form);
  const needsBackup = !change && form.disclosure === 'end_reveal';
  const envelopeOk = within.length > 0 && within.every((c) => c.ok);

  const stepValid =
    Object.keys(errors).length === 0 &&
    (id !== 'token' || form.chain === 'evm'
      ? !!token || id !== 'token'
      : nameAvailable !== false) &&
    (id !== 'terms' || (!!plan && problems.length === 0)) &&
    (id !== 'envelope' || envelopeOk);

  // Salt is drawn once per exact plan, so the commitment shown is the one that gets sealed.
  const planKey = plan ? canonicalJson(plan) : '';
  const salt = useMemo(() => (planKey ? newSaltHex() : ''), [planKey]);
  const commitment = plan && salt ? planCommitment(plan, salt) : '';
  useEffect(() => {
    // A new commitment means a new salt, so any earlier backup no longer matches.
    if (commitment) setDownloaded(false);
  }, [commitment]);

  function go(i: number) {
    setStep(i);
    setShowErrors(false);
    setSubmitError(null);
    requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
      headingRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  function next() {
    if (!stepValid) {
      setShowErrors(true);
      // After the errors render, take the founder to the first field that needs fixing.
      requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    const n = step + 1;
    setReached((r) => Math.max(r, n));
    go(n);
  }

  const err = (k: keyof PlanForm) => (showErrors ? errors[k] : undefined);

  const backup = (): PlanBackup | null =>
    plan && envelope
      ? {
          kind: 'glidepath-plan-backup',
          commitment,
          salt,
          plan: JSON.parse(canonicalJson(plan)),
          envelope: envelopeJson(envelope),
          launch: change
            ? undefined
            : {
                name: form.name.trim(),
                founder_allocation: wholeTokens(form.founderAllocation)?.toString(),
                listing_price_usd: form.listingPrice.trim(),
              },
          created_at: new Date().toISOString(),
        }
      : null;

  function loadBackupFile(file: File) {
    void file.text().then((text) => {
      const b = parseBackupFile(text);
      const p = backupPlan(b);
      if (!p) {
        setSubmitError('That file is not a plan backup from this app.');
        return;
      }
      setSubmitError(null);
      setLoadedFrom(file.name);
      set(formFromPlan(p));
    });
  }

  function downloadBackup() {
    const body = backup();
    if (!body) return;
    const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${form.symbol.toLowerCase() || 'plan'}-plan-${commitment.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
  }

  async function seal() {
    if (!plan || !envelope || !token || !attestation?.ok) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (sealed.current?.commitment !== commitment) {
        // The plan leaves this browser only encrypted to the attested enclave key.
        const payload = JSON.stringify({ plan: JSON.parse(canonicalJson(plan)), salt });
        const box = sealTo(meta.enclave.encryptionKeyHex, payload);
        const backupBoxes = backups.map((b) => ({
          signing_key: b.identity.signingKey,
          sealed_box: sealTo(b.identity.encryptionKeyHex, payload),
        }));
        const cooling = coolingMs(form) ?? minCooling;
        const body: Record<string, unknown> = change
          ? {
              actor,
              commitment,
              envelope: envelopeJson(envelope),
              sealed_box: box,
              backup_boxes: backupBoxes,
            }
          : {
              actor,
              label: form.label.trim(),
              token,
              beneficiary: {
                near_account: form.beneficiaryNear,
                ...(form.beneficiaryEvm.trim() ? { evm_address: form.beneficiaryEvm.trim() } : {}),
              },
              envelope: envelopeJson(envelope),
              disclosure:
                form.disclosure === 'delayed'
                  ? { type: 'delayed', delay_ms: Number(form.delayDays) * DAY_MS }
                  : { type: form.disclosure },
              cooling_off_ms: cooling,
              start_ms: Date.parse(plan.start),
              end_ms: Date.parse(plan.end),
              commitment,
              sealed_box: box,
              backup_boxes: backupBoxes,
              proceeds_asset: proceedsAsset,
            };
        sealed.current = { commitment, body };
      }
      const body = sealed.current.body;
      if (change) {
        const r = await ownerWrite<{ txHash: string; effectiveAtMs: number | null }>(
          `/api/plans/${change.planId}/change`,
          body,
          { planId: change.planId, confirm: wallet.confirm },
        );
        const b = backup();
        if (b) saveBackup(change.planId, b);
        sealed.current = null;
        onDone({ effectiveAtMs: r.effectiveAtMs });
        return;
      }
      const out = await ownerWrite<{
        planId: number;
        txHash: string;
        planAccount: string;
        /** Null for a wallet's plan (the wallet is the credential) or a retry of a create. */
        ownerKey: string | null;
      }>('/api/plans', body, { confirm: wallet.confirm });
      const b = backup();
      if (b) saveBackup(out.planId, b);
      const ownerKey = out.ownerKey ? parsePlanKey(out.ownerKey) : null;
      if (ownerKey) savePlanKey(out.planId, { key: ownerKey, saved: false });
      sessionStorage.removeItem(DRAFT_KEY);
      sealed.current = null;
      if (walletOwner) {
        setSubmitting(false);
        setCreated(out.planId);
        return;
      }
      onDone({ planId: out.planId });
    } catch (e) {
      setSubmitError(actionError(e));
      setSubmitting(false);
    }
  }

  const symbol = token?.symbol || form.symbol || 'TOKEN';
  const f = (k: keyof PlanForm | 'asset' | 'envPeriod') => `${uid}-${k}`;

  if (created !== null && token)
    return (
      <div>
        <h2 className="mb-3 text-lg font-semibold">Fund the plan</h2>
        <FundStep planId={created} chain={token.chain} onDone={() => onDone({ planId: created })} />
      </div>
    );

  return (
    <div>
      <Steps steps={steps} current={step} reached={reached} onPick={go} />
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          if (id === 'review') void seal();
          else next();
        }}
        noValidate
      >
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="mb-1 scroll-mt-36 text-lg font-semibold outline-none"
        >
          {STEP_TITLES[id]}
        </h2>

        {id === 'token' && (
          <div className="space-y-6">
            <p className="max-w-[70ch] text-sm text-ink-2">
              Launch a new token whose team allocation is minted straight into the plan, so it never
              sits under anyone’s key. The launch happens right after the plan is committed.
            </p>
            <fieldset>
              <legend className="label">Chain</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {chains.map((c) => (
                  <label
                    key={c}
                    className={`well flex cursor-pointer gap-3 p-4 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent`}
                  >
                    <input
                      type="radio"
                      name={f('chain')}
                      value={c}
                      checked={form.chain === c}
                      onChange={() => set({ chain: c })}
                      className="mt-1 self-start accent-[var(--accent)]"
                    />
                    <span>
                      <span className="block font-semibold">
                        {c === 'near' ? 'NEAR token (NEP-141)' : 'EVM token (ERC-20)'}
                      </span>
                      <span className="block text-sm text-ink-2">
                        {c === 'near'
                          ? 'Held by the keyless plan account on NEAR.'
                          : `On ${evmChainName(meta)}, held by an address only the registry can have signed, through Chain Signatures.`}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {nearOff && (
                <p className="hint mt-2">
                  This server offers plans for {evmChainName(meta)} tokens only.
                </p>
              )}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput
                id={f('symbol')}
                label="Symbol"
                value={form.symbol}
                onChange={(v) => {
                  const symbol = v
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, '')
                    .slice(0, 8);
                  setForm((prev) => {
                    const autoLabel =
                      !prev.label || prev.label === `${prev.symbol} team allocation`;
                    const autoName = !prev.name || prev.name === `${prev.symbol} Token`;
                    return {
                      ...prev,
                      symbol,
                      label: autoLabel ? `${symbol} team allocation` : prev.label,
                      name: autoName && symbol ? `${symbol} Token` : autoName ? '' : prev.name,
                    };
                  });
                }}
                error={
                  err('symbol') ??
                  (nameAvailable === false
                    ? `${tokenAccount} is already taken`
                    : form.chain === 'evm' && evmSymbols.includes(form.symbol)
                      ? `A plan already uses an EVM token called ${form.symbol}`
                      : undefined)
                }
                hint={
                  form.chain === 'near' ? (
                    form.symbol ? (
                      <span>
                        Token account <span className="mono">{tokenAccount}</span>
                        {nameAvailable === true && <span className="text-pass"> · available</span>}
                        {nameAvailable === null && ' · checking…'}
                      </span>
                    ) : (
                      '2 to 8 capital letters, e.g. ACME'
                    )
                  ) : (
                    '2 to 8 capital letters, e.g. BOLT'
                  )
                }
                placeholder="ACME"
                autoFocus
              />
              <TextInput
                id={f('name')}
                label="Token name"
                value={form.name}
                onChange={(v) => set({ name: v })}
                error={err('name')}
                placeholder="Acme Network"
              />
              <TextInput
                id={f('allocation')}
                label="Team allocation, minted into the plan"
                value={form.allocation}
                onChange={(v) => set({ allocation: v })}
                error={err('allocation')}
                suffix={symbol}
                inputMode="decimal"
                hint="Percent limits in the plan refer to this amount. 18 decimals."
              />
              <TextInput
                id={f('founderAllocation')}
                label="Owner’s own allocation (outside the plan)"
                value={form.founderAllocation}
                onChange={(v) => set({ founderAllocation: v })}
                error={err('founderAllocation')}
                suffix={symbol}
                inputMode="decimal"
                hint={
                  form.chain === 'near'
                    ? `Minted to ${actor}. It can be enrolled into the plan later.`
                    : `Minted to the app’s token deployer on ${evmChainName(meta)}, not to you or into the plan.`
                }
              />
              <TextInput
                id={f('listingPrice')}
                label="Listing price"
                value={form.listingPrice}
                onChange={(v) => set({ listingPrice: v })}
                error={err('listingPrice')}
                prefix="$"
                inputMode="decimal"
                hint={
                  meta.livePriceSymbols.includes(form.symbol)
                    ? `${form.symbol} has a real market, so this does not set its price.`
                    : 'A new token has no market yet; this sets its simulated price.'
                }
              />
              <TextInput
                id={f('label')}
                label="Plan name"
                value={form.label}
                onChange={(v) => set({ label: v })}
                error={err('label')}
                hint="Public. Shown on the verifier page."
              />
            </div>
            {form.chain === 'evm' && (
              <div className="well p-4 text-sm">
                {evmError ? (
                  <ErrorNote error={evmError} />
                ) : !evmNext ? (
                  <p className="text-ink-3">Reading the next addresses…</p>
                ) : (
                  <dl className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-ink-3">Token contract will deploy at</dt>
                      <dd>
                        <Hash value={evmNext.evmToken} label="token address" head={10} tail={8} />
                      </dd>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-ink-3">Plan’s Chain Signatures address</dt>
                      <dd>
                        <Hash
                          value={evmNext.planEvmAddress}
                          label="plan EVM address"
                          head={10}
                          tail={8}
                        />
                      </dd>
                    </div>
                    <p className="text-xs text-ink-3">
                      Derived from the registry account and the path plan/&lt;id&gt;. Only the
                      registry can ask the MPC network to sign for it.
                    </p>
                  </dl>
                )}
              </div>
            )}
          </div>
        )}

        {id === 'terms' && (
          <div className="space-y-6">
            <p className="flex max-w-[70ch] items-start gap-2 text-sm text-ink-2">
              <LockIcon className="mt-0.5 shrink-0 text-accent" />
              These terms are sealed. They are encrypted in this browser to the enclave’s key; the
              server and the public see only a salted hash.
            </p>
            {change && (
              <div className="well space-y-2 px-4 py-3 text-sm text-ink-2">
                <p>
                  Token, beneficiary, start and end are fixed by the registry and stay the same. The
                  allocation the percentages refer to is{' '}
                  <span className="num font-medium text-ink">
                    {tokens(wholeTokens(form.allocation) ?? 0n, DECIMALS, 0)} {symbol}
                  </span>
                  .
                </p>
                <p>
                  {loadedFrom
                    ? `Started from your backup file ${loadedFrom}.`
                    : change.current
                      ? 'Started from the current sealed plan saved in this browser.'
                      : 'This browser has no copy of the current sealed plan, so the fields show defaults. Load your backup file to start from the current terms.'}
                </p>
                <label className="btn btn-secondary btn-sm cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
                  Load backup file
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) loadBackupFile(file);
                    }}
                  />
                </label>
                {submitError && <p className="text-xs text-fail">{submitError}</p>}
              </div>
            )}
            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-2 text-sm font-semibold">How much</legend>
              <TextInput
                id={f('periodPct')}
                label="Sell at most, per period"
                value={form.periodPct}
                onChange={(v) => set({ periodPct: v })}
                error={err('periodPct')}
                suffix="%"
                inputMode="decimal"
                hint={
                  wholeTokens(form.allocation) !== null && plan
                    ? `${tokens((plan.allocation * BigInt(plan.max_sell_per_period_bps)) / 10_000n, DECIMALS, 0)} ${symbol}`
                    : 'Of the allocation'
                }
              />
              <TextInput
                id={f('periodDays')}
                label="Period length"
                value={form.periodDays}
                onChange={(v) => set({ periodDays: v })}
                error={err('periodDays')}
                suffix="days"
                inputMode="numeric"
                disabled={!!change}
                hint={change ? 'Fixed by the public envelope' : undefined}
              />
              <TextInput
                id={f('perSalePct')}
                label="Largest single sale"
                value={form.perSalePct}
                onChange={(v) => set({ perSalePct: v })}
                error={err('perSalePct')}
                suffix="%"
                inputMode="decimal"
                hint={
                  plan
                    ? `${tokens((plan.allocation * BigInt(plan.max_sell_per_tx_bps)) / 10_000n, DECIMALS, 0)} ${symbol}`
                    : 'Of the allocation'
                }
              />
            </fieldset>
            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-2 text-sm font-semibold">At what price</legend>
              <TextInput
                id={f('floorUsd')}
                label="Price floor"
                value={form.floorUsd}
                onChange={(v) => set({ floorUsd: v })}
                error={err('floorUsd')}
                prefix="$"
                inputMode="decimal"
                hint={`Never sell ${symbol} below this`}
              />
              <TextInput
                id={f('slippagePct')}
                label="Maximum slippage"
                value={form.slippagePct}
                onChange={(v) => set({ slippagePct: v })}
                error={err('slippagePct')}
                suffix="%"
                inputMode="decimal"
              />
              <TextInput
                id={f('agreementPct')}
                label="Sources must agree within"
                value={form.agreementPct}
                onChange={(v) => set({ agreementPct: v })}
                error={err('agreementPct')}
                suffix="%"
                inputMode="decimal"
                hint="Otherwise the sale waits"
              />
              <fieldset className="sm:col-span-3">
                <legend className="label">Price sources</legend>
                <div className="flex flex-wrap gap-3">
                  {PRICE_SOURCES.map((s) => (
                    <label
                      key={s}
                      className="well flex cursor-pointer items-center gap-2 px-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={form.sources.includes(s)}
                        className="accent-[var(--accent)]"
                        onChange={(e) =>
                          set({
                            sources: e.target.checked
                              ? [...form.sources, s]
                              : form.sources.filter((x) => x !== s),
                          })
                        }
                      />
                      {SOURCE_NAMES[s]}
                    </label>
                  ))}
                </div>
                {err('sources') && <p className="mt-1 text-xs text-fail">{err('sources')}</p>}
              </fieldset>
            </fieldset>
            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-semibold">When</legend>
              <TextInput
                id={f('gapMinMinutes')}
                label="Shortest gap between sales"
                value={form.gapMinMinutes}
                onChange={(v) => set({ gapMinMinutes: v })}
                error={err('gapMinMinutes')}
                suffix="min"
                inputMode="numeric"
              />
              <TextInput
                id={f('gapMaxMinutes')}
                label="Longest gap between sales"
                value={form.gapMaxMinutes}
                onChange={(v) => set({ gapMaxMinutes: v })}
                error={err('gapMaxMinutes')}
                suffix="min"
                inputMode="numeric"
                hint="Each sale happens at a random time in this window"
              />
              <TextInput
                id={f('start')}
                type="datetime-local"
                label="Start"
                value={form.start}
                onChange={(v) => {
                  startTouched.current = true;
                  set({ start: v });
                }}
                error={err('start')}
                disabled={!!change}
                hint={chainNow ? `Chain time now: ${fmtDateTime(chainNow)}` : undefined}
              />
              <TextInput
                id={f('end')}
                type="datetime-local"
                label="End"
                value={form.end}
                onChange={(v) => set({ end: v })}
                error={err('end')}
                disabled={!!change}
                hint="Whatever is left then goes to the beneficiary"
              />
            </fieldset>
            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-2 text-sm font-semibold">Proceeds</legend>
              <TextInput
                id={f('beneficiaryNear')}
                label="Beneficiary (NEAR account)"
                value={form.beneficiaryNear}
                onChange={(v) => set({ beneficiaryNear: v.trim() })}
                error={err('beneficiaryNear')}
                disabled={!!change}
              />
              <TextInput
                id={f('beneficiaryEvm')}
                label={
                  form.chain === 'evm'
                    ? 'Beneficiary EVM address'
                    : 'Beneficiary EVM address (optional)'
                }
                value={form.beneficiaryEvm}
                onChange={(v) => set({ beneficiaryEvm: v.trim() })}
                error={err('beneficiaryEvm')}
                disabled={!!change}
                placeholder="0x…"
                hint={form.chain === 'evm' ? 'Receives what is left at the end' : undefined}
              />
              <Field label="Paid in" htmlFor={f('asset')}>
                <select id={f('asset')} className="input" value={proceedsAsset} disabled>
                  <option value={proceedsAsset}>USDC on NEAR, via 1Click</option>
                </select>
              </Field>
            </fieldset>
            {warnings.length > 0 && (
              <ul className="space-y-2" aria-live="polite">
                {warnings.map((w) => (
                  <li
                    key={w}
                    className="rounded-lg border border-wait/40 bg-wait-soft px-4 py-2.5 text-sm text-wait"
                  >
                    {w}
                  </li>
                ))}
              </ul>
            )}
            {showErrors && problems.length > 0 && <ErrorNote error={problems.join('. ')} />}
          </div>
        )}

        {id === 'envelope' && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <div className="space-y-5">
              <p className="max-w-[70ch] text-sm text-ink-2">
                The public envelope is what holders see, and the registry enforces it on every sale
                no matter what the enclave says. Keep it looser than the sealed plan so it does not
                give the plan away.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Period" htmlFor={f('envPeriod')} hint="Always the sealed period">
                  <input
                    id={f('envPeriod')}
                    className="input"
                    disabled
                    value={
                      /^\d+$/.test(form.periodDays)
                        ? periodWords(Number(form.periodDays) * DAY_MS)
                        : ''
                    }
                  />
                </Field>
                <TextInput
                  id={f('envPerPeriod')}
                  label="Most sold per period"
                  value={form.envPerPeriod}
                  onChange={(v) => setForm((p) => ({ ...p, envPerPeriod: v, envTouched: true }))}
                  error={err('envPerPeriod')}
                  suffix={symbol}
                  inputMode="decimal"
                />
                <TextInput
                  id={f('envPerSale')}
                  label="Largest single sale"
                  value={form.envPerSale}
                  onChange={(v) => setForm((p) => ({ ...p, envPerSale: v, envTouched: true }))}
                  error={err('envPerSale')}
                  suffix={symbol}
                  inputMode="decimal"
                />
                <TextInput
                  id={f('envMinPrice')}
                  label="Minimum price"
                  value={form.envMinPrice}
                  onChange={(v) => setForm((p) => ({ ...p, envMinPrice: v, envTouched: true }))}
                  error={err('envMinPrice')}
                  prefix="$"
                  inputMode="decimal"
                  hint="Checked against each sale’s guaranteed minimum output"
                />
                <TextInput
                  id={f('envMinGapMinutes')}
                  label="Minimum gap between sales"
                  value={form.envMinGapMinutes}
                  onChange={(v) =>
                    setForm((p) => ({ ...p, envMinGapMinutes: v, envTouched: true }))
                  }
                  error={err('envMinGapMinutes')}
                  suffix="min"
                  inputMode="decimal"
                />
              </div>
              <div className="well px-4 py-3 text-sm text-ink-2">
                <p>
                  {change
                    ? 'These are the current public bounds. Loosening them is allowed, but holders see the new bounds during the cooling-off before they apply.'
                    : 'The suggested values are round figures with random slack (caps 1.5 to 3 times the sealed limits, a floor 50 to 80% of the sealed floor), so they reveal less than a fixed multiple would. Choose them deliberately: whatever you publish here tells holders the worst case.'}
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm mt-2"
                  onClick={() =>
                    setForm((p) => {
                      const next = { ...p, envSeed: newEnvelopeSeed(), envTouched: false };
                      return { ...next, ...suggestEnvelope(next) };
                    })
                  }
                >
                  Suggest other round values
                </button>
              </div>
            </div>
            <div className="well h-fit p-4" aria-live="polite">
              <p className="text-sm font-semibold">Sealed plan sits inside the envelope</p>
              <p className="mt-0.5 mb-2 text-xs text-ink-3">
                The enclave runs the same check before it accepts the plan. Its acknowledgement says
                only yes or no.
              </p>
              {within.length === 0 ? (
                <p className="text-sm text-ink-3">Fill in the sealed terms and envelope first.</p>
              ) : (
                <CheckList
                  checks={within.map((c) => ({ label: c.rule, state: c.ok ? 'pass' : 'fail' }))}
                />
              )}
            </div>
          </div>
        )}

        {id === 'disclosure' && (
          <div className="grid gap-8 lg:grid-cols-2">
            <fieldset>
              <legend className="label">When holders see sale amounts</legend>
              <div className="space-y-2">
                {(
                  [
                    [
                      'realtime',
                      'Right away',
                      'Each receipt shows its amount at once. Most open, easiest to read patterns from.',
                    ],
                    [
                      'delayed',
                      'After a delay',
                      'Receipts show compliance at once and amounts after the delay. Default.',
                    ],
                    [
                      'end_reveal',
                      'At the end',
                      'The enclave reveals the whole plan after it ends, checked against the commitment. Your backup is the fallback.',
                    ],
                  ] as const
                ).map(([value, title, text]) => (
                  <label
                    key={value}
                    className="well flex cursor-pointer gap-3 p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
                  >
                    <input
                      type="radio"
                      name={f('disclosure')}
                      checked={form.disclosure === value}
                      onChange={() => set({ disclosure: value })}
                      className="mt-1 self-start accent-[var(--accent)]"
                    />
                    <span>
                      <span className="block text-sm font-semibold">{title}</span>
                      <span className="block text-sm text-ink-2">{text}</span>
                    </span>
                  </label>
                ))}
              </div>
              {form.disclosure === 'delayed' && (
                <div className="mt-3 max-w-xs">
                  <TextInput
                    id={f('delayDays')}
                    label="Delay"
                    value={form.delayDays}
                    onChange={(v) => set({ delayDays: v })}
                    error={err('delayDays')}
                    suffix="days"
                    inputMode="numeric"
                  />
                </div>
              )}
              {form.disclosure === 'end_reveal' && (
                <p className="mt-3 rounded-lg border border-wait/40 bg-wait-soft px-4 py-2.5 text-sm text-wait">
                  When the plan ends, the enclave publishes it with its salt, and anyone checks they
                  hash to the commitment; it does so only once the chain shows the plan has ended.
                  The next step asks you to download the backup file: with it you can reveal the
                  plan yourself if the enclave cannot.
                </p>
              )}
            </fieldset>
            <fieldset>
              <legend className="label">Cooling-off for changes and cancelling</legend>
              <p className="mb-3 text-sm text-ink-2">
                Any change or cancellation is public at once and takes effect only after this long.
                The current plan keeps running meanwhile. There is no instant exit.
              </p>
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <TextInput
                    id={f('coolingValue')}
                    label="Cooling-off"
                    value={form.coolingValue}
                    onChange={(v) => set({ coolingValue: v })}
                    error={err('coolingValue')}
                    inputMode="numeric"
                    hint={`This registry accepts ${duration(minCooling)} or more.`}
                  />
                </div>
                <div className="w-32">
                  <Field label="Unit" htmlFor={f('coolingUnit')}>
                    <select
                      id={f('coolingUnit')}
                      className="input"
                      value={form.coolingUnit}
                      onChange={(e) => set({ coolingUnit: e.target.value as 'minutes' | 'days' })}
                    >
                      <option value="days">days</option>
                      <option value="minutes">minutes</option>
                    </select>
                  </Field>
                </div>
              </div>
            </fieldset>
          </div>
        )}

        {id === 'review' && (
          <div className="space-y-6">
            {!plan || !envelope ? (
              <ErrorNote error="The plan is incomplete. Go back and fix the highlighted fields." />
            ) : (
              <>
                <div className="grid gap-5 lg:grid-cols-2">
                  <Panel
                    level={3}
                    title={
                      <span className="flex items-center gap-2">
                        <LockIcon className="text-accent" /> Your sealed plan
                      </span>
                    }
                    description="Only you and the enclave will ever read this."
                  >
                    <ul className="list-disc space-y-1.5 pl-5 text-sm">
                      {plainLines(describePlan(plan), proceedsAsset).map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                      {token?.chain === 'evm' && <li>The token is on {evmChainName(meta)}.</li>}
                    </ul>
                  </Panel>
                  <Panel
                    level={3}
                    title="What the public sees"
                    description="Published on-chain and enforced by the registry on every sale."
                  >
                    <ul className="list-disc space-y-1.5 pl-5 text-sm">
                      {envelopeLines(envelope, symbol, DECIMALS).map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                      {!change && (
                        <>
                          <li>
                            Runs from {fmtDateTime(Date.parse(plan.start))} to{' '}
                            {fmtDateTime(Date.parse(plan.end))}.
                          </li>
                          <li>
                            Changes and cancelling wait {periodWords(coolingMs(form) ?? minCooling)}{' '}
                            in public first.
                          </li>
                          <li>
                            {form.disclosure === 'realtime'
                              ? 'Sale amounts are shown right away.'
                              : form.disclosure === 'delayed'
                                ? `Sale amounts are disclosed after ${form.delayDays} days.`
                                : 'The full plan is revealed after it ends.'}
                          </li>
                        </>
                      )}
                      <li>The commitment below, and a receipt for every sale.</li>
                    </ul>
                  </Panel>
                </div>

                <div className="grid gap-5 lg:grid-cols-2">
                  <Panel
                    level={3}
                    title="Enclave attestation"
                    description="Checked in this browser before anything is encrypted to its key."
                    actions={
                      liveQuote ? (
                        <Badge tone="accent">{OUTLAYER_LABEL}</Badge>
                      ) : enclaveSim ? (
                        <SimBadge title={`Simulated: ${enclaveSim}`}>Simulated TDX quote</SimBadge>
                      ) : undefined
                    }
                  >
                    {attestationError ? (
                      <ErrorNote error={attestationError} />
                    ) : !attestation ? (
                      <p className="text-sm text-ink-3">Checking…</p>
                    ) : attestation.ok ? (
                      <details open={attestation.checks.some((c) => c.warn)}>
                        <summary
                          className={`cursor-pointer text-sm ${attestation.checks.some((c) => c.warn) ? 'text-wait' : 'text-pass'}`}
                        >
                          {passedSummary(attestation.checks)}
                        </summary>
                        <CheckList
                          checks={attestation.checks.map((c) => ({
                            label: c.label,
                            state: checkState(c),
                            detail: c.detail,
                          }))}
                        />
                        {liveQuote && (
                          <div className="mt-2 border-t border-rule-2 pt-3">
                            <OutlayerEvidence quote={liveQuote} meta={meta} />
                          </div>
                        )}
                      </details>
                    ) : (
                      <div className="space-y-2">
                        <ErrorNote
                          error={`${attestationFailure(attestation.checks)} Sealing is blocked: nobody could vouch for the enclave the plan would be encrypted to.`}
                        />
                        <CheckList
                          checks={attestation.checks.map((c) => ({
                            label: c.label,
                            state: checkState(c),
                            detail: c.detail,
                          }))}
                        />
                      </div>
                    )}
                    {attestation?.ok && backups.length > 0 && (
                      <p className="mt-3 text-sm text-ink-2">
                        Also sealed to{' '}
                        {backups.length === 1
                          ? 'a backup build'
                          : `${backups.length} backup builds`}{' '}
                        of the enclave, checked the same way. A backup holds its own copy and sells
                        only if the main build cannot run.
                      </p>
                    )}
                  </Panel>
                  <Panel
                    level={3}
                    title="Commitment"
                    description="sha256(canonical plan ‖ salt), computed in this browser."
                  >
                    <p className="mono text-[0.8125rem] break-all">{commitment}</p>
                    <p className="mt-3 text-sm text-ink-2">
                      Save the plan and its salt. You need them to prove the plan later (for an end
                      reveal) and to start a change from the same terms on another device. This
                      browser also keeps a copy; the other is inside the enclave, which releases it
                      only for an end reveal, after the plan ends.
                    </p>
                    <button
                      type="button"
                      className="btn btn-secondary mt-3"
                      onClick={downloadBackup}
                    >
                      <DownloadIcon /> Download plan and salt
                    </button>
                    {downloaded && (
                      <p className="mt-2 text-xs text-pass" role="status">
                        Backup saved. Keep it private.
                      </p>
                    )}
                  </Panel>
                </div>
                {!envelopeOk && (
                  <ErrorNote error="The sealed plan is outside the public envelope. The enclave would refuse it." />
                )}
                {warnings.map((w) => (
                  <p
                    key={w}
                    className="rounded-lg border border-wait/40 bg-wait-soft px-4 py-2.5 text-sm text-wait"
                  >
                    {w}
                  </p>
                ))}
                {needsBackup && !downloaded && (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 accent-[var(--accent)]"
                      checked={skipBackup}
                      onChange={(e) => setSkipBackup(e.target.checked)}
                    />
                    <span>
                      I will not download the backup. I understand that if the enclave cannot reveal
                      this plan at the end, nobody can.
                    </span>
                  </label>
                )}
              </>
            )}
            {walletOwner && plan && envelope && (
              <Panel
                level={3}
                title="What your wallet signs and pays"
                description="Glidepath never holds your keys. Each step opens your wallet, which shows the transaction before you approve it."
              >
                <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                  {change ? (
                    <li>
                      Your wallet signs the change request on the registry and pays its gas. You see
                      the exact call, and anything it attaches, before the wallet opens.
                    </li>
                  ) : (
                    <>
                      <li>
                        <span className="font-medium">Commit the plan.</span> Your wallet signs it
                        on the registry as <span className="mono">{actor}</span> and pays the
                        deposit for the plan’s keyless account plus gas. The exact amount is shown
                        before the wallet opens.
                      </li>
                      <li>
                        <span className="font-medium">Fund the plan’s budget.</span> A NEAR transfer
                        from your wallet that pays Glidepath’s relayer for the launch, each enclave
                        run and sale, and closing the plan, at these prices:
                        {fees.data && (
                          <div className="mt-2">
                            <FeeList
                              budget={{ ...fees.data, balance: '0' }}
                              chain={form.chain === 'near' ? 'near' : 'evm'}
                            />
                          </div>
                        )}
                      </li>
                      <li>
                        <span className="font-medium">Launch {symbol}.</span> The relayer launches
                        it with the team allocation minted into the plan, paid from the budget.
                      </li>
                    </>
                  )}
                </ol>
              </Panel>
            )}
            {wallet.prompt}
            {submitError && <ErrorNote error={submitError} />}
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-5">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={step === 0 || submitting}
            onClick={() => go(step - 1)}
          >
            Back
          </button>
          <div className="flex items-center gap-3">
            {id === 'review' && !downloaded && plan && (
              <span className="hint hidden sm:inline">
                {needsBackup && !skipBackup
                  ? 'Download the backup first: it is the fallback for the end reveal.'
                  : 'You have not saved the backup yet.'}
              </span>
            )}
            {id === 'review' ? (
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  submitting ||
                  !plan ||
                  !envelope ||
                  !envelopeOk ||
                  !attestation?.ok ||
                  (needsBackup && !downloaded && !skipBackup)
                }
              >
                <LockIcon />
                {wallet.call
                  ? 'Waiting for your go-ahead…'
                  : submitting
                    ? 'Sealing…'
                    : change
                      ? 'Seal and request change'
                      : 'Seal and commit'}
              </button>
            ) : (
              <button type="submit" className="btn btn-primary">
                Continue
              </button>
            )}
          </div>
        </div>
        {showErrors && !stepValid && id !== 'review' && (
          <p className="mt-3 text-right text-sm text-fail" role="alert">
            {id === 'envelope' && !envelopeOk && Object.keys(errors).length === 0
              ? 'The sealed plan must sit inside the envelope.'
              : 'Fix the highlighted fields to continue.'}
          </p>
        )}
      </form>
    </div>
  );
}
