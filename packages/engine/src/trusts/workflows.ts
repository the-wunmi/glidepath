import type { SealedBox } from '@vsp/core';
import { type Tx, trusts, trustTrades } from '@vsp/db';
import type { KeyPairString } from '@vsp/near';
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { Engine } from '../context.ts';
import { DBOS, durableEngine, effect, inTx, readStep, sleep } from '../durable.ts';
import { waitForChain } from '../workflows.ts';
import { trustEnclaveOf } from './enclave.ts';
import { type CreateTrustInput, officialAccount, trustsOf, trustWorldOf } from './service.ts';

/**
 * The blind trust's durable work, one DBOS workflow per outside job, the same way as the plans'
 * (`../workflows.ts`): started once under our own key, outside effects as steps that read the chain
 * first so a repeat sends nothing, database writes as transaction steps, 1Click silence in doubt.
 */

const NEAR = 10n ** 24n;
/** A trade receipt (about 2 KB with its quote) plus the deposit address registration. */
const TRADE_DEPOSIT = NEAR / 10n;
const SETTLE_POLL_MS = 3_000;
const IN_DOUBT_POLL_MS = 30_000;
const TRANSIENT_WAIT_MS = 10_000;
/** Refusals that clear by themselves. */
const TRANSIENT = new Set(['paused', 'enclave_not_active', 'quote_signer_not_active']);

export type TrustTradeStatus =
  | 'signed'
  | 'on_chain'
  | 'settled'
  | 'refunded'
  | 'settlement_failed'
  | 'in_doubt'
  | 'refused'
  | 'failed_on_chain';

/** Moves a trade only from the statuses given, so late or repeated signals cannot undo it. */
export async function trustTransition(
  db: Tx,
  trustId: number,
  seq: number,
  from: TrustTradeStatus[],
  to: TrustTradeStatus,
  set: Partial<typeof trustTrades.$inferInsert> = {},
): Promise<boolean> {
  const rows = await db
    .update(trustTrades)
    .set({ ...set, status: to, updatedAt: new Date() })
    .where(
      and(
        eq(trustTrades.trustId, trustId),
        eq(trustTrades.seq, seq),
        inArray(trustTrades.status, from),
      ),
    )
    .returning({ id: trustTrades.id });
  return rows.length > 0;
}

const relayer = (e: Engine) =>
  e.near.account(e.world.relayer, e.world.keys[e.world.relayer] as KeyPairString);
const solver = (e: Engine) =>
  e.near.account(e.world.solver, e.world.keys[e.world.solver] as KeyPairString);

// ── trust_created ───────────────────────────────────────────────────────────────────────────

/**
 * The follow-up of createTrust: waits for the trust on-chain, records it, moves the official's
 * deposits in, hands the sealed mandate to the enclave and relays its ack.
 */
async function trustCreated(
  input: z.output<typeof CreateTrustInput>,
  ownerKeyHash: string,
): Promise<string> {
  const e = durableEngine();
  const world = trustWorldOf(e);
  const found = await waitForChain(
    'find trust',
    async () => {
      const page = await e.near.view<{ id: number; owner: string; commitment: string }[]>(
        world.contract,
        'list_trusts',
        { from_index: 1, limit: 50 },
      );
      return page.find((t) => t.commitment === input.commitment && t.owner === e.world.founder);
    },
    10 * 60_000,
  );
  if (!found) return 'not created';
  const trustId = found.id;
  await inTx('record trust', (db) =>
    db
      .insert(trusts)
      .values({
        id: trustId,
        owner: e.world.founder,
        label: input.label,
        commitment: input.commitment,
        sealedBox: input.sealed_box,
        trustAccount: `t${trustId}.${world.contract}`,
        deposits: input.deposits,
        createTx: '',
        ownerKeyHash,
      })
      .onConflictDoNothing(),
  );
  for (const d of input.deposits) await fund(e, trustId, d.asset, BigInt(d.tokens));
  const chain = await readStep('read trust', () => trustsOf(e).trust(trustId));
  if (chain?.status !== 'awaiting_ack') return 'not awaiting an ack';
  const accepted = await effect('enclave accept', async () =>
    trustEnclaveOf(e).accept(
      (await trustsOf(e).trust(trustId)) ?? chain,
      input.sealed_box as SealedBox,
      await e.near.chainTimeMs(),
    ),
  );
  if (!accepted.ok) {
    e.log('trust refused by the enclave', { trustId, reasons: accepted.reasons });
    return 'enclave refused';
  }
  for (;;) {
    const out = await effect('ack_trust', async () => {
      const now = await trustsOf(e).trust(trustId);
      if (now?.status !== 'awaiting_ack') return { ok: true as const, code: '' };
      const sent = await e.near.call(
        relayer(e),
        world.contract,
        'ack_trust',
        {
          trust_id: trustId,
          ack_json: accepted.ack.json,
          signature: accepted.ack.signature,
          enclave_key: accepted.ack.enclaveKey,
        },
        { gasTera: 100 },
      );
      return sent.ok ? { ok: true as const, code: '' } : { ok: false as const, code: sent.code };
    });
    if (out.ok) return 'active';
    if (!TRANSIENT.has(out.code)) return out.code;
    await sleep(TRANSIENT_WAIT_MS);
  }
}
export const trustCreatedWorkflow = DBOS.registerWorkflow(trustCreated, { name: 'trust_created' });

