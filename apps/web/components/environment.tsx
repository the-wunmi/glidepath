'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { isOutlayerQuote } from '@/lib/attestation';
import { evmChainName, simReason } from '@/lib/env';
import { duration } from '@/lib/format';
import type { Meta } from '@/lib/types';
import { useMeta } from './meta';
import { ModeBadge } from './status';

interface Row {
  key: keyof Meta['modes'];
  name: string;
  detail: (m: Meta) => string;
}

const ROWS: Row[] = [
  {
    key: 'near',
    name: 'NEAR',
    detail: (m) => (m.network === 'testnet' ? 'NEAR testnet' : 'A NEAR node run by this server'),
  },
  {
    key: 'evm',
    name: 'EVM',
    detail: (m) =>
      m.modes.evm === 'off'
        ? 'Not offered here: NEAR tokens only'
        : m.modes.evm === 'live'
          ? evmChainName(m)
          : 'An EVM node run by this server',
  },
  {
    key: 'chainSignatures',
    name: 'Chain Signatures',
    detail: (m) =>
      simReason(m, 'chainSignatures')
        ? 'A stand-in signer on the local chain, same interface'
        : `The real MPC network (${m.accounts.signer})`,
  },
  {
    key: 'enclave',
    name: 'Enclave',
    detail: (m) =>
      simReason(m, 'enclave')
        ? `Because ${simReason(m, 'enclave')}`
        : isOutlayerQuote(m.enclave.quote)
          ? 'OutLayer TDX (testnet)'
          : 'A real TEE worker',
  },
  {
    key: 'oneclick',
    name: '1Click swaps',
    detail: (m) =>
      simReason(m, 'oneclick') ? `Because ${simReason(m, 'oneclick')}` : '1Click’s live API',
  },
  {
    key: 'prices',
    name: 'Prices',
    detail: (m) =>
      `Exchanges for ${m.livePriceSymbols.join(', ')}; new tokens get a simulated market`,
  },
];

/** The one place that says where this server runs and what it simulates. */
export function EnvironmentBadge() {
  const meta = useMeta().data;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const path = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: close whenever the route changes.
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!meta) return null;
  const simulated = ROWS.filter((r) => meta.modes[r.key] === 'mock').map((r) => r.name);
  const label = meta.network === 'testnet' ? 'Testnet' : 'Local chain';
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap text-ink-2 hover:text-ink ${simulated.length ? 'hatch border-dashed border-ink-3' : 'border-rule'}`}
        aria-expanded={open}
        aria-controls={panelId}
        title={
          simulated.length
            ? `${label}. Simulated here: ${simulated.join(', ')}.`
            : `${label}. Nothing is simulated.`
        }
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <section
          id={panelId}
          aria-label="Where this app runs"
          className="panel absolute top-full right-0 z-40 mt-2 w-[min(24rem,calc(100vw-2rem))] p-4 text-sm"
        >
          <p className="font-semibold">Where this app runs</p>
          <ul className="mt-2 divide-y divide-rule-2">
            {ROWS.map((r) => (
              <li key={r.key} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium">{r.name}</p>
                  <p className="text-xs text-ink-3">{r.detail(meta)}</p>
                </div>
                <ModeBadge mode={meta.modes[r.key]} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-2">
            Founder actions are signed by the server with its own key for each account; no wallet is
            connected. The shortest cooling-off this registry accepts is{' '}
            {duration(meta.registry.config.min_cooling_off_ms)}.
          </p>
          <Link href="/how-it-works#simulated" className="link mt-2 inline-block text-xs">
            How it works
          </Link>
        </section>
      )}
    </div>
  );
}
