import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError, toBaseUnits } from '@vsp/core';
import { type Db, dailyUsage, type plans } from '@vsp/db';
import { sql } from 'drizzle-orm';
import type { Engine } from './context.ts';

/**
 * Who is asking to manage a plan: the operator (OPERATOR_TOKEN, checked by the API), or whoever
 * presents a plan's owner key. The `actor` in a request body only picks the persona that signs;
 * it never authorizes anything.
 */
export interface PlanPrincipal {
  operator: boolean;
  /** The `x-plan-key` header as sent, unchecked. */
  planKey: string | null;
}

/** Scripts and tests acting for the server itself. */
export const OPERATOR: PlanPrincipal = { operator: true, planKey: null };

/**
 * A refusal for capacity rather than for the request: `busy` (503) when the server's own funds
 * are low, `rate_limited` (429) when a cap is used up. Not a DomainError code because
 * packages/core is part of the registered enclave measurement and cannot change for this.
 */
export class LimitError extends Error {
  constructor(
    readonly code: 'busy' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'LimitError';
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest();

/** A new plan's owner key (32 random bytes, hex) and the hash the database keeps. */
export function newOwnerKey(): { key: string; hash: string } {
  const key = randomBytes(32).toString('hex');
  return { key, hash: sha256(key).toString('hex') };
}

/** Constant-time comparison of a presented secret with the expected one, through their hashes. */
export function sameSecret(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/** Throws unless the principal may manage this plan: the operator, or the holder of its key. */
export function authorizePlan(
  row: Pick<typeof plans.$inferSelect, 'ownerKeyHash'>,
  principal: PlanPrincipal,
): void {
  if (principal.operator) return;
  const key = principal.planKey;
  const ok =
    !!row.ownerKeyHash &&
    !!key &&
    /^[0-9a-f]{64}$/i.test(key) &&
    timingSafeEqual(sha256(key.toLowerCase()), Buffer.from(row.ownerKeyHash, 'hex'));
  if (!ok) throw new DomainError('forbidden', 'This plan’s key is required to manage it');
}

const DAY_MS = 86_400_000;

/** The server's caps, as /api/meta shows them. maxPlanDays is null when plans may run any length. */
export function serverLimits(e: Engine) {
  const testnet = e.world.network === 'testnet';
  return {
    plansPerDay: e.config.MAX_PLANS_PER_DAY,
    launchesPerDay: e.config.MAX_LAUNCHES_PER_DAY,
    relayerWritesPerDay: e.config.MAX_RELAYER_WRITES_PER_DAY,
    maxPlanDays: e.config.MAX_PLAN_DAYS ?? (testnet ? 30 : null),
    nearTokens: nearTokensEnabled(e),
  };
}

/**
 * Whether NEAR-token plans are offered. Each launch deploys the demo token: about 1.9 NEAR of
 * storage with its own copy of the code, a fraction of that with the published global code.
 */
export function nearTokensEnabled(e: Engine): boolean {
  if (e.config.NEAR_TOKEN_LAUNCHES) return e.config.NEAR_TOKEN_LAUNCHES === 'on';
  return e.world.network !== 'testnet' || Boolean(e.world.demoTokenCodeHash);
}

/** Refuses a plan that would run past this server's longest plan; `nowMs` is chain time. */
export function assertPlanLength(e: Engine, endMs: number, nowMs: number): void {
  const days = serverLimits(e).maxPlanDays;
  if (days !== null && endMs > nowMs + days * DAY_MS)
    throw new DomainError(
      'invalid',
      `Plans on this server can run at most ${days} days from now; choose an earlier end`,
    );
}

export type DailyKind = 'plan_created' | 'token_launched' | 'relayer_write';

const DAILY_MESSAGES: Record<DailyKind, string> = {
  plan_created: 'Today’s limit for new plans is reached; try again after 00:00 UTC',
  token_launched: 'Today’s limit for token launches is reached; try again after 00:00 UTC',
  relayer_write: 'Today’s limit for on-chain actions is reached; try again after 00:00 UTC',
};

/**
 * Counts one spending action against today's (UTC) cap, or refuses it. One statement, so two
 * requests racing for the last slot cannot both get it.
 */
export async function chargeDaily(db: Db, kind: DailyKind, max: number): Promise<void> {
  const rows = await db
    .insert(dailyUsage)
    .values({ day: sql`(now() at time zone 'utc')::date`, kind, used: 1 })
    .onConflictDoUpdate({
      target: [dailyUsage.day, dailyUsage.kind],
      set: { used: sql`${dailyUsage.used} + 1` },
      setWhere: sql`${dailyUsage.used} < ${max}`,
    })
    .returning({ used: dailyUsage.used });
  // A first insert always succeeds, so a cap of 0 is checked here.
  if (!rows.length || (rows[0]?.used ?? 0) > max)
    throw new LimitError('rate_limited', DAILY_MESSAGES[kind]);
}

/** Balance reads are cached this long: a burst of requests costs one RPC call, not one each. */
const BALANCE_TTL_MS = 30_000;
const balances = new Map<string, { at: number; value: Promise<bigint> }>();

function cachedBalance(key: string, read: () => Promise<bigint>): Promise<bigint> {
  const hit = balances.get(key);
  if (hit && Date.now() - hit.at < BALANCE_TTL_MS) return hit.value;
  const value = read();
  balances.set(key, { at: Date.now(), value });
  // A failed read is not cached: the next request tries again.
  value.catch(() => balances.delete(key));
  return value;
}

const BUSY = 'Glidepath is busy right now; try again later';

/**
 * Refuses a spending action while the server's own testnet funds are under their reserve, so a
 * flood of requests cannot drain the relayer (NEAR) or the Sepolia funder (ETH) to zero. The
 * local network spends free sandbox funds and has no reserve.
 */
export async function assertReserve(e: Engine, chain: 'near' | 'evm'): Promise<void> {
  if (e.world.network !== 'testnet') return;
  if (chain === 'near') {
    const relayer = e.world.relayer;
    const held = await cachedBalance(`near:${relayer}`, async () =>
      BigInt((await e.near.accountState(relayer)).amount),
    );
    if (held < toBaseUnits(e.config.NEAR_RESERVE, 24)) throw new LimitError('busy', BUSY);
    return;
  }
  if (e.evm.local) return;
  const funder = e.evm.funderAddress;
  const held = await cachedBalance(`evm:${funder}`, () => e.evm.ethBalance(funder));
  if (held < toBaseUnits(e.config.EVM_RESERVE, 18)) throw new LimitError('busy', BUSY);
}

/**
 * Before a write the relayer pays for, once the request is valid and authorized: the reserve
 * floor, then one unit of the shared daily budget for all such writes.
 */
export async function spendRelayer(e: Engine): Promise<void> {
  await assertReserve(e, 'near');
  await chargeDaily(e.db, 'relayer_write', e.config.MAX_RELAYER_WRITES_PER_DAY);
}
