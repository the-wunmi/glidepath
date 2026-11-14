import { readFile } from 'node:fs/promises';
import type { Engine } from '@vsp/engine';
import { Hono } from 'hono';

/**
 * The Bitcoin vault prototype's deployment record for this server's NEAR network (written by
 * `pnpm vault:deploy`, or by `pnpm vault:demo --local --rpc …` for the dev sandbox). The page reads
 * everything else from the chains itself; this only tells it which contract and vault to read.
 * `{ deployment: null }` when there is none.
 */
export function vaultRoutes(e: Engine) {
  const app = new Hono();
  const file =
    e.config.NEAR_NETWORK === 'testnet'
      ? `${e.config.DEPLOYMENTS_DIR}/vault-testnet.json`
      : `${e.config.DEPLOYMENTS_DIR}/local-vault.json`;
  app.get('/', async (c) => {
    const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!text) return c.json({ deployment: null });
    const record = JSON.parse(text) as Record<string, unknown>;
    // Only what the page needs; the record holds no secrets, but nothing else is anyone's business.
    return c.json({
      deployment: {
        network: record.network,
        contract: record.contract,
        signer_contract: record.signer_contract,
        mpc_root_public_key: record.mpc_root_public_key,
        min_delay_ms: record.min_delay_ms,
        deployed_at: record.deployed_at,
        vault: record.vault ?? null,
      },
    });
  });
  return app;
}
