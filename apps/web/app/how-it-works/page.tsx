'use client';

import Link from 'next/link';
import { OUTLAYER_LABEL, OutlayerEvidence } from '@/components/enclave-evidence';
import { useMeta } from '@/components/meta';
import { ModeBadge } from '@/components/status';
import {
  Badge,
  CheckList,
  ErrorNote,
  Hash,
  LoadingBlock,
  PageHeader,
  Panel,
  SimBadge,
} from '@/components/ui';
import { attestationFailure, isOutlayerQuote, useAttestation } from '@/lib/attestation';
import { accessKeys } from '@/lib/chain';
import { simReason } from '@/lib/env';
import { duration, fmtDateTime } from '@/lib/format';
import type { Meta } from '@/lib/types';
import { useResource } from '@/lib/use-resource';

const PARTS = [
  {
    name: 'Plan registry',
    where: 'A NEAR account running the registry code',
    does: 'Stores each plan’s commitment, its public envelope, the cooling-off state, the enclave allowlist and every receipt.',
    guarantees:
      'Refuses any sale outside the public envelope, from a key not on the allowlist, or during a pending change’s cooling-off. Its deploy key was deleted and it has no upgrade method.',
  },
  {
    name: 'Plan account',
    where: 'One NEAR sub-account per plan, with no keys',
    does: 'Holds the plan’s NEP-141 tokens.',
    guarantees:
      'With no key, nobody can sign for it. Its code obeys only the registry, so the founder cannot move tokens out or add a key. Anyone can check this on-chain.',
  },
  {
    name: 'Chain Signatures address',
    where: 'An EVM address derived from the registry and the path plan/<id>',
    does: 'Holds the plan’s ERC-20 tokens on their own chain. Nothing is wrapped or bridged.',
    guarantees:
      'Only the registry can ask the MPC network to sign for it, and it signs only the EIP-1559 transfer it built itself, never an opaque hash. One signature at a time, with nonces.',
  },
  {
    name: 'Executor enclave',
    where: 'A TEE worker (OutLayer, Intel TDX)',
    does: 'Holds the sealed plan, picks random sale times, checks several price sources and signs each sale request.',
    guarantees:
      'Opens a plan only if it matches the on-chain commitment and sits inside the public envelope. Its receipts answer yes/no compliance checks and never publish the plan’s numbers.',
  },
  {
    name: 'Settlement',
    where: 'NEAR Intents through the 1Click API',
    does: 'Swaps each sale into USDC for the beneficiary.',
    guarantees:
      'Each sale carries a 1Click-signed quote that the registry checks on-chain. It binds the deposit address, amount, minimum output (from the floor), recipient and proceeds asset, so even a compromised enclave cannot redirect proceeds. A swap with no final answer is in doubt and keeps being checked; it is never assumed to have failed.',
  },
  {
    name: 'Your browser',
    where: 'This app',
    does: 'Seals the plan, computes the commitment and verifies receipts.',
    guarantees:
      'The plan leaves the browser only encrypted to an enclave key whose attestation it checked first. The server never sees the plan. The verifier reads the chain directly.',
  },
];

const SALE_PATH = [
  'The enclave wakes at a random time and checks the period budget, the floor and the gap since the last sale.',
  'It reads prices from at least two sources and a 1Click quote; if they disagree beyond the sealed tolerance, it waits.',
  'It signs a request naming the exact transfer, the 1Click deposit address, the minimum output and its yes/no compliance answers.',
  'The registry checks the signature and allowlist, then enforces the public envelope itself, records a receipt and moves the tokens (or has the MPC network sign the EVM transfer).',
  '1Click settles the swap and sends the proceeds to the beneficiary. Anyone can re-check the receipt from chain data.',
];

