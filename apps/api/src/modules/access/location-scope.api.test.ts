// LOCATION and DEPARTMENT plus LOCATION assignment filters (§5.1 "Company, location and department restrictions apply
// together"; BR-006; DB017 values OR within a dimension, dimensions AND; FR-066). Each place that applies a filter has its own
// implementation, so each is exercised: the row-scope predicate (list, detail, export), reviewer selection, hiring scope,
// employee creation and transfer, and holiday creation. Both dimensions must match the SAME current assignment. Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { approvedRequisition, hiringWorld } from '../hiring/test-fixtures.js';
import { isModuleActive } from '../registry.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let north: string;
let south: string;
const people: Record<string, string> = {};

// Who sits where: hq/north/south name the location, eng/fin the department.
const place = async (name: string, departmentId: string, locationId: string) => {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId, locationId, displayName: `Scope ${name} (synthetic)` }));
  expect(res.statusCode, res.body).toBe(201);
  await h.setStatus(A, res.json().id, 'ACTIVE_CONFIRMED');
  people[name] = res.json().id;
};
const listed = async (a: TestActor) => {
  const res = await h.call(a, 'GET', '/v1/employees?pageSize=100&search=Scope');
  expect(res.statusCode, res.body).toBe(200);
  const ids = (res.json().items as { id: string }[]).map((i) => i.id);
  return Object.keys(people).filter((name) => ids.includes(people[name]!)).sort();
};
const opens = async (a: TestActor, name: string) => (await h.call(a, 'GET', `/v1/employees/${people[name]}`)).statusCode;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const location = async (code: string) => (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  north = await location('NORTH');
  south = await location('SOUTH');
  await place('engNorth', A.dept, north);
  await place('engSouth', A.dept, south);
  await place('finNorth', A.financeDept, north);
  await place('finSouth', A.financeDept, south);
  await place('engHq', A.dept, A.loc);
});

afterAll(async () => {
  await h?.stop();
});

describe('the row-scope predicate: list, detail and export', () => {
  it('LOCATION only: the list and detail hold that location, in every department', async () => {
    const a = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: north });
    expect(await listed(a)).toEqual(['engNorth', 'finNorth']);
    expect(await opens(a, 'engNorth')).toBe(200);
    expect(await opens(a, 'finNorth')).toBe(200);
    expect(await opens(a, 'engSouth')).toBe(404);
  });

  it('values within LOCATION combine with OR', async () => {
    const a = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: [north, south] });
    expect(await listed(a)).toEqual(['engNorth', 'engSouth', 'finNorth', 'finSouth']);
    expect(await opens(a, 'engHq')).toBe(404);
  });

  it('DEPARTMENT and LOCATION combine with AND', async () => {
    const a = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept, locationFilter: north });
    expect(await listed(a)).toEqual(['engNorth']);
    expect(await opens(a, 'engNorth')).toBe(200);
    expect(await opens(a, 'engSouth')).toBe(404); // right department, wrong location
    expect(await opens(a, 'finNorth')).toBe(404); // right location, wrong department
  });

  it('both dimensions must match the same current assignment, not one each from different periods', async () => {
    // In engineering at SOUTH until 1 March, then in finance at NORTH: engineering AND north never held together.
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.dept, locationId: south, joiningDate: '2026-01-05', displayName: 'Mover (synthetic)' }));
    const mover = res.json().id as string;
    expect((await h.call(hr, 'POST', `/v1/employees/${mover}/assignment`, { departmentId: A.financeDept, locationId: north, designationId: A.desig, effectiveFrom: '2026-03-01' })).statusCode).toBe(200);
    const crossing = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept, locationFilter: north });
    expect((await h.call(crossing, 'GET', `/v1/employees/${mover}`)).statusCode).toBe(404);
    // Only the current period counts: its former location gives no access either.
    const former = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: south });
    expect((await h.call(former, 'GET', `/v1/employees/${mover}`)).statusCode).toBe(404);
    const current = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept, locationFilter: north });
    expect((await h.call(current, 'GET', `/v1/employees/${mover}`)).statusCode).toBe(200);
  });

  it('another role of the same user lends no scope (BR-006): each assignment answers for itself', async () => {
    const user = await h.makeUser();
    const wide = await h.actor(A, 'HR_ADMINISTRATOR', { user, locationFilter: north });
    const narrow = await h.actor(A, 'AUDITOR', { user, locationFilter: south });
    expect(await listed(wide)).toEqual(['engNorth', 'finNorth']);
    expect(await listed(narrow)).toEqual(['engSouth', 'finSouth']);
  });

  it('the export holds exactly what the list holds (BR-026, FR-007)', async () => {
    const a = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept, locationFilter: north });
    const requested = await h.call(a, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER', filters: { search: 'Scope' } });
    expect(requested.statusCode, requested.body).toBe(202);
    await processReportQueue(h.pool);
    const download = await h.call(a, 'GET', `/v1/reports/${requested.json().id}/download`);
    expect(download.statusCode, download.body).toBe(200);
    const rows = csvTable(download.body).trim().split(/\r?\n/).slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Scope engNorth (synthetic)');
  });
});

