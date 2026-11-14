import { parseInput, toJson } from '@vsp/core';
import type { Engine } from '@vsp/engine';
import * as engine from '@vsp/engine';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

/**
 * The blind trust prototype (Labs). Reads tell the page which contract and enclave to use and what
 * the trust is worth; the receipts, envelope and allowlist the page reads from the chain itself.
 * Writes act for the official persona, like the founder's plan actions.
 */
export function trustRoutes(e: Engine, principal: (c: Context) => engine.PlanPrincipal) {
  const app = new Hono();
  const json = (value: unknown, status: 200 | 201 = 200) =>
    new Response(toJson(value), { status, headers: { 'content-type': 'application/json' } });
  const trustId = (c: Context) => parseInput(z.coerce.number().int().positive(), c.req.param('id'));

  app.get('/meta', async () => {
    const world = e.world.trust;
    if (!world) return json({ available: false });
    const [identity, config] = await Promise.all([
      e.enclave.identity(),
      engine.trustsOf(e).config(),
    ]);
    const signingKey = await engine.trustEnclaveOf(e).signingKey();
    return json({
      available: true,
      network: e.world.network ?? 'local',
      contract: world.contract,
      official: e.world.founder,
      minCoolingOffMs: config.min_cooling_off_ms,
      tokens: world.tokens.map((t) => ({
        asset: `nep141:${t.account}`,
        symbol: t.symbol,
        name: t.name,
        sector: t.sector,
        decimals: t.decimals,
      })),
      // The page seals to this key after checking the attestation binds it to the signing key.
      enclave: {
        mode: identity.mode,
        signingKey,
        encryptionKeyHex: identity.encryptionKeyHex,
        quote: identity.quote,
        quoteHash: identity.quoteHash,
        sameAsAttested: signingKey === identity.signingKey,
      },
    });
  });
  app.get('/', async () => json(e.world.trust ? await engine.listTrusts(e) : []));
  app.get('/:id', async (c) => json(await engine.trustSummary(e, trustId(c))));
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => undefined);
    return json(await engine.createTrust(e, body), 201);
  });
  app.post('/:id/cancel', async (c) => json(await engine.cancelTrust(e, principal(c), trustId(c))));
  return app;
}
