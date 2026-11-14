import { freshTestDatabase } from '@glidepath/db/test-databases';
import { defineConfig } from 'vitest/config';

/** The engine's fast tests: stubs for the chains, seconds to run (`pnpm test`). */
export default defineConfig(async () => ({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.chain.test.ts'],
    env: await freshTestDatabase('engine'),
  },
}));
