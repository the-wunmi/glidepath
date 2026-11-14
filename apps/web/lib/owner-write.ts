'use client';

import { formatAmount } from '@vsp/core';
import { ApiError, api } from './api';

/** The call a plan owner's wallet must sign, as the API's 409 `wallet_signature_needed` names it. */
export interface WalletCall {
  receiverId: string;
  method: string;
  args: Record<string, unknown>;
  /** Gas in Tgas. */
  gasTera: number | string;
  /** Attached deposit in yoctoNEAR, as a decimal string. */
  deposit: string;
}

/** The owner closed the signing prompt; nothing was sent. */
export class WalletDeclined extends Error {
  constructor() {
    super('Nothing was signed.');
    this.name = 'WalletDeclined';
  }
}

/** The wallet sent its transaction, but the API could not record it yet. Trying again reuses it. */
export class WalletSentNotRecorded extends Error {
  constructor(
    readonly txHash: string,
    cause: string,
  ) {
    super(
      `Your wallet sent the transaction (${txHash.slice(0, 8)}…), but Glidepath could not record it yet: ${cause} Try again; the wallet will not be asked a second time.`,
    );
    this.name = 'WalletSentNotRecorded';
  }
}

const YOCTO = 24;
const TERA = 10n ** 12n;
/** Waits between resends while the chain makes the wallet's transaction final. */
const FINALITY_BACKOFF_MS = [1500, 2500, 4000, 6000, 8000];

/** yoctoNEAR to "0.25 NEAR"; at most four decimals, more only for amounts smaller than that. */
export function nearAmount(yocto: string | bigint): string {
  const v = BigInt(yocto);
  const out = formatAmount(v, YOCTO, 4);
  return `${v > 0n && /^0(\.0*)?$/.test(out) ? formatAmount(v, YOCTO, 8) : out} NEAR`;
}

/** "0.42" NEAR to yoctoNEAR; null unless it is a positive amount with at most 24 decimals. */
export function parseNear(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text.trim().replace(/,/g, ''));
  if (!m) return null;
  const v = BigInt(m[1] ?? '0') * 10n ** 24n + BigInt((m[2] ?? '').padEnd(YOCTO, '0') || '0');
  return v > 0n ? v : null;
}

const isWalletCall = (e: unknown): e is ApiError =>
  e instanceof ApiError && e.status === 409 && e.code === 'wallet_signature_needed';

/**
 * Whether a sent transaction can never count for this request: the API checked it and refused it
 * (not this call, or the registry refused it). Anything else (a server fault, a network error) keeps
 * it, so trying again sends the same hash instead of asking the wallet twice.
 */
const txRejected = (e: unknown) =>
  e instanceof ApiError && e.status >= 400 && e.status < 500 && !notFinal(e);

