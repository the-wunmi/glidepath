import type { Utxo } from './vault.ts';

/**
 * Reads and broadcasts through the mempool.space Esplora API for testnet4. Plain fetch, so it runs
 * in the browser (its CORS headers are unverified: not yet tried from a browser) and in Node.
 */
export const MEMPOOL_TESTNET4_API = 'https://mempool.space/testnet4/api';
export const MEMPOOL_TESTNET4_WEB = 'https://mempool.space/testnet4';

export const mempoolTxUrl = (txid: string) => `${MEMPOOL_TESTNET4_WEB}/tx/${txid}`;
export const mempoolAddressUrl = (address: string) => `${MEMPOOL_TESTNET4_WEB}/address/${address}`;

/** A slow API fails within this long, so a page can say so and retry. */
const TIMEOUT_MS = 10_000;

export class MempoolError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

interface EsploraStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
}

export interface AddressBalance {
  /** Satoshis in confirmed outputs. */
  confirmed: bigint;
  /** Net change from unconfirmed transactions (can be negative). */
  unconfirmed: bigint;
}

export interface TxStatus {
  confirmed: boolean;
  block_height?: number;
  block_time?: number;
}

export interface FeeRates {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

export interface ConfirmedUtxo extends Utxo {
  confirmed: boolean;
}

export class MempoolClient {
  constructor(readonly baseUrl: string = MEMPOOL_TESTNET4_API) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new MempoolError(
        error instanceof DOMException && error.name === 'TimeoutError'
          ? `mempool.space did not answer within ${TIMEOUT_MS / 1000} s`
          : 'mempool.space is not reachable',
        null,
      );
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new MempoolError(text || `mempool.space answered ${res.status}`, res.status);
    }
    return res;
  }

  private async json<T>(path: string): Promise<T> {
    return (await (await this.request(path)).json()) as T;
  }

  async utxos(address: string): Promise<ConfirmedUtxo[]> {
    const list = await this.json<EsploraUtxo[]>(`/address/${address}/utxo`);
    return list.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: BigInt(u.value),
      confirmed: u.status.confirmed,
    }));
  }

  async balance(address: string): Promise<AddressBalance> {
    const info = await this.json<{ chain_stats: EsploraStats; mempool_stats: EsploraStats }>(
      `/address/${address}`,
    );
    const net = (s: EsploraStats) => BigInt(s.funded_txo_sum) - BigInt(s.spent_txo_sum);
    return { confirmed: net(info.chain_stats), unconfirmed: net(info.mempool_stats) };
  }

  /** null when mempool.space has never seen the transaction. */
  async txStatus(txid: string): Promise<TxStatus | null> {
    try {
      return await this.json<TxStatus>(`/tx/${txid}/status`);
    } catch (error) {
      if (error instanceof MempoolError && (error.status === 404 || error.status === 400))
        return null;
      throw error;
    }
  }

  feeRates(): Promise<FeeRates> {
    return this.json<FeeRates>('/v1/fees/recommended');
  }

  /** Returns the txid the network assigned; a rejected transaction throws with the node's reason. */
  async broadcast(hex: string): Promise<string> {
    const res = await this.request('/tx', { method: 'POST', body: hex });
    return (await res.text()).trim();
  }
}
