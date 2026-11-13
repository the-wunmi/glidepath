'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { hasSimulatedParts } from '@/lib/env';
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
  { href: '/unlock', label: 'A real unlock (ARB)' },
  { href: '/evidence', label: 'Evidence' },
  { href: '/red-team', label: 'Red team' },
  { href: '/how-it-works', label: 'How it works' },
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
  // On the public server the demo controls steer everyone's demo, so only the operator gets them.
  const demo =
    hasSimulatedParts(meta.data) && (!meta.data?.public || operator.status === 'operator');

  // biome-ignore lint/correctness/useExhaustiveDependencies: close the menu whenever the route changes.
  useEffect(() => setMenuOpen(false), [path]);

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
            {demo && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSimOpen(true)}
                aria-haspopup="dialog"
                title="Demo controls: time, prices, 1Click outcomes"
              >
                <SlidersIcon />
                <span className="hidden sm:inline">Demo</span>
                <span className="sr-only sm:hidden">Demo controls</span>
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
