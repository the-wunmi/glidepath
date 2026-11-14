import { createHash, randomBytes } from 'node:crypto';
import { DomainError, parseInput } from '@vsp/core';
import { sessions, walletChallenges } from '@vsp/db';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Engine } from './context.ts';
import { verifyNep413 } from './nep413.ts';

/**
 * Sign-in with a NEAR wallet: the wallet signs a one-time NEP-413 message for
 * this site, the server checks the signature and that the key is a full-access key of the account
 * on chain, and starts a session. Nothing is sent on chain; the wallet pays nothing to sign in.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const WALLET_CHALLENGE_TTL_MS = 5 * 60_000;
export const WALLET_SIGN_IN_MESSAGE = 'Sign in to Glidepath';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');

export const VerifyWalletLogin = z.object({
  accountId: z.string().min(2).max(64),
  publicKey: z.string().startsWith('ed25519:').max(80),
  signature: z.string().min(80).max(100),
  /** Base64 of the challenge's 32-byte nonce. */
  nonce: z.string().min(40).max(48),
  /** The recipient the wallet was asked to sign for, if the browser reports it. */
  recipient: z.string().max(253).optional(),
});

/**
 * Accounts that can sign in on this network: named accounts under its suffix (`.testnet`, or
 * `.sandbox`/`.test.near` locally) and 64-hex implicit accounts.
 */
export function canSignIn(e: Engine, accountId: string): boolean {
  if (accountId.length < 2 || accountId.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(accountId)) return true;
  if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)+[a-z\d]+$/.test(accountId)) return false;
  if (e.world.network === 'testnet') return accountId.endsWith('.testnet');
  return accountId.endsWith(`.${e.world.root.split('.').at(-1)}`);
}

/**
 * A one-time challenge for a wallet to sign: a random nonce bound to the browser by `binding` (a
 * random token kept in an http-only cookie; only its hash is stored), valid for minutes.
 */
export async function startWalletLogin(e: Engine, binding: string, recipient: string) {
  const nonce = randomBytes(32).toString('base64');
  const expiresAt = new Date(Date.now() + WALLET_CHALLENGE_TTL_MS);
  await e.db
    .delete(walletChallenges)
    .where(lt(walletChallenges.expiresAt, new Date(Date.now() - WALLET_CHALLENGE_TTL_MS)));
  await e.db.insert(walletChallenges).values({
    nonce,
    bindingHash: hashToken(binding),
    message: WALLET_SIGN_IN_MESSAGE,
    recipient,
    expiresAt,
  });
  return { message: WALLET_SIGN_IN_MESSAGE, nonce, recipient, expiresAt: expiresAt.toISOString() };
}

/**
 * A signed challenge becomes a session only if every check holds: an account of this network, the
 * challenge unused, unexpired and issued to this browser, a valid ed25519 signature over the
 * NEP-413 payload with our recipient, and the key a full-access key of that account on chain.
 */
export async function verifyWalletLogin(
  e: Engine,
  binding: string | undefined,
  input: z.input<typeof VerifyWalletLogin>,
): Promise<{ accountId: string; sessionToken: string }> {
  const signed = parseInput(VerifyWalletLogin, input);
  if (!canSignIn(e, signed.accountId))
    throw new DomainError('invalid', 'Sign in with a NEAR testnet account.');
  if (!binding) throw new DomainError('forbidden', 'Start the sign-in again from this page.');
  // Claim the challenge first: a nonce is spent even if what follows fails, so it can't be replayed.
  const [challenge] = await e.db
    .update(walletChallenges)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(walletChallenges.nonce, signed.nonce),
        eq(walletChallenges.bindingHash, hashToken(binding)),
        isNull(walletChallenges.usedAt),
        gt(walletChallenges.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!challenge) {
    const [row] = await e.db
      .select()
      .from(walletChallenges)
      .where(eq(walletChallenges.nonce, signed.nonce));
    const why = !row
      ? 'That sign-in request is unknown.'
      : row.bindingHash !== hashToken(binding)
        ? 'That sign-in request was made in another browser.'
        : row.usedAt
          ? 'That sign-in request was already used.'
          : 'That sign-in request expired.';
    throw new DomainError('forbidden', `${why} Start the sign-in again.`);
  }
  if (signed.recipient !== undefined && signed.recipient !== challenge.recipient)
    throw new DomainError('forbidden', 'The wallet signed for another site.');
  const ok = verifyNep413(signed, {
    message: challenge.message,
    nonce: Uint8Array.from(Buffer.from(challenge.nonce, 'base64')),
    recipient: challenge.recipient,
  });
  if (!ok) throw new DomainError('forbidden', 'The wallet’s signature doesn’t match.');
  const permission = await e.near.accessKeyPermission(signed.accountId, signed.publicKey);
  if (permission === null)
    throw new DomainError('forbidden', `That key isn’t a key of ${signed.accountId}.`);
  if (permission !== 'full')
    throw new DomainError(
      'forbidden',
      'That key can only call some contracts; sign with a full-access key of the account.',
    );
  const sessionToken = newToken();
  await e.db.insert(sessions).values({
    tokenHash: hashToken(sessionToken),
    accountId: signed.accountId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { accountId: signed.accountId, sessionToken };
}

/** The account a session token belongs to, or null when it is unknown or expired. */
export async function sessionAccount(e: Engine, token: string | undefined): Promise<string | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const [row] = await e.db
    .select({ accountId: sessions.accountId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  return row?.accountId ?? null;
}

export async function endSession(e: Engine, token: string): Promise<void> {
  await e.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
