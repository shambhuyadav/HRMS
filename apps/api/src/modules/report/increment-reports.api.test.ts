// FR-093 increment reports (§11.2 "Increment cycle and history reports"; FR-090; DF14; DF15; CI21; ZT26; BR-044):
// increment due/decision and employee annual increment, generated in the background like every report, under the
// increment salary export grant and the requester's row scope, reconciled with the lists and per-employee views they
// export. Synthetic INR amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import type { PermissionKey } from '../access/baseline.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { csvTable } from './csv.fixtures.js';
import { processReportQueue } from './service.js';

let h: Harness;
let A: Company;
let hr1: TestActor;
let hr2: TestActor;
let hrPlain: TestActor;
let financeExporter: TestActor;
let manager: TestActor;
const emp: Record<string, { id: string; code: string }> = {};

const FINANCE: PermissionKey[] = ['salary.manage.salary', 'salary.read.salary', 'increment.read.salary', 'increment.history_read.salary', 'increment.propose.salary', 'increment.approve.salary', 'increment.export.salary'];
const FY2026 = { from: '2026-04-01', to: '2027-03-31' };

/** Every cell of a report CSV line (every cell is quoted; quotes are doubled). */
const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
const request = (a: TestActor, reportCode: string, filters: object = {}) => h.call(a, 'POST', '/v1/reports', { reportCode, filters });

/** Requests, generates and downloads a report; its rows keyed by column header. */
async function exported(a: TestActor, reportCode: string, filters: object): Promise<Record<string, string>[]> {
  const res = await request(a, reportCode, filters);
  expect(res.statusCode, res.body).toBe(202);
  await processReportQueue(h.pool);
  expect((await h.call(a, 'GET', `/v1/reports/${res.json().id}`)).json()).toMatchObject({ state: 'COMPLETED' });
  const file = await h.call(a, 'GET', `/v1/reports/${res.json().id}/download`);
  expect(file.statusCode).toBe(200);
  const [header, ...lines] = csvTable(file.body).trimEnd().split('\r\n').map(cells);
  return lines.map((l) => Object.fromEntries(header!.map((k, i) => [k, l[i]!])));
}

async function employee(opts: { joiningDate?: string; departmentId?: string; salary?: [string, string] } = {}) {
  const e = (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A, { ...(opts.joiningDate ? { joiningDate: opts.joiningDate } : {}), ...(opts.departmentId ? { departmentId: opts.departmentId } : {}) }))).json();
  if (opts.salary) {
    const res = await h.call(hr1, 'POST', `/v1/employees/${e.id}/salary`, { effectiveFrom: e.joiningDate, monthlyGross: opts.salary[0], annualCtc: opts.salary[1], currency: 'INR' });
    expect(res.statusCode, res.body).toBe(201);
  }
  return { id: e.id as string, code: e.employeeCode as string };
}

/** An off-cycle increase proposed by one finance HR and decided by the other (DF15 independence). */
async function offCycle(employeeId: string, effectiveDate: string, amount: string, counterpart: string, decision: 'APPROVE' | 'REJECT', by = hr1, decider = hr2) {
  const res = await h.call(by, 'POST', '/v1/increment-cases/off-cycle', { employeeId, effectiveDate, proposedAmount: amount, proposedCounterpart: counterpart, reason: 'Off-cycle adjustment (synthetic)' });
  expect(res.statusCode, res.body).toBe(201);
  const task = ((await h.call(decider, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === employeeId)!;
  const decided = await h.call(decider, 'POST', `/v1/increment-cases/tasks/${task.taskId}/decision`, { decision, reason: 'Independent review (synthetic)', idempotencyKey: uniq('inc-key-') });
  expect(decided.statusCode, decided.body).toBe(200);
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
  financeExporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['increment.read.salary', 'increment.history_read.salary', 'increment.export.salary'], departmentFilter: A.financeDept });
  manager = await h.actor(A, 'REPORTING_MANAGER', { extra: ['increment.read.salary'] });
  await h.db.query(
    `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'increment_case', $2, 1, true), ($1, 'increment_case', $3, 2, true)`,
    [A.id, hr1.user, hr2.user],
  );
  emp.E1 = await employee({ salary: ['100000', '1200000'] });
  emp.E2 = await employee({ salary: ['50000', '600000'] });
  emp.E3 = await employee({ joiningDate: '2026-06-01', salary: ['70000', '840000'] });
  emp.E4 = await employee({ departmentId: A.financeDept, salary: ['90000', '1080000'] });
  emp.E5 = await employee(); // no salary on record
  // ZT26: 100000 -> 110000 -> 121000 in FY 2026 (two 10 percent changes, 21 percent annual growth).
  await offCycle(emp.E1.id, '2026-07-01', '110000', '1320000', 'APPROVE');
  await offCycle(emp.E1.id, '2027-01-01', '121000', '1452000', 'APPROVE', hr2, hr1);
  await offCycle(emp.E2.id, '2026-09-01', '55000', '660000', 'REJECT');
  await offCycle(emp.E4.id, '2026-10-01', '99000', '1188000', 'APPROVE');
  // A cycle review for E2: a due review is a DRAFT case, not a raise (DF15).
  await h.setStatus(A, emp.E2.id, 'ACTIVE_CONFIRMED');
  const cycleId = (await h.call(hr1, 'GET', '/v1/increment-cycles')).json().items[0].id as string;
  const opening = await h.runBulkJob(hr1, `/v1/increment-cycles/${cycleId}/reviews`, { year: 2027 });
  expect(opening.result).toMatchObject({ created: 1 });
});

