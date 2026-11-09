// Grade salary structures and CTC categories (FR-028, FR-029; E08; DF05; migration 0207; decided under owner delegation, 6 Nov 2026,
// docs/03 I-80). Values worked by hand from the rules as written, on synthetic CTCs:
//   annual 6,00,000: monthly CTC 50,000.00; BASIC 40% of CTC 20,000.00; HRA 50% of BASIC 10,000.00; employer PF 12% of BASIC
//   2,400.00; conveyance fixed 1,600.00; SPECIAL (balance) 50,000 - 34,000 = 16,000.00; gross = BASIC + HRA + CONV + SPECIAL = 47,600.00.
//   annual 5,00,000: monthly 41,666.666... -> 41,666.67; BASIC 16,666.666... -> 16,666.67; HRA 8,333.335 -> 8,333.34 (half-up);
//   PF 2,000.0004 -> 2,000.00; CONV 1,600.00; SPECIAL 41,666.67 - 28,600.01 = 13,066.66; gross 39,666.67.
//   annual 30,000: monthly 2,500.00 is less than BASIC 1,000 + HRA 500 + PF 120 + CONV 1,600 = 3,220: refused, never a negative balance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { CONFIG, grants, head, ok, person, SALARY } from './payroll.fixtures.js';

interface Structure {
  id: string;
  state: string;
  version: number;
  revision: number;
  lines: { sequence: number; componentCode: string; method: string }[];
}
interface Derivation {
  monthlyCtc: string;
  monthlyGross: string;
  lines: { componentCode: string; headType: string; amount: string }[];
}