/**
 * Moves `tokens` whole tokens of a demo asset from the official into the trust account. The
 * simulator's solver mints the official's stake first (demo tokens have no market to buy them on).
 * Each step checks balances first, so a repeat after a crash moves nothing twice.
 */
async function fund(e: Engine, trustId: number, asset: string, tokens: bigint): Promise<void> {
  const world = trustWorldOf(e);
  const token = world.tokens.find((t) => `nep141:${t.account}` === asset);
  if (!token) return;
  const amount = tokens * 10n ** BigInt(token.decimals);
  const account = `t${trustId}.${world.contract}`;
  const balance = async (who: string) =>
    BigInt(
      await e.near
        .view<string>(token.account, 'ft_balance_of', { account_id: who })
        .catch(() => '0'),
    );
  await effect(`fund ${token.symbol}`, async () => {
    if ((await balance(account)) >= amount) return true;
    if ((await balance(e.world.founder)) < amount) {
      const minted = await e.near.call(solver(e), token.account, 'mint', {
        account_id: e.world.founder,
        amount: amount.toString(),
      });
      if (!minted.ok) throw new Error(`mint: ${minted.code}`);
    }
    const official = officialAccount(e);
    const registered = await e.near.call(
      official,
      token.account,
      'storage_deposit',
      { account_id: account, registration_only: true },
      { deposit: NEAR / 100n },
    );
    if (!registered.ok) throw new Error(`register: ${registered.code}`);
    const sent = await e.near.call(
      official,
      token.account,
      'ft_transfer',
      { receiver_id: account, amount: amount.toString(), memo: `trust ${trustId}` },
      { deposit: 1n },
    );
    if (!sent.ok) throw new Error(`transfer: ${sent.code}`);
    return true;
  });
}

// ── trust_trade ─────────────────────────────────────────────────────────────────────────────

type TradeOutcome =
  | { kind: 'traded'; txHash: string | null; receiptStatus: string }
  | { kind: 'refused'; code: string; txHash: string };

/**
 * Relays an enclave-signed trade, then follows the swap through 1Click until a final answer. The
 * contract's sequence number makes a trade land at most once; a repeat reads the receipt first.
 */
