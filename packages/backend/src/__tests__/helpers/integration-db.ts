/**
 * Integration test DB helper.
 *
 * Connects to a real Postgres database (provided via TEST_DATABASE_URL) and
 * resets it to the schema defined in schema.prisma using `prisma db push`.
 *
 * Why db push rather than migrate deploy:
 * The migrations folder has historical baselining: the earliest migration
 * assumes tables already exist from a pre-tracked `db push` setup. Fresh
 * databases therefore can't replay the migration history from empty. In
 * production this is handled by `prisma/baseline.sh` which marks old
 * migrations as already applied. In tests we don't need the migration
 * history — we need to verify that the Prisma client and the schema agree,
 * which is exactly what `db push` provides (schema.prisma is the source of
 * truth and the DB is reset to match).
 *
 * Integration tests gated behind TEST_DATABASE_URL. When the env var is
 * unset, any test importing this helper will skip via `describe.skip`.
 *
 * IMPORTANT — must run serially:
 *   Multiple integration test files all call `getIntegrationDb()`, each of
 *   which runs `prisma db push --force-reset`. Jest's default worker pool
 *   would have parallel workers racing the reset, wiping each others' seed
 *   data mid-test. Use the `test:integration` npm script (which sets
 *   `--runInBand`) or pass it explicitly when running directly.
 */
import { execSync } from 'child_process';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const SCHEMA_PATH = path.resolve(__dirname, '../../../prisma/schema.prisma');

let cachedClient: PrismaClient | null = null;

export const INTEGRATION_DB_AVAILABLE = !!process.env.TEST_DATABASE_URL;

/**
 * Reset the test DB to match schema.prisma and return a Prisma client
 * bound to it. Safe to call multiple times — the first call does the push,
 * subsequent calls reuse the same client.
 */
export async function getIntegrationDb(): Promise<PrismaClient> {
  if (!INTEGRATION_DB_AVAILABLE) {
    throw new Error(
      'Integration DB not configured. Set TEST_DATABASE_URL to a Postgres URL ' +
        'pointing at an expendable test database (it will be wiped).'
    );
  }

  if (cachedClient) {
    return cachedClient;
  }

  // Apply schema.prisma to the test DB. --force-reset wipes existing data.
  // Schema path is absolute so this works regardless of the jest CWD.
  execSync(
    `npx prisma db push --force-reset --skip-generate --accept-data-loss --schema ${SCHEMA_PATH}`,
    {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
      stdio: 'pipe',
    }
  );

  cachedClient = new PrismaClient({
    datasources: { db: { url: process.env.TEST_DATABASE_URL } },
  });

  await cachedClient.$connect();
  return cachedClient;
}

/**
 * Disconnect the integration DB client. Call in afterAll().
 */
export async function closeIntegrationDb(): Promise<void> {
  if (cachedClient) {
    await cachedClient.$disconnect();
    cachedClient = null;
  }
}

/**
 * Skip a describe block if the integration DB isn't configured.
 * Usage:
 *   integrationDescribe('my suite', () => { ... });
 */
export const integrationDescribe = INTEGRATION_DB_AVAILABLE ? describe : describe.skip;
