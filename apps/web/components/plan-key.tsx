'use client';

import { useEffect, useId, useState } from 'react';
import {
  loadPlanKey,
  PLAN_KEY_EVENT,
  parsePlanKey,
  type StoredPlanKey,
  savePlanKey,
} from '@/lib/backup';
import { CopyIcon, DownloadIcon } from './icons';
import { Panel } from './ui';

/** The plan key this browser holds for a plan, kept current when one is stored elsewhere. */
export function usePlanKey(planId: number): StoredPlanKey | null {
  const [stored, setStored] = useState<StoredPlanKey | null>(null);
  useEffect(() => {
    const read = () => setStored(loadPlanKey(planId));
    read();
    window.addEventListener(PLAN_KEY_EVENT, read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener(PLAN_KEY_EVENT, read);
      window.removeEventListener('storage', read);
    };
  }, [planId]);
  return stored;
}

function downloadKey(planId: number, key: string) {
  const blob = new Blob([`${key}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `glidepath-plan-${planId}-key.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Copy and download buttons; `onSaved` runs after either succeeds. */
function KeyButtons({
  planId,
  stored,
  onSaved,
}: {
  planId: number;
  stored: StoredPlanKey;
  onSaved: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() =>
          void navigator.clipboard?.writeText(stored.key).then(() => {
            setCopied(true);
            onSaved();
          })
        }
      >
        <CopyIcon />
        {copied ? 'Copied' : 'Copy key'}
      </button>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => {
          downloadKey(planId, stored.key);
          onSaved();
        }}
      >
        <DownloadIcon />
        Download
      </button>
    </>
  );
}

/**
 * Shown once a plan exists and until its key is saved: the key cannot be shown again by anyone,
 * and without it the plan can be managed only from this browser.
 */
export function SavePlanKeyNotice({ planId, stored }: { planId: number; stored: StoredPlanKey }) {
  const uid = useId();
  const [kept, setKept] = useState(false);
  return (
    <section className="panel border-accent/50 px-5 py-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-[62ch]">
          <h2 id={`${uid}-title`} className="font-semibold">
            Save your plan key
          </h2>
          <p className="mt-0.5 text-sm text-ink-2">
            It is the only way to manage this plan from another browser, and nobody can recover it.
            This browser keeps a copy.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <KeyButtons planId={planId} stored={stored} onSaved={() => setKept(true)} />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!kept}
            title={kept ? undefined : 'Copy or download the key first'}
            onClick={() => savePlanKey(planId, { ...stored, saved: true })}
          >
            Done
          </button>
        </div>
      </div>
    </section>
  );
}

/** Stores a pasted plan key after checking its format; the API checks it on the first action. */
function PasteForm({ planId, onDone }: { planId: number; onDone?: () => void }) {
  const uid = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      noValidate
      className="mt-3 flex flex-wrap items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const key = parsePlanKey(text);
        if (!key) {
          setError('A plan key is 64 characters, 0–9 and a–f');
          return;
        }
        savePlanKey(planId, { key, saved: true });
        setText('');
        onDone?.();
      }}
    >
      <div className="min-w-0 flex-1 basis-64">
        <label htmlFor={`${uid}-key`} className="sr-only">
          Plan key
        </label>
        <input
          id={`${uid}-key`}
          className="input mono"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste your plan key"
          value={text}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${uid}-key-error` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        {error && (
          <p id={`${uid}-key-error`} className="mt-1 text-xs text-fail" role="alert">
            {error}
          </p>
        )}
      </div>
      <button type="submit" className="btn btn-secondary">
        Use key
      </button>
    </form>
  );
}

/** In place of the owner actions when this browser has no key for the plan. */
export function PlanKeyNeeded({ planId }: { planId: number }) {
  return (
    <div>
      <p className="text-sm text-ink-2">
        Owner actions need this plan’s key. Paste it to manage the plan from this browser.
      </p>
      <PasteForm planId={planId} />
    </div>
  );
}

/** The Proof tab's record of the key: copy it again, or replace a wrong one. */
export function PlanKeyPanel({ planId, stored }: { planId: number; stored: StoredPlanKey }) {
  const [replacing, setReplacing] = useState(false);
  return (
    <Panel
      title="Plan key"
      description="Lets you manage this plan from another browser. Nobody can recover it if it is lost."
      actions={
        <>
          <KeyButtons
            planId={planId}
            stored={stored}
            onSaved={() => !stored.saved && savePlanKey(planId, { ...stored, saved: true })}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={replacing}
            onClick={() => setReplacing((v) => !v)}
          >
            {replacing ? 'Keep this key' : 'Replace'}
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-2">
        This browser holds the key and sends it with each action.
      </p>
      {replacing && <PasteForm planId={planId} onDone={() => setReplacing(false)} />}
    </Panel>
  );
}
