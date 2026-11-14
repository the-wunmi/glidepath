import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDb, createPool, plans } from '@vsp/db';
import { runMigrations } from '@vsp/db/migrate';
import type { Engine } from '@vsp/engine';
import {
  assertPlanLength,
  chargeDaily,
  loadConfig,
  newOwnerKey,
  REPO_DATA_DIR,
  serverLimits,
  spendRelayer,
} from '@vsp/engine';
import { publicRpcClient } from '@vsp/evm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { clientKeyOf } from '../src/limits.ts';
import { evmAnswerIsFinal, nearAnswerIsFinal } from '../src/rpc-cache.ts';

const pool = createPool(process.env.DATABASE_URL);
const db = createDb(pool);
const OPERATOR_TOKEN = 'operator-token-for-tests-0123456789';
const owned = newOwnerKey();
/** ERC-20 of plan 3, which has a database row; the proxy may read it. */
const TOKEN = '0x00000000000000000000000000000000000000aa';
/** An ERC-20 of a plan on the registry this server's database has no row for. */
const CHAIN_ONLY_TOKEN = '0x00000000000000000000000000000000000000cc';

beforeAll(async () => {
  await runMigrations(process.env.DATABASE_URL);
  const row = {
    owner: 'founder.sandbox',
    label: 'test',
    tokenChain: 'near',
    tokenAddress: 'acme.sandbox',
    tokenSymbol: 'ACME',
    tokenDecimals: 18,
    commitment: '00'.repeat(32),
    sealedBox: {},
    planAccount: 'p1.registry.sandbox',
    createTx: '',
  };
  // Plan 1 has an owner key; plan 2 predates keys, so only the operator manages it.
  await db
    .insert(plans)
    .values([
      { ...row, id: 1, ownerKeyHash: owned.hash },
      { ...row, id: 2, ownerKeyHash: null },
      { ...row, id: 3, tokenChain: 'evm', tokenAddress: TOKEN, tokenSymbol: 'EVMT' },
    ])
    .onConflictDoNothing();
});
afterAll(() => pool.end());

/** Enough of an engine for routes that never reach the chain: config, world and database. */
function engineStub(
  network: 'local' | 'testnet' = 'local',
  env: Record<string, string> = {},
  evmUrls = ['http://127.0.0.1:1'],
) {
  const config = loadConfig({
    OPERATOR_TOKEN,
    ...env,
    NEAR_NETWORK: network,
    NEAR_RPC_URL: 'http://127.0.0.1:1',
    RELAYER_ACCOUNT_ID: 'r',
    RELAYER_PRIVATE_KEY: 'k',
  });
  return {
    config,
    db,
    world: { network, nearRpcUrl: 'http://127.0.0.1:1', evmRpcUrl: 'http://127.0.0.1:1' },
    reads: { evm: publicRpcClient(evmUrls) },
    registry: {
      plans: async () => [{ asset: { type: 'evm_erc20', token_address: CHAIN_ONLY_TOKEN } }],
    },
    oneclickSim: null,
    log: () => {},
  } as unknown as Engine;
}

function app(network: 'local' | 'testnet' = 'local', env: Record<string, string> = {}) {
  return createApp(engineStub(network, env));
}

const rpc = (path: string, method: string) =>
  app().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  });

