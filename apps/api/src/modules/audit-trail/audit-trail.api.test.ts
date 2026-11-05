// Audit trail read/export and retention controls over HTTP (FR-058; DF08; DF02; C4; BR-026). Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let hrB: TestActor;
let auditor: TestActor;
let exporter: TestActor;
let keeper: TestActor;
let approver: TestActor;
let employeeId: string;
let workEmail: string;
let today: string;

type AuditItem = { id: string; resource: string; recordKey: string; action: string; actorUserId: string; actingRoleCode: string | null; valueGroups: string[]; changedFields: string[]; reasonRecorded: boolean };
const events = async (a: TestActor, query: string) => (await h.call(a, 'GET', `/v1/audit/events${query}`)).json() as { items: AuditItem[]; total: number };

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['employee.create.personal', 'employee.read.personal'] });
  hrB = await h.actor(B, 'HR_ADMINISTRATOR');
  auditor = await h.actor(A, 'AUDITOR');
  exporter = await h.actor(A, 'AUDITOR', { extra: ['audit.export.operational'] });
  keeper = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['retention.manage.operational', 'retention.approve.operational'] });
  approver = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['retention.manage.operational', 'retention.approve.operational'] });
  workEmail = `${uniq('audit.person')}@example.test`;
  const created = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { workEmail, dateOfBirth: '1991-07-14' }));
  expect(created.statusCode).toBe(201);
  employeeId = created.json().id;
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
});

afterAll(async () => {
  await h?.stop();
});

describe('audit trail read (FR-058, DF02)', () => {
  it('only an audit duty in company scope reads the trail; an employee or HR cannot', async () => {
    const self = await h.actor(A, 'EMPLOYEE', { employeeId });
    expect((await h.call(self, 'GET', '/v1/audit/events')).statusCode).toBe(403);
    expect((await h.call(hr, 'GET', '/v1/audit/events')).statusCode).toBe(403);
    expect((await h.call(auditor, 'GET', '/v1/audit/events')).statusCode).toBe(200);
    const filtered = await h.actor(A, 'AUDITOR', { departmentFilter: A.dept });
    expect((await h.call(filtered, 'GET', '/v1/audit/events')).statusCode).toBe(403);
  });

  it('shows who did what to which record and when, with field names but never values', async () => {
    const res = await events(auditor, `?resource=employee&recordKey=${employeeId}`);
    const create = res.items.find((e) => e.action === 'CREATE')!;
    expect(create).toMatchObject({ resource: 'employee', recordKey: employeeId, actorUserId: hr.user, actingRoleCode: 'HR_ADMINISTRATOR', reasonRecorded: false });
    expect(create.valueGroups).toEqual(['operational', 'personal']);
    expect(create.changedFields).toEqual(expect.arrayContaining(['employeeCode', 'workEmail', 'joiningDate']));
    const body = JSON.stringify(res);
    expect(body).not.toContain(workEmail);
    expect(body).not.toContain('1991-07-14');
  });

  it('never shows another company’s events, and pages consistently', async () => {
    const other = (await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B))).json().id;
    expect((await events(auditor, `?recordKey=${other}`)).items).toEqual([]);
    const all = await events(auditor, '?pageSize=100');
    expect(all.items.every((e) => e.resource !== undefined)).toBe(true);
    const page2 = await events(auditor, '?pageSize=1&page=2');
    expect(page2.total).toBe(all.total);
    expect(page2.items).toHaveLength(1);
  });
});

