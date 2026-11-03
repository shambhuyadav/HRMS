// Test fixtures of the payroll module. Synthetic data only: example.test addresses, obviously fake names, made-up
// codes and amounts, a fictitious bank and made-up account identifiers.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { sealJson } from '../../security/field-crypto.js';
import type { Company, Harness, TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';

/** A fresh idempotency key (8 to 100 characters, as the API requires). */
export const key = (prefix = 'pr-key-') => `${prefix}${randomUUID()}`;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const CONFIG: PermissionKey[] = ['payroll_config.read.operational', 'payroll_config.manage.operational', 'payroll_config.activate.operational'];
export const SALARY: PermissionKey[] = ['salary.read.salary', 'salary.manage.salary'];
export const PREPARE: PermissionKey[] = ['payroll_run.read.amount', 'payroll_run.prepare.amount', 'payroll_input.read.amount', 'payroll_input.prepare.amount'];
export const REVIEW: PermissionKey[] = ['payroll_run.read.amount', 'payroll_run.review.amount'];
export const APPROVE: PermissionKey[] = ['payroll_run.read.amount', 'payroll_run.approve.amount'];
export const PROCESS: PermissionKey[] = ['payroll_run.read.amount', 'payroll_run.process.amount'];
export const CANCEL: PermissionKey[] = ['payroll_run.read.amount', 'payroll_run.cancel.amount'];
export const INPUT_APPROVE: PermissionKey[] = ['payroll_input.read.amount', 'payroll_input.approve.amount'];
export const STOP_PROPOSE: PermissionKey[] = ['payroll_stop.read.hold', 'payroll_stop.propose.hold'];
export const STOP_DECIDE: PermissionKey[] = ['payroll_stop.read.hold', 'payroll_stop.decide.hold'];
export const HOLD_PROPOSE: PermissionKey[] = ['payroll_hold.read.hold', 'payroll_hold.propose.hold'];
export const HOLD_DECIDE: PermissionKey[] = ['payroll_hold.read.hold', 'payroll_hold.decide.hold'];
export const HOLD_RELEASE: PermissionKey[] = ['payroll_hold.read.hold', 'payroll_hold.release.hold'];
export const CRITERIA: PermissionKey[] = ['payroll_hold.read.hold', 'payroll_hold.define_criterion.hold', 'payroll_hold.activate_criterion.hold'];
export const DOCUMENTS: PermissionKey[] = ['document.upload.document', 'document.read.document'];
export const VERIFY_DOCUMENTS: PermissionKey[] = ['document.read.document', 'document.verify.document'];

/** Several grant lists as one, without repeats (an assignment holds each permission once). */
export const grants = (...lists: PermissionKey[][]): PermissionKey[] => [...new Set(lists.flat())];

export async function today(h: Harness, company: Company): Promise<string> {
  return (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [company.id])).d;
}

export async function ok<T = Record<string, unknown>>(res: { statusCode: number; body: string; json(): unknown }, status = 200): Promise<T> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
}

/** The access grant of an actor's assignment, for calling a service directly (e.g. with a small chunk size). */
export async function grantOf(h: Harness, a: TestActor, resource: string, action: string, fieldGroups: string[]): Promise<AccessGrant> {
  const d = await resolveAccess(h.pool, { userId: a.user, companyId: a.company.id, assignmentId: a.assignment, resource, action, fieldGroups });
  if (!d.allowed) throw new Error(`no grant for ${resource}.${action}`);
  return d;
}

/** An active employee created through the API. */
export async function person(
  h: Harness,
  company: Company,
  hr: TestActor,
  opts: { joiningDate?: string; name?: string; departmentId?: string; locationId?: string; gradeId?: string; status?: string } = {},
): Promise<string> {
  const body = h.newEmployeeBody(company, {
    displayName: opts.name ?? 'Synthetic Person',
    ...(opts.joiningDate ? { joiningDate: opts.joiningDate } : {}),
    ...(opts.departmentId ? { departmentId: opts.departmentId } : {}),
    ...(opts.locationId ? { locationId: opts.locationId } : {}),
    ...(opts.gradeId ? { gradeId: opts.gradeId } : {}),
  });
  const res = await h.call(hr, 'POST', '/v1/employees', body);
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  await h.setStatus(company, id, opts.status ?? 'ACTIVE_CONFIRMED');
  return id;
}

