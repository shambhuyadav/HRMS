// DF03 "Rejected requests are terminal; a new request links to the rejected predecessor" (FR-026; FR-027; FR-059; FR-074; CI02; 0125),
// for each request kind a person raises for themselves: the link is optional, named at creation, shown in the own request list and in
// the kind's own list, and refused unless it names the caller's own rejected request of the same kind with no live successor.
// The database holds the same rules for a writer that goes round the service. Synthetic data; a fixed past Tuesday for attendance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let colleague: TestActor;
let employeeEmp: string;
let record: { id: string };
let colleagueRecord: { id: string };

const TUE = '2026-03-03';
let nextMonday = 21;
const mondayAhead = () => {
  nextMonday += 7;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + nextMonday);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const created = (res: { statusCode: number; body: string; json(): { requestId?: string; claimId?: string } }) => {
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return (body.requestId ?? body.claimId)!;
};
const reject = async (a: TestActor, path: string, transactionId: string) => {
  const tasks = (await h.call(a, 'GET', path)).json().items as { taskId: string; transactionId: string }[];
  const task = tasks.find((t) => t.transactionId === transactionId);
  expect(task, `no task on ${path}`).toBeDefined();
  const url = path.endsWith('/mine') ? path.replace('/mine', `/${task!.taskId}/decision`) : `${path}/${task!.taskId}/decision`;
  const res = await h.call(a, 'POST', url, { decision: 'REJECT', reason: 'Synthetic rejection', idempotencyKey: uniq('pred-key-') });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().state).toBe('REJECTED');
};
const expenseLine = async (a: TestActor) => {
  const uploaded = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic predecessor receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  return { category: 'OTHER', expenseDate: day, merchant: 'Synthetic Merchant', grossAmount: '90', claimedAmount: '90', description: 'Synthetic line', receipt: { receiptId: uploaded.json().receiptId } };
};

/** What differs by kind: how a new request is raised (optionally following another), and where it is decided and listed. */
interface Kind {
  name: string;
  kind: string;
  root: string;
  raise(a: TestActor, predecessorRequestId?: string): Promise<{ statusCode: number; body: string; json(): { requestId?: string; claimId?: string; error?: string } }>;
  /** Submits a claim raised as a draft; every other kind is submitted when raised. */
  submit?(a: TestActor, id: string): Promise<void>;
  reviewer(): TestActor;
  tasks: string;
  list: (employeeId: string) => string;
}

const KINDS: Kind[] = [
  {
    name: 'leave',
    kind: 'leave_request',
    root: 'leave_request',
    raise: (a, predecessorRequestId) => {
      const day = mondayAhead();
      return h.call(a, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: day, endDate: day, ...(predecessorRequestId ? { predecessorRequestId } : {}) });
    },
    reviewer: () => manager,
    tasks: '/v1/leave/tasks',
    list: (id) => `/v1/employees/${id}/leave-requests`,
  },
  {
    name: 'expense claim',
    kind: 'expense_claim',
    root: 'expense_claim',
    raise: async (a, predecessorRequestId) => h.call(a, 'POST', '/v1/expense/claims', { purpose: 'Predecessor check (synthetic)', currency: 'INR', lines: [await expenseLine(a)], ...(predecessorRequestId ? { predecessorRequestId } : {}) }),
    submit: async (a, id) => {
      const version = (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json().version as number;
      const res = await h.call(a, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: version });
      expect(res.statusCode, res.body).toBe(200);
    },
    reviewer: () => manager,
    tasks: '/v1/expense/tasks',
    list: (id) => `/v1/employees/${id}/expense-claims`,
  },
  {
    name: 'outdoor duty',
    kind: 'outdoor_duty',
    root: 'outdoor_duty_request',
    raise: (a, predecessorRequestId) => {
      const day = mondayAhead();
      return h.call(a, 'POST', '/v1/work-requests/outdoor_duty', { purpose: 'Client visit (synthetic)', startDate: day, endDate: day, ...(predecessorRequestId ? { predecessorRequestId } : {}) });
    },
    reviewer: () => manager,
    tasks: '/v1/work-requests/tasks/mine',
    list: (id) => `/v1/employees/${id}/work-requests`,
  },
  {
    name: 'profile change',
    kind: 'profile_change',
    root: 'profile_change_request',
    raise: (a, predecessorRequestId) => h.call(a, 'POST', '/v1/me/profile-changes', { displayName: uniq('Synthetic Renamed '), ...(predecessorRequestId ? { predecessorRequestId } : {}) }),
    reviewer: () => hr,
    tasks: '/v1/profile-changes/tasks/mine',
    list: (id) => `/v1/employees/${id}/profile-changes`,
  },
  {
    name: 'attendance correction',
    kind: 'attendance_correction',
    root: 'attendance_correction_request',
    raise: (a, predecessorRequestId) =>
      h.call(a, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId: (a === colleague ? colleagueRecord : record).id, status: 'PRESENT', reason: 'Badge reader fault (synthetic)', ...(predecessorRequestId ? { predecessorRequestId } : {}) }),
    reviewer: () => manager,
    tasks: '/v1/attendance-corrections/tasks/mine',
    list: (id) => `/v1/employees/${id}/attendance-corrections`,
  },
];

