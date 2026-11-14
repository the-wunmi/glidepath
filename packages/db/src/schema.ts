import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * The deployed world: contract accounts, token addresses and, in local mode, the sandbox keys of
 * the demo personas. One row. Local chains are fresh on every start, so a changed genesis hash
 * means every chain-derived row below belongs to a world that no longer exists.
 */
export const world = pgTable('world', {
  id: integer('id').primaryKey().default(1),
  genesisHash: text('genesis_hash').notNull(),
  config: jsonb('config').notNull(),
  createdAt: createdAt(),
});

/**
 * The app's index of plans. The server never sees a plan in plaintext: it keeps the ciphertext
 * sealed to the enclave key so it can hand it over, plus the public facts that are on-chain anyway.
 */
export const plans = pgTable(
  'plans',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    owner: text('owner').notNull(),
    label: text('label').notNull(),
    tokenChain: text('token_chain').notNull(),
    tokenAddress: text('token_address').notNull(),
    tokenSymbol: text('token_symbol').notNull(),
    tokenDecimals: integer('token_decimals').notNull(),
    commitment: text('commitment').notNull(),
    sealedBox: jsonb('sealed_box').notNull(),
    /** A change's ciphertext waits here until its cooling-off ends and the enclave picks it up. */
    pendingSealedBox: jsonb('pending_sealed_box'),
    /** The same plan sealed to each backup enclave build (`[{ signingKey, box }]`). */
    backupBoxes: jsonb('backup_boxes').notNull().default([]),
    /** A pending change sealed to each backup build, staged with the main one. */
    pendingBackupBoxes: jsonb('pending_backup_boxes').notNull().default([]),
    planAccount: text('plan_account').notNull(),
    createTx: text('create_tx').notNull(),
    /**
     * sha256 (hex) of the owner key handed out once at creation; every owner write must present
     * the key. Null for plans created before keys existed: only the operator manages those.
     */
    ownerKeyHash: text('owner_key_hash'),
    /**
     * Set once this plan launched its token: the only token it may enroll more of, up to the
     * founder allocation that launch minted (base units). Null: never launched here.
     */
    launchedToken: text('launched_token'),
    founderAllocation: numeric('founder_allocation', { precision: 78, scale: 0 }),
    /** Base units enrolled so far through the app; never more than founderAllocation. */
    enrolled: numeric('enrolled', { precision: 78, scale: 0 }).notNull().default('0'),
    createdAt: createdAt(),
  },
  (t) => [
    index('plans_owner').on(t.owner),
    // A token is launched by one plan only, so no other plan can enroll or release it.
    uniqueIndex('plans_launched_token').on(t.launchedToken),
  ],
);

/**
 * The enclave's sealed storage: opaque boxes only the enclave's sealing key opens (sealed plans,
 * salts, schedule state). Mirrors how a TEE persists state through an untrusted host.
 */
export const enclaveStore = pgTable('enclave_store', {
  key: text('key').primaryKey(),
  box: jsonb('box').notNull(),
  updatedAt: updatedAt(),
});

/**
 * One row per sale the enclave decided on. Status only moves forward through the engine's single
 * transition function; a sale with no final answer from 1Click is in_doubt, never failed.
 */
export const executions = pgTable(
  'executions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    planId: bigint('plan_id', { mode: 'number' }).notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    amount: text('amount').notNull(),
    correlationId: text('correlation_id').notNull(),
    depositAddress: text('deposit_address').notNull(),
    minAmountOut: text('min_amount_out').notNull(),
    quote: jsonb('quote').notNull(),
    requestJson: text('request_json').notNull(),
    signature: text('signature').notNull(),
    enclaveKey: text('enclave_key').notNull(),
    status: text('status').notNull(),
    chainTx: text('chain_tx'),
    chainError: text('chain_error'),
    evmTxHash: text('evm_tx_hash'),
    /** EVM block number when the current signed transfer was sent; a stuck one is re-signed. */
    evmSentAtBlock: bigint('evm_sent_at_block', { mode: 'number' }),
    /** How many times the transfer was re-signed with higher fees. */
    evmResigns: integer('evm_resigns').notNull().default(0),
    settlementStatus: text('settlement_status'),
    amountOut: text('amount_out'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('executions_plan_seq').on(t.planId, t.seq),
    index('executions_status').on(t.status),
  ],
);

