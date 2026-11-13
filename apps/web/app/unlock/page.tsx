'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, ErrorNote, LoadingBlock, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { refusalText } from '@/lib/copy';
import { pct } from '@/lib/format';
import { useResource } from '@/lib/use-resource';

/** data/replay/case-arb-2024-03-16.json, served at GET /api/replay/case. Only the fields read. */
interface Source {
  label: string;
  url: string;
}
interface Flow {
  at: string;
  kind: 'release' | 'forward' | 'deposit';
  amount: string;
  from: { address: string; label: string };
  to: { address: string; label: string };
  tx: string;
  explorer: string;
}
type Verdict = { allowed: true } | { allowed: false; code: string };
interface Attempt {
  at_ms: number;
  amount: number;
  price_usd: number;
  verdict: Verdict;
  explorer?: string;
}
interface Model {
  gross_usd: number;
  impact_cost_usd: number;
  impact_bps: number;
  max_daily_participation: number;
  sale_count: number;
}
interface UnlockCase {
  case: {
    title: string;
    token: string;
    unlock_at: string;
    unlock: { amount: string; sources: Source[] };
    vesting: {
      beneficiary: string;
      contracts: number;
      released: string;
      detail: string;
      sources: Source[];
    };
    flows: Flow[];
    reporting: Source[];
    caveats: string[];
  };
  envelope: {
    allocation: number;
    per_sale: number;
    per_period: number;
    period_days: number;
    min_gap_hours: number;
    floor_usd: number;
    slippage_bps: number;
  };
  price: {
    source_url: string;
    window: { from: string; to: string };
    token_change: number;
    btc_change: number;
    series: { t: number; close: number }[];
  };
  observed: { deposited: number; attempts: Attempt[]; model: Model };
  sealed: {
    attempts: Attempt[];
    allowed_amount: number;
    model: Model;
    periods_to_sell_deposited: number;
  };
  model: { label: string };
}

