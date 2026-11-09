// FR-028 external deduction mapping and the PAYROLL_INPUTS_V2 import on the stored framework (decided under owner delegation, 6 Nov 2026;
// docs/03 I-91; migration 0213). An outside code maps, from a date, to a DEDUCTION head on the INPUT basis, drafted by one person and
// activated by another; inputs may name the code instead of the component, and an unknown, unmapped or retired code is refused by name.
// The V2 import checks every row as entry does and writes one input batch per period, all or nothing. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { calendar, CONFIG, grants, head, key, months, ok, person, PREPARE, SALARY, salary } from './payroll.fixtures.js';

interface Mapping {
  id: string;
  externalCode: string;
  componentCode: string;
  state: string;
  version: number;
}

describe('external deduction mapping and the V2 input import (FR-028, I-91)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let periods: Record<string, string>;
  let emp: { id: string; code: string };

  const draft = (a: TestActor, body: Record<string, unknown>) =>
    h.call(a, 'POST', '/v1/payroll/external-deductions', { name: 'Synthetic canteen', reason: 'Synthetic vendor agreement', effectiveFrom: '2026-01-01', ...body });
  const decide = (a: TestActor, m: { id: string; version: number }, action: string) => h.call(a, 'POST', `/v1/payroll/external-deductions/${m.id}/decision`, { action, expectedVersion: m.version });
  const mapped = async (externalCode: string, componentCode: string, effectiveFrom = '2026-01-01') => {
    const m = await ok<Mapping>(await draft(configA, { externalCode, componentCode, effectiveFrom }), 201);
    return ok<Mapping>(await decide(configB, m, 'ACTIVATE'));
  };
  const entry = (lines: Record<string, unknown>[]) =>
    h.call(preparer, 'POST', `/v1/payroll/periods/${periods['2026-12']}/input-batches`, { lines, idempotencyKey: key('xd-') });
  const line = (over: Record<string, unknown>) => ({
    employeeId: emp.id,
    inputKind: 'VARIABLE_PAYMENT',
    amount: '250.00',
    currencyCode: 'INR',
    effectiveDate: '2026-12-10',
    reference: uniq('XD-REF-'),
    ...over,
  });
  const errorsOf = async (lines: Record<string, unknown>[]) => (await entry(lines)).json().details?.errors?.map((e: { code: string }) => e.code);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    await head(h, configA, configB, { code: 'XD_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'XD_CANTEEN', headType: 'DEDUCTION', basis: 'INPUT', sequence: 2 });
    await head(h, configA, configB, { code: 'XD_SOCIETY', headType: 'DEDUCTION', basis: 'INPUT', sequence: 3 });
    await head(h, configA, configB, { code: 'XD_BONUS', headType: 'EARNING', basis: 'INPUT', sequence: 4 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    const id = await person(h, A, hr, { joiningDate: '2026-01-05' });
    await salary(h, preparer, id, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'XD_BASIC', amount: '30000' }] });
    emp = { id, code: (await h.one<{ employee_code: string }>(`select employee_code from employee where id = $1`, [id])).employee_code };
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('maps an outside code to a DEDUCTION input head, drafted by one person and activated by another', async () => {
    expect((await draft(configA, { externalCode: 'CANTEEN', componentCode: 'XD_BONUS' })).json().error).toBe('COMPONENT_HEAD_INVALID');
    expect((await draft(configA, { externalCode: 'CANTEEN', componentCode: 'XD_BASIC' })).json().error).toBe('COMPONENT_HEAD_INVALID');
    expect((await draft(configA, { externalCode: '1BAD', componentCode: 'XD_CANTEEN' })).json().error).toBe('INVALID_CODE');
    const m = await ok<Mapping>(await draft(configA, { externalCode: 'canteen', componentCode: 'XD_CANTEEN' }), 201);
    expect(m).toMatchObject({ externalCode: 'CANTEEN', componentCode: 'XD_CANTEEN', state: 'DRAFT' });
    expect((await decide(configA, m, 'ACTIVATE')).json().error).toBe('SELF_APPROVAL');
    await expect(h.db.query(`update payroll_external_deduction set state = 'ACTIVE', activated_by = created_by, activated_at = now() where id = $1`, [m.id])).rejects.toThrow(
      /payroll_external_deduction_check/,
    );
    expect((await ok<Mapping>(await decide(configB, m, 'ACTIVATE'))).state).toBe('ACTIVE');
    await expect(h.db.query(`update payroll_external_deduction set component_id = (select id from pay_component where code = 'XD_SOCIETY' and company_id = $2) where id = $1`, [m.id, A.id])).rejects.toThrow(
      /keeps its code, component/,
    );
  });

  it('an input names the outside code instead of the component, resolved on its date; unknown, unmapped and retired codes are refused by name', async () => {
    const res = await entry([line({ externalCode: 'CANTEEN' }), line({ componentCode: 'XD_SOCIETY' })]);
    expect(res.statusCode, res.body).toBe(201);
    const stored = (
      await h.db.query<{ code: string; external_code: string | null; amount: string }>(
        `select pc.code, i.external_code, i.amount::text from payroll_input i join pay_component pc on pc.id = i.component_id where i.batch_id = $1 order by pc.code`,
        [res.json().id],
      )
    ).rows;
    expect(stored).toEqual([
      { code: 'XD_CANTEEN', external_code: 'CANTEEN', amount: '250.0000' },
      { code: 'XD_SOCIETY', external_code: null, amount: '250.0000' },
    ]);
    expect(await errorsOf([line({ externalCode: 'NOPE' })])).toEqual(['EXTERNAL_CODE_UNKNOWN']);
    expect(await errorsOf([line({ externalCode: 'CANTEEN', componentCode: 'XD_CANTEEN' })])).toEqual(['COMPONENT_OR_EXTERNAL_CODE']);
    expect(await errorsOf([line({})])).toEqual(['COMPONENT_OR_EXTERNAL_CODE']);
    // A mapping that starts after the input's date is not in force on it.
    await mapped('SOCIETY', 'XD_SOCIETY', '2027-01-01');
    expect(await errorsOf([line({ externalCode: 'SOCIETY' })])).toEqual(['EXTERNAL_CODE_UNMAPPED']);
    // Retired, the code ends; no other component is ever assumed.
    const canteen = (await ok<{ items: Mapping[] }>(await h.call(configA, 'GET', '/v1/payroll/external-deductions'))).items.find((x) => x.externalCode === 'CANTEEN' && x.state === 'ACTIVE')!;
    expect((await ok<Mapping>(await decide(configB, canteen, 'RETIRE'))).state).toBe('RETIRED');
    expect(await errorsOf([line({ externalCode: 'CANTEEN' })])).toEqual(['EXTERNAL_CODE_RETIRED']);
  });

  it('imports PAYROLL_INPUTS_V2 through the stored framework: previewed, committed as one batch per period, all or nothing', async () => {
    await mapped('INSURANCE', 'XD_SOCIETY');
    const IMPORTS = '/v1/payroll/input-imports';
    const HEADER = 'period_code,employee_code,component_code,external_code,input_kind,amount,currency_code,effective_date,reference';
    const file = (rows: string[][]) => Buffer.from(`${HEADER}\r\n${rows.map((r) => r.join(',')).join('\r\n')}\r\n`).toString('base64');
    const upload = (rows: string[][]) => h.call(preparer, 'POST', IMPORTS, { fileName: 'inputs.csv', contentBase64: file(rows), idempotencyKey: key('v2-key-') });
    const r1 = uniq('V2-A-');
    const r2 = uniq('V2-B-');
    // One bad row (a retired code) rejects the whole file, with its reason; nothing is written.
    const bad = await upload([
      ['2026-12', emp.code, '', 'INSURANCE', 'VARIABLE_PAYMENT', '100.00', 'INR', '2026-12-05', r1],
      ['2026-12', emp.code, '', 'CANTEEN', 'VARIABLE_PAYMENT', '50.00', 'INR', '2026-12-05', r2],
    ]);
    expect(bad.statusCode, bad.body).toBe(201);
    // The valid row of a refused file is BATCH_REJECTED: nothing is applied in part (FR-064).
    expect((bad.json().rows as { rowNumber: number; errorCode: string | null }[]).map((r) => r.errorCode)).toEqual(['BATCH_REJECTED', 'EXTERNAL_CODE_RETIRED']);
    expect((await h.call(preparer, 'POST', `${IMPORTS}/${bad.json().id}/commit`)).statusCode).not.toBe(200);
    const good = await upload([
      ['2026-12', emp.code, '', 'insurance', 'VARIABLE_PAYMENT', '100.00', 'INR', '2026-12-05', r1],
      ['2026-12', emp.code.toLowerCase(), 'XD_SOCIETY', '', 'VARIABLE_PAYMENT', '75.50', 'INR', '2026-12-06', r2],
    ]);
    expect(good.json(), good.body).toMatchObject({ state: 'PREVIEWED', template: 'PAYROLL_INPUTS_V2', rowCount: 2 });
    // A preview writes nothing.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_input where reference = any($1::text[])`, [[r1, r2]])).n).toBe(0);
    const committed = await h.call(preparer, 'POST', `${IMPORTS}/${good.json().id}/commit`);
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 2 });
    const written = (
      await h.db.query<{ batch_id: string; code: string; external_code: string | null; amount: string; source: string }>(
        `select i.batch_id, pc.code, i.external_code, i.amount::text, i.source from payroll_input i join pay_component pc on pc.id = i.component_id
          where i.reference = any($1::text[]) order by i.reference`,
        [[r1, r2]],
      )
    ).rows;
    expect(written.map((w) => [w.code, w.external_code, w.amount, w.source])).toEqual([
      ['XD_SOCIETY', 'INSURANCE', '100.0000', 'UPLOAD'],
      ['XD_SOCIETY', null, '75.5000', 'UPLOAD'],
    ]);
    expect(new Set(written.map((w) => w.batch_id)).size).toBe(1);
    expect((await h.one<{ state: string }>(`select state from payroll_input_batch where id = $1`, [written[0]!.batch_id])).state).toBe('DRAFT');
  });
});
