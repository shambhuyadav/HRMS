// Test fixtures of the lifecycle module (synthetic data only: example.test addresses, obviously fake names).
import { expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { type PermissionKey, parsePermissionKey } from '../access/baseline.js';
import type { Company, Harness, TestActor } from '../../test/harness.js';

export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const key = (prefix = 'lc-key-') => uniq(prefix);
export const pdf = Buffer.from('%PDF-1.4\n% synthetic evidence\n%%EOF\n').toString('base64');

/** Confidential grants of an eligible HR Administrator assignment (approved per assignment in tests). */
export const HR_NOTES: PermissionKey[] = ['employee_process.read.note', 'employee_process.read_evidence.evidence', 'employee_note.read.restricted', 'employee_note.write.restricted'];
export const HR_LETTERS: PermissionKey[] = ['letter.generate.letter', 'letter.read.letter'];
export const HR_SETTLEMENT: PermissionKey[] = [
  'settlement.read.amount',
  'settlement.prepare.amount',
  'settlement.review.amount',
  'settlement.approve.amount',
  'settlement.release.amount',
];
/** The same grants plus the separate export right (FR-002, 0119). */
export const HR_SETTLEMENT_EXPORT: PermissionKey[] = [...HR_SETTLEMENT, 'settlement.export.amount'];

export async function today(h: Harness, company: Company): Promise<string> {
  return (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [company.id])).d;
}

/** An active employee created through the API (HR needs the employee create duty), optionally reporting to a manager. */
export async function person(h: Harness, company: Company, hr: TestActor, opts: { managerId?: string; name?: string; status?: string } = {}): Promise<string> {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company, { displayName: opts.name ?? 'Synthetic Person' }));
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  await h.setStatus(company, id, opts.status ?? 'ACTIVE_CONFIRMED');
  if (opts.managerId) {
    const m = await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: opts.managerId, effectiveFrom: '2026-01-05' });
    expect(m.statusCode, m.body).toBeLessThan(300);
  }
  return id;
}

export async function statusOf(h: Harness, employeeId: string): Promise<string> {
  return (await h.one<{ s: string }>(`select st.code as s from employee e join reference_value st on st.id = e.status_id where e.id = $1`, [employeeId])).s;
}

export interface TaskSpec {
  code: string;
  title: string;
  ownerRoleCode?: string;
  ownerUserId?: string;
  required: boolean;
  dueOffsetDays: number;
  evidenceRequired: boolean;
}

/** Creates and publishes a process template; returns its id. */
export async function publishedTemplate(h: Harness, hr: TestActor, code: string, processType: string, tasks: TaskSpec[]): Promise<string> {
  const created = await h.call(hr, 'POST', '/v1/lifecycle-processes', { code, name: `${code} (synthetic)`, processType, tasks });
  expect(created.statusCode, created.body).toBe(201);
  const t = created.json();
  const draft = t.revisions.find((r: { state: string }) => r.state === 'DRAFT');
  const published = await h.call(hr, 'POST', `/v1/lifecycle-processes/${t.id}/publish`, { revision: draft.revision, expectedVersion: draft.version });
  expect(published.statusCode, published.body).toBe(200);
  return t.id as string;
}

/**
 * What a route guard resolves for an actor before its transaction opens, after which the assignment's DB109 entry
 * for that permission is withdrawn (docs/09 §6.5: the transaction must re-check and refuse).
 */
export async function narrowedGrant(h: Harness, company: Company, a: TestActor, permission: PermissionKey): Promise<AccessGrant> {
  const { resource, action, fieldGroup } = parsePermissionKey(permission);
  const grant = await resolveAccess(h.pool, { userId: a.user, companyId: company.id, assignmentId: a.assignment, resource, action, fieldGroups: [fieldGroup] });
  expect(grant.allowed).toBe(true);
  await h.db.query(
    `update role_assignment_permission set active = false
      where company_id = $1 and role_assignment_id = $2
        and permission_id = (select id from permission where resource = $3 and action = $4 and field_group = $5)`,
    [company.id, a.assignment, resource, action, fieldGroup],
  );
  return grant as AccessGrant;
}

/** Audit before/after values and outbox payloads of a record, as one text for leak checks. */
export async function trailText(h: Harness, companyId: string, recordKeys: string[]): Promise<string> {
  const a = await h.one<{ t: string }>(
    `select coalesce(string_agg(coalesce(before_values::text, '') || ' ' || coalesce(after_values::text, ''), ' '), '') as t from audit_event where company_id = $1 and record_key = any($2::uuid[])`,
    [companyId, recordKeys],
  );
  const o = await h.one<{ t: string }>(`select coalesce(string_agg(payload::text, ' '), '') as t from outbox_event where company_id = $1`, [companyId]);
  return `${a.t} ${o.t}`;
}
