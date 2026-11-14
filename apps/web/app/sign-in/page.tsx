'use client';

import { useEffect, useState } from 'react';
import { ErrorNote } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useMe } from '@/lib/session';

/** Where to send people without a testnet account: a wallet NEAR Connect offers on testnet that can sign a message. */
const TESTNET_WALLET = { name: 'Meteor Wallet', url: 'https://wallet.meteorwallet.app' };

/** The `?next=` path to return to, if it is a path on this site; anything else goes to the plans. */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next?.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/app';
  const url = new URL(next, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname === '/sign-in') return '/app';
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * NEAR wallet sign-in. The wallet connector runs under this page's wider content security policy
 * (see `usesWallet`); the shell turns moves to and from such pages into full page loads.
 */
export default function SignInPage() {
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState('');
  useEffect(() => setHost(window.location.host), []);

  return (
    <div className="mx-auto max-w-md py-4">
      <div className="panel px-5 py-6 sm:px-7">
        <h1 className="text-[1.5rem] leading-tight font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-ink-2">
          Sign in with your NEAR testnet account. Your wallet only signs a message to prove the
          account is yours: nothing is sent on chain and it costs nothing.
        </p>
        {me.data ? (
          <div className="mt-5 space-y-3">
            <p className="text-sm">
              Signed in as <span className="mono text-[0.9em]">{me.data.account}</span>.
            </p>
            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={() => window.location.assign(nextPath())}
            >
              Continue
            </button>
          </div>
        ) : (
          <>
            {host && (
              <p className="mt-3 text-sm font-semibold">
                Sign only if your wallet shows the request coming from {host}.
              </p>
            )}
            <button
              type="button"
              className="btn btn-primary mt-5 w-full"
              disabled={busy || me.loading}
              aria-busy={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const { walletSignIn } = await import('@/lib/wallet');
                  await walletSignIn();
                  // A full page load, so the next page gets its own policy and a fresh session.
                  window.location.assign(nextPath());
                } catch (err) {
                  setError(errorMessage(err));
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Waiting for the wallet…' : 'Choose a wallet'}
            </button>
            {error && (
              <div className="mt-3">
                <ErrorNote error={error} />
              </div>
            )}
            <p className="hint mt-4">
              No testnet account yet? Create one free in{' '}
              <a
                href={TESTNET_WALLET.url}
                target="_blank"
                rel="noreferrer"
                className="font-semibold underline underline-offset-2"
              >
                {TESTNET_WALLET.name}
              </a>{' '}
              (switch it to testnet), or use Intear, Nightly or a Ledger.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
