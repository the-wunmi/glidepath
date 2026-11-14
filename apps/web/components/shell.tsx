'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { hasSimulatedParts } from '@/lib/env';
import { type Me, signOut, useMe } from '@/lib/session';
import type { Resource } from '@/lib/use-resource';
import { usesWallet } from '@/lib/wallet';
import { EnvironmentBadge } from './environment';
import { MenuIcon, SealMark, SlidersIcon } from './icons';
import { useMeta } from './meta';
import { useOperator } from './operator';
import { SimulationDrawer } from './simulation';
import { ThemeToggle } from './theme';

const NAV = [
  { href: '/app', label: 'Your plans' },
  { href: '/verify', label: 'Verify a plan' },
];

/** Background and method pages: useful, but not where anyone starts. */
const FOOTER = [
  { href: '/unlock', label: 'Case study: ARB' },
  { href: '/evidence', label: 'Evidence' },
  { href: '/red-team', label: 'Red team' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/labs', label: 'Labs' },
  { href: '/operator', label: 'Operator' },
];

const isActive = (path: string, href: string) =>
  href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const meta = useMeta();
  const [menuOpen, setMenuOpen] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  const operator = useOperator();
  // On the public server the simulation controls steer everyone's view, so only the operator gets them.
  const demo =
    hasSimulatedParts(meta.data) && (!meta.data?.public || operator.status === 'operator');

  // biome-ignore lint/correctness/useExhaustiveDependencies: close the menu whenever the route changes.
  useEffect(() => setMenuOpen(false), [path]);
  useWalletPolicyBoundary(path);
  const me = useMe();

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-rule bg-surface">
        <div className="mx-auto flex h-14 max-w-[1180px] items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold text-ink">
            <SealMark className="text-accent" />
            <span className="tracking-tight whitespace-nowrap">Glidepath</span>
          </Link>
          <nav aria-label="Main" className="ml-2 hidden items-center gap-1 sm:flex">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(path, n.href) ? 'page' : undefined}
                className="rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-ink-2 hover:bg-surface-2 hover:text-ink aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-accent-text"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <EnvironmentBadge />
            <Account path={path} me={me} />
            {demo && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSimOpen(true)}
                aria-haspopup="dialog"
                title="Simulation controls: time, prices, 1Click outcomes"
              >
                <SlidersIcon />
                <span className="hidden sm:inline">Simulation</span>
                <span className="sr-only sm:hidden">Simulation controls</span>
              </button>
            )}
            <ThemeToggle />
            <button
              type="button"
              className="btn btn-ghost btn-sm size-8 px-0 sm:hidden"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MenuIcon />
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            id="mobile-nav"
            aria-label="Main"
            className="border-t border-rule-2 px-4 pt-2 pb-4 sm:hidden"
          >
            <ul className="space-y-0.5">
              {NAV.map((n) => (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={isActive(path, n.href) ? 'page' : undefined}
                    className="block rounded-md px-3 py-2 text-sm text-ink-2 aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-accent-text"
                  >
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
            {me.data && (
              <p className="mt-2 border-t border-rule-2 px-3 pt-3 text-xs text-ink-3">
                Signed in as <span className="mono text-ink-2">{me.data.account}</span>
              </p>
            )}
          </nav>
        )}
      </header>
      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>
      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-5 text-xs text-ink-3 sm:px-6">
          <span>Glidepath</span>
          <nav aria-label="More">
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {FOOTER.map((f) => (
                <li key={f.href}>
                  <Link
                    href={f.href}
                    aria-current={isActive(path, f.href) ? 'page' : undefined}
                    className="hover:text-ink aria-[current=page]:font-semibold aria-[current=page]:text-ink"
                  >
                    {f.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </footer>
      {demo && <SimulationDrawer open={simOpen} onClose={() => setSimOpen(false)} />}
    </div>
  );
}

/**
 * Wallet pages are served with a wider content security policy than the rest (see `usesWallet`),
 * and a policy belongs to the document, so moving between the two kinds of page must load the
 * page afresh. Links are caught before Next navigates; anything else (router.push, back and
 * forward) reloads once the route has changed.
 */
function useWalletPolicyBoundary(path: string) {
  const loadedAsWalletPage = useRef<boolean | null>(null);
  useEffect(() => {
    loadedAsWalletPage.current ??= usesWallet(path);
    if (usesWallet(path) !== loadedAsWalletPage.current) window.location.reload();
  }, [path]);
  useEffect(() => {
    const cross = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || link.target === '_blank' || e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (usesWallet(url.pathname) === loadedAsWalletPage.current) return;
      e.preventDefault();
      e.stopPropagation();
      window.location.assign(url.href);
    };
    document.addEventListener('click', cross, true);
    return () => document.removeEventListener('click', cross, true);
  }, []);
}

function Account({ path, me }: { path: string; me: Resource<Me | null> }) {
  const [busy, setBusy] = useState(false);
  if (me.loading) return null;
  if (!me.data) {
    if (path === '/sign-in') return null;
    return (
      <a href={`/sign-in?next=${encodeURIComponent(path)}`} className="btn btn-secondary btn-sm">
        Sign in
      </a>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        className="mono hidden max-w-[16ch] truncate text-xs text-ink-2 sm:inline"
        title={me.data.account}
      >
        {me.data.account}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        title={`Signed in as ${me.data.account}`}
        onClick={async () => {
          setBusy(true);
          try {
            await signOut();
          } finally {
            // Every page re-reads who is signed in.
            window.location.reload();
          }
        }}
      >
        Sign out
      </button>
    </div>
  );
}
