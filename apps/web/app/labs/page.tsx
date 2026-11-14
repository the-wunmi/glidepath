import Link from 'next/link';
import { Badge, PageHeader } from '@/components/ui';

export const metadata = { title: 'Labs' };

const PROTOTYPES = [
  {
    href: '/labs/vault',
    name: 'Bitcoin vault',
    summary:
      'A Bitcoin address that no person holds a key to. Withdrawals wait out a public delay, and guardians can stop one or send everything to a recovery address, so a stolen key or a threatened owner cannot empty it at once.',
    where: 'NEAR testnet and Bitcoin testnet4',
  },
  {
    href: '/labs/trust',
    name: 'Blind trust',
    summary:
      'An official’s assets run by a sealed mandate they cannot read back. An enclave rebalances inside it; the page shows the rules the contract enforces, yes-or-no statements and a receipt per trade, and the total value. Balances and trades stay readable on-chain.',
    where: 'A local NEAR chain, with a simulated enclave and 1Click',
  },
];

export default function Labs() {
  return (
    <div>
      <PageHeader
        title="Labs"
        lead="Prototypes that use the mechanism behind Glidepath’s plans for other problems: an account with no keys, Chain Signatures to sign on other chains, and a public delay before anything moves. They are separate from selling plans and run on test networks only."
      />
      <ul className="grid gap-4 md:grid-cols-2">
        {PROTOTYPES.map((p) => (
          <li key={p.href} className="panel flex flex-col px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[0.95rem] font-semibold">
                <Link href={p.href} className="link">
                  {p.name}
                </Link>
              </h2>
              <Badge>Prototype</Badge>
            </div>
            <p className="mt-2 flex-1 text-sm text-ink-2">{p.summary}</p>
            <p className="mt-3 text-xs text-ink-3">{p.where}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
