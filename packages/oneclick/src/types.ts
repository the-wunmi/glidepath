import { z } from 'zod';

/**
 * 1Click API shapes, from https://1click.chaindefuser.com/docs/v0/openapi.yaml and live calls on
 * 2026-11-11. The simulator serves exactly these, so the client code is the same in mock and live
 * mode.
 */
export const SWAP_TYPES = ['EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT', 'ANY_INPUT'] as const;
export const DEPOSIT_TYPES = ['ORIGIN_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS'] as const;
export const RECIPIENT_TYPES = ['DESTINATION_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS'] as const;

export const STATUSES = [
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
] as const;
export type OneClickStatus = (typeof STATUSES)[number];

/** Statuses after which 1Click will not move the swap again. */
export const FINAL_STATUSES: readonly OneClickStatus[] = ['SUCCESS', 'REFUNDED', 'FAILED'];

export const TokenInfo = z.object({
  assetId: z.string(),
  decimals: z.int(),
  blockchain: z.string(),
  symbol: z.string(),
  price: z.number(),
  priceUpdatedAt: z.string(),
  contractAddress: z.string().optional(),
});
export type TokenInfo = z.infer<typeof TokenInfo>;

export const QuoteRequest = z.object({
  dry: z.boolean(),
  swapType: z.enum(SWAP_TYPES),
  /** Basis points: 100 = 1%. */
  slippageTolerance: z.number().int().min(0).max(10_000),
  originAsset: z.string().min(1),
  depositType: z.enum(DEPOSIT_TYPES),
  destinationAsset: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  refundTo: z.string().min(1),
  refundType: z.enum(DEPOSIT_TYPES),
  recipient: z.string().min(1),
  recipientType: z.enum(RECIPIENT_TYPES),
  deadline: z.iso.datetime(),
  depositMode: z.enum(['SIMPLE', 'MEMO']).optional(),
  confidentiality: z.enum(['public', 'basic', 'advanced']).optional(),
  quoteWaitingTimeMs: z.number().int().optional(),
  referral: z.string().optional(),
  appFees: z.array(z.object({ recipient: z.string(), fee: z.number().int() })).optional(),
  insured: z.boolean().optional(),
});
export type QuoteRequest = z.infer<typeof QuoteRequest>;

export const Quote = z.object({
  amountIn: z.string(),
  amountInFormatted: z.string(),
  amountInUsd: z.string(),
  minAmountIn: z.string(),
  amountOut: z.string(),
  amountOutFormatted: z.string(),
  amountOutUsd: z.string(),
  minAmountOut: z.string(),
  timeEstimate: z.number(),
  depositAddress: z.string().optional(),
  deadline: z.string().optional(),
  timeWhenInactive: z.string().optional(),
  refundFee: z.string().optional(),
  withdrawFee: z.string().optional(),
});
export type Quote = z.infer<typeof Quote>;

export const QuoteResponse = z.object({
  correlationId: z.string(),
  timestamp: z.string(),
  signature: z.string(),
  quoteRequest: z.record(z.string(), z.unknown()),
  quote: Quote,
});
export type QuoteResponse = z.infer<typeof QuoteResponse>;

const TxRef = z.object({ hash: z.string(), explorerUrl: z.string() });

export const SwapDetails = z.object({
  intentHashes: z.array(z.string()),
  nearTxHashes: z.array(z.string()),
  originChainTxHashes: z.array(TxRef),
  destinationChainTxHashes: z.array(TxRef),
  amountIn: z.string().nullish(),
  amountOut: z.string().nullish(),
  refundedAmount: z.string().nullish(),
  refundReason: z.string().nullish(),
  depositedAmount: z.string().nullish(),
});
export type SwapDetails = z.infer<typeof SwapDetails>;

export const StatusResponse = z.object({
  correlationId: z.string(),
  quoteResponse: QuoteResponse,
  status: z.enum(STATUSES),
  updatedAt: z.string(),
  swapDetails: SwapDetails,
});
export type StatusResponse = z.infer<typeof StatusResponse>;

export const SubmitDepositRequest = z.object({
  txHash: z.string().min(1),
  depositAddress: z.string().min(1),
  nearSenderAccount: z.string().optional(),
  memo: z.string().optional(),
});
export type SubmitDepositRequest = z.infer<typeof SubmitDepositRequest>;

export const emptySwapDetails = (): SwapDetails => ({
  intentHashes: [],
  nearTxHashes: [],
  originChainTxHashes: [],
  destinationChainTxHashes: [],
  refundedAmount: '0',
});
