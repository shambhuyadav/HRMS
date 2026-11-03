// Employee-to-mobile-app links over HTTP (FR-023; C4). Synthetic opaque app account references.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hr2: TestActor;
let employee: TestActor;
let other: TestActor;
let employeeEmp: string;
let otherEmp: string;

type Link = { id: string; state: string; appAccountRef: string; version: number; replacesLinkId: string | null };
const links = async (a: TestActor, employeeId: string) => (await h.call(a, 'GET', `/v1/employees/${employeeId}/mobile-links`)).json().items as Link[];
const versionOf = async (id: string) => (await h.one<{ version: number }>(`select version from mobile_app_link where id = $1`, [id])).version;
const decide = async (a: TestActor, id: string, decision: 'APPROVE' | 'REJECT') => h.call(a, 'POST', `/v1/mobile-links/${id}/decision`, { expectedVersion: await versionOf(id), decision });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
  employeeEmp = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
  otherEmp = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  other = await h.actor(A, 'EMPLOYEE', { employeeId: otherEmp });
});

afterAll(async () => {
  await h?.stop();
});

describe('mobile-app links (FR-023, C4)', () => {
  it('a link exists only after an independent review; the employee cannot approve it', async () => {
    const ref = uniq('app-user-');
    const res = await h.call(employee, 'POST', '/v1/mobile-links', { appAccountRef: ref });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();
    expect(await links(employee, employeeEmp)).toMatchObject([{ id, state: 'PENDING', appAccountRef: ref }]);
    expect((await h.call(employee, 'POST', `/v1/mobile-links/${id}/decision`, { expectedVersion: 1, decision: 'APPROVE' })).statusCode).toBe(403);
    expect((await h.call(employee, 'POST', '/v1/mobile-links', { appAccountRef: uniq('app-user-') })).statusCode).toBe(409); // one pending per employee
    expect((await h.call(hr, 'POST', `/v1/mobile-links/${id}/decision`, { expectedVersion: 99, decision: 'APPROVE' })).statusCode).toBe(409);
    expect((await decide(hr, id, 'APPROVE')).json().state).toBe('ACTIVE');
    expect((await h.call(employee, 'POST', '/v1/mobile-links', { appAccountRef: ref })).json().error).toBe('ALREADY_LINKED');
  });

  it('the requester never decides, and an account linked to one employee cannot be linked to another', async () => {
    const ref = uniq('app-user-');
    const req = (await h.call(hr, 'POST', '/v1/mobile-links', { employeeId: otherEmp, appAccountRef: ref })).json();
    expect((await decide(hr, req.id, 'APPROVE')).json().error).toBe('SELF_APPROVAL');
    expect((await decide(hr2, req.id, 'APPROVE')).json().state).toBe('ACTIVE');
    // The same app account cannot be associated with a second employee.
    expect((await h.call(employee, 'POST', '/v1/mobile-links', { appAccountRef: ref })).json().error).toBe('ACCOUNT_LINKED_ELSEWHERE');
    // An HR user cannot decide a link for their own employee record.
    const hrEmp = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
    const hrSelf = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: hrEmp });
    const own = (await h.call(hr2, 'POST', '/v1/mobile-links', { employeeId: hrEmp, appAccountRef: uniq('app-user-') })).json();
    expect((await decide(hrSelf, own.id, 'APPROVE')).json().error).toBe('SELF_APPROVAL');
    expect((await decide(hr, own.id, 'REJECT')).json().state).toBe('REJECTED');
  });

  it('re-linking needs the same review and revokes the previous link only on approval', async () => {
    const current = (await links(hr, employeeEmp)).find((l) => l.state === 'ACTIVE')!;
    const next = (await h.call(employee, 'POST', '/v1/mobile-links', { appAccountRef: uniq('app-user-') })).json();
    expect(next.replacesLinkId).toBe(current.id);
    expect((await links(hr, employeeEmp)).find((l) => l.id === current.id)!.state).toBe('ACTIVE'); // still active while pending
    expect((await decide(hr, next.id, 'APPROVE')).json().state).toBe('ACTIVE');
    const after = await links(hr, employeeEmp);
    expect(after.find((l) => l.id === current.id)!.state).toBe('REVOKED');
    expect(after.filter((l) => l.state === 'ACTIVE').map((l) => l.id)).toEqual([next.id]);

    const revoke = (reason: string) => h.call(hr, 'POST', `/v1/mobile-links/${next.id}/revoke`, { expectedVersion: after.find((l) => l.id === next.id)!.version, reason });
    expect((await revoke('Phone replaced (synthetic)')).json().state).toBe('REVOKED');
    expect((await h.call(hr, 'POST', `/v1/mobile-links/${next.id}/revoke`, { expectedVersion: await versionOf(next.id), reason: 'Again' })).statusCode).toBe(409);
  });

  it('employees see and request only their own links', async () => {
    expect((await h.call(other, 'GET', `/v1/employees/${employeeEmp}/mobile-links`)).statusCode).toBe(404);
    expect((await h.call(other, 'POST', '/v1/mobile-links', { employeeId: employeeEmp, appAccountRef: uniq('app-user-') })).statusCode).toBe(404);
    expect((await h.call(other, 'GET', '/v1/mobile-links')).statusCode).toBe(403);
    const queue = (await h.call(hr, 'GET', '/v1/mobile-links?state=REVOKED')).json().items as Link[];
    expect(queue.length).toBeGreaterThanOrEqual(2);
  });
});
