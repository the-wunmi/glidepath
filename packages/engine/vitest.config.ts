import { freshTestDatabase } from '@vsp/db/test-databases';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  test: {
    fileParallelism: false,
    testTimeout: 300_000,
    // Setup starts a NEAR sandbox and a Hardhat node, deploys every contract and fast-forwards
    // past the enclave activation delay (about 2,100 blocks); under a busy machine that alone
    // can take several minutes.
    hookTimeout: 600_000,
    env: await freshTestDatabase('engine'),
  },
}));