async function trustTrade(trustId: number, seq: number): Promise<string> {
  const e = durableEngine();
  const world = trustWorldOf(e);
  const row = await readStep('read trade', async () => {
    const [r] = await e.db
      .select()
      .from(trustTrades)
      .where(and(eq(trustTrades.trustId, trustId), eq(trustTrades.seq, seq)));
    return r
      ? {
          status: r.status,
          requestJson: r.requestJson,
          signature: r.signature,
          enclaveKey: r.enclaveKey,
          depositAddress: r.depositAddress,
          createdAtMs: r.createdAt.getTime(),
        }
      : null;
  });
  if (!row) return 'not found';
  if (row.status === 'signed') {
    let out: TradeOutcome;
    for (;;) {
      out = await effect('trade', async (): Promise<TradeOutcome> => {
        const before = await trustsOf(e).receipt(trustId, seq);
        if (before?.request_json === row.requestJson)
          return { kind: 'traded', txHash: null, receiptStatus: before.status };
        const sent = await e.near.call(
          relayer(e),
          world.contract,
          'trade',
          {
            trust_id: trustId,
            request_json: row.requestJson,
            signature: row.signature,
            enclave_key: row.enclaveKey,
          },
          { gasTera: 300, deposit: TRADE_DEPOSIT },
        );
        const receipt = await trustsOf(e).receipt(trustId, seq);
        // A lost response can come back as bad_seq; if the chain holds our request, it landed.
        if (receipt?.request_json === row.requestJson)
          return { kind: 'traded', txHash: sent.txHash, receiptStatus: receipt.status };
        if (sent.ok) return { kind: 'traded', txHash: sent.txHash, receiptStatus: 'failed' };
        return { kind: 'refused', code: sent.code, txHash: sent.txHash };
      });
      if (out.kind === 'refused' && TRANSIENT.has(out.code)) {
        await sleep(TRANSIENT_WAIT_MS);
        continue;
      }
      break;
    }
    if (out.kind === 'refused') {
      const refused = out;
      await inTx('record refusal', (db) =>
        trustTransition(db, trustId, seq, ['signed'], 'refused', {
          chainTx: refused.txHash,
          chainError: refused.code,
        }),
      );
      return `refused: ${refused.code}`;
    }
    let status = out.receiptStatus;
    while (status === 'pending') {
      await sleep(2_000);
      status =
        (await readStep('receipt status', () => trustsOf(e).receipt(trustId, seq)))?.status ??
        'failed';
    }
    const txHash = out.txHash;
    if (status !== 'done') {
      await inTx('record failure', (db) =>
        trustTransition(db, trustId, seq, ['signed'], 'failed_on_chain', {
          chainTx: txHash,
          chainError: 'transfer_failed',
        }),
      );
      return 'failed on chain';
    }
    await inTx('record trade', (db) =>
      trustTransition(db, trustId, seq, ['signed'], 'on_chain', { chainTx: txHash }),
    );
    await effect('submit deposit', () =>
      e.oneclick
        .submitDeposit({ txHash: txHash ?? '', depositAddress: row.depositAddress })
        .then(() => true)
        // Submitting only speeds detection up; 1Click finds the deposit without it.
        .catch(() => false),
    );
  }
  let inDoubt = row.status === 'in_doubt';
  for (;;) {
    const answer = await readStep('1click status', async () => {
      try {
        return (await e.oneclick.status(row.depositAddress)).status as string;
      } catch {
        return null;
      }
    });
    const final =
      answer === 'SUCCESS'
        ? 'settled'
        : answer === 'REFUNDED' || answer === 'INCOMPLETE_DEPOSIT'
          ? 'refunded'
          : answer === 'FAILED'
            ? 'settlement_failed'
            : null;
    if (final) {
      await inTx('record settlement', (db) =>
        trustTransition(db, trustId, seq, ['on_chain', 'in_doubt'], final, {
          settlementStatus: answer,
        }),
      );
      return final;
    }
    if (!inDoubt) {
      const overdue = await readStep(
        'overdue',
        async () => Date.now() - row.createdAtMs > e.config.SETTLE_IN_DOUBT_SECONDS * 1_000,
      );
      if (overdue)
        inDoubt = await inTx('mark in doubt', async (db) => {
          await trustTransition(db, trustId, seq, ['on_chain'], 'in_doubt');
          return true;
        });
    }
    await sleep(inDoubt ? IN_DOUBT_POLL_MS : SETTLE_POLL_MS);
  }
}
export const trustTradeWorkflow = DBOS.registerWorkflow(trustTrade, { name: 'trust_trade' });

// ── trust_release ───────────────────────────────────────────────────────────────────────────

/**
 * Ends a trust whose term is over or whose cancel took effect, then has the trust account send
 * every holding to the beneficiary. Anyone may do this on-chain; the engine does it so nobody
 * has to. A release of a token already sent moves nothing.
 */
async function trustRelease(trustId: number): Promise<string> {
  const e = durableEngine();
  const world = trustWorldOf(e);
  const ended = await effect('finalize', async () => {
    const chain = await trustsOf(e).trust(trustId);
    if (!chain) return 'not found';
    if (chain.status === 'ended') return 'ended';
    const out = await e.near.call(relayer(e), world.contract, 'finalize', { trust_id: trustId });
    return out.ok ? 'ended' : out.code;
  });
  if (ended !== 'ended') return ended;
  const chain = await readStep('read trust', () => trustsOf(e).trust(trustId));
  for (const token of chain?.holdings ?? [])
    await effect(`release ${token}`, async () => {
      const out = await e.near.call(
        relayer(e),
        world.contract,
        'release',
        { trust_id: trustId, token },
        { gasTera: 150 },
      );
      if (!out.ok) e.log('trust release failed', { trustId, token, code: out.code });
      return out.ok;
    });
  return 'released';
}
export const trustReleaseWorkflow = DBOS.registerWorkflow(trustRelease, { name: 'trust_release' });
