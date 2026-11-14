import { freshTestDatabase } from '@glidepath/db/test-databases';
import { defineConfig } from 'vitest/config';

/**
 * The engine on real local chains (`pnpm test:chain`): each file starts its own NEAR sandbox and
 * Hardhat node and has its own database, so files run side by side.
 */
export default defineConfig(async () => ({
  test: {
    include: ['test/**/*.chain.test.ts'],
    maxWorkers: 4,
    testTimeout: 300_000,
    // Setup starts the chains, deploys every contract and fast-forwards past the enclave
    // activation delay; on a busy machine that alone can take minutes.
    hookTimeout: 600_000,
    env: await freshTestDatabase('engine'),
  },
}));
