import { DomainError, Hex32, parseInput, SealedBox } from '@glidepath/core';
import { trusts } from '@glidepath/db';
import type { KeyPairString, NearClient } from '@glidepath/near';
import { marketKey, marketPriceE6 } from '@glidepath/prices';
import {
  AssetId,
  type AssetPrice,
  type ChainTrust,
  type ChainTrustReceipt,
  type Holding,
  type TrustEnclaveEntry,
  TrustEnvelope,
  type TrustQuoteSigner,
  tokenOf,
} from '@glidepath/trust';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Engine } from '../context.ts';
import { startOnce } from '../durable.ts';
import { authorizePlan, newOwnerKey, type PlanPrincipal, spendRelayer } from '../guards.ts';
import { readSimSettings } from '../sim-settings.ts';
import { trustCreatedWorkflow } from './workflows.ts';
import type { TrustWorld } from './world.ts';

const NEAR = 10n ** 24n;
/** Pays the trust's storage (envelope, holdings) and the trust account's 0.1 NEAR; the rest is refunded. */
export const CREATE_TRUST_DEPOSIT = NEAR / 2n;
/** A trust in this prototype holds a few demo tokens; a million of one is far more than a demo needs. */
const MAX_DEPOSIT_TOKENS = 1_000_000n;
/** The contract's longest term is ten years; the Labs demo runs for at most one. */
const MAX_TERM_MS = 366 * 86_400_000;
const MAX_LABEL = 80;
/**
 * The shortest public gap between a trust's trades this server accepts: the contract's own
 * minimum (`MIN_GAP_MS`, one minute). With the per-trade relayer budget it bounds what one trust
 * can make the relayer spend.
 */
export const TRUST_MIN_GAP_MS = 60_000;

/** The contract's views, decoded the same way for every reader. */
export function trustReader(near: NearClient, contract: string) {
  return {
    trust: (id: number) => near.view<ChainTrust | null>(contract, 'get_trust', { trust_id: id }),
    receipts: (id: number) =>
      near.view<ChainTrustReceipt[]>(contract, 'get_receipts', { trust_id: id, limit: 50 }),
    async receipt(id: number, seq: number): Promise<ChainTrustReceipt | null> {
      const [r] = await near.view<ChainTrustReceipt[]>(contract, 'get_receipts', {
        trust_id: id,
        from_seq: seq,
        limit: 1,
      });
      return r && r.seq === seq ? r : null;
    },
    enclaves: () => near.view<TrustEnclaveEntry[]>(contract, 'get_enclaves', { limit: 50 }),
    quoteSigners: () => near.view<TrustQuoteSigner[]>(contract, 'get_quote_signers', { limit: 50 }),
    config: () =>
      near.view<{ min_cooling_off_ms: number; enclave_activation_delay_ms: number }>(
        contract,
        'get_config',
      ),
  };
}

/** The trust part of the world, or a clear refusal where the prototype is not deployed. */
export function trustWorldOf(e: Engine): TrustWorld {
  const t = e.world.trust;
  if (!t) throw new DomainError('unavailable', 'The blind trust prototype is not deployed here');
  return t;
}

export const trustsOf = (e: Engine) => trustReader(e.near, trustWorldOf(e).contract);

/** The official persona: the demo founder signs for the official, as it does for founders. */
export const officialAccount = (e: Engine) =>
  e.near.account(e.world.founder, e.world.keys[e.world.founder] as KeyPairString);

export const CreateTrustInput = z.object({
  label: z.string().max(MAX_LABEL),
  commitment: Hex32,
  sealed_box: SealedBox,
  envelope: TrustEnvelope,
  cooling_off_ms: z.int().min(0),
  end_ms: z.int().min(0),
  /** What the official moves into the trust, in whole tokens of the demo assets. */
  deposits: z
    .array(z.object({ asset: AssetId, tokens: z.string().regex(/^\d{1,7}$/) }))
    .min(1)
    .max(5),
});

/**
 * Creates a trust for the official persona: the contract records the commitment and envelope and
 * creates the keyless trust account; a durable workflow then funds it, hands the sealed mandate to
 * the enclave and relays its ack. Returns the owner key once (cancelling needs it).
 */
