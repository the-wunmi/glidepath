'use client';

import { formatAmount } from '@vsp/core';
import {
  ATTESTATION_LABELS,
  type ChainTrustReceipt,
  type TradeAttestation,
  type TradeRequest,
  type TrustReceiptVerification,
  verifyTrustReceipt,
} from '@vsp/trust';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  Badge,
  CheckList,
  CheckMark,
  EmptyState,
  ErrorNote,
  Facts,
  Hash,
  LoadingBlock,
  PageHeader,
  Panel,
  ProofDetails,
  SimBadge,
  TabPanel,
  Tabs,
  useHashTab,
} from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { duration, fmtDate, fmtDateTime, periodWords } from '@/lib/format';
import {
  type AvailableTrustMeta,
  cancelTrust,
  loadTrustKey,
  readTrust,
  type TrustOnChain,
  trustMeta,
  trustSummary,
} from '@/lib/trust';
import { useResource } from '@/lib/use-resource';

const TABS = ['overview', 'receipts', 'proof'] as const;

const SIMULATED_PRICES =
  'Demo tokens priced on the simulated market of this local chain; real trusts would use market prices';
const SIMULATED_ENCLAVE =
  'The enclave is simulated in-process here; its attestation is a simulated TDX quote';

export default function TrustPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const meta = useResource(trustMeta, []);
  const m = meta.data?.available ? meta.data : null;
  const chain = useResource(m ? () => readTrust(m.contract, id) : null, [m?.contract, id], 10_000);
  const summary = useResource(() => trustSummary(id), [id], 15_000);
  const [tab, setTab] = useHashTab(TABS);
  const d = chain.data;
  const trades = d?.receipts.filter((r) => r.kind === 'trade') ?? [];

  return (
    <div>
      <PageHeader
        meta={
          <>
            <Link href="/labs/trust" className="link text-sm">
              Blind trust
            </Link>
            <Badge>Prototype</Badge>
            {d && <StatusBadge status={d.trust.status} />}
          </>
        }
        title={summary.data?.label || `Trust #${id}`}
        lead="The mandate is sealed: neither the official nor the public can read it. What anyone can check is below, read from the chain by this browser. The trust account’s balances, and each trade’s assets and size in its quote and transfer, are public on NEAR, and an official who remembers the mandate could work out what it trades. Hiding them needs confidential Intents, which run on mainnet only."
      />
      {meta.error || chain.error ? (
        <ErrorNote
          error={(meta.error ?? chain.error) as Error}
          retry={() => void (meta.error ? meta.reload() : chain.reload())}
        />
      ) : meta.data && !meta.data.available ? (
        <EmptyState title="The blind trust is not deployed on this server" />
      ) : !d || !m ? (
        <LoadingBlock />
      ) : (
        <>
          <Tabs
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'receipts', label: 'Receipts', note: trades.length },
              { id: 'proof', label: 'Proof' },
            ]}
            current={tab}
            onChange={setTab}
            label="Trust sections"
            idBase="trust"
          />
          <TabPanel idBase="trust" id="overview" current={tab}>
            <Overview id={id} d={d} meta={m} summary={summary.data} />
          </TabPanel>
          <TabPanel idBase="trust" id="receipts" current={tab}>
            <Receipts d={d} meta={m} receipts={trades} />
          </TabPanel>
          <TabPanel idBase="trust" id="proof" current={tab}>
            <Proof d={d} meta={m} />
          </TabPanel>
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: TrustOnChain['trust']['status'] }) {
  if (status === 'active')
    return (
      <Badge tone="pass" dot>
        Active
      </Badge>
    );
  if (status === 'awaiting_ack')
    return (
      <Badge tone="wait" dot>
        Opening
      </Badge>
    );
  return <Badge>Ended</Badge>;
}

/** USD × 10^6 to whole cents, rounded down: "$16,099.71". */
const dollars = (e6: string) => {
  const [whole = '0', frac = ''] = formatAmount(BigInt(e6), 6, 2).split('.');
  return `$${whole}.${frac.padEnd(2, '0')}`;
};

