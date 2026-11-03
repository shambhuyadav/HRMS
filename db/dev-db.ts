// Local development PostgreSQL without Docker: a persistent embedded server in .dev-pg on port 54329.
// Usage: npm run db:dev  (leave it running), then set DATABASE_URL to the printed URL.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const dir = join(process.cwd(), '.dev-pg');
const port = 54329;
// initdb flags apply only when the cluster is first created; an existing .dev-pg keeps its encoding.
const server = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'hrms',
  password: 'hrms_local_only',
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale-provider=icu', '--icu-locale=und', '--locale=C'],
});
const fresh = !existsSync(join(dir, 'PG_VERSION'));
if (fresh) await server.initialise();
await server.start();
if (fresh) await server.createDatabase('hrms_dev');
console.log(`Development database running. DATABASE_URL=postgres://hrms:hrms_local_only@127.0.0.1:${port}/hrms_dev`);
const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
