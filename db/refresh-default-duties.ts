// One-time refresh of default duties on a production database (authorised by the owner on 11 Nov 2026; apps/api/src/admin/bootstrap.ts
// refreshDefaultDuties says exactly what it adds and what it never adds). A dry run unless REFRESH_CONFIRM=add-default-duties.
// Usage (on the server, with the production environment loaded; deploy/scripts/refresh-duties.sh runs it):
//   REFRESH_COMPANY=HRMS npx tsx db/refresh-default-duties.ts                                   (dry run: prints the plan)
//   REFRESH_COMPANY=HRMS REFRESH_CONFIRM=add-default-duties npx tsx db/refresh-default-duties.ts (applies it)
import pg from 'pg';
import { refreshDefaultDuties } from '../apps/api/src/admin/bootstrap.js';

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
};
const apply = process.env.REFRESH_CONFIRM === 'add-default-duties';
const client = new pg.Client({ connectionString: required('DATABASE_URL') });
await client.connect();
try {
  const result = await refreshDefaultDuties(client, {
    companyCode: required('REFRESH_COMPANY'),
    apply,
    reason:
      'One-time refresh of the default duties of existing grants after a release, authorised by the owner on 11 Nov 2026: the deployment has no independent approver for new grants (only its two first administrators)',
  });
  console.log(JSON.stringify(result, null, 1));
  if (!apply) console.log('Dry run: nothing was written. Set REFRESH_CONFIRM=add-default-duties to apply this plan.');
} finally {
  await client.end();
}