const symbolOf = (meta: AvailableTrustMeta, asset: string) =>
  meta.tokens.find((t) => t.asset === asset)?.symbol ?? asset.replace(/^nep141:/, '');

/** The statements every trade carried this period, as yes or no; never what was traded. */
function periodStatements(d: TrustOnChain, receipts: ChainTrustReceipt[]) {
  const period = Math.floor((d.chainNow - d.trust.start_ms) / d.trust.envelope.period_ms);
  const now = receipts.filter((r) => r.period_index === period && r.status !== 'failed');
  const said = (key: keyof TradeAttestation) =>
    now.every((r) => {
      try {
        return (JSON.parse(r.request_json ?? '') as TradeRequest).attestation[key] === true;
      } catch {
        return false;
      }
    });
  return { count: now.length, said };
}

function Overview({
  id,
  d,
  meta,
  summary,
}: {
  id: number;
  d: TrustOnChain;
  meta: AvailableTrustMeta;
  summary: { totalValueUsdE6: string; valuedAtMs: number } | null;
}) {
  const t = d.trust;
  const trades = d.receipts.filter((r) => r.kind === 'trade');
  const statements = periodStatements(d, trades);
  const change = t.pending_change;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel
        title="What the official sees"
        actions={<SimBadge title={SIMULATED_PRICES}>Simulated prices</SimBadge>}
      >
        <p className="text-sm text-ink-2">Total value</p>
        <p className="num mt-1 text-3xl font-semibold">
          {summary ? dollars(summary.totalValueUsdE6) : '…'}
        </p>
        <p className="mt-2 text-sm text-ink-2">
          This page does not show what it holds or trades. The official chose the mandate once and
          cannot read it back.
        </p>
      </Panel>

      <Panel title="Attested this period">
        <CheckList
          checks={[
            {
              label: 'No trades into excluded assets',
              state: statements.said('not_excluded') ? 'pass' : 'fail',
              detail: 'Signed by the enclave on every trade and checked by the contract.',
            },
            {
              label: 'Turnover within the public cap',
              state: statements.said('within_turnover') ? 'pass' : 'fail',
              detail: 'Measured on 1Click’s signed USD values and checked by the contract.',
            },
            {
              label: 'Every trade within the sealed mandate',
              state: statements.said('within_mandate') ? 'pass' : 'fail',
              detail: 'The enclave’s signed word; only it can read the mandate.',
            },
            {
              label: 'No discretionary trades by the official',
              state: d.accountKeys === 0 ? 'pass' : 'fail',
              detail:
                'The trust account has no keys, and the contract gives the official no way to move or trade.',
            },
          ]}
        />
        <p className="mt-3 text-xs text-ink-3">
          {statements.count === 0
            ? 'No trades so far this period.'
            : `${statements.count} trade${statements.count === 1 ? '' : 's'} this period; each has a receipt.`}
        </p>
      </Panel>

      <Panel title="Public rules" description="Enforced by the contract on every trade.">
        <Facts
          items={[
            [
              'Never buys',
              t.envelope.excluded_assets.length
                ? t.envelope.excluded_assets.map((a) => symbolOf(meta, a)).join(', ')
                : 'No exclusions',
            ],
            [
              'Turnover cap',
              `${dollars(t.envelope.max_turnover_usd_e6)} per ${periodWords(t.envelope.period_ms).replace(/^1 /, '')}`,
            ],
            ['Minimum gap', t.envelope.min_gap_ms ? duration(t.envelope.min_gap_ms) : 'None'],
            ['Proceeds and refunds', 'Only to the trust account'],
            ['Changes and cancel', `Public, after ${duration(t.cooling_off_ms)} of cooling-off`],
            ['Term ends', fmtDate(t.end_ms)],
            ['Then', `Everything goes to ${t.beneficiary}`],
          ]}
        />
        {change && (
          <p className="mt-4 rounded-lg border border-wait/40 bg-wait-soft px-4 py-2.5 text-sm text-wait">
            {change.kind === 'cancel' ? 'A cancel' : 'A change to these rules'} was requested on{' '}
            {fmtDateTime(change.requested_at_ms)} and takes effect on{' '}
            {fmtDateTime(change.effective_at_ms)}.
          </p>
        )}
      </Panel>

      <OwnerPanel id={id} d={d} />
    </div>
  );
}

