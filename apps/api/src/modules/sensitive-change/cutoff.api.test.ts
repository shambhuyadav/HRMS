// FR-105 payroll cutoff warning on bank changes (H3 TN03 "cutoff warning"; H4 "Bank revisions after cutoff warn
// employee"; I-18). A warning only: submission and approval proceed. Synthetic data only: a fictitious bank and
// made-up account identifiers; payroll periods are built around the company's business date.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { addDays, CONFIG, calendar } from '../payroll/payroll.fixtures.js';
import { submitChange } from './service.js';

let h: Harness;

const REVIEW: `${string}.${string}.${string}`[] = [
  'sensitive_change.review.private',
  'sensitive_change.read.private',
  'employee.read.private',
  'employee.read.bank',
  'document.read.document',
  'document.verify.document',
];
const pdf = Buffer.from('%PDF-1.4\n% synthetic evidence\n%%EOF\n').toString('base64');
const monthEnd = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).toISOString().slice(0, 10);

interface Setup {
  company: Company;
  hr: TestActor;
  today: string;
  person(): Promise<TestActor & { employeeId: string }>;
}

async function setup(): Promise<Setup> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR', { extra: REVIEW });
  expect((await h.call(hr, 'PUT', '/v1/workflows/sensitive_change/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
  const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [company.id])).d;
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json();
    await h.setStatus(company, e.id, 'ACTIVE_CONFIRMED');
    const a = await h.actor(company, 'EMPLOYEE', { employeeId: e.id });
    return { ...a, employeeId: e.id as string };
  };
  return { company, hr, today, person };
}

/** Drafts and submits a BANK change with the employee's own verified evidence; returns the submission response. */
async function submitBank(s: Setup, employee: TestActor & { employeeId: string }, effectiveDate: string) {
  const doc = (await h.call(employee, 'POST', `/v1/employees/${employee.employeeId}/documents`, { documentType: 'GENERAL', fileName: 'bank-letter.pdf', contentBase64: pdf })).json().id as string;
  expect((await h.call(s.hr, 'POST', `/v1/documents/${doc}/verification`, { decision: 'VERIFIED' })).statusCode).toBe(200);
  const created = await h.call(employee, 'POST', '/v1/me/sensitive-changes', {
    category: 'BANK',
    effectiveDate,
    values: { holderName: 'Synthetic Person', accountIdentifier: '000123456789', routingReference: 'SYNT0000001', countryCode: 'IN' },
    reason: 'New synthetic account',
    evidenceDocumentIds: [doc],
  });
  expect(created.statusCode).toBe(201);
  const requestId = created.json().requestId as string;
  const submitted = await h.call(employee, 'POST', `/v1/me/sensitive-changes/${requestId}/submit`, { expectedVersion: 1 });
  expect(submitted.statusCode).toBe(200);
  return { requestId, submitted: submitted.json() };
}

/** The request as the employee's own list (GET /v1/me/sensitive-changes) shows it. */
async function ownListed(employee: TestActor, requestId: string): Promise<Record<string, unknown>> {
  const res = await h.call(employee, 'GET', '/v1/me/sensitive-changes');
  expect(res.statusCode).toBe(200);
  return (res.json().items as Record<string, unknown>[]).find((i) => i.id === requestId)!;
}

