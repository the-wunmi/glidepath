import { ed25519 } from '@noble/curves/ed25519.js';
import {
  formatNearKey,
  fromBaseUnits,
  oneclickQuoteMessage,
  oneclickSignedBytes,
  quoteValueDown,
} from '@vsp/core';
import { type Db, simOneClickQuotes } from '@vsp/db';
import { type MarketSettings, marketKey, marketPriceE6 } from '@vsp/prices';
import { and, eq, notInArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  emptySwapDetails,
  FINAL_STATUSES,
  type OneClickStatus,
  QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
  SubmitDepositRequest,
  type SwapDetails,
  type TokenInfo,
} from './types.ts';

/** An asset the simulator can swap, mapped to a chain contract it can watch and pay from. */
export interface SimAsset {
  assetId: string;
  symbol: string;
  decimals: number;
  blockchain: 'near' | 'eth';
  contractAddress: string;
}

/** What the simulator rehearses for the next swap. `stall` never finishes: an in-doubt payment. */
export const SIM_OUTCOMES = ['success', 'refund', 'fail', 'stall'] as const;
export type SimOutcome = (typeof SIM_OUTCOMES)[number];

/** The chain work the simulator needs; the engine implements it against the local chains. */
export interface SimRails {
  newDepositAddress(asset: SimAsset): Promise<{ address: string; key: string }>;
  depositedAmount(
    asset: SimAsset,
    address: string,
  ): Promise<{ amount: bigint; txHashes: string[] }>;
  refund(
    asset: SimAsset,
    deposit: { address: string; key: string },
    to: string,
    amount: bigint,
  ): Promise<string>;
  pay(asset: SimAsset, recipient: string, amount: bigint): Promise<string>;
}

export interface OneClickSimulatorDeps {
  db: Db;
  assets: () => Promise<SimAsset[]>;
  market: () => Promise<MarketSettings>;
  takeOutcome: () => Promise<SimOutcome>;
  rails: SimRails;
  now: () => number;
  /** 32-byte ed25519 secret the simulator signs quotes with, in 1Click's own format. */
  signingSecret: Uint8Array;
  /** The live price of a listed token, or null for a token priced on the simulated market. */
  listedPriceE6?: (symbol: string) => Promise<bigint | null>;
}

/** The fee 1Click adds without a partner JWT: 20 bps observed live on 2026-11-11. */
export const NO_JWT_FEE_BPS = 20;
const SIM_FEE_RECIPIENT = 'simulated-1click.near';
/** The simulated solvers' spread on top of the fee. */
const SOLVER_SPREAD_BPS = 5n;
/** Live quotes returned deadline = request deadline + 3 days. */
const DEADLINE_EXTENSION_MS = 3 * 86_400_000;

const usd = (amount: bigint, decimals: number, priceE6: bigint) =>
  fromBaseUnits(quoteValueDown(amount, priceE6, decimals, 6), 6, 6);