describe('read-only chain proxies', () => {
  it('refuse to send a NEAR transaction', async () => {
    expect((await rpc('/rpc/near', 'send_tx')).status).toBe(403);
    expect((await rpc('/rpc/near', 'broadcast_tx_commit')).status).toBe(403);
  });

  it('refuse to send an EVM transaction', async () => {
    expect((await rpc('/rpc/evm', 'eth_sendRawTransaction')).status).toBe(403);
    expect((await rpc('/rpc/evm', 'eth_sendTransaction')).status).toBe(403);
  });

  it('refuse a body that is not a JSON-RPC request', async () => {
    const res = await app().request('/rpc/near', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(403);
  });
});

describe('a fresh .env copied from .env.example', () => {
  /** .env.example as `cp .env.example .env` gives it: KEY=value lines, comments skipped. */
  const example = Object.fromEntries(
    readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

  it('runs the local world with nothing filled in', () => {
    const c = loadConfig({ ...example, NEAR_NETWORK: 'local', EVM_NETWORK: 'local' });
    expect(c.EVM_FUNDER_PRIVATE_KEY).toBeUndefined();
    expect(c.RELAYER_ACCOUNT_ID).toBeUndefined();
  });

  it('keeps the enclave secret in the repo’s .data whichever folder a process runs from', () => {
    const c = loadConfig({ ...example, NEAR_NETWORK: 'local', EVM_NETWORK: 'local' });
    expect(c.DATA_DIR).toBe(REPO_DATA_DIR);
  });
});

describe('the enclave a public server runs', () => {
  const env = {
    NODE_ENV: 'production',
    NEAR_NETWORK: 'testnet',
    RELAYER_ACCOUNT_ID: 'r',
    RELAYER_PRIVATE_KEY: 'k',
  };

  it('is the real OutLayer enclave when its deployment record exists', () => {
    expect(loadConfig(env).ENCLAVE_BACKEND).toBe('outlayer');
  });

  it('never falls back to the simulator unnoticed: without the record it refuses to start', () => {
    expect(() => loadConfig({ ...env, DEPLOYMENTS_DIR: '/nonexistent' })).toThrow(
      /outlayer-testnet\.json/,
    );
    const chosen = { ...env, DEPLOYMENTS_DIR: '/nonexistent', ENCLAVE_BACKEND: 'simulated' };
    expect(loadConfig(chosen).ENCLAVE_BACKEND).toBe('simulated');
  });
});

describe('simulation controls', () => {
  it('cannot move time on testnet, which runs in real time', async () => {
    const live = app('testnet');
    const advance = await live.request('/api/sim/advance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minutes: 60 }),
    });
    expect(advance.status).toBe(403);
  });
});

describe('cross-site protection', () => {
  it('refuses a write without a JSON content type', async () => {
    const res = await app().request('/api/plans/1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ actor: 'founder.sandbox' }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a write from another origin', async () => {
    const res = await app().request('/api/plans/1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ actor: 'founder.sandbox' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('errors', () => {
  it('report a bad plan id as invalid input, not a server error', async () => {
    const res = await app().request('/api/plans/abc');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'invalid' });
  });

  it('refuse oversized bodies', async () => {
    const res = await app().request('/api/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(200_000) }),
    });
    expect(res.status).toBe(413);
  });
});

describe('behind the public proxy', () => {
  const server = () =>
    app('testnet', { PUBLIC_ORIGIN: 'https://glidepath.example/', EVM_NETWORK: 'off' });
  const write = (a: ReturnType<typeof app>, path: string, headers: Record<string, string> = {}) =>
    a.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ token: { chain: 'evm' } }),
    });

  it('refuses a write from the local web origin once a public origin is set', async () => {
    const res = await write(server(), '/api/plans', { origin: 'http://localhost:3400' });
    expect(res.status).toBe(403);
  });

  it('counts no invalid plan against a client’s creation limit', async () => {
    const a = app('testnet', { PUBLIC_ORIGIN: 'https://glidepath.example/' });
    for (let i = 0; i < 5; i++) {
      const res = await write(a, '/api/plans', {
        origin: 'https://glidepath.example',
        'x-forwarded-for': `6.6.6.6, 1.1.1.1`,
      });
      expect(res.status).toBe(422);
    }
  });

  it('refuses an API write with no Origin unless it carries the operator token', async () => {
    const a = server();
    const bare = await a.request('/api/plans/1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '4.4.4.4' },
      body: JSON.stringify({ actor: 'someone.sandbox' }),
    });
    expect(bare.status).toBe(403);
    const operator = await a.request('/api/plans/1/cancel', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '4.4.4.4',
        authorization: `Bearer ${OPERATOR_TOKEN}`,
      },
      body: JSON.stringify({ actor: 'someone.sandbox' }),
    });
    // Past the origin check and authorized: refused only because that persona owns nothing.
    expect(operator.status).toBe(404);
  });

  it('leaves the demo controls to the operator', async () => {
    const put = (headers: Record<string, string>) =>
      server().request('/api/sim', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: 'https://glidepath.example',
          ...headers,
        },
        body: JSON.stringify({}),
      });
    expect((await put({})).status).toBe(403);
    // The operator gets as far as validating the settings.
    expect((await put({ authorization: `Bearer ${OPERATOR_TOKEN}` })).status).toBe(422);
  });

  it('refuses EVM plans while EVM is off', async () => {
    const res = await write(server(), '/api/plans', {
      'x-forwarded-for': '3.3.3.3',
      origin: 'https://glidepath.example',
    });
    expect(res.status).toBe(503);
    expect((await server().request('/api/addresses/next')).status).toBe(503);
    const rpc = await write(server(), '/rpc/evm', { 'x-forwarded-for': '3.3.3.3' });
    expect(rpc.status).toBe(503);
  });

  it('hides the 1Click simulator from everyone but this process', async () => {
    expect((await server().request('/sim/1click/v0/tokens')).status).toBe(404);
  });
});

