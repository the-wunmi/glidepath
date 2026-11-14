import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from 'near-sandbox';
import type { KeyPairString } from './client.ts';

/** The root account and key of every node near-sandbox starts, the app's `pnpm dev:local` one included. */
export const SANDBOX_ROOT = {
  accountId: DEFAULT_ACCOUNT_ID,
  key: DEFAULT_PRIVATE_KEY as KeyPairString,
};

export interface LocalNear {
  rpcUrl: string;
  rootAccount: string;
  rootKey: KeyPairString;
  stop: () => Promise<void>;
}

/**
 * Starts a throwaway NEAR sandbox node. State lives in a temp directory, so every start is a fresh
 * chain; the app's bootstrap redeploys and reseeds it (see packages/engine/src/world.ts).
 */
export async function startNearSandbox(rpcPort?: number): Promise<LocalNear> {
  if (rpcPort) await clearStaleLock(rpcPort);
  const sandbox = await Sandbox.start(rpcPort ? { config: { rpcPort } } : {});
  return {
    rpcUrl: sandbox.rpcUrl,
    rootAccount: DEFAULT_ACCOUNT_ID,
    rootKey: DEFAULT_PRIVATE_KEY as KeyPairString,
    stop: () => sandbox.tearDown(),
  };
}

const portIsFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

/**
 * near-sandbox reserves its port with a lock file in the temp directory. A process killed without
 * cleanup leaves the file behind and every later start fails; if nothing listens on the port, the
 * lock is stale and goes.
 */
async function clearStaleLock(port: number): Promise<void> {
  if (await portIsFree(port))
    await rm(join(tmpdir(), `near-sandbox-port-${port}.lock`), { force: true });
}
