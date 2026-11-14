import { oneclickQuoteMessage } from '@glidepath/core';
import { trusts, trustTrades } from '@glidepath/db';
import type { ChainTrust } from '@glidepath/trust';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Engine } from '../context.ts';
import { startOnce } from '../durable.ts';
import { LimitError, spendRelayer } from '../guards.ts';
import { trustEnclaveOf } from './enclave.ts';
import { trustMarketView, trustsOf } from './service.ts';
import { trustReleaseWorkflow, trustTradeWorkflow } from './workflows.ts';

/** How often the worker wakes each trust. The enclave decides; most wake-ups hold. */
export const TRUST_TICK_MS = 15_000;

/** A trade not yet on-chain or not yet paid out: the trust waits for it before deciding again. */
const UNSETTLED = ['signed', 'on_chain'];

export type TrustTickOutcome =
  | { trustId: number; outcome: 'idle'; reason: string }
  | { trustId: number; outcome: 'skipped' }
  | { trustId: number; outcome: 'traded'; seq: number }
  | { trustId: number; outcome: 'ending' }
  | { trustId: number; outcome: 'ended' };

/**
 * One wake-up for each recorded trust (or the ones named): the enclave sees the trust account's
 * balances and prices and may decide one trade; the engine fetches the 1Click quote it asks for
 * and hands it back; a signed trade goes to the durable `trust_trade` workflow. A trust whose
 * term is over or whose cancel took effect is ended and released by `trust_release`.
 */
export async function tickTrusts(e: Engine, ids?: number[]): Promise<TrustTickOutcome[]> {
  if (!e.world.trust) return [];
  // Ended trusts are never woken again: nothing they do can change.
  const open = isNull(trusts.endedAt);
  const rows = await e.db
    .select({ id: trusts.id })
    .from(trusts)
    .where(ids?.length ? and(open, inArray(trusts.id, ids)) : open);
  const out: TrustTickOutcome[] = [];
  for (const row of rows) {
    try {
      const outcome = await tickTrust(e, row.id);
      if (outcome) out.push(outcome);
    } catch (error) {
      e.log('trust tick failed', { trustId: row.id, error: String(error) });
    }
  }
  return out;
}

async function tickTrust(e: Engine, trustId: number): Promise<TrustTickOutcome | null> {
  const chain = await trustsOf(e).trust(trustId);
  if (chain?.status === 'ended') {
    await e.db.update(trusts).set({ endedAt: new Date() }).where(eq(trusts.id, trustId));
    return { trustId, outcome: 'ended' };
  }
  if (chain?.status !== 'active') return null;
  const now = await e.near.chainTimeMs();
  if (ending(chain, now)) {
    await startOnce(trustReleaseWorkflow, `trust:release:${trustId}`, trustId);
    return { trustId, outcome: 'ending' };
  }
  const [inFlight] = await e.db
    .select({ seq: trustTrades.seq })
    .from(trustTrades)
    .where(and(eq(trustTrades.trustId, trustId), inArray(trustTrades.status, UNSETTLED)));
  if (inFlight) return { trustId, outcome: 'idle', reason: 'waiting' };

  const enclave = trustEnclaveOf(e);
  const view = await trustMarketView(e, chain);
  const decided = await enclave.tick(chain, { holdings: view.holdings, prices: view.prices }, now);
  if (decided.type === 'idle') return { trustId, outcome: 'idle', reason: decided.reason };
  // Each trade the relayer pays for (about 0.1 NEAR of deposit and gas) waits while the relayer is
  // under its reserve floor, like every plan write.
  try {
    await spendRelayer(e);
  } catch (error) {
    if (error instanceof LimitError) return { trustId, outcome: 'idle', reason: error.code };
    throw error;
  }
  const quote = await e.oneclick.quote(decided.quoteRequest);
  const signed = await enclave.trade(
    chain,
    {
      payload: oneclickQuoteMessage(quote),
      signature: quote.signature,
      correlation_id: quote.correlationId,
    },
    await e.near.chainTimeMs(),
  );
  if (signed.type === 'idle') return { trustId, outcome: 'idle', reason: signed.reason };
  if (signed.type === 'skipped') return { trustId, outcome: 'skipped' };
  const depositAddress = quote.quote.depositAddress ?? '';
  await e.db
    .insert(trustTrades)
    .values({
      trustId,
      seq: signed.seq,
      depositAddress,
      requestJson: signed.request.json,
      signature: signed.request.signature,
      enclaveKey: signed.request.enclaveKey,
      status: 'signed',
    })
    .onConflictDoNothing();
  await startOnce(trustTradeWorkflow, `trust:trade:${trustId}:${signed.seq}`, trustId, signed.seq);
  return { trustId, outcome: 'traded', seq: signed.seq };
}

function ending(chain: ChainTrust, now: number): boolean {
  const c = chain.pending_change;
  return now >= chain.end_ms || (c?.kind === 'cancel' && c.effective_at_ms <= now);
}

/** Wakes every trust on its own interval, beside the plans' worker. Returns a stop function. */
export function startTrustWorker(e: Engine): () => void {
  if (!e.world.trust) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void tickTrusts(e)
      .catch((error) => e.log('trust worker failed', { error: String(error) }))
      .finally(() => {
        running = false;
      });
  }, TRUST_TICK_MS);
  return () => clearInterval(timer);
}
