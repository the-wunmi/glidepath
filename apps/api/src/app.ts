import { DomainError, parseInput, toJson } from '@vsp/core';
import type { Engine } from '@vsp/engine';
import * as engine from '@vsp/engine';
import { rpcUnavailable } from '@vsp/evm';
import { nearRpcUnavailable } from '@vsp/near';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { clientKeyOf, RateLimit, TtlCache } from './limits.ts';
import { ChainAnswers, evmAnswerIsFinal, nearAnswerIsFinal } from './rpc-cache.ts';
import { trustRoutes } from './trust.ts';
import { vaultRoutes } from './vault.ts';

const STATUS: Record<DomainError['code'], ContentfulStatusCode> = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
  forbidden: 403,
  policy_error: 422,
  unavailable: 503,
};

/**
 * Fast-forwarding costs about 14 ms of wall time per sandbox block (300 ms of chain time), so an
 * hour is about 15 s of waiting; longer jumps would hold the request for minutes.
 */
const MAX_ADVANCE_MINUTES = 60;

/** The largest body the API takes. A sealed plan box is capped at 64 KB, so this leaves room for the JSON around it. */
const MAX_BODY_BYTES = 128 * 1024;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOUR_MS = 3_600_000;

/**
 * A page view makes a handful of API reads and polls a plan every few seconds; 120 a minute is
 * several open tabs, while a script hammering the API gets refused before it reaches the RPC.
 */
const READS_PER_WINDOW = 120;
const READ_WINDOW_MS = 60_000;
/** Meta and the plan list read the chain; a few seconds' staleness saves an RPC call per visitor. */
const READ_CACHE_MS = 3_000;
/** A 1Click outage is remembered this long, so each page view does not wait on it again. */
const REFERENCE_FAILURE_MS = 30_000;
/** Sepolia finalizes about every 6.4 minutes; a stale value only delays when answers are kept. */
const FINALIZED_CACHE_MS = 60_000;
/** What a 503 from the chain proxies asks the browser to wait: an endpoint's first rest is 1 s. */
const BUSY_RETRY_AFTER_S = 2;
/** eth_getLogs ranges wider than this are refused: public nodes choke on them. */
const MAX_LOG_BLOCKS = 5_000n;

/** A founder session (create, launch, enroll, a change or two) takes about ten writes. */
const WRITES_PER_WINDOW = 30;
const WRITE_WINDOW_MS = 10 * 60_000;
/** The verifier page reads a plan's receipts through /rpc: a few dozen calls per check. */
const RPC_CALLS_PER_WINDOW = 300;
const RPC_WINDOW_MS = 60_000;
/**
 * Each plan deploys a plan account paid by the relayer's testnet NEAR. The total is the engine's
 * durable daily cap (MAX_PLANS_PER_DAY); this keeps one address from taking all of it.
 */
const PLANS_PER_HOUR_PER_CLIENT = 3;

/**
 * Read-only methods the verifier page may call on the chains through this proxy. Anything that
 * writes (send_tx, eth_sendRawTransaction) is refused, so the proxy cannot be used to act.
 */
const NEAR_READ_METHODS = new Set([
  'query',
  'block',
  'tx',
  'EXPERIMENTAL_tx_status',
  'status',
  'chunk',
]);
const EVM_READ_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_getBalance',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_getLogs',
]);

const json = (value: unknown, status: ContentfulStatusCode = 200) =>
  new Response(toJson(value), { status, headers: { 'content-type': 'application/json' } });

/** Every refusal has one shape: `error` and `code` both carry the code (older clients read `error`). */
const fail = (code: string, message: string, status: ContentfulStatusCode, details?: unknown) =>
  json({ error: code, code, message, ...(details === undefined ? {} : { details }) }, status);

/** The raw body; the engine function it goes to validates it. Malformed JSON fails there. */
const body = <T>(c: Context): Promise<T> => c.req.json<T>().catch(() => undefined as T);

