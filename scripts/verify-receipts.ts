/**
 * Verifies every receipt of every plan the way the verifier page does, reading the chains only
 * through the API's read-only proxies (/rpc/near, /rpc/evm). Usage: pnpm verify-receipts
 */
import type { ChainEnclave, ChainPlan, ChainReceipt } from '@vsp/near';
import { verifyReceipt } from '@vsp/verify';
import type { Hex } from 'viem';
import { API, api } from './lib/api.ts';

async function rpc<T>(path: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result as T;
}

async function view<T>(
  contract: string,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await rpc<{ result: number[] }>('/rpc/near', 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(result.result).toString()) as T;
}

async function main() {
  const meta = await api<{
    accounts: { registry: string };
    enclave: { quote: unknown; encryptionKeyHex: string };
    quoteSigner: string;
  }>('/api/meta');
  const registry = meta.accounts.registry;
  const plans = await view<ChainPlan[]>(registry, 'list_plans', { limit: 50 });
  const enclaves = await view<ChainEnclave[]>(registry, 'get_enclaves', {});
  let failed = 0;
  for (const plan of plans) {
    const receipts = await view<ChainReceipt[]>(registry, 'get_receipts', {
      plan_id: plan.id,
      limit: 50,
    });
    for (const r of receipts) {
      const result = await verifyReceipt(
        r,
        plan,
        enclaves,
        meta.enclave,
        {
          evmTransaction: async (hash: Hex) => {
            const rc = await rpc<{ status: string } | null>(
              '/rpc/evm',
              'eth_getTransactionReceipt',
              [hash],
            );
            return rc ? { status: rc.status === '0x1' ? 'success' : 'reverted' } : null;
          },
        },
        meta.quoteSigner,
      );
      const bad = result.checks.filter((c) => c.status === 'fail');
      failed += result.ok ? 0 : 1;
      console.log(
        `plan ${plan.id} sale #${r.seq}: ${!result.ok ? 'FAILED' : result.complete ? 'verified' : 'verified so far (in progress)'} (${result.checks.filter((c) => c.status === 'pass').length} checks passed${bad.length ? `; failed: ${bad.map((c) => c.label).join(', ')}` : ''})`,
      );
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