afterAll(async () => {
  await h?.stop();
});

describe('increment reports in the catalogue (FR-093)', () => {
  it('are listed with their columns and need the increment salary export grant at request (BR-044)', async () => {
    // Listed to the role holding the increment salary export grant only (reportCatalogue).
    const items = (await h.call(hr1, 'GET', '/v1/reports/catalogue')).json().items as { code: string; requiresPeriod: boolean; columns: string[] }[];
    const withoutGrant = ((await h.call(hrPlain, 'GET', '/v1/reports/catalogue')).json().items as { code: string }[]).map((r) => r.code);
    expect(withoutGrant).not.toContain('INCREMENT_DUE_DECISION');
    expect(withoutGrant).not.toContain('ANNUAL_INCREMENT');
    expect(items.find((r) => r.code === 'INCREMENT_DUE_DECISION')).toMatchObject({ requiresPeriod: true, columns: expect.arrayContaining(['Decision due', 'State', 'Baseline', 'Approved']) });
    expect(items.find((r) => r.code === 'ANNUAL_INCREMENT')).toMatchObject({ requiresPeriod: true, columns: expect.arrayContaining(['Opening', 'Closing', 'Annual growth %', 'N/A reason']) });
    for (const code of ['INCREMENT_DUE_DECISION', 'ANNUAL_INCREMENT']) {
      // Manager status and the increment read grant alone are not enough.
      for (const a of [hrPlain, manager]) expect((await request(a, code, FY2026)).statusCode).toBe(403);
      expect((await request(hr1, code, FY2026)).statusCode).toBe(202);
    }
    await processReportQueue(h.pool);
    const audit = await h.db.query<{ after: { operational: { reportCode: string } } }>(
      `select after_values as after from audit_event where company_id = $1 and resource_code = 'report_execution' and action = 'REQUEST' and actor_user_id = $2`,
      [A.id, hr1.user],
    );
    expect(audit.rows.map((r) => r.after.operational.reportCode).sort()).toEqual(['ANNUAL_INCREMENT', 'INCREMENT_DUE_DECISION']);
    const outputs = await h.db.query<{ classification: string }>(
      `select a.classification from report_execution x join attachment a on a.company_id = x.company_id and a.id = x.output_attachment_id
        where x.company_id = $1 and x.report_code in ('INCREMENT_DUE_DECISION', 'ANNUAL_INCREMENT')`,
      [A.id],
    );
    expect(outputs.rows.map((r) => r.classification)).toEqual(['CONFIDENTIAL', 'CONFIDENTIAL']);
  });
});

