import { freshTestDatabase } from '@vsp/db/test-databases';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  // Plan authorization and the daily caps are checked against real Postgres rows.
  test: { env: await freshTestDatabase('api') },
}));