const planId = (c: Context) => parseInput(z.coerce.number().int().positive(), c.req.param('id'));

export function createApp(e: Engine) {
  const app = new Hono();
  /** The one background fast-forward allowed at a time. */
  let advancing: Promise<void> | null = null;

  app.onError((err) => {
    if (err instanceof DomainError)
      return fail(err.code, err.message, STATUS[err.code], err.details);
    if (err instanceof engine.LimitError)
      return fail(err.code, err.message, err.code === 'busy' ? 503 : 429);
    e.log('request failed', { error: err instanceof Error ? err.stack : String(err) });
    return fail('internal', 'Something went wrong on our side', 500);
  });
  app.notFound(() => fail('not_found', 'No such route', 404));
  app.use('*', secureHeaders());
  const publicOrigin = e.config.PUBLIC_ORIGIN;
  app.use('/api/*', cors({ origin: publicOrigin ?? e.config.WEB_ORIGIN }));
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => fail('too_large', 'Body too large', 413),
    }),
  );

  /** `Authorization: Bearer <OPERATOR_TOKEN>`, compared in constant time. */
  const operatorToken = e.config.OPERATOR_TOKEN;
  const isOperator = (c: Context) => {
    const bearer = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    return !!operatorToken && !!bearer && engine.sameSecret(bearer, operatorToken);
  };
  /** Who is asking to manage a plan; the engine checks it against the plan's key hash. */
  const principal = (c: Context): engine.PlanPrincipal => ({
    operator: isOperator(c),
    planKey: c.req.header('x-plan-key') ?? null,
  });

  // Founder actions sign with keys this process holds, so a page on another site must not be able
  // to trigger them: API writes need a JSON body (a cross-site form or no-cors fetch cannot send one
  // without a preflight), and any write the browser labels with an Origin must come from ours. With
  // PUBLIC_ORIGIN set, the public URL is the only origin accepted, and an API write with no Origin
  // at all (not a browser) needs the operator token; the read-only /rpc proxies stay open to
  // scripts such as verify-receipts. The 1Click simulator's routes are exempt: this process calls
  // them on loopback, and the proxy layer below hides them from everyone else.
  const allowedOrigins = new Set(
    publicOrigin
      ? [publicOrigin]
      : [e.config.WEB_ORIGIN, e.config.API_ORIGIN, 'http://127.0.0.1:3400'],
  );
  app.use('*', async (c, next) => {
    if (READ_METHODS.has(c.req.method) || c.req.path.startsWith('/sim/')) return next();
    const origin = c.req.header('origin');
    const jsonBody = (c.req.header('content-type') ?? '').startsWith('application/json');
    const crossSite =
      (c.req.path.startsWith('/api/') && !jsonBody) ||
      (origin
        ? !allowedOrigins.has(origin)
        : !!publicOrigin && c.req.path.startsWith('/api/') && !isOperator(c));
    if (crossSite) return fail('forbidden', 'Cross-site requests are not accepted', 403);
    return next();
  });

  // Behind the proxy (PUBLIC_ORIGIN set) anyone can reach the API, and every founder action spends
  // the relayer's testnet NEAR, so requests are rate-limited per client address (an IPv6 client
  // by its /64): writes, chain proxy calls, and API reads, which share the RPC budget. The proxy
  // overwrites X-Forwarded-For with the client's address and the API port is published on
  // loopback only, so the right-most value is the proxy's word; without a proxy any client could
  // set it.
  const behindProxy = Boolean(publicOrigin);
  const socketAddress = (c: Context) =>
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
      ?.remoteAddress;
  const clientKey = (c: Context) =>
    clientKeyOf(
      c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || socketAddress(c) || 'unknown',
    );
  const reads = new RateLimit(READS_PER_WINDOW, READ_WINDOW_MS);
  const writes = new RateLimit(WRITES_PER_WINDOW, WRITE_WINDOW_MS);
  const rpcCalls = new RateLimit(RPC_CALLS_PER_WINDOW, RPC_WINDOW_MS);
  const planCreations = new RateLimit(PLANS_PER_HOUR_PER_CLIENT, HOUR_MS);
  const tooMany = () => fail('rate_limited', 'Too many requests from here. Try again later.', 429);
  app.use('*', async (c, next) => {
    if (!behindProxy) return next();
    const path = c.req.path;
    // The 1Click simulator is called only by this process, through API_ORIGIN on loopback.
    if (path.startsWith('/sim/'))
      return LOOPBACK.has(socketAddress(c) ?? '')
        ? next()
        : fail('not_found', 'No such route', 404);
    if (c.req.method === 'OPTIONS') return next();
    const limit = path.startsWith('/rpc/')
      ? rpcCalls
      : READ_METHODS.has(c.req.method)
        ? path.startsWith('/api/')
          ? reads
          : null
        : writes;
    if (limit && !limit.take(clientKey(c))) return tooMany();
    return next();
  });

  /** Demo controls on the public server belong to the operator. */
  const assertSimControl = (c: Context) => {
    if (publicOrigin && !isOperator(c))
      throw new DomainError('forbidden', 'Only the operator can change the demo');
  };

  // EVM off (a server without Sepolia): no EVM plans, and the meta says so (`modes.evm: 'off'`).
  const evmOff = e.config.EVM_NETWORK === 'off';
  const refuseEvm = () => {
    throw new DomainError('unavailable', 'EVM plans are off on this server');
  };

  // ── Read ────────────────────────────────────────────────────────────────────
  const metaCache = new TtlCache<Awaited<ReturnType<typeof engine.metaView>>>(READ_CACHE_MS);
  const listCache = new TtlCache<Awaited<ReturnType<typeof engine.planList>>>(READ_CACHE_MS);
  const detailCache = new TtlCache<Awaited<ReturnType<typeof engine.planDetail>>>(READ_CACHE_MS);
  const addressCache = new TtlCache<{ evmToken: string; planEvmAddress: string }>(READ_CACHE_MS);
  /** After a write the next read should see it, not a cached copy from before. */
  const clearReadCaches = () => {
    listCache.clear();
    detailCache.clear();
    addressCache.clear();
    metaCache.clear();
  };
  app.get('/api/health', () => json({ ok: true }));
  app.get('/api/meta', async () => {
    const meta = await metaCache.get('meta', () => engine.metaView(e));
    return json(evmOff ? { ...meta, modes: { ...meta.modes, evm: 'off' } } : meta);
  });
  /** Whether this request carries the operator token, so the web can show operator controls. */
  app.get('/api/operator', (c) => json({ operator: isOperator(c) }));
  // One cached chain read serves every owner filter, so a stream of distinct ?owner= values
  // costs no extra RPC calls.
  app.get('/api/plans', async (c) => {
    const owner = c.req.query('owner') || undefined;
    const all = await listCache.get('all', () => engine.planList(e));
    return json(owner ? all.filter((p) => p.owner === owner) : all);
  });
  app.get('/api/plans/:id', async (c) => {
    const id = planId(c);
    return json(await detailCache.get(String(id), () => engine.planDetail(e, id)));
  });
  app.get('/api/addresses/next', async () => {
    if (evmOff) refuseEvm();
    return json(
      await addressCache.get('next', async () => ({
        evmToken: await engine.predictEvmTokenAddress(e, true),
        planEvmAddress: await engine.predictPlanEvmAddress(e, true),
      })),
    );
  });
  app.get('/api/replay', async () => {
    const { readFile } = await import('node:fs/promises');
    const file = new URL('../../../data/replay/results.json', import.meta.url);
    return new Response(await readFile(file, 'utf8'), {
      headers: { 'content-type': 'application/json' },
    });
  });

  app.route('/api/vault', vaultRoutes(e));
  app.route('/api/trusts', trustRoutes(e, principal));

  /** The last red-team run (data/redteam/results.json, written by `pnpm redteam`); 404 before one. */
  app.get('/api/redteam', async () => {
    const { readFile } = await import('node:fs/promises');
    const file = new URL('../../../data/redteam/results.json', import.meta.url);
    const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new DomainError('not_found', 'No red-team run yet');
      throw error;
    });
    return new Response(text, { headers: { 'content-type': 'application/json' } });
  });

  /**
   * A live, signed 1Click quote no plan uses (1Click has no testnet), so the browser can check the
   * real service's format and key. An unreachable 1Click is a 503, not a server fault.
   */
  const referenceCache = new TtlCache<Awaited<ReturnType<typeof engine.referenceQuote>>>(
    0,
    REFERENCE_FAILURE_MS,
  );
  app.get('/api/oneclick/reference', async () => {
    const quote = await referenceCache
      .get('reference', () =>
        engine.referenceQuote(e).catch((error: unknown) => {
          e.log('1click reference quote failed', { error: String(error) });
          throw error;
        }),
      )
      .catch(() => {
        throw new DomainError('unavailable', '1Click did not answer; try again shortly');
      });
    return json(quote);
  });

  /** The demo's real-unlock case (data/replay/case-*.json, built by `pnpm --filter @vsp/replay build:results`). */
  app.get('/api/replay/case', async () => {
    const { readFile } = await import('node:fs/promises');
    const file = new URL('../../../data/replay/case-arb-2024-03-16.json', import.meta.url);
    return new Response(await readFile(file, 'utf8'), {
      headers: { 'content-type': 'application/json' },
    });
  });

  // ── Founder actions (personas sign with keys this process holds) ───────────
  // Anyone may create a plan; it comes back with its owner key, the only credential for the owner
  // actions below (or the operator token). Finalize and reveal are open to anyone, as on chain.
  app.post('/api/plans', async (c) => {
    // The raw body: createPlan validates it; this only peeks at the chain.
    const input = await body<Parameters<typeof engine.createPlan>[1]>(c);
    if (evmOff && input?.token?.chain === 'evm') refuseEvm();
    // Only a valid plan counts against this address's hourly share; the daily cap is the engine's.
    await engine.checkNewPlan(e, input);
    if (behindProxy && !planCreations.take(clientKey(c))) return tooMany();
    const created = await engine.createPlan(e, input);
    clearReadCaches();
    return json(created, 201);
  });
  // Every write below changes what plan reads show.
  app.use('/api/plans/:id/*', async (c, next) => {
    await next();
    if (c.req.method === 'POST') clearReadCaches();
  });
  app.post('/api/plans/:id/launch', async (c) =>
    json(await engine.launchToken(e, principal(c), planId(c), await body(c))),
  );
  app.post('/api/plans/:id/enroll', async (c) =>
    json(await engine.enroll(e, principal(c), planId(c), await body(c))),
  );
  app.post('/api/plans/:id/change', async (c) =>
    json(await engine.requestChange(e, principal(c), planId(c), await body(c))),
  );
  app.post('/api/plans/:id/cancel', async (c) =>
    json(await engine.requestCancel(e, principal(c), planId(c), await body(c))),
  );
  app.post('/api/plans/:id/withdraw-change', async (c) =>
    json(await engine.withdrawChange(e, principal(c), planId(c), await body(c))),
  );
  app.post('/api/plans/:id/reveal', async (c) =>
    json(await engine.revealFromBackup(e, planId(c), await body(c))),
  );
  app.post('/api/plans/:id/finalize', async (c) => json(await engine.finalizePlan(e, planId(c))));
  app.post('/api/plans/:id/attempts/direct-transfer', async (c) =>
    json(await engine.tryDirectTransfer(e, principal(c), planId(c), await body(c))),
  );
  app.post('/api/plans/:id/attempts/add-key', async (c) =>
    json(await engine.tryAddKey(e, principal(c), planId(c), await body(c))),
  );

  // ── Simulation controls (operator only on the public server) ───────────────
  app.get('/api/sim', async () => json(await engine.readSimSettings(e.db)));
  app.put('/api/sim', async (c) => {
    assertSimControl(c);
    const settings = parseInput(engine.SimSettings, await body(c));
    // The real MPC network on testnet cannot be switched off from here.
    if (e.world.network === 'testnet') settings.mpcUp = true;
    await engine.writeSimSettings(e.db, settings);
    clearReadCaches();
    return json(settings);
  });
  app.post('/api/sim/advance', async (c) => {
    assertSimControl(c);
    if (e.world.network === 'testnet')
      throw new DomainError(
        'forbidden',
        'Only the local sandbox can move time; testnet runs in real time',
      );
    const { minutes } = parseInput(
      z.object({
        minutes: z.int().min(1).max(MAX_ADVANCE_MINUTES),
      }),
      await body(c),
    );
    if (advancing) throw new DomainError('conflict', 'Chain time is already moving forward');
    // Jump in steps under the 100-block validity window so in-flight transactions survive. It
    // takes seconds per minute of chain time, so it runs in the background and the page polls.
    const now = await e.near.chainTimeMs();
    const blocks = Math.ceil((minutes * 60_000) / engine.SANDBOX_MS_PER_BLOCK);
    advancing = (async () => {
      await e.near.fastForward(blocks);
    })()
      .catch((error) => e.log('advance failed', { error: String(error) }))
      .finally(() => {
        advancing = null;
      });
    return json({ chainTimeMs: now, targetChainTimeMs: now + minutes * 60_000 }, 202);
  });

  // ── Read-only chain proxies for the verifier page ──────────────────────────
  // Upstream error texts can name endpoints and internals: they go to the log, and the caller
  // gets a generic JSON-RPC error. 503 means no node could answer (try again); 400 means the node
  // answered with an error, which a retry would only repeat.
  const rpcError = (id: unknown, status: ContentfulStatusCode, message: string) =>
    json({ jsonrpc: '2.0', id, error: { code: -32000, message } }, status);
  const busy = (id: unknown, chain: string) => {
    const res = rpcError(id, 503, `The ${chain} RPC is busy; try again shortly`);
    res.headers.set('retry-after', String(BUSY_RETRY_AFTER_S));
    return res;
  };
  const notAllowed = () =>
    json(
      { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed here' } },
      403,
    );
  const nearAnswers = new ChainAnswers();
  const evmAnswers = new ChainAnswers();
  const finalizedCache = new TtlCache<bigint | null>(FINALIZED_CACHE_MS);
  /** Sepolia's finalized block, or null when the node does not say (a local node may not). */
  const finalizedBlock = () =>
    finalizedCache.get('finalized', async () => {
      const block = await e.reads.evm
        .request({ method: 'eth_getBlockByNumber', params: ['finalized', false] })
        .catch(() => null);
      return block?.number ? BigInt(block.number) : null;
    });

  // NEAR reads go through the engine's read client, paced apart from the engine's own calls and
  // failing over on a 429: visitors' polling cannot use up the budget sales and relays need.
  app.post('/rpc/near', async (c) => {
    const req = await body<{ id?: unknown; method?: string; params?: unknown }>(c);
    if (!req || typeof req.method !== 'string' || !NEAR_READ_METHODS.has(req.method))
      return notAllowed();
    const { method, params } = req;
    const id = req.id ?? null;
    try {
      const result = await nearAnswers.get(
        method,
        params,
        () => e.reads.near.provider.sendJsonRpc(method as never, params as never),
        (answer) => nearAnswerIsFinal(method, params, answer),
      );
      return json({ jsonrpc: '2.0', id, result });
    } catch (error) {
      e.log('near rpc proxy failed', { method, error: String(error) });
      if (error instanceof DomainError || nearRpcUnavailable(error)) return busy(id, 'NEAR');
      // near-api-js names the node's answer by class (AccountDoesNotExistError, ...): safe to pass on.
      const name = (error as Error)?.constructor?.name;
      return rpcError(
        id,
        400,
        name && /^[A-Z][A-Za-z]{2,63}Error$/.test(name) && name !== 'TypedError'
          ? name
          : 'The NEAR node refused this request',
      );
    }
  });

  app.post('/rpc/evm', async (c) => {
    if (evmOff) refuseEvm();
    const req = await body<{ id?: unknown; method?: string; params?: unknown }>(c);
    if (!req || typeof req.method !== 'string' || !EVM_READ_METHODS.has(req.method))
      return notAllowed();
    const { method, params } = req;
    const id = req.id ?? null;
    const refused = await evmRequestProblem(method, params);
    if (refused)
      return json({ jsonrpc: '2.0', id, error: { code: -32602, message: refused } }, 403);
    try {
      const result = await evmAnswers.get(
        method,
        params,
        () => e.reads.evm.request({ method, params } as never),
        async (answer) => evmAnswerIsFinal(method, params, answer, await finalizedBlock()),
      );
      return json({ jsonrpc: '2.0', id, result });
    } catch (error) {
      e.log('evm rpc proxy failed', { method, error: String(error) });
      if (rpcUnavailable(error)) return busy(id, 'EVM');
      return rpcError(id, 400, 'The EVM node refused this request');
    }
  });

  /**
   * Narrows the two EVM reads that could cost the node real work: log queries need explicit
   * numeric bounds no wider than MAX_LOG_BLOCKS and a plan token's address, and eth_call may only
   * read plan tokens.
   */
  async function evmRequestProblem(method: string, params: unknown): Promise<string | null> {
    const first = Array.isArray(params) ? (params[0] as Record<string, unknown> | undefined) : null;
    if (method === 'eth_getLogs') {
      const address = first?.address;
      const addresses = (Array.isArray(address) ? address : [address]).map((a) =>
        typeof a === 'string' ? a.toLowerCase() : '',
      );
      const tokens = await engine.evmPlanTokens(e);
      if (!addresses.length || !addresses.every((a) => tokens.has(a)))
        return 'eth_getLogs may only read plan tokens';
      const from = typeof first?.fromBlock === 'string' ? first.fromBlock : '';
      const to = typeof first?.toBlock === 'string' ? first.toBlock : '';
      if (!/^0x[0-9a-f]+$/i.test(from) || !/^0x[0-9a-f]+$/i.test(to))
        return 'eth_getLogs needs numeric fromBlock and toBlock';
      const span = BigInt(to) - BigInt(from);
      if (span < 0n || span >= MAX_LOG_BLOCKS)
        return `eth_getLogs covers at most ${MAX_LOG_BLOCKS} blocks`;
    }
    if (method === 'eth_call') {
      const to = typeof first?.to === 'string' ? first.to.toLowerCase() : '';
      if (!(await engine.evmPlanTokens(e)).has(to)) return 'eth_call may only read plan tokens';
      // Only a plain read: {to, data} and a block tag. State overrides, gas or value would let a
      // caller make the node do arbitrary work against a plan token's address.
      if (!Array.isArray(params) || params.length > 2) return 'eth_call takes [{to, data}, block]';
      if (Object.keys(first ?? {}).some((k) => k !== 'to' && k !== 'data' && k !== 'input'))
        return 'eth_call may only set to and data';
      const tag = params[1];
      if (
        tag !== undefined &&
        tag !== 'latest' &&
        !(typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag))
      )
        return "eth_call's block must be 'latest' or a block number";
    }
    return null;
  }

  // ── The 1Click simulator, on the real API's paths ───────────────────────────
  if (e.oneclickSim) app.route('/sim/1click', e.oneclickSim.routes);

  return app;
}
