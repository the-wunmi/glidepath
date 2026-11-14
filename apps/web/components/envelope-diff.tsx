import type { EnvelopeJson } from '@glidepath/core';
import { periodWords, tokens, usdE6 } from '@/lib/format';

/**
 * The public bounds before and after a pending change, side by side, so a holder sees at once
 * whether the change loosens anything.
 */
export function EnvelopeDiff({
  current,
  pending,
  symbol,
  decimals,
}: {
  current: EnvelopeJson;
  pending: EnvelopeJson;
  symbol: string;
  decimals: number;
}) {
  const rows: { label: string; a: string; b: string; looser: boolean }[] = [
    {
      label: 'Most sold per period',
      a: `${tokens(current.max_amount_per_period, decimals)} ${symbol}`,
      b: `${tokens(pending.max_amount_per_period, decimals)} ${symbol}`,
      looser: BigInt(pending.max_amount_per_period) > BigInt(current.max_amount_per_period),
    },
    {
      label: 'Largest single sale',
      a: `${tokens(current.max_amount_per_tx, decimals)} ${symbol}`,
      b: `${tokens(pending.max_amount_per_tx, decimals)} ${symbol}`,
      looser: BigInt(pending.max_amount_per_tx) > BigInt(current.max_amount_per_tx),
    },
    {
      label: 'Minimum price',
      a: usdE6(current.min_price_usd_e6),
      b: usdE6(pending.min_price_usd_e6),
      looser: BigInt(pending.min_price_usd_e6) < BigInt(current.min_price_usd_e6),
    },
    {
      label: 'Minimum gap',
      a: current.min_gap_ms ? periodWords(current.min_gap_ms) : 'none',
      b: pending.min_gap_ms ? periodWords(pending.min_gap_ms) : 'none',
      looser: pending.min_gap_ms < current.min_gap_ms,
    },
    {
      label: 'Period',
      a: periodWords(current.period_ms),
      b: periodWords(pending.period_ms),
      looser: false,
    },
  ];
  const anyLooser = rows.some((r) => r.looser);
  // Unchanged bounds need no table: one sentence says it.
  if (rows.every((r) => r.a === r.b))
    return <p className="mt-3 text-sm text-ink-2">The public bounds stay the same.</p>;
  return (
    <div className="mt-3">
      <div className="overflow-x-auto rounded-lg border border-rule-2 bg-surface">
        <table className="table min-w-[460px]">
          <caption className="sr-only">Public envelope, current and after the change</caption>
          <thead>
            <tr>
              <th scope="col">Public bound</th>
              <th scope="col" className="r">
                Now
              </th>
              <th scope="col" className="r">
                After the change
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row" className="text-left font-medium">
                  {r.label}
                </th>
                <td className="num r">{r.a}</td>
                <td className={`num r ${r.a !== r.b ? 'font-semibold' : 'text-ink-3'}`}>
                  {r.b}
                  {r.looser && <span className="ml-2 text-xs font-semibold text-wait">looser</span>}
                  {r.a !== r.b && !r.looser && (
                    <span className="ml-2 text-xs font-semibold text-ink-2">tighter</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-3">
        {anyLooser
          ? 'This change loosens the public bounds. It can act only after the cooling-off, and holders see the new bounds now.'
          : 'This change keeps or tightens every public bound.'}
      </p>
    </div>
  );
}
