// Disposable PostgreSQL database for one test file.
//   * TEST_DATABASE_URL: use that (empty, owned) database directly, e.g. in CI with Docker.
//   * TEST_PG_ADMIN_URL (set by global-setup.ts): clone the migrated template into a fresh database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../migrate.js';
import { TEMPLATE_DB } from './global-setup.js';

export interface TestDatabase {
  client: pg.Client;
  /** For tests that need their own pool (e.g. the API under test). */
  connectionString: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    const client = new pg.Client({ connectionString: external });
    await client.connect();
    await migrate(client);
    return { client, connectionString: external, stop: () => client.end() };
  }

  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  if (!adminUrl) throw new Error('No test database: run through vitest (global setup) or set TEST_DATABASE_URL');
  return createDatabase(adminUrl, TEMPLATE_DB);
}

/**
 * An empty database (nothing migrated) for upgrade tests, which migrate it step by step themselves. Null when only
 * TEST_DATABASE_URL is set, since such a run cannot create databases.
 */
export async function startEmptyTestDatabase(): Promise<TestDatabase | null> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  return adminUrl ? createDatabase(adminUrl, 'template0') : null;
}

async function createDatabase(adminUrl: string, template: string): Promise<TestDatabase> {
  const name = `hrms_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name} template ${template}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const connectionString = url.toString();
  const client = new pg.Client({ connectionString });
  await client.connect();
  return {
    client,
    connectionString,
    async stop() {
      await client.end();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}
