'use client';

import type { ChainEnclave, ChainPlan, ChainReceipt, RegistryConfig } from '@vsp/near';
import type { ChainReveal } from '@vsp/verify';
import { useEffect, useState } from 'react';

/**
 * Direct chain reads for the public verifier. These go to the NEAR and EVM JSON-RPC endpoints
 * (proxied read-only by the API at /rpc/*), never to the app's own plan database, so a holder
 * checks the registry's state rather than what the operator says about it.
 */
let rpcId = 0;

export class RpcError extends Error {}

const RPC_KEY = 'vsp-near-rpc';
export const DEFAULT_NEAR_RPC = '/rpc/near';
/** A slow or dead endpoint fails within this long, so the page can say so and retry. */
const RPC_TIMEOUT_MS = 10_000;

/** The NEAR RPC endpoint this browser reads from. A holder may point it at their own node. */
export function nearRpcUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_NEAR_RPC;
  return localStorage.getItem(RPC_KEY) || DEFAULT_NEAR_RPC;
}

export function setNearRpcUrl(url: string | null) {
  if (url && url !== DEFAULT_NEAR_RPC) localStorage.setItem(RPC_KEY, url);
  else localStorage.removeItem(RPC_KEY);
}

async function rpc<T>(chain: 'near' | 'evm', method: string, params: unknown): Promise<T> {
  const url = chain === 'near' ? nearRpcUrl() : '/rpc/evm';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      cache: 'no-store',
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RpcError(
      error instanceof DOMException && error.name === 'TimeoutError'
        ? `The ${chain === 'near' ? 'NEAR' : 'EVM'} RPC did not answer within ${RPC_TIMEOUT_MS / 1000} s`
        : `The ${chain === 'near' ? 'NEAR' : 'EVM'} RPC at ${url} is not reachable`,
    );
  }
  const body = (await res.json().catch(() => null)) as {
    result?: T & { error?: string };
    error?: { message?: string; data?: unknown; cause?: { name?: string } };
  } | null;
  if (!body) throw new RpcError(`The chain RPC answered ${res.status}`);
  if (body.error)
    throw new RpcError(
      body.error.cause?.name ?? body.error.message ?? `The chain RPC refused ${method}`,
    );
  // NEAR returns some query failures inside result.error.
  if (body.result && typeof body.result === 'object' && 'error' in body.result && body.result.error)
    throw new RpcError(String(body.result.error));
  return body.result as T;
}

const toB64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** A registry (or any contract) view method, decoded from the byte array NEAR returns. */
export async function nearView<T>(
  contract: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const out = await rpc<{ result: number[] }>('near', 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: method,
    args_base64: toB64(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(out.result))) as T;
}

export interface AccessKeyInfo {
  public_key: string;
  access_key: { nonce: number; permission: 'FullAccess' | { FunctionCall: unknown } };
}

export async function accessKeys(account: string) {
  const out = await rpc<{ keys: AccessKeyInfo[] }>('near', 'query', {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: account,
  });
  return {
    total: out.keys.length,
    fullAccess: out.keys.filter((k) => k.access_key.permission === 'FullAccess').length,
  };
}

export interface AccountView {
  amount: string;
  code_hash?: string;
  global_contract_hash?: string;
  global_contract_account_id?: string;
}

export const viewAccount = (account: string) =>
  rpc<AccountView>('near', 'query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: account,
  });

/** Whether an account exists; a missing account is the RPC error UNKNOWN_ACCOUNT. */
export async function nearAccountExists(account: string): Promise<boolean> {
  try {
    await viewAccount(account);
    return true;
  } catch (error) {
    if (error instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(error.message))
      return false;
    throw error;
  }
}

/** The chain's own clock: the latest final block's timestamp, in ms. */
export async function nearChainTimeMs(): Promise<number> {
  const block = await rpc<{ header: { timestamp_nanosec: string } }>('near', 'block', {
    finality: 'final',
  });
  return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
}

