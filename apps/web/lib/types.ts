import type { SimulatedQuote } from '@vsp/core';
import type {
  ChainEnclave,
  ChainPlan,
  ChainReceipt,
  PendingChange,
  RegistryConfig,
} from '@vsp/near';

export type { ChainEnclave, ChainPlan, ChainReceipt, PendingChange, RegistryConfig };

/**
 * `live`: a public network or service; `local`: a real node on the server's machine; `mock`: a
 * simulator; `mixed`: live for some assets; `off`: not offered by this server (EVM only).
 */
export type Mode = 'mock' | 'live' | 'local' | 'mixed' | 'off';

/** GET /api/meta (packages/engine/src/views.ts metaView). */
export interface Meta {
  modes: {
    near: Mode;
    evm: Mode;
    chainSignatures: Mode;
    oneclick: Mode;
    enclave: Mode;
    prices: Mode;
  };
  /** Where the plans live: local nodes, or NEAR testnet. */
  network: 'local' | 'testnet';
  /** Tokens priced live from Binance and Coinbase; the rest have no market. */
  livePriceSymbols: string[];
  chainTimeMs: number;
  accounts: {
    /** The account new NEAR tokens are created under (`<symbol>.<root>`). */
    root: string;
    registry: string;
    signer: string;
    usdc: string;
    founder: string;
    governance: string;
    relayer: string;
    /** The treasury DAO persona (Sputnik DAO v2), when the world has one. */
    dao?: string;
  };
  registry: { config: RegistryConfig; enclaves: ChainEnclave[]; accessKeys: number };
  enclave: {
    mode: Mode;
    signingKey: string;
    encryptionKeyHex: string;
    /** The simulated TDX quote, or the OutLayer worker's evidence when the enclave is live. */
    quote: SimulatedQuote | OutlayerQuote;
    quoteHash: string;
  };
  /** Earlier enclave builds, for receipts their keys signed. */
  pastEnclaves?: Meta['enclave'][];
  /** Builds new plans are also sealed to; each can stand in when the current build cannot run. */
  backupEnclaves?: Meta['enclave'][];
  mpcRootPublicKey: string;
  evmChainId: number;
  sim: SimSettings;
  /** True on the public server: owner writes need the plan key, simulation controls the operator. */
  public: boolean;
  /** What this server offers. */
  limits: {
    nearTokens: boolean;
  };
}

/**
 * A live OutLayer enclave's evidence (`enclave.quote` when `format` is 'outlayer-tdx-v1'). The
 * Intel TDX quote itself sits behind `attestation_url`; the browser fetches and checks it (`@vsp/verify/tdx`).
 */
export interface OutlayerQuote {
  format: 'outlayer-tdx-v1';
  measurements: ChainEnclave['measurements'];
  attestation_url: string;
  /** The testnet transaction of the attested run that proved the key; the registry pinned it then. */
  key_proof_tx: string;
  wasm_url: string;
  wasm_sha256: string;
  worker_registry: string;
}

export const SIM_OUTCOMES = ['success', 'refund', 'fail', 'stall'] as const;
export type SimOutcome = (typeof SIM_OUTCOMES)[number];

/** packages/engine/src/sim-settings.ts SimSettings. */
export interface SimSettings {
  market: {
    /** Simulated base prices by token address (NEAR account or 0x address). */
    assets: Record<string, { basePriceE6: string }>;
    sourceOffsetsBps: Record<string, number>;
    volatilityBps: number;
  };
  oneclickOutcomes: SimOutcome[];
  enclaveUp: boolean;
  mpcUp: boolean;
}

export interface PlanSummary {
  id: number;
  label: string;
  owner: string;
  status: ChainPlan['status'];
  commitment: string;
  token: { chain: 'near' | 'evm'; address: string; symbol: string; decimals: number };
  planAccount: string;
  evmAddress: string | null;
  pendingChange: PendingChange | null;
  receiptCount: number;
  soldTotal: string;
  createdAtMs: number;
  startMs: number;
  endMs: number;
}

export type ExecutionStatus =
  | 'signed'
  | 'on_chain'
  | 'broadcast'
  | 'settling'
  | 'settled'
  | 'refunded'
  | 'settlement_failed'
  | 'in_doubt'
  | 'refused'
  | 'failed_on_chain';

export interface Execution {
  seq: number;
  kind: string;
  amount: string;
  status: ExecutionStatus;
  chainTx: string | null;
  chainError: string | null;
  evmTxHash: string | null;
  settlementStatus: string | null;
  depositAddress: string | null;
  minAmountOut: string | null;
  amountOut: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityItem {
  id: number;
  kind: string;
  message: string;
  data: Record<string, unknown> | null;
  at: string;
}

/** GET /api/plans/:id (planDetail). */
export interface PlanDetail {
  plan: ChainPlan;
  /** The published sealed terms once the plan has ended and been revealed. */
  reveal: { plan_json: string; salt: string; revealed_at_ms: number } | null;
  summary: PlanSummary;
  planAccount: { id: string; accessKeys: number; codeHash: string | null };
  balance: string | null;
  receipts: ChainReceipt[];
  executions: Execution[];
  activity: ActivityItem[];
  hasPendingSealedChange: boolean;
  /**
   * Base units receipted on-chain but never sold: executions that ended settlement_failed (a
   * reverted EVM transfer or a failed swap). The registry still counts them in its totals.
   */
  failedTotal?: string;
}

/** data/redteam/results.json (scripts/redteam.ts), served at GET /api/redteam. */
export interface RedteamResults {
  generated_at: string;
  /** Free text from the script, e.g. "local sandbox" or "testnet". */
  network: string;
  plan_id: number;
  registry: string;
  attempts: {
    attack: string;
    attacker: string;
    expected: string;
    got: string;
    verdict: 'refused' | 'accepted' | 'unexpected';
    tx_hash: string | null;
  }[];
}

export interface AttemptResult {
  refused: boolean;
  code: string;
  error: string;
  txHash: string;
}
