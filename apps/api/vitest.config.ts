import { freshTestDatabase } from '@vsp/db/test-databases';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  // Plan authorization is checked against real Postgres rows.
  test: { env: await freshTestDatabase('api') },
}));