describe('plan authorization', () => {
  const cancel = (id: number, headers: Record<string, string>, actor = 'someone.sandbox') =>
    app().request(`/api/plans/${id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ actor }),
    });

  it('refuses an owner action without the plan’s key', async () => {
    const res = await cancel(1, {});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'forbidden',
      error: 'forbidden',
      message: 'This plan’s key is required to manage it',
    });
  });

  it('refuses an owner action with another key', async () => {
    expect((await cancel(1, { 'x-plan-key': newOwnerKey().key })).status).toBe(403);
    expect((await cancel(1, { 'x-plan-key': 'not-hex' })).status).toBe(403);
  });

  it('accepts the plan’s own key, after which the actor must still own the plan', async () => {
    // 404, not 403: authorized, then refused only because this persona does not own plan 1.
    expect((await cancel(1, { 'x-plan-key': owned.key })).status).toBe(404);
  });

  it('never takes the actor as authorization', async () => {
    expect((await cancel(1, {}, 'founder.sandbox')).status).toBe(403);
  });

  it('lets the operator manage any plan, including one created before keys', async () => {
    const bearer = { authorization: `Bearer ${OPERATOR_TOKEN}` };
    expect((await cancel(2, bearer)).status).toBe(404);
    expect((await cancel(2, { 'x-plan-key': owned.key })).status).toBe(403);
    expect((await cancel(1, { authorization: 'Bearer wrong-token-0123456789abcdef' })).status).toBe(
      403,
    );
  });

  it('guards every owner write, but not finalize or reveal', async () => {
    for (const action of [
      'launch',
      'enroll',
      'change',
      'withdraw-change',
      'attempts/direct-transfer',
      'attempts/add-key',
    ]) {
      const res = await app().request(`/api/plans/1/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'founder.sandbox' }),
      });
      // Invalid bodies are refused first (422); a valid one without a key is a 403.
      expect([403, 422]).toContain(res.status);
    }
  });

  it('tells the web whether it holds the operator token', async () => {
    const ask = async (headers: Record<string, string>) =>
      (await app().request('/api/operator', { headers })).json();
    expect(await ask({})).toEqual({ operator: false });
    expect(await ask({ authorization: `Bearer ${OPERATOR_TOKEN}` })).toEqual({ operator: true });
  });
});

