// The status history baseline of migration 0101 for employees that existed before it (FR-006; BR-002). A new database has no
// such rows when the migration runs, so this runs the migration's own statement over real records. It has a file of its own
// because that statement writes a row for every employee in the database. Synthetic data.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { separateDueExits } from '../lifecycle/exit.js';
import { addDays, key, today as businessDate } from '../lifecycle/lifecycle.fixtures.js';
import { isModuleActive } from '../registry.js';

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), '../../../../../db/migrations/0101_employee_status_history.sql');
const baselineStatement = () => {
  const match = /insert into employee_status_history \(company_id, employee_id, status_id, effective_date, source_kind, actor_user_id, recorded_at\)[\s\S]*?limit 1\) x on true;/.exec(readFileSync(MIGRATION, 'utf8'));
  if (!match) throw new Error('The baseline statement of 0101 was not found');
  return match[0];
};

let h: Harness;
let A: Company;
let hr: TestActor;
let today: string;

const create = async (overrides: Record<string, unknown> = {}) => {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides));
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  today = await businessDate(h, A);
});

afterAll(async () => {
  await h?.stop();
});

describe('status history baseline for existing employees (0101)', () => {
  it('records each current status once, dated by the record that shows when it applied', async () => {
    const draft = await create({ joiningDate: '2026-02-02' });
    const futureDraft = await create({ joiningDate: addDays(today, 40) });
    const probation = await create({ joiningDate: '2026-02-03' });
    await h.setStatus(A, probation, 'ACTIVE_PROBATION');
    const confirmed = await create({ joiningDate: '2026-02-04' });
    await h.setStatus(A, confirmed, 'ACTIVE_CONFIRMED');
    await h.db.query(`update employee set confirmation_date = '2026-06-15' where id = $1`, [confirmed]);
    const confirmedNoDate = await create({ joiningDate: '2026-02-05' });
    await h.setStatus(A, confirmedNoDate, 'ACTIVE_CONFIRMED');
    const separatedNoExit = await create({ joiningDate: '2026-02-06' });
    await h.setStatus(A, separatedNoExit, 'INACTIVE_SEPARATED');

    // A real exit, so the dates come from a real exit case: one left on notice, one separated.
    const expected: Record<string, string> = {
      [draft]: '2026-02-02',
      [futureDraft]: today,
      [probation]: '2026-02-03',
      [confirmed]: '2026-06-15',
      [confirmedNoDate]: '2026-02-05',
      [separatedNoExit]: today,
    };
    if (isModuleActive('lifecycle')) {
      const managerId = await create({ displayName: 'Manager (synthetic)' });
      await h.setStatus(A, managerId, 'ACTIVE_CONFIRMED');
      const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerId });
      expect((await h.call(hr, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
      const leaver = async (lwd: string) => {
        const id = await create({ displayName: 'Leaver (synthetic)' });
        await h.setStatus(A, id, 'ACTIVE_CONFIRMED');
        expect((await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
        const actor = await h.actor(A, 'EMPLOYEE', { employeeId: id });
        const exitId = (await h.call(actor, 'POST', '/v1/me/resignation', { reason: 'Synthetic personal reason', proposedLastWorkingDate: lwd })).json().exitCaseId as string;
        const taskOf = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/exit-cases/tasks/mine')).json().items as { taskId: string; exitCase: { id: string } | null }[]).find((t) => t.exitCase?.id === exitId)!;
        expect((await h.call(manager, 'POST', `/v1/exit-cases/tasks/${(await taskOf(manager)).taskId}/recommend`, { recommendedLastWorkingDate: lwd, idempotencyKey: key() })).statusCode).toBeLessThan(300);
        const decided = await h.call(hr, 'POST', `/v1/exit-cases/tasks/${(await taskOf(hr)).taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key() });
        expect(decided.json().state, decided.body).toBe('APPROVED');
        return id;
      };
      const separatedLwd = addDays(today, 3);
      const separated = await leaver(separatedLwd);
      expect(await separateDueExits(h.pool, A.id, addDays(separatedLwd, 1), await h.makeUser())).toMatchObject({ separated: 1 });
      expected[separated] = addDays(separatedLwd, 1);
      expected[await leaver(addDays(today, 30))] = today;
    }

    // As before the migration: no history at all, then the migration's statement.
    await h.db.query(`alter table employee_status_history disable trigger employee_status_history_append_only`);
    await h.db.query(`delete from employee_status_history`);
    await h.db.query(`alter table employee_status_history enable trigger employee_status_history_append_only`);
    await h.db.query(baselineStatement());

    const rows = (
      await h.db.query<{ employee_id: string; effective_date: string; source_kind: string; prior_status_id: string | null; status_matches: boolean }>(
        `select b.employee_id, b.effective_date::text as effective_date, b.source_kind, b.prior_status_id, b.status_id = e.status_id as status_matches
           from employee_status_history b join employee e on e.id = b.employee_id where b.company_id = $1`,
        [A.id],
      )
    ).rows;
    const employees = (await h.one<{ n: number }>(`select count(*)::int as n from employee where company_id = $1`, [A.id])).n;
    expect(rows).toHaveLength(employees);
    expect(rows.every((r) => r.source_kind === 'BASELINE' && r.prior_status_id === null && r.status_matches)).toBe(true);
    const byEmployee = new Map(rows.map((r) => [r.employee_id, r.effective_date]));
    for (const [employeeId, date] of Object.entries(expected)) expect(byEmployee.get(employeeId), employeeId).toBe(date);

    // The next status change simply follows it.
    await h.setStatus(A, probation, 'ACTIVE_CONFIRMED');
    const history = (await h.call(hr, 'GET', `/v1/employees/${probation}/history`)).json().statuses as { status: string; sourceKind: string }[];
    expect(history.map((s) => [s.status, s.sourceKind])).toEqual([
      ['ACTIVE_PROBATION', 'BASELINE'],
      ['ACTIVE_CONFIRMED', 'DIRECT'],
    ]);
  });
});
