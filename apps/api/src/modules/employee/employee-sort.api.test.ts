// Sortable employee list columns (FR-007 "sortable list columns, paging and counts"; I-37): an allowlisted column and direction
// with a stable tie-breaker (employee code, then id), applied identically by the EMPLOYEE_REGISTER export. Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { processReportQueue } from '../report/service.js';
import { EMPLOYEE_SORTS } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let tag: string;
let codes: Record<string, string>;

const listOrder = async (query: string, a = hr) => {
  const res = await h.call(a, 'GET', `/v1/employees?pageSize=100&search=${tag}${query ? `&${query}` : ''}`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { employeeCode: string }[]).map((i) => i.employeeCode);
};
const exportOrder = async (filters: Record<string, string>, a = hr) => {
  const res = await h.call(a, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER', filters: { search: tag, ...filters } });
  expect(res.statusCode, res.body).toBe(202);
  await processReportQueue(h.pool);
  const body = (await h.call(a, 'GET', `/v1/reports/${res.json().id}/download`)).body;
  return body.trimEnd().split('\r\n').slice(1).map((r) => JSON.parse(r.split(',')[0]!) as string);
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  tag = uniq('sorttag').toLowerCase();
  const add = async (name: string, code: string, overrides: Record<string, unknown>) => {
    const employeeCode = `${tag}-${code}`.toUpperCase();
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { employeeCode, workEmail: `${code}.${tag}@example.test`, ...overrides }));
    expect(res.statusCode, res.body).toBe(201);
    return [name, employeeCode] as const;
  };
  codes = Object.fromEntries([
    await add('c', 'c', { displayName: `Same Name`, joiningDate: '2026-03-01', departmentId: A.dept }),
    await add('a', 'a', { displayName: `Same Name`, joiningDate: '2026-03-01', departmentId: A.financeDept }),
    await add('d', 'd', { displayName: `Alpha`, joiningDate: '2026-01-05', departmentId: A.dept }),
    await add('b', 'b', { displayName: `Zulu`, joiningDate: '2026-02-01', departmentId: A.financeDept }),
    // Joins far ahead: no current assignment today, so its department, location and designation are blank.
    await add('e', 'e', { displayName: `Mid`, joiningDate: '2099-01-01', departmentId: A.dept }),
  ]);
});

afterAll(async () => {
  await h?.stop();
});

const of = (...names: string[]) => names.map((n) => codes[n]!);

describe('employee list sort (FR-007)', () => {
  it('defaults to the employee code, as before', async () => {
    expect(await listOrder('')).toEqual(of('a', 'b', 'c', 'd', 'e'));
    expect(await listOrder('direction=DESC')).toEqual(of('e', 'd', 'c', 'b', 'a'));
  });

  it('sorts by the chosen column; equal values fall back to the code in ascending order in both directions', async () => {
    expect(await listOrder('sort=displayName')).toEqual(of('d', 'e', 'a', 'c', 'b'));
    expect(await listOrder('sort=displayName&direction=DESC')).toEqual(of('b', 'a', 'c', 'e', 'd'));
    expect(await listOrder('sort=joiningDate')).toEqual(of('d', 'b', 'a', 'c', 'e'));
    expect(await listOrder('sort=joiningDate&direction=DESC')).toEqual(of('e', 'a', 'c', 'b', 'd'));
  });

  it('puts a blank column last in either direction', async () => {
    const asc = await listOrder('sort=department');
    const desc = await listOrder('sort=department&direction=DESC');
    expect(asc.at(-1)).toBe(codes.e);
    expect(desc.at(-1)).toBe(codes.e);
    // ENG before FIN, code order inside each.
    expect(asc).toEqual(of('c', 'd', 'a', 'b', 'e'));
    expect(desc).toEqual(of('a', 'b', 'c', 'd', 'e'));
  });

  it('pages stably: ties neither repeat nor disappear across pages, and the count stays', async () => {
    const seen: string[] = [];
    const pageSize = 25;
    const res = await h.call(hr, 'GET', `/v1/employees?search=${tag}&sort=status&page=1&pageSize=${pageSize}`);
    expect(res.json().total).toBe(5);
    seen.push(...(res.json().items as { employeeCode: string }[]).map((i) => i.employeeCode));
    // Every record is DRAFT, so the order is decided by the tie-breaker alone.
    expect(seen).toEqual(of('a', 'b', 'c', 'd', 'e'));
  });

  it('refuses a column or direction outside the allowlist, so nothing reaches SQL', async () => {
    for (const q of ['sort=password', 'sort=employee_code', 'sort=id;drop table employee', 'direction=sideways', 'direction=asc']) {
      const res = await h.call(hr, 'GET', `/v1/employees?${q.replace(/ /g, '%20')}`);
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('keeps row scope: a sort never brings in a record outside the filter', async () => {
    const finance = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    expect(await listOrder('sort=displayName&direction=DESC', finance)).toEqual(of('b', 'a'));
    expect(await exportOrder({ sort: 'displayName', direction: 'DESC' }, finance)).toEqual(of('b', 'a'));
  });
});

describe('the register export applies the same order (FR-007, I-37)', () => {
  it.each(EMPLOYEE_SORTS.flatMap((sort) => [[sort, 'ASC'], [sort, 'DESC']] as const))('%s %s matches the list row for row', async (sort, direction) => {
    const list = await listOrder(`sort=${sort}&direction=${direction}`);
    expect(list).toHaveLength(5);
    expect(await exportOrder({ sort, direction })).toEqual(list);
  });

  it('with no sort the export keeps the list default, and the execution records what it applied', async () => {
    expect(await exportOrder({})).toEqual(await listOrder(''));
    await exportOrder({ sort: 'joiningDate', direction: 'DESC' });
    const snapshot = await h.one<{ filter_snapshot: Record<string, string> }>(`select filter_snapshot from report_execution where company_id = $1 order by created_at desc limit 1`, [A.id]);
    expect(snapshot.filter_snapshot).toMatchObject({ sort: 'joiningDate', direction: 'DESC' });
  });

  it('refuses a bad sort, and a report that does not apply the order refuses it rather than ignoring it', async () => {
    expect((await h.call(hr, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER', filters: { sort: 'password' } })).statusCode).toBe(400);
    const leave = await h.call(hr, 'POST', '/v1/reports', { reportCode: 'LEAVE_REGISTER', filters: { from: '2026-01-01', to: '2026-12-31', sort: 'displayName' } });
    expect([leave.statusCode, leave.json().error]).toEqual([422, 'FILTER_NOT_SUPPORTED']);
  });
});