/** The initial salary arrangement through the salary master, then its components (set once). */
export async function salary(
  h: Harness,
  admin: TestActor,
  employeeId: string,
  opts: { effectiveFrom: string; monthlyGross: string; annualCtc?: string; currency?: string; components: { code: string; amount: string; basis?: 'MONTHLY' | 'ANNUAL' }[] },
): Promise<string> {
  const created = await h.call(admin, 'POST', `/v1/employees/${employeeId}/salary`, {
    effectiveFrom: opts.effectiveFrom,
    annualCtc: opts.annualCtc ?? opts.monthlyGross,
    monthlyGross: opts.monthlyGross,
    currency: opts.currency ?? 'INR',
  });
  expect(created.statusCode, created.body).toBe(201);
  const arrangementId = created.json().id as string;
  await components(h, admin, arrangementId, opts.components);
  return arrangementId;
}

export async function components(h: Harness, admin: TestActor, arrangementId: string, list: { code: string; amount: string; basis?: 'MONTHLY' | 'ANNUAL' }[]) {
  const res = await h.call(admin, 'POST', `/v1/payroll/salary-arrangements/${arrangementId}/components`, {
    components: list.map((c) => ({ componentCode: c.code, amount: c.amount, basis: c.basis ?? 'MONTHLY' })),
  });
  expect(res.statusCode, res.body).toBe(201);
}

/** A later arrangement from `from` (the earlier one ends there), written directly: the increment flow is tested elsewhere. */
export async function laterArrangement(h: Harness, company: Company, employeeId: string, from: string, monthlyGross: string, list: { code: string; amount: string }[]) {
  await h.db.query(`update salary_arrangement set effective_to = $3 where company_id = $1 and employee_id = $2 and effective_to is null`, [company.id, employeeId, from]);
  const id = (
    await h.one<{ id: string }>(
      `insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code) values ($1, $2, $3, $4, $4, 'INR') returning id`,
      [company.id, employeeId, from, monthlyGross],
    )
  ).id;
  for (const c of list) {
    await h.db.query(
      `insert into salary_component (company_id, salary_arrangement_id, component_id, amount, basis)
       select $1, $2, id, $4, 'MONTHLY' from pay_component where company_id = $1 and code = $3`,
      [company.id, id, c.code, c.amount],
    );
  }
  return id;
}

export interface HeadSpec {
  code: string;
  kind?: 'EARNING' | 'DEDUCTION';
  headType: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION' | 'REIMBURSEMENT';
  basis: 'FIXED' | 'INPUT' | 'RULE_PACK';
  rulePackCode?: string;
  base?: string[];
  effectiveFrom?: string;
  sequence?: number;
}

/** A pay component (if new) and an active head revision: authored by one configurator, activated by another. */
export async function head(h: Harness, author: TestActor, activator: TestActor, spec: HeadSpec): Promise<string> {
  const kind = spec.kind ?? (spec.headType === 'DEDUCTION' ? 'DEDUCTION' : 'EARNING');
  const exists = await h.db.query(`select 1 from pay_component where company_id = $1 and code = $2`, [author.company.id, spec.code]);
  if (!exists.rowCount) await ok(await h.call(author, 'POST', '/v1/payroll/components', { code: spec.code, name: `${spec.code} (synthetic)`, componentKind: kind }), 201);
  const draft = await ok<{ id: string; version: number }>(
    await h.call(author, 'POST', '/v1/payroll/heads', {
      componentCode: spec.code,
      effectiveFrom: spec.effectiveFrom ?? '2020-01-01',
      inUse: true,
      headType: spec.headType,
      calculationBasis: spec.basis,
      taxTreatment: 'TAXABLE',
      displaySequence: spec.sequence ?? 10,
      ...(spec.rulePackCode ? { rulePackCode: spec.rulePackCode } : {}),
      ...(spec.base ? { baseComponentCodes: spec.base } : {}),
    }),
    201,
  );
  await ok(await h.call(activator, 'POST', `/v1/payroll/head-revisions/${draft.id}/activate`, { expectedVersion: draft.version }));
  return draft.id;
}

