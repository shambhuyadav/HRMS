// Letters name the post in force on their process's date, not on the day of issue (FR-017 "generation substitutes correct
// employee data"): a future joiner and a future-dated transfer, previewed and generated. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { addDays, HR_LETTERS, publishedTemplate, today as businessDate } from './lifecycle.fixtures.js';

describe.runIf(isModuleActive('lifecycle'))('letters: the post on the process date (FR-017)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let hrLetters: TestActor;
  let today: string;
  let templateCode: string;

  const preview = (processId: string) => h.call(hrLetters, 'POST', `/v1/employee-processes/${processId}/letters/preview`, { templateCode });
  const start = async (employeeId: string, effectiveDate?: string) => {
    const res = await h.call(hr, 'POST', `/v1/employees/${employeeId}/processes`, { processCode: 'POST_LETTER', ...(effectiveDate ? { effectiveDate } : {}) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    hrLetters = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_LETTERS });
    today = await businessDate(h, A);
    await publishedTemplate(h, hr, 'POST_LETTER', 'TRANSFER', [{ code: 'ISSUE', title: 'Issue letter', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
    templateCode = uniq('POST').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const created = await h.call(hr, 'POST', '/v1/letter-templates', { code: templateCode, name: 'Synthetic post letter', letterType: 'APPOINTMENT', body: '{{employeeName}} joins {{department}} as {{designation}} at {{location}} on {{letterDate}}.' });
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json().revisions[0];
    expect((await h.call(hr, 'POST', `/v1/letter-templates/${created.json().id}/publish`, { revision: draft.revision, expectedVersion: draft.version })).statusCode).toBe(200);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('a new hire who has not joined yet gets the department, designation and location of the joining date', async () => {
    const joining = addDays(today, 30);
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: 'Future Joiner (synthetic)', joiningDate: joining }));
    expect(res.statusCode, res.body).toBe(201);
    // A process started today, before the joining date, and one dated on it read the same assignment.
    for (const effectiveDate of [undefined, joining]) {
      const processId = await start(res.json().id, effectiveDate);
      const shown = (await preview(processId)).json();
      expect(shown).toMatchObject({ missing: [], ready: true });
      expect(shown.text).toBe(`Future Joiner (synthetic) joins ENG as DEV at HQ on ${today}.`);
    }
    const generated = await h.call(hrLetters, 'POST', `/v1/employee-processes/${await start(res.json().id)}/letters`, { templateCode });
    expect(generated.statusCode, generated.body).toBe(201);
    const content = await h.call(hrLetters, 'GET', `/v1/letter-outputs/${generated.json().id}/content`);
    expect(content.body).toBe(`Future Joiner (synthetic) joins ENG as DEV at HQ on ${today}.`);
  });

  it('a letter for a future-dated transfer names the new post; a process dated before it names the old one', async () => {
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: 'Moving Person (synthetic)' }));
    expect(res.statusCode, res.body).toBe(201);
    const employeeId = res.json().id as string;
    await h.setStatus(A, employeeId, 'ACTIVE_CONFIRMED');
    const moved = addDays(today, 20);
    const transfer = await h.call(hr, 'POST', `/v1/employees/${employeeId}/assignment`, { departmentId: A.financeDept, locationId: A.loc, designationId: A.desig, effectiveFrom: moved });
    expect(transfer.statusCode, transfer.body).toBe(200);

    expect((await preview(await start(employeeId, moved))).json().text).toBe(`Moving Person (synthetic) joins FIN as DEV at HQ on ${today}.`);
    expect((await preview(await start(employeeId, addDays(moved, 5)))).json().text).toBe(`Moving Person (synthetic) joins FIN as DEV at HQ on ${today}.`);
    expect((await preview(await start(employeeId, addDays(moved, -1)))).json().text).toBe(`Moving Person (synthetic) joins ENG as DEV at HQ on ${today}.`);
    expect((await preview(await start(employeeId))).json().text).toBe(`Moving Person (synthetic) joins ENG as DEV at HQ on ${today}.`);
  });
});
