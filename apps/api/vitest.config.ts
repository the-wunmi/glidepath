import { runMigrations } from '@vsp/db/migrate';
import { freshTestDatabase } from '@vsp/db/test-databases';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const env = await freshTestDatabase('api');
  // Migrated once here: test files run in parallel and would otherwise race to create the schema.
  await runMigrations(env.DATABASE_URL);
  // Plan authorization is checked against real Postgres rows.
  return { test: { env } };
});
