import { createDb, createPool, executions, planBudget, plans } from '@glidepath/db';
import { runMigrations } from '@glidepath/db/migrate';
import type { Engine } from '@glidepath/engine';
import {
  base58Encode,
  budgetBalance,
  canAfford,
  chargePlan,
  FEES,
  loadConfig,
  nep413Digest,
  personasOf,
} from '@glidepath/engine';
import type { WalletAction } from '@glidepath/near';
import { ed25519 } from '@noble/curves/ed25519.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

const pool = createPool(process.env.DATABASE_URL);
const db = createDb(pool);

const FOUNDER = 'alice.testnet';
const secret = ed25519.utils.randomSecretKey();
const PUBLIC_KEY = `ed25519:${base58Encode(ed25519.getPublicKey(secret))}`;
/** Plans of this file (others use 1–3). */
const WALLET_PLAN = 41;
const PERSONA_PLAN = 42;
const TX = '9'.repeat(44);

interface SentTx {
  signerId: string;
  receiverId: string;
  actions: WalletAction[];
  ok?: boolean;
}

/**
 * The chain as these routes see it: which keys belong to which accounts, and the transactions
 * wallets have sent, by hash. Everything else of the engine is real (database, config, routes).
 */
function engineStub(chain: {
  keys?: Record<string, 'full' | 'function_call'>;
  txs?: Record<string, SentTx>;
  /** Sales already executed on chain, by sequence number. */
  onChain?: number[];
}) {
  const config = loadConfig({
    NEAR_NETWORK: 'testnet',
    NEAR_RPC_URL: 'http://127.0.0.1:1',
    RELAYER_ACCOUNT_ID: 'relayer.testnet',
    RELAYER_PRIVATE_KEY: 'k',
    ENCLAVE_BACKEND: 'simulated',
  });
  return {
    config,
    db,
    world: {
      network: 'testnet',
      root: 'relayer.testnet',
      founder: 'relayer.testnet',
      dao: null,
      relayer: 'relayer.testnet',
      registry: 'registry.testnet',
      usdc: 'usdc.testnet',
    },
    near: {
      accessKeyPermission: async (account: string, key: string) =>
        chain.keys?.[`${account}/${key}`] ?? null,
      signedTransaction: async (hash: string, signer: string) => {
        const tx = chain.txs?.[hash];
        if (!tx || tx.signerId !== signer) return null;
        return {
          signerId: tx.signerId,
          receiverId: tx.receiverId,
          actions: tx.actions,
          outcome:
            tx.ok === false
              ? { ok: false, txHash: hash, error: 'x', code: 'x', logs: [], events: [] }
              : { ok: true, txHash: hash, value: undefined, logs: [], events: [] },
          innerFailure: null,
        };
      },
    },
    registry: {
      receipt: async (_plan: number, seq: number) =>
        chain.onChain?.includes(seq) ? { request_json: `request ${seq}` } : null,
      plans: async () => [],
      plan: async () => ({ pending_change: { effective_at_ms: 1 } }),
    },
    oneclickSim: null,
    log: () => {},
  } as unknown as Engine;
}

beforeAll(async () => {
  await runMigrations(process.env.DATABASE_URL);
  const row = {
    label: 'wallet test',
    tokenChain: 'near',
    tokenAddress: 'wlt.relayer.testnet',
    tokenSymbol: 'WLT',
    tokenDecimals: 18,
    commitment: '11'.repeat(32),
    sealedBox: {},
    planAccount: 'p41.registry.testnet',
    createTx: '',
  };
  await db
    .insert(plans)
    .values([
      { ...row, id: WALLET_PLAN, owner: FOUNDER },
      { ...row, id: PERSONA_PLAN, owner: 'relayer.testnet', tokenAddress: 'prs.relayer.testnet' },
    ])
    .onConflictDoNothing();
});
afterAll(() => pool.end());

