// Where a refusal is recorded (I-84 item 16, decided under owner delegation, 6 Nov 2026; I-74 item 11; FR-098; ZT01 "no successful
// mutation"; BR-046). A denial goes to the audit trail of the company the request named only when the user has a tie to it; a replayed
// header naming a company the user never belonged to adds nothing there and goes to the security log. Synthetic data only.
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../test/harness.js';
import { auditDenial } from './guard.js';

let h: Harness;
let A: Company;
let B: Company;
let outsider: TestActor;

const deniedIn = async (company: Company, user: string) =>
  (await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and actor_user_id = $2 and action = 'ACCESS_DENIED'`, [company.id, user])).n;
const allRowsOf = async (company: Company) => (await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1`, [company.id])).n;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  outsider = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('a refusal is recorded where the user belongs (ZT01, BR-046)', () => {
  it('ZT01: a company A user replaying the header of company B is refused, and nothing is added to B’s audit trail', async () => {
    const before = await allRowsOf(B);
    const replayed: TestActor = { ...outsider, company: B };
    for (const url of ['/v1/employees', '/v1/access/assignments', '/v1/workflows/stranded-tasks']) {
      const res = await h.call(replayed, 'GET', url);
      expect(res.statusCode, url).toBe(403);
    }
    expect(await allRowsOf(B)).toBe(before);
    // In the user's own company a refusal is still recorded, as before.
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: (await h.call(outsider, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id });
    expect((await h.call(employee, 'GET', '/v1/access/assignments')).statusCode).toBe(403);
    expect(await deniedIn(A, employee.user)).toBe(1);
  });

  it('ZT01: a tie of any kind keeps the record: a revoked assignment, or an employee link, in the named company', async () => {
    const formerly = await h.actor(B, 'HR_ADMINISTRATOR');
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where company_id = $1 and id = $2`, [B.id, formerly.assignment]);
    expect((await h.call(formerly, 'GET', '/v1/employees')).statusCode).toBe(403);
    expect(await deniedIn(B, formerly.user)).toBe(1);

    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const linkedEmployee = (await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B))).json().id as string;
    const linked = await h.actor(A, 'EMPLOYEE', { employeeId: (await h.call(outsider, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id });
    await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [B.id, linked.user, linkedEmployee]);
    expect((await h.call({ ...linked, company: B }, 'GET', '/v1/employees')).statusCode).toBe(403);
    expect(await deniedIn(B, linked.user)).toBe(1);
  });

  it('BR-046: the refusal outside any tie goes to the security log, naming the request, user, company, action and reason, never a payload', async () => {
    const logged: { fields: Record<string, unknown>; message: string }[] = [];
    const request = {
      id: 'req-synthetic-1',
      actor: { userId: outsider.user, sessionId: 'session-synthetic', companyId: B.id, assignmentId: outsider.assignment },
      log: { warn: (fields: Record<string, unknown>, message: string) => logged.push({ fields, message }) },
    } as unknown as FastifyRequest;
    const before = await allRowsOf(B);
    await auditDenial(h.pool, request, { resource: 'employee', action: 'read', reason: 'ASSIGNMENT_NOT_ACTIVE', recordKey: 'SYNTHETIC-RECORD' });
    expect(await allRowsOf(B)).toBe(before);
    expect(logged).toEqual([
      {
        fields: { event: 'ACCESS_DENIED_OUTSIDE_COMPANY', userId: outsider.user, namedCompanyId: B.id, resource: 'employee', action: 'read', reason: 'ASSIGNMENT_NOT_ACTIVE' },
        message: 'Refused a request naming a company the user has no tie to',
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain('SYNTHETIC-RECORD');
  });
});
