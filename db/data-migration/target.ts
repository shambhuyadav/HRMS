// What the target company already holds, read in one read-only transaction (validate writes nothing to the company): its
// organisation masters, controlled lists, shifts, currencies, employees and the codes an earlier run of the same migration loaded,
// so a re-run is not mistaken for a duplicate (DQ-05, DQ-10).
import { createHash } from 'node:crypto';
import type { Database } from '../../apps/api/src/db/transaction.js';
import type { Queryable } from '../../apps/api/src/db/queryable.js';
import { MASTER_KINDS, type MasterKind } from './model.js';

export interface TargetFacts {
  companyId: string;
  companyCode: string;
  masters: Record<MasterKind, Map<string, { active: boolean; validFrom: string | null; validTo: string | null }>>;
  employmentTypes: Set<string>;
  leaveTypes: Set<string>;
  /** Active shifts by code. */
  shifts: Set<string>;
  /** currency code -> minor unit (the currency reference, 0145). */
  currencies: Map<string, number>;
  /** Currencies an active payroll calendar pays in (loans need one). */
  loanCurrencies: Map<string, number>;
  /** employee code -> work email and whether this migration's own committed onboarding batch created it. */
  employees: Map<string, { email: string | null; migrated: boolean }>;
  /** lower-cased work email -> employee code. */
  emails: Map<string, string>;
}

/** The idempotency-key prefix of every import batch a migration submits (load.ts). */
export const jobKeyPrefix = (migrationId: string) => `data-migration:${migrationId}:`;

/** The audit record key of a migration in a company (audit_event.record_key is a uuid): name-based, the same on every run. */
export function migrationRecordKey(companyId: string, migrationId: string): string {
  const h = createHash('sha256').update(`data-migration:${companyId}:${migrationId}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Escapes LIKE wildcards. */
export const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, '\\$&')}%`;

export async function readTargetFacts(db: Queryable, companyCode: string, migrationId: string): Promise<TargetFacts> {
  const company = (await db.query<{ id: string; code: string }>(`select id, code from company where code = $1 and active`, [companyCode.trim().toUpperCase()])).rows[0];
  if (!company) throw new Error(`No active company ${companyCode}`);
  const c = company.id;
  const masters = {} as TargetFacts['masters'];
  for (const kind of MASTER_KINDS) {
    const rows = (await db.query<{ code: string; active: boolean; valid_from: string | null; valid_to: string | null }>(`select code, active, valid_from::text, valid_to::text from ${kind} where company_id = $1`, [c])).rows;
    masters[kind] = new Map(rows.map((r) => [r.code, { active: r.active, validFrom: r.valid_from, validTo: r.valid_to }]));
  }
  const codes = async (sql: string) => new Set((await db.query<{ code: string }>(sql, [c])).rows.map((r) => r.code));
  const employees = (
    await db.query<{ code: string; email: string | null; migrated: boolean }>(
      `select e.employee_code as code, e.work_email as email,
              exists (select 1 from import_row r join import_job j on j.company_id = r.company_id and j.id = r.job_id
                       where r.company_id = e.company_id and r.business_key = e.employee_code and r.state = 'ACCEPTED'
                         and j.kind = 'employee' and j.state = 'COMMITTED' and j.idempotency_key like $2) as migrated
         from employee e where e.company_id = $1`,
      [c, likePrefix(jobKeyPrefix(migrationId))],
    )
  ).rows;
  return {
    companyId: c,
    companyCode: company.code,
    masters,
    employmentTypes: await codes(`select code from reference_value where company_id = $1 and category = 'EMPLOYMENT_TYPE' and active`),
    leaveTypes: await codes(`select code from leave_type where company_id = $1`),
    shifts: await codes(`select code from shift where company_id = $1 and active`),
    currencies: new Map((await db.query<{ code: string; minor_unit: number }>(`select code, minor_unit from currency`)).rows.map((r) => [r.code, Number(r.minor_unit)])),
    loanCurrencies: new Map(
      (await db.query<{ code: string; m: number }>(`select currency_code as code, min(currency_minor_unit) as m from payroll_calendar where company_id = $1 and state = 'ACTIVE' group by currency_code`, [c])).rows.map(
        (r) => [r.code, Number(r.m)],
      ),
    ),
    employees: new Map(employees.map((e) => [e.code, { email: e.email, migrated: e.migrated }])),
    emails: new Map(employees.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e.code])),
  };
}

/** Runs `work` in a read-only transaction that is always rolled back, so nothing it calls can write. */
export async function readOnly<T>(db: Database, work: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    return await work(client);
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}