/** `live` replaces `here` when the part's mode is live on this server. */
const SIMULATED: {
  part: string;
  mode: keyof Meta['modes'] | null;
  here: string;
  live?: string;
  real: string;
}[] = [
  {
    part: 'Enclave',
    mode: 'enclave',
    here: 'An executor process on the server with its own keys, sealed storage and a simulated TDX quote. OutLayer’s TEE workers run only on mainnet (paid in mainnet USDC), so there is no testnet enclave to use.',
    live: 'An OutLayer worker in Intel TDX on testnet. The registry pinned its key after one attested key-proof run.',
    real: 'An OutLayer worker in Intel TDX.',
  },
  {
    part: 'TDX quote vendor key',
    mode: 'enclave',
    here: 'A vendor key whose seed is public. Every check the browser runs is real computation, but anyone could sign such a quote, so it proves the wiring only.',
    live: 'Intel’s, checked with OutLayer’s verifier. This app’s browser checks only that the served measurements and quote hash match the registry.',
    real: 'Intel’s attestation collateral.',
  },
  {
    part: 'MPC signing network',
    mode: 'chainSignatures',
    here: 'On NEAR testnet, the real network: the registry calls v1.signer-prod.testnet. Locally, a signer simulator on the sandbox answers through the same interface and key derivation.',
    real: 'NEAR Chain Signatures (v1.signer).',
  },
  {
    part: '1Click',
    mode: 'oneclick',
    here: 'A simulator on the real API paths (quote, deposit, status), signing quotes in 1Click’s real format with its own key, which can be told to refund, fail or stall. 1Click has no testnet.',
    real: '1click.chaindefuser.com.',
  },
  {
    part: 'Price feeds',
    mode: 'prices',
    here: 'Binance and Coinbase, keyless, for listed tokens (NEAR, wNEAR). A demo token has no market, so it is priced on a seeded simulated market, with per-source offsets to rehearse manipulation.',
    real: 'Exchange APIs and 1Click quotes, fetched inside the enclave.',
  },
  {
    part: 'NEAR',
    mode: 'near',
    here: 'NEAR testnet with the deployed registry. Tests and offline work use a local NEAR sandbox, whose time the demo controls can move forward.',
    real: 'NEAR mainnet.',
  },
  {
    part: 'EVM chain',
    mode: 'evm',
    here: 'Sepolia, reached through public RPC endpoints. Tests and offline work use a local Hardhat node.',
    real: 'An EVM chain such as Ethereum or Base.',
  },
];

const THREATS = [
  [
    'The insider sells enrolled tokens outside the plan',
    'The plan account has no keys; only allowlisted enclave requests inside the envelope execute; the registry cannot be upgraded.',
    'Bugs in the registry code.',
  ],
  [
    'The insider holds tokens that were never enrolled',
    'Mint the team allocation straight into the plan at launch and publish the enrolled share.',
    'Tokens outside the plan are not covered.',
  ],
  [
    'The insider hedges with derivatives',
    'Disclosure norms; optional attested exchange-account checks.',
    'Cannot be fully prevented.',
  ],
  [
    'Front-running by inferring the schedule',
    'Random timing, delayed disclosure, a public envelope looser than the plan.',
    'Large sales still move the price.',
  ],
  [
    'Price manipulation to trigger sales below fair value',
    'Several sources must agree; the floor is checked against independent prices; minimum output on every quote.',
    'Costly but possible for illiquid tokens.',
  ],
  [
    'The operator reads or alters the plan',
    'The plan is encrypted to the attested enclave key; the commitment is on-chain.',
    'Trust in the TEE vendor.',
  ],
  [
    'The enclave is compromised',
    'Allowlist with revocation; the registry’s public envelope still bounds every sale.',
    'As for any TEE system.',
  ],
  [
    'The enclave goes down',
    'Sales stop (fail safe); no escape hatch for the insider.',
    'Sales are delayed during an outage.',
  ],
  [
    'The insider rushes a change before bad news',
    'Every change is public and waits out the cooling-off; the old plan keeps running.',
    'A change can loosen the public bounds, but only after a public cooling-off; holders see the new bounds before they apply.',
  ],
  [
    'A signed request is replayed',
    'Sequence numbers, expiry and per-plan state in the registry.',
    '—',
  ],
];

const LIMITS = [
  'It proves how enrolled tokens were handled, not everything the insider does. Wallets never enrolled and derivative hedges are outside it.',
  'Its legal status is untested. It mirrors a 10b5-1 plan, but no regulator recognises it for tokens yet. Its value today is reputational and contractual.',
  'Token coverage depends on NEAR Intents and its solvers. Illiquid or unsupported tokens cannot be sold this way.',
  'Market impact remains. The plan hides timing, not the fact that supply is being sold.',
  'TEE and MPC trust assumptions are explicit, not removed.',
];

