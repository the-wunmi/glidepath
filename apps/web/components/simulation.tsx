'use client';

import { e6ToUsd, usdToE6 } from '@vsp/core';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/api';
import { announceSimChange, nearChainTimeMs, useChainNow } from '@/lib/chain';
import { fmtDateTime, shortHash } from '@/lib/format';
import {
  type PlanDetail,
  type PlanSummary,
  SIM_OUTCOMES,
  type SimOutcome,
  type SimSettings,
} from '@/lib/types';
import { CrossIcon } from './icons';
import { useMeta } from './meta';
import { ErrorNote, SimBadge } from './ui';

const OUTCOME_TEXT: Record<SimOutcome, string> = {
  success: 'Settles',
  refund: 'Refunded',
  fail: 'Fails',
  stall: 'Stalls (no answer)',
};

const PRICE_SOURCES = ['binance', 'coinbase'] as const;

/** The API moves the local chain's time at most an hour per call (apps/api MAX_ADVANCE_MINUTES). */
const MAX_ADVANCE_MINUTES = 60;
const ADVANCE_PRESETS = [
  { label: '10 min', minutes: 10 },
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
];

/** The most recently created sales across all plans, newest first: the ones a used outcome hit. */
async function latestSales(n: number) {
  const plans = await api<PlanSummary[]>('/api/plans');
  const details = await Promise.all(plans.map((p) => api<PlanDetail>(`/api/plans/${p.id}`)));
  return details
    .flatMap((d) => d.executions.map((x) => ({ planId: d.plan.id, seq: x.seq, at: x.createdAt })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, n)
    .reverse();
}

/**
 * Simulated prices are keyed by token address; people know tokens by symbol. Symbols come from
 * the plans' tokens and the proceeds token; an address no plan uses shows shortened.
 */
async function symbolsByAddress(usdc: string | undefined): Promise<Record<string, string>> {
  const plans = await api<PlanSummary[]>('/api/plans').catch(() => []);
  const out: Record<string, string> = usdc ? { [usdc]: 'USDC' } : {};
  for (const p of plans) out[p.token.address] = p.token.symbol;
  return out;
}

const assetLabel = (address: string, labels: Record<string, string>) =>
  labels[address] ??
  labels[address.toLowerCase()] ??
  (address.length > 16 ? shortHash(address, 6, 4) : address);

/** USD text for a basePriceE6 field; invalid input stays as typed until it is fixed. */
type Draft = SimSettings & { prices: Record<string, string> };

function toDraft(s: SimSettings): Draft {
  return {
    ...structuredClone(s),
    prices: Object.fromEntries(
      Object.entries(s.market.assets).map(([k, v]) => [k, e6ToUsd(BigInt(v.basePriceE6))]),
    ),
  };
}

function fromDraft(d: Draft, labels: Record<string, string>): SimSettings | string {
  const assets: SimSettings['market']['assets'] = {};
  for (const [address, text] of Object.entries(d.prices)) {
    if (!/^\d{1,9}(\.\d{1,6})?$/.test(text.trim()))
      return `Price for ${assetLabel(address, labels)} is not a number`;
    assets[address] = { basePriceE6: usdToE6(text.trim()).toString() };
  }
  return {
    market: { ...d.market, assets },
    oneclickOutcomes: d.oneclickOutcomes,
    enclaveUp: d.enclaveUp,
    mpcUp: d.mpcUp,
  };
}

function Switch({
  checked,
  onChange,
  label,
  on,
  off,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  on: string;
  off: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-sm">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className="inline-flex items-center gap-2 text-sm"
      >
        <span
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-pass' : 'bg-fail'}`}
        >
          <span
            className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`}
          />
        </span>
        <span className={`w-10 text-left font-semibold ${checked ? 'text-pass' : 'text-fail'}`}>
          {checked ? on : off}
        </span>
      </button>
    </div>
  );
}

export function SimulationDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const meta = useMeta();
  const chainNow = useChainNow();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [customMinutes, setCustomMinutes] = useState('60');
  const [progress, setProgress] = useState<{ from: number; target: number; now: number } | null>(
    null,
  );
  const [used, setUsed] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const usdc = meta.data?.accounts.usdc;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setError(null);
      setStatus('');
      void symbolsByAddress(usdc).then(setLabels);
      api<SimSettings>('/api/sim')
        .then((s) => {
          setDraft(toDraft(s));
          setSaved(JSON.stringify(s));
        })
        .catch((e) => setError(errorMessage(e)));
    } else if (!open && d.open) d.close();
  }, [open, usdc]);

  const built = draft ? fromDraft(draft, labels) : null;
  const dirty = !!built && typeof built !== 'string' && JSON.stringify(built) !== saved;

  async function apply() {
    if (!built || typeof built === 'string') return;
    setBusy(true);
    setError(null);
    try {
      const s = await api<SimSettings>('/api/sim', { method: 'PUT', body: built });
      setDraft(toDraft(s));
      setSaved(JSON.stringify(s));
      setStatus('Applied.');
      announceSimChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function advance(minutes: number) {
    setBusy(true);
    setError(null);
    setStatus(`Moving chain time forward ${minutes} minutes…`);
    try {
      // The API answers at once and fast-forwards the sandbox in the background.
      const r = await api<{ chainTimeMs: number; targetChainTimeMs?: number }>('/api/sim/advance', {
        body: { minutes },
      });
      const from = r.chainTimeMs;
      const target = r.targetChainTimeMs ?? r.chainTimeMs;
      setProgress({ from, target, now: from });
      for (let i = 0; i < 600; i++) {
        const now = await nearChainTimeMs().catch(() => from);
        setProgress({ from, target, now });
        if (now >= target) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      const now = await nearChainTimeMs().catch(() => target);
      setStatus(`Chain time is now ${fmtDateTime(now)}.`);
      announceSimChange();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'Chain time is already moving forward. Wait for it to finish.'
          : errorMessage(e),
      );
      setStatus('');
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  // While outcomes are queued, watch the queue and say which sale used each one.
  const savedQueue = saved ? (JSON.parse(saved) as SimSettings).oneclickOutcomes : [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm only when the saved queue changes.
  useEffect(() => {
    if (!open || savedQueue.length === 0) return;
    let stop = false;
    const t = setInterval(async () => {
      const s = await api<SimSettings>('/api/sim').catch(() => null);
      if (!s || stop) return;
      const before = JSON.parse(saved) as SimSettings;
      const usedCount = before.oneclickOutcomes.length - s.oneclickOutcomes.length;
      if (usedCount <= 0) return;
      const usedOutcomes = before.oneclickOutcomes.slice(0, usedCount);
      const hit = await latestSales(usedCount).catch(() => []);
      setUsed((u) => [
        ...usedOutcomes.map((o, i) => {
          const sale = hit[i];
          return sale
            ? `“${OUTCOME_TEXT[o]}” was used by plan #${sale.planId}, sale #${sale.seq}.`
            : `“${OUTCOME_TEXT[o]}” was used by the next swap.`;
        }),
        ...u,
      ]);
      setSaved(JSON.stringify(s));
      setDraft((d) => (d ? { ...d, oneclickOutcomes: s.oneclickOutcomes } : d));
    }, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [open, saved]);

  const set = (fn: (d: Draft) => void) =>
    setDraft((d) => {
      if (!d) return d;
      const next = structuredClone(d);
      fn(next);
      return next;
    });

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-[440px] border-l border-rule bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 id={titleId} className="text-base font-semibold">
                Demo controls
              </h2>
              <SimBadge>Demo only</SimBadge>
            </div>
            <p className="mt-1 text-sm text-ink-2">
              {meta.data?.network === 'testnet'
                ? 'Steer the simulated parts: the enclave, 1Click outcomes and new tokens’ prices. The chain and its clock are real.'
                : 'Steer the simulated parts and the local chain’s clock. None of this exists in a real deployment.'}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm size-8 px-0"
            aria-label="Close demo controls"
            onClick={onClose}
          >
            <CrossIcon />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {error && <ErrorNote error={error} />}

          {meta.data?.network !== 'testnet' && (
            <section aria-labelledby={`${titleId}-time`}>
              <h3 id={`${titleId}-time`} className="text-sm font-semibold">
                Chain time
              </h3>
              <p className="mt-0.5 text-sm text-ink-2">
                Now:{' '}
                <span className="num font-medium text-ink">
                  {chainNow ? fmtDateTime(chainNow) : '…'}
                </span>
                . Move it forward up to an hour at a time, for example to end a short cooling-off.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {ADVANCE_PRESETS.map((p) => (
                  <button
                    key={p.minutes}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => void advance(p.minutes)}
                  >
                    +{p.label}
                  </button>
                ))}
              </div>
              <form
                className="mt-2 flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const m = Number(customMinutes);
                  if (Number.isInteger(m) && m >= 1 && m <= MAX_ADVANCE_MINUTES) void advance(m);
                  else setError(`Minutes must be a whole number from 1 to ${MAX_ADVANCE_MINUTES}`);
                }}
              >
                <div className="flex-1">
                  <label className="label" htmlFor={`${titleId}-minutes`}>
                    Custom, in minutes (1 to {MAX_ADVANCE_MINUTES})
                  </label>
                  <input
                    id={`${titleId}-minutes`}
                    className="input"
                    inputMode="numeric"
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(e.target.value)}
                  />
                </div>
                <button type="submit" className="btn btn-secondary" disabled={busy}>
                  Advance
                </button>
              </form>
              {progress && (
                <div
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-rule-2"
                  role="progressbar"
                  aria-label="Chain time moved"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(
                    (Math.min(progress.now - progress.from, progress.target - progress.from) /
                      Math.max(1, progress.target - progress.from)) *
                      100,
                  )}
                >
                  <div
                    className="h-full bg-accent transition-[width]"
                    style={{
                      width: `${Math.min(100, ((progress.now - progress.from) / Math.max(1, progress.target - progress.from)) * 100)}%`,
                    }}
                  />
                </div>
              )}
              <p className="mt-2 text-xs text-ink-2" aria-live="polite">
                {status}
              </p>
            </section>
          )}

          {!draft ? (
            <p className="text-sm text-ink-3">Loading settings…</p>
          ) : (
            <>
              <section aria-labelledby={`${titleId}-systems`}>
                <h3 id={`${titleId}-systems`} className="text-sm font-semibold">
                  Systems
                </h3>
                <div className="divide-y divide-rule-2">
                  <Switch
                    label="Enclave"
                    on="Up"
                    off="Down"
                    checked={draft.enclaveUp}
                    onChange={(v) =>
                      set((d) => {
                        d.enclaveUp = v;
                      })
                    }
                  />
                  {meta.data?.network !== 'testnet' && (
                    <Switch
                      label="MPC signing network"
                      on="Up"
                      off="Down"
                      checked={draft.mpcUp}
                      onChange={(v) =>
                        set((d) => {
                          d.mpcUp = v;
                        })
                      }
                    />
                  )}
                </div>
                <p className="hint mt-1">
                  With the enclave down, no sale is signed (fail safe).
                  {meta.data?.network === 'testnet'
                    ? ''
                    : ' With MPC down, EVM sales wait for a signature.'}
                </p>
              </section>

              <section aria-labelledby={`${titleId}-market`}>
                <h3 id={`${titleId}-market`} className="text-sm font-semibold">
                  Prices of tokens with no market (USD)
                </h3>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {Object.keys(draft.prices).map((address, i) => (
                    <div key={address}>
                      <label
                        className="label truncate"
                        htmlFor={`${titleId}-p-${i}`}
                        title={address}
                      >
                        {assetLabel(address, labels)}
                      </label>
                      <input
                        id={`${titleId}-p-${i}`}
                        className="input"
                        inputMode="decimal"
                        value={draft.prices[address]}
                        onChange={(e) =>
                          set((d) => {
                            d.prices[address] = e.target.value;
                          })
                        }
                      />
                    </div>
                  ))}
                  <div>
                    <label className="label" htmlFor={`${titleId}-vol`}>
                      Volatility (bps, 100 = 1%)
                    </label>
                    <input
                      id={`${titleId}-vol`}
                      className="input"
                      type="number"
                      min={0}
                      max={2000}
                      value={draft.market.volatilityBps}
                      onChange={(e) =>
                        set((d) => {
                          d.market.volatilityBps = Number(e.target.value) || 0;
                        })
                      }
                    />
                  </div>
                </div>
              </section>

              <section aria-labelledby={`${titleId}-feeds`}>
                <h3 id={`${titleId}-feeds`} className="text-sm font-semibold">
                  Manipulate a price feed
                </h3>
                <p className="hint mt-0.5">
                  Shift one source by some basis points (1 bps = 0.01%, so 100 bps = 1%). If sources
                  disagree by more than the sealed tolerance, the enclave waits instead of selling.
                </p>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {PRICE_SOURCES.map((src) => (
                    <div key={src}>
                      <label className="label" htmlFor={`${titleId}-o-${src}`}>
                        {src === 'binance' ? 'Binance' : 'Coinbase'} offset (bps)
                      </label>
                      <input
                        id={`${titleId}-o-${src}`}
                        className="input"
                        type="number"
                        min={-5000}
                        max={5000}
                        step={50}
                        value={draft.market.sourceOffsetsBps[src] ?? 0}
                        onChange={(e) =>
                          set((d) => {
                            const v = Math.max(-5000, Math.min(5000, Number(e.target.value) || 0));
                            if (v === 0) delete d.market.sourceOffsetsBps[src];
                            else d.market.sourceOffsetsBps[src] = v;
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              </section>

              <section aria-labelledby={`${titleId}-1click`}>
                <h3 id={`${titleId}-1click`} className="text-sm font-semibold">
                  Next 1Click outcomes
                </h3>
                <p className="hint mt-0.5">
                  Queued outcomes apply to the next swaps in order; with an empty queue, swaps
                  settle.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {SIM_OUTCOMES.map((o) => (
                    <button
                      key={o}
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={draft.oneclickOutcomes.length >= 20}
                      onClick={() => set((d) => void d.oneclickOutcomes.push(o))}
                    >
                      Queue “{OUTCOME_TEXT[o]}”
                    </button>
                  ))}
                </div>
                {draft.oneclickOutcomes.length > 0 ? (
                  <ol className="mt-3 space-y-1">
                    {draft.oneclickOutcomes.map((o, i) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: queue positions are the identity.
                        key={i}
                        className="well flex items-center justify-between px-3 py-1.5 text-sm"
                      >
                        <span>
                          <span className="num mr-2 text-ink-3">{i + 1}.</span>
                          {OUTCOME_TEXT[o]}
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm size-6 px-0"
                          aria-label={`Remove outcome ${i + 1}`}
                          onClick={() => set((d) => void d.oneclickOutcomes.splice(i, 1))}
                        >
                          <CrossIcon width={12} height={12} />
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 text-sm text-ink-3">Queue is empty.</p>
                )}
                {used.length > 0 && (
                  <ul className="mt-3 space-y-1 text-sm" aria-live="polite">
                    {used.map((u, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log.
                      <li key={i} className="text-ink-2">
                        {u}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-rule px-5 py-3">
          <span className="text-xs text-ink-3">
            {typeof built === 'string'
              ? built
              : dirty
                ? 'Unapplied changes'
                : meta.data
                  ? 'No unapplied changes'
                  : ''}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!dirty || busy}
            onClick={() => void apply()}
          >
            Apply changes
          </button>
        </footer>
      </div>
    </dialog>
  );
}