describe('creating and transferring (employee service)', () => {
  it('creation must land inside the location filter, and inside both filters', async () => {
    const a = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: north });
    expect((await h.call(a, 'POST', '/v1/employees', h.newEmployeeBody(A, { locationId: south }))).statusCode).toBe(403);
    expect((await h.call(a, 'POST', '/v1/employees', h.newEmployeeBody(A, { locationId: north }))).statusCode).toBe(201);

    const both = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept, locationFilter: north });
    expect((await h.call(both, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.dept, locationId: south }))).statusCode).toBe(403);
    expect((await h.call(both, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.financeDept, locationId: north }))).statusCode).toBe(403);
    expect((await h.call(both, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.dept, locationId: north }))).statusCode).toBe(201);
  });

  it('a transfer cannot move anyone out of the filter or reach anyone outside it', async () => {
    const a = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: north });
    const move = (who: string, locationId: string, effectiveFrom: string) =>
      h.call(a, 'POST', `/v1/employees/${who}/assignment`, { departmentId: A.dept, locationId, designationId: A.desig, effectiveFrom });
    const mine = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { locationId: north }))).json().id as string;
    expect((await move(mine, south, '2026-04-01')).statusCode).toBe(403);
    expect((await move(mine, north, '2026-04-01')).statusCode).toBe(200);
    expect((await move(people.engSouth!, north, '2026-04-01')).statusCode).toBe(404);
  });
});

describe('reviewer selection (workflow engine)', () => {
  const setList = (reviewers: TestActor[]) => h.call(hr, 'PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: reviewers.map((r, i) => ({ userId: r.user, priority: i + 1 })) });
  const request = async (name: string) => {
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: people[name]! });
    return h.call(employee, 'POST', '/v1/me/profile-changes', { displayName: `Renamed ${uniq('S')} (synthetic)` });
  };
  const tasks = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/profile-changes/tasks/mine')).json().items as unknown[]).length;

  it('skips a reviewer whose LOCATION filter misses the employee, and takes one whose filter holds it', async () => {
    const northOnly = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: north });
    const southOnly = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: south });
    expect((await setList([northOnly, southOnly])).statusCode).toBe(200);
    expect((await request('finSouth')).statusCode).toBe(201);
    expect(await tasks(northOnly)).toBe(0);
    expect(await tasks(southOnly)).toBe(1);
  });

  it('a DEPARTMENT and LOCATION reviewer needs both on the same assignment', async () => {
    const both = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept, locationFilter: north });
    const fallback = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await setList([both, fallback])).statusCode).toBe(200);
    expect((await request('engSouth')).statusCode).toBe(201); // right department, wrong location
    expect(await tasks(both)).toBe(0);
    expect(await tasks(fallback)).toBe(1);
    expect((await request('engNorth')).statusCode).toBe(201);
    expect(await tasks(both)).toBe(1);
  });

  it('refuses to route when no listed reviewer holds the employee', async () => {
    const northOnly = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: north });
    expect((await setList([northOnly])).statusCode).toBe(200);
    const res = await request('engHq');
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(await tasks(northOnly)).toBe(0);
  });
});

describe('holiday creation', () => {
  const holiday = (a: TestActor, locationId: string, holidayDate: string) => h.call(a, 'POST', '/v1/holidays', { locationId, holidayDate, name: 'Synthetic holiday' });

  it('a location filter admits its own location only; a department filter cannot maintain a location calendar', async () => {
    const a = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: north });
    expect((await holiday(a, south, '2026-08-03')).statusCode).toBe(403);
    expect((await holiday(a, north, '2026-08-03')).statusCode).toBe(201);
    const twoPlaces = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: [north, south] });
    expect((await holiday(twoPlaces, south, '2026-08-04')).statusCode).toBe(201);

    const both = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept, locationFilter: north });
    expect((await holiday(both, north, '2026-08-05')).statusCode).toBe(403);
    const dept = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await holiday(dept, north, '2026-08-06')).statusCode).toBe(403);
  });
});