export interface PeriodSpec {
  code: string;
  start: string;
  end: string;
  cutoff?: string;
  payment?: string;
  financialYear?: string;
}

/** An active payroll calendar with its periods (company configuration; nothing is defaulted). */
export async function calendar(h: Harness, author: TestActor, activator: TestActor, periods: PeriodSpec[], opts: { code?: string; currency?: string; minorUnit?: number } = {}) {
  const k = await ok<{ id: string }>(
    await h.call(author, 'POST', '/v1/payroll/calendars', { code: opts.code ?? uniq('CAL'), name: 'Monthly payroll (synthetic)', currencyCode: opts.currency ?? 'INR', currencyMinorUnit: opts.minorUnit ?? 2 }),
    201,
  );
  const ids: Record<string, string> = {};
  for (const p of periods) {
    const created = await ok<{ id: string }>(
      await h.call(author, 'POST', `/v1/payroll/calendars/${k.id}/periods`, {
        periodCode: p.code,
        financialYear: p.financialYear ?? 'FY-SYNTH',
        serviceStart: p.start,
        serviceEnd: p.end,
        inputCutoff: p.cutoff ?? '2099-12-30',
        paymentDate: p.payment ?? '2099-12-31',
      }),
      201,
    );
    ids[p.code] = created.id;
  }
  const current = await ok<{ version: number }>(await h.call(author, 'GET', `/v1/payroll/calendars/${k.id}`));
  await ok(await h.call(activator, 'POST', `/v1/payroll/calendars/${k.id}/activate`, { expectedVersion: current.version }));
  return { calendarId: k.id, periods: ids };
}

/** The twelve monthly periods of a year. */
export const months = (year: number): PeriodSpec[] =>
  Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, '0');
    return { code: `${year}-${m}`, start: `${year}-${m}-01`, end: new Date(Date.UTC(year, i + 1, 0)).toISOString().slice(0, 10) };
  });