/** Worth asking again: the transaction is not final yet, or NEAR's public RPC is busy. */
const notFinal = (e: unknown) =>
  e instanceof ApiError &&
  ((e.status === 409 && e.code === 'conflict' && /not final/i.test(e.message)) ||
    (e.status === 503 && e.code === 'unavailable'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where a sent but unrecorded transaction waits, keyed by the request it answers. */
async function pendingKey(path: string, body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${path}\n${JSON.stringify(body)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `vsp-wallet-tx-${Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Sends a request, again while the API answers that the wallet's transaction is not final yet.
 * `txHash` goes as `x-wallet-tx` when given.
 */
async function sendUntilFinal<T>(
  path: string,
  body: unknown,
  planId: number | undefined,
  txHash?: string,
): Promise<T> {
  const headers = txHash ? { 'x-wallet-tx': txHash } : undefined;
  for (let i = 0; ; i++) {
    try {
      return await api<T>(path, { body, planId, headers });
    } catch (e) {
      const wait = FINALITY_BACKOFF_MS[i];
      if (!notFinal(e) || wait === undefined) throw e;
      await sleep(wait);
    }
  }
}

/**
 * An owner action on a plan. A plan owned by the signed-in wallet answers the first request with
 * the call to sign (409 `wallet_signature_needed`): `confirm` shows it to the owner (reject to stop),
 * the wallet signs and sends exactly that call, and the same request goes again with its hash. Plans
 * the server signs for (its own accounts, a plan key or the operator) answer the first request.
 * A transaction the API could not record yet is kept for this tab, so trying again does not ask the
 * wallet twice.
 */
export async function ownerWrite<T>(
  path: string,
  body: unknown,
  opts: { planId?: number; confirm?: (call: WalletCall) => Promise<void> } = {},
): Promise<T> {
  const key = await pendingKey(path, body);
  const earlier = sessionStorage.getItem(key);
  if (earlier) {
    try {
      const out = await sendUntilFinal<T>(path, body, opts.planId, earlier);
      sessionStorage.removeItem(key);
      return out;
    } catch (e) {
      if (!txRejected(e)) throw new WalletSentNotRecorded(earlier, (e as Error).message);
      // The API refused that transaction for this request (refused, or not this call): start over.
      sessionStorage.removeItem(key);
    }
  }
  let call: WalletCall;
  try {
    return await api<T>(path, { body, planId: opts.planId });
  } catch (e) {
    if (!isWalletCall(e)) throw e;
    const details = e.details as { call?: WalletCall } | undefined;
    if (!details?.call) throw e;
    call = details.call;
  }
  await opts.confirm?.(call);
  const { signAndSendTransactions, functionCall } = await import('./wallet');
  const [sent] = await signAndSendTransactions([
    {
      receiverId: call.receiverId,
      actions: [
        functionCall(call.method, call.args, String(BigInt(call.gasTera) * TERA), call.deposit),
      ],
    },
  ]);
  if (!sent) throw new Error('The wallet returned no transaction.');
  sessionStorage.setItem(key, sent.txHash);
  try {
    const out = await sendUntilFinal<T>(path, body, opts.planId, sent.txHash);
    sessionStorage.removeItem(key);
    return out;
  } catch (e) {
    if (!txRejected(e)) throw new WalletSentNotRecorded(sent.txHash, (e as Error).message);
    sessionStorage.removeItem(key);
    throw e;
  }
}

/** GET /api/plans/:id/budget: what the relayer charges a founder's plan, in yoctoNEAR. */
export interface PlanBudget {
  balance: string;
  fees: {
    run: string;
    execute: string;
    evm_execute: string;
    finalize: string;
    reveal: string;
    launch_near: string;
    launch_evm: string;
  };
  /** The least a plan must hold for a sale to be tried. */
  saleReserve: string;
  /** The account a top-up is sent to. */
  relayer: string;
}

/** Sales the suggested first top-up covers; the owner can top up again at any time. */
export const SUGGESTED_SALES = 20;

/** What one sale costs the plan: an enclave run, then its execute on NEAR or the EVM chain. */
export const saleFee = (b: PlanBudget, chain: 'near' | 'evm'): bigint =>
  BigInt(b.fees.run) + BigInt(chain === 'evm' ? b.fees.evm_execute : b.fees.execute);

export const launchFee = (b: PlanBudget, chain: 'near' | 'evm'): bigint =>
  BigInt(chain === 'evm' ? b.fees.launch_evm : b.fees.launch_near);

/**
 * A first top-up: the launch (unless done), about twenty sales, and the closing finalize and
 * reveal, less what the plan already holds.
 */
export function suggestedTopUp(b: PlanBudget, chain: 'near' | 'evm', launched: boolean): bigint {
  const need =
    (launched ? 0n : launchFee(b, chain)) +
    BigInt(SUGGESTED_SALES) * saleFee(b, chain) +
    BigInt(b.fees.finalize) +
    BigInt(b.fees.reveal);
  const short = need - BigInt(b.balance);
  return short > 0n ? short : BigInt(SUGGESTED_SALES) * saleFee(b, chain);
}

const fundKey = (planId: number) => `vsp-fund-tx-${planId}`;

/**
 * Tops up a plan's budget: the owner's wallet sends `yocto` to the relayer, and the API credits the
 * plan once it reads that transfer on chain. A transfer sent but not yet credited is kept for this
 * tab and claimed first next time, so no transfer is lost or sent twice by a retry.
 */
export async function fundPlan(
  planId: number,
  relayer: string,
  yocto: bigint,
): Promise<{ balance: string; claimedEarlier: boolean }> {
  const claim = (txHash: string) =>
    sendUntilFinal<{ balance: string }>(`/api/plans/${planId}/fund`, { tx_hash: txHash }, planId);
  const earlier = sessionStorage.getItem(fundKey(planId));
  if (earlier) {
    try {
      const out = await claim(earlier);
      sessionStorage.removeItem(fundKey(planId));
      return { ...out, claimedEarlier: true };
    } catch (e) {
      if (notFinal(e)) throw new WalletSentNotRecorded(earlier, (e as Error).message);
      sessionStorage.removeItem(fundKey(planId));
    }
  }
  const { signAndSendTransactions, transfer } = await import('./wallet');
  const [sent] = await signAndSendTransactions([
    { receiverId: relayer, actions: [transfer(yocto.toString())] },
  ]);
  if (!sent) throw new Error('The wallet returned no transaction.');
  sessionStorage.setItem(fundKey(planId), sent.txHash);
  try {
    const out = await claim(sent.txHash);
    sessionStorage.removeItem(fundKey(planId));
    return { ...out, claimedEarlier: false };
  } catch (e) {
    if (notFinal(e)) throw new WalletSentNotRecorded(sent.txHash, (e as Error).message);
    sessionStorage.removeItem(fundKey(planId));
    throw e;
  }
}