export async function createTrust(e: Engine, input: z.input<typeof CreateTrustInput>) {
  const world = trustWorldOf(e);
  const p = parseInput(CreateTrustInput, input);
  const now = await e.near.chainTimeMs();
  if (p.envelope.min_gap_ms < TRUST_MIN_GAP_MS)
    throw new DomainError('invalid', 'The minimum gap between trades is at least one minute');
  if (p.end_ms <= now || p.end_ms > now + MAX_TERM_MS)
    throw new DomainError('invalid', 'The term must end within a year from now');
  const known = new Set(world.tokens.map((t) => `nep141:${t.account}`));
  const assets = p.deposits.map((d) => d.asset);
  if (!assets.every((a) => known.has(a)) || new Set(assets).size !== assets.length)
    throw new DomainError('invalid', 'Deposits must name different assets offered here');
  if (p.deposits.some((d) => BigInt(d.tokens) === 0n || BigInt(d.tokens) > MAX_DEPOSIT_TOKENS))
    throw new DomainError('invalid', `Deposit between 1 and ${MAX_DEPOSIT_TOKENS} of each asset`);
  await spendRelayer(e);
  const owner = newOwnerKey();
  // Started before the chain call: if this process dies after the trust is created, the workflow
  // finds it on-chain, records it and carries on. If the call is refused, it ends.
  await startOnce(trustCreatedWorkflow, `trust:created:${p.commitment}`, p, owner.hash);
  const out = await e.near.call<number>(
    officialAccount(e),
    world.contract,
    'create_trust',
    {
      commitment: p.commitment,
      envelope: p.envelope,
      beneficiary: e.world.founder,
      cooling_off_ms: p.cooling_off_ms,
      end_ms: p.end_ms,
      holdings: assets.map(tokenOf),
      label: p.label,
    },
    { gasTera: 200, deposit: CREATE_TRUST_DEPOSIT },
  );
  if (!out.ok)
    throw new DomainError('policy_error', `The trust contract refused: ${out.code}`, {
      code: out.code,
      txHash: out.txHash,
    });
  return { trustId: out.value, txHash: out.txHash, ownerKey: owner.key };
}

/** Owner-only, through the owner key: a public cancel that takes effect after the cooling-off. */
export async function cancelTrust(e: Engine, principal: PlanPrincipal, trustId: number) {
  const [row] = await e.db.select().from(trusts).where(eq(trusts.id, trustId));
  if (!row) throw new DomainError('not_found', 'Trust not found');
  authorizePlan(row, principal);
  await spendRelayer(e);
  const out = await e.near.call(officialAccount(e), trustWorldOf(e).contract, 'cancel', {
    trust_id: trustId,
  });
  if (!out.ok)
    throw new DomainError('policy_error', `The trust contract refused: ${out.code}`, {
      code: out.code,
    });
  return { txHash: out.txHash };
}

/**
 * What the trust account holds and what it is worth, read from the chain and the simulated market
 * (the host's view, handed to the enclave as untrusted input).
 */
export async function trustMarketView(
  e: Engine,
  chain: ChainTrust,
): Promise<{ holdings: Holding[]; prices: AssetPrice[]; totalUsdE6: bigint }> {
  const world = trustWorldOf(e);
  const market = (await readSimSettings(e.db)).market;
  const holdings: Holding[] = [];
  const prices: AssetPrice[] = [];
  let total = 0n;
  // Market prices run on wall-clock time, like the 1Click simulator's quotes.
  const at = Date.now();
  for (const token of chain.holdings) {
    const known = world.tokens.find((t) => t.account === token);
    const decimals =
      known?.decimals ??
      (await e.near.view<{ decimals: number }>(token, 'ft_metadata').catch(() => null))?.decimals;
    if (decimals === undefined) continue;
    const amount = BigInt(
      await e.near
        .view<string>(token, 'ft_balance_of', { account_id: chain.trust_account })
        .catch(() => '0'),
    );
    const asset = `nep141:${token}`;
    holdings.push({ asset, amount: amount.toString(), decimals });
    let price: bigint | null = null;
    try {
      price = marketPriceE6(market, marketKey(market, token, known?.symbol ?? token), at);
    } catch {
      price = null;
    }
    if (price === null) continue;
    prices.push({ asset, price_usd_e6: price.toString() });
    total += (amount * price) / 10n ** BigInt(decimals);
  }
  return { holdings, prices, totalUsdE6: total };
}

/** Recorded trusts, newest first, with what the contract says about each. */
export async function listTrusts(e: Engine) {
  const rows = await e.db.select().from(trusts);
  const reader = trustsOf(e);
  const out = [];
  for (const row of rows.sort((a, b) => b.id - a.id)) {
    const chain = await reader.trust(row.id);
    if (chain) out.push({ id: row.id, label: row.label, status: chain.status });
  }
  return out;
}

/**
 * Everything the public trust page shows that only the server knows: the label, the total value
 * at simulated market prices, and the contract and token names. Receipts, the envelope and the
 * allowlist are read from the chain by the browser itself.
 */
export async function trustSummary(e: Engine, trustId: number) {
  const world = trustWorldOf(e);
  const [row] = await e.db.select().from(trusts).where(eq(trusts.id, trustId));
  const chain = await trustsOf(e).trust(trustId);
  if (!row || !chain) throw new DomainError('not_found', 'Trust not found');
  const view = await trustMarketView(e, chain);
  return {
    id: trustId,
    label: row.label,
    contract: world.contract,
    trustAccount: chain.trust_account,
    totalValueUsdE6: view.totalUsdE6.toString(),
    valuedAtMs: Date.now(),
  };
}