/** Approved leave written directly (synthetic fixture; the leave workflow is tested in its own module). */
export async function approvedLeave(h: Harness, company: Company, employeeId: string, typeCode: string, start: string, end: string, units: string, halfDay = false) {
  await h.db.query('begin');
  try {
    const t = await h.one<{ type_id: string; policy_id: string }>(
      `select t.id as type_id, p.id as policy_id from leave_type t join leave_policy p on p.company_id = t.company_id and p.leave_type_id = t.id
        where t.company_id = $1 and t.code = $2 order by p.revision limit 1`,
      [company.id, typeCode],
    );
    const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'leave_request', $2, 'SUBMITTED') returning id`, [
      company.id,
      employeeId,
    ]);
    // The leave mirror compares the row as written, so the request is written in its final (approved) state.
    await h.db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [bt.id]);
    const lr = await h.one<{ id: string }>(
      `insert into leave_request (company_id, employee_id, leave_type_id, policy_id, transaction_id, start_date, end_date, half_day, requested_units, state)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'APPROVED') returning id`,
      [company.id, employeeId, t.type_id, t.policy_id, bt.id, start, end, halfDay, units],
    );
    await h.db.query('commit');
    return lr.id;
  } catch (e) {
    await h.db.query('rollback');
    throw e;
  }
}

/** A reviewed attendance outcome written directly (synthetic fixture). */
export async function attendance(h: Harness, company: Company, employeeId: string, day: string, status: string) {
  await h.db.query(
    `insert into attendance_record (company_id, employee_id, work_date, policy_id, scheduled_net_minutes, worked_minutes, late, early_departure, status_id)
     select $1, $2, $3, (select id from attendance_policy where company_id = $1 order by revision limit 1), 480, 0, false, false, s.id
       from reference_value s where s.company_id = $1 and s.category = 'ATTENDANCE_STATUS' and s.code = $4`,
    [company.id, employeeId, day, status],
  );
}

/** Evaluated attendance for every day of a range (PRESENT on Monday to Friday, WEEKLY_OFF otherwise), except `skip`. */
export async function attendanceMonth(h: Harness, company: Company, employeeId: string, start: string, end: string, skip: string[] = []) {
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (skip.includes(d)) continue;
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    await attendance(h, company, employeeId, d, weekday === 0 || weekday === 6 ? 'WEEKLY_OFF' : 'PRESENT');
  }
}

/** An approved exit (last working date) written directly (synthetic fixture; the exit workflow is tested in lifecycle). */
export async function approvedExit(h: Harness, company: Company, employeeId: string, requestDate: string, lastWorkingDate: string) {
  await h.db.query('begin');
  try {
    const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [company.id, employeeId]);
    const x = await h.one<{ id: string }>(
      `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
       values ($1, $2, $3, 'RESIGNATION', $4, $5, $5, 'SUBMITTED') returning id`,
      [company.id, employeeId, bt.id, requestDate, lastWorkingDate],
    );
    await h.db.query(`update business_transaction set state = 'RECOMMENDED' where id = $1`, [bt.id]);
    await h.db.query(`update exit_case set state = 'RECOMMENDED', recommended_leaving_date = $2, recommended_at = now() where id = $1`, [x.id, lastWorkingDate]);
    await h.db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [bt.id]);
    await h.db.query(`update exit_case set state = 'APPROVED', approved_leaving_date = $2, approved_at = now(), prior_status_code = 'ACTIVE_CONFIRMED' where id = $1`, [x.id, lastWorkingDate]);
    await h.db.query('commit');
  } catch (e) {
    await h.db.query('rollback');
    throw e;
  }
}

/** A BANK revision written directly, without a source request (an audited initial migration); `valid: false` seals it for another row. */
export async function bankRevision(h: Harness, company: Company, employeeId: string, opts: { valid?: boolean } = {}) {
  const id = randomUUID();
  const values = { holderName: 'Synthetic Holder', accountIdentifier: '000123456789', routingReference: 'SYNTH0001', countryCode: 'IN' };
  // An invalid instruction: sealed for another row, so it never opens here.
  const payload = sealJson(values, { purpose: 'private_profile.revision', companyId: company.id, ownerId: employeeId, recordId: opts.valid === false ? randomUUID() : id });
  await h.db.query(
    `insert into employee_private_profile_revision (id, company_id, employee_id, category, revision, effective_from, payload)
     values ($1, $2, $3, 'BANK', coalesce((select max(revision) from employee_private_profile_revision where company_id = $2 and employee_id = $3 and category = 'BANK'), 0) + 1, '2026-01-01', $4)`,
    [id, company.id, employeeId, payload],
  );
  return id;
}

/** A verified approved BANK revision through the real sensitive-change flow (employee request, verified evidence, independent approval). */
export async function verifiedBank(h: Harness, company: Company, reviewer: TestActor, employeeId: string, employeeActor?: TestActor) {
  const employee = employeeActor ?? (await h.actor(company, 'EMPLOYEE', { employeeId }));
  const pdf = Buffer.from('%PDF-1.4\n% synthetic bank evidence\n%%EOF\n').toString('base64');
  const doc = await ok<{ id: string }>(
    await h.call(employee, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'bank.pdf', contentBase64: pdf }),
    201,
  );
  await ok(await h.call(reviewer, 'POST', `/v1/documents/${doc.id}/verification`, { decision: 'VERIFIED' }));
  const draft = await ok<{ requestId: string; version: number }>(
    await h.call(employee, 'POST', '/v1/me/sensitive-changes', {
      category: 'BANK',
      reason: 'Synthetic bank account',
      values: { holderName: 'Synthetic Holder', accountIdentifier: '000987654321', routingReference: 'SYNTH0002', countryCode: 'IN' },
      evidenceDocumentIds: [doc.id],
    }),
    201,
  );
  await ok(await h.call(employee, 'POST', `/v1/me/sensitive-changes/${draft.requestId}/submit`, { expectedVersion: draft.version }));
  const t = ((await h.call(reviewer, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string; request: { id: string } | null }[]).find(
    (x) => x.request?.id === draft.requestId,
  )!;
  await ok(await h.call(reviewer, 'POST', `/v1/sensitive-changes/tasks/${t.taskId}/start-review`));
  const decided = await ok<{ state: string }>(
    await h.call(reviewer, 'POST', `/v1/sensitive-changes/tasks/${t.taskId}/decision`, { decision: 'APPROVE', reason: 'Verified against synthetic evidence', idempotencyKey: key('bank-') }),
  );
  expect(decided.state).toBe('APPLIED');
}

/** An evidence document about an employee, uploaded by one HR user, released by the scan and verified by another. */
export async function evidenceDocument(h: Harness, uploader: TestActor, verifier: TestActor, employeeId: string, opts: { verify?: boolean } = {}) {
  const pdf = Buffer.from(`%PDF-1.4\n% synthetic case evidence ${uniq('doc')}\n%%EOF\n`).toString('base64');
  const doc = await ok<{ id: string; scanState: string }>(
    await h.call(uploader, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'case-evidence.pdf', contentBase64: pdf }),
    201,
  );
  expect(doc.scanState).toBe('CLEAN');
  if (opts.verify !== false) await ok(await h.call(verifier, 'POST', `/v1/documents/${doc.id}/verification`, { decision: 'VERIFIED' }));
  return doc.id;
}

/** Sets a kind's explicit fallback reviewer list (DF03), in priority order. */
export async function reviewers(h: Harness, hr: TestActor, kind: string, users: TestActor[]) {
  await ok(await h.call(hr, 'PUT', `/v1/workflows/${kind}/fallback-reviewers`, { reviewers: users.map((u, i) => ({ userId: u.user, priority: i + 1 })) }));
}

/** An active hold criterion (company configuration: authored by one Admin, activated by another). */
export async function criterion(
  h: Harness,
  author: TestActor,
  activator: TestActor,
  spec: { code?: string; category?: 'CONTRACTUAL' | 'LEGAL_DISCIPLINARY'; scopeMode?: 'FULL_ONLY' | 'FULL_OR_PARTIAL'; maxReviewDays?: number } = {},
) {
  const draft = await ok<{ id: string; version: number }>(
    await h.call(author, 'POST', '/v1/payroll/hold-criteria', {
      code: spec.code ?? uniq('HOLD_CRIT_'),
      category: spec.category ?? 'CONTRACTUAL',
      applicability: 'Synthetic contractual criterion for tests',
      scopeMode: spec.scopeMode ?? 'FULL_OR_PARTIAL',
      maxReviewDays: spec.maxReviewDays ?? 30,
      evidenceReference: 'SYNTH-CONTRACT-CLAUSE-1',
      validationReference: 'SYNTH-VALIDATION-1',
    }),
    201,
  );
  await ok(await h.call(activator, 'POST', `/v1/payroll/hold-criteria/${draft.id}/activate`, { expectedVersion: draft.version }));
  return draft.id;
}

export interface RunView {
  id: string;
  state: string;
  revision: number;
  version: number;
  successorRunId: string | null;
  exceptions: { blocking: number; unresolved: number; warnings: number };
  records: Record<string, number>;
  progress: { calculation: { calculated: number; complete: boolean; chunks: number }; processing: { frozen: number; complete: boolean; chunks: number } };
  totals?: { currencyCode: string; net: string; gross: string; earnings: string; deductions: string; reimbursements: string; employerContributions: string; records: number }[];
}

export async function getRun(h: Harness, a: TestActor, id: string): Promise<RunView> {
  return ok<RunView>(await h.call(a, 'GET', `/v1/payroll/runs/${id}`));
}

/** Preview, confirm and create a run of a period (optionally filtered). */
export async function createRun(h: Harness, preparer: TestActor, periodId: string, filters: { departmentIds?: string[]; gradeIds?: string[]; locationIds?: string[] } = {}) {
  const preview = await ok<{ scopeToken: string; memberCount: number }>(await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId, ...filters }));
  return ok<RunView>(await h.call(preparer, 'POST', '/v1/payroll/runs', { periodId, ...filters, scopeToken: preview.scopeToken }), 201);
}

/** Calculates a run, continuing while the API answers 202 (chunked work left). */
export async function calculate(h: Harness, preparer: TestActor, runId: string) {
  const r = await getRun(h, preparer, runId);
  for (let i = 0; i < 100; i++) {
    const res = await h.call(preparer, 'POST', `/v1/payroll/runs/${runId}/calculate`, { expectedVersion: r.version });
    if (res.statusCode !== 202) return ok<RunView>(res);
  }
  throw new Error('calculation did not complete');
}

export interface RecordView {
  id: string;
  employeeId: string;
  calculationStatus: string;
  paidUnits: string | null;
  earnings: string | null;
  reimbursements: string | null;
  gross: string | null;
  deductions: string | null;
  net: string | null;
  employerContributions: string | null;
  bankStatus: string | null;
  bankRevisionId: string | null;
  exceptions: { id: string; code: string; severity: string; resolvable: boolean; detail: Record<string, unknown>; resolvedAt: string | null }[];
  lines: { componentCode: string; headType: string; amount: string; ruleVersion: string }[];
  segments: { segmentStart: string; segmentEnd: string; calendarDays: number; leaveLopUnits: string; attendanceLopUnits: string; paidDays: string }[];
  lossOfPay: { day: string; sourceKind: string; units: string }[];
  inputs: { inputId: string; componentCode: string; amount: string; reference: string }[];
}

export async function record(h: Harness, a: TestActor, runId: string, employeeId: string): Promise<RecordView> {
  return ok<RecordView>(await h.call(a, 'GET', `/v1/payroll/runs/${runId}/records/${employeeId}`));
}

async function myTask(h: Harness, a: TestActor, runId: string, step: 'REVIEW' | 'APPROVAL' | 'COVER') {
  const items = (await ok<{ items: { taskId: string; step: string; run: { id: string; coveredEmployeeId: string | null } | null }[] }>(await h.call(a, 'GET', '/v1/payroll/runs/tasks/mine'))).items;
  return items.find((t) => t.step === step && t.run?.id === runId);
}

export async function taskOf(h: Harness, a: TestActor, runId: string, step: 'REVIEW' | 'APPROVAL' | 'COVER') {
  const t = await myTask(h, a, runId, step);
  expect(t, `${step} task of run ${runId}`).toBeDefined();
  return t!.taskId;
}

export const hasTask = async (h: Harness, a: TestActor, runId: string, step: 'REVIEW' | 'APPROVAL' | 'COVER') => (await myTask(h, a, runId, step)) !== undefined;

/** Submit, independent review and independent approval of a calculated run. */
export async function submitAndApprove(h: Harness, t: { preparer: TestActor; reviewer: TestActor; approver: TestActor }, runId: string) {
  const r = await getRun(h, t.preparer, runId);
  await ok(await h.call(t.preparer, 'POST', `/v1/payroll/runs/${runId}/submit`, { expectedVersion: r.version }));
  await ok(await h.call(t.reviewer, 'POST', `/v1/payroll/run-tasks/${await taskOf(h, t.reviewer, runId, 'REVIEW')}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
  return ok<{ state: string }>(await h.call(t.approver, 'POST', `/v1/payroll/run-tasks/${await taskOf(h, t.approver, runId, 'APPROVAL')}/approve`, { decision: 'APPROVE', idempotencyKey: key() }));
}