describe('grade salary structures and CTC categories (FR-028, FR-029, I-80)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let grade: string;

  const LINES = [
    { componentCode: 'GS_BASIC', method: 'PERCENT_OF_CTC', percent: '40' },
    { componentCode: 'GS_HRA', method: 'PERCENT_OF_COMPONENT', percent: '50', baseComponentCode: 'GS_BASIC' },
    { componentCode: 'GS_PF_ER', method: 'PERCENT_OF_COMPONENT', percent: '12', baseComponentCode: 'GS_BASIC' },
    { componentCode: 'GS_CONV', method: 'FIXED_MONTHLY', amount: '1600' },
    { componentCode: 'GS_SPECIAL', method: 'BALANCE' },
  ];
  const draft = (lines: unknown[] = LINES, extra: Record<string, unknown> = {}) =>
    h.call(configA, 'POST', '/v1/payroll/grade-structures', { gradeCode: 'GS1', effectiveFrom: '2026-01-01', currencyCode: 'INR', lines, ...extra });
  const derivation = async (employeeId: string, annualCtc: string) =>
    (await ok<{ structure: Derivation | null }>(await h.call(preparer, 'GET', `/v1/payroll/grade-structures/derivation?employeeId=${employeeId}&effectiveFrom=2026-02-01&annualCtc=${annualCtc}`))).structure;
  const amounts = (d: Derivation) => Object.fromEntries(d.lines.map((l) => [l.componentCode, l.amount]));

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(SALARY) });
    grade = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active) values ($1, 'GS1', 'Structured grade', true) returning id`, [A.id])).id;
    await head(h, configA, configB, { code: 'GS_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'GS_HRA', headType: 'EARNING', basis: 'FIXED', sequence: 2 });
    await head(h, configA, configB, { code: 'GS_PF_ER', headType: 'EMPLOYER_CONTRIBUTION', basis: 'FIXED', sequence: 3 });
    await head(h, configA, configB, { code: 'GS_CONV', headType: 'REIMBURSEMENT', basis: 'FIXED', sequence: 4 });
    await head(h, configA, configB, { code: 'GS_SPECIAL', headType: 'EARNING', basis: 'FIXED', sequence: 5 });
    await head(h, configA, configB, { code: 'GS_PF_EE', headType: 'DEDUCTION', basis: 'FIXED', sequence: 6 });
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('drafts a structure with one balancing earning on CTC heads, and refuses what cannot be one', async () => {
    expect((await draft(LINES.slice(0, 4))).json().error).toBe('BALANCE_LINE_REQUIRED');
    expect((await draft([...LINES, { componentCode: 'GS_PF_EE', method: 'FIXED_MONTHLY', amount: '1800' }])).json().error).toBe('STRUCTURE_HEAD_INVALID');
    expect((await draft([{ ...LINES[1], baseComponentCode: 'GS_CONV' }, ...LINES.slice(2)])).json().error).toBe('BASE_COMPONENT_INVALID');
    expect((await draft([{ ...LINES[0], percent: '120' }, ...LINES.slice(1)])).json().error).toBe('INVALID_PERCENT');
    expect((await draft(LINES, { gradeCode: 'NOPE' })).json().error).toBe('UNKNOWN_GRADE');
    expect((await draft(LINES, { currencyCode: 'XYZ' })).json().error).toBe('UNSUPPORTED_CURRENCY');
    const s = await ok<Structure>(await draft(), 201);
    expect(s).toMatchObject({ state: 'DRAFT', revision: 1 });
    expect(s.lines.map((l) => [l.sequence, l.componentCode, l.method])).toEqual([
      [1, 'GS_BASIC', 'PERCENT_OF_CTC'],
      [2, 'GS_HRA', 'PERCENT_OF_COMPONENT'],
      [3, 'GS_PF_ER', 'PERCENT_OF_COMPONENT'],
      [4, 'GS_CONV', 'FIXED_MONTHLY'],
      [5, 'GS_SPECIAL', 'BALANCE'],
    ]);
    // Maker-checker: the author never activates it; the database holds that too.
    const self = await h.call(configA, 'POST', `/v1/payroll/grade-structures/${s.id}/activate`, { expectedVersion: s.version });
    expect([self.statusCode, self.json().error]).toEqual([403, 'SELF_APPROVAL']);
    await expect(h.db.query(`update grade_salary_structure set state = 'ACTIVE', activated_by = created_by, activated_at = now() where id = $1`, [s.id])).rejects.toThrow(/grade_salary_structure_check/);
    expect((await ok<Structure>(await h.call(configB, 'POST', `/v1/payroll/grade-structures/${s.id}/activate`, { expectedVersion: s.version }))).state).toBe('ACTIVE');
    // Its rules are fixed once in effect.
    await expect(h.db.query(`update grade_salary_structure_line set percent = 41 where structure_id = $1 and sequence = 1`, [s.id])).rejects.toThrow(/never changed or removed/);
  });

  it('derives the components of a CTC exactly: lines rounded half-up, the balance taking what is left, gross without employer cost', async () => {
    const e = await person(h, A, hr, { gradeId: grade, joiningDate: '2026-01-05' });
    const round = (await derivation(e, '600000'))!;
    expect(round.monthlyCtc).toBe('50000.0000');
    expect(amounts(round)).toEqual({ GS_BASIC: '20000.0000', GS_HRA: '10000.0000', GS_PF_ER: '2400.0000', GS_CONV: '1600.0000', GS_SPECIAL: '16000.0000' });
    expect(round.monthlyGross).toBe('47600.0000');
    const odd = (await derivation(e, '500000'))!;
    expect(odd.monthlyCtc).toBe('41666.6700');
    expect(amounts(odd)).toEqual({ GS_BASIC: '16666.6700', GS_HRA: '8333.3400', GS_PF_ER: '2000.0000', GS_CONV: '1600.0000', GS_SPECIAL: '13066.6600' });
    expect(odd.monthlyGross).toBe('39666.6700');
    const low = await h.call(preparer, 'GET', `/v1/payroll/grade-structures/derivation?employeeId=${e}&effectiveFrom=2026-02-01&annualCtc=30000`);
    expect([low.statusCode, low.json().error, low.json().details]).toEqual([422, 'STRUCTURE_EXCEEDS_CTC', { monthlyCtc: '2500.0000', linesBeforeBalance: '3220.0000' }]);
    // No structure for an ungraded employee: components are entered as they are.
    expect(await derivation(await person(h, A, hr, { joiningDate: '2026-01-05' }), '600000')).toBeNull();
  });

  it('holds an arrangement of a structured grade to the derivation: the same components and gross, or a named refusal', async () => {
    const e = await person(h, A, hr, { gradeId: grade, joiningDate: '2026-01-05' });
    const arrangement = async (employeeId: string, monthlyGross: string) =>
      (await ok<{ id: string }>(await h.call(preparer, 'POST', `/v1/employees/${employeeId}/salary`, { effectiveFrom: '2026-02-01', annualCtc: '600000', monthlyGross, currency: 'INR' }), 201)).id;
    const set = (id: string, components: { componentCode: string; amount: string }[]) =>
      h.call(preparer, 'POST', `/v1/payroll/salary-arrangements/${id}/components`, { components: components.map((c) => ({ ...c, basis: 'MONTHLY' })) });
    const derived = [
      { componentCode: 'GS_BASIC', amount: '20000' },
      { componentCode: 'GS_HRA', amount: '10000' },
      { componentCode: 'GS_PF_ER', amount: '2400' },
      { componentCode: 'GS_CONV', amount: '1600' },
      { componentCode: 'GS_SPECIAL', amount: '16000' },
    ];
    const id = await arrangement(e, '47600');
    const off = await set(id, [...derived.slice(0, 4), { componentCode: 'GS_SPECIAL', amount: '15999.99' }]);
    expect([off.statusCode, off.json().error, off.json().details?.monthlyGross]).toEqual([422, 'STRUCTURE_MISMATCH', '47600.0000']);
    expect((await set(id, derived.slice(0, 4))).json().error).toBe('STRUCTURE_MISMATCH');
    expect((await set(id, derived)).statusCode).toBe(201);
    // A gross that is not the structure's is refused too.
    const other = await person(h, A, hr, { gradeId: grade, joiningDate: '2026-01-05' });
    expect((await set(await arrangement(other, '50000'), derived)).json().error).toBe('STRUCTURE_MISMATCH');
  });

  it('keeps CTC categories as a company list recorded on an arrangement and filters the salary master by them (E08)', async () => {
    const category = await ok<{ code: string }>(await h.call(configA, 'POST', '/v1/payroll/ctc-categories', { code: 'staff', name: 'Staff CTC' }), 201);
    expect(category.code).toBe('STAFF');
    expect((await h.call(configA, 'POST', '/v1/payroll/ctc-categories', { code: 'STAFF', name: 'Again' })).statusCode).toBe(409);
    const e = await person(h, A, hr, { joiningDate: '2026-01-05' });
    const f = await person(h, A, hr, { joiningDate: '2026-01-05' });
    const body = { effectiveFrom: '2026-02-01', annualCtc: '360000', monthlyGross: '30000', currency: 'INR' };
    expect((await h.call(preparer, 'POST', `/v1/employees/${e}/salary`, { ...body, ctcCategoryCode: 'NOPE' })).json().error).toBe('UNKNOWN_CTC_CATEGORY');
    await ok(await h.call(preparer, 'POST', `/v1/employees/${e}/salary`, { ...body, ctcCategoryCode: 'STAFF' }), 201);
    await ok(await h.call(preparer, 'POST', `/v1/employees/${f}/salary`, body), 201);
    // The business date (the default day): both arrangements are in force; only the category's is listed.
    const listed = await ok<{ items: { employeeId: string; ctcCategory: string | null }[] }>(await h.call(preparer, 'GET', '/v1/salary-master?ctcCategory=STAFF&pageSize=100'));
    expect(listed.items.map((r) => r.employeeId)).toEqual([e]);
    expect(listed.items[0]!.ctcCategory).toBe('STAFF');
  });
});
