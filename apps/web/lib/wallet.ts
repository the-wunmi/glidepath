'use client';

import type { ConnectorAction, NearConnector, NearConnectorOptions } from '@hot-labs/near-connect';
import { api } from './api';
import type { Me } from './session';

/**
 * Pages that load the wallet connector. NEAR Connect runs each wallet's code in a sandboxed
 * `srcdoc` iframe, which inherits the page's content security policy, and that code loads its own
 * fonts and images, talks to RPCs over https and wss, and some wallets frame their own site. So
 * these pages are served with a wider policy (the reverse proxy's site config, by path), and the
 * same applies to signing transactions as to signing in. Every other page keeps the strict one.
 */
export const usesWallet = (path: string): boolean =>
  path === '/sign-in' || path === '/app/new' || path.startsWith('/app/plans/');

interface WalletChallenge {
  message: string;
  /** Base64 of 32 random bytes. */
  nonce: string;
  recipient: string;
}

interface SignedMessage {
  accountId: string;
  publicKey: string;
  signature: string;
}

// WalletConnect needs a project id we don't have; Ethereum wallets can't sign NEAR messages or
// transactions.
const EXCLUDED_WALLETS = ['wallet-connect', 'ethereum-wallets'];

async function connector(features: NearConnectorOptions['features']): Promise<NearConnector> {
  const { NearConnector } = await import('@hot-labs/near-connect');
  return new NearConnector({
    network: 'testnet',
    // Only wallets that can do what is asked on testnet are offered.
    features: { ...features, testnet: true },
    excludedWallets: EXCLUDED_WALLETS,
    autoConnect: false,
  });
}

/**
 * Sign in with a NEAR testnet wallet: the person picks a wallet, it signs the API's one-time
 * challenge (NEP-413), and the API checks the signature and that the key is a full-access key of
 * the account before it starts a session. Nothing is sent on chain; the connection is dropped once
 * the message is signed. Resolves to the signed-in account.
 */
export async function walletSignIn(): Promise<string> {
  const challenge = await api<WalletChallenge>('/api/auth/wallet/challenge', {
    // An empty JSON body: the API takes writes only as JSON.
    body: {},
  });
  const nonce = Uint8Array.from(atob(challenge.nonce), (c) => c.charCodeAt(0));
  const near = await connector({ signMessage: true });
  const params = { message: challenge.message, recipient: challenge.recipient, nonce };
  // Wallets that sign during sign-in report it with this event; the others are asked afterwards.
  let signed: SignedMessage | null = null;
  near.on('wallet:signInAndSignMessage', (e) => {
    signed = e.accounts[0]?.signedMessage ?? null;
  });
  try {
    const wallet = await near.connect({ signMessageParams: params });
    // The event can trail the connect promise slightly.
    for (let i = 0; i < 15 && !signed; i++) await new Promise((r) => setTimeout(r, 100));
    const proof: SignedMessage =
      (signed as SignedMessage | null) ??
      (await wallet.signMessage({ ...params, network: 'testnet' }));
    const { account } = await api<{ account: string }>('/api/auth/wallet/verify', {
      body: {
        accountId: proof.accountId,
        publicKey: proof.publicKey,
        signature: proof.signature,
        nonce: challenge.nonce,
        recipient: challenge.recipient,
      },
    });
    return account;
  } finally {
    await near.disconnect().catch(() => undefined);
  }
}

export type FunctionCallAction = Extract<ConnectorAction, { type: 'FunctionCall' }>;
export type TransferAction = Extract<ConnectorAction, { type: 'Transfer' }>;

export interface WalletTransaction {
  receiverId: string;
  actions: ConnectorAction[];
}

/** A function call; gas in gas units and deposit in yoctoNEAR, both as decimal strings. */
export const functionCall = (
  methodName: string,
  args: object,
  gas: string,
  deposit: string,
): FunctionCallAction => ({ type: 'FunctionCall', params: { methodName, args, gas, deposit } });

/** A NEAR transfer of `deposit` yoctoNEAR (a decimal string). */
export const transfer = (deposit: string): TransferAction => ({
  type: 'Transfer',
  params: { deposit },
});

/** The parts of a FinalExecutionOutcome we read (its type comes from a package not installed). */
interface Outcome {
  transaction_outcome?: { id?: string };
  transaction?: { hash?: string };
}

const txHash = (outcome: unknown): string => {
  const o = outcome as Outcome | null;
  const hash = o?.transaction_outcome?.id ?? o?.transaction?.hash;
  if (!hash) throw new Error('The wallet sent the transaction but returned no transaction hash.');
  return hash;
};

/**
 * Has the signed-in account's wallet sign and send these transactions on testnet, in order, and
 * returns their hashes. The wallet must be connected to the same account as the session, so a
 * person can't sign as one account while Glidepath records another. The connection is dropped
 * afterwards.
 */
export async function signAndSendTransactions(
  txs: WalletTransaction[],
): Promise<{ txHash: string }[]> {
  if (txs.length === 0) return [];
  const me = await api<Me | null>('/api/me');
  if (!me) throw new Error('Sign in with your NEAR wallet first.');
  const single = txs.length === 1;
  const near = await connector(
    single ? { signAndSendTransaction: true } : { signAndSendTransactions: true },
  );
  try {
    const wallet = await near.connect();
    const accounts = await wallet.getAccounts({ network: 'testnet' });
    const connected = accounts[0]?.accountId;
    if (connected !== me.account)
      throw new Error(
        connected
          ? `The wallet is on ${connected}, but you are signed in as ${me.account}. Switch accounts in the wallet and try again.`
          : 'The wallet did not share an account.',
      );
    const base = { network: 'testnet' as const, signerId: me.account };
    const [first] = txs;
    const outcomes =
      single && first
        ? [await wallet.signAndSendTransaction({ ...base, ...first })]
        : await wallet.signAndSendTransactions({ ...base, transactions: txs });
    return outcomes.map((o) => ({ txHash: txHash(o) }));
  } finally {
    await near.disconnect().catch(() => undefined);
  }
}