/** Processes a run, continuing while the API answers 202 (chunked work left). */
export async function processRun(h: Harness, processor: TestActor, runId: string) {
  const r = await getRun(h, processor, runId);
  for (let i = 0; i < 100; i++) {
    const res = await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/process`, { expectedVersion: r.version });
    if (res.statusCode !== 202) return ok<RunView>(res);
  }
  throw new Error('processing did not complete');
}

/**
 * Leak checks: audit before/after values under the operational group, outbox payloads and rendered notifications of
 * the company, each as one text.
 */
export async function trailText(h: Harness, companyId: string): Promise<{ operational: string; outbox: string; notifications: string }> {
  const a = await h.one<{ t: string }>(
    `select coalesce(string_agg(coalesce(before_values -> 'operational', '{}'::jsonb)::text || ' ' || coalesce(after_values -> 'operational', '{}'::jsonb)::text, ' '), '') as t
       from audit_event where company_id = $1`,
    [companyId],
  );
  const o = await h.one<{ t: string }>(`select coalesce(string_agg(payload::text, ' '), '') as t from outbox_event where company_id = $1`, [companyId]);
  const n = await h.one<{ t: string }>(`select coalesce(string_agg(coalesce(title, '') || ' ' || coalesce(body, ''), ' '), '') as t from notification where company_id = $1`, [companyId]);
  return { operational: a.t, outbox: o.t, notifications: n.t };
}