/** Registry reads, paged the way the contract pages (50 at a time). */
export const registry = {
  config: (registryId: string) => nearView<RegistryConfig>(registryId, 'get_config'),
  plan: (registryId: string, id: number) =>
    nearView<ChainPlan | null>(registryId, 'get_plan', { plan_id: id }),
  /** list_plans takes a plan id to start from (ids start at 1), so pages continue at last id + 1. */
  async plans(registryId: string): Promise<ChainPlan[]> {
    const out: ChainPlan[] = [];
    for (let from = 1; out.length < 500; ) {
      const page = await nearView<ChainPlan[]>(registryId, 'list_plans', {
        from_index: from,
        limit: 50,
      });
      out.push(...page);
      if (page.length < 50) break;
      from = (page.at(-1)?.id ?? from) + 1;
    }
    return out;
  },
  async receipts(registryId: string, id: number): Promise<ChainReceipt[]> {
    const out: ChainReceipt[] = [];
    for (let from = 0; out.length < 500; ) {
      const page = await nearView<ChainReceipt[]>(registryId, 'get_receipts', {
        plan_id: id,
        from_seq: from,
        limit: 50,
      });
      out.push(...page);
      if (page.length < 50) break;
      from = (page.at(-1)?.seq ?? from) + 1;
    }
    return out;
  },
  /** get_enclaves pages by position in the allowlist. */
  async enclaves(registryId: string): Promise<ChainEnclave[]> {
    const out: ChainEnclave[] = [];
    for (let from = 0; from < 500; from += 50) {
      const page = await nearView<ChainEnclave[]>(registryId, 'get_enclaves', {
        from_index: from,
        limit: 50,
      });
      out.push(...page);
      if (page.length < 50) break;
    }
    return out;
  },
  /** A finished plan's published terms and salt, or null while they stay sealed. */
  async reveal(registryId: string, planId: number): Promise<ChainReveal | null> {
    return nearView<ChainReveal | null>(registryId, 'get_reveal', { plan_id: planId }).catch(
      () => null,
    );
  },

  /**
   * Every quote signer the registry has had, so receipts signed before a key rotation still
   * verify. Null when this registry predates get_quote_signers; callers then use get_config.
   */
  async quoteSigners(registryId: string): Promise<QuoteSignerEntry[] | null> {
    try {
      const out: QuoteSignerEntry[] = [];
      for (let from = 0; from < 500; from += 50) {
        const page = await nearView<QuoteSignerEntry[]>(registryId, 'get_quote_signers', {
          from_index: from,
          limit: 50,
        });
        out.push(...page);
        if (page.length < 50) break;
      }
      return out;
    } catch {
      return null;
    }
  },
};

export interface QuoteSignerEntry {
  public_key: string;
  active_from_ms: number;
  replaced_at_ms: number | null;
}

/** An EVM transaction's outcome, read from the chain's own node. */
export async function evmTransactionStatus(
  hash: string,
): Promise<{ status: 'success' | 'reverted' } | null> {
  const r = await rpc<{ status: string } | null>('evm', 'eth_getTransactionReceipt', [hash]);
  if (!r) return null;
  return { status: r.status === '0x1' ? 'success' : 'reverted' };
}

/** ERC-20 balanceOf(holder), read with eth_call. */
export async function erc20Balance(token: string, holder: string): Promise<bigint> {
  const data = `0x70a08231${holder.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const out = await rpc<string>('evm', 'eth_call', [{ to: token, data }, 'latest']);
  return BigInt(out === '0x' ? 0 : out);
}

/** ERC-20 symbol(), decoded from the ABI string it returns. */
export async function erc20Symbol(token: string): Promise<string> {
  const out = await rpc<string>('evm', 'eth_call', [{ to: token, data: '0x95d89b41' }, 'latest']);
  const hex = out.replace(/^0x/, '');
  const len = Number.parseInt(hex.slice(64, 128), 16);
  const bytes = hex.slice(128, 128 + len * 2).match(/.{2}/g) ?? [];
  return new TextDecoder().decode(Uint8Array.from(bytes.map((b) => Number.parseInt(b, 16))));
}

/** NEP-141 ft_balance_of. */
export async function ftBalance(token: string, holder: string): Promise<bigint> {
  return BigInt(await nearView<string>(token, 'ft_balance_of', { account_id: holder }));
}

/**
 * The chain's clock, extrapolated between reads. Cooling-off and plan dates are chain time, and
 * the local sandbox can be fast-forwarded far ahead of the wall clock, so countdowns use this.
 */
export function useChainNow(): number | null {
  const [anchor, setAnchor] = useState<{ chain: number; wall: number } | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    const read = () =>
      nearChainTimeMs()
        .then((chain) => {
          if (!stop) setAnchor({ chain, wall: Date.now() });
        })
        .catch(() => undefined);
    void read();
    const poll = setInterval(read, 10_000);
    const tick = setInterval(() => setTick((n) => n + 1), 1_000);
    const onAdvance = () => void read();
    window.addEventListener('vsp:chain-advanced', onAdvance);
    return () => {
      stop = true;
      clearInterval(poll);
      clearInterval(tick);
      window.removeEventListener('vsp:chain-advanced', onAdvance);
    };
  }, []);
  return anchor ? anchor.chain + (Date.now() - anchor.wall) : null;
}

/** Tells every open view that the simulation moved chain time or changed the world. */
export const announceSimChange = () => window.dispatchEvent(new Event('vsp:chain-advanced'));
