// Test helpers (not a test file) for release gates that claim "nothing changed" (ZT01, ZT18): a digest of everything a company
// has stored, table by table, so a refused or rolled-back request can be compared against the whole database and not only the
// rows a test thought of. Tables without a company_id (sessions, global catalogues) are not business state and are left out.
import type { Harness } from './harness.js';

export type CompanyState = Record<string, string>;

async function companyTables(h: Harness): Promise<string[]> {
  const rows = await h.db.query<{ name: string }>(
    `select c.relname as name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
      order by c.relname`,
  );
  return rows.rows.map((r) => r.name);
}

/** One digest per company-owned table (with the company row itself). Equal digests mean no row was added, removed or changed. */
export async function companyState(h: Harness, companyId: string): Promise<CompanyState> {
  const tables = await companyTables(h);
  const digests = tables.map((t) => `select '${t}' as name, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as digest from "${t}" x where x.company_id = $1`);
  digests.push(`select 'company' as name, md5(x::text) as digest from company x where x.id = $1`);
  const rows = await h.db.query<{ name: string; digest: string }>(digests.join(' union all '), [companyId]);
  return Object.fromEntries(rows.rows.map((r) => [r.name, r.digest]));
}

/** The tables whose stored rows differ between two digests. */
export function changedTables(before: CompanyState, after: CompanyState): string[] {
  return Object.keys({ ...before, ...after })
    .filter((t) => before[t] !== after[t])
    .sort();
}
