'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { OneClickCheck } from '@/components/oneclick-check';
import { Badge, ErrorNote, LoadingBlock, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { bps, fmtDate, pct, usdCompact } from '@/lib/format';
import { useResource } from '@/lib/use-resource';

/** data/replay/results.json, served at GET /api/replay. Only the fields this page reads. */
interface Spread {
  p10: number;
  median: number;
  p90: number;
}
interface ReplayEvent {
  event: {
    id: string;
    token: string;
    symbol: string;
    unlock_date: string;
    unlock_amount: string;
    insider_amount: string;
    recipients: string;
    share_of_supply: { pct: number; basis: string };
    share_of_supply_notes: string;
    verification: string;
    verification_notes: string;
    sources: { url: string; supports: string; fetched_at: string }[];
  };
  observed: {
    return_t_minus_30d_to_t_minus_1d: number;
    market_return_t_minus_30d_to_t_minus_1d: number;
    excess_return_t_minus_30d_to_t_minus_1d: number;
    return_t_minus_1d_to_t_plus_7d: number;
    excess_return_t_minus_1d_to_t_plus_7d: number;
    return_t_minus_1d_to_t_plus_30d: number;
    excess_return_t_minus_1d_to_t_plus_30d: number;
    max_drawdown_t_minus_30d_to_t_plus_30d: number;
    volume_ratio_week_after_vs_month_before: number;
  };
  simulation: {
    sell_quantity: string;
    notional_at_t_minus_1d_usd: number;
    benchmark: { impact_bps: number; max_daily_participation: number };
    sealed: { impact_bps: Spread };
    comparison: {
      impact_avoided_bps: Spread;
      impact_avoided_usd: Spread;
      price_path_difference_bps: Spread;
      net_difference_bps: Spread;
      sealed_vs_public_twap_net_bps: Spread;
    };
    sensitivity: {
      impact_coefficient: number;
      sell_fraction_bps: number;
      impact_avoided_bps: Spread;
    }[];
  };
  data: { source_url: string; candles: number; first_open: string; last_open: string };
}
interface Replay {
  data_fetched_from: string;
  labels: { observed: string; price_path_difference: string; impact: string };
  params: {
    sell_fraction_bps: number;
    plan_days: number;
    benchmark_days: number;
    sealed_sales: number;
    seeds: number;
    sensitivity_coefficients: number[];
    sensitivity_sell_fractions_bps: number[];
  };
  method: { summary: string; steps: string[] };
  assumptions: string[];
  limitations: string[];
  data_sources: { symbol: string; event_id: string; source_url: string; candles: number }[];
  events: ReplayEvent[];
}

const short = (e: ReplayEvent) => e.event.symbol.replace(/USDT$/, '');
const compact = (n: string) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(
    Number(n),
  );
const range = (s: Spread) => `${bps(s.p10)} to ${bps(s.p90)}`;

function Label({ kind }: { kind: 'observed' | 'model' | 'path' }) {
  return kind === 'observed' ? (
    <Badge tone="accent">Observed</Badge>
  ) : kind === 'model' ? (
    <Badge tone="wait">Model estimate</Badge>
  ) : (
    <Badge tone="neutral">Real prices, hypothetical timing</Badge>
  );
}

/** Signs carry the meaning; green and red stay reserved for pass and fail. */
function Signed({ children }: { value: number; children: ReactNode }) {
  return <span>{children}</span>;
}

function Findings({ r }: { r: Replay }) {
  const pre = r.events.map((e) => ({
    s: short(e),
    v: e.observed.excess_return_t_minus_30d_to_t_minus_1d,
  }));
  const under = pre.filter((x) => x.v < 0);
  const avoided = r.events.map((e) => e.simulation.comparison.impact_avoided_bps.median);
  const twap = r.events.map((e) => e.simulation.comparison.sealed_vs_public_twap_net_bps.median);
  const negative = r.events.filter((e) => e.simulation.comparison.net_difference_bps.median < 0);
  return (
    <div className="grid gap-px overflow-hidden rounded-[10px] border border-rule bg-rule md:grid-cols-2">
      <div className="bg-surface p-5">
        <Label kind="observed" />
        <p className="mt-3 font-semibold">
          In {under.length} of {pre.length} unlocks the token lagged BTC in the 30 days before the
          public date.
        </p>
        <p className="mt-1 text-sm text-ink-2">
          {under.map((x) => `${x.s} ${pct(x.v)}`).join(', ')} against BTC.{' '}
          {pre
            .filter((x) => x.v >= 0)
            .map((x) => `${x.s} did ${pct(x.v)} better.`)
            .join(' ')}{' '}
          This is the window a public schedule leaves open for selling ahead of the date. Four
          events cannot show the unlock caused it.
        </p>
      </div>
      <div className="bg-surface p-5">
        <Label kind="model" />
        <p className="mt-3 font-semibold">
          Spreading the sale over {r.params.plan_days} days cut the estimated impact cost by{' '}
          {Math.round(Math.min(...avoided))} to {Math.round(Math.max(...avoided))} bps.
        </p>
        <p className="mt-1 text-sm text-ink-2">
          A public {r.params.plan_days}-day TWAP gets about the same: the sealed plan’s median
          result against it is {bps(Math.max(...twap))} to {bps(Math.min(...twap))}. The model
          rewards spreading sales out, not hiding them.
        </p>
      </div>
      <div className="bg-surface p-5">
        <Label kind="path" />
        <p className="mt-3 font-semibold">
          On real prices, the net result was negative for {negative.map(short).join(' and ')}.
        </p>
        <p className="mt-1 text-sm text-ink-2">
          Their prices kept falling for months after the unlock, so any seller who waited got less.
          Where prices rose, waiting got more. That is the market’s path, not a property of sealed
          plans.
        </p>
      </div>
      <div className="bg-surface p-5">
        <Badge>What this does not measure</Badge>
        <p className="mt-3 font-semibold">
          The sealed plan’s main claim, that nobody can see when sales will come, is not quantified
          here.
        </p>
        <p className="mt-1 text-sm text-ink-2">
          The observed pre-unlock underperformance shows the size of the window a public schedule
          exposes. Whether a sealed plan closes it in practice needs live plans to measure.
        </p>
      </div>
    </div>
  );
}

export default function EvidencePage() {
  const replay = useResource(() => api<Replay>('/api/replay'), []);
  const r = replay.data;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Evidence: four unlocks replayed"
        lead="We replayed four large, publicly scheduled team and investor unlocks with real hourly Binance prices. Observed numbers and model estimates are kept apart, and the limits are stated."
      />
      {replay.error && !r ? (
        <ErrorNote error={replay.error} retry={replay.reload} />
      ) : !r ? (
        <div className="panel px-5 py-5">
          <LoadingBlock label="Loading the replay study" />
        </div>
      ) : (
        <>
          <Findings r={r} />

          <Panel
            title="A. What prices did around each public unlock"
            description={r.labels.observed}
            actions={<Label kind="observed" />}
          >
            <div className="-mx-5 overflow-x-auto">
              <table className="table min-w-[860px]">
                <caption className="sr-only">Observed returns around each unlock</caption>
                <thead>
                  <tr>
                    <th scope="col">Unlock</th>
                    <th scope="col" className="r">
                      30 days before (vs BTC)
                    </th>
                    <th scope="col" className="r">
                      Day before to +7 days (vs BTC)
                    </th>
                    <th scope="col" className="r">
                      Day before to +30 days (vs BTC)
                    </th>
                    <th scope="col" className="r">
                      Max drawdown ±30 days
                    </th>
                    <th scope="col" className="r">
                      Volume, week after / month before
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.events.map((e) => {
                    const o = e.observed;
                    return (
                      <tr key={e.event.id}>
                        <th scope="row" className="text-left font-semibold">
                          {e.event.token}
                          <div className="num text-xs font-normal text-ink-3">
                            {fmtDate(e.event.unlock_date)}
                          </div>
                        </th>
                        <td className="num r">
                          {pct(o.return_t_minus_30d_to_t_minus_1d)}{' '}
                          <Signed value={o.excess_return_t_minus_30d_to_t_minus_1d}>
                            <strong>({pct(o.excess_return_t_minus_30d_to_t_minus_1d)})</strong>
                          </Signed>
                        </td>
                        <td className="num r">
                          {pct(o.return_t_minus_1d_to_t_plus_7d)}{' '}
                          <Signed value={o.excess_return_t_minus_1d_to_t_plus_7d}>
                            ({pct(o.excess_return_t_minus_1d_to_t_plus_7d)})
                          </Signed>
                        </td>
                        <td className="num r">
                          {pct(o.return_t_minus_1d_to_t_plus_30d)}{' '}
                          <Signed value={o.excess_return_t_minus_1d_to_t_plus_30d}>
                            ({pct(o.excess_return_t_minus_1d_to_t_plus_30d)})
                          </Signed>
                        </td>
                        <td className="num r">{pct(o.max_drawdown_t_minus_30d_to_t_plus_30d)}</td>
                        <td className="num r">
                          {o.volume_ratio_week_after_vs_month_before.toFixed(2)}×
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-ink-3">
              Returns are the token’s own; in brackets, the token minus BTC over the same window (a
              crude control for the whole market). The unlock is taken as 00:00 UTC on the date.
            </p>
          </Panel>

          <Panel
            title={`B. Selling ${r.params.sell_fraction_bps / 100}% of the tranche: sealed plan against selling in ${r.params.benchmark_days} days`}
            description={`A sealed plan of ${r.params.sealed_sales} sales at random hours over ${r.params.plan_days} days, ${r.params.seeds.toLocaleString('en-US')} seeded runs per event; median with the 10th–90th percentile range. All figures are basis points of the benchmark’s proceeds.`}
          >
            <div className="-mx-5 overflow-x-auto">
              <table className="table min-w-[980px]">
                <caption className="sr-only">Modelled comparison per event</caption>
                <thead>
                  <tr>
                    <th scope="col">Unlock</th>
                    <th scope="col" className="r">
                      Quantity
                    </th>
                    <th scope="col" className="r">
                      Impact avoided <Label kind="model" />
                    </th>
                    <th scope="col" className="r">
                      Price-path difference <Label kind="path" />
                    </th>
                    <th scope="col" className="r">
                      Net
                    </th>
                    <th scope="col" className="r">
                      vs public TWAP
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.events.map((e) => {
                    const c = e.simulation.comparison;
                    return (
                      <tr key={e.event.id}>
                        <th scope="row" className="text-left font-semibold">
                          {short(e)}
                        </th>
                        <td className="num r">
                          {compact(e.simulation.sell_quantity)} {short(e)}
                          <div className="text-xs text-ink-3">
                            ≈ {usdCompact(e.simulation.notional_at_t_minus_1d_usd)}
                          </div>
                        </td>
                        <td className="num r">
                          {bps(c.impact_avoided_bps.median)}
                          <div className="text-xs text-ink-3">
                            {range(c.impact_avoided_bps)}, ≈{' '}
                            {usdCompact(c.impact_avoided_usd.median)}
                          </div>
                        </td>
                        <td className="num r">
                          <Signed value={c.price_path_difference_bps.median}>
                            {bps(c.price_path_difference_bps.median)}
                          </Signed>
                          <div className="text-xs text-ink-3">
                            {range(c.price_path_difference_bps)}
                          </div>
                        </td>
                        <td className="num r font-semibold">
                          <Signed value={c.net_difference_bps.median}>
                            {bps(c.net_difference_bps.median)}
                          </Signed>
                          <div className="text-xs font-normal text-ink-3">
                            {range(c.net_difference_bps)}
                          </div>
                        </td>
                        <td className="num r">
                          {bps(c.sealed_vs_public_twap_net_bps.median)}
                          <div className="text-xs text-ink-3">
                            {range(c.sealed_vs_public_twap_net_bps)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="mt-4 list-disc space-y-1.5 pl-5 text-sm text-ink-2">
              <li>
                <strong className="text-ink">Impact avoided</strong> is a model output (square-root
                impact, coefficient 1). It scales directly with the coefficient.
              </li>
              <li>
                <strong className="text-ink">Price-path difference</strong> uses real prices at
                hypothetical sale times. It is set by where the market went, and in a rising market
                it has the opposite sign.
              </li>
              <li>
                <strong className="text-ink">vs public TWAP</strong> compares the sealed plan with
                an even public schedule over the same {r.params.plan_days} days. Close to zero: the
                model gives no credit for being unpredictable.
              </li>
            </ul>
          </Panel>

          <Panel
            title="Sensitivity of the modelled impact saving"
            description="Median impact avoided, in bps, for other sale sizes and impact coefficients (Y)."
            actions={<Label kind="model" />}
          >
            <div className="-mx-5 overflow-x-auto">
              <table className="table min-w-[640px]">
                <thead>
                  <tr>
                    <th scope="col">Unlock</th>
                    {r.params.sensitivity_sell_fractions_bps.map((f) => (
                      <th key={f} scope="col" className="r">
                        {f / 100}% sold, Y = {r.params.sensitivity_coefficients.join(' / ')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.events.map((e) => (
                    <tr key={e.event.id}>
                      <th scope="row" className="text-left font-semibold">
                        {short(e)}
                      </th>
                      {r.params.sensitivity_sell_fractions_bps.map((f) => (
                        <td key={f} className="num r">
                          {r.params.sensitivity_coefficients
                            .map((y) =>
                              Math.round(
                                e.simulation.sensitivity.find(
                                  (s) => s.sell_fraction_bps === f && s.impact_coefficient === y,
                                )?.impact_avoided_bps.median ?? Number.NaN,
                              ),
                            )
                            .join(' / ')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <section aria-labelledby="events">
            <h2 id="events" className="mb-4 text-lg font-semibold">
              The events and their sources
            </h2>
            <div className="grid gap-5 md:grid-cols-2">
              {r.events.map((e) => (
                <article key={e.event.id} className="panel p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">{e.event.token}</h3>
                    <Badge tone={e.event.verification === 'confirmed' ? 'pass' : 'wait'}>
                      {e.event.verification === 'confirmed'
                        ? 'Amounts confirmed'
                        : 'Amount partly derived'}
                    </Badge>
                  </div>
                  <p className="num mt-1 text-sm text-ink-2">
                    {fmtDate(e.event.unlock_date)}: {compact(e.event.unlock_amount)} unlocked,{' '}
                    {compact(e.event.insider_amount)} to team and investors (
                    {e.event.share_of_supply.pct}% of {e.event.share_of_supply.basis} supply).
                  </p>
                  <p className="mt-2 text-sm">{e.event.recipients}</p>
                  <p className="mt-2 text-xs text-ink-3">{e.event.verification_notes}</p>
                  <ul className="mt-3 space-y-1 text-sm">
                    {e.event.sources.map((s) => (
                      <li key={s.url}>
                        <a href={s.url} className="link" target="_blank" rel="noreferrer">
                          {new URL(s.url).hostname.replace(/^www\./, '')}
                        </a>
                        <span className="text-ink-3">: {s.supports}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Method">
              <p className="text-sm text-ink-2">{r.method.summary}</p>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm">
                {r.method.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </Panel>
            <div className="space-y-6">
              <Panel title="Assumptions">
                <ul className="list-disc space-y-1.5 pl-5 text-sm">
                  {r.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Panel>
              <Panel title="Limitations">
                <ul className="list-disc space-y-1.5 pl-5 text-sm">
                  {r.limitations.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Panel>
            </div>
          </div>

          <section aria-labelledby="checks" className="space-y-4">
            <h2 id="checks" className="text-lg font-semibold">
              Checks you can run now
            </h2>
            <OneClickCheck />
            <p className="text-sm text-ink-2">
              The{' '}
              <Link href="/red-team" className="link">
                red-team run
              </Link>{' '}
              lists scripted attempts to get around a plan and what the registry answered to each.
            </p>
          </section>

          <Panel
            title="Price data"
            description={`Binance spot hourly candles, no API key needed, fetched ${fmtDate(r.data_fetched_from)}. Each file covers T−35 days to T+95 days.`}
          >
            <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
              {r.data_sources.map((s) => (
                <li key={`${s.event_id}-${s.symbol}`}>
                  <a
                    href={s.source_url}
                    className="link mono text-[0.8125rem]"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {s.symbol}
                  </a>{' '}
                  <span className="text-ink-3">
                    for {s.event_id}, {s.candles.toLocaleString('en-US')} candles
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-3">
              The study is rebuilt offline and deterministically from these files with{' '}
              <span className="mono">pnpm --filter @vsp/replay build:results</span>; the method is
              also in <span className="mono">data/replay/METHOD.md</span>.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}