describe('increment due and decisions (FR-093, §11.2)', () => {
  type Case = { employeeCode: string; occurrence: string; offCycle: boolean; state: string; proposedOutcome: string | null; effectiveDate: string; decisionDueOn: string | null; baselineAmount: string; proposedAmount: string | null; currency: string };
  const visible = async (a: TestActor, from: string, to: string, state?: string) =>
    ((await h.call(a, 'GET', `/v1/increment-cases${state ? `?state=${state}` : ''}`)).json().items as Case[]).filter((c) => c.effectiveDate >= from && c.effectiveDate <= to);
  const money = (v: string | null) => (v === null ? '' : Number(v).toFixed(2));

  it('exports every case whose planned effective date is in the period, exactly as the case list shows it', async () => {
    const rows = await exported(hr1, 'INCREMENT_DUE_DECISION', FY2026);
    const cases = await visible(hr1, FY2026.from, FY2026.to);
    expect(rows).toHaveLength(4);
    expect(rows.length).toBe(cases.length);
    expect(rows.map((r) => [r['Employee code'], r['Planned effective date'], r.State])).toEqual([
      [emp.E1!.code, '2026-07-01', 'APPLIED'],
      [emp.E2!.code, '2026-09-01', 'REJECTED'],
      [emp.E4!.code, '2026-10-01', 'APPLIED'],
      [emp.E1!.code, '2027-01-01', 'APPLIED'],
    ]);
    for (const r of rows) {
      const c = cases.find((x) => x.employeeCode === r['Employee code'] && x.effectiveDate === r['Planned effective date'])!;
      expect(r).toMatchObject({
        Occurrence: c.occurrence,
        'Off-cycle': String(c.offCycle),
        State: c.state,
        'Proposed outcome': c.proposedOutcome ?? '',
        'Decision due': c.decisionDueOn ?? '',
        Basis: 'MONTHLY_GROSS',
        Currency: c.currency,
        Baseline: money(c.baselineAmount),
        Proposed: money(c.proposedAmount),
      });
    }
    expect(rows[0]).toMatchObject({ Baseline: '100000.00', Proposed: '110000.00', Approved: '110000.00', 'Approved effective date': '2026-07-01', 'Off-cycle': 'true', 'Review opens': '' });
    // A rejected decision changes no salary and has no approved amount (BR-041).
    expect(rows[1]).toMatchObject({ Proposed: '55000.00', Approved: '', 'Approved effective date': '' });
    // No free-text reason is exported.
    expect(JSON.stringify(rows)).not.toMatch(/synthetic/i);
  });

  it('shows a due cycle review with its review window; the state filter and the row scope apply as on the list', async () => {
    const april = { from: '2027-04-01', to: '2027-04-30' };
    const [due] = await exported(hr1, 'INCREMENT_DUE_DECISION', april);
    const [listed] = await visible(hr1, april.from, april.to);
    expect(listed).toMatchObject({ employeeCode: emp.E2!.code, state: 'DRAFT', offCycle: false });
    expect(due).toMatchObject({ 'Employee code': emp.E2!.code, State: 'DRAFT', 'Off-cycle': 'false', 'Decision due': listed!.decisionDueOn, Occurrence: listed!.occurrence, Baseline: '50000.00', Proposed: '', Approved: '' });
    expect(due!['Review opens']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(due!['Decision due']! <= due!['Planned effective date']!).toBe(true);

    const applied = await exported(hr1, 'INCREMENT_DUE_DECISION', { ...FY2026, status: 'APPLIED' });
    expect(applied.length).toBe((await visible(hr1, FY2026.from, FY2026.to, 'APPLIED')).length);
    expect(applied.map((r) => r.State)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    // A department-limited exporter exports its department only.
    const finance = await exported(financeExporter, 'INCREMENT_DUE_DECISION', FY2026);
    expect(finance.map((r) => r['Employee code'])).toEqual([emp.E4!.code]);
    expect(finance.length).toBe((await visible(financeExporter, FY2026.from, FY2026.to)).length);
  });
});

describe('employee annual increment (FR-090, FR-093, DF14, CI21, ZT26)', () => {
  const growth = async (id: string, financialYear: number, basis = 'MONTHLY_GROSS') =>
    (await h.call(hr1, 'GET', `/v1/employees/${id}/annual-increment?financialYear=${financialYear}&basis=${basis}`)).json() as {
      opening: string | null;
      closing: string | null;
      currency: string | null;
      annualGrowthPercent: string | null;
      percentNaReason: string | null;
      changes: unknown[];
    };
  const money = (v: string | null) => (v === null ? '' : Number(v).toFixed(2));

  it('one row per employee with salary in the financial year, reconciled with the per-employee annual view: 21 percent, not 20', async () => {
    const rows = await exported(hr1, 'ANNUAL_INCREMENT', FY2026);
    const byCode = Object.fromEntries(rows.map((r) => [r['Employee code'], r]));
    // E5 has no salary on record, so no row.
    expect(rows.map((r) => r['Employee code']).sort()).toEqual([emp.E1!.code, emp.E2!.code, emp.E3!.code, emp.E4!.code].sort());
    expect(byCode[emp.E1!.code]).toEqual({
      'Employee code': emp.E1!.code,
      'Period start': '2026-04-01',
      'Period end': '2027-03-31',
      Basis: 'MONTHLY_GROSS',
      Currency: 'INR',
      Opening: '100000.00',
      Closing: '121000.00',
      'Approved changes': '2',
      'Annual growth %': '21.00',
      'N/A reason': '',
    });
    // No change on a known comparable baseline is zero (the rejected proposal changed nothing); a missing opening is N/A.
    expect(byCode[emp.E2!.code]).toMatchObject({ Opening: '50000.00', Closing: '50000.00', 'Approved changes': '0', 'Annual growth %': '0.00', 'N/A reason': '' });
    expect(byCode[emp.E3!.code]).toMatchObject({ Opening: '', Closing: '70000.00', 'Annual growth %': '', 'N/A reason': 'MISSING_OPENING_OR_CLOSING' });
    expect(byCode[emp.E4!.code]).toMatchObject({ 'Annual growth %': '10.00' });
    for (const e of [emp.E1!, emp.E2!, emp.E3!, emp.E4!]) {
      const g = await growth(e.id, 2026);
      expect(byCode[e.code]).toMatchObject({
        Opening: money(g.opening),
        Closing: money(g.closing),
        Currency: g.currency ?? '',
        'Approved changes': String(g.changes.length),
        'Annual growth %': g.annualGrowthPercent ?? '',
        'N/A reason': g.percentNaReason ?? '',
      });
    }
  });

  it('takes another comparable basis, a calendar year, and the requester’s row scope', async () => {
    const ctc = await exported(hr1, 'ANNUAL_INCREMENT', { ...FY2026, basis: 'ANNUAL_CTC' });
    const e1 = ctc.find((r) => r['Employee code'] === emp.E1!.code)!;
    const view = await growth(emp.E1!.id, 2026, 'ANNUAL_CTC');
    expect(e1).toMatchObject({ Basis: 'ANNUAL_CTC', Opening: '1200000.00', Closing: '1452000.00', 'Annual growth %': '21.00', 'Approved changes': '0' });
    expect(e1['Annual growth %']).toBe(view.annualGrowthPercent);
    // The increments were decided on the monthly gross basis, so no ANNUAL_CTC change is counted (bases are never mixed).
    expect(view.changes).toHaveLength(0);

    // Calendar year 2026: E1's salary starts on 5 January, so there is no opening salary on 31 December 2025.
    const calendar = await exported(hr1, 'ANNUAL_INCREMENT', { from: '2026-01-01', to: '2026-12-31' });
    expect(calendar.find((r) => r['Employee code'] === emp.E1!.code)).toMatchObject({ Opening: '', Closing: '110000.00', 'Approved changes': '1', 'N/A reason': 'MISSING_OPENING_OR_CLOSING' });

    const finance = await exported(financeExporter, 'ANNUAL_INCREMENT', FY2026);
    expect(finance.map((r) => r['Employee code'])).toEqual([emp.E4!.code]);
  });

  it('covers exactly one financial or calendar year; only this report takes a basis', async () => {
    const refused = async (code: string, filters: object) => {
      const res = await request(hr1, code, filters);
      return [res.statusCode, res.json().error];
    };
    expect(await refused('ANNUAL_INCREMENT', {})).toEqual([422, 'PERIOD_REQUIRED']);
    for (const period of [
      { from: '2026-04-01', to: '2026-12-31' },
      { from: '2026-04-02', to: '2027-03-31' },
      { from: '2026-04-01', to: '2028-03-31' },
      { from: '2026-01-01', to: '2027-12-31' },
    ]) {
      expect(await refused('ANNUAL_INCREMENT', period)).toEqual([422, 'ANNUAL_PERIOD_REQUIRED']);
    }
    expect((await request(hr1, 'ANNUAL_INCREMENT', { ...FY2026, basis: 'BASIC' })).statusCode).toBe(400);
    expect(await refused('INCREMENT_HISTORY', { ...FY2026, basis: 'MONTHLY_GROSS' })).toEqual([422, 'FILTER_NOT_SUPPORTED']);
    expect(await refused('INCREMENT_DUE_DECISION', { ...FY2026, basis: 'MONTHLY_GROSS' })).toEqual([422, 'FILTER_NOT_SUPPORTED']);
    expect(await refused('ANNUAL_INCREMENT', { ...FY2026, search: 'x' })).toEqual([422, 'FILTER_NOT_SUPPORTED']);
    // A status the report would not apply is refused, not ignored; the due/decision report applies it as the case state.
    expect(await refused('ANNUAL_INCREMENT', { ...FY2026, status: 'ACTIVE_CONFIRMED' })).toEqual([422, 'FILTER_NOT_SUPPORTED']);
    expect(await refused('INCREMENT_HISTORY', { ...FY2026, status: 'ACTIVE_CONFIRMED' })).toEqual([422, 'FILTER_NOT_SUPPORTED']);
    expect((await request(hr1, 'INCREMENT_DUE_DECISION', { ...FY2026, status: 'APPLIED' })).statusCode).toBe(202);
  });

  it('access revoked after the request means nothing is generated (ZT05)', async () => {
    const temp = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['increment.export.salary', 'increment.history_read.salary'] });
    const { id } = (await request(temp, 'ANNUAL_INCREMENT', FY2026)).json();
    await h.db.query(
      `update role_assignment_permission set active = false
        where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'increment' and action = 'export' and field_group = 'salary')`,
      [temp.assignment],
    );
    await processReportQueue(h.pool);
    expect((await h.call(temp, 'GET', `/v1/reports/${id}`)).statusCode).toBe(403);
    expect(await h.one(`select state, failure_code from report_execution where id = $1`, [id])).toEqual({ state: 'FAILED', failure_code: 'ACCESS_REVOKED' });
  });
});
