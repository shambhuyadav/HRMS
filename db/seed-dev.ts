// Seeds the development database with one synthetic company (idempotent). Usage: npm run db:seed
import pg from 'pg';
import { seedDevCompany } from '../apps/api/src/dev/seed.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
if (process.env.NODE_ENV === 'production') throw new Error('The development seed never runs in production');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await migrate(client);
  const { accounts } = await seedDevCompany(client);
  console.log('Seeded synthetic company DEMO. Sign in at the web app with one of:');
  for (const [role, key] of Object.entries(accounts)) console.log(`  ${role.padEnd(9)} ${key}`);
} finally {
  await client.end();
}
