import { TtlCache } from './limits.ts';

/** Answers kept per chain; a plan's receipt checks are a few dozen, so this is many plans' worth. */
const MAX_FINAL_ANSWERS = 5_000;
/**
 * Bytes of kept answers per chain. Answers vary in size (a receipt is a few KB, a block or a wide log
 * query far more), so the count alone would not bound memory.
 */
const MAX_FINAL_BYTES = 32 * 1024 * 1024;
/** An answer bigger than this is served and shared briefly, but never kept. */
const MAX_KEPT_ANSWER_BYTES = 256 * 1024;
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
 * The proxies' memory of chain answers. Final answers up to MAX_KEPT_ANSWER_BYTES are kept (the
 * oldest dropped past MAX_FINAL_ANSWERS or MAX_FINAL_BYTES), so repeats never reach a public node;
 * anything else is shared for RECENT_MS. Failures are never kept.
 */
export class ChainAnswers {
  private readonly final = new Map<string, { result: unknown; bytes: number }>();
  private readonly recent = new TtlCache<unknown>(RECENT_MS);
  private bytes = 0;

  constructor(
    private readonly limits = {
      answers: MAX_FINAL_ANSWERS,
      bytes: MAX_FINAL_BYTES,
      perAnswer: MAX_KEPT_ANSWER_BYTES,
    },
  ) {}

  async get(
    method: string,
    params: unknown,
    load: () => Promise<unknown>,
    isFinal: (result: unknown) => boolean | Promise<boolean>,
  ): Promise<unknown> {
    const key = JSON.stringify([method, params ?? null]);
    const kept = this.final.get(key);
    if (kept) return kept.result;
    const result = await this.recent.get(key, load);
    if (!(await isFinal(result))) return result;
    // Concurrent reads of one key all get here; only the first keeps it, so bytes count it once.
    if (this.final.has(key)) return result;
    const bytes = key.length + (JSON.stringify(result) ?? '').length;
    if (bytes > this.limits.perAnswer) return result;
    while (
      this.final.size > 0 &&
      (this.final.size >= this.limits.answers || this.bytes + bytes > this.limits.bytes)
    ) {
      const [oldest, entry] = this.final.entries().next().value as [string, { bytes: number }];
      this.final.delete(oldest);
      this.bytes -= entry.bytes;
    }
    this.final.set(key, { result, bytes });
    this.bytes += bytes;
    return result;
  }

  get size(): number {
    return this.final.size;
  }

  /** Bytes of kept answers (their JSON), as counted against the limit. */
  get keptBytes(): number {
    return this.bytes;
  }
}