describe.runIf(isModuleActive('hiring'))('hiring scope: budget, requisition and candidate', () => {
  let northOnly: TestActor;
  let southOnly: TestActor;
  let financeNorth: TestActor;
  let requisitionId: string;

  // Raising a requisition needs an actor linked to an active employee; named apart from the 'Scope' people the list tests count.
  const linkedActor = async (filters: { departmentFilter?: string; locationFilter?: string }) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: 'Hiring actor (synthetic)' }))).json().id as string;
    await h.setStatus(A, e, 'ACTIVE_CONFIRMED');
    return { actor: await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: e, ...filters }), employeeId: e };
  };
  const budget = (a: TestActor, departmentId: string, locationId: string) =>
    h.call(a, 'POST', '/v1/hiring/budgets', { departmentId, locationId, designationId: A.desig, periodStart: '2027-01-01', periodEnd: '2027-12-31', headcount: 1, reason: `Synthetic plan ${uniq('p')}` });
  const requisition = (a: TestActor, requester: string, departmentId: string, locationId: string) =>
    h.call(a, 'POST', '/v1/hiring/requisitions', {
      title: 'Synthetic platform engineer',
      departmentId,
      locationId,
      designationId: A.desig,
      employmentType: 'PERMANENT',
      vacancies: 1,
      reasonType: 'NEW',
      reason: 'Synthetic team growth',
      skills: ['TypeScript'],
      targetDate: '2027-06-01',
      hiringManagerId: requester,
    });

  beforeAll(async () => {
    northOnly = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: north });
    southOnly = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: south });
    financeNorth = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept, locationFilter: north });
  });

  it('a budget is created and read only inside the filter, on both dimensions', async () => {
    const created = await budget(hr, A.dept, north);
    expect(created.statusCode, created.body).toBe(201);
    const { budgetId } = created.json() as { budgetId: string };
    expect((await budget(northOnly, A.dept, south)).statusCode).toBe(403);
    expect((await h.call(northOnly, 'GET', `/v1/hiring/budgets/${budgetId}`)).statusCode).toBe(200);
    expect((await h.call(southOnly, 'GET', `/v1/hiring/budgets/${budgetId}`)).statusCode).toBe(404);
    expect((await h.call(financeNorth, 'GET', `/v1/hiring/budgets/${budgetId}`)).statusCode).toBe(404); // right location, wrong department
  });

  it('a requisition is raised and read only inside the filter, on both dimensions', async () => {
    const { actor, employeeId } = await linkedActor({ locationFilter: north });
    expect((await requisition(actor, employeeId, A.dept, south)).statusCode).toBe(403);
    const created = await requisition(actor, employeeId, A.dept, north);
    expect(created.statusCode, created.body).toBe(201);
    requisitionId = created.json().id;
    expect((await h.call(northOnly, 'GET', `/v1/hiring/requisitions/${requisitionId}`)).statusCode).toBe(200);
    expect((await h.call(southOnly, 'GET', `/v1/hiring/requisitions/${requisitionId}`)).statusCode).toBe(404);
    expect((await h.call(financeNorth, 'GET', `/v1/hiring/requisitions/${requisitionId}`)).statusCode).toBe(404);

    const both = await linkedActor({ departmentFilter: A.dept, locationFilter: north });
    expect((await requisition(both.actor, both.employeeId, A.financeDept, north)).statusCode).toBe(403);
    expect((await requisition(both.actor, both.employeeId, A.dept, south)).statusCode).toBe(403);
    expect((await requisition(both.actor, both.employeeId, A.dept, north)).statusCode).toBe(201);
  });

  it('a candidate follows the requisitions they applied to; one with no application stays in the open register', async () => {
    const candidate = (await h.call(hr, 'POST', '/v1/hiring/candidates', { fullName: 'Synthetic Candidate', sourceCode: 'DIRECT', skills: ['SQL'], consentStatus: 'GIVEN', consentRecordedOn: '2026-01-05', retainUntil: null })).json() as { id: string };
    expect((await h.call(southOnly, 'GET', `/v1/hiring/candidates/${candidate.id}`)).statusCode).toBe(200);

    // Candidates apply only to an approved requisition.
    const approved = await approvedRequisition(h, A, await hiringWorld(h, A), { locationId: north });
    const applied = await h.call(hr, 'POST', `/v1/hiring/requisitions/${approved.id}/applications`, { candidateId: candidate.id });
    expect(applied.statusCode, applied.body).toBeLessThan(300);
    expect((await h.call(northOnly, 'GET', `/v1/hiring/candidates/${candidate.id}`)).statusCode).toBe(200);
    expect((await h.call(southOnly, 'GET', `/v1/hiring/candidates/${candidate.id}`)).statusCode).toBe(404);
    expect((await h.call(financeNorth, 'GET', `/v1/hiring/candidates/${candidate.id}`)).statusCode).toBe(404);
  });
});