const txOf = async (root: string, id: string) => (await h.one<{ transaction_id: string }>(`select transaction_id from ${root} where id = $1`, [id])).transaction_id;

/** Takes a raised request to rejected, so the next test can raise one (a person holds one live profile change or correction per record). */
async function settle(k: Kind, id: string, a: TestActor = employee) {
  await k.submit?.(a, id);
  await reject(k.reviewer(), k.tasks, await txOf(k.root, id));
}

async function rejected(k: Kind, a: TestActor = employee) {
  const id = created(await k.raise(a));
  await settle(k, id, a);
  return id;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['attendance.read.reason'] });
  const shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id as string;
  const person = async (managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
    if (managerId) await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
    return e.id as string;
  };
  const managerEmp = await person();
  employeeEmp = await person(managerEmp);
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  const colleagueEmp = await person(managerEmp);
  colleague = await h.actor(A, 'EMPLOYEE', { employeeId: colleagueEmp });
  for (const url of ['/v1/leave/policies', '/v1/attendance/policies', '/v1/expense/policies']) {
    for (const p of (await h.call(hr, 'GET', url)).json().items as { id: string; version: number }[]) await h.call(hr, 'POST', `${url}/${p.id}/activate`, { expectedVersion: p.version });
  }
  expect((await h.call(hr, 'PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
  await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: TUE });
  record = (await h.call(hr, 'GET', `/v1/employees/${employeeEmp}/attendance?from=${TUE}&to=${TUE}`)).json().items[0];
  colleagueRecord = (await h.call(hr, 'GET', `/v1/employees/${colleagueEmp}/attendance?from=${TUE}&to=${TUE}`)).json().items[0];
});

afterAll(async () => {
  await h?.stop();
});

describe.each(KINDS)('$name', (k) => {
  const ownRow = async (id: string) => ((await h.call(employee, 'GET', `/v1/me/requests?kind=${k.kind}&page=1&pageSize=100`)).json().items as { requestId: string; predecessorRequestId: string | null }[]).find((r) => r.requestId === id);
  const inList = async (id: string) => ((await h.call(employee, 'GET', k.list(employeeEmp))).json().items as { id: string; predecessorRequestId: string | null }[]).find((r) => r.id === id);

  it('links a new request to the caller’s own rejected one, shown in the own list and the kind’s list; without one the link stays empty', async () => {
    const first = await rejected(k);
    const second = created(await k.raise(employee, first));
    expect((await ownRow(second))?.predecessorRequestId).toBe(first);
    expect((await inList(second))?.predecessorRequestId).toBe(first);
    expect((await ownRow(first))?.predecessorRequestId).toBeNull();
    expect((await inList(first))?.predecessorRequestId).toBeNull();
    const predecessor = (await h.one<{ p: string | null }>(`select predecessor_transaction_id as p from business_transaction where id = $1`, [await txOf(k.root, second)])).p;
    expect(predecessor).toBe(await txOf(k.root, first));
    // A draft claim is not audited until it is submitted; every other kind records the link with its creation.
    if (k.kind !== 'expense_claim') {
      const audited = await h.one<{ after_values: { operational: { predecessorRequestId?: string } } }>(`select after_values from audit_event where resource_code = $1 and record_key = $2 and action = 'CREATE'`, [k.root, second]);
      expect(audited.after_values.operational.predecessorRequestId).toBe(first);
    }
    await settle(k, second);
  });

  it('refuses a predecessor that is still live, someone else’s, or unknown, and creates nothing', async () => {
    const count = async () => Number((await h.one<{ n: string }>(`select count(*) as n from business_transaction where company_id = $1 and kind = $2`, [A.id, k.kind])).n);
    const live = created(await k.raise(employee));
    await k.submit?.(employee, live);
    const before = await count();
    const notRejected = await k.raise(employee, live);
    expect([notRejected.statusCode, notRejected.json().error]).toEqual([422, 'PREDECESSOR_NOT_REJECTED']);
    const unknown = await k.raise(employee, '00000000-0000-4000-8000-000000000001');
    expect([unknown.statusCode, unknown.json().error]).toEqual([422, 'PREDECESSOR_NOT_FOUND']);
    const theirs = await rejected(k, colleague);
    const others = await k.raise(employee, theirs);
    expect([others.statusCode, others.json().error]).toEqual([422, 'PREDECESSOR_NOT_FOUND']);
    expect(await count()).toBe(before + 1); // only the colleague's own request
    await reject(k.reviewer(), k.tasks, await txOf(k.root, live));
  });

  it('one live successor: a second is refused until the first is itself rejected', async () => {
    const first = await rejected(k);
    const second = created(await k.raise(employee, first));
    await k.submit?.(employee, second);
    const again = await k.raise(employee, first);
    expect([again.statusCode, again.json().error]).toEqual([409, 'PREDECESSOR_ALREADY_FOLLOWED']);
    await reject(k.reviewer(), k.tasks, await txOf(k.root, second));
    await settle(k, created(await k.raise(employee, first)));
  });
});

