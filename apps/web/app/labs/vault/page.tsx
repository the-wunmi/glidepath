'use client';

import {
  type AddressBalance,
  MempoolClient,
  mempoolAddressUrl,
  mempoolTxUrl,
  type SpendView,
  type VaultView,
} from '@glidepath/btc';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useMeta } from '@/components/meta';
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
  SimBadge,
  type Tone,
} from '@/components/ui';
import { accessKeys } from '@/lib/chain';
import { type Explorer, explorer } from '@/lib/env';
import { duration, fmtDateTime } from '@/lib/format';
import { type Resource, useNow, useResource } from '@/lib/use-resource';
import {
  addressMatchesDerivation,
  btc,
  readVault,
  sats,
  signedTransaction,
  type VaultDeployment,
  vaultDeployment,
} from '@/lib/vault';

/** Bitcoin testnet4 reads: blockstream.info's Esplora API answers browsers (CORS) reliably. */
const mempool = new MempoolClient('https://blockstream.info/testnet4/api');

const SIMULATED_SIGNER =
  'On this local chain a stand-in signer plays the MPC network, and the rehearsal’s UTXOs are made up';

export default function VaultPage() {
  const deployment = useResource(vaultDeployment, [], 60_000);
  const local = deployment.data?.network === 'local';
  return (
    <div>
      <PageHeader
        meta={
          <>
            <Link href="/labs" className="link text-sm">
              Labs
            </Link>
            <Badge>Prototype</Badge>
            {!local && <Badge tone="accent">Bitcoin testnet4</Badge>}
          </>
        }
        title="Bitcoin vault"
        lead="A Bitcoin address that no person holds a key to. Coins leave it only after a public delay, and guardians can stop a withdrawal or send everything to a recovery address the owner chose in advance."
      />
      <Explainer />
      <section aria-labelledby="live-vault" className="mt-8">
        <h2 id="live-vault" className="mb-3 text-lg font-semibold">
          The live vault
        </h2>
        {deployment.error && !deployment.data ? (
          <ErrorNote error={deployment.error} retry={deployment.reload} />
        ) : deployment.loading && deployment.data === null ? (
          <div className="panel px-5 py-4">
            <LoadingBlock label="Looking up the vault" />
          </div>
        ) : !deployment.data?.vault ? (
          <EmptyState title="No vault to show yet">
            {deployment.data
              ? `The vault contract ${deployment.data.contract} is deployed, but no vault has been created on it.`
              : 'This server has no vault deployment. The contract and its tests are in the repository, in contracts/btc-vault.'}
          </EmptyState>
        ) : (
          <LiveVault deployment={deployment.data} id={deployment.data.vault.id} />
        )}
      </section>
    </div>
  );
}

function Explainer() {
  return (
    <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
      <Panel title="The problem">
        <div className="space-y-3 text-sm text-ink-2">
          <p>
            Whoever holds a Bitcoin key can move the coins at once, and nothing can undo it. A thief
            who copies the key can empty the wallet in minutes. So can someone who threatens the
            owner until they hand it over, a “wrench attack”, and those keep happening.
          </p>
          <p>
            Bitcoin itself has no way to say “this money may only leave slowly”. A proposal to add
            one (OP_VAULT) has not been adopted.
          </p>
        </div>
      </Panel>
      <Panel title="What stops it">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-2">
          <li>
            The vault’s address belongs to a NEAR contract. NEAR’s MPC network (Chain Signatures)
            signs for it only when that contract asks, and nobody holds its key.
          </li>
          <li>
            The owner’s withdrawals are public the moment they are asked for, and wait out the
            vault’s delay before anything is signed.
          </li>
          <li>
            During the delay, and until someone executes it, any guardian can veto a withdrawal for
            good.
          </li>
          <li>
            At any time, a guardian can send everything to the recovery address the owner fixed when
            the vault was made, with no delay. That is the only place they can send it.
          </li>
          <li>
            The contract builds each transaction itself, so the owner cannot hurry it and a guardian
            cannot redirect it. It has no upgrade method and no key, so its rules cannot be changed.
          </li>
        </ol>
      </Panel>
      <Panel title="Limits" className="lg:col-span-2">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
          <li>
            Once a withdrawal is executed its signatures may be public. After that only a claw-back
            can stop it, by replacing it before it confirms. The contract makes a claw-back able to
            pay more fee, but replacement is best effort: the recipient can make it harder by
            spending the unconfirmed output (“pinning”).
          </li>
          <li>
            A guardian can block withdrawals indefinitely. The coins stay safe: a guardian can still
            only send them to the recovery address.
          </li>
          <li>
            The contract cannot read Bitcoin, so it takes the coin amounts a request names on trust.
            A wrong amount only produces signatures the network rejects, and a corrected request
            still goes through. Signatures can only be combined within one exact transaction, and
            the contract refuses the same coins and outputs with other amounts.
          </li>
          <li>A prototype on test networks, with test coins only.</li>
        </ul>
      </Panel>
    </div>
  );
}

