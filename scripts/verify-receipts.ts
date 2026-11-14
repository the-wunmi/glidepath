/**
 * Verifies every receipt of every plan the way the verifier page does. Usage:
 *   pnpm verify https://glidepath.clanker.show   # a deployed site: no keys, nothing signed
 *   pnpm verify-receipts                         # the local API (pnpm dev:local)
 * The site supplies only the registry's address and the enclave's evidence (checked against what
 * the registry pinned); a public site's chains are read from public RPC endpoints directly (an
 * archival NEAR node for the enclaves' key-proof transactions), so the answers do not depend on the
 * site. A local run reads them through the API's read-only proxies.
 * An OutLayer enclave's attestation is checked in full for each key that signed a receipt: the
 * quote OutLayer serves, the measurements the registry pinned, the key proof, and Intel's
 * collateral (read through the site's /api/pcs pass-through; Intel signed it, so the site cannot
 * change it unnoticed). A warning, such as a TCB status below UpToDate, is printed but does not fail.
 */
import type { ChainEnclave, ChainPlan, ChainReceipt } from '@glidepath/near';
import { type ReceiptAttestation, verifyReceipt } from '@glidepath/verify';
import {
  checkOutlayerEnclave,
  checkState,
  type EnclaveCheck,
  fetchOutlayerEvidence,
  isOutlayerQuote,
} from '@glidepath/verify/outlayer';
import type { Hex } from 'viem';
import { API, api } from './lib/api.ts';

const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API);
/** Public endpoints for a deployed site (NEAR testnet and Sepolia). */
const PUBLIC_RPC: Record<string, string> = {
  '/rpc/near': 'https://rpc.testnet.near.org',
  '/rpc/evm': 'https://ethereum-sepolia-rpc.publicnode.com',
};
/**
 * A key-proof run is older than a regular node keeps transactions (a few days), so a public site's
 * key-proof transactions are read from an archival node.
 */
const ARCHIVAL_NEAR_RPC = 'https://archival-rpc.testnet.near.org';

async function rpc<T>(path: string, method: string, params: unknown, archival = false): Promise<T> {
  const remote = archival ? ARCHIVAL_NEAR_RPC : (PUBLIC_RPC[path] as string);
  const res = await fetch(local ? `${API}${path}` : remote, {
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

/** One enclave build as /api/meta serves it. */
interface Build {
  signingKey: string;
  encryptionKeyHex: string;
  quote: unknown;
}

const short = (key: string) => `${key.slice(0, 16)}…`;

/**
 * The attestation of the build that serves `key`, for verifyReceipt: a simulated quote as served,
 * or every check of an OutLayer build, run here. Null when no build here serves the key.
 */
async function attestationFor(
  build: Build | undefined,
  enclaves: ChainEnclave[],
): Promise<ReceiptAttestation | null> {
  if (!build) return null;
  if (!isOutlayerQuote(build.quote))
    return { quote: build.quote, encryptionKeyHex: build.encryptionKeyHex };
  const quote = build.quote;
  const enclave = enclaves.find((x) => x.public_key === build.signingKey) ?? null;
  const ev = await fetchOutlayerEvidence(quote.attestation_url, {
    fetch: (url) => fetch(url),
    txSuccessValue: async (hash, sender) =>
      (
        await rpc<{ status: { SuccessValue?: string } }>(
          '/rpc/near',
          'tx',
          {
            tx_hash: hash,
            sender_account_id: sender,
            wait_until: 'FINAL',
          },
          true,
        )
      ).status.SuccessValue ?? null,
    pcs: (path) => fetch(`${API}/api/pcs/${path}`),
  }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  const rows = checkOutlayerEnclave(enclave, { ...build, quote }, ev);
  printAttestation(build.signingKey, quote.wasm_sha256, rows);
  return { outlayer: rows };
}

function printAttestation(key: string, wasm: string, rows: EnclaveCheck[]) {
  const n = (s: 'pass' | 'warn' | 'fail') => rows.filter((c) => checkState(c) === s).length;
  console.log(
    `enclave ${short(key)} (OutLayer build ${wasm.slice(0, 12)}…): attestation ${n('fail') ? 'FAILED' : 'verified'}, ${n('pass')} passed, ${n('warn')} warning(s), ${n('fail')} failed`,
  );
  for (const c of rows)
    if (checkState(c) !== 'pass')
      console.log(
        `  ${checkState(c) === 'fail' ? 'FAIL' : 'warn'}: ${c.label}${c.detail ? ` (${c.detail})` : ''}`,
      );
}

async function main() {
  const meta = await api<{
    accounts: { registry: string };
    enclave: Build;
    backupEnclaves?: Build[];
    pastEnclaves?: Build[];
    quoteSigner: string;
  }>('/api/meta');
  const builds = [meta.enclave, ...(meta.backupEnclaves ?? []), ...(meta.pastEnclaves ?? [])];
  const registry = meta.accounts.registry;
  const plans = await view<ChainPlan[]>(registry, 'list_plans', { limit: 50 });
  const enclaves = await view<ChainEnclave[]>(registry, 'get_enclaves', {});
  /** Each key's attestation, checked once however many receipts it signed. */
  const attestations = new Map<string, Promise<ReceiptAttestation | null>>();
  const attestationOf = (key: string) => {
    let p = attestations.get(key);
    if (!p) {
      p = attestationFor(
        builds.find((b) => b.signingKey === key),
        enclaves,
      );
      attestations.set(key, p);
    }
    return p;
  };
  let failed = 0;
  let total = 0;
  let warned = 0;
  for (const plan of plans) {
    const receipts = await view<ChainReceipt[]>(registry, 'get_receipts', {
      plan_id: plan.id,
      limit: 50,
    });
    for (const r of receipts) {
      const attestation = r.enclave_key ? await attestationOf(r.enclave_key) : null;
      const result = await verifyReceipt(
        r,
        plan,
        enclaves,
        attestation,
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
      const count = (s: string) => result.checks.filter((c) => c.status === s).length;
      const bad = result.checks.filter((c) => c.status === 'fail');
      const warns = result.checks.filter((c) => c.status === 'warn');
      total += 1;
      failed += result.ok ? 0 : 1;
      warned += result.ok && warns.length ? 1 : 0;
      const attested =
        r.kind === 'release'
          ? ''
          : attestation && 'outlayer' in attestation
            ? ', OutLayer TDX'
            : result.simulatedAttestation
              ? ', simulated TDX'
              : '';
      console.log(
        `plan ${plan.id} ${r.kind === 'release' ? 'release' : `sale #${r.seq}`}: ${!result.ok ? 'FAILED' : result.complete ? 'verified' : 'verified so far (in progress)'} (${count('pass')} checks passed${warns.length ? `, ${warns.length} warning(s)` : ''}${attested}${bad.length ? `; failed: ${bad.map((c) => c.label).join(', ')}` : ''})`,
      );
    }
  }
  const source = `chains read from ${local ? API : 'public RPC endpoints'}`;
  console.log(
    failed
      ? `${failed} of ${total} receipt(s) FAILED (${source})`
      : `all ${total} receipt(s) verified${warned ? `, ${warned} with warnings` : ''} (${source})`,
  );
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