const post = (
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const cookieOf = (res: Response, name: string) =>
  /^([^;]+)/.exec(res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '')?.[1] ??
  '';

/** Signs in through the routes as a browser would, with the given account's key. */
async function signIn(app: ReturnType<typeof createApp>, accountId = FOUNDER) {
  const challenge = await post(app, '/api/auth/wallet/challenge', {});
  const binding = cookieOf(challenge, 'glidepath_wallet_challenge');
  const c = (await challenge.json()) as { message: string; nonce: string; recipient: string };
  const digest = nep413Digest({
    message: c.message,
    nonce: Uint8Array.from(Buffer.from(c.nonce, 'base64')),
    recipient: c.recipient,
  });
  const signature = Buffer.from(ed25519.sign(digest, secret)).toString('base64');
  const verify = await post(
    app,
    '/api/auth/wallet/verify',
    { accountId, publicKey: PUBLIC_KEY, signature, nonce: c.nonce, recipient: c.recipient },
    { cookie: binding },
  );
  return {
    verify,
    session: cookieOf(verify, 'glidepath_session'),
    binding,
    challenge: c,
    signature,
  };
}

describe('signing in with a NEAR wallet', () => {
  const chain = { keys: { [`${FOUNDER}/${PUBLIC_KEY}`]: 'full' as const } };

  it('a full-access key’s signature over the challenge starts a session for that account', async () => {
    const app = createApp(engineStub(chain));
    const { verify, session } = await signIn(app);
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ account: FOUNDER });
    const me = await app.request('/api/me', { headers: { cookie: session } });
    expect(await me.json()).toEqual({ account: FOUNDER });
    expect(await (await app.request('/api/me')).json()).toBeNull();
  });

  it('a challenge works once, and only in the browser that asked for it', async () => {
    const app = createApp(engineStub(chain));
    const first = await signIn(app);
    const again = await post(
      app,
      '/api/auth/wallet/verify',
      {
        accountId: FOUNDER,
        publicKey: PUBLIC_KEY,
        signature: first.signature,
        nonce: first.challenge.nonce,
      },
      { cookie: first.binding },
    );
    expect(again.status).toBe(403);
    expect(((await again.json()) as { message: string }).message).toMatch(/already used/);
    const other = await signIn(createApp(engineStub(chain)));
    const stolen = await post(
      app,
      '/api/auth/wallet/verify',
      {
        accountId: FOUNDER,
        publicKey: PUBLIC_KEY,
        signature: other.signature,
        nonce: other.challenge.nonce,
      },
      { cookie: 'glidepath_wallet_challenge=00' },
    );
    expect(stolen.status).toBe(403);
  });

  it('refuses a key that is not the account’s, or only a function-call key', async () => {
    const none = await signIn(createApp(engineStub({})));
    expect(none.verify.status).toBe(403);
    const limited = await signIn(
      createApp(engineStub({ keys: { [`${FOUNDER}/${PUBLIC_KEY}`]: 'function_call' } })),
    );
    expect(limited.verify.status).toBe(403);
    expect(((await limited.verify.json()) as { message: string }).message).toMatch(
      /full-access key/,
    );
  });

  it('signs out', async () => {
    const app = createApp(engineStub(chain));
    const { session } = await signIn(app);
    await post(app, '/api/auth/logout', {}, { cookie: session });
    expect(
      await (await app.request('/api/me', { headers: { cookie: session } })).json(),
    ).toBeNull();
  });
});

