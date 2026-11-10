// First run of a production database: applies the migrations, then creates the company and its first System Administrator and HR
// Administrator (apps/api/src/admin/bootstrap.ts). Idempotent. Usage (on the server, with the production environment loaded):
//   BOOTSTRAP_COMPANY_CODE=ACME BOOTSTRAP_COMPANY_NAME='Acme Ltd' BOOTSTRAP_ADMIN_EMAIL=it@acme.example BOOTSTRAP_HR_EMAIL=hr@acme.example \
//     npx tsx db/bootstrap-production.ts
import pg from 'pg';
import { bootstrapCompany } from '../apps/api/src/admin/bootstrap.js';
import { migrate } from './migrate.js';

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
};
const client = new pg.Client({ connectionString: required('DATABASE_URL') });
await client.connect();
try {
  await migrate(client);
  const result = await bootstrapCompany(client, {
    companyCode: required('BOOTSTRAP_COMPANY_CODE'),
    companyName: required('BOOTSTRAP_COMPANY_NAME'),
    adminEmail: required('BOOTSTRAP_ADMIN_EMAIL'),
    hrEmail: required('BOOTSTRAP_HR_EMAIL'),
    effectiveFrom: process.env.BOOTSTRAP_EFFECTIVE_FROM?.trim() || new Date().toISOString().slice(0, 10),
  });
  console.log(JSON.stringify(result));
} finally {
  await client.end();
}