function LiveVault({ deployment, id }: { deployment: VaultDeployment; id: number }) {
  const meta = useMeta();
  const links = explorer(meta.data);
  const chain = useResource(() => readVault(deployment, id), [deployment.contract, id], 10_000);
  const keys = useResource(() => accessKeys(deployment.contract), [deployment.contract], 60_000);
  const address = chain.data?.vault.address ?? null;
  const balance = useResource(address ? () => mempool.balance(address) : null, [address], 30_000);

  if (chain.error && !chain.data) return <ErrorNote error={chain.error} retry={chain.reload} />;
  if (!chain.data)
    return (
      <div className="panel px-5 py-4">
        <LoadingBlock label="Reading the vault from NEAR" />
      </div>
    );
  const { vault, spends, rootKey, chainOffsetMs } = chain.data;
  const account = (a: string) => <AccountLink account={a} links={links} />;

  return (
    <div className="space-y-5">
      {chain.error && (
        <ErrorNote error={`Showing the last successful read. ${chain.error.message}. Retrying.`} />
      )}
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Panel title={`Vault #${vault.id}`} description="Read from the contract by your browser.">
          <Facts
            items={[
              [
                'Bitcoin address',
                vault.address ? (
                  <Hash
                    key="address"
                    value={vault.address}
                    label="vault address"
                    full
                    href={mempoolAddressUrl(vault.address)}
                  />
                ) : (
                  'Waiting for the signer to derive its key'
                ),
              ],
              ['Balance', <Balance key="balance" resource={balance} />],
              ['Owner', account(vault.owner)],
              [
                vault.guardians.length === 1 ? 'Guardian' : 'Guardians',
                <span key="guardians" className="flex flex-col gap-0.5">
                  {vault.guardians.map((g) => (
                    <span key={g}>{account(g)}</span>
                  ))}
                </span>,
              ],
              ['Withdrawal delay', duration(vault.delay_ms)],
              [
                'Recovery address',
                <Hash
                  key="recovery"
                  value={vault.recovery_address}
                  label="recovery address"
                  full
                  href={mempoolAddressUrl(vault.recovery_address)}
                />,
              ],
              ['Contract', account(deployment.contract)],
              [
                'Signer',
                <span key="signer" className="inline-flex flex-wrap items-center gap-2">
                  {account(deployment.signer_contract)}
                  {deployment.network === 'local' && <SimBadge title={SIMULATED_SIGNER} />}
                </span>,
              ],
            ]}
          />
        </Panel>
        <Panel title="Checked in your browser">
          <CheckList
            checks={[
              {
                label: 'The address is the one the MPC network derives for this contract',
                state: addressMatchesDerivation(rootKey, deployment.contract, vault)
                  ? 'pass'
                  : 'fail',
                detail: `From the root key the signer contract ${deployment.signer_contract} reports, the contract ${deployment.contract} and the path “${vault.path}”. Nobody chose it, and only this contract can ask for its signatures.`,
              },
              {
                label: keys.data
                  ? `The contract has ${keys.data.total} access key${keys.data.total === 1 ? '' : 's'}`
                  : keys.error
                    ? 'The contract’s keys could not be checked'
                    : 'Checking the contract’s keys',
                state: keys.data ? (keys.data.total === 0 ? 'pass' : 'fail') : 'pending',
                detail: keys.error
                  ? keys.error.message
                  : 'With no key, nobody can change its code or its rules.',
              },
            ]}
          />
        </Panel>
      </div>
      <Panel
        title="Withdrawals and claw-backs"
        description="Newest first. Every request is public on NEAR from the moment it is made."
      >
        {spends.length === 0 ? (
          <p className="text-sm text-ink-2">None yet.</p>
        ) : (
          <ul className="divide-y divide-rule-2">
            {spends.map((s) => (
              <SpendRow
                key={s.id}
                spend={s}
                vault={vault}
                account={account}
                chainOffsetMs={chainOffsetMs}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function AccountLink({ account, links }: { account: string; links: Explorer }) {
  const href = links.nearAccount(account);
  return href ? (
    <a
      href={href}
      className="mono link text-[0.8125rem] [overflow-wrap:anywhere]"
      target="_blank"
      rel="noreferrer"
    >
      {account}
    </a>
  ) : (
    <span className="mono text-[0.8125rem] [overflow-wrap:anywhere]">{account}</span>
  );
}

function Balance({ resource }: { resource: Resource<AddressBalance> }) {
  if (resource.error && !resource.data)
    return (
      <span className="text-ink-2">
        Could not be read from Bitcoin testnet4.{' '}
        <button type="button" className="link" onClick={() => void resource.reload()}>
          Try again
        </button>
      </span>
    );
  if (!resource.data) return <span className="text-ink-3">Reading Bitcoin testnet4…</span>;
  const { confirmed, unconfirmed } = resource.data;
  return (
    <span>
      {sats(confirmed)} <span className="text-ink-3">({btc(confirmed)})</span>
      {unconfirmed !== 0n && (
        <span className="block text-xs text-ink-3">
          {unconfirmed > 0n ? '+' : '−'}
          {sats(unconfirmed < 0n ? -unconfirmed : unconfirmed)} unconfirmed
        </span>
      )}
    </span>
  );
}

const STATUS: Record<SpendView['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'wait' },
  signing: { label: 'Signing', tone: 'accent' },
  signed: { label: 'Signed', tone: 'pass' },
  vetoed: { label: 'Vetoed', tone: 'fail' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

function SpendRow({
  spend,
  vault,
  account,
  chainOffsetMs,
}: {
  spend: SpendView;
  vault: VaultView;
  account: (a: string) => ReactNode;
  chainOffsetMs: number;
}) {
  const clock = useNow(1000);
  const now = clock ? clock + chainOffsetMs : 0;
  const status = STATUS[spend.status];
  // `now` is 0 until mounted; the countdown waits for the real clock.
  const left = now ? spend.effective_at_ms - now : spend.effective_at_ms - spend.requested_at_ms;
  const toRecovery = spend.destination === vault.recovery_address;
  return (
    <li className="py-3.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">
            {spend.kind === 'withdrawal' ? 'Withdrawal' : 'Claw-back'} #{spend.id}
          </span>
          <Badge tone={status.tone} dot>
            {status.label}
          </Badge>
        </div>
        <span className="text-sm font-semibold">{sats(spend.amount)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
        <span>to</span>
        <Hash
          value={spend.destination}
          label="destination"
          head={10}
          tail={8}
          href={mempoolAddressUrl(spend.destination)}
        />
        {toRecovery && <span className="text-xs text-ink-3">(the recovery address)</span>}
      </div>
      <p className="mt-1 text-xs text-ink-3">
        Fee {sats(spend.fee)}
        {BigInt(spend.change) > 0n && `, ${sats(spend.change)} back to the vault`}. Asked{' '}
        {fmtDateTime(spend.requested_at_ms)} by {account(spend.requested_by)}.
      </p>
      <p className="mt-1.5 text-sm">
        {spend.status === 'pending' && spend.kind === 'withdrawal' && left > 0 ? (
          <>
            Executable in{' '}
            <span className="font-semibold tabular-nums">{now ? duration(left) : '…'}</span> (
            {fmtDateTime(spend.effective_at_ms)}). Until someone executes it, any guardian can veto
            it.
          </>
        ) : spend.status === 'pending' && spend.sign_rounds > 0 ? (
          'A signing round did not finish. Its signatures may already be public, so it can no longer be vetoed: anyone can execute it again, and a guardian can claw back.'
        ) : spend.status === 'pending' && spend.kind === 'withdrawal' ? (
          'Ready: anyone can execute it now. Until someone does, any guardian can veto it.'
        ) : spend.status === 'pending' ? (
          'Ready: anyone can execute it now.'
        ) : spend.status === 'signing' ? (
          'The MPC network is signing it.'
        ) : spend.status === 'signed' ? (
          `Signed ${spend.signed_at_ms ? fmtDateTime(spend.signed_at_ms) : ''}. Anyone can broadcast it.`
        ) : spend.status === 'vetoed' ? (
          <>
            Vetoed by {spend.vetoed_by && account(spend.vetoed_by)} before any signing. The contract
            will never sign it.
          </>
        ) : (
          <>
            Cancelled by {spend.vetoed_by && account(spend.vetoed_by)}’s claw-back before it was
            signed.
          </>
        )}
      </p>
      {spend.status === 'signed' && (
        <SignedTransaction spend={spend} publicKey={vault.public_key} />
      )}
    </li>
  );
}

function SignedTransaction({ spend, publicKey }: { spend: SpendView; publicKey: string | null }) {
  const tx = signedTransaction(spend, publicKey);
  const txid = tx?.ok ? tx.txid : null;
  const status = useResource(txid ? () => mempool.txStatus(txid) : null, [txid], 30_000);
  if (!tx) return null;
  if (!tx.ok)
    return (
      <div className="mt-2 flex items-start gap-2 text-sm text-fail">
        <CheckMark state="fail" />
        <span>{tx.error}</span>
      </div>
    );
  return (
    <div className="mt-2 space-y-1 rounded-md bg-surface-2 px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <CheckMark state="pass" />
        <span>
          Rebuilt in your browser from the contract’s record; every signature verifies against the
          vault’s key.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 pl-7">
        <span className="text-ink-3">Bitcoin transaction</span>
        <Hash value={tx.txid} label="transaction id" href={mempoolTxUrl(tx.txid)} />
        <span className="text-xs text-ink-3">
          {status.error && !status.data
            ? 'status could not be read from Bitcoin testnet4'
            : status.loading
              ? 'checking Bitcoin testnet4…'
              : status.data === null
                ? 'not seen on Bitcoin testnet4 yet'
                : status.data.confirmed
                  ? `confirmed in block ${status.data.block_height}`
                  : 'in the mempool, unconfirmed'}
        </span>
      </div>
    </div>
  );
}
