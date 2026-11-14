import { TtlCache } from './limits.ts';

/** Answers kept per chain; a plan's receipt checks are a few dozen, so this is many plans' worth. */
const MAX_FINAL_ANSWERS = 5_000;
/**
 * Identical reads within this window share one upstream call: a burst of visitors (or one page's
 * polling) costs one request, and a few seconds' staleness is invisible on a 12 s block chain.
 */
const RECENT_MS = 2_000;

const isBlockNumber = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v);
const atOrBefore = (block: unknown, finalized: bigint | null) =>
  finalized !== null && isBlockNumber(block) && BigInt(block) <= finalized;

/**
 * Whether an EVM answer can never change: it describes a block at or before the finalized one.
 * A missing receipt, a pending transaction or a read at `latest` can still change.
 */
export function evmAnswerIsFinal(
  method: string,
  params: unknown,
  result: unknown,
  finalized: bigint | null,
): boolean {
  if (method === 'eth_chainId') return true;
  const list = Array.isArray(params) ? params : [];
  if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') {
    const block = (result as { blockNumber?: unknown } | null)?.blockNumber;
    return atOrBefore(block, finalized);
  }
  if (method === 'eth_getLogs')
    return atOrBefore((list[0] as { toBlock?: unknown } | undefined)?.toBlock, finalized);
  if (method === 'eth_call' || method === 'eth_getBalance' || method === 'eth_getTransactionCount')
    // The block is always the second parameter; without it the node reads `latest`.
    return atOrBefore(list[1], finalized);
  return false;
}

/**
 * Whether a NEAR answer can never change: a block or chunk named by hash, a read pinned to a block
 * hash, or a transaction whose outcome is final.
 */
export function nearAnswerIsFinal(method: string, params: unknown, result: unknown): boolean {
  const p = (params ?? {}) as Record<string, unknown>;
  const isHash = (v: unknown) => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  if (method === 'block' || method === 'query') return isHash(p.block_id);
  if (method === 'chunk') return isHash(p.chunk_id) || isHash(p.block_id);
  if (method === 'tx' || method === 'EXPERIMENTAL_tx_status')
    return (
      (result as { final_execution_status?: unknown } | null)?.final_execution_status === 'FINAL'
    );
  return false;
}

/**
 * The proxies' memory of chain answers. Final answers are kept (the oldest dropped past
 * MAX_FINAL_ANSWERS), so repeats never reach a public node; anything else is shared for
 * RECENT_MS. Failures are never kept.
 */
export class ChainAnswers {
  private readonly final = new Map<string, unknown>();
  private readonly recent = new TtlCache<unknown>(RECENT_MS);

  async get(
    method: string,
    params: unknown,
    load: () => Promise<unknown>,
    isFinal: (result: unknown) => boolean | Promise<boolean>,
  ): Promise<unknown> {
    const key = JSON.stringify([method, params ?? null]);
    if (this.final.has(key)) return this.final.get(key);
    const result = await this.recent.get(key, load);
    if (!this.final.has(key) && (await isFinal(result))) {
      if (this.final.size >= MAX_FINAL_ANSWERS) {
        const oldest = this.final.keys().next();
        if (!oldest.done) this.final.delete(oldest.value);
      }
      this.final.set(key, result);
    }
    return result;
  }

  get size(): number {
    return this.final.size;
  }
}
