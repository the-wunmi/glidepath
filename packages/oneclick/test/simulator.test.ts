import {
  oneclickQuoteMessage,
  oneclickSignedBytes,
  parseNearKey,
  quoteCostWithinBound,
} from '@glidepath/core';
import { createDb, createPool, simOneClickQuotes } from '@glidepath/db';
import { runMigrations } from '@glidepath/db/migrate';
import type { MarketSettings } from '@glidepath/prices';
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOneClickSimulator,
  OneClickClient,
  type QuoteRequest,
  type SimAsset,
  type SimOutcome,
  type SimRails,
  simulatorPublicKey,
} from '../src/index.ts';

const SIM_SECRET = new Uint8Array(32).fill(3);

const pool = createPool();
const db = createDb(pool);

const ACME: SimAsset = {
  assetId: 'nep141:acme.sandbox',
  symbol: 'ACME',
  decimals: 18,
  blockchain: 'near',
  contractAddress: 'acme.sandbox',
};
const USDC: SimAsset = {
  assetId: 'nep141:usdc.sandbox',
  symbol: 'USDC',
  decimals: 6,
  blockchain: 'near',
  contractAddress: 'usdc.sandbox',
};
const market: MarketSettings = {
  assets: { ACME: { basePriceE6: '2000000' }, USDC: { basePriceE6: '1000000' } },
  sourceOffsetsBps: {},
  volatilityBps: 0,
};

/** Rails that only record what the simulator asked the chains to do. */
function fakeRails() {
  const deposits = new Map<string, bigint>();
  const calls: string[] = [];
  const rails: SimRails = {
    newDepositAddress: async () => {
      const address = crypto.randomUUID().replaceAll('-', '').padEnd(64, '0');
      return { address, key: 'k' };
    },
    depositedAmount: async (_a, address) => ({
      amount: deposits.get(address) ?? 0n,
      txHashes: ['tx-in'],
    }),
    refund: async (_a, d, to, amount) => {
      calls.push(`refund ${amount} to ${to} from ${d.address}`);
      return 'tx-refund';
    },
    pay: async (_a, to, amount) => {
      calls.push(`pay ${amount} to ${to}`);
      return 'tx-pay';
    },
  };
  return { rails, deposits, calls };
}

let outcomes: SimOutcome[] = [];
const rig = fakeRails();
const sim = createOneClickSimulator({
  db,
  assets: async () => [ACME, USDC],
  market: async () => market,
  takeOutcome: async () => outcomes.shift() ?? 'success',
  rails: rig.rails,
  now: () => Date.parse('2026-12-01T00:00:00Z'),
  signingSecret: SIM_SECRET,
});
/** The client in mock mode talks to the simulator over fetch, exactly like the live API. */
const client = new OneClickClient('http://sim', 'mock');
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
  sim.routes.request(String(input).replace('http://sim', ''), init)) as typeof fetch;

const request = (overrides: Partial<QuoteRequest> = {}): QuoteRequest => ({
  dry: false,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: ACME.assetId,
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: USDC.assetId,
  amount: (10n ** 21n).toString(),
  refundTo: 'p1.registry.sandbox',
  refundType: 'ORIGIN_CHAIN',
  recipient: 'founder.sandbox',
  recipientType: 'DESTINATION_CHAIN',
  deadline: '2026-12-01T00:10:00Z',
  ...overrides,
});

beforeAll(async () => {
  await runMigrations();
});
beforeEach(async () => {
  await db.delete(simOneClickQuotes);
  rig.calls.length = 0;
  outcomes = [];
});
afterAll(async () => {
  await pool.end();
});

const SIM_KEY = simulatorPublicKey(SIM_SECRET);

describe('the 1Click simulator', () => {
  it('prices a dry quote without a deposit address, with the no-JWT fee', async () => {
    const q = await client.quote(request({ dry: true }));
    // 1,000 ACME at $2 = $2,000, less 20 bps fee and 5 bps spread.
    expect(q.quote.amountOut).toBe('1995000000');
    expect(q.quote.minAmountOut).toBe('1975050000');
    expect(q.quote.depositAddress).toBeUndefined();
    expect(q.quoteRequest).toMatchObject({
      depositMode: 'SIMPLE',
      confidentiality: 'public',
      appFees: [{ fee: 20 }],
    });
    expect(q.signature).toMatch(/^ed25519:/);
  });

  it('gives a real quote a deposit address and a deadline three days past the request', async () => {
    const q = await client.quote(request());
    expect(q.quote.depositAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(q.quote.deadline).toBe('2026-12-04T00:10:00.000Z');
    expect((await client.status(q.quote.depositAddress!)).status).toBe('PENDING_DEPOSIT');
  });

  it('signs real quotes exactly as 1Click does, over base58(sha256(Q)), with its own key', async () => {
    const q = await client.quote(request());
    const message = oneclickSignedBytes(oneclickQuoteMessage(q));
    expect(
      ed25519.verify(parseNearKey(q.signature).bytes, message, parseNearKey(SIM_KEY).bytes),
    ).toBe(true);
    // The live-only fields are in Q for a real quote.
    expect(JSON.parse(oneclickQuoteMessage(q))).toMatchObject({
      dry: false,
      depositAddress: q.quote.depositAddress,
      deadline: q.quote.deadline,
    });
  });

  it('takes requested app fees out of the output, which the signed USD values then show', async () => {
    const q = await client.quote(
      request({ dry: true, appFees: [{ recipient: 'x.near', fee: 300 }] }),
    );
    // 20 bps 1Click fee + 300 bps app fee + 5 bps spread off $2,000.
    expect(q.quote.amountOut).toBe('1935000000');
    expect(quoteCostWithinBound(q.quote)).toBe(false);
  });

  it('answers an unknown deposit address with 404, as the real API does', async () => {
    await expect(client.status('f'.repeat(64))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a confidential quote without a JWT', async () => {
    await expect(client.quote(request({ confidentiality: 'basic' }))).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('moves a funded swap to SUCCESS and pays the recipient', async () => {
    const q = await client.quote(request());
    rig.deposits.set(q.quote.depositAddress!, 10n ** 21n);
    for (let i = 0; i < 3; i++) await sim.advance();
    const s = await client.status(q.quote.depositAddress!);
    expect(s.status).toBe('SUCCESS');
    expect(rig.calls).toEqual(['pay 1995000000 to founder.sandbox']);
  });

  it('refunds a partial deposit to refundTo as INCOMPLETE_DEPOSIT', async () => {
    const q = await client.quote(request());
    rig.deposits.set(q.quote.depositAddress!, 10n ** 20n);
    await sim.advance();
    const s = await client.status(q.quote.depositAddress!);
    expect(s.status).toBe('INCOMPLETE_DEPOSIT');
    expect(s.swapDetails.refundReason).toBe('PARTIAL_DEPOSIT');
    expect(rig.calls[0]).toContain('to p1.registry.sandbox');
  });

  it('rehearses a refund, a failure and a stall', async () => {
    outcomes = ['refund', 'fail', 'stall'];
    const quotes = [
      await client.quote(request()),
      await client.quote(request()),
      await client.quote(request()),
    ];
    for (const q of quotes) rig.deposits.set(q.quote.depositAddress!, 10n ** 21n);
    for (let i = 0; i < 4; i++) await sim.advance();
    const statuses = await Promise.all(quotes.map((q) => client.status(q.quote.depositAddress!)));
    expect(statuses.map((s) => s.status)).toEqual(['REFUNDED', 'FAILED', 'PROCESSING']);
  });
});
