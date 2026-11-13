import { type Db, simSettings } from '@vsp/db';
import { SIM_OUTCOMES, type SimOutcome } from '@vsp/oneclick';
import { MarketSettings } from '@vsp/prices';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

/** Prices are keyed by token address (`marketKey`); one entry per launched demo token is plenty. */
const MAX_MARKET_ASSETS = 64;

/**
 * Everything a demo operator can change about the simulated outside world, in one row: market
 * prices, a manipulated price feed, the outcome of the next 1Click swaps, and whether the enclave
 * and the MPC network are up. The UI shows all of it under "Simulation controls".
 */
export const SimSettings = z.object({
  market: MarketSettings.refine((m) => Object.keys(m.assets).length <= MAX_MARKET_ASSETS, {
    message: `At most ${MAX_MARKET_ASSETS} simulated assets`,
  }),
  oneclickOutcomes: z.array(z.enum(SIM_OUTCOMES)).max(20).default([]),
  enclaveUp: z.boolean().default(true),
  mpcUp: z.boolean().default(true),
});
export type SimSettings = z.output<typeof SimSettings>;

/** Demo tokens get their price when they launch; only the world's USDC is priced from the start. */
export const defaultSimSettings = (usdc?: string): SimSettings => ({
  market: {
    assets: usdc ? { [usdc]: { basePriceE6: '1000000' } } : {},
    sourceOffsetsBps: {},
    volatilityBps: 150,
  },
  oneclickOutcomes: [],
  enclaveUp: true,
  mpcUp: true,
});

export async function readSimSettings(db: Db): Promise<SimSettings> {
  const [row] = await db.select().from(simSettings).where(eq(simSettings.id, 1));
  return SimSettings.parse(row?.data ?? defaultSimSettings());
}

export async function writeSimSettings(db: Db, settings: SimSettings): Promise<void> {
  await db
    .insert(simSettings)
    .values({ id: 1, data: settings })
    .onConflictDoUpdate({ target: simSettings.id, set: { data: settings, updatedAt: new Date() } });
}

/**
 * Changes the settings under a row lock, so two writers (two launches pricing their tokens) cannot
 * each read the old row and overwrite the other's change.
 */
export async function updateSimSettings(db: Db, change: (s: SimSettings) => void): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .execute<{ data: unknown }>(sql`select data from sim_settings where id = 1 for update`)
      .then((r) => r.rows);
    const settings = SimSettings.parse(row?.data ?? defaultSimSettings());
    change(settings);
    await tx
      .insert(simSettings)
      .values({ id: 1, data: settings })
      .onConflictDoUpdate({
        target: simSettings.id,
        set: { data: settings, updatedAt: new Date() },
      });
  });
}

/**
 * Pops the next rehearsed 1Click outcome, defaulting to success. Locked so two quotes never take
 * the same queued outcome.
 */
export async function takeOneClickOutcome(db: Db): Promise<SimOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .execute<{ data: unknown }>(sql`select data from sim_settings where id = 1 for update`)
      .then((r) => r.rows);
    const settings = SimSettings.parse(row?.data ?? defaultSimSettings());
    const [next, ...rest] = settings.oneclickOutcomes;
    if (!next) return 'success';
    await tx
      .update(simSettings)
      .set({ data: { ...settings, oneclickOutcomes: rest }, updatedAt: new Date() })
      .where(eq(simSettings.id, 1));
    return next;
  });
}