export function createOneClickSimulator(deps: OneClickSimulatorDeps) {
  const app = new Hono();
  const priceOf = async (asset: SimAsset) => {
    const listed = await deps.listedPriceE6?.(asset.symbol);
    if (listed != null) return listed;
    const market = await deps.market();
    return marketPriceE6(
      market,
      marketKey(market, asset.contractAddress, asset.symbol),
      deps.now(),
    );
  };
  const findAsset = async (id: string) => (await deps.assets()).find((a) => a.assetId === id);
  const error = (message: string, statusCode: 400 | 401 | 404) => ({
    body: { message, error: statusCode === 404 ? 'Not Found' : 'Bad Request', statusCode },
    statusCode,
  });

  app.get('/v0/tokens', async () => {
    const tokens: TokenInfo[] = [];
    for (const a of await deps.assets()) {
      const price = await priceOf(a);
      tokens.push({
        assetId: a.assetId,
        decimals: a.decimals,
        blockchain: a.blockchain,
        symbol: a.symbol,
        price: Number(fromBaseUnits(price, 6, 6)),
        priceUpdatedAt: new Date(deps.now()).toISOString(),
        contractAddress: a.contractAddress,
      });
    }
    return Response.json(tokens);
  });

  app.post('/v0/quote', async (c) => {
    const parsed = QuoteRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const e = error('Invalid quote request', 400);
      return c.json(e.body, e.statusCode);
    }
    const req = parsed.data;
    const jwt = c.req.header('authorization');
    if (req.confidentiality && req.confidentiality !== 'public' && !jwt) {
      const e = error('User authentication is required for confidential intent quotes', 401);
      return c.json(e.body, e.statusCode);
    }
    const origin = await findAsset(req.originAsset);
    const destination = await findAsset(req.destinationAsset);
    if (!origin || !destination || req.swapType !== 'EXACT_INPUT') {
      const e = error('Unsupported asset pair or swap type in the simulator', 400);
      return c.json(e.body, e.statusCode);
    }
    const quote = await buildQuote(req, origin, destination, jwt !== undefined);
    if (req.dry) return Response.json(quote);

    const deposit = await deps.rails.newDepositAddress(origin);
    const deadline = new Date(Date.parse(req.deadline) + DEADLINE_EXTENSION_MS).toISOString();
    const full: QuoteResponse = {
      ...quote,
      quote: {
        ...quote.quote,
        depositAddress: deposit.address,
        deadline,
        timeWhenInactive: deadline,
      },
    };
    full.signature = sign(full);
    await deps.db.insert(simOneClickQuotes).values({
      depositAddress: deposit.address,
      correlationId: full.correlationId,
      depositKey: deposit.key,
      response: full,
      status: 'PENDING_DEPOSIT',
      outcome: await deps.takeOutcome(),
      swapDetails: emptySwapDetails(),
    });
    return Response.json(full);
  });

  app.get('/v0/status', async (c) => {
    const address = c.req.query('depositAddress') ?? '';
    const row = await load(address);
    if (!row) {
      const e = error(`Deposit address ${address} not found`, 404);
      return c.json(e.body, e.statusCode);
    }
    return Response.json(statusView(row));
  });

  app.post('/v0/deposit/submit', async (c) => {
    const parsed = SubmitDepositRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const e = error('Invalid deposit submission', 400);
      return c.json(e.body, e.statusCode);
    }
    const row = await load(parsed.data.depositAddress);
    if (!row) {
      const e = error(`Deposit address ${parsed.data.depositAddress} not found`, 404);
      return c.json(e.body, e.statusCode);
    }
    // Through the shared pass, so a submission never races the worker's loop on the same swap.
    await advance();
    return Response.json(statusView((await load(row.depositAddress)) ?? row));
  });

  async function buildQuote(
    req: QuoteRequest,
    origin: SimAsset,
    destination: SimAsset,
    hasJwt: boolean,
  ): Promise<QuoteResponse> {
    const amountIn = BigInt(req.amount);
    const originPrice = await priceOf(origin);
    const destinationPrice = await priceOf(destination);
    // 1Click's own fee without a partner key, plus any app fees the requester asked for (each pays
    // its own recipient). The signature covers neither list, only the amounts that result.
    const requestedFees = (req.appFees ?? []).reduce((sum, f) => sum + BigInt(f.fee), 0n);
    const fee = (hasJwt ? 0n : BigInt(NO_JWT_FEE_BPS)) + requestedFees;
    // amountIn × originPrice ÷ destinationPrice, rescaled between decimals, rounded down.
    const gross =
      (amountIn * originPrice * 10n ** BigInt(destination.decimals)) /
      (10n ** BigInt(origin.decimals) * destinationPrice);
    const keptBps = 10_000n - fee - SOLVER_SPREAD_BPS;
    const amountOut = keptBps > 0n ? (gross * keptBps) / 10_000n : 0n;
    const minAmountOut = (amountOut * (10_000n - BigInt(req.slippageTolerance))) / 10_000n;
    const echoed = {
      depositMode: 'SIMPLE',
      confidentiality: 'public',
      quoteWaitingTimeMs: 0,
      insured: false,
      ...req,
      ...(hasJwt && !req.appFees
        ? {}
        : {
            appFees: [
              ...(req.appFees ?? []),
              ...(hasJwt ? [] : [{ recipient: SIM_FEE_RECIPIENT, fee: NO_JWT_FEE_BPS }]),
            ],
          }),
    };
    const response: QuoteResponse = {
      correlationId: crypto.randomUUID(),
      timestamp: new Date(deps.now()).toISOString(),
      signature: '',
      quoteRequest: echoed,
      quote: {
        amountIn: amountIn.toString(),
        amountInFormatted: fromBaseUnits(amountIn, origin.decimals),
        amountInUsd: usd(amountIn, origin.decimals, originPrice),
        minAmountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        amountOutFormatted: fromBaseUnits(amountOut, destination.decimals),
        amountOutUsd: usd(amountOut, destination.decimals, destinationPrice),
        minAmountOut: minAmountOut.toString(),
        timeEstimate: 20,
        refundFee: '0',
        withdrawFee: '0',
      },
    };
    response.signature = sign(response);
    return response;
  }

  /**
   * Signs exactly as 1Click does (verified against a live quote): ed25519 over the text of
   * base58(sha256(Q)). Only the key differs: the simulator's own, registered in mock mode.
   */
  function sign(response: QuoteResponse): string {
    const message = oneclickSignedBytes(oneclickQuoteMessage(response));
    return formatNearKey('ed25519', ed25519.sign(message, deps.signingSecret));
  }

  type Row = typeof simOneClickQuotes.$inferSelect;

  async function load(address: string): Promise<Row | undefined> {
    const [row] = await deps.db
      .select()
      .from(simOneClickQuotes)
      .where(eq(simOneClickQuotes.depositAddress, address));
    return row;
  }

  function statusView(row: Row): StatusResponse {
    const response = row.response as QuoteResponse;
    return {
      correlationId: row.correlationId,
      quoteResponse: response,
      status: row.status as OneClickStatus,
      updatedAt: row.updatedAt.toISOString(),
      swapDetails: row.swapDetails as SwapDetails,
    };
  }

  async function save(row: Row, status: OneClickStatus, details: Partial<SwapDetails>) {
    await deps.db
      .update(simOneClickQuotes)
      .set({
        status,
        swapDetails: { ...(row.swapDetails as SwapDetails), ...details },
        updatedAt: new Date(deps.now()),
      })
      .where(
        and(
          eq(simOneClickQuotes.depositAddress, row.depositAddress),
          eq(simOneClickQuotes.status, row.status),
        ),
      );
  }

  /** Moves one swap a single step, the way the real service's status advances between polls. */
  async function advanceOne(row: Row): Promise<void> {
    const response = row.response as QuoteResponse;
    const origin = await findAsset(String(response.quoteRequest.originAsset));
    const destination = await findAsset(String(response.quoteRequest.destinationAsset));
    if (!origin || !destination) return;
    const amountIn = BigInt(response.quote.amountIn);
    const deposit = { address: row.depositAddress, key: row.depositKey };
    const refundTo = String(response.quoteRequest.refundTo);

    switch (row.status as OneClickStatus) {
      case 'PENDING_DEPOSIT': {
        const seen = await deps.rails.depositedAmount(origin, row.depositAddress);
        if (seen.amount === 0n) return;
        const originChainTxHashes = seen.txHashes.map((hash) => ({ hash, explorerUrl: '' }));
        if (seen.amount < amountIn) {
          const refund = await deps.rails.refund(origin, deposit, refundTo, seen.amount);
          await save(row, 'INCOMPLETE_DEPOSIT', {
            depositedAmount: seen.amount.toString(),
            refundedAmount: seen.amount.toString(),
            refundReason: 'PARTIAL_DEPOSIT',
            originChainTxHashes: [...originChainTxHashes, { hash: refund, explorerUrl: '' }],
          });
          return;
        }
        await save(row, 'KNOWN_DEPOSIT_TX', {
          depositedAmount: seen.amount.toString(),
          originChainTxHashes,
        });
        return;
      }
      case 'KNOWN_DEPOSIT_TX':
        await save(row, 'PROCESSING', { amountIn: amountIn.toString() });
        return;
      case 'PROCESSING': {
        if (row.outcome === 'stall') return;
        if (row.outcome === 'fail') {
          await save(row, 'FAILED', {});
          return;
        }
        // Re-price at execution: if the market moved below the guaranteed output, refund.
        const echoed = response.quoteRequest as QuoteRequest;
        // The echo carries 1Click's own fee entry; drop it so it is not charged twice.
        const requested = echoed.appFees?.filter((f) => f.recipient !== SIM_FEE_RECIPIENT);
        const live = await buildQuote(
          { ...echoed, dry: true, appFees: requested?.length ? requested : undefined },
          origin,
          destination,
          !paysNoJwtFee(response),
        );
        const out = BigInt(live.quote.amountOut);
        if (row.outcome === 'refund' || out < BigInt(response.quote.minAmountOut)) {
          const refund = await deps.rails.refund(origin, deposit, refundTo, amountIn);
          await save(row, 'REFUNDED', {
            refundedAmount: amountIn.toString(),
            refundReason: row.outcome === 'refund' ? 'SOLVER_REFUSED' : 'PRICE_BELOW_MIN_OUT',
            originChainTxHashes: [
              ...((row.swapDetails as SwapDetails).originChainTxHashes ?? []),
              { hash: refund, explorerUrl: '' },
            ],
          });
          return;
        }
        const paid = await deps.rails.pay(
          destination,
          String(response.quoteRequest.recipient),
          out,
        );
        await save(row, 'SUCCESS', {
          amountOut: out.toString(),
          nearTxHashes: [paid],
          destinationChainTxHashes: [{ hash: paid, explorerUrl: '' }],
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * One pass over every unfinished swap. Passes never overlap: a call while one is running shares
   * it, so two callers (the worker's loop, a deposit submission, a test) never pay or refund the
   * same swap twice.
   */
  let running: Promise<void> | null = null;
  function advance(): Promise<void> {
    running ??= (async () => {
      const open = await deps.db
        .select()
        .from(simOneClickQuotes)
        .where(notInArray(simOneClickQuotes.status, [...FINAL_STATUSES, 'INCOMPLETE_DEPOSIT']));
      for (const row of open) await advanceOne(row);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return { routes: app, advance };
}

export const SimOutcomeQueue = z.array(z.enum(SIM_OUTCOMES)).max(20);

/** The simulator's quote-signing public key, so the quote signature can be checked. */
export const simulatorPublicKey = (secret: Uint8Array) =>
  formatNearKey('ed25519', ed25519.getPublicKey(secret));

const paysNoJwtFee = (response: QuoteResponse): boolean =>
  Array.isArray(response.quoteRequest.appFees) &&
  (response.quoteRequest.appFees as { recipient?: string }[]).some(
    (f) => f.recipient === SIM_FEE_RECIPIENT,
  );
