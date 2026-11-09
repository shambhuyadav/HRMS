// BR-003 "Current, Offered Rejected, Offered, On Probation, On Notice and Left are visible views ... not assumed to be one
// exclusive stored status" and FR-006 "Reference status views are Current, Offered[Rej], Offered, On Probation, On Notice and
// Left", as decided under owner delegation, 6 Nov 2026 (docs/03 I-82 item 3): views over DF04's lifecycle states on the
// employee list and its export; Current includes On Notice; Offered is a pre-joining (DRAFT) record and Offered Rejected one
// closed before joining; offers still awaiting an answer or declined stay in hiring. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';
import { EMPLOYEE_STATUS_GROUPS } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let reader: TestActor;
const people: Record<string, string> = {};

const view = async (a: TestActor, statusGroup: string) => {
  const res = await h.call(a, 'GET', `/v1/employees?statusGroup=${statusGroup}&search=VIEWS&pageSize=100`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { id: string }[]).map((e) => e.id).sort();
};
const ids = (...names: string[]) => names.map((n) => people[n]!).sort();

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  reader = await h.actor(A, 'PAYROLL_OPERATOR');
  const make = async (name: string, status: string | null) => {
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: `VIEWS ${name}` }));
    expect(res.statusCode, res.body).toBe(201);
    people[name] = res.json().id;
    if (status) await h.setStatus(A, res.json().id, status);
    return res.json() as { id: string; version: number };
  };
  await make('preJoining', null);
  const neverJoined = await make('neverJoined', null);
  // The real close-draft route: the status history records DRAFT_CLOSED.
  const closed = await h.call(hr, 'POST', `/v1/employees/${neverJoined.id}/close-draft`, { expectedVersion: neverJoined.version, reason: 'Synthetic: did not join' });
  expect(closed.statusCode, closed.body).toBe(200);
  await make('probation', 'ACTIVE_PROBATION');
  await make('confirmed', 'ACTIVE_CONFIRMED');
  await make('notice', 'NOTICE');
  await make('separated', 'INACTIVE_SEPARATED');
  // Archived after leaving (no DRAFT_CLOSED in its history): Left, never Offered Rejected.
  await make('archivedAfterLeaving', 'ARCHIVED');
});

afterAll(async () => {
  await h?.stop();
});

describe('BR-003 / FR-006 reference status views (I-82 item 3)', () => {
  it('BR-003: each named view is a list filter over the lifecycle states, and the views overlap rather than being one stored status', async () => {
    expect(Object.keys(EMPLOYEE_STATUS_GROUPS)).toEqual(expect.arrayContaining(['CURRENT', 'OFFERED', 'OFFERED_REJECTED', 'ON_PROBATION', 'ON_NOTICE', 'LEFT']));
    expect(await view(hr, 'OFFERED')).toEqual(ids('preJoining'));
    expect(await view(hr, 'OFFERED_REJECTED')).toEqual(ids('neverJoined'));
    expect(await view(hr, 'ON_PROBATION')).toEqual(ids('probation'));
    expect(await view(hr, 'ON_NOTICE')).toEqual(ids('notice'));
    expect(await view(hr, 'LEFT')).toEqual(ids('separated', 'archivedAfterLeaving'));
    // Overlap (BR-003 "not assumed to be one exclusive stored status"): the probationer and the person on notice are also Current.
    expect(await view(hr, 'CURRENT')).toEqual(ids('probation', 'confirmed', 'notice'));
  });

  it('BR-003 decision: Current includes On Notice, exactly as DF17 "Active" counts', async () => {
    const current = await view(hr, 'CURRENT');
    expect(current).toContain(people.notice);
    expect(current).toEqual(await view(hr, 'ACTIVE'));
  });

  it('FR-006 decision: Offered Rejected is a record closed before joining; an archived record that had joined is Left', async () => {
    expect(await view(hr, 'OFFERED_REJECTED')).not.toContain(people.archivedAfterLeaving);
    expect(await view(hr, 'LEFT')).not.toContain(people.neverJoined);
    // A pre-joining record is neither Current nor Left.
    expect(await view(hr, 'CURRENT')).not.toContain(people.preJoining);
    expect(await view(hr, 'LEFT')).not.toContain(people.preJoining);
  });

  it('BR-003: every list reader may use the views (operational states only); an unknown view is refused', async () => {
    expect(await view(reader, 'OFFERED')).toEqual(ids('preJoining'));
    expect((await h.call(hr, 'GET', '/v1/employees?statusGroup=OFFERED_DECLINED')).statusCode).toBe(400);
  });

  it('FR-007 / BR-003: the employee register export applies the same view as the list', async () => {
    for (const statusGroup of ['OFFERED_REJECTED', 'LEFT', 'CURRENT']) {
      const requested = await h.call(hr, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER', filters: { statusGroup, search: 'VIEWS' } });
      expect(requested.statusCode, requested.body).toBe(202);
      await processReportQueue(h.pool);
      const file = await h.call(hr, 'GET', `/v1/reports/${requested.json().id}/download`);
      expect(file.statusCode, file.body).toBe(200);
      const lines = csvTable(file.body).trimEnd().split('\r\n').slice(1);
      expect(lines).toHaveLength((await view(hr, statusGroup)).length);
    }
  });
});