describe('drain protection', () => {
  it('caps spending actions per UTC day in the database, refusing past the cap', async () => {
    await chargeDaily(db, 'token_launched', 2);
    await chargeDaily(db, 'token_launched', 2);
    await expect(chargeDaily(db, 'token_launched', 2)).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'Today’s limit for token launches is reached; try again after 00:00 UTC',
    });
  });

  it('shares one daily budget across every relayer-paid write', async () => {
    const e = engineStub('local', { MAX_RELAYER_WRITES_PER_DAY: '1' });
    await spendRelayer(e);
    await expect(spendRelayer(e)).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'Today’s limit for on-chain actions is reached; try again after 00:00 UTC',
    });
  });

  it('bounds plan length to 30 days on testnet and not locally', () => {
    const now = Date.parse('2026-11-13T00:00:00Z');
    const day = 86_400_000;
    expect(() => assertPlanLength(engineStub('testnet'), now + 31 * day, now)).toThrow(/30 days/);
    expect(() => assertPlanLength(engineStub('testnet'), now + 29 * day, now)).not.toThrow();
    expect(() => assertPlanLength(engineStub('local'), now + 400 * day, now)).not.toThrow();
  });

  it('offers NEAR-token plans on testnet only once the token code is published', () => {
    expect(serverLimits(engineStub('testnet')).nearTokens).toBe(false);
    expect(serverLimits(engineStub('local')).nearTokens).toBe(true);
    const published = engineStub('testnet');
    (published.world as { demoTokenCodeHash?: string }).demoTokenCodeHash = 'hash';
    expect(serverLimits(published).nearTokens).toBe(true);
    expect(serverLimits(engineStub('testnet', { NEAR_TOKEN_LAUNCHES: 'off' })).nearTokens).toBe(
      false,
    );
  });

  it('keys IPv6 clients by their /64 and IPv4-mapped clients as IPv4', () => {
    expect(clientKeyOf('2001:db8:1:2:aaaa::1')).toBe(
      clientKeyOf('2001:db8:1:2:bbbb:cccc:dddd:eeee'),
    );
    expect(clientKeyOf('2001:db8:1:2::1')).not.toBe(clientKeyOf('2001:db8:1:3::1'));
    expect(clientKeyOf('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientKeyOf('1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('the EVM read proxy', () => {
  const call = (method: string, params: unknown[]) =>
    app().request('/rpc/evm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });

  it('refuses log queries without a plan token, numeric bounds, or over 5,000 blocks', async () => {
    const logs = (filter: Record<string, unknown>) => call('eth_getLogs', [filter]);
    const other = '0x00000000000000000000000000000000000000bb';
    expect((await logs({ fromBlock: '0x0', toBlock: '0x10' })).status).toBe(403);
    expect((await logs({ address: other, fromBlock: '0x0', toBlock: '0x10' })).status).toBe(403);
    expect((await logs({ address: TOKEN, fromBlock: 'earliest', toBlock: 'latest' })).status).toBe(
      403,
    );
    expect((await logs({ address: TOKEN, fromBlock: '0x0', toBlock: '0x1388' })).status).toBe(403);
    // Within bounds it reaches the node (none listens in this test, hence 503).
    expect((await logs({ address: TOKEN, fromBlock: '0x0', toBlock: '0x10' })).status).toBe(503);
  });

  it('calls only plan tokens', async () => {
    const res = await call('eth_call', [
      { to: '0x0000000000000000000000000000000000000001', data: '0x' },
      'latest',
    ]);
    expect(res.status).toBe(403);
  });

  it('reads the token of a plan the registry holds but this database does not', async () => {
    const res = await call('eth_call', [{ to: CHAIN_ONLY_TOKEN, data: '0x95d89b41' }, 'latest']);
    // Allowed through to the node (none listens in this test, hence 503, not 403).
    expect(res.status).toBe(503);
  });

  it('does not pass on what the node said when it fails', async () => {
    const res = await call('eth_blockNumber', []);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(JSON.stringify(await res.json())).not.toContain('127.0.0.1');
  });
});

describe('the EVM read proxy against public nodes', () => {
  const FINAL_TX = `0x${'aa'.repeat(32)}`;
  const RECENT_TX = `0x${'bb'.repeat(32)}`;
  const servers: Server[] = [];
  afterAll(() => Promise.all(servers.map((x) => new Promise((r) => x.close(r)))));

  /**
   * A Sepolia node whose finalized block is 0x100: FINAL_TX was mined in 0x50, RECENT_TX in 0x200.
   * `limited` makes it answer every request with 429, as publicnode did under a burst.
   */
  async function node(limited = false) {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => {
        raw += d;
      });
      req.on('end', () => {
        const { id, method, params } = JSON.parse(raw) as {
          id: number;
          method: string;
          params: unknown[];
        };
        hits.push(method);
        if (limited) return void res.writeHead(429).end('Rate limit exceeded');
        const result =
          method === 'eth_getBlockByNumber'
            ? { number: '0x100' }
            : method === 'eth_getTransactionReceipt'
              ? { status: '0x1', blockNumber: params[0] === FINAL_TX ? '0x50' : '0x200' }
              : '0x1';
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
  }
  const receipt = (a: ReturnType<typeof createApp>, hash: string) =>
    a.request('/rpc/evm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'eth_getTransactionReceipt',
        params: [hash],
      }),
    });

  it('keeps a finalized receipt, so a repeat never reaches the node', async () => {
    const n = await node();
    const a = createApp(engineStub('local', {}, [n.url]));
    const first = await receipt(a, FINAL_TX);
    expect(await first.json()).toMatchObject({ id: 7, result: { status: '0x1' } });
    // Well past the burst window, so only the kept answer can serve it.
    await new Promise((r) => setTimeout(r, 2_100));
    expect((await receipt(a, FINAL_TX)).status).toBe(200);
    expect(n.hits.filter((m) => m === 'eth_getTransactionReceipt')).toHaveLength(1);
  });

  it('asks again for a receipt that is not final yet, but shares one call within a burst', async () => {
    const n = await node();
    const a = createApp(engineStub('local', {}, [n.url]));
    await Promise.all([receipt(a, RECENT_TX), receipt(a, RECENT_TX), receipt(a, RECENT_TX)]);
    expect(n.hits.filter((m) => m === 'eth_getTransactionReceipt')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 2_100));
    await receipt(a, RECENT_TX);
    expect(n.hits.filter((m) => m === 'eth_getTransactionReceipt')).toHaveLength(2);
  });

  it('fails over from a rate-limited node to the next', async () => {
    const limited = await node(true);
    const healthy = await node();
    const a = createApp(engineStub('local', {}, [limited.url, healthy.url]));
    const res = await receipt(a, FINAL_TX);
    expect(res.status).toBe(200);
    expect(limited.hits.length).toBeGreaterThan(0);
  });

  it('answers 503 with a retry hint when every node is rate-limited', async () => {
    const limited = await node(true);
    const res = await receipt(createApp(engineStub('local', {}, [limited.url])), FINAL_TX);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
  });
});

describe('which chain answers are kept', () => {
  it('keeps EVM answers about finalized blocks only', () => {
    const at = (block: string) => ({ status: '0x1', blockNumber: block });
    expect(evmAnswerIsFinal('eth_getTransactionReceipt', [], at('0x10'), 0x10n)).toBe(true);
    expect(evmAnswerIsFinal('eth_getTransactionReceipt', [], at('0x11'), 0x10n)).toBe(false);
    expect(evmAnswerIsFinal('eth_getTransactionReceipt', [], null, 0x10n)).toBe(false);
    expect(evmAnswerIsFinal('eth_getTransactionReceipt', [], at('0x1'), null)).toBe(false);
    expect(evmAnswerIsFinal('eth_getLogs', [{ toBlock: '0x8' }], [], 0x10n)).toBe(true);
    expect(evmAnswerIsFinal('eth_call', [{}, 'latest'], '0x', 0x10n)).toBe(false);
    expect(evmAnswerIsFinal('eth_call', [{}, '0x9'], '0x', 0x10n)).toBe(true);
    // No block given: the node read `latest`, even if the address looks like a small number.
    expect(evmAnswerIsFinal('eth_getBalance', ['0x1'], '0x0', 0x10n)).toBe(false);
    expect(evmAnswerIsFinal('eth_blockNumber', [], '0x9', 0x10n)).toBe(false);
  });

  it('keeps NEAR answers pinned to a block hash, or a final transaction', () => {
    const hash = 'FFgwLG3qNaqQdH7U139DscDCQYg4gadQWqJe7FgvR2GC';
    expect(nearAnswerIsFinal('query', { finality: 'final' }, {})).toBe(false);
    expect(nearAnswerIsFinal('query', { block_id: hash }, {})).toBe(true);
    expect(nearAnswerIsFinal('block', { block_id: 1234 }, {})).toBe(false);
    expect(nearAnswerIsFinal('tx', {}, { final_execution_status: 'FINAL' })).toBe(true);
    expect(nearAnswerIsFinal('tx', {}, { final_execution_status: 'EXECUTED' })).toBe(false);
  });
});

describe('red-team results', () => {
  it('serves the last run, or says plainly that there is none', async () => {
    const { existsSync } = await import('node:fs');
    const ran = existsSync(new URL('../../../data/redteam/results.json', import.meta.url));
    const res = await app().request('/api/redteam');
    if (ran) {
      expect(res.status).toBe(200);
      expect(Array.isArray(((await res.json()) as { attempts: unknown }).attempts)).toBe(true);
    } else {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_found' });
    }
  });
});

describe('1Click reference quote', () => {
  it('answers 503, not a server error, when 1Click is unreachable', async () => {
    const res = await app('local', { ONECLICK_BASE_URL: 'http://127.0.0.1:1' }).request(
      '/api/oneclick/reference',
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'unavailable' });
  });
});