async function reviewAndApprove(s: Setup, requestId: string) {
  const items = (await h.call(s.hr, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string; request: Record<string, unknown> & { id: string } }[];
  const task = items.find((t) => t.request?.id === requestId)!;
  expect((await h.call(s.hr, 'POST', `/v1/sensitive-changes/tasks/${task.taskId}/start-review`)).json().state).toBe('IN_REVIEW');
  const decided = await h.call(s.hr, 'POST', `/v1/sensitive-changes/tasks/${task.taskId}/decision`, { decision: 'APPROVE', reason: 'Verified against synthetic evidence', idempotencyKey: uniq('sc-key-') });
  expect(decided.statusCode).toBe(200);
  return { task: task.request, decided: decided.json() };
}

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

describe('payroll cutoff warning on bank changes (FR-105, I-18)', () => {
  it('warns the employee and the reviewer, without blocking, when the change takes effect after the open period’s input cutoff', async () => {
    const s = await setup();
    const author = await h.actor(s.company, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const activator = await h.actor(s.company, 'HR_ADMINISTRATOR', { extra: CONFIG });
    // The current month's period: inputs close today, payment at month end (company configuration, nothing defaulted).
    const start = `${s.today.slice(0, 7)}-01`;
    const code = `P${s.today.slice(0, 4)}${s.today.slice(5, 7)}`;
    const calendarCode = uniq('CAL');
    await calendar(h, author, activator, [{ code, start, end: monthEnd(s.today), cutoff: s.today, payment: monthEnd(s.today) }], { code: calendarCode });

    const late = await s.person();
    const tomorrow = addDays(s.today, 1);
    const { requestId, submitted } = await submitBank(s, late, tomorrow);
    const expected = { code: 'AFTER_PAYROLL_CUTOFF', calendarCode, periodCode: code, inputCutoff: s.today, paymentDate: monthEnd(s.today), effectiveDate: tomorrow };
    expect(submitted).toMatchObject({ state: 'SUBMITTED', payrollCutoffWarning: expected });
    expect(submitted.payrollCutoffWarning.message).toContain(code);
    expect(submitted.payrollCutoffWarning.message).toContain(s.today);
    // The employee's own list carries it too, the same warning while the change is pending.
    expect(await ownListed(late, requestId)).toMatchObject({ state: 'SUBMITTED', payrollCutoffWarning: submitted.payrollCutoffWarning });
    // The reviewer sees it before deciding; approval goes ahead and repeats it.
    const { task, decided } = await reviewAndApprove(s, requestId);
    expect(task.payrollCutoffWarning).toMatchObject(expected);
    expect(decided).toMatchObject({ state: 'SCHEDULED', payrollCutoffWarning: expected });
    // Approved but not applied yet: still pending, still warned; period facts only, never a bank value.
    const scheduled = await ownListed(late, requestId);
    expect(scheduled).toMatchObject({ state: 'SCHEDULED', payrollCutoffWarning: expected });
    expect(Object.keys(scheduled.payrollCutoffWarning as object).sort()).toEqual(['calendarCode', 'code', 'effectiveDate', 'inputCutoff', 'message', 'paymentDate', 'periodCode']);
    expect(JSON.stringify(scheduled.payrollCutoffWarning)).not.toContain('000123456789');

    // H7 "bank change cutoff": the employee is told in-app once, though submission and approval both warned, by period and
    // dates only; a bank value never reaches the notice, its event or the outbox.
    await dispatchOutbox(h.pool, 500);
    const notices = (await h.call(late, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string; body: string }[];
    expect(notices.filter((n) => n.category === 'BANK_CHANGE_CUTOFF')).toEqual([
      expect.objectContaining({ title: 'Bank change after payroll cutoff', body: `Your change of bank details effective ${tomorrow} falls after the input cutoff (${s.today}) of payroll period ${code}.` }),
    ]);
    const trail = (
      await h.one<{ t: string }>(
        `select coalesce((select string_agg(body, ' ') from notification where company_id = $1), '') || coalesce((select string_agg(data::text, ' ') from notification_event where company_id = $1), '')
                || coalesce((select string_agg(payload::text, ' ') from outbox_event where company_id = $1), '') as t`,
        [s.company.id],
      )
    ).t;
    for (const bankValue of ['000123456789', 'SYNT0000001', 'New synthetic account']) expect(trail).not.toContain(bankValue);
    // A second dispatch of everything repeats nothing (BR-034).
    await h.db.query(`update outbox_event set published_at = null where company_id = $1`, [s.company.id]);
    await dispatchOutbox(h.pool, 500);
    expect(((await h.call(late, 'GET', '/v1/me/notifications')).json().items as { category: string }[]).filter((n) => n.category === 'BANK_CHANGE_CUTOFF')).toHaveLength(1);

    // A draft is not pending (the warning comes with its submission); a withdrawn request is not either.
    const drafting = await s.person();
    const doc = (await h.call(drafting, 'POST', `/v1/employees/${drafting.employeeId}/documents`, { documentType: 'GENERAL', fileName: 'bank-letter.pdf', contentBase64: pdf })).json().id as string;
    const draft = (
      await h.call(drafting, 'POST', '/v1/me/sensitive-changes', {
        category: 'BANK',
        effectiveDate: tomorrow,
        values: { holderName: 'Synthetic Person', accountIdentifier: '000555666777', routingReference: 'SYNT0000001', countryCode: 'IN' },
        reason: 'New synthetic account',
        evidenceDocumentIds: [doc],
      })
    ).json().requestId as string;
    expect(await ownListed(drafting, draft)).not.toHaveProperty('payrollCutoffWarning');
    expect((await h.call(drafting, 'POST', `/v1/me/sensitive-changes/${draft}/submit`, { expectedVersion: 1 })).json().payrollCutoffWarning).toMatchObject(expected);
    expect(await ownListed(drafting, draft)).toMatchObject({ state: 'SUBMITTED', payrollCutoffWarning: expected });
    expect((await h.call(drafting, 'POST', `/v1/me/sensitive-changes/${draft}/withdraw`)).json().state).toBe('WITHDRAWN');
    expect(await ownListed(drafting, draft)).not.toHaveProperty('payrollCutoffWarning');
    // The notice comes with the submission, whatever becomes of the request after it.
    await dispatchOutbox(h.pool, 500);
    expect(((await h.call(drafting, 'GET', '/v1/me/notifications')).json().items as { category: string }[]).filter((n) => n.category === 'BANK_CHANGE_CUTOFF')).toHaveLength(1);
    // An address change is never warned.
    const address = (
      await h.call(drafting, 'POST', '/v1/me/sensitive-changes', {
        category: 'ADDRESS',
        effectiveDate: tomorrow,
        values: { line1: '1 Synthetic Road', city: 'Synthetic Town', countryCode: 'IN' },
        reason: 'Moved (synthetic)',
      })
    ).json().requestId as string;
    expect((await h.call(drafting, 'POST', `/v1/me/sensitive-changes/${address}/submit`, { expectedVersion: 1 })).json().state).toBe('SUBMITTED');
    expect(await ownListed(drafting, address)).not.toHaveProperty('payrollCutoffWarning');
    // Audited as operational period facts; no bank value travels.
    const audits = await h.db.query<{ action: string; after: string }>(
      `select action, after_values::text as after from audit_event where company_id = $1 and resource_code = 'employee_sensitive_change_request' and record_key = $2 and action in ('SUBMIT', 'APPROVE')`,
      [s.company.id, requestId],
    );
    expect(audits.rows).toHaveLength(2);
    for (const a of audits.rows) {
      expect(a.after).toContain(code);
      expect(a.after).not.toContain('000123456789');
    }

    // On or before the cutoff: no warning, at submission, in the list or at approval.
    const onTime = await s.person();
    const second = await submitBank(s, onTime, s.today);
    expect(second.submitted.state).toBe('SUBMITTED');
    expect(second.submitted).not.toHaveProperty('payrollCutoffWarning');
    expect(await ownListed(onTime, second.requestId)).not.toHaveProperty('payrollCutoffWarning');
    const approved = await reviewAndApprove(s, second.requestId);
    expect(approved.task).not.toHaveProperty('payrollCutoffWarning');
    expect(approved.decided.state).toBe('APPLIED');
    expect(approved.decided).not.toHaveProperty('payrollCutoffWarning');
    expect(await ownListed(onTime, second.requestId)).toMatchObject({ state: 'APPLIED' });
    expect(await ownListed(onTime, second.requestId)).not.toHaveProperty('payrollCutoffWarning');
    await dispatchOutbox(h.pool, 500);
    expect(((await h.call(onTime, 'GET', '/v1/me/notifications')).json().items as { category: string }[]).filter((n) => n.category === 'BANK_CHANGE_CUTOFF')).toEqual([]);
  });

  it('a change that crossed the cutoff while it waited warns its employee on approval', async () => {
    const s = await setup();
    const author = await h.actor(s.company, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const activator = await h.actor(s.company, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const employee = await s.person();
    const tomorrow = addDays(s.today, 1);
    // No calendar applies at submission, so nothing is warned; by the approval the open period's cutoff has passed.
    const { requestId, submitted } = await submitBank(s, employee, tomorrow);
    expect(submitted).not.toHaveProperty('payrollCutoffWarning');
    const code = `Q${s.today.slice(0, 4)}${s.today.slice(5, 7)}`;
    await calendar(h, author, activator, [{ code, start: `${s.today.slice(0, 7)}-01`, end: monthEnd(s.today), cutoff: s.today, payment: monthEnd(s.today) }], { code: uniq('CAL') });
    expect((await reviewAndApprove(s, requestId)).decided.payrollCutoffWarning).toMatchObject({ periodCode: code });
    await dispatchOutbox(h.pool, 500);
    expect(((await h.call(employee, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[]).filter((n) => n.category === 'BANK_CHANGE_CUTOFF').map((n) => n.body)).toEqual([
      `Your change of bank details effective ${tomorrow} falls after the input cutoff (${s.today}) of payroll period ${code}.`,
    ]);
  });

  it('submitting uses the authority current at commit, not the one the route guard saw (docs/09 §6.5)', async () => {
    const s = await setup();
    const employee = await s.person();
    const doc = (await h.call(employee, 'POST', `/v1/employees/${employee.employeeId}/documents`, { documentType: 'GENERAL', fileName: 'bank-letter.pdf', contentBase64: pdf })).json().id as string;
    expect((await h.call(s.hr, 'POST', `/v1/documents/${doc}/verification`, { decision: 'VERIFIED' })).statusCode).toBe(200);
    const requestId = (
      await h.call(employee, 'POST', '/v1/me/sensitive-changes', {
        category: 'BANK',
        effectiveDate: s.today,
        values: { holderName: 'Synthetic Person', accountIdentifier: '000123456789', routingReference: 'SYNT0000001', countryCode: 'IN' },
        reason: 'New synthetic account',
        evidenceDocumentIds: [doc],
      })
    ).json().requestId as string;
    const guard = (await resolveAccess(h.pool, { userId: employee.user, companyId: s.company.id, assignmentId: employee.assignment, resource: 'sensitive_change', action: 'submit', fieldGroups: ['private'] })) as AccessGrant;
    await h.db.query(
      `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2
          and permission_id = (select id from permission where resource = 'sensitive_change' and action = 'submit' and field_group = 'private')`,
      [s.company.id, employee.assignment],
    );
    await expect(withTransaction(h.pool, (tx) => submitChange(tx, guard, requestId, { expectedVersion: 1 }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.one<{ state: string }>(`select state from employee_sensitive_change_request where id = $1`, [requestId])).state).toBe('DRAFT');
  });

  it('says nothing when no payroll calendar applies', async () => {
    const s = await setup();
    const employee = await s.person();
    const { requestId, submitted } = await submitBank(s, employee, addDays(s.today, 3));
    expect(submitted.state).toBe('SUBMITTED');
    expect(submitted).not.toHaveProperty('payrollCutoffWarning');
    expect(await ownListed(employee, requestId)).not.toHaveProperty('payrollCutoffWarning');
    const { task, decided } = await reviewAndApprove(s, requestId);
    expect(task).not.toHaveProperty('payrollCutoffWarning');
    expect(decided.state).toBe('SCHEDULED');
    expect(decided).not.toHaveProperty('payrollCutoffWarning');
    await dispatchOutbox(h.pool, 500);
    expect(((await h.call(employee, 'GET', '/v1/me/notifications')).json().items as { category: string }[]).filter((n) => n.category === 'BANK_CHANGE_CUTOFF')).toEqual([]);
  });
});
