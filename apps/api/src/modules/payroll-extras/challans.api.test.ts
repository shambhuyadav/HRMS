// Challan master and TDS challans over HTTP (BRD coverage CL-074 challan master, CL-081 monthly TDS challan entry; FR-039; DF09
// imports; BR-026; FR-057 audit): dated revisions never overwritten, the statute rules, screen entry, upload, cancellation, the
// company-scope rule, and the reconciliation with the Form 24Q working data. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';

const MANAGE = ['payroll_challan.read.operational', 'payroll_challan.manage.operational'] as const;
const toBase64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const HEADER = 'month,section,bsrCode,challanSerial,depositDate,amount';
const csv = (...rows: string[]) => `${HEADER}\r\n${rows.join('\r\n')}\r\n`;

describe.runIf(isModuleActive('payroll-extras'))('challan master and TDS challans (CL-074, CL-081; FR-039)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let admin: TestActor;
  let operator: TestActor;
  let plainHr: TestActor;
  let deptOnly: TestActor;
  let otherCompany: TestActor;
  let today: string;

  const setting = (a: TestActor, body: Record<string, unknown>) => h.call(a, 'POST', '/v1/payroll-extras/challan-settings', body);
  const challan = (a: TestActor, body: Record<string, unknown>) => h.call(a, 'POST', '/v1/payroll-extras/tds-challans', body);
  const upload = (a: TestActor, text: string, key = uniq('challan-batch-')) =>
    h.call(a, 'POST', '/v1/payroll-extras/tds-challan-imports', { fileName: 'challans.csv', contentBase64: toBase64(text), idempotencyKey: key });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    admin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...MANAGE] });
    operator = await h.actor(A, 'PAYROLL_OPERATOR', { extra: ['payroll_challan.manage.operational'] });
    plainHr = await h.actor(A, 'HR_ADMINISTRATOR');
    deptOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...MANAGE], departmentFilter: A.dept });
    otherCompany = await h.actor(B, 'HR_ADMINISTRATOR', { extra: [...MANAGE] });
    today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('CL-074: dated revisions per statute, never overwritten; the revision in force is the latest effective on or before the day', async () => {
    const first = await setting(admin, { statute: 'TDS', effectiveFrom: '2026-04-01', tan: 'abcd12345e', bankName: 'Synthetic Bank', bsrCode: '0510001', reason: 'Initial TAN (synthetic)' });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ statute: 'TDS', revision: 1, tan: 'ABCD12345E', bsrCode: '0510001', establishmentCode: null });
    const later = await setting(operator, { statute: 'TDS', effectiveFrom: '2099-01-01', tan: 'WXYZ54321A', bankName: 'Later Bank', reason: 'Bank change (synthetic)' });
    expect(later.statusCode, later.body).toBe(201);
    expect(later.json().revision).toBe(2);
    const pf = await setting(admin, { statute: 'PF', effectiveFrom: '2026-01-01', establishmentCode: 'MHBAN0012345000', bankName: 'Synthetic Bank', reason: 'PF code (synthetic)' });
    expect(pf.statusCode, pf.body).toBe(201);
    const list = (await h.call(operator, 'GET', '/v1/payroll-extras/challan-settings')).json();
    expect(list.inForce.TDS).toMatchObject({ revision: 1, tan: 'ABCD12345E' });
    expect(list.inForce.PF).toMatchObject({ establishmentCode: 'MHBAN0012345000' });
    expect(list.inForce.ESIC).toBeNull();
    expect(list.items.filter((i: { statute: string }) => i.statute === 'TDS').map((i: { revision: number }) => i.revision)).toEqual([2, 1]);
    // Never overwritten: the table refuses an update outright.
    await expect(h.db.query(`update payroll_challan_setting set bank_name = 'Changed' where id = $1`, [first.json().id])).rejects.toThrow();
    const audit = await h.db.query(`select action, reason from audit_event where company_id = $1 and resource_code = 'payroll_challan_setting' order by occurred_at`, [A.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['CREATE', 'CREATE', 'CREATE']);
    expect(audit.rows[0]!.reason).toBe('Initial TAN (synthetic)');
  });

  it('CL-074: each statute takes its own identifier, and the formats are checked', async () => {
    const bad = async (body: Record<string, unknown>) => (await setting(admin, { effectiveFrom: '2026-04-01', bankName: 'Bank', reason: 'x', ...body })).json().error;
    expect(await bad({ statute: 'TDS', tan: 'ABC123' })).toBe('INVALID_TAN');
    expect(await bad({ statute: 'TDS' })).toBe('INVALID_TAN');
    expect(await bad({ statute: 'ESIC', tan: 'ABCD12345E' })).toBe('INVALID_ESTABLISHMENT_CODE');
    expect(await bad({ statute: 'ESIC', establishmentCode: '12345678901234567', tan: 'ABCD12345E' })).toBe('INVALID_VALUE');
    expect(await bad({ statute: 'PF', establishmentCode: 'MHBAN0012345000', bsrCode: '12' })).toBe('INVALID_BSR_CODE');
    expect((await setting(admin, { statute: 'GST', effectiveFrom: '2026-04-01', bankName: 'B', reason: 'x' })).statusCode).toBe(400);
  });

  it('BR-026 FR-002: the grant, company scope and company boundary', async () => {
    const body = { statute: 'ESIC', effectiveFrom: '2026-04-01', establishmentCode: '12345678901234567', bankName: 'B', reason: 'x' };
    expect((await setting(plainHr, body)).statusCode).toBe(403);
    expect((await h.call(plainHr, 'GET', '/v1/payroll-extras/challan-settings')).statusCode).toBe(403);
    // A department-filtered assignment cannot change company configuration.
    expect((await setting(deptOnly, body)).json().error).toBe('COMPANY_SCOPE_REQUIRED');
    expect((await challan(deptOnly, { month: '2026-04', section: '192', bsrCode: '0510001', challanSerial: '1', depositDate: '2026-05-07', amount: '10.00' })).json().error).toBe('COMPANY_SCOPE_REQUIRED');
    // Another company's settings are not visible.
    expect((await h.call(otherCompany, 'GET', '/v1/payroll-extras/challan-settings')).json().items).toEqual([]);
    // The Payroll Operator reads by default (default duty) and the denial of a plain HR role is audited.
    expect((await h.call(await h.actor(A, 'PAYROLL_OPERATOR'), 'GET', '/v1/payroll-extras/challan-settings')).statusCode).toBe(200);
    const denied = await h.db.query(`select 1 from audit_event where company_id = $1 and action = 'ACCESS_DENIED' and actor_user_id = $2`, [A.id, plainHr.user]);
    expect(denied.rowCount).toBeGreaterThan(0);
  });

  it('CL-081: a challan entered on screen, recorded once, never edited, cancelled with a reason and entered again', async () => {
    const body = { month: '2026-04', section: '192', bsrCode: '0510001', challanSerial: '12', depositDate: '2026-05-07', amount: '15000.50' };
    const created = await challan(admin, body);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ month: '2026-04', challanSerial: '00012', amount: '15000.50', state: 'RECORDED', source: 'SCREEN', version: 1 });
    expect((await challan(admin, body)).json().error).toBe('CHALLAN_EXISTS');
    // Never edited in place: the database refuses it.
    await expect(h.db.query(`update payroll_tds_challan set amount = 1 where id = $1`, [created.json().id])).rejects.toThrow(/never edited/);
    expect((await h.call(admin, 'POST', `/v1/payroll-extras/tds-challans/${created.json().id}/cancel`, { reason: 'Wrong serial (synthetic)', expectedVersion: 9 })).json().error).toBe('STALE_VERSION');
    const cancelled = await h.call(admin, 'POST', `/v1/payroll-extras/tds-challans/${created.json().id}/cancel`, { reason: 'Wrong serial (synthetic)', expectedVersion: 1 });
    expect(cancelled.json()).toMatchObject({ state: 'CANCELLED', cancelReason: 'Wrong serial (synthetic)', version: 2 });
    expect((await h.call(admin, 'POST', `/v1/payroll-extras/tds-challans/${created.json().id}/cancel`, { reason: 'again', expectedVersion: 2 })).json().error).toBe('INVALID_STATE');
    // The same challan identification can be recorded again once the wrong entry is cancelled.
    expect((await challan(admin, body)).statusCode).toBe(201);
    const actions = await h.db.query(`select action from audit_event where company_id = $1 and resource_code = 'payroll_tds_challan' and record_key = $2 order by occurred_at`, [A.id, created.json().id]);
    expect(actions.rows.map((r) => r.action)).toEqual(['CREATE', 'CANCEL']);
  });

  it('CL-081: the challan rules: month and deposit date not in the future, deposit not before the month, formats', async () => {
    const base = { month: '2026-04', section: '192', bsrCode: '0510001', challanSerial: '77', depositDate: '2026-05-07', amount: '10.00' };
    const error = async (over: Record<string, unknown>) => (await challan(admin, { ...base, ...over })).json().error;
    expect(await error({ month: '2026-13' })).toBe('INVALID_MONTH');
    expect(await error({ month: '2099-01', depositDate: '2099-01-07' })).toBe('FUTURE_MONTH');
    expect(await error({ depositDate: '2099-01-07' })).toBe('FUTURE_DEPOSIT_DATE');
    expect(await error({ depositDate: '2026-03-31' })).toBe('DEPOSIT_BEFORE_MONTH');
    expect(await error({ bsrCode: '05100' })).toBe('INVALID_BSR_CODE');
    expect(await error({ challanSerial: '123456' })).toBe('INVALID_CHALLAN_SERIAL');
    expect(await error({ amount: '0' })).toBe('INVALID_AMOUNT');
    expect(await error({ amount: '1.234' })).toBe('INVALID_AMOUNT');
    expect(await error({ section: '19-2' })).toBe('INVALID_SECTION');
  });

  it('CL-081 DF09: the upload previews, applies all or nothing, records the batch, and refuses a repeat of a recorded challan', async () => {
    const template = await h.call(admin, 'GET', '/v1/payroll-extras/tds-challan-imports/template');
    expect(template.body).toBe(`${HEADER}\r\n`);
    const text = csv('2026-06,192,0510001,301,2026-07-07,2000.00', '2026-07,192,0510001,302,2026-08-07,2500.25');
    const job = (await upload(admin, text)).json();
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'TDS_CHALLAN_V1' });
    expect(job.rows.map((r: { businessKey: string; state: string }) => [r.businessKey, r.state])).toEqual([
      ['0510001@2026-07-07@00301', 'VALID'],
      ['0510001@2026-08-07@00302', 'VALID'],
    ]);
    expect((await h.db.query(`select 1 from payroll_tds_challan where company_id = $1 and challan_serial in ('00301', '00302')`, [A.id])).rowCount).toBe(0);
    const done = (await h.call(admin, 'POST', `/v1/payroll-extras/tds-challan-imports/${job.id}/commit`)).json();
    expect(done).toMatchObject({ state: 'COMMITTED', acceptedCount: 2 });
    const stored = await h.db.query(`select source, import_job_id from payroll_tds_challan where company_id = $1 and challan_serial in ('00301', '00302')`, [A.id]);
    expect(stored.rows).toEqual([
      { source: 'IMPORT', import_job_id: job.id },
      { source: 'IMPORT', import_job_id: job.id },
    ]);
    // A file repeating a recorded challan, or one with a bad row, is rejected whole.
    const again = (await upload(admin, csv('2026-06,192,0510001,301,2026-07-07,2000.00', '2026-08,192,0510001,303,2026-09-07,10.00'))).json();
    expect(again.state).toBe('REJECTED');
    expect(again.rows.map((r: { errorCode: string | null }) => r.errorCode)).toEqual(['CHALLAN_EXISTS', 'BATCH_REJECTED']);
    const repeated = (await upload(admin, csv('2026-08,192,0510001,304,2026-09-07,10.00', '2026-08,192,0510001,00304,2026-09-07,10.00'))).json();
    expect(repeated.state).toBe('REJECTED');
    expect(repeated.rows.map((r: { errorCode: string | null }) => r.errorCode)).toEqual(['BATCH_REJECTED', 'DUPLICATE_IN_BATCH']);
    // Company configuration: the department-filtered assignment cannot upload either.
    expect((await upload(deptOnly, text)).json().error).toBe('COMPANY_SCOPE_REQUIRED');
  });

  it('CL-081 FR-039: the year list totals recorded challans by month; the reconciliation compares them with the TDS deducted', async () => {
    const reconciler = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...MANAGE, 'payroll_report.read.amount'] });
    const list = (await h.call(reconciler, 'GET', '/v1/payroll-extras/tds-challans?fiscalYear=2026-27')).json();
    expect(list.amountsHidden).toBe(false);
    expect(list.months).toEqual([
      { month: '2026-04', deposited: '15000.5000' },
      { month: '2026-06', deposited: '2000.0000' },
      { month: '2026-07', deposited: '2500.2500' },
    ]);
    expect(list.items.filter((c: { state: string }) => c.state === 'CANCELLED')).toHaveLength(1);
    expect((await h.call(admin, 'GET', '/v1/payroll-extras/tds-challans?fiscalYear=2026-28')).json().error).toBe('INVALID_FISCAL_YEAR');
    // The reconciliation needs the payroll report grant as well (company figures).
    expect((await h.call(admin, 'GET', '/v1/payroll-extras/tds-reconciliation?fiscalYear=2026-27')).statusCode).toBe(403);
    const rec = (await h.call(reconciler, 'GET', '/v1/payroll-extras/tds-reconciliation?fiscalYear=2026-27')).json();
    expect(rec.form24Q.status).toBe('NOT_CONFIGURED');
    // No processed payroll in this company: nothing deducted, so every deposit is in excess.
    expect(rec.months[0]).toEqual({ month: '2026-04', deducted: '0.0000', deposited: '15000.5000', difference: '-15000.5000', status: 'EXCESS_DEPOSITED' });
    expect(rec.totals).toEqual({ deducted: '0.0000', deposited: '19500.7500' });
    // A month later than today is refused for entry: the deposit list never runs ahead of the calendar.
    expect((await challan(admin, { month: `${Number(today.slice(0, 4)) + 1}-01`, section: '192', bsrCode: '0510001', challanSerial: '9', depositDate: today, amount: '1.00' })).json().error).toBe('FUTURE_MONTH');
  });

  it('CL-081 DF02: the challan read duty lists the challans; their amounts and totals only with the payroll report amount grant, company-wide', async () => {
    type Listed = { amountsHidden: boolean; items: { challanSerial: string; amount: string | null; state: string }[]; months: { month: string; deposited: string | null }[]; deposited: string | null };
    const listed = async (a: TestActor) => {
      const res = await h.call(a, 'GET', '/v1/payroll-extras/tds-challans?fiscalYear=2026-27');
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Listed;
    };
    // The default duty of the Payroll Operator, Payroll Approver and Finance Reviewer: the challans, without their amounts.
    for (const role of ['PAYROLL_OPERATOR', 'PAYROLL_APPROVER', 'FINANCE_REVIEWER']) {
      const reader = await h.actor(A, role);
      const hidden = await listed(reader);
      expect(hidden.amountsHidden, role).toBe(true);
      expect(hidden.items.length, role).toBeGreaterThan(0);
      expect(hidden.items.every((c) => c.amount === null), role).toBe(true);
      expect(hidden.months.map((m) => m.deposited)).toEqual([null, null, null]);
      expect(hidden.deposited).toBeNull();
    }
    // The challan managers above hold no amount grant either; a manager cancelling a challan does not read its amount back.
    expect((await listed(admin)).amountsHidden).toBe(true);
    const wrong = await challan(admin, { month: '2026-05', section: '192', bsrCode: '0510001', challanSerial: '501', depositDate: '2026-06-07', amount: '321.00' });
    expect(wrong.json().amount).toBe('321.00');
    const cancelled = await h.call(admin, 'POST', `/v1/payroll-extras/tds-challans/${wrong.json().id}/cancel`, { reason: 'Synthetic: entered twice', expectedVersion: 1 });
    expect(cancelled.json()).toMatchObject({ state: 'CANCELLED', amount: null, amountsHidden: true });
    // With the payroll report amount grant in the same assignment, company-wide: the amounts and the monthly totals.
    const amounts = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_challan.read.operational', 'payroll_report.read.amount'] });
    const shown = await listed(amounts);
    expect(shown.amountsHidden).toBe(false);
    expect(shown.items.find((c) => c.challanSerial === '00501')!.amount).toBe('321.00');
    expect(shown.months.find((m) => m.month === '2026-04')!.deposited).toBe('15000.5000');
    expect(shown.deposited).toBe('19500.7500');
    // A department-filtered amount grant is not company-wide: company figures stay hidden.
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_challan.read.operational', 'payroll_report.read.amount'], departmentFilter: A.dept });
    expect((await listed(narrow)).amountsHidden).toBe(true);
  });
});
