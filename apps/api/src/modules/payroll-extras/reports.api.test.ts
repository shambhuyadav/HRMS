// Medical claims and liability provisions over HTTP and the report worker (BRD coverage CL-113 check medical claims, CL-098 liability
// provisions; FR-038; FR-056; FR-079; BR-026 row scope; DF02; owner safeguard: statutory packs inactive until authorised, so nothing is
// valued without them). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { approvedExit } from '../payroll/payroll.fixtures.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';
import { isModuleActive } from '../registry.js';

const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

describe.runIf(isModuleActive('payroll-extras'))('medical claims and liability provisions (CL-113, CL-098)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;

  async function report(a: TestActor, reportCode: string, filters: object): Promise<Record<string, string>[]> {
    const res = await h.call(a, 'POST', '/v1/reports', { reportCode, filters });
    expect(res.statusCode, res.body).toBe(202);
    await processReportQueue(h.pool, 10);
    const status = (await h.call(a, 'GET', `/v1/reports/${res.json().id}`)).json();
    expect(status.state, JSON.stringify(status)).toBe('COMPLETED');
    const file = await h.call(a, 'GET', `/v1/reports/${res.json().id}/download`);
    const [header, ...rows] = csvTable(file.body).trimEnd().split('\r\n').filter((l) => l !== '').map(cells);
    return rows.map((row) => Object.fromEntries(header!.map((column, i) => [column, row[i]!])));
  }
  const person = async (over: Record<string, unknown> = {}) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, over))).json();
    expect(e.id, JSON.stringify(e)).toBeTruthy();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return { id: e.id as string, code: e.employeeCode as string };
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  describe('check medical claims (CL-113; FR-079, DF02)', () => {
    const READER: PermissionKey[] = ['expense.read.operational', 'expense.export.operational', 'payment.read.operational'];
    const FINANCE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'payment.read.operational'];
    let reader: TestActor;
    let eng: { id: string; code: string };
    let fin: { id: string; code: string };
    const PERIOD = { from: daysAgo(10), to: daysAgo(0) };
    const list = async (a: TestActor, q: Record<string, string> = {}) => h.call(a, 'GET', `/v1/payroll-extras/medical-claims?${new URLSearchParams({ ...PERIOD, ...q })}`);

    beforeAll(async () => {
      reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: READER });
      const fin1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
      await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [A.id, fin1.user]);
      // HR creates the medical categories and their rules on the draft policy; another administrator activates it.
      const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0] as { id: string; version: number };
      let version = policy.version;
      for (const code of ['MEDICAL', 'MEDICAL_DENTAL']) {
        const category = await h.call(hr, 'POST', '/v1/expense/categories', { code, name: `${code} (synthetic)`, limitBasis: 'PER_LINE' });
        expect(category.statusCode, category.body).toBe(201);
        const rule = await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/rules`, { expectedVersion: version, categoryId: category.json().id, limitAmount: '50000', receiptRequired: false });
        expect(rule.statusCode, rule.body).toBe(201);
        version = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0].version;
      }
      const activator = await h.actor(A, 'HR_ADMINISTRATOR');
      const activated = await h.call(activator, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: version });
      expect(activated.statusCode, activated.body).toBe(200);

      const boss = await person();
      const claimant = async (departmentId: string) => {
        const p = await person({ departmentId });
        await h.call(hr, 'POST', `/v1/employees/${p.id}/manager`, { managerEmployeeId: boss.id, effectiveFrom: '2026-01-05' });
        return { ...p, actor: await h.actor(A, 'EMPLOYEE', { employeeId: p.id }) };
      };
      const line =(category: string, amount: string, expenseDate: string, merchant: string) => ({ category, expenseDate, merchant, grossAmount: amount, claimedAmount: amount, description: `${category} (synthetic)` });
      const withReceipts = async (a: TestActor, lines: object[]) => {
        const out: object[] = [];
        for (const l of lines) {
          const uploaded = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
          expect(uploaded.statusCode, uploaded.body).toBe(201);
          out.push({ ...l, receipt: { receiptId: uploaded.json().receiptId as string } });
        }
        return out;
      };
      const claim = async (a: TestActor, plain: object[], submit = true) => {
        const lines = await withReceipts(a, plain);
        const created = await h.call(a, 'POST', '/v1/expense/claims', { purpose: 'Medical check (synthetic)', currency: 'INR', lines });
        expect(created.statusCode, created.body).toBe(201);
        const id = created.json().claimId as string;
        if (submit) {
          const v = (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json().version;
          const res = await h.call(a, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: v });
          expect(res.statusCode, res.body).toBe(200);
        }
        return id;
      };
      const e = await claimant(A.dept);
      const f = await claimant(A.financeDept);
      eng = e;
      fin = f;
      await claim(e.actor, [line('MEDICAL', '1500', daysAgo(3), 'Synthetic Clinic'), line('TRAVEL', '300', daysAgo(3), 'Synthetic Cab')]);
      await claim(e.actor, [line('MEDICAL', '99', daysAgo(2), 'Draft Clinic')], false);
      await claim(f.actor, [line('MEDICAL_DENTAL', '800', daysAgo(5), 'Synthetic Dental')]);
      // An older bill, submitted late with its reason.
      await claim(f.actor, [{ ...line('MEDICAL', '700', daysAgo(40), 'Old Clinic'), exceptionReason: 'Late bill (synthetic)' }]);
    }, 300_000);

    it('CL-113: medical lines of submitted claims in the bill-date period, with their state and amounts; nothing else', async () => {
      const res = await list(reader);
      expect(res.statusCode, res.body).toBe(200);
      const rows = res.json().items as Record<string, string>[];
      expect(rows.map((r) => [r.employee_code, r.category, r.merchant, r.claimed_amount, r.claim_state])).toEqual([
        [fin.code, 'MEDICAL_DENTAL', 'Synthetic Dental', '800.00', 'MANAGER_PENDING'],
        [eng.code, 'MEDICAL', 'Synthetic Clinic', '1500.00', 'MANAGER_PENDING'],
      ]);
      expect(rows[1]).toMatchObject({ department: 'ENG', expense_date: daysAgo(3), approved_amount: '', payment_state: 'NOT_APPLICABLE', currency: 'INR' });
      // Search (code, name or merchant) and department.
      expect(((await list(reader, { search: eng.code })).json().items as unknown[]).length).toBe(1);
      expect(((await list(reader, { search: 'dental' })).json().items as { employee_code: string }[]).map((r) => r.employee_code)).toEqual([fin.code]);
      expect(((await list(reader, { departmentId: A.financeDept })).json().items as { employee_code: string }[]).map((r) => r.employee_code)).toEqual([fin.code]);
      // A wider period reaches the older claim.
      expect(((await list(reader, { from: daysAgo(60) })).json().items as unknown[]).length).toBe(3);
      expect((await list(reader, { from: daysAgo(400) })).json().error).toBe('PERIOD_TOO_LONG');
      expect((await list(reader, { from: daysAgo(-5) })).json().error).toBe('INVALID_PERIOD');
    });

    it('BR-026 DF02: the row scope, the claim-read rule and the grant', async () => {
      const engOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: READER, departmentFilter: A.dept });
      expect(((await list(engOnly)).json().items as { employee_code: string }[]).map((r) => r.employee_code)).toEqual([eng.code]);
      // DF02: the read duty alone opens no claim (no payment read duty, no task on it).
      const readOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational'] });
      expect((await list(readOnly)).json().items).toEqual([]);
      expect((await list(hr)).statusCode).toBe(403);
    });

    it('CL-113 FR-056: the MEDICAL_CLAIMS report holds the same rows, under the export grant', async () => {
      const rows = await report(reader, 'MEDICAL_CLAIMS', { ...PERIOD });
      expect(rows.map((r) => [r['Employee code'], r.Category, r['Claimed amount'], r['Bill date']])).toEqual([
        [fin.code, 'MEDICAL_DENTAL', '800.00', daysAgo(5)],
        [eng.code, 'MEDICAL', '1500.00', daysAgo(3)],
      ]);
      expect((await report(reader, 'MEDICAL_CLAIMS', { ...PERIOD, search: fin.code })).map((r) => r['Employee code'])).toEqual([fin.code]);
      expect((await h.call(reader, 'POST', '/v1/reports', { reportCode: 'MEDICAL_CLAIMS', filters: {} })).json().error).toBe('PERIOD_REQUIRED');
      expect((await h.call(hr, 'POST', '/v1/reports', { reportCode: 'MEDICAL_CLAIMS', filters: PERIOD })).statusCode).toBe(403);
    });
  });

  describe('liability provisions as on a date (CL-098; FR-038, FR-052)', () => {
    const AS_OF = '2026-10-31';
    // Worked from salaries: the salary read grant, and the salary history grant for an earlier as-on date (AS_OF is one).
    const SALARY_READ: PermissionKey[] = ['salary.read.salary', 'salary.history_read.salary'];
    const REPORT: PermissionKey[] = ['payroll_report.read.amount', 'payroll_report.export.amount', ...SALARY_READ];
    const REPORT_ONLY: PermissionKey[] = ['payroll_report.read.amount', 'payroll_report.export.amount'];
    const CONFIG: PermissionKey[] = ['payroll_config.read.operational', 'payroll_config.manage.operational', 'payroll_config.activate.operational', 'salary.read.salary', 'salary.manage.salary'];
    let reader: TestActor;
    let config1: TestActor;
    let config2: TestActor;
    let g1: { id: string; code: string };
    let g2: { id: string; code: string };
    let g3: { id: string; code: string };
    const provisions = async (a: TestActor, q: Record<string, string> = {}) => h.call(a, 'GET', `/v1/payroll-extras/liability-provisions?${new URLSearchParams({ asOf: AS_OF, ...q })}`);
    type Item = Record<string, unknown> & { item: string; totals: { currencyCode: string; amount: string }[]; unresolved: number };
    const item = (body: { items: Item[] }, code: string) => body.items.find((i) => i.item === code)!;

    beforeAll(async () => {
      reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT });
      config1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
      config2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
      for (const code of ['LP_BASIC', 'LP_DA', 'LP_ENCASH']) expect((await h.call(config1, 'POST', '/v1/payroll/components', { code, name: `${code} (synthetic)`, componentKind: 'EARNING' })).statusCode).toBe(201);
      const paid = async (joiningDate: string, departmentId: string, components: { code: string; amount: string }[]) => {
        const p = await person({ joiningDate, departmentId });
        const gross = String(components.reduce((s, c) => s + Number(c.amount), 0));
        const sa = await h.call(config1, 'POST', `/v1/employees/${p.id}/salary`, { effectiveFrom: joiningDate, annualCtc: gross, monthlyGross: gross, currency: 'INR' });
        expect(sa.statusCode, sa.body).toBe(201);
        const cs = await h.call(config1, 'POST', `/v1/payroll/salary-arrangements/${sa.json().id}/components`, { components: components.map((c) => ({ componentCode: c.code, amount: c.amount, basis: 'MONTHLY' })) });
        expect(cs.statusCode, cs.body).toBe(201);
        return p;
      };
      g1 = await paid('2020-01-05', A.dept, [{ code: 'LP_BASIC', amount: '20000' }, { code: 'LP_DA', amount: '6000' }]);
      g2 = await paid('2025-01-05', A.financeDept, [{ code: 'LP_BASIC', amount: '13000' }]);
      g3 = await paid('2024-02-01', A.dept, [{ code: 'LP_BASIC', amount: '15000' }]);
      const opening = async (employeeId: string, units: string) =>
        expect(
          (await h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId, kind: 'OPENING', leaveType: 'ANNUAL', units, effectiveDate: '2026-02-01', reason: 'Opening (synthetic)', idempotencyKey: uniq('liability-opening-') })).statusCode,
        ).toBe(201);
      await opening(g1.id, '12');
      await opening(g2.id, '40');
      // g3 resigned on 20 October, leaving on 10 November with 30 days' contractual notice: 22 days served, 8 short.
      await approvedExit(h, A, g3.id, '2026-10-20', '2026-11-10');
      await h.db.query(`update exit_case set contractual_notice_days = 30 where company_id = $1 and employee_id = $2`, [A.id, g3.id]);
    }, 300_000);

    it('CL-098: with no settlement policy and the packs inactive, every item reads NOT_CONFIGURED and no number is shown', async () => {
      const res = await provisions(reader);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.items.map((i: { item: string; status: string; reason: string }) => [i.item, i.status, i.reason])).toEqual([
        ['GRATUITY', 'NOT_CONFIGURED', 'RULE_PACK_NOT_ACTIVE'],
        ['STATUTORY_BONUS', 'NOT_CONFIGURED', 'RULE_PACK_NOT_DEFINED'],
        ['LEAVE_ENCASHMENT', 'NOT_CONFIGURED', 'SETTLEMENT_POLICY_NOT_CONFIGURED'],
        ['NOTICE_PAY', 'NOT_CONFIGURED', 'SETTLEMENT_POLICY_NOT_CONFIGURED'],
      ]);
      expect(body.rows).toEqual([]);
      expect(body.departments).toEqual([]);
    });

    it('CL-098: leave encashment and notice pay from the settlement policy and leave balances; gratuity waits for its pack', async () => {
      const created = await h.call(config1, 'POST', '/v1/settlements/policies', {
        effectiveFrom: '2026-01-01',
        basicComponentCode: 'LP_BASIC',
        daComponentCode: 'LP_DA',
        encashmentComponentCode: 'LP_ENCASH',
        encashmentRateBasis: 'BASIC_DA',
        encashmentDivisor: 30,
        encashable: [{ leaveType: 'ANNUAL', maxUnits: '30' }],
        noticeRateBasis: 'BASIC',
        noticeDivisor: 30,
      });
      expect(created.statusCode, created.body).toBe(201);
      const activated = await h.call(config2, 'POST', `/v1/settlements/policies/${created.json().id}/activate`, { expectedVersion: created.json().version });
      expect(activated.statusCode, activated.body).toBe(200);
      const body = (await provisions(reader)).json();
      expect(item(body, 'GRATUITY')).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'RULE_PACK_NOT_ACTIVE', totals: [] });
      expect(body.rows.filter((r: { item: string }) => r.item === 'GRATUITY')).toEqual([]);
      const encash = body.rows.filter((r: { item: string }) => r.item === 'LEAVE_ENCASHMENT');
      // 12 days x 26,000 / 30 = 10,400; 40 days capped at 30 x 13,000 / 30 = 13,000.
      expect(encash.map((r: { employeeCode: string; amount: string; status: string }) => [r.employeeCode, r.status, r.amount])).toEqual([
        [g1.code, 'CALCULATED', '10400.0000'],
        [g2.code, 'CALCULATED', '13000.0000'],
      ]);
      // A resignation 8 days short of its notice: 8 x 15,000 / 30 = 4,000, recoverable (negative).
      expect(body.rows.filter((r: { item: string }) => r.item === 'NOTICE_PAY').map((r: { employeeCode: string; amount: string }) => [r.employeeCode, r.amount])).toEqual([[g3.code, '-4000.0000']]);
      expect(item(body, 'LEAVE_ENCASHMENT').totals).toEqual([{ currencyCode: 'INR', amount: '23400.0000' }]);
    });

    it('CL-098: gratuity once its pack is validated and activated by two people: accrued for everyone, vested or not, by department', async () => {
      const packV = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.read.operational', 'statutory_pack.validate.operational'] });
      const packA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.read.operational', 'statutory_pack.activate.operational'] });
      const pack = ((await h.call(packV, 'GET', '/v1/statutory-rule-packs')).json().items as { id: string; code: string; version: number }[]).find((p) => p.code === 'GRATUITY')!;
      const v = await h.call(packV, 'POST', `/v1/statutory-rule-packs/${pack.id}/validate`, { sourceReference: 'Synthetic source', validationReference: 'Synthetic check', expectedVersion: pack.version });
      expect(v.statusCode, v.body).toBe(200);
      expect((await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pack.id}/activate`, { expectedVersion: v.json().version })).statusCode).toBe(200);
      const body = (await provisions(reader)).json();
      expect(item(body, 'GRATUITY')).toMatchObject({ status: 'CALCULATED' });
      const gratuity = body.rows.filter((r: { item: string }) => r.item === 'GRATUITY') as { employeeCode: string; status: string; amount: string | null; vested: string }[];
      // 26,000 x 15/26 x 7 years (6 completed and more than six months) = 105,000; 13,000 x 15/26 x 2 = 15,000; 15,000 x 15/26 x 3 = 25,961.54.
      expect(gratuity.filter((r) => r.status === 'CALCULATED').map((r) => [r.employeeCode, r.amount, r.vested])).toEqual([
        [g1.code, '105000.0000', 'YES'],
        [g2.code, '15000.0000', 'NO'],
        [g3.code, '25961.5400', 'NO'],
      ]);
      // Everyone else employed on the date (the claimants above) has no salary arrangement: listed with why, never a number.
      const others = gratuity.filter((r) => ![g1.code, g2.code, g3.code].includes(r.employeeCode));
      expect(others.length).toBeGreaterThan(0);
      expect(others.every((r) => r.status === 'NO_SALARY_ARRANGEMENT' && r.amount === null)).toBe(true);
      expect(item(body, 'GRATUITY').unresolved).toBe(others.length);
      expect(body.departments).toEqual([
        { departmentCode: 'ENG', department: 'ENG', currencyCode: 'INR', amounts: { GRATUITY: '130961.5400', LEAVE_ENCASHMENT: '10400.0000', NOTICE_PAY: '-4000.0000' }, total: '137361.5400' },
        { departmentCode: 'FIN', department: 'FIN', currencyCode: 'INR', amounts: { GRATUITY: '15000.0000', LEAVE_ENCASHMENT: '13000.0000' }, total: '28000.0000' },
      ]);
      // The statutory bonus has no pack definition: still not configured.
      expect(item(body, 'STATUTORY_BONUS')).toMatchObject({ status: 'NOT_CONFIGURED', totals: [] });
      // Before g1 joined nobody of them was employed; on a date before g3's resignation there is no notice row.
      expect((await provisions(reader, { asOf: '2026-10-19' })).json().rows.filter((r: { item: string }) => r.item === 'NOTICE_PAY')).toEqual([]);
    });

    it('BR-026: the department filter, the row scope, never one’s own record, and the grant', async () => {
      const calculated = (res: { json(): { rows: { employeeCode: string; status: string }[] } }) => res.json().rows.filter((r) => r.status === 'CALCULATED').map((r) => r.employeeCode);
      expect(new Set(calculated(await provisions(reader, { departmentId: A.financeDept })))).toEqual(new Set([g2.code]));
      const engOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT, departmentFilter: A.dept });
      expect([...new Set(calculated(await provisions(engOnly)))].sort()).toEqual([g1.code, g3.code].sort());
      const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT, employeeId: g1.id });
      expect(((await provisions(self)).json().rows as { employeeCode: string }[]).some((r) => r.employeeCode === g1.code)).toBe(false);
      expect((await provisions(hr)).statusCode).toBe(403);
      expect((await h.call(reader, 'GET', '/v1/payroll-extras/liability-provisions')).statusCode).toBe(400);
    });

    it('CL-098 FR-056: the report holds the employee rows and one NOT_CONFIGURED row per item without a rule', async () => {
      const rows = await report(reader, 'LIABILITY_PROVISIONS', { to: AS_OF });
      expect(rows.filter((r) => r.Item === 'STATUTORY_BONUS')).toEqual([expect.objectContaining({ Status: 'NOT_CONFIGURED', 'Employee code': '', Amount: '', Basis: 'RULE_PACK_NOT_DEFINED' })]);
      expect(rows.filter((r) => r.Item === 'GRATUITY' && r.Status === 'CALCULATED').map((r) => [r['Employee code'], r.Amount, r.Vested])).toEqual([
        [g1.code, '105000.0000', 'YES'],
        [g2.code, '15000.0000', 'NO'],
        [g3.code, '25961.5400', 'NO'],
      ]);
      expect((await h.call(reader, 'POST', '/v1/reports', { reportCode: 'LIABILITY_PROVISIONS', filters: { from: AS_OF, to: AS_OF } })).json().error).toBe('FILTER_NOT_SUPPORTED');
      expect((await h.call(reader, 'POST', '/v1/reports', { reportCode: 'LIABILITY_PROVISIONS', filters: {} })).json().error).toBe('AS_OF_REQUIRED');
      // Reading is not exporting.
      const readOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_report.read.amount', ...SALARY_READ] });
      expect((await h.call(readOnly, 'POST', '/v1/reports', { reportCode: 'LIABILITY_PROVISIONS', filters: { to: AS_OF } })).statusCode).toBe(403);
    });

    it('CL-098 C4: worked from salaries, so the payroll report grant alone is refused, and an earlier date needs the salary history grant', async () => {
      const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
      const request = (a: TestActor, to: string) => h.call(a, 'POST', '/v1/reports', { reportCode: 'LIABILITY_PROVISIONS', filters: { to } });
      // The payroll report grants alone: no screen, no export, today or earlier, and the report is not offered.
      const reportOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT_ONLY });
      for (const asOf of [AS_OF, today]) expect((await provisions(reportOnly, { asOf })).statusCode).toBe(403);
      expect([(await request(reportOnly, today)).statusCode, (await request(reportOnly, today)).json().error]).toEqual([403, 'SOURCE_GRANT_REQUIRED']);
      const offered = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/reports/catalogue')).json().items as { code: string }[]).map((i) => i.code);
      expect(await offered(reportOnly)).not.toContain('LIABILITY_PROVISIONS');
      expect(await offered(reader)).toContain('LIABILITY_PROVISIONS');
      // The salary read grant without the history grant: today only.
      const current = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...REPORT_ONLY, 'salary.read.salary'] });
      expect((await provisions(current, { asOf: today })).statusCode).toBe(200);
      expect((await provisions(current, { asOf: AS_OF })).statusCode).toBe(403);
      expect([(await request(current, AS_OF)).statusCode, (await request(current, AS_OF)).json().error]).toEqual([403, 'HISTORY_GRANT_REQUIRED']);
      expect((await request(current, today)).statusCode).toBe(202);
      // A file generated with the salary grant is not downloaded once it is gone (the download re-checks it).
      const holder = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT });
      const requested = await request(holder, AS_OF);
      expect(requested.statusCode, requested.body).toBe(202);
      await processReportQueue(h.pool, 10);
      expect((await h.call(holder, 'GET', `/v1/reports/${requested.json().id}`)).json().state).toBe('COMPLETED');
      await h.db.query(
        `update role_assignment_permission set active = false
          where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'salary' and action = 'read' and field_group = 'salary')`,
        [holder.assignment],
      );
      expect((await h.call(holder, 'GET', `/v1/reports/${requested.json().id}/download`)).statusCode).toBe(403);
      expect((await provisions(holder)).statusCode).toBe(403);
    });

    it('CL-098: an as-on date after today is refused, on screen and for the export (422)', async () => {
      const future = await provisions(reader, { asOf: '2099-01-01' });
      expect([future.statusCode, future.json().error]).toEqual([422, 'FUTURE_AS_OF']);
      const exported = await h.call(reader, 'POST', '/v1/reports', { reportCode: 'LIABILITY_PROVISIONS', filters: { to: '2099-01-01' } });
      expect([exported.statusCode, exported.json().error]).toEqual([422, 'FUTURE_AS_OF']);
    });

    it('CL-098: the basis names the rate basis and the rule, never an amount or a count that would give the salary back', async () => {
      const body = (await provisions(reader)).json();
      const rows = body.rows as { item: string; status: string; basis: string }[];
      // Every item that is worked out has rows here (gratuity, encashment, notice pay).
      expect(new Set(rows.filter((r) => r.status === 'CALCULATED').map((r) => r.item))).toEqual(new Set(['GRATUITY', 'LEAVE_ENCASHMENT', 'NOTICE_PAY']));
      for (const r of rows) expect(r.basis, `${r.item} ${r.status}`).not.toMatch(/\d/);
      expect(rows.find((r) => r.item === 'GRATUITY' && r.status === 'CALCULATED')!.basis).toContain('Basic + DA');
      const exported = await report(reader, 'LIABILITY_PROVISIONS', { to: AS_OF });
      expect(exported.length).toBeGreaterThan(0);
      for (const r of exported) expect(r.Basis, `${r.Item} ${r.Status}`).not.toMatch(/\d/);
    });
  });
});
