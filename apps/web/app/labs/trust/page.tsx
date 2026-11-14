'use client';

import { SimulatedQuote, sealTo, verifySimulatedQuote } from '@glidepath/core';
import {
  checkMandateEnvelope,
  mandateCommitment,
  mandateProblems,
  newTrustSalt,
  parseMandate,
  sealedMandateJson,
  type TrustEnclaveEntry,
  type TrustEnvelope,
} from '@glidepath/trust';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useMemo, useState } from 'react';
import {
  Badge,
  CheckList,
  EmptyState,
  ErrorNote,
  Field,
  Hash,
  LoadingBlock,
  PageHeader,
  Panel,
  SimBadge,
} from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { nearChainTimeMs, nearView } from '@/lib/chain';
import {
  type AvailableTrustMeta,
  createTrust,
  saveTrustKey,
  trustList,
  trustMeta,
} from '@/lib/trust';
import { useResource } from '@/lib/use-resource';

const DAY_MS = 86_400_000;
const SIMULATED =
  'Runs on a local NEAR chain with test tokens priced on a simulated market; the enclave and 1Click are simulated';

/** A diversified official's starting point: an index, bonds and gold, plus two regulated sectors. */
const DEFAULTS: Record<string, { deposit: string; target: string; excluded: boolean }> = {
  IDX: { deposit: '400', target: '60', excluded: false },
  BOND: { deposit: '20', target: '30', excluded: false },
  GOLD: { deposit: '0', target: '10', excluded: false },
  NRG: { deposit: '40', target: '0', excluded: true },
  DEFI: { deposit: '100', target: '0', excluded: true },
};

interface Row {
  deposit: string;
  target: string;
  excluded: boolean;
}

