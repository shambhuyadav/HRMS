// Payroll lineage and head binding at the database (CI07; DB036; DB038; BRD line 4542; line 81 "test direct data writes"). The
// service copies these values itself, so only a direct write can break them. Each refusal is paired with a control: the same
// write succeeds with that one guard removed, so it is this guard refusing and not another check. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../../../db/migrate.js';
import { startEmptyTestDatabase, type TestDatabase } from '../../../../../db/tests/test-database.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { calculate, calendar, CANCEL, CONFIG, createRun, getRun, grantOf, grants, head, months, ok, person, PREPARE, SALARY, salary } from './payroll.fixtures.js';
import { calculateRun } from './runs.js';

const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
const LINEAGE = /supersedes the previous revision of its own lineage, period and calendar/;
const COPIED = `scope_department_ids, scope_grade_ids, scope_location_ids, scope_token, service_start, service_end, input_cutoff, payment_date,
                days_in_month, currency_code, currency_minor_unit, member_count`;

describe('payroll lineage and head binding at the database (CI07 supersedes link and head binding)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let canceller: TestActor;
  let periods: Record<string, string>;
  let first: { id: string };
  let base: { id: string };
  let other: { id: string };
  let otherCalendar: { calendarId: string; periods: Record<string, string> };
  let heads: { basic: string; extra: string };
  let componentExtra: string;
  let snapshot: { record: string; segment: string; employee: string; input: string };

  /** A direct revision copied from `from`, with one thing changed. Everything is otherwise as the service writes it. */
  const insertRevision = (from: string, o: { id?: string; calendar?: string; period?: string; lineage?: string; revision?: number; supersedes?: string } = {}) =>
    h.db.query(
      `insert into payroll_run (id, company_id, calendar_id, period_id, lineage_id, revision, supersedes_run_id, transaction_id, state, ${COPIED}, created_by, updated_by)
       select coalesce($2::uuid, gen_random_uuid()), company_id, coalesce($3::uuid, calendar_id), coalesce($4::uuid, period_id), coalesce($5::uuid, lineage_id),
              coalesce($6::int, revision + 1), coalesce($7::uuid, id), gen_random_uuid(), 'DRAFT', ${COPIED}, created_by, created_by
         from payroll_run where id = $1`,
      [from, o.id ?? null, o.calendar ?? null, o.period ?? null, o.lineage ?? null, o.revision ?? null, o.supersedes ?? null],
    );

  /** Two new revisions, each superseding the other, written by one statement: the only way a cycle could ever form. */
  const insertCycle = () => {
    const [a, b] = [randomUUID(), randomUUID()];
    return h.db.query(
      `insert into payroll_run (id, company_id, calendar_id, period_id, lineage_id, revision, supersedes_run_id, transaction_id, state, ${COPIED}, created_by, updated_by)
       select x.id, r.company_id, r.calendar_id, r.period_id, r.lineage_id, x.revision, x.supersedes, gen_random_uuid(), 'DRAFT', ${COPIED.replace(/(\w+)/g, 'r.$1')}, r.created_by, r.created_by
         from (values ($1::uuid, $3::uuid, 3, $2::uuid), ($2::uuid, $4::uuid, 2, $1::uuid)) as x(id, from_run, revision, supersedes)
         join payroll_run r on r.id = x.from_run`,
      [a, b, base.id, other.id],
    );
  };

  /** The write succeeds once the named guard alone is gone. The whole attempt is undone, so nothing stays behind. */
  const succeedsWithout = async (guard: { table: string; trigger?: string; constraint?: string }, write: () => Promise<pg.QueryResult>) => {
    await h.db.query('begin');
    try {
      await h.db.query(guard.trigger ? `alter table ${guard.table} disable trigger ${guard.trigger}` : `alter table ${guard.table} drop constraint ${guard.constraint}`);
      expect((await write()).rowCount).toBeGreaterThan(0);
    } finally {
      await h.db.query('rollback');
    }
  };

  const insertLine = (component: string, headRevision: string, headType: string) =>
    h.db.query(
      `insert into payroll_line (company_id, record_id, component_id, head_revision_id, head_type, calculation_basis, amount, rule_version)
       values ($1, $2, $3, $4, $5, 'FIXED', 1, 'synthetic')`,
      [A.id, snapshot.record, component, headRevision, headType],
    );
  const insertComponent = (component: string, headRevision: string, headType: string) =>
    h.db.query(
      `insert into payroll_record_component (company_id, record_id, segment_id, component_id, amount, amount_basis, head_revision_id, head_type, calculation_basis)
       values ($1, $2, $3, $4, 1, 'MONTHLY', $5, $6, 'FIXED')`,
      [A.id, snapshot.record, snapshot.segment, component, headRevision, headType],
    );
  const insertInput = (component: string, headRevision: string, headType: string) =>
    h.db.query(
      `insert into payroll_record_input (company_id, record_id, employee_id, input_id, component_id, amount, currency_code, head_revision_id, head_type, calculation_basis)
       values ($1, $2, $3, $4, $5, 1, 'INR', $6, $7, 'FIXED')`,
      [A.id, snapshot.record, snapshot.employee, snapshot.input, component, headRevision, headType],
    );

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    canceller = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CANCEL });
    heads = {
      basic: await head(h, configA, configB, { code: 'LG_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 }),
      extra: await head(h, configA, configB, { code: 'LG_EXTRA', headType: 'EARNING', basis: 'FIXED', sequence: 2 }),
    };
    componentExtra = (await h.one<{ id: string }>(`select id from pay_component where company_id = $1 and code = 'LG_EXTRA'`, [A.id])).id;
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    otherCalendar = await calendar(h, configA, configB, months(2031));
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'LINEAGE', 'LINEAGE', true) returning id`, [A.id])).id;
    const staff: string[] = [];
    for (let i = 0; i < 2; i++) {
      const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
      await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'LG_BASIC', amount: '30000' }] });
      staff.push(e);
    }

    // April: revision 1 is returned to revision 2 by the service, which is then cancelled so no live revision or successor is in the way.
    const april = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [dept] });
    await calculate(h, preparer, april.id);
    const calculated = await getRun(h, preparer, april.id);
    first = { id: april.id };
    base = await ok<{ id: string; revision: number }>(await h.call(preparer, 'POST', `/v1/payroll/runs/${april.id}/revise`, { reason: 'Synthetic correction', expectedVersion: calculated.version }), 201);
    const second = await getRun(h, preparer, base.id);
    await ok(await h.call(canceller, 'POST', `/v1/payroll/runs/${base.id}/cancel`, { reason: 'Synthetic cancellation', expectedVersion: second.version }));

    // May: another lineage, also closed.
    const may = await createRun(h, preparer, periods['2026-05']!, { departmentIds: [dept] });
    other = { id: may.id };
    await ok(await h.call(canceller, 'POST', `/v1/payroll/runs/${may.id}/cancel`, { reason: 'Synthetic cancellation', expectedVersion: may.version }));

    // June: one chunk of two, so the revision is mid-calculation and the snapshot guard lets a direct row reach the binding.
    const june = await createRun(h, preparer, periods['2026-06']!, { departmentIds: [dept] });
    await calculateRun(h.pool, await grantOf(h, preparer, 'payroll_run', 'prepare', ['amount']), june.id, { expectedVersion: june.version }, { chunkSize: 1, maxChunks: 1 });
    const stored = await h.one<{ record: string; segment: string; employee: string }>(
      `select r.id as record, s.id as segment, r.employee_id as employee from payroll_record r join payroll_record_segment s on s.company_id = r.company_id and s.record_id = r.id where r.run_id = $1 limit 1`,
      [june.id],
    );
    await h.db.query(`set session_replication_role = replica`);
    const input = await h.one<{ id: string }>(
      `insert into payroll_input (company_id, batch_id, period_id, employee_id, component_id, input_kind_id, amount, currency_code, effective_date, source, reference, state)
       values ($1, $2, $3, $4, $5, $6, 1, 'INR', '2026-06-01', 'ENTRY', 'LG-1', 'APPROVED') returning id`,
      [A.id, randomUUID(), periods['2026-06'], stored.employee, componentExtra, randomUUID()],
    );
    await h.db.query(`set session_replication_role = origin`);
    snapshot = { ...stored, input: input.id };
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  const lineageGuard = { table: 'payroll_run', trigger: 'payroll_run_lineage_guard' };
  const refused = (write: () => Promise<pg.QueryResult>) => expect(write()).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(LINEAGE) });

  it('the service still opens a revision: the next number, its own lineage, period and calendar', async () => {
    const [one, two] = (await h.db.query<{ id: string; lineage_id: string; period_id: string; calendar_id: string; revision: number; supersedes_run_id: string | null }>(
      `select id, lineage_id, period_id, calendar_id, revision, supersedes_run_id from payroll_run where id = any($1::uuid[]) order by revision`,
      [[first.id, base.id]],
    )).rows;
    expect(two).toMatchObject({ revision: 2, supersedes_run_id: first.id, lineage_id: first.id, period_id: one!.period_id, calendar_id: one!.calendar_id });
  });

  it('refuses a revision of another period', async () => {
    const write = () => insertRevision(base.id, { period: periods['2026-07']! });
    await refused(write);
    await succeedsWithout(lineageGuard, write);
  });

  it('refuses a revision of another calendar, even with a period of that calendar', async () => {
    const write = () => insertRevision(base.id, { calendar: otherCalendar.calendarId, period: otherCalendar.periods['2031-04']! });
    await refused(write);
    await succeedsWithout(lineageGuard, write);
  });

  it('refuses a revision in another lineage', async () => {
    const write = () => insertRevision(base.id, { lineage: other.id });
    await refused(write);
    await succeedsWithout(lineageGuard, write);
  });

  it('refuses a skipped revision number', async () => {
    const skipped = () => insertRevision(base.id, { revision: 4 });
    await refused(skipped);
    await succeedsWithout(lineageGuard, skipped);
  });

  it('refuses a revision naming itself or a run that does not exist', async () => {
    const id = randomUUID();
    const itself = () => insertRevision(base.id, { id, supersedes: id });
    await refused(itself);
    await succeedsWithout(lineageGuard, itself);
    await refused(() => insertRevision(base.id, { supersedes: randomUUID() }));
  });

  it('refuses a cycle written by one statement (the only way one could form)', async () => {
    await refused(insertCycle);
    await succeedsWithout(lineageGuard, insertCycle);
  });

  for (const [table, write] of [
    ['payroll_line', () => insertLine],
    ['payroll_record_component', () => insertComponent],
    ['payroll_record_input', () => insertInput],
  ] as const) {
    describe(table, () => {
      const binding = { table, constraint: `${table}_head_binding` };
      const isRefused = (attempt: () => Promise<pg.QueryResult>) => expect(attempt()).rejects.toMatchObject({ code: FK_VIOLATION, constraint: `${table}_head_binding` });

      it('refuses a head revision of another component', async () => {
        const attempt = () => write()(componentExtra, heads.basic, 'EARNING');
        await isRefused(attempt);
        await succeedsWithout(binding, attempt);
      });

      it('refuses a type other than the head revision’s', async () => {
        const attempt = () => write()(componentExtra, heads.extra, 'REIMBURSEMENT');
        await isRefused(attempt);
        await succeedsWithout(binding, attempt);
      });

      it('accepts the component’s own head revision with its own type', async () => {
        await h.db.query('begin');
        try {
          expect((await write()(componentExtra, heads.extra, 'EARNING')).rowCount).toBe(1);
        } finally {
          await h.db.query('rollback');
        }
      });

      it('is fully validated on a database with no disagreeing rows', async () => {
        expect((await h.one<{ convalidated: boolean }>(`select convalidated from pg_constraint where conname = $1`, [`${table}_head_binding`])).convalidated).toBe(true);
      });
    });
  }

  it('a real calculation satisfies the binding end to end', async () => {
    const run = await createRun(h, preparer, periods['2026-08']!, {});
    expect((await calculate(h, preparer, run.id)).state).toBe('CALCULATED');
    const lines = await h.one<{ n: number }>(`select count(*)::int as n from payroll_line where company_id = $1 and record_id in (select id from payroll_record where run_id = $2)`, [A.id, run.id]);
    expect(lines.n).toBeGreaterThan(0);
  });
});

// Upgrade: stored rows that break the new rules never stop the migration, are never changed, and a clean table still validates.
describe('0140 on a database that already holds payroll rows', () => {
  let old: TestDatabase;
  let db: pg.Client;
  const company = randomUUID();
  const [c1, c2] = [randomUUID(), randomUUID()];
  const headRevision = randomUUID();
  const [run1, run2] = [randomUUID(), randomUUID()];

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0140' });
    await db.query(`set session_replication_role = replica`);
    await db.query(
      `insert into payroll_head_revision (id, company_id, component_id, revision, effective_from, in_use, head_type, calculation_basis, rounding_rule, tax_treatment_id, display_sequence, state, activated_by, activated_at)
       values ($1, $2, $3, 1, '2020-01-01', true, 'EARNING', 'FIXED', 'HALF_UP_MINOR_UNIT', $4, 1, 'ACTIVE', $5, now())`,
      [headRevision, company, c1, randomUUID(), randomUUID()],
    );
    // A line naming a head revision of another component, and a second revision whose first revision is in another period.
    await db.query(
      `insert into payroll_line (company_id, record_id, component_id, head_revision_id, head_type, calculation_basis, amount, rule_version) values ($1, $2, $3, $4, 'EARNING', 'FIXED', 1, 'old')`,
      [company, randomUUID(), c2, headRevision],
    );
    for (const [id, lineage, revision, supersedes, period] of [
      [run1, run1, 1, null, randomUUID()],
      [run2, run1, 2, run1, randomUUID()],
    ] as const) {
      await db.query(
        `insert into payroll_run (id, company_id, calendar_id, period_id, lineage_id, revision, supersedes_run_id, transaction_id, state, scope_token, service_start, service_end, input_cutoff,
                                  payment_date, days_in_month, currency_code, currency_minor_unit, member_count, closed_at, close_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'CANCELLED', repeat('a', 64), '2026-04-01', '2026-04-30', '2026-04-30', '2026-04-30', 30, 'INR', 2, 0, now(), 'Stored before 0140 (synthetic)')`,
        [id, company, randomUUID(), period, lineage, revision, supersedes, randomUUID()],
      );
    }
    await db.query(`set session_replication_role = origin`);
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  const validated = async (name: string) => (await db.query<{ convalidated: boolean }>(`select convalidated from pg_constraint where conname = $1`, [name])).rows[0]!.convalidated;

  it('applies, keeps the disagreeing stored rows and leaves only that table’s constraint unvalidated', async () => {
    expect((await db.query(`select 1 from schema_migration where filename like '0140%'`)).rowCount).toBe(1);
    expect((await db.query(`select 1 from payroll_line where company_id = $1 and component_id = $2`, [company, c2])).rowCount).toBe(1);
    expect((await db.query(`select 1 from payroll_run where company_id = $1`, [company])).rowCount).toBe(2);
    expect(await validated('payroll_line_head_binding')).toBe(false);
    expect(await validated('payroll_record_component_head_binding')).toBe(true);
    expect(await validated('payroll_record_input_head_binding')).toBe(true);
  });
});
