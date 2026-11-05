// Local development PostgreSQL without Docker: a persistent embedded server in .dev-pg on port 54329.
// Usage: set DEV_DB_PASSWORD to a password of your own, run npm run db:dev (leave it running), then set DATABASE_URL as printed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const dir = join(process.cwd(), '.dev-pg');
const port = 54329;
const fresh = !existsSync(join(dir, 'PG_VERSION'));
// The password, like the initdb flags, applies only when the cluster is first created: an existing .dev-pg keeps the one it was made with.
const password = process.env.DEV_DB_PASSWORD;
if (fresh && !password) throw new Error('DEV_DB_PASSWORD is not set: choose a local password of your own before the first start (see .env.example)');
const server = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'hrms',
  password: password ?? '',
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale-provider=icu', '--icu-locale=und', '--locale=C'],
});
if (fresh) await server.initialise();
await server.start();
if (fresh) await server.createDatabase('hrms_dev');
console.log(`Development database running. DATABASE_URL=postgres://hrms:<your DEV_DB_PASSWORD>@127.0.0.1:${port}/hrms_dev`);
const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
