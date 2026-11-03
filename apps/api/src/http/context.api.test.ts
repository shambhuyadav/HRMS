// The context headers carry ids PostgreSQL reads in any letter case. From the actor on they are canonical, because they
// also reach object keys (docs/09 §3.4; storage/files.ts) and comparisons: an upload under an upper-case company header
// is stored under the company's one key prefix instead of failing. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../test/harness.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from './context.js';

let h: Harness;
let A: Company;
let employee: TestActor;
let employeeId: string;

const pdf = Buffer.from('%PDF-1.4\n% synthetic evidence\n%%EOF\n').toString('base64');

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  const hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  employeeId = e.id as string;
  employee = await h.actor(A, 'EMPLOYEE', { employeeId });
});

afterAll(async () => {
  await h?.stop();
});

describe('context headers', () => {
  it('an id header in another letter case is the same id: the upload is keyed under the canonical company prefix', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeId}/documents`,
      payload: { documentType: 'GENERAL', fileName: 'letter.pdf', contentBase64: pdf },
      headers: { authorization: `Bearer ${employee.token}`, [COMPANY_HEADER]: A.id.toUpperCase(), [ASSIGNMENT_HEADER]: employee.assignment.toUpperCase() },
    });
    expect(res.statusCode).toBe(201);
    const stored = await h.one<{ reference: string; company_id: string }>(
      `select a.content_reference as reference, a.company_id from employee_document d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id where d.id = $1`,
      [res.json().id],
    );
    expect(stored.company_id).toBe(A.id);
    expect(stored.reference.startsWith(`mem:${A.id}/`)).toBe(true);
  });
});