function SystemStatus() {
  const meta = useMeta();
  const { result, error: attError } = useAttestation(meta.data);
  const registryId = meta.data?.accounts.registry;
  const keys = useResource(registryId ? () => accessKeys(registryId) : null, [registryId], 30_000);

  if (meta.error && !meta.data) return <ErrorNote error={meta.error} retry={meta.reload} />;
  if (!meta.data) return <LoadingBlock label="Loading system status" />;
  const m = meta.data;
  const keyCount = keys.data?.total ?? m.registry.accessKeys;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel
        level={3}
        title="Plan registry"
        description="The NEAR account that stores every commitment, limit and receipt."
      >
        <dl className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-ink-3">Account</dt>
            <dd className="mono">{m.accounts.registry}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-ink-3">Access keys (read from chain)</dt>
            <dd className="flex items-center gap-2">
              <span className="num font-semibold">{keyCount}</span>
              {keyCount === 0 ? (
                <Badge tone="pass" dot>
                  Code cannot change
                </Badge>
              ) : (
                <Badge tone="fail" dot>
                  Someone holds a key
                </Badge>
              )}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-ink-3">Plan account code</dt>
            <dd>
              {m.registry.config.plan_account_code_hash ? (
                <Hash value={m.registry.config.plan_account_code_hash} label="code hash" />
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-ink-3">Minimum cooling-off</dt>
            <dd className="num">{duration(m.registry.config.min_cooling_off_ms)}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-ink-3">Plans so far</dt>
            <dd className="num">{m.registry.config.next_plan_id - 1}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-ink-3">Chain time</dt>
            <dd className="num">{fmtDateTime(m.chainTimeMs)}</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-ink-3">
          The registry’s deploy key was deleted and its code has no upgrade method, so its code
          cannot be replaced. Its governance account ({m.registry.config.governance}) can pause it
          and add enclave or quote-signer keys, each only after a public activation delay.
        </p>
      </Panel>

      <Panel
        level={3}
        title="Enclave"
        description="The executor that holds sealed plans. Checked in this browser just now."
        actions={
          isOutlayerQuote(m.enclave.quote) ? (
            <Badge tone="accent">{OUTLAYER_LABEL}</Badge>
          ) : simReason(m, 'enclave') ? (
            <SimBadge title={`Simulated: ${simReason(m, 'enclave')}`}>Simulated TDX quote</SimBadge>
          ) : undefined
        }
      >
        <dl className="mb-3 space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-ink-3">Signing key</dt>
            <dd>
              <Hash value={m.enclave.signingKey} label="enclave signing key" head={14} />
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-ink-3">Encryption key (X25519)</dt>
            <dd>
              <Hash value={m.enclave.encryptionKeyHex} label="enclave encryption key" />
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-ink-3">Attestation</dt>
            <dd>
              {attError ? (
                <Badge tone="fail">Could not read the registry</Badge>
              ) : !result ? (
                <Badge>Checking…</Badge>
              ) : result.ok ? (
                <Badge tone="pass" dot>
                  All {result.checks.length} checks passed
                </Badge>
              ) : (
                <Badge tone="fail" dot>
                  {result.checks.filter((c) => !c.ok).length} checks failed
                </Badge>
              )}
            </dd>
          </div>
        </dl>
        {result && !result.ok && (
          <p className="mb-3 text-sm text-fail">{attestationFailure(result.checks)}</p>
        )}
        {result && (
          <details className="well px-3 py-1" open={!result.ok}>
            <summary className="cursor-pointer py-1.5 text-sm font-medium">Show each check</summary>
            <CheckList
              checks={result.checks.map((c) => ({
                label: c.label,
                state: c.ok ? 'pass' : 'fail',
              }))}
            />
          </details>
        )}
        {isOutlayerQuote(m.enclave.quote) ? (
          <div className="mt-3">
            <OutlayerEvidence quote={m.enclave.quote} meta={m} />
          </div>
        ) : (
          <p className="mt-3 text-xs text-ink-3">
            The quote is served by the operator; its hash, key and measurements are read from the
            registry on-chain.
            {simReason(m, 'enclave')
              ? ' Its vendor key is simulated, so this proves the wiring, not Intel hardware.'
              : ''}
          </p>
        )}
      </Panel>
    </div>
  );
}

export default function HowItWorksPage() {
  const meta = useMeta();
  return (
    <div className="space-y-10">
      <PageHeader
        title="How it works"
        lead="What each part does, what it guarantees, what this build simulates, and where the guarantees stop."
      />

      <section aria-labelledby="parts">
        <h2 id="parts" className="mb-4 text-lg font-semibold">
          The parts and what each guarantees
        </h2>
        <div className="panel divide-y divide-rule-2">
          {PARTS.map((p) => (
            <div
              key={p.name}
              className="grid gap-2 px-5 py-4 md:grid-cols-[14rem_1fr_1fr] md:gap-6"
            >
              <div>
                <h3 className="font-semibold">{p.name}</h3>
                <p className="text-xs text-ink-3">{p.where}</p>
              </div>
              <p className="text-sm text-ink-2">{p.does}</p>
              <p className="text-sm">
                <span className="sr-only">Guarantees: </span>
                {p.guarantees}
              </p>
            </div>
          ))}
        </div>
      </section>

      <Panel title="The path of one sale">
        <ol className="space-y-3">
          {SALE_PATH.map((s, i) => (
            <li key={s} className="flex gap-3 text-sm">
              <span className="num inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text">
                {i + 1}
              </span>
              <span className="pt-0.5">{s}</span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm text-ink-2">
          Even a fully compromised enclave is bounded by the registry: it cannot sell more per sale
          or per period than the public envelope, below its floor, or more often than its minimum
          gap. Holders can check each receipt on the{' '}
          <Link href="/verify" className="link">
            public verifier
          </Link>
          .
        </p>
      </Panel>

      <section id="simulated" aria-labelledby="simulated-title" className="scroll-mt-24">
        <h2 id="simulated-title" className="text-lg font-semibold">
          What is simulated in this build
        </h2>
        <p className="mt-1 mb-4 max-w-[70ch] text-sm text-ink-2">
          Every outside system has a simulator that mirrors the real API, selected by a mode flag.
          The contracts, the cryptography and the browser checks are real.
        </p>
        <div className="panel overflow-x-auto">
          <table className="table min-w-[720px]">
            <thead>
              <tr>
                <th scope="col">Part</th>
                <th scope="col">Mode now</th>
                <th scope="col">In this build</th>
                <th scope="col">In production</th>
              </tr>
            </thead>
            <tbody>
              {SIMULATED.map((s) => (
                <tr key={s.part}>
                  <th scope="row" className="text-left font-semibold">
                    {s.part}
                  </th>
                  <td>
                    {s.mode && meta.data ? <ModeBadge mode={meta.data.modes[s.mode]} /> : '…'}
                  </td>
                  <td className="text-ink-2">
                    {s.live && s.mode && meta.data?.modes[s.mode] === 'live' ? s.live : s.here}
                  </td>
                  <td className="text-ink-2">{s.real}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="status">
        <h2 id="status" className="text-lg font-semibold">
          Live status
        </h2>
        <p className="mt-1 mb-4 max-w-[70ch] text-sm text-ink-2">
          Read just now from the registry and the enclave this app talks to.
        </p>
        <SystemStatus />
      </section>

      <section aria-labelledby="threats">
        <h2 id="threats" className="mb-4 text-lg font-semibold">
          Threat model
        </h2>
        <div className="panel overflow-x-auto">
          <table className="table min-w-[760px]">
            <thead>
              <tr>
                <th scope="col">Threat</th>
                <th scope="col">What stops it</th>
                <th scope="col">What is left</th>
              </tr>
            </thead>
            <tbody>
              {THREATS.map(([t, m, r]) => (
                <tr key={t}>
                  <th scope="row" className="text-left font-medium">
                    {t}
                  </th>
                  <td className="text-ink-2">{m}</td>
                  <td className="text-ink-2">{r}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Known limits">
          <ul className="list-disc space-y-2 pl-5 text-sm">
            {LIMITS.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Panel>
        <Panel title="How this differs from Wakeless and Charter">
          <div className="space-y-3 text-sm">
            <p>
              <strong>Wakeless</strong> hides how a trader executes their own order.{' '}
              <strong>Charter</strong> enforces public rules on a fund.
            </p>
            <p>
              Neither lets an insider prove to everyone else that they are following a secret plan
              they committed to in advance, with their allocation locked in a keyless account from
              launch on its own chain, and a public cooling-off before any change. That proof is the
              product.
            </p>
            <p className="text-ink-2">
              It is also not vesting: vesting decides when tokens unlock. A sales plan governs how
              they are sold, privately and verifiably.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