/** Append-only activity log shown in the founder's timeline. Never updated or deleted. */
export const activity = pgTable(
  'activity',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    planId: bigint('plan_id', { mode: 'number' }),
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    at: createdAt(),
  },
  (t) => [index('activity_plan').on(t.planId, t.at)],
);

/**
 * Settings of the local simulators (market prices, injected faults). One row; everything a demo
 * operator can change lives here so it shows up in one place, labelled as simulation.
 */
export const simSettings = pgTable('sim_settings', {
  id: integer('id').primaryKey().default(1),
  data: jsonb('data').notNull(),
  updatedAt: updatedAt(),
});

/** The 1Click simulator's quotes. Mirrors what the real service tracks per deposit address. */
export const simOneClickQuotes = pgTable(
  'sim_oneclick_quotes',
  {
    depositAddress: text('deposit_address').primaryKey(),
    correlationId: text('correlation_id').notNull(),
    /** Simulator-held key for the deposit address, so it can refund. Never exists in live mode. */
    depositKey: text('deposit_key').notNull(),
    response: jsonb('response').notNull(),
    status: text('status').notNull(),
    outcome: text('outcome').notNull(),
    swapDetails: jsonb('swap_details').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sim_oneclick_correlation').on(t.correlationId)],
);

/**
 * Blind trusts (Labs prototype). Like plans, the server never sees a mandate: it keeps the box
 * sealed to the enclave so it can hand it over, plus what is on-chain anyway.
 */
export const trusts = pgTable('trusts', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  owner: text('owner').notNull(),
  label: text('label').notNull(),
  commitment: text('commitment').notNull(),
  sealedBox: jsonb('sealed_box').notNull(),
  trustAccount: text('trust_account').notNull(),
  /** The deposit the official makes into the trust: `[{ asset, amount }]`, base units. */
  deposits: jsonb('deposits').notNull(),
  createTx: text('create_tx').notNull(),
  /** sha256 (hex) of the owner key handed out once at creation (cancel needs it). */
  ownerKeyHash: text('owner_key_hash').notNull(),
  /** Set once the chain shows the trust ended; the worker then stops waking it. */
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * One row per trade the trust enclave signed. Status only moves forward, through
 * `trustTransition`; a swap with no final answer from 1Click is in_doubt, never failed.
 */
export const trustTrades = pgTable(
  'trust_trades',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    trustId: bigint('trust_id', { mode: 'number' }).notNull(),
    seq: integer('seq').notNull(),
    depositAddress: text('deposit_address').notNull(),
    requestJson: text('request_json').notNull(),
    signature: text('signature').notNull(),
    enclaveKey: text('enclave_key').notNull(),
    status: text('status').notNull(),
    chainTx: text('chain_tx'),
    chainError: text('chain_error'),
    settlementStatus: text('settlement_status'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('trust_trades_trust_seq').on(t.trustId, t.seq)],
);

/**
 * One-time challenges a NEAR wallet signs to sign in (NEP-413). Bound to the browser that asked:
 * only the hash of a random http-only cookie is kept.
 */
export const walletChallenges = pgTable('wallet_challenges', {
  /** Base64 of the 32-byte nonce. */
  nonce: text('nonce').primaryKey(),
  bindingHash: text('binding_hash').notNull(),
  message: text('message').notNull(),
  recipient: text('recipient').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/** Signed-in browsers: the sha256 of the session cookie and the NEAR account that signed in. */
export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  accountId: text('account_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/**
 * Each plan's budget for the work the server's relayer does for it, in yoctoNEAR: credits are the
 * owner's own transfers to the relayer (a tx hash counts once), debits the published fee for each
 * relayed action. A plan whose budget cannot pay the next action waits for a top-up.
 */
export const planBudget = pgTable(
  'plan_budget',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    planId: bigint('plan_id', { mode: 'number' }).notNull(),
    /** Positive for a credit, negative for a debit. */
    yocto: numeric('yocto', { precision: 40, scale: 0 }).notNull(),
    kind: text('kind').notNull(),
    /** The owner's transfer for a credit (unique), the relayed tx for a debit when there is one. */
    txHash: text('tx_hash'),
    createdAt: createdAt(),
  },
  (t) => [
    index('plan_budget_plan').on(t.planId),
    uniqueIndex('plan_budget_credit_tx').on(t.txHash).where(sql`${t.kind} = 'credit'`),
  ],
);
