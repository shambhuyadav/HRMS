// Organisation chart (coverage CL-023 "Org Structure", under FR-001 and FR-003; org/chart.ts): the current reporting lines of everyone
// employed today whom the requester may list — HR the company, a manager their team (BR-026) — with each person's manager, department,
// location and designation; drafts and separated people are not on it. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
const ids: Record<string, string> = {};

const ref = async (category: string, code: string) =>
  (await h.one<{ id: string }>(`select id from reference_value where company_id = $1 and category = $2 and code = $3`, [A.id, category, code])).id;

async function employee(code: string, status: string, manager?: string) {
  const id = (
    await h.one<{ id: string }>(
      `insert into employee (company_id, employee_code, display_name, work_email, joining_date, employment_type_id, status_id, created_by)
       values ($1, $2, $3, $4, '2025-01-06', $5, $6, $7) returning id`,
      [A.id, code, `Person ${code}`, `${code.toLowerCase()}@example.invalid`, await ref('EMPLOYMENT_TYPE', 'PERMANENT'), await ref('EMPLOYEE_STATUS', status), SYSTEM_ACTOR_ID],
    )
  ).id;
  await h.db.query(
    `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, effective_from) values ($1, $2, $3, $4, $5, '2025-01-06')`,
    [A.id, id, A.dept, A.loc, A.desig],
  );
  if (manager) {
    await h.db.query(`insert into manager_assignment (company_id, employee_id, manager_employee_id, effective_from) values ($1, $2, $3, '2025-01-06')`, [A.id, id, ids[manager]]);
  }
  ids[code] = id;
  return id;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await employee('OC0', 'ACTIVE_CONFIRMED'); // the top
  await employee('OC1', 'ACTIVE_CONFIRMED', 'OC0'); // a manager
  await employee('OC2', 'ACTIVE_PROBATION', 'OC1');
  await employee('OC3', 'NOTICE', 'OC1');
  await employee('OC4', 'ACTIVE_CONFIRMED', 'OC0'); // another branch
  await employee('OC5', 'DRAFT', 'OC1'); // not employed yet
  await employee('OC6', 'INACTIVE_SEPARATED', 'OC1'); // gone
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

const chartOf = async (a: TestActor) => {
  const res = await h.call(a, 'GET', '/v1/org/chart');
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { asOf: string; truncated: boolean; items: { id: string; code: string; name: string; managerId: string | null; designation: string | null; department: string | null }[] };
};

describe('organisation chart (FR-001, FR-003; coverage CL-023)', () => {
  it('FR-003 HR sees everyone employed today with their manager; drafts and separated people are left out', async () => {
    const chart = await chartOf(hr);
    const mine = chart.items.filter((n) => n.code.startsWith('OC'));
    expect(mine.map((n) => n.code).sort()).toEqual(['OC0', 'OC1', 'OC2', 'OC3', 'OC4']);
    const by = Object.fromEntries(mine.map((n) => [n.code, n]));
    expect(by.OC0!.managerId).toBeNull();
    expect(by.OC1!.managerId).toBe(ids.OC0);
    expect(by.OC2!.managerId).toBe(ids.OC1);
    expect(by.OC3!.managerId).toBe(ids.OC1);
    expect(by.OC4!.managerId).toBe(ids.OC0);
    expect(by.OC2!.designation).toBeTruthy();
    expect(chart.truncated).toBe(false);
    expect(chart.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('BR-026 a manager sees only their own team on the chart', async () => {
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: ids.OC1! });
    const chart = await chartOf(manager);
    const codes = chart.items.map((n) => n.code);
    expect(codes).toEqual(expect.arrayContaining(['OC2', 'OC3']));
    expect(codes).not.toContain('OC4');
    expect(codes).not.toContain('OC0');
  });

  it('FR-001 the chart is refused to a role that cannot list employees', async () => {
    const own = await h.actor(A, 'EMPLOYEE', { employeeId: ids.OC2! });
    const res = await h.call(own, 'GET', '/v1/org/chart');
    expect(res.statusCode).toBe(403);
  });
});