describe('audit export (FR-058, DF09)', () => {
  it('needs its own export duty, records requester and scope, and contains no values', async () => {
    const body = { reportCode: 'AUDIT_TRAIL', filters: { from: today, to: today } };
    expect((await h.call(auditor, 'POST', '/v1/reports', body)).statusCode).toBe(403);
    // HR holds ordinary report exports (e.g. leave.export) by default; they do not open the audit export.
    expect((await h.call(hr, 'POST', '/v1/reports', { reportCode: 'LEAVE_REGISTER', filters: { from: today, to: today } })).statusCode).toBe(202);
    expect((await h.call(hr, 'POST', '/v1/reports', body)).statusCode).toBe(403);
    expect((await h.call(exporter, 'POST', '/v1/reports', { reportCode: 'AUDIT_TRAIL', filters: { from: '2026-01-01', to: '2026-03-01' } })).json().error).toBe('PERIOD_TOO_LONG');

    const queued = await h.call(exporter, 'POST', '/v1/reports', body);
    expect(queued.statusCode).toBe(202);
    const { id } = queued.json();
    const execution = await h.one<{ requested_by: string; acting_assignment_id: string; scope_snapshot: { scopeKind: string }; created_at: Date }>(
      `select requested_by, acting_assignment_id, scope_snapshot, created_at from report_execution where id = $1`,
      [id],
    );
    expect(execution).toMatchObject({ requested_by: exporter.user, acting_assignment_id: exporter.assignment, scope_snapshot: { scopeKind: 'COMPANY' } });
    expect(execution.created_at).toBeInstanceOf(Date);

    await processReportQueue(h.pool);
    const download = await h.call(exporter, 'GET', `/v1/reports/${id}/download`);
    expect(download.statusCode).toBe(200);
    const csv = download.body;
    expect(csvTable(csv).split('\r\n')[0]).toContain('"Operational fields"');
    expect(csv).toContain(employeeId);
    expect(csv).not.toContain(workEmail);
    expect(csv).not.toContain('1991-07-14');
    // Another user cannot fetch the output.
    expect((await h.call(auditor, 'GET', `/v1/reports/${id}/download`)).statusCode).toBe(404);
  });

  it('a filtered view and its export hold the same events, and the filters stay in the snapshot (FR-058, BR-026)', async () => {
    const period = { from: today, to: today };
    const exportRows = async (filters: Record<string, string>) => {
      const queued = await h.call(exporter, 'POST', '/v1/reports', { reportCode: 'AUDIT_TRAIL', filters: { ...period, ...filters } });
      expect(queued.statusCode, queued.body).toBe(202);
      const { id } = queued.json();
      const snapshot = await h.one<{ filter_snapshot: Record<string, string> }>(`select filter_snapshot from report_execution where id = $1`, [id]);
      expect(snapshot.filter_snapshot).toEqual({ ...period, ...filters });
      await processReportQueue(h.pool);
      const status = (await h.call(exporter, 'GET', `/v1/reports/${id}`)).json();
      expect(status.state).toBe('COMPLETED');
      const body = (await h.call(exporter, 'GET', `/v1/reports/${id}/download`)).body;
      const lines = csvTable(body).trimEnd().split('\r\n').slice(1);
      expect(status.rowCount).toBe(lines.length);
      return lines.map((l: string) => JSON.parse(l.split(',')[2]!) as string).sort();
    };
    const viewKeys = async (filters: Record<string, string>) => {
      const q = new URLSearchParams({ ...period, ...filters, pageSize: '100' }).toString();
      const res = await events(auditor, `?${q}`);
      expect(res.total).toBeLessThanOrEqual(100);
      return { total: res.total, keys: res.items.map((e) => e.recordKey).sort() };
    };
    // Each filter of the viewer on its own and together, narrowing to a part of the company's events. The export's own
    // request is recorded as a report_execution event by the exporter, which none of these filters reach.
    for (const filters of [
      { resource: 'employee', recordKey: employeeId },
      { resource: 'employee' },
      { recordKey: employeeId },
      { actorUserId: hr.user, action: 'CREATE' },
      { action: 'CREATE', resource: 'employee' },
    ]) {
      const view = await viewKeys(filters);
      expect(view.total, JSON.stringify(filters)).toBeGreaterThan(0);
      expect(await exportRows(filters), JSON.stringify(filters)).toEqual(view.keys);
    }
    const everything = await exportRows({});
    expect(everything.length).toBeGreaterThan((await viewKeys({ resource: 'employee', recordKey: employeeId })).total);
    // A filter that matches nothing is an empty export of the same query, not the whole trail.
    expect(await exportRows({ recordKey: '00000000-0000-4000-8000-00000000dddd' })).toEqual([]);
  });

  it('refuses what the viewer refuses, and other reports do not take the audit filters', async () => {
    const post = (filters: Record<string, string>, reportCode = 'AUDIT_TRAIL') => h.call(exporter, 'POST', '/v1/reports', { reportCode, filters: { from: today, to: today, ...filters } });
    expect((await post({ resource: 'Not A Code' })).statusCode).toBe(400);
    expect((await post({ recordKey: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await post({ actorUserId: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await post({ action: 'lower' })).statusCode).toBe(400);
    const other = await h.call(hr, 'POST', '/v1/reports', { reportCode: 'LEAVE_REGISTER', filters: { from: today, to: today, resource: 'employee' } });
    expect([other.statusCode, other.json().error]).toEqual([422, 'FILTER_NOT_SUPPORTED']);
    // The export duty still comes first, and a filtered audit assignment is still refused.
    expect((await h.call(hr, 'POST', '/v1/reports', { reportCode: 'AUDIT_TRAIL', filters: { from: today, to: today, resource: 'employee' } })).statusCode).toBe(403);
    const narrowed = await h.actor(A, 'AUDITOR', { extra: ['audit.export.operational'], departmentFilter: A.dept });
    expect((await h.call(narrowed, 'POST', '/v1/reports', { reportCode: 'AUDIT_TRAIL', filters: { from: today, to: today, resource: 'employee' } })).statusCode).toBe(403);
  });
});

describe('retention rules and holds (FR-058, DF08, C4)', () => {
  let oldEvents: string[] = [];
  const heldRecord = '00000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    // Synthetic historical events (the trail is append-only; inserting old rows is how history arrives).
    oldEvents = [];
    for (const [resource, recordKey] of [
      ['employee', heldRecord],
      ['employee', '00000000-0000-4000-8000-000000000002'],
      ['leave_request', '00000000-0000-4000-8000-000000000003'],
    ] as const) {
      oldEvents.push(
        (
          await h.one<{ id: string }>(
            `insert into audit_event (company_id, resource_code, record_key, actor_user_id, action, after_values, occurred_at, created_by)
             values ($1, $2, $3, $4, 'CREATE', '{"operational": {}}', now() - interval '10 days', $4) returning id`,
            [A.id, resource, recordKey, hr.user],
          )
        ).id,
      );
    }
  });

  const eligibility = async () => (await h.call(keeper, 'GET', '/v1/retention/eligibility?resource=audit_event')).json();
  const holdVersion = async (id: string) => (await h.one<{ version: number }>(`select version from retention_hold where id = $1`, [id])).version;

  it('without an approved schedule nothing is eligible, and purge is disabled', async () => {
    expect(await eligibility()).toMatchObject({ resource: 'audit_event', rule: null, eligibleCount: 0, heldCount: 0, purgeEnabled: false });
  });

  it('a rule is activated only by someone other than its author', async () => {
    const proposed = await h.call(keeper, 'POST', '/v1/retention/rules', { resource: 'audit_event', retainDays: 1, basisNote: 'Synthetic test schedule' });
    expect(proposed.statusCode).toBe(201);
    const { id } = proposed.json();
    expect((await h.call(keeper, 'POST', `/v1/retention/rules/${id}/activate`, { expectedVersion: 1 })).json().error).toBe('SELF_APPROVAL');
    expect((await h.call(approver, 'POST', `/v1/retention/rules/${id}/activate`, { expectedVersion: 1 })).json().state).toBe('ACTIVE');
    const rules = (await h.call(keeper, 'GET', '/v1/retention/rules')).json().items;
    expect(rules).toMatchObject([{ id, state: 'ACTIVE', retainDays: 1, approvedBy: approver.user }]);
  });

  it('eligibility excludes records under an approved hold, and a released hold stops protecting', async () => {
    expect(await eligibility()).toMatchObject({ rule: { retainDays: 1 }, eligibleCount: 3, heldCount: 0, purgeEnabled: false });

    const hold = (await h.call(keeper, 'POST', '/v1/retention/holds', { resource: 'employee', recordKey: heldRecord, reason: 'Synthetic dispute' })).json();
    expect(hold.state).toBe('PENDING');
    expect((await eligibility()).heldCount).toBe(0); // a pending hold protects nothing yet
    expect((await h.call(keeper, 'POST', `/v1/retention/holds/${hold.id}/decision`, { expectedVersion: 1, decision: 'APPROVE' })).json().error).toBe('SELF_APPROVAL');
    expect((await h.call(approver, 'POST', `/v1/retention/holds/${hold.id}/decision`, { expectedVersion: 99, decision: 'APPROVE' })).statusCode).toBe(409);
    expect((await h.call(approver, 'POST', `/v1/retention/holds/${hold.id}/decision`, { expectedVersion: 1, decision: 'APPROVE' })).json().state).toBe('ACTIVE');
    expect(await eligibility()).toMatchObject({ eligibleCount: 2, heldCount: 1 });

    const kindHold = (await h.call(keeper, 'POST', '/v1/retention/holds', { resource: 'audit_event', reason: 'Synthetic audit freeze' })).json();
    await h.call(approver, 'POST', `/v1/retention/holds/${kindHold.id}/decision`, { expectedVersion: 1, decision: 'APPROVE' });
    expect(await eligibility()).toMatchObject({ eligibleCount: 0, heldCount: 3 });

    const released = await h.call(keeper, 'POST', `/v1/retention/holds/${kindHold.id}/release`, { expectedVersion: await holdVersion(kindHold.id), reason: 'Freeze lifted (synthetic)' });
    expect(released.json().state).toBe('RELEASED');
    expect(await eligibility()).toMatchObject({ eligibleCount: 2, heldCount: 1 });
    expect((await h.call(keeper, 'POST', `/v1/retention/holds/${kindHold.id}/release`, { expectedVersion: await holdVersion(kindHold.id), reason: 'Again' })).statusCode).toBe(409);

    const rejected = (await h.call(keeper, 'POST', '/v1/retention/holds', { resource: 'leave_request', reason: 'Not needed (synthetic)' })).json();
    expect((await h.call(approver, 'POST', `/v1/retention/holds/${rejected.id}/decision`, { expectedVersion: 1, decision: 'REJECT' })).json().state).toBe('REJECTED');
    expect((await eligibility()).heldCount).toBe(1);
    // Nothing was deleted by any of this (DF08).
    expect(Number((await h.one<{ n: string }>(`select count(*) as n from audit_event where id = any($1)`, [oldEvents])).n)).toBe(3);
  });

  it('retention controls need their own duties', async () => {
    expect((await h.call(hr, 'GET', '/v1/retention/holds')).statusCode).toBe(403);
    expect((await h.call(auditor, 'POST', '/v1/retention/holds', { resource: 'employee', reason: 'x' })).statusCode).toBe(403);
    const managerOnly = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['retention.manage.operational'] });
    const hold = (await h.call(managerOnly, 'POST', '/v1/retention/holds', { resource: 'employee', reason: 'Synthetic' })).json();
    expect((await h.call(managerOnly, 'POST', `/v1/retention/holds/${hold.id}/decision`, { expectedVersion: 1, decision: 'APPROVE' })).statusCode).toBe(403);
  });
});
