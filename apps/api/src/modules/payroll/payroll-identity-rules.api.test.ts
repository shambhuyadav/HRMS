// CI07 payroll identity and dates (BRD line 4542), the clauses payroll/lineage-guards.api.test.ts does not reach: the record's arrangement
// belongs to the record's employee and company and is the one applicable to the period; the supersedes link stays in the company;
// a component's company, and the sign and currency of money, agree. FR-062's salary line clause is proved on the same fixtures.
// Each refusal is a direct write, paired with a control where another guard could be the one answering. Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { calculate, calendar, CONFIG, createRun, grantOf, grants, head, laterArrangement, months, ok, person, PREPARE, record, SALARY, salary } from './payroll.fixtures.js';
import { calculateRun } from './runs.js';

const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

describe.runIf(isModuleActive('payroll'))('payroll identity and dates', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let periods: Record<string, string>;
  let dept: string;
  let mine: string;
  let myArrangement: string;
  let otherArrangement: string;
  let foreignArrangement: string;
  let foreignEmployee: string;
  let foreignComponent: string;
  let foreignRun: string;
  let calculated: { runId: string; recordId: string };
  /** A run with one record calculated and one left, so the snapshot guard lets a direct row through to the rule under test. */
  let open: { runId: string; recordId: string; component: string; extraComponent: string; extraHead: string };

  /** Runs `write` with the record guard off (it would refuse any later write to a record), so only the key under test can answer. */
  const pastRecordGuard = async <T>(write: () => Promise<T>) => {
    await h.db.query('begin');
    try {
      await h.db.query(`alter table payroll_record disable trigger payroll_record_guard`);
      return await write();
    } finally {
      await h.db.query('rollback');
    }
  };
  /** A write inside a transaction that is always undone; deferred checks never run. */
  const undone = async (write: () => Promise<pg.QueryResult>) => {
    await h.db.query('begin');
    try {
      return await write();
    } finally {
      await h.db.query('rollback');
    }
  };
  const attachArrangement = (recordId: string, arrangement: string) => h.db.query(`update payroll_record set salary_arrangement_id = $2 where id = $1`, [recordId, arrangement]);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    await head(h, configA, configB, { code: 'ID_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    const extraHead = await head(h, configA, configB, { code: 'ID_EXTRA', headType: 'EARNING', basis: 'FIXED', sequence: 2 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'IDENTITY', 'IDENTITY', true) returning id`, [A.id])).id;
    const staffed = async (amount: string) => {
      const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
      return { e, a: await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: amount, components: [{ code: 'ID_BASIC', amount }] }) };
    };
    const first = await staffed('30000');
    const second = await staffed('40000');
    mine = first.e;
    myArrangement = first.a;
    otherArrangement = second.a;

    // Another company, with a salary and a run of its own.
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const configB1 = await h.actor(B, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB2 = await h.actor(B, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const preparerB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    await head(h, configB1, configB2, { code: 'ID_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    const periodsB = (await calendar(h, configB1, configB2, months(2026))).periods;
    foreignEmployee = await person(h, B, hrB, { joiningDate: '2026-01-05' });
    foreignArrangement = await salary(h, preparerB, foreignEmployee, { effectiveFrom: '2026-01-05', monthlyGross: '50000', components: [{ code: 'ID_BASIC', amount: '50000' }] });
    foreignComponent = (await h.one<{ id: string }>(`select id from pay_component where company_id = $1 and code = 'ID_BASIC'`, [B.id])).id;
    foreignRun = (await createRun(h, preparerB, periodsB['2026-03']!)).id;

    const done = await createRun(h, preparer, periods['2026-03']!, { departmentIds: [dept] });
    await calculate(h, preparer, done.id);
    calculated = { runId: done.id, recordId: (await record(h, preparer, done.id, mine)).id };

    const partial = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [dept] });
    await calculateRun(h.pool, await grantOf(h, preparer, 'payroll_run', 'prepare', ['amount']), partial.id, { expectedVersion: partial.version }, { chunkSize: 1, maxChunks: 1 });
    const recordId = (await h.one<{ id: string }>(`select id from payroll_record where run_id = $1 limit 1`, [partial.id])).id;
    const component = (await h.one<{ id: string }>(`select id from pay_component where company_id = $1 and code = 'ID_BASIC'`, [A.id])).id;
    const extraComponent = (await h.one<{ id: string }>(`select id from pay_component where company_id = $1 and code = 'ID_EXTRA'`, [A.id])).id;
    open = { runId: partial.id, recordId, component, extraComponent, extraHead };
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('CI07, FR-062: a payroll record cannot name the salary arrangement of another employee or of another company', async () => {
    await pastRecordGuard(async () => {
      await h.db.query('savepoint own');
      expect((await attachArrangement(calculated.recordId, myArrangement)).rowCount).toBe(1);
      await h.db.query('rollback to savepoint own');
      await expect(attachArrangement(calculated.recordId, otherArrangement)).rejects.toMatchObject({ code: FK_VIOLATION });
    });
    await pastRecordGuard(async () => {
      await expect(attachArrangement(calculated.recordId, foreignArrangement)).rejects.toMatchObject({ code: FK_VIOLATION });
    });
    // The company key on its own: a record of company A cannot name an employee of company B either.
    await pastRecordGuard(async () => {
      await expect(h.db.query(`update payroll_record set employee_id = $2, salary_arrangement_id = $3 where id = $1`, [calculated.recordId, foreignEmployee, foreignArrangement])).rejects.toMatchObject({ code: FK_VIOLATION });
    });
  });

  it('CI07: a real calculation names the record’s own arrangement, and each segment the arrangement in force for its days; a later one is not used', async () => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    const early = await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'ID_BASIC', amount: '31000' }] });
    const mid = await laterArrangement(h, A, e, '2026-07-16', '62000', [{ code: 'ID_BASIC', amount: '62000' }]);
    const future = await laterArrangement(h, A, e, '2026-08-01', '93000', [{ code: 'ID_BASIC', amount: '93000' }]);
    const preview = await ok<{ scopeToken: string }>(await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId: periods['2026-07'], departmentIds: [dept] }));
    const run = await ok<{ id: string }>(await h.call(preparer, 'POST', '/v1/payroll/runs', { periodId: periods['2026-07'], departmentIds: [dept], scopeToken: preview.scopeToken }), 201);
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, e);
    const stored = await h.one<{ salary_arrangement_id: string; employee_id: string }>(`select salary_arrangement_id, employee_id from payroll_record where id = $1`, [r.id]);
    expect(stored).toEqual({ salary_arrangement_id: mid, employee_id: e });
    const segments = (await h.db.query<{ arrangement: string; from: string; to: string }>(
      `select salary_arrangement_id as arrangement, to_char(segment_start, 'YYYY-MM-DD') as from, to_char(segment_end, 'YYYY-MM-DD') as to from payroll_record_segment where record_id = $1 order by segment_start`,
      [r.id],
    )).rows;
    expect(segments).toEqual([
      { arrangement: early, from: '2026-07-01', to: '2026-07-15' },
      { arrangement: mid, from: '2026-07-16', to: '2026-07-31' },
    ]);
    expect(segments.map((s) => s.arrangement)).not.toContain(future);
    // 31000 x 15 / 31 + 62000 x 16 / 31 = 15000 + 32000.
    expect(r.earnings).toBe('47000.0000');
  });

  it('CI07: a revision cannot supersede a run of another company', async () => {
    const write = () =>
      h.db.query(
        `insert into payroll_run (id, company_id, calendar_id, period_id, lineage_id, revision, supersedes_run_id, transaction_id, state, scope_token, service_start, service_end, input_cutoff, payment_date,
                                  days_in_month, currency_code, currency_minor_unit, member_count, created_by, updated_by)
         select gen_random_uuid(), company_id, calendar_id, period_id, lineage_id, revision + 1, $2, gen_random_uuid(), 'DRAFT', scope_token, service_start, service_end, input_cutoff, payment_date,
                days_in_month, currency_code, currency_minor_unit, member_count, created_by, created_by from payroll_run where id = $1`,
        [calculated.runId, foreignRun],
      );
    await expect(write()).rejects.toThrow(/supersedes the previous revision of its own lineage, period and calendar/);
  });

  const line = (o: { company?: string; component?: string; amount?: string } = {}) =>
    h.db.query(
      `insert into payroll_line (company_id, record_id, component_id, head_revision_id, head_type, calculation_basis, amount, rule_version) values ($1, $2, $3, $4, 'EARNING', 'FIXED', $5, 'synthetic')`,
      [o.company ?? A.id, open.recordId, o.component ?? open.extraComponent, open.extraHead, o.amount ?? '1'],
    );

  it('CI07: a payroll line is of its own company’s component, and its amount is never negative', async () => {
    // Control: the same line, right company and positive, is accepted (and undone, so its deferred totals check never runs).
    expect((await undone(() => line())).rowCount).toBe(1);
    await expect(line({ component: foreignComponent })).rejects.toMatchObject({ code: FK_VIOLATION });
    await expect(line({ amount: '-1' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(h.db.query(`update payroll_record set net = 0 where id = $1`, [calculated.recordId])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // A deduction line is positive and subtracts: the sign comes from its type, so a record's own figures must agree.
    await pastRecordGuard(async () => {
      await expect(h.db.query(`update payroll_record set net = gross + 1 where id = $1`, [calculated.recordId])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('CI07: a salary in another currency than the payroll calendar is never calculated: the employee is blocked by name, with no figures', async () => {
    const dept2 = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'IDENTITY_FX', 'IDENTITY_FX', true) returning id`, [A.id])).id;
    const e = await person(h, A, hr, { departmentId: dept2, joiningDate: '2026-01-05' });
    // Foreign currency is disabled in wave 1 (DF06), so only a direct write can store this one.
    const usd = (await h.one<{ id: string }>(`insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code) values ($1, $2, '2026-01-05', 12000, 1000, 'USD') returning id`, [A.id, e])).id;
    await h.db.query(`insert into salary_component (company_id, salary_arrangement_id, component_id, amount, basis) values ($1, $2, $3, 1000, 'MONTHLY')`, [A.id, usd, open.component]);
    const run = await createRun(h, preparer, periods['2026-09']!, { departmentIds: [dept2] });
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, e);
    expect(r).toMatchObject({ calculationStatus: 'FAILED', net: null, earnings: null });
    expect(r.exceptions.map((x) => x.code)).toContain('CURRENCY_MISMATCH');
    expect(r.lines).toEqual([]);
  });

  // Direct writes the calculation would never make. The outer describe and these names deliberately do not state the identifier: the row
  // stays Blocked on the owner's valuation rule (docs/03 I-75 item 4), so nothing here may add to its evidence.
  const completeByHand = async (o: { laterArrangementFrom?: string; segmentCurrency?: string }) => {
    const waiting = await h.one<{ employee_id: string; employee_code: string; joining_date: string; arrangement: string }>(
      `select m.employee_id, e.employee_code, to_char(e.joining_date, 'YYYY-MM-DD') as joining_date, a.id as arrangement
         from payroll_run_member m join employee e on e.company_id = m.company_id and e.id = m.employee_id
         join salary_arrangement a on a.company_id = e.company_id and a.employee_id = e.id
        where m.lineage_id = $1 and not exists (select 1 from payroll_record r where r.run_id = $1 and r.employee_id = m.employee_id) limit 1`,
      [open.runId],
    );
    await h.db.query('begin');
    try {
      const arrangement = o.laterArrangementFrom ? await laterArrangement(h, A, waiting.employee_id, o.laterArrangementFrom, '1', []) : waiting.arrangement;
      const rec = await h.one<{ id: string }>(
        `insert into payroll_record (company_id, run_id, employee_id, employee_code, joining_date, status_code, calculation_status, currency_code, days_in_month)
         values ($1, $2, $3, $4, $5, 'ACTIVE_CONFIRMED', 'PENDING', 'INR', 30) returning id`,
        [A.id, open.runId, waiting.employee_id, waiting.employee_code, waiting.joining_date],
      );
      if (o.segmentCurrency) {
        await h.db.query(
          `insert into payroll_record_segment (company_id, record_id, employee_id, salary_arrangement_id, segment_start, segment_end, calendar_days, leave_lop_units, attendance_lop_units, paid_days, currency_code)
           values ($1, $2, $3, $4, '2026-04-01', '2026-04-30', 30, 0, 0, 30, $5)`,
          [A.id, rec.id, waiting.employee_id, arrangement, o.segmentCurrency],
        );
        // As if committed while the record was pending: what the segment's own write checks is over, so only the completion can answer.
        await h.db.query('set constraints all immediate');
      }
      await h.db.query(
        `update payroll_record set calculation_status = 'CALCULATED', salary_arrangement_id = $2, paid_units = 30, earnings = 0, reimbursements = 0, gross = 0, deductions = 0, net = 0, employer_contributions = 0 where id = $1`,
        [rec.id, arrangement],
      );
      await h.db.query('set constraints all immediate');
    } finally {
      await h.db.query('rollback');
    }
  };

  // 0172. A segment may differ from its record while the record has failed (the test above), so the guard is on a calculated record.
  it('a record cannot be completed by hand with a segment in another currency; in its own currency the same write goes through', async () => {
    await expect(completeByHand({ segmentCurrency: 'INR' })).resolves.toBeUndefined();
    await expect(completeByHand({ segmentCurrency: 'USD' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  // Possible only while the run is a draft: after that the snapshot guard refuses every segment, in any currency.
  it('a segment in another currency cannot be added to a record already calculated; in its own currency it can', async () => {
    const done = await h.one<{ calculation_status: string; employee_id: string; salary_arrangement_id: string }>(`select calculation_status, employee_id, salary_arrangement_id from payroll_record where id = $1`, [open.recordId]);
    expect(done.calculation_status).toBe('CALCULATED');
    const add = (currency: string) =>
      undone(async () => {
        await h.db.query(
          `insert into payroll_record_segment (company_id, record_id, employee_id, salary_arrangement_id, segment_start, segment_end, calendar_days, leave_lop_units, attendance_lop_units, paid_days, currency_code)
           values ($1, $2, $3, $4, '2099-01-01', '2099-01-01', 1, 0, 0, 1, $5)`,
          [A.id, open.recordId, done.employee_id, done.salary_arrangement_id, currency],
        );
        return h.db.query('set constraints all immediate');
      });
    await expect(add('INR')).resolves.toBeDefined();
    await expect(add('USD')).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  // A known gap: the calculation applies the valuation date, and nothing holds a direct write to it, because the BRD leaves that rule to the
  // owner. This it.fails passes only while the write is accepted. A passing it.fails counts as passed in the register, hence the name.
  it.fails('a record cannot be completed by hand with an arrangement not in force in its period (no guard: only the calculation applies the valuation date, and the BRD leaves that rule to the owner)', async () => {
    await expect(completeByHand({ laterArrangementFrom: '2026-11-01' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});
