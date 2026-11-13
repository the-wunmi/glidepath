'use client';

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { shortHash } from '@/lib/format';
import { CheckIcon, CopyIcon, CrossIcon, DashIcon } from './icons';

export type Tone = 'neutral' | 'accent' | 'pass' | 'fail' | 'wait';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2 border-rule',
  accent: 'bg-accent-soft text-accent-text border-transparent',
  pass: 'bg-pass-soft text-pass border-transparent',
  fail: 'bg-fail-soft text-fail border-transparent',
  wait: 'bg-wait-soft text-wait border-transparent',
};

const DOTS: Record<Tone, string> = {
  neutral: 'bg-ink-3',
  accent: 'bg-accent',
  pass: 'bg-pass',
  fail: 'bg-fail',
  wait: 'bg-wait',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
  title,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${TONES[tone]}`}
    >
      {dot && <span className={`size-1.5 rounded-full ${DOTS[tone]}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Marks anything this build simulates. Hatched so it reads as "not real" even in grayscale. */
export function SimBadge({
  children = 'Simulated',
  title,
}: {
  children?: ReactNode;
  /** Why it is simulated, on hover. */
  title?: string;
}) {
  return (
    <span
      title={title}
      className="hatch inline-flex items-center rounded-full border border-dashed border-ink-3 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-ink-2"
    >
      {children}
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <button
      type="button"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
      aria-label={copied ? 'Copied' : `Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon className="text-pass" /> : <CopyIcon />}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  );
}

/** A hash, key or address: monospace, truncated in the middle, full value on hover and copy. */
export function Hash({
  value,
  label = 'value',
  head = 8,
  tail = 6,
  full = false,
  href,
}: {
  value: string;
  label?: string;
  head?: number;
  tail?: number;
  full?: boolean;
  href?: string;
}) {
  const text = full ? value : shortHash(value, head, tail);
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 align-middle">
      {href ? (
        <a
          href={href}
          className="mono link truncate text-[0.8125rem]"
          title={`${value} (opens an explorer)`}
          target="_blank"
          rel="noreferrer"
        >
          {text}
        </a>
      ) : (
        <span
          className={`mono text-[0.8125rem] ${full ? '[overflow-wrap:anywhere]' : 'truncate'}`}
          title={value}
        >
          {text}
        </span>
      )}
      <CopyButton value={value} label={label} />
    </span>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className = '',
  id,
  level = 2,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  /** Heading level, so a panel inside a section keeps the outline in order. */
  level?: 2 | 3;
}) {
  const headingId = useId();
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <section
      className={`panel ${className}`}
      aria-labelledby={title ? headingId : undefined}
      id={id}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rule-2 px-5 py-3.5">
          <div className="min-w-0">
            {title && (
              <Heading id={headingId} className="text-[0.95rem] font-semibold">
                {title}
              </Heading>
            )}
            {description && <p className="mt-0.5 text-sm text-ink-2">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  lead,
  actions,
  meta,
}: {
  title: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        {meta && <div className="mb-2 flex flex-wrap items-center gap-2">{meta}</div>}
        <h1 className="text-[1.75rem] leading-tight font-semibold sm:text-[2rem]">{title}</h1>
        {lead && <p className="mt-2 text-ink-2">{lead}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Label/value pairs, the way a statement lists them. */
export function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-[minmax(9rem,auto)_1fr] sm:gap-y-3">
      {items.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of label/value rows.
        <div key={i} className="contents">
          <dt className="text-xs text-ink-3 sm:text-sm">{k}</dt>
          <dd className="mb-2.5 min-w-0 text-sm last:mb-0 sm:mb-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export type CheckState = 'pass' | 'fail' | 'skip' | 'pending';

export function CheckMark({ state }: { state: CheckState }) {
  const cls = {
    pass: 'bg-pass-soft text-pass',
    fail: 'bg-fail-soft text-fail',
    skip: 'bg-surface-2 text-ink-3',
    pending: 'bg-surface-2 text-ink-3',
  }[state];
  const label = { pass: 'Passed', fail: 'Failed', skip: 'Not checked', pending: 'Checking' }[state];
  return (
    <span
      className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full ${cls}`}
      role="img"
      aria-label={label}
    >
      {state === 'pass' ? (
        <CheckIcon width={12} height={12} />
      ) : state === 'fail' ? (
        <CrossIcon width={12} height={12} />
      ) : (
        <DashIcon width={12} height={12} />
      )}
    </span>
  );
}

export function CheckList({
  checks,
}: {
  checks: { label: ReactNode; state: CheckState; detail?: ReactNode; extra?: ReactNode }[];
}) {
  return (
    <ul className="divide-y divide-rule-2">
      {checks.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: checks are an ordered, fixed list.
        <li key={i} className="flex items-start gap-2.5 py-2">
          <CheckMark state={c.state} />
          <div className="min-w-0 flex-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span>{c.label}</span>
              {c.extra}
            </div>
            {c.detail && <div className="mt-0.5 text-xs break-all text-ink-3">{c.detail}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="space-y-3 py-2" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-rule px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: Error | string; retry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-fail/30 bg-fail-soft px-4 py-3 text-sm text-fail"
    >
      <span>{typeof error === 'string' ? error : error.message}</span>
      {retry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1 text-xs text-fail">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="hint mt-1">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A horizontal bar for "used of cap"; the value is announced as text, not just drawn. */
export function Meter({
  value,
  label,
  tone = 'accent',
}: {
  value: number;
  label: string;
  tone?: 'accent' | 'wait' | 'fail';
}) {
  const v = Math.max(0, Math.min(100, value));
  const fill = { accent: 'bg-accent', wait: 'bg-wait', fail: 'bg-fail' }[tone];
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot be styled consistently across browsers.
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-rule-2"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
    >
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${v}%` }} />
    </div>
  );
}

export interface TabSpec<T extends string> {
  id: T;
  label: ReactNode;
  /** A short count or state after the label, e.g. the number of sales. */
  note?: ReactNode;
}

/**
 * The tab chosen in the URL hash (#sales), so a tab can be linked and survives a reload. Falls
 * back to the first tab when the hash names none of them.
 */
export function useHashTab<T extends string>(ids: readonly T[]): [T, (t: T) => void] {
  const first = ids[0] as T;
  const [tab, setTab] = useState<T>(first);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab ids are fixed per page.
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.slice(1) as T;
      setTab(ids.includes(h) ? h : first);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  const choose = (t: T) => {
    setTab(t);
    window.history.replaceState(null, '', t === first ? window.location.pathname : `#${t}`);
  };
  return [tab, choose];
}

/** WAI-ARIA tabs: arrow keys move between tabs, each tab controls one panel. */
export function Tabs<T extends string>({
  tabs,
  current,
  onChange,
  label,
  idBase,
}: {
  tabs: TabSpec<T>[];
  current: T;
  onChange: (t: T) => void;
  label: string;
  idBase: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (delta: number) => {
    const i = tabs.findIndex((t) => t.id === current);
    const next = tabs[(i + delta + tabs.length) % tabs.length];
    if (!next) return;
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="-mx-4 flex gap-1 overflow-x-auto border-b border-rule px-4 sm:mx-0 sm:px-0"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') move(1);
        else if (e.key === 'ArrowLeft') move(-1);
        else return;
        e.preventDefault();
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${t.id}`}
          aria-selected={t.id === current}
          aria-controls={`${idBase}-panel-${t.id}`}
          tabIndex={t.id === current ? 0 : -1}
          onClick={() => onChange(t.id)}
          className="-mb-px flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-sm whitespace-nowrap text-ink-2 hover:text-ink aria-selected:border-accent aria-selected:font-semibold aria-selected:text-ink"
        >
          {t.label}
          {t.note !== undefined && t.note !== null && (
            <span className="num rounded-full bg-surface-2 px-1.5 text-xs font-medium text-ink-3">
              {t.note}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  idBase,
  id,
  current,
  children,
}: {
  idBase: string;
  id: string;
  current: string;
  children: ReactNode;
}) {
  if (id !== current) return null;
  return (
    <div
      role="tabpanel"
      id={`${idBase}-panel-${id}`}
      aria-labelledby={`${idBase}-tab-${id}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a tab panel takes focus so keyboard users land in it.
      tabIndex={0}
      className="space-y-6 pt-6 outline-none"
    >
      {children}
    </div>
  );
}

/** Technical evidence, folded away from the main flow. */
export function ProofDetails({
  summary = 'For the curious',
  children,
}: {
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-rule-2 bg-surface-2 px-4">
      <summary className="cursor-pointer py-2.5 text-sm font-medium text-ink-2 hover:text-ink">
        {summary}
      </summary>
      <div className="pb-4 text-sm">{children}</div>
    </details>
  );
}
