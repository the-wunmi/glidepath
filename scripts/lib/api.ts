import {
  canonicalJson,
  type Envelope,
  envelopeJson,
  newSaltHex,
  parseInput,
  planCommitment,
  SealedPlan,
  type SealedPlanInput,
  SimulatedQuote,
  sealTo,
  toBaseUnits,
  verifySimulatedQuote,
} from '@glidepath/core';

/** The site to talk to: a URL argument (`pnpm verify https://…`), GLIDEPATH_API, or the local API. */
export const API = (
  process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ??
  process.env.GLIDEPATH_API ??
  'http://127.0.0.1:4400'
).replace(/\/$/, '');

/** Owner keys of the plans this script created: POST /api/plans hands each out once. */
const ownerKeys = new Map<number, string>();

/**
 * Calls the API as the browser would: an owner action on a plan carries the key this script got
 * when it created the plan. With OPERATOR_TOKEN set (from .env), every call carries it as well,
 * which a public server needs for writes from a script (no Origin header).
 */
export async function api<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.OPERATOR_TOKEN) headers.authorization = `Bearer ${process.env.OPERATOR_TOKEN}`;
  const planId = /^\/api\/plans\/(\d+)\//.exec(path)?.[1];
  const key = planId ? ownerKeys.get(Number(planId)) : undefined;
  if (key) headers['x-plan-key'] = key;
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text}`);
  const value = JSON.parse(text) as T;
  const created = value as { planId?: unknown; ownerKey?: unknown };
  if (
    path === '/api/plans' &&
    typeof created.planId === 'number' &&
    typeof created.ownerKey === 'string'
  )
    ownerKeys.set(created.planId, created.ownerKey);
  return value;
}

export interface Meta {
  chainTimeMs: number;
  accounts: Record<string, string>;
  enclave: { signingKey: string; encryptionKeyHex: string; quote: unknown; quoteHash: string };
  registry: {
    enclaves: {
      public_key: string;
      measurements: SimulatedQuote['measurements'];
      quote_hash: string;
    }[];
  };
  evmChainId: number;
}

/**
 * What the browser does before sealing: check the enclave's attestation against the on-chain
 * registration, then encrypt plan ‖ salt to the attested key and compute the commitment.
 */
export function sealPlan(meta: Meta, input: SealedPlanInput) {
  const quote = SimulatedQuote.parse(meta.enclave.quote);
  const onchain = meta.registry.enclaves.find((x) => x.public_key === meta.enclave.signingKey);
  if (!onchain) throw new Error('The enclave key is not registered on-chain');
  const check = verifySimulatedQuote(quote, {
    signingKey: meta.enclave.signingKey,
    encryptionKeyHex: meta.enclave.encryptionKeyHex,
    measurements: onchain.measurements,
    quoteHash: onchain.quote_hash,
  });
  const failed = check.checks.filter((c) => !c.ok);
  if (failed.length)
    throw new Error(`Attestation failed: ${failed.map((c) => c.label).join(', ')}`);
  const plan = parseInput(SealedPlan, input);
  const salt = newSaltHex();
  const commitment = planCommitment(plan, salt);
  const box = sealTo(
    meta.enclave.encryptionKeyHex,
    JSON.stringify({ plan: JSON.parse(canonicalJson(plan)), salt }),
  );
  return { plan, salt, commitment, box };
}

export const tokens = (n: string, decimals = 18) => toBaseUnits(n, decimals).toString();

export const envelopeBody = (e: Envelope) => envelopeJson(e);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(1_500);
  }
}