describe('a request of another kind cannot be named', () => {
  it('a rejected leave request is not found as the predecessor of an outdoor duty', async () => {
    const leave = await rejected(KINDS[0]!);
    const res = await KINDS[2]!.raise(employee, leave);
    expect([res.statusCode, res.json().error]).toEqual([422, 'PREDECESSOR_NOT_FOUND']);
  });
});

describe('the link is set at creation only', () => {
  it('a corrected, resubmitted request keeps the link it was created with, whatever the correction names', async () => {
    const rejectedFirst = await rejected(KINDS[0]!);
    const otherRejected = await rejected(KINDS[0]!);
    const day = mondayAhead();
    const id = created(await KINDS[0]!.raise(employee, rejectedFirst));
    const tx = await txOf('leave_request', id);
    const tasks = (await h.call(manager, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; transactionId: string }[];
    const returned = await h.call(manager, 'POST', `/v1/leave/tasks/${tasks.find((t) => t.transactionId === tx)!.taskId}/decision`, { decision: 'RETURN', reason: 'Synthetic return', idempotencyKey: uniq('pred-key-') });
    expect(returned.statusCode, returned.body).toBe(200);
    const version = ((await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/leave-requests`)).json().items as { id: string; version: number }[]).find((r) => r.id === id)!.version;
    const put = await h.call(employee, 'PUT', `/v1/leave/requests/${id}`, { startDate: day, endDate: day, expectedVersion: version, predecessorRequestId: otherRejected });
    expect(put.statusCode, put.body).toBe(200);
    expect((await h.one<{ p: string }>(`select predecessor_transaction_id as p from business_transaction where id = $1`, [tx])).p).toBe(await txOf('leave_request', rejectedFirst));
    await reject(manager, '/v1/leave/tasks', tx);
  });
});

describe('the database guard (0125)', () => {
  const insert = (kind: string, owner: string | null, state: string, predecessor: string | null) =>
    h.db.query(`begin; set constraints business_transaction_has_root deferred; insert into business_transaction (company_id, kind, owner_employee_id, state, predecessor_transaction_id) values ('${A.id}', '${kind}', ${owner ? `'${owner}'` : 'null'}, '${state}', ${predecessor ? `'${predecessor}'` : 'null'}); rollback;`);
  const failing = async (work: Promise<unknown>) => {
    const error = await work.then(
      () => null,
      (e: { code?: string; message: string }) => e,
    );
    await h.db.query('rollback');
    return error;
  };

  it('refuses another kind, another owner and a predecessor that was not rejected; accepts the rejected one', async () => {
    const first = await txOf('leave_request', await rejected(KINDS[0]!));
    const otherEmp = (await h.one<{ id: string }>(`select id from employee where company_id = $1 and id <> $2 limit 1`, [A.id, employeeEmp])).id;
    expect((await failing(insert('expense_claim', employeeEmp, 'DRAFT', first)))?.message).toMatch(/same kind and owner/);
    expect((await failing(insert('leave_request', otherEmp, 'SUBMITTED', first)))?.message).toMatch(/same kind and owner/);
    expect((await failing(insert('leave_request', null, 'SUBMITTED', first)))?.message).toMatch(/same kind and owner/);
    const day = mondayAhead();
    const liveId = created(await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: day, endDate: day }));
    const live = await txOf('leave_request', liveId);
    expect((await failing(insert('leave_request', employeeEmp, 'SUBMITTED', live)))?.message).toMatch(/only a rejected request/);
    expect(await failing(insert('leave_request', employeeEmp, 'SUBMITTED', first))).toBeNull();
    await h.db.query('rollback').catch(() => undefined);
    await reject(manager, '/v1/leave/tasks', live);
  });

  it('refuses a second live successor and any later change of the link', async () => {
    const first = await txOf('leave_request', await rejected(KINDS[0]!));
    const secondId = created(await KINDS[0]!.raise(employee, (await h.one<{ id: string }>(`select id from leave_request where transaction_id = $1`, [first])).id));
    const second = await txOf('leave_request', secondId);
    const duplicate = await failing(insert('leave_request', employeeEmp, 'SUBMITTED', first));
    expect(duplicate?.code).toBe('23505');
    const other = await txOf('leave_request', await rejected(KINDS[0]!));
    const changed = await failing(h.db.query(`update business_transaction set predecessor_transaction_id = $2 where id = $1`, [second, other]));
    expect(changed?.message).toMatch(/immutable/);
    const cleared = await failing(h.db.query(`update business_transaction set predecessor_transaction_id = null where id = $1`, [second]));
    expect(cleared?.message).toMatch(/immutable/);
  });
});
