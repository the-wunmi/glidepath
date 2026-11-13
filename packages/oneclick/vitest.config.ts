import { freshTestDatabase } from '@vsp/db/test-databases';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  test: { fileParallelism: false, env: await freshTestDatabase('oneclick') },
}));