describe('an owner action signed by the founder’s wallet', () => {
  const cancelCall = {
    signerId: FOUNDER,
    receiverId: 'registry.testnet',
    actions: [
      {
        type: 'FunctionCall',
        method: 'request_cancel',
        args: JSON.stringify({ plan_id: WALLET_PLAN }),
        deposit: 5n * 10n ** 22n,
        gas: 100n * 10n ** 12n,
      },
    ],
  };
  const keys = { [`${FOUNDER}/${PUBLIC_KEY}`]: 'full' as const };

  it('answers with the exact call to sign, then accepts that call’s transaction', async () => {
    const app = createApp(engineStub({ keys, txs: { [TX]: cancelCall } }));
    const { session } = await signIn(app);
    const ask = await post(
      app,
      `/api/plans/${WALLET_PLAN}/cancel`,
      { actor: FOUNDER },
      { cookie: session },
    );
    expect(ask.status).toBe(409);
    const asked = (await ask.json()) as {
      code: string;
      details: { call: Record<string, unknown> };
    };
    expect(asked.code).toBe('wallet_signature_needed');
    expect(asked.details.call).toMatchObject({
      receiverId: 'registry.testnet',
      method: 'request_cancel',
      args: { plan_id: WALLET_PLAN },
    });
    const done = await post(
      app,
      `/api/plans/${WALLET_PLAN}/cancel`,
      { actor: FOUNDER },
      { cookie: session, 'x-wallet-tx': TX },
    );
    expect(done.status).toBe(200);
    expect(((await done.json()) as { txHash: string }).txHash).toBe(TX);
  });

  it('refuses a transaction that is another call, from another signer, or to another contract', async () => {
    const variants: SentTx[] = [
      { ...cancelCall, actions: [{ ...cancelCall.actions[0], args: '{"plan_id":1}' }] as never },
      {
        ...cancelCall,
        actions: [{ ...cancelCall.actions[0], method: 'withdraw_change' }] as never,
      },
      { ...cancelCall, receiverId: 'evil.testnet' },
      { ...cancelCall, actions: [{ ...cancelCall.actions[0], deposit: 0n }] as never },
    ];
    for (const tx of variants) {
      const app = createApp(engineStub({ keys, txs: { [TX]: tx } }));
      const { session } = await signIn(app);
      const res = await post(
        app,
        `/api/plans/${WALLET_PLAN}/cancel`,
        { actor: FOUNDER },
        { cookie: session, 'x-wallet-tx': TX },
      );
      expect(res.status).toBe(422);
    }
  });

  it('acts only for the signed-in owner of the plan', async () => {
    const app = createApp(engineStub({ keys: { ...keys, [`bob.testnet/${PUBLIC_KEY}`]: 'full' } }));
    const bob = await signIn(app, 'bob.testnet');
    const res = await post(
      app,
      `/api/plans/${WALLET_PLAN}/cancel`,
      { actor: FOUNDER },
      { cookie: bob.session },
    );
    expect(res.status).toBe(403);
    const anonymous = await post(app, `/api/plans/${WALLET_PLAN}/cancel`, { actor: FOUNDER });
    expect(anonymous.status).toBe(403);
  });
});

describe('creating a plan', () => {
  const plan = (actor: string) => ({
    actor,
    label: 'test',
    token: {
      chain: 'evm',
      chain_id: 11155111,
      address: `0x${'ab'.repeat(20)}`,
      symbol: 'GPLQ',
      decimals: 18,
    },
    beneficiary: { near_account: actor, evm_address: `0x${'cd'.repeat(20)}` },
    proceeds_asset: 'nep141:usdc.testnet',
    envelope: {
      period_ms: 86_400_000,
      max_amount_per_period: '100',
      max_amount_per_tx: '10',
      min_price_usd_e6: '1',
      min_gap_ms: 0,
    },
    disclosure: { type: 'realtime' },
    cooling_off_ms: 600_000,
    start_ms: 1,
    end_ms: 2,
    commitment: 'ab'.repeat(32),
    sealed_box: { v: 1, epk: 'cd'.repeat(32), nonce: 'ef'.repeat(12), ct: 'x' },
  });

  it('as the server’s own account needs the operator, whatever plan key a request carries', async () => {
    const res = await post(createApp(engineStub({})), '/api/plans', plan('relayer.testnet'), {
      'x-plan-key': 'ab'.repeat(32),
    });
    expect(res.status).toBe(403);
  });

  it('as a wallet account needs that wallet signed in', async () => {
    const res = await post(createApp(engineStub({})), '/api/plans', plan(FOUNDER));
    expect(res.status).toBe(403);
  });
});

