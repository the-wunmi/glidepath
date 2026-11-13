import { fmtDateTime } from '@/lib/format';
import { CopyButton } from './ui';

/**
 * The commitment, shown the way a certificate shows its number: the full hash in groups of
 * eight, so two people can read it to each other and compare. It is the one thing about a sealed
 * plan that is public, so it gets the most weight on the page.
 */
export function CommitmentSeal({
  commitment,
  committedAtMs,
  caption = 'Plan commitment',
}: {
  commitment: string;
  committedAtMs?: number | null;
  caption?: string;
}) {
  const groups = commitment.match(/.{1,8}/g) ?? [commitment];
  return (
    <figure className="relative overflow-hidden rounded-[10px] border border-accent/40 bg-surface">
      <div className="pointer-events-none absolute inset-[5px] rounded-[7px] border border-dashed border-accent/30" />
      <div className="relative flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:gap-6">
        <svg
          viewBox="0 0 64 64"
          className="size-14 shrink-0 text-accent"
          aria-hidden="true"
          fill="none"
        >
          <circle cx="32" cy="32" r="30" stroke="currentColor" strokeWidth="2" />
          <circle
            cx="32"
            cy="32"
            r="23"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2.5 2.5"
          />
          <path
            d="M22 33l7 7 13-16"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div className="min-w-0 flex-1">
          <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-semibold">{caption}</span>
            {committedAtMs ? (
              <span className="text-ink-2">
                Committed on-chain <span className="num">{fmtDateTime(committedAtMs)}</span>
              </span>
            ) : null}
            <span className="ml-auto">
              <CopyButton value={commitment} label="commitment" />
            </span>
          </figcaption>
          <p className="mono mt-2 grid grid-cols-4 gap-x-3 gap-y-1 text-[0.95rem] tracking-wide text-ink lg:grid-cols-8">
            <span className="sr-only">{commitment}</span>
            {groups.map((g, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed positions of the hash.
              <span key={i} aria-hidden="true">
                {g}
              </span>
            ))}
          </p>
          <p className="mt-2 text-xs text-ink-3">
            sha256 of the sealed plan and a secret salt. It proves which plan the enclave follows
            without showing its terms.
          </p>
        </div>
      </div>
    </figure>
  );
}