const utc = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});
const at = (ms: number | string) => `${utc.format(new Date(ms))} UTC`;
const arb = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })} ARB`;
const usd = (n: number) => `$${n.toFixed(3)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const share = (f: number) => `${(f * 100).toFixed(1)}%`;
const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`;

const KIND_LABEL: Record<Flow['kind'], string> = {
  release: 'Released from vesting',
  forward: 'Forwarded',
  deposit: 'Deposited to an exchange address',
};

const pad = { l: 44, r: 12, t: 14, b: 26 };

/** ARB's hourly close with the unlock and each deposit marked; hover reads off time and price. */
function PriceChart({ data }: { data: UnlockCase }) {
  // The viewBox follows the real width, so labels stay 11px on a phone and on a desktop.
  const box = useRef<HTMLElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setW(Math.max(280, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W < 500 ? 200 : 220;
  const s = data.price.series;
  const [hover, setHover] = useState<number | null>(null);
  const { x, y, ticks } = useMemo(() => {
    const t0 = s[0]?.t ?? 0;
    const t1 = s[s.length - 1]?.t ?? 1;
    const lo = Math.min(...s.map((p) => p.close));
    const hi = Math.max(...s.map((p) => p.close));
    const min = Math.floor(lo * 10) / 10;
    const max = Math.ceil(hi * 10) / 10;
    return {
      x: (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r),
      y: (v: number) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b),
      ticks: [min, (min + max) / 2, max],
    };
  }, [s, W, H]);
  const path = s
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.close).toFixed(1)}`)
    .join('');
  const unlockMs = Date.parse(data.case.unlock_at);
  const deposits = data.case.flows.filter((f) => f.kind === 'deposit');
  const point = hover === null ? null : s[hover];
  const days = [
    Date.parse('2024-03-09'),
    Date.parse('2024-03-16'),
    Date.parse('2024-03-23'),
    Date.parse('2024-03-30'),
  ];
  return (
    <figure className="m-0" ref={box}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${data.case.token} hourly price on Binance, 9 to 31 March 2024, falling from about $2.10 to about $1.60, with the unlock on 16 March and four deposits between 22 and 28 March marked.`}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(ev) => {
          const r = ev.currentTarget.getBoundingClientRect();
          const px = ((ev.clientX - r.left) / r.width) * W;
          let best = 0;
          for (let i = 0; i < s.length; i++)
            if (Math.abs(x(s[i]?.t ?? 0) - px) < Math.abs(x(s[best]?.t ?? 0) - px)) best = i;
          setHover(best);
        }}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(v)}
              y2={y(v)}
              className="stroke-rule-2"
              strokeWidth={1}
            />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="fill-ink-3 text-[11px]">
              ${v.toFixed(2)}
            </text>
          </g>
        ))}
        {days.map((d) => (
          <text key={d} x={x(d)} y={H - 8} textAnchor="middle" className="fill-ink-3 text-[11px]">
            {utc
              .format(new Date(d))
              .replace(/,.*$/, '')
              .replace(/ \d\d:\d\d/, '')}
          </text>
        ))}
        <line
          x1={x(unlockMs)}
          x2={x(unlockMs)}
          y1={pad.t}
          y2={H - pad.b}
          className="stroke-ink-2"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
        <text x={x(unlockMs) + 4} y={pad.t + 10} className="fill-ink-2 text-[11px] font-semibold">
          Cliff unlock
        </text>
        <path
          d={path}
          fill="none"
          className="stroke-accent"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {deposits.map((d) => {
          const t = Math.floor(Date.parse(d.at) / 3_600_000) * 3_600_000;
          const p = s.find((q) => q.t === t);
          return p ? (
            <circle
              key={d.tx}
              cx={x(t)}
              cy={y(p.close)}
              r={5}
              className="fill-fail stroke-surface"
              strokeWidth={2}
            />
          ) : null;
        })}
        {point && (
          <g pointerEvents="none">
            <line
              x1={x(point.t)}
              x2={x(point.t)}
              y1={pad.t}
              y2={H - pad.b}
              className="stroke-ink-3"
              strokeWidth={1}
            />
            <circle
              cx={x(point.t)}
              cy={y(point.close)}
              r={4}
              className="fill-accent stroke-surface"
              strokeWidth={2}
            />
          </g>
        )}
      </svg>
      <figcaption className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
        <span>
          <span
            className="mr-1 inline-block size-2.5 rounded-full bg-fail align-middle"
            aria-hidden="true"
          />
          Deposit to the exchange address. Hourly closes, Binance {data.case.token}USDT,{' '}
          <a className="link" href={data.price.source_url} target="_blank" rel="noreferrer">
            source
          </a>
          .
        </span>
        <span aria-live="polite" className="num">
          {point
            ? `${at(point.t)} · ${usd(point.close)}`
            : 'Hover or drag across the chart to read prices'}
        </span>
      </figcaption>
    </figure>
  );
}

function VerdictBadge({ v }: { v: Verdict }) {
  return v.allowed ? (
    <Badge tone="pass" dot>
      Allowed
    </Badge>
  ) : (
    <Badge tone="fail" dot title={refusalText(v.code)}>
      Refused: <span className="mono">{v.code}</span>
    </Badge>
  );
}

export default function UnlockCasePage() {
  const res = useResource(() => api<UnlockCase>('/api/replay/case'), []);
  if (res.error) return <ErrorNote error={res.error} />;
  if (!res.data) return <LoadingBlock label="Loading the replay" />;
  const d = res.data;
  const e = d.envelope;
  const deposits = d.case.flows.filter((f) => f.kind === 'deposit');
  const allowed = d.sealed.attempts.filter((a) => a.verdict.allowed);
  const refusedSealed = d.sealed.attempts.filter((a) => !a.verdict.allowed);

  return (
    <div className="space-y-6">
      <PageHeader
        meta={
          <>
            <Badge tone="neutral">Real data</Badge>
            <Badge tone="wait">Costs are a model</Badge>
          </>
        }
        title={d.case.title}
        lead={
          <>
            Minutes after the cliff, one beneficiary released {arb(d.case.vesting.released)} from{' '}
            {d.case.vesting.contracts} Arbitrum vesting contracts, forwarded it to a fresh wallet,
            and over the next 12 days that wallet sent {arb(d.observed.deposited)} to an address
            tagged as a Binance deposit. Below: what the chain shows, and the same allocation under
            a sealed plan.
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <div className="min-w-0 space-y-6">
          <Panel
            title="What happened"
            description="Every transfer is on Arbitrum One; follow the links to check it."
          >
            <PriceChart data={d} />
            <p className="mt-3 text-sm">
              From {at(d.price.window.from)} to {at(d.price.window.to)}, {d.case.token} moved{' '}
              <span className="num font-semibold">{pct(d.price.token_change)}</span>; BTC moved{' '}
              <span className="num font-semibold">{pct(d.price.btc_change)}</span> over the same
              hours (Binance hourly closes).
            </p>
            <ol className="mt-4 space-y-3 border-t border-rule-2 pt-4">
              {d.case.flows.map((f, i) => {
                const repeat =
                  i > 0 && d.case.flows[i - 1]?.kind === 'deposit' && f.kind === 'deposit';
                return (
                  <li key={f.tx} className="text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-semibold">{KIND_LABEL[f.kind]}</span>
                      <span className="num text-ink-3">{at(f.at)}</span>
                    </div>
                    <p className="text-ink-2">
                      <span className="num font-semibold text-ink">{arb(f.amount)}</span> from{' '}
                      <span className="mono">{short(f.from.address)}</span>
                      {repeat ? '' : ` (${f.from.label})`} to{' '}
                      <span className="mono">{short(f.to.address)}</span>
                      {repeat ? ', the same exchange address' : ` (${f.to.label})`}.{' '}
                      <a className="link" href={f.explorer} target="_blank" rel="noreferrer">
                        Transaction
                      </a>
                    </p>
                  </li>
                );
              })}
            </ol>
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel
            title="The same allocation under a sealed plan"
            description="Our illustration: these public limits, enforced by the registry on every sale."
          >
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>
                Allocation: <span className="num">{arb(e.allocation)}</span> (what this beneficiary
                received at the cliff).
              </li>
              <li>
                At most <span className="num">{arb(e.per_period)}</span> every {e.period_days} days,
                and <span className="num">{arb(e.per_sale)}</span> in any one sale.
              </li>
              <li>
                At least {e.min_gap_hours} hour between sales, and never a guaranteed price under $
                {e.floor_usd.toFixed(2)}.
              </li>
            </ul>

            <h3 className="mt-5 mb-2 text-sm font-semibold">
              Each deposit, as a sale through the registry
            </h3>
            <div className="overflow-x-auto">
              <table className="table w-full min-w-[30rem] text-sm">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col" className="text-right">
                      Amount
                    </th>
                    <th scope="col">Registry</th>
                  </tr>
                </thead>
                <tbody>
                  {d.observed.attempts.map((a, i) => (
                    <tr key={deposits[i]?.tx ?? a.at_ms}>
                      <td className="num">{at(a.at_ms)}</td>
                      <td className="num text-right">{arb(a.amount)}</td>
                      <td>
                        <VerdictBadge v={a.verdict} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-ink-2">
              Each is more than{' '}
              {Math.floor(Math.min(...d.observed.attempts.map((a) => a.amount)) / e.per_sale)} times
              the per-sale cap. Selling what was deposited over those days would run into a{' '}
              {ordinal(d.sealed.periods_to_sell_deposited)} {e.period_days}-day period under these
              limits: more than {(d.sealed.periods_to_sell_deposited - 1) * e.period_days} days.
            </p>

            <h3 className="mt-5 mb-2 text-sm font-semibold">
              What the plan would have sold over the same days
            </h3>
            <p className="text-sm text-ink-2">
              {allowed.length} sales at random hours,{' '}
              <span className="num">{arb(d.sealed.allowed_amount)}</span> in all, each allowed. The
              next one would have passed the monthly cap, and the registry refuses it
              {refusedSealed[0] && !refusedSealed[0].verdict.allowed ? (
                <>
                  {' '}
                  (<span className="mono">{refusedSealed[0].verdict.code}</span>)
                </>
              ) : null}
              . Sale times and sizes here stand in for the enclave’s secret schedule.
            </p>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {[
                ['Deposits, if sold on their day', d.observed.model],
                ['The sealed plan’s sales', d.sealed.model],
              ].map(([label, m]) => {
                const model = m as Model;
                return (
                  <div key={label as string} className="rounded-lg border border-rule-2 p-3">
                    <p className="text-xs text-ink-3">{label as string}</p>
                    <p className="num mt-1 text-lg font-semibold">
                      {model.impact_bps.toFixed(0)} bps
                    </p>
                    <p className="text-xs text-ink-2">
                      modelled price impact; at most {share(model.max_daily_participation)} of a
                      day’s Binance volume
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-ink-3">{d.model.label}</p>
          </Panel>

          <Panel
            title="What holders could have checked, as it happened"
            description="On the live demo these are real checks your browser runs."
          >
            <ul className="list-disc space-y-1.5 pl-5 text-sm">
              <li>
                The allocation sat in a plan account with 0 keys, so no one could move it outside
                the plan.
              </li>
              <li>
                The plan’s commitment and its public limits were on-chain before the cliff, so the
                most that could reach the market each month was known in advance.
              </li>
              <li>
                Every sale left a receipt within minutes: the enclave’s signature, the 1Click quote
                it used, and yes/no answers that it followed the sealed plan.
              </li>
              <li>Any change or cancellation would have waited a public cooling-off.</li>
            </ul>
            <Link href="/verify" className="btn btn-secondary mt-3">
              See the checks on a live plan
            </Link>
          </Panel>
        </div>
      </div>

      <Panel
        title="What this does and does not show"
        description="Stated plainly, with every source."
      >
        <ul className="list-disc space-y-1.5 pl-5 text-sm">
          {d.case.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
          <li>{d.case.vesting.detail}</li>
        </ul>
        <h3 className="mt-4 mb-1 text-sm font-semibold">Sources</h3>
        <ul className="space-y-1 text-sm">
          {[...d.case.unlock.sources, ...d.case.vesting.sources, ...d.case.reporting].map((s) => (
            <li key={s.url}>
              <a className="link" href={s.url} target="_blank" rel="noreferrer">
                {s.label}
              </a>
            </li>
          ))}
          <li>
            <a className="link" href={d.price.source_url} target="_blank" rel="noreferrer">
              Binance hourly klines, {d.case.token}USDT (BTCUSDT from the same endpoint)
            </a>
          </li>
        </ul>
      </Panel>
    </div>
  );
}