export default function TrustLabs() {
  const meta = useResource(trustMeta, []);
  const list = useResource(trustList, [], 15_000);
  const m = meta.data;
  return (
    <div>
      <PageHeader
        meta={
          <>
            <Link href="/labs" className="link text-sm">
              Labs
            </Link>
            <Badge>Prototype</Badge>
          </>
        }
        title="Blind trust"
        lead="An official puts assets into a trust run by a mandate they cannot read back once it is sealed. An enclave rebalances inside the mandate. This page shows the public the rules the contract enforces, yes-or-no statements about every trade and a receipt for each, and shows the official the total value."
      />
      <p className="-mt-3 mb-7 max-w-3xl rounded-lg border border-wait/40 bg-wait-soft px-4 py-2.5 text-sm text-wait">
        This page shows only the rules, yes-or-no statements and the total value, but it is not
        private: the trust account’s balances, and each trade’s assets and size in its quote and
        transfer, are public on NEAR, and an official who remembers the mandate could work out what
        it trades. Hiding them needs confidential Intents, which run on mainnet only.
      </p>
      {meta.error ? (
        <ErrorNote error={meta.error} retry={meta.reload} />
      ) : !m ? (
        <LoadingBlock />
      ) : !m.available ? (
        <EmptyState title="The blind trust is not deployed on this server">
          It runs with <code className="mono">pnpm dev:local</code>, which deploys its contract on
          the local chain.
        </EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <CreateTrust meta={m} onCreated={list.reload} />
          <Panel title="Trusts" level={2} className="self-start">
            {list.error ? (
              <ErrorNote error={list.error} retry={list.reload} />
            ) : !list.data ? (
              <LoadingBlock />
            ) : list.data.length === 0 ? (
              <p className="text-sm text-ink-2">None yet. The first one you create shows here.</p>
            ) : (
              <ul className="divide-y divide-rule-2">
                {list.data.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                    <Link href={`/labs/trust/${t.id}`} className="link min-w-0 truncate text-sm">
                      #{t.id} {t.label || 'Blind trust'}
                    </Link>
                    <Badge tone={t.status === 'active' ? 'pass' : 'neutral'}>
                      {t.status === 'awaiting_ack'
                        ? 'Opening'
                        : t.status === 'active'
                          ? 'Active'
                          : 'Ended'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

/** The enclave's attestation, checked here against the trust contract's allowlist before sealing. */
function useAttested(meta: AvailableTrustMeta) {
  return useResource(async () => {
    const [onChain, now] = await Promise.all([
      nearView<TrustEnclaveEntry[]>(meta.contract, 'get_enclaves', { limit: 50 }),
      nearChainTimeMs(),
    ]);
    const entry = onChain.find((x) => x.public_key === meta.enclave.signingKey);
    const checks = [
      { label: 'The enclave key is on the trust contract’s allowlist', ok: !!entry },
      {
        label: 'Its public delay is over and it is not revoked',
        ok: !!entry && entry.revoked_at_ms === null && entry.active_from_ms <= now,
      },
      {
        label: 'The key you seal to belongs to the key that signs',
        ok: meta.enclave.sameAsAttested,
      },
    ];
    const quote = SimulatedQuote.safeParse(meta.enclave.quote);
    if (entry && quote.success)
      checks.push(
        ...verifySimulatedQuote(quote.data, {
          signingKey: entry.public_key,
          encryptionKeyHex: meta.enclave.encryptionKeyHex,
          measurements: entry.measurements,
          quoteHash: entry.quote_hash,
        }).checks,
      );
    else checks.push({ label: 'The attestation quote is readable', ok: false });
    return { ok: checks.every((c) => c.ok), checks };
  }, [meta.contract, meta.enclave.signingKey]);
}

function CreateTrust({ meta, onCreated }: { meta: AvailableTrustMeta; onCreated: () => void }) {
  const router = useRouter();
  const attested = useAttested(meta);
  const [label, setLabel] = useState('Blind trust');
  const [rows, setRows] = useState<Record<string, Row>>(() =>
    Object.fromEntries(
      meta.tokens.map((t) => [
        t.asset,
        DEFAULTS[t.symbol] ?? { deposit: '0', target: '0', excluded: false },
      ]),
    ),
  );
  const sectors = [...new Set(meta.tokens.map((t) => t.sector))];
  const [excludedSectors, setExcludedSectors] = useState<string[]>(['energy', 'defi']);
  const [band, setBand] = useState('5');
  const [maxTrade, setMaxTrade] = useState('2000');
  const [minTrade, setMinTrade] = useState('10');
  const [cap, setCap] = useState('5000');
  const [gapMinutes, setGapMinutes] = useState('1');
  const [months, setMonths] = useState('6');
  const minCoolingMinutes = Math.ceil(meta.minCoolingOffMs / 60_000);
  const [coolingMinutes, setCoolingMinutes] = useState(String(minCoolingMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: number; key: string } | null>(null);
  const set = (asset: string, patch: Partial<Row>) =>
    setRows((r) => ({ ...r, [asset]: { ...(r[asset] as Row), ...patch } }));

  // The mandate and envelope as they would be sealed and published, or the reasons they cannot be.
  const draft = useMemo(() => {
    try {
      const targets = meta.tokens
        .map((t) => ({ asset: t.asset, pct: Number(rows[t.asset]?.target || 0) }))
        .filter((t) => t.pct > 0);
      if (targets.some((t) => !Number.isInteger(t.pct * 100)))
        return { problems: ['Use target weights with at most two decimals'] };
      const envelope: TrustEnvelope = {
        excluded_assets: meta.tokens.filter((t) => rows[t.asset]?.excluded).map((t) => t.asset),
        period_ms: DAY_MS,
        max_turnover_usd_e6: BigInt(Math.round(Number(cap) * 1e6)).toString(),
        min_gap_ms: Math.round(Number(gapMinutes) * 60_000),
      };
      const problems: string[] = [];
      if (!(Number(cap) > 0)) problems.push('The turnover cap must be above zero');
      // The contract's and this server's floors; the band and the smallest trade are sealed, so
      // only this form checks them before sealing.
      if (!(Number(gapMinutes) >= 1)) problems.push('The minimum gap is at least 1 minute');
      if (!(Number(band) >= 1)) problems.push('The rebalance band is at least 1%');
      if (!(Number(minTrade) >= 10))
        problems.push('The smallest trade is at least $10 (the contract refuses smaller ones)');
      if (!(Number(coolingMinutes) >= minCoolingMinutes))
        problems.push(`The cooling-off is at least ${minCoolingMinutes} minutes here`);
      const deposits = meta.tokens
        .map((t) => ({ asset: t.asset, tokens: rows[t.asset]?.deposit.trim() || '0' }))
        .filter((d) => d.tokens !== '0');
      if (!deposits.length) problems.push('Move at least one asset into the trust');
      if (deposits.some((d) => !/^\d{1,7}$/.test(d.tokens)))
        problems.push('Deposits are whole tokens, up to a million of each');
      return {
        problems,
        envelope,
        deposits,
        mandate: (end: string) =>
          parseMandate({
            version: 1,
            universe: meta.tokens.map((t) => ({ asset: t.asset, sector: t.sector })),
            excluded_sectors: excludedSectors,
            targets: targets.map((t) => ({ asset: t.asset, weight_bps: Math.round(t.pct * 100) })),
            band_bps: Math.round(Number(band) * 100),
            max_trade_usd: maxTrade.trim(),
            min_trade_usd: minTrade.trim(),
            beneficiary: meta.official,
            end,
          }),
      };
    } catch (e) {
      return { problems: [errorMessage(e)] };
    }
  }, [
    meta,
    rows,
    excludedSectors,
    band,
    maxTrade,
    minTrade,
    cap,
    gapMinutes,
    coolingMinutes,
    minCoolingMinutes,
  ]);

  // The rules the enclave will check, run here first so a mistake shows before anything is sealed.
  const checks = useMemo(() => {
    if (!('mandate' in draft) || !draft.mandate || !draft.envelope) return draft.problems;
    try {
      const m = draft.mandate('2030-01-01T00:00:00.000Z');
      return [
        ...draft.problems,
        ...mandateProblems(m),
        ...checkMandateEnvelope(m, draft.envelope)
          .filter((c) => !c.ok)
          .map((c) => `Outside the public envelope: ${c.rule}`),
      ];
    } catch {
      return [...draft.problems, 'Check the mandate: weights, band and trade sizes'];
    }
  }, [draft]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!('mandate' in draft) || !draft.mandate || !draft.envelope || !draft.deposits) return;
    setBusy(true);
    setError(null);
    try {
      const now = await nearChainTimeMs();
      const endMs = now + Math.round(Number(months) * 30 * DAY_MS);
      const mandate = draft.mandate(new Date(endMs).toISOString());
      const salt = newTrustSalt();
      const out = await createTrust({
        label: label.trim(),
        commitment: mandateCommitment(mandate, salt),
        // Sealed here: the server only ever holds ciphertext for the enclave.
        sealed_box: sealTo(meta.enclave.encryptionKeyHex, sealedMandateJson(mandate, salt)),
        envelope: draft.envelope,
        cooling_off_ms: Math.round(Number(coolingMinutes) * 60_000),
        end_ms: endMs,
        deposits: draft.deposits,
      });
      saveTrustKey(out.trustId, out.ownerKey);
      setCreated({ id: out.trustId, key: out.ownerKey });
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (created)
    return (
      <Panel title={`Trust #${created.id} is being set up`}>
        <p className="text-sm text-ink-2">
          The mandate left this browser sealed to the enclave. The official’s assets are moving into
          the trust account, and the enclave is opening the mandate to check it against the public
          rules. The owner key below lets the official cancel the trust, publicly and after the
          cooling-off. It is kept in this browser; copy it if you want it elsewhere.
        </p>
        <div className="mt-3">
          <Hash value={created.key} label="owner key" full />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => router.push(`/labs/trust/${created.id}`)}
          >
            Open the trust
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setCreated(null)}>
            Create another
          </button>
        </div>
      </Panel>
    );

  const ready = attested.data?.ok === true && checks.length === 0 && !busy;
  return (
    <form onSubmit={submit} className="space-y-6">
      <Panel
        title="Create a trust"
        description={`Everything here plays the official (${meta.official}), who is also the beneficiary at the end.`}
      >
        <div className="space-y-5">
          <Field label="Name" htmlFor="trust-label" hint="Shown publicly with the trust.">
            <input
              id="trust-label"
              className="input"
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <div>
            <p className="label">Assets</p>
            <p className="hint mb-2">
              What the official moves in (whole test tokens), the sealed target weight of each, and
              which ones the public envelope excludes.
            </p>
            <div className="hidden grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_7rem] gap-3 px-3 pb-1 text-xs text-ink-3 sm:grid">
              <span>Asset</span>
              <span>Deposit</span>
              <span>Target %</span>
              <span>Public exclusion</span>
            </div>
            <ul className="space-y-2">
              {meta.tokens.map((t) => {
                const row = rows[t.asset] as Row;
                return (
                  <li
                    key={t.asset}
                    className="well grid grid-cols-2 items-center gap-3 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_7rem]"
                  >
                    <div className="col-span-2 min-w-0 sm:col-span-1">
                      <span className="font-semibold">{t.symbol}</span>{' '}
                      <span className="text-sm text-ink-2">{t.name}</span>
                      <span className="ml-2 text-xs text-ink-3">{t.sector}</span>
                    </div>
                    <label className="text-xs text-ink-3 sm:text-sm">
                      <span className="sm:sr-only">Deposit</span>
                      <input
                        className="input num mt-1 sm:mt-0"
                        inputMode="numeric"
                        aria-label={`${t.symbol} deposit`}
                        value={row.deposit}
                        onChange={(e) => set(t.asset, { deposit: e.target.value })}
                      />
                    </label>
                    <label className="text-xs text-ink-3 sm:text-sm">
                      <span className="sm:sr-only">Target %</span>
                      <input
                        className="input num mt-1 sm:mt-0"
                        inputMode="decimal"
                        aria-label={`${t.symbol} target weight in percent`}
                        value={row.target}
                        onChange={(e) => set(t.asset, { target: e.target.value })}
                      />
                    </label>
                    <label className="col-span-2 flex items-center gap-2 text-sm sm:col-span-1">
                      <input
                        type="checkbox"
                        className="accent-[var(--accent)]"
                        checked={row.excluded}
                        onChange={(e) => set(t.asset, { excluded: e.target.checked })}
                      />
                      Excluded
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
          <fieldset>
            <legend className="label">Sectors the mandate never buys (sealed)</legend>
            <div className="flex flex-wrap gap-2">
              {sectors.map((s) => (
                <label
                  key={s}
                  className="well flex cursor-pointer items-center gap-2 px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={excludedSectors.includes(s)}
                    onChange={(e) =>
                      setExcludedSectors((x) =>
                        e.target.checked ? [...x, s] : x.filter((y) => y !== s),
                      )
                    }
                  />
                  {s}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Rebalance band (%)" htmlFor="band" hint="Trade only past this drift.">
              <input
                id="band"
                className="input num"
                inputMode="decimal"
                value={band}
                onChange={(e) => setBand(e.target.value)}
              />
            </Field>
            <Field label="Largest trade (USD)" htmlFor="max-trade" hint="Sealed.">
              <input
                id="max-trade"
                className="input num"
                inputMode="decimal"
                value={maxTrade}
                onChange={(e) => setMaxTrade(e.target.value)}
              />
            </Field>
            <Field label="Smallest trade (USD)" htmlFor="min-trade" hint="Sealed.">
              <input
                id="min-trade"
                className="input num"
                inputMode="decimal"
                value={minTrade}
                onChange={(e) => setMinTrade(e.target.value)}
              />
            </Field>
            <Field
              label="Turnover cap per day (USD)"
              htmlFor="cap"
              hint="Public, enforced on-chain."
            >
              <input
                id="cap"
                className="input num"
                inputMode="decimal"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
              />
            </Field>
            <Field label="Minimum gap (minutes)" htmlFor="gap" hint="Public, enforced on-chain.">
              <input
                id="gap"
                className="input num"
                inputMode="decimal"
                value={gapMinutes}
                onChange={(e) => setGapMinutes(e.target.value)}
              />
            </Field>
            <Field
              label="Term (months)"
              htmlFor="months"
              hint="Then everything goes to the beneficiary."
            >
              <input
                id="months"
                className="input num"
                inputMode="numeric"
                value={months}
                onChange={(e) => setMonths(e.target.value)}
              />
            </Field>
            <Field
              label="Cooling-off (minutes)"
              htmlFor="cooling"
              hint="How long a public change or cancel waits."
            >
              <input
                id="cooling"
                className="input num"
                inputMode="numeric"
                value={coolingMinutes}
                onChange={(e) => setCoolingMinutes(e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel
        title="Seal"
        description="Your browser checks the enclave’s attestation, then encrypts the mandate to its key. Only a salted hash of the mandate goes on-chain."
        actions={<SimBadge title={SIMULATED}>Simulated enclave</SimBadge>}
      >
        {attested.error ? (
          <ErrorNote error={attested.error} retry={attested.reload} />
        ) : !attested.data ? (
          <LoadingBlock label="Checking the enclave" />
        ) : (
          <CheckList
            checks={attested.data.checks.map((c) => ({
              label: c.label,
              state: c.ok ? 'pass' : 'fail',
            }))}
          />
        )}
        {checks.length > 0 && (
          <ul className="mt-4 space-y-1">
            {checks.map((p) => (
              <li key={p} className="text-sm text-fail">
                {p}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <div className="mt-4">
            <ErrorNote error={error} />
          </div>
        )}
        <div className="mt-4">
          <button type="submit" className="btn btn-primary" disabled={!ready}>
            {busy ? 'Sealing and creating…' : 'Seal and create the trust'}
          </button>
        </div>
      </Panel>
    </form>
  );
}