function OwnerPanel({ id, d }: { id: number; d: TrustOnChain }) {
  const [key] = useState(() => (typeof window === 'undefined' ? null : loadTrustKey(id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const t = d.trust;
  const canCancel = !!key && t.status !== 'ended' && !t.pending_change;
  return (
    <Panel title="What the official can do">
      <p className="text-sm text-ink-2">
        Cancel, or propose new public rules on the contract. Both are public at once and wait out
        the cooling-off; nothing the official does moves or trades an asset. At the end, or after a
        cancel, the contract sends everything to the beneficiary.
      </p>
      {canCancel && !done && (
        <button
          type="button"
          className="btn btn-secondary mt-4"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await cancelTrust(id, key);
              setDone(true);
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Cancelling…' : 'Cancel the trust'}
        </button>
      )}
      {done && (
        <p className="mt-4 text-sm text-ink-2">
          Cancel requested. It shows under Public rules once the chain has it.
        </p>
      )}
      {error && (
        <div className="mt-4">
          <ErrorNote error={error} />
        </div>
      )}
    </Panel>
  );
}

type Result = TrustReceiptVerification | 'running' | { error: string };

function Receipts({
  d,
  meta,
  receipts,
}: {
  d: TrustOnChain;
  meta: AvailableTrustMeta;
  receipts: ChainTrustReceipt[];
}) {
  const [results, setResults] = useState<Record<number, Result>>({});
  const verify = (r: ChainTrustReceipt) => {
    setResults((x) => ({ ...x, [r.seq]: 'running' }));
    try {
      // The served quote is checked against the key's on-chain entry, never taken on trust.
      const attestation =
        meta.enclave.signingKey === r.enclave_key
          ? { quote: meta.enclave.quote, encryptionKeyHex: meta.enclave.encryptionKeyHex }
          : null;
      const out = verifyTrustReceipt(r, d.trust, d.enclaves, attestation, d.quoteSigners);
      setResults((x) => ({ ...x, [r.seq]: out }));
    } catch (e) {
      setResults((x) => ({ ...x, [r.seq]: { error: errorMessage(e) } }));
    }
  };
  const done = receipts.filter((r) => {
    const v = results[r.seq];
    return v && v !== 'running' && !('error' in v) && v.ok;
  }).length;
  return (
    <Panel
      title="Receipts"
      description="One per trade, written by the contract. Checked here, in your browser, against the chain."
      actions={
        receipts.length > 0 ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              for (const r of receipts) verify(r);
            }}
          >
            Verify all
          </button>
        ) : undefined
      }
    >
      {receipts.length === 0 ? (
        <p className="text-sm text-ink-2">
          No trades yet. The enclave trades only when a holding drifts past the mandate’s band.
        </p>
      ) : (
        <>
          {Object.keys(results).length > 0 && (
            <p className="mb-3 text-sm text-ink-2">
              {done} of {receipts.length} verified.
            </p>
          )}
          <ul className="space-y-3">
            {receipts.map((r) => (
              <ReceiptRow key={r.seq} r={r} result={results[r.seq]} onVerify={() => verify(r)} />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function ReceiptRow({
  r,
  result,
  onVerify,
}: {
  r: ChainTrustReceipt;
  result: Result | undefined;
  onVerify: () => void;
}) {
  let attestation: TradeAttestation | null = null;
  try {
    attestation = (JSON.parse(r.request_json ?? '') as TradeRequest).attestation;
  } catch {
    attestation = null;
  }
  const verdict = result && result !== 'running' && !('error' in result) ? result : null;
  return (
    <li className="well px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Trade #{r.seq}</span>
          <span className="text-sm text-ink-2">{fmtDateTime(r.created_at_ms)}</span>
          <Badge tone={r.status === 'done' ? 'pass' : r.status === 'failed' ? 'fail' : 'wait'}>
            {r.status === 'done'
              ? 'Sent to 1Click'
              : r.status === 'failed'
                ? 'Rolled back'
                : 'Pending'}
          </Badge>
        </div>
        {verdict ? (
          <Badge tone={verdict.ok ? 'pass' : 'fail'} dot>
            {verdict.ok ? (verdict.complete ? 'Verified' : 'Verified so far') : 'Check failed'}
          </Badge>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onVerify}>
            {result === 'running' ? 'Verifying…' : 'Verify'}
          </button>
        )}
      </div>
      {attestation && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {(Object.keys(ATTESTATION_LABELS) as (keyof TradeAttestation)[]).map((k) => (
            <li key={k} className="flex items-center gap-1.5 text-sm">
              <CheckMark state={attestation[k] ? 'pass' : 'fail'} />
              {ATTESTATION_LABELS[k]}
            </li>
          ))}
        </ul>
      )}
      {result && typeof result === 'object' && 'error' in result && (
        <div className="mt-2">
          <ErrorNote error={result.error} />
        </div>
      )}
      {verdict && (
        <div className="mt-3">
          <ProofDetails summary="What was checked">
            <CheckList
              checks={verdict.checks.map((c) => ({
                label: c.label,
                state: c.status,
                extra:
                  c.id === 'attestation' && verdict.simulatedAttestation ? (
                    <SimBadge title={SIMULATED_ENCLAVE} />
                  ) : undefined,
              }))}
            />
          </ProofDetails>
        </div>
      )}
    </li>
  );
}

function Proof({ d, meta }: { d: TrustOnChain; meta: AvailableTrustMeta }) {
  const t = d.trust;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Commitment and account">
        <Facts
          items={[
            ['Mandate commitment', <Hash key="c" value={t.commitment} label="commitment" />],
            ['Trust account', <Hash key="a" value={t.trust_account} label="trust account" full />],
            [
              'Keys on the account',
              <span key="k" className="flex items-center gap-2">
                <CheckMark state={d.accountKeys === 0 ? 'pass' : 'fail'} />
                {d.accountKeys === 0
                  ? 'None: only the contract can move its assets'
                  : d.accountKeys}
              </span>,
            ],
            ['Contract', <Hash key="ct" value={meta.contract} label="contract" full />],
            ['Created', fmtDateTime(t.created_at_ms)],
          ]}
        />
        <p className="mt-4 text-sm text-ink-2">
          The commitment is sha256 of the mandate and a secret salt. It proves the mandate never
          changed; the mandate itself stays sealed.
        </p>
      </Panel>
      <Panel
        title="Enclave"
        actions={<SimBadge title={SIMULATED_ENCLAVE}>Simulated enclave</SimBadge>}
      >
        <Facts
          items={[
            [
              'Accepted by',
              t.acked_by ? <Hash key="e" value={t.acked_by} label="enclave key" /> : 'Not yet',
            ],
            [
              'On the allowlist',
              `${d.enclaves.filter((x) => x.revoked_at_ms === null).length} active key${
                d.enclaves.length === 1 ? '' : 's'
              }`,
            ],
            [
              '1Click quote key',
              d.quoteSigners.at(-1) ? (
                <Hash key="q" value={d.quoteSigners.at(-1)?.public_key ?? ''} label="quote key" />
              ) : (
                'None'
              ),
            ],
          ]}
        />
        <p className="mt-4 text-sm text-ink-2">
          Each trade’s receipt holds the enclave’s signed request and 1Click’s signed quote, so
          anyone can repeat the checks under Receipts from chain data alone.
        </p>
      </Panel>
    </div>
  );
}