describe('a founder’s plan budget', () => {
  const keys = { [`${FOUNDER}/${PUBLIC_KEY}`]: 'full' as const };
  const fund = (deposit: bigint, extra: Partial<SentTx> = {}): SentTx => ({
    signerId: FOUNDER,
    receiverId: 'relayer.testnet',
    actions: [{ type: 'Transfer', deposit }],
    ...extra,
  });

  it('counts the owner’s transfer to the relayer once, and pays the relayer’s work from it', async () => {
    await db.delete(planBudget).where(eq(planBudget.planId, WALLET_PLAN));
    const hash = 'F'.repeat(44);
    const e = engineStub({ keys, txs: { [hash]: fund(10n ** 24n) } });
    const app = createApp(e);
    const { session } = await signIn(app);
    const credited = await post(
      app,
      `/api/plans/${WALLET_PLAN}/fund`,
      { tx_hash: hash },
      { cookie: session },
    );
    expect(credited.status).toBe(200);
    expect(((await credited.json()) as { balance: string }).balance).toBe((10n ** 24n).toString());
    const twice = await post(
      app,
      `/api/plans/${WALLET_PLAN}/fund`,
      { tx_hash: hash },
      { cookie: session },
    );
    expect(twice.status).toBe(409);
    await chargePlan(db, personasOf(e), WALLET_PLAN, 'launch_near');
    expect(await budgetBalance(db, WALLET_PLAN)).toBe(10n ** 24n - FEES.launch_near);
    expect(await canAfford(db, personasOf(e), WALLET_PLAN, 10n ** 24n)).toBe(false);
  });

  it('refuses a transfer to anyone but the relayer, or from anyone but the owner', async () => {
    const wrong: Record<string, SentTx> = {
      ['A'.repeat(44)]: fund(10n ** 24n, { receiverId: 'someone.testnet' }),
      ['B'.repeat(44)]: fund(10n ** 24n, { signerId: 'bob.testnet' }),
      ['C'.repeat(44)]: fund(10n ** 24n, { ok: false }),
    };
    const app = createApp(engineStub({ keys, txs: wrong }));
    const { session } = await signIn(app);
    for (const hash of Object.keys(wrong)) {
      const res = await post(
        app,
        `/api/plans/${WALLET_PLAN}/fund`,
        { tx_hash: hash },
        { cookie: session },
      );
      expect(res.status).not.toBe(200);
    }
  });

  it('never charges the server’s own plans', async () => {
    const e = engineStub({});
    await chargePlan(db, personasOf(e), PERSONA_PLAN, 'run');
    expect(await budgetBalance(db, PERSONA_PLAN)).toBe(0n);
    expect(await canAfford(db, personasOf(e), PERSONA_PLAN, 10n ** 30n)).toBe(true);
  });
});

describe('a signed sale the relayer has not sent', () => {
  const sale = (seq: number, ageMs: number) => ({
    planId: WALLET_PLAN,
    seq,
    kind: 'nep141_transfer',
    amount: '1',
    correlationId: `c${seq}`,
    depositAddress: 'd',
    minAmountOut: '1',
    quote: {},
    requestJson: `request ${seq}`,
    signature: 'sig',
    enclaveKey: 'ed25519:key',
    status: 'signed',
    createdAt: new Date(Date.now() - ageMs),
  });

  it('is shown to anyone, with the exact call to send it, once it has waited past the grace period', async () => {
    await db.delete(executions).where(eq(executions.planId, WALLET_PLAN));
    await db
      .insert(executions)
      .values([sale(0, 10 * 60_000), sale(1, 10_000), sale(2, 10 * 60_000)]);
    const res = await createApp(engineStub({ onChain: [2] })).request(
      `/api/plans/${WALLET_PLAN}/unsent`,
    );
    const unsent = (await res.json()) as { seq: number; call: Record<string, unknown> }[];
    // Seq 1 is still within the grace period, and seq 2 is already on chain.
    expect(unsent.map((u) => u.seq)).toEqual([0]);
    expect(unsent[0]?.call).toMatchObject({
      receiverId: 'registry.testnet',
      method: 'execute',
      args: {
        plan_id: WALLET_PLAN,
        request_json: 'request 0',
        signature: 'sig',
        enclave_key: 'ed25519:key',
      },
    });
  });
});
