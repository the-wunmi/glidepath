'use client';

import { useId, useState } from 'react';
import { useMeta } from '@/components/meta';
import { useOperator } from '@/components/operator';
import { PageHeader } from '@/components/ui';

/**
 * Sign-in for the people running this deployment. The token stays in this browser and goes out
 * as the bearer on API calls; it lets the operator manage plans that have no plan key here
 * (the showcase plans) and, on the public server, use the demo controls.
 */
export default function OperatorPage() {
  const uid = useId();
  const meta = useMeta();
  const { status, signIn, signOut } = useOperator();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="max-w-xl">
      <PageHeader
        title="Operator"
        lead="For the people running this deployment. Holders and founders need nothing here."
      />
      {status === 'operator' || status === 'unchecked' ? (
        <section className="panel px-5 py-4" aria-live="polite">
          <p className="font-semibold">
            {status === 'operator' ? 'Signed in as operator' : 'Operator token saved'}
          </p>
          <p className="mt-0.5 text-sm text-ink-2">
            {status === 'operator'
              ? `This browser can manage every plan${meta.data?.public ? ' and use the demo controls' : ''}.`
              : 'The API could not check it just now; it is sent with every call from this browser.'}
          </p>
          <button type="button" className="btn btn-secondary mt-3" onClick={signOut}>
            Sign out
          </button>
        </section>
      ) : (
        <form
          className="panel px-5 py-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            const t = token.trim();
            if (!t) {
              setError('Paste the operator token');
              return;
            }
            setError(null);
            const s = await signIn(t);
            if (s === 'refused') setError('The API refused that token.');
            else setToken('');
          }}
        >
          <label htmlFor={`${uid}-token`} className="label">
            Operator token
          </label>
          <input
            id={`${uid}-token`}
            type="password"
            autoComplete="off"
            className="input mono"
            value={token}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${uid}-token-error` : `${uid}-token-hint`}
            onChange={(e) => {
              setToken(e.target.value);
              setError(null);
            }}
          />
          {error ? (
            <p id={`${uid}-token-error`} className="mt-1 text-xs text-fail" role="alert">
              {error}
            </p>
          ) : (
            <p id={`${uid}-token-hint`} className="hint mt-1">
              Kept in this browser only and checked with the API.
            </p>
          )}
          <button type="submit" className="btn btn-primary mt-3" disabled={status === 'checking'}>
            {status === 'checking' ? 'Checking…' : 'Sign in'}
          </button>
        </form>
      )}
    </div>
  );
}
