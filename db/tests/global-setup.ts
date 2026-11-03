// Vitest global setup: one embedded PostgreSQL per test run with a migrated template database.
// Each test file then clones the template (CREATE DATABASE ... TEMPLATE), keeping files isolated without
// paying server start-up and migration cost per file. Skipped when TEST_DATABASE_URL points elsewhere.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migrate } from '../migrate.js';

export const TEMPLATE_DB = 'hrms_template';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  if (process.env.TEST_DATABASE_URL) return async () => undefined;

  const dir = await mkdtemp(join(tmpdir(), 'hrms-pg-'));
  const port = await freePort();
  // UTF-8 with ICU root collation on every platform (the Windows default is a single-byte code page that cannot hold
  // names such as Devanagari), the same text behaviour as a production cluster.
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'hrms_test',
    password: 'hrms_test_only',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale-provider=icu', '--icu-locale=und', '--locale=C'],
    onLog: () => undefined,
  });
  await server.initialise();
  await server.start();
  await server.createDatabase(TEMPLATE_DB);

  const template = new pg.Client({ host: '127.0.0.1', port, user: 'hrms_test', password: 'hrms_test_only', database: TEMPLATE_DB });
  await template.connect();
  await migrate(template);
  await template.end(); // a template must have no open connections when cloned

  process.env.TEST_PG_ADMIN_URL = `postgres://hrms_test:hrms_test_only@127.0.0.1:${port}/postgres`;
  return async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  };
}
