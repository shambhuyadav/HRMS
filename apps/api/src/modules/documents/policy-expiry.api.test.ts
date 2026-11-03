// DF12 "document expiry" for company policy versions (FR-010; DF02; I-38): a daily job raises one POLICY_EXPIRING notice
// per policy version on its expiry date (no lead time unless one is passed), sent only to users who can currently manage
// that policy at its classification (company_policy.manage for each of its field groups, from an unrestricted company
// scope), so a confidential policy's code and title never reach anyone without the confidential group. The notice
// names the policy, the version and the date, never the file. Synthetic data and synthetic PDF bytes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { runScheduledJobs } from '../../worker/scheduler.js';
import { MODULE_DAILY_JOBS } from '../jobs-registry.js';
import { isModuleActive } from '../registry.js';
import { runPolicyExpiry } from './expiry.js';

const CONFIDENTIAL: `${string}.${string}.${string}`[] = ['company_policy.read.confidential', 'company_policy.manage.confidential'];
const pdf = Buffer.from('%PDF-1.4\n% synthetic policy body\n%%EOF\n').toString('base64');
// A file the malware scan flags: the EICAR anti-virus test string, assembled at run time (storage/scan.ts).
const infected = Buffer.from(`%PDF-1.4\n% ${EICAR_TEST_STRING}\n%%EOF\n`, 'latin1').toString('base64');

describe.runIf(isModuleActive('documents'))('company policy expiry notices (DF12, FR-010, DF02)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor; // HR default duties: manages operational policies company-wide
  let hrConfidential: TestActor; // also holds the confidential group (read and manage)
  let confidentialReader: TestActor; // HR who may read confidential policies but manage operational ones only
  let hrTeam: TestActor; // manage grant, but limited to one department: cannot publish policies
  let manager: TestActor; // reads policies, manages none
  let employee: TestActor;
  let hrB: TestActor; // another company's policy manager

  const publish = async (a: TestActor, body: Record<string, unknown>) => {
    const res = await h.call(a, 'POST', '/v1/company-policies', { policyCode: uniq('POL_'), title: 'Synthetic policy', classification: 'OPERATIONAL', fileName: 'policy.pdf', contentBase64: pdf, ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; policyCode: string; title: string; versionId: string; scanState: string };
  };
  const addVersion = async (a: TestActor, policyId: string, body: Record<string, unknown>) => {
    const current = (await h.call(a, 'GET', `/v1/company-policies/${policyId}`)).json() as { version: number };
    const res = await h.call(a, 'POST', `/v1/company-policies/${policyId}/versions`, { fileName: 'policy-v2.pdf', contentBase64: pdf, expectedVersion: current.version, ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { versionId: string; versionNumber: number; scanState: string };
  };
  const notices = async (a: TestActor) =>
    ((await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[]).filter((n) => n.category === 'POLICY_EXPIRING');
  const bodies = async (a: TestActor) => (await notices(a)).map((n) => n.body);
  const noticeFor = (code: string, title: string, day: string, version = 1) => `Version ${version} of the company policy ${code} (${title}) expires on ${day}.`;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    hrConfidential = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIDENTIAL });
    confidentialReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['company_policy.read.confidential'] });
    hrTeam = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    manager = await h.actor(A, 'REPORTING_MANAGER');
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    hrB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: CONFIDENTIAL });
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('is provisioned from the documents module registration and runs as its daily job', async () => {
    const rule = await h.one<{ recipient_selector: string; optional_event: boolean; body: string; placeholders: string[] }>(
      `select r.recipient_selector, r.optional_event, t.body_template as body, t.approved_placeholders as placeholders
         from notification_rule r join notification_template t on t.company_id = r.company_id and t.id = r.template_id
        where r.company_id = $1 and r.code = 'POLICY_EXPIRING' and r.event_type = 'POLICY_EXPIRING'`,
      [A.id],
    );
    expect(rule).toMatchObject({ recipient_selector: 'POLICY_MANAGERS', optional_event: false });
    expect(rule.placeholders.sort()).toEqual(['expiresOn', 'policyCode', 'policyTitle', 'versionNumber']);
    expect(MODULE_DAILY_JOBS.filter((j) => j.code === 'POLICY_EXPIRY').map((j) => [j.key, j.fromHour])).toEqual([['documents', 8]]);
  });

  it('on the expiry date, once per version, to the current managers of that policy only; a confidential title only to the confidential group', async () => {
    const day = '2027-03-15';
    const open = await publish(hr, { title: 'Synthetic travel policy', expiresOn: day });
    const secret = await publish(hrConfidential, { title: 'Synthetic restructuring plan', classification: 'CONFIDENTIAL', expiresOn: day });
    await publish(hr, { title: 'Synthetic later policy', expiresOn: '2027-03-16' });
    await publish(hr, { title: 'Synthetic open-ended policy' });
    await publish(hrB, { title: 'Synthetic other company policy', expiresOn: day });

    expect((await runPolicyExpiry(h.pool, A.id, '2027-03-14')).events).toBe(0); // no lead time unless configured
    expect(await runPolicyExpiry(h.pool, A.id, day)).toMatchObject({ day, events: 2 });
    expect((await runPolicyExpiry(h.pool, A.id, day)).events).toBe(0); // a rerun raises nothing new

    const openNotice = noticeFor(open.policyCode, 'Synthetic travel policy', day);
    const secretNotice = noticeFor(secret.policyCode, 'Synthetic restructuring plan', day);
    expect(await notices(hrConfidential)).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Company policy expiring', body: openNotice }), expect.objectContaining({ body: secretNotice })]),
    );
    expect((await bodies(hrConfidential)).sort()).toEqual([openNotice, secretNotice].sort());
    // Operational managers are told about the operational policy only; the confidential code and title reach nobody else,
    // not even a holder of the confidential read grant who cannot manage the policy.
    for (const a of [hr, confidentialReader]) expect(await bodies(a)).toEqual([openNotice]);
    // A department-limited manager cannot publish policies; readers and other roles manage nothing.
    for (const a of [hrTeam, manager, employee, hrB]) expect(await notices(a)).toEqual([]);
    for (const a of [hr, confidentialReader, hrTeam, manager, employee]) expect(JSON.stringify(await notices(a))).not.toMatch(new RegExp(`restructuring|${secret.policyCode}|policy\\.pdf`));
    expect(JSON.stringify(await notices(hrConfidential))).not.toContain('policy.pdf');
    // The recipient of the confidential notice can see that policy; to an operational-only manager it reads as not found.
    expect((await h.call(hrConfidential, 'GET', `/v1/company-policies/${secret.id}`)).statusCode).toBe(200);
    expect((await h.call(hr, 'GET', `/v1/company-policies/${secret.id}`)).statusCode).toBe(404);

    const events = await h.db.query<{ event_key: string; data: Record<string, string>; subject_employee_id: string | null }>(
      `select event_key, data, subject_employee_id from notification_event where company_id = $1 and event_type = 'POLICY_EXPIRING' order by event_key`,
      [A.id],
    );
    expect(events.rows).toEqual(
      expect.arrayContaining([
        { event_key: `POLICY_EXPIRING:${open.versionId}:${day}:0`, subject_employee_id: null, data: { versionNumber: '1', policyCode: open.policyCode, policyTitle: 'Synthetic travel policy', expiresOn: day } },
      ]),
    );
    expect(events.rows).toHaveLength(2);
    // The other company's version is its own company's event, for its own managers.
    expect((await runPolicyExpiry(h.pool, B.id, day)).events).toBe(1);
    expect(await notices(hrB)).toHaveLength(1);
    expect(await bodies(hr)).toEqual([openNotice]);
  });

  it('each version is its own occurrence; a missed day is caught up once within the catch-up window', async () => {
    const p = await publish(hr, { title: 'Synthetic leave policy', expiresOn: '2027-08-10' });
    expect((await runPolicyExpiry(h.pool, A.id, '2027-08-10')).events).toBe(1);
    await addVersion(hr, p.id, { expiresOn: '2027-08-12' });
    // The job did not run on 12 August; the run on 13 August still raises the new version's notice, and only once.
    expect((await runPolicyExpiry(h.pool, A.id, '2027-08-13')).events).toBe(1);
    expect((await runPolicyExpiry(h.pool, A.id, '2027-08-14')).events).toBe(0);
    const mine = (await bodies(hr)).filter((b) => b.includes(p.policyCode));
    expect(mine.sort()).toEqual([noticeFor(p.policyCode, 'Synthetic leave policy', '2027-08-10'), noticeFor(p.policyCode, 'Synthetic leave policy', '2027-08-12', 2)].sort());
    // Beyond the catch-up window a long-expired version raises nothing.
    await publish(hr, { title: 'Synthetic long-expired policy', expiresOn: '2027-07-01' });
    expect((await runPolicyExpiry(h.pool, A.id, '2027-08-15')).events).toBe(0);
  });

  it('only the policy’s current version raises a notice: never a superseded one, nor one quarantined or still waiting for the scan (FR-106)', async () => {
    const day = '2027-09-20';
    // Superseded: version 1 expires on the day, but a later released version replaced it.
    const superseded = await publish(hr, { title: 'Synthetic superseded policy', expiresOn: day });
    expect((await addVersion(hr, superseded.id, {})).scanState).toBe('CLEAN');
    // Quarantined: the only version failed the scan, so no version of the policy is in force.
    expect((await publish(hr, { title: 'Synthetic quarantined policy', expiresOn: day, contentBase64: infected })).scanState).toBe('QUARANTINED');
    // Still current: version 2 failed the scan, so version 1 stays the one in force; both expire on the day.
    const kept = await publish(hr, { title: 'Synthetic kept policy', expiresOn: day });
    expect((await addVersion(hr, kept.id, { contentBase64: infected, expiresOn: day })).scanState).toBe('QUARANTINED');
    // Waiting for the scan: version 2 expires on the day but is not released yet (written directly: the harness scanner
    // always answers, and a scanned file never returns to PENDING_SCAN).
    const waiting = await publish(hr, { title: 'Synthetic unscanned policy' });
    await h.db.query(
      `with a as (insert into attachment (company_id, owner_user_id, content_reference, media_type, checksum, classification, file_name, byte_size, scan_state)
                  values ($1, $2, 'synthetic-unscanned', 'application/pdf', repeat('0', 64), 'OPERATIONAL', 'policy-v2.pdf', 40, 'PENDING_SCAN') returning id)
       insert into company_policy_version (company_id, policy_id, version_number, attachment_id, expires_on) select $1, $3, 2, a.id, $4::date from a`,
      [A.id, hr.user, waiting.id, day],
    );

    expect(await runPolicyExpiry(h.pool, A.id, day)).toMatchObject({ events: 1 });
    expect((await bodies(hr)).filter((b) => b.endsWith(`expires on ${day}.`))).toEqual([noticeFor(kept.policyCode, 'Synthetic kept policy', day)]);
  });

  it('a lead time is a parameter (none by default); each lead is its own occurrence', async () => {
    const day = '2027-05-10';
    const p = await publish(hr, { title: 'Synthetic expense policy', expiresOn: day });
    expect((await runPolicyExpiry(h.pool, A.id, '2027-05-03')).events).toBe(0);
    expect((await runPolicyExpiry(h.pool, A.id, '2027-05-03', 7)).events).toBe(1);
    expect((await runPolicyExpiry(h.pool, A.id, '2027-05-03', 7)).events).toBe(0);
    expect((await bodies(hr)).filter((b) => b === noticeFor(p.policyCode, 'Synthetic expense policy', day))).toHaveLength(1);
    await expect(runPolicyExpiry(h.pool, A.id, '2027-05-03', -1)).rejects.toThrow();
  });

  it('recipients are decided when the notice is raised: the current classification, allowlist and role ceiling govern', async () => {
    const managePermission = (group: string) => `(select id from permission where resource = 'company_policy' and action = 'manage' and field_group = '${group}')`;
    // An operational policy made confidential before it expires: its operational-only managers are no longer told.
    const day = '2027-06-21';
    const p = await publish(hr, { title: 'Synthetic reclassified policy', expiresOn: day });
    const before = (await h.call(hrConfidential, 'GET', `/v1/company-policies/${p.id}`)).json() as { version: number };
    const patched = await h.call(hrConfidential, 'PATCH', `/v1/company-policies/${p.id}`, { expectedVersion: before.version, classification: 'CONFIDENTIAL' });
    expect(patched.statusCode, patched.body).toBe(200);
    const second = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIDENTIAL });
    // hrConfidential's DB109 allowlist entry for managing confidential policies is switched off.
    await h.db.query(`update role_assignment_permission set active = false where role_assignment_id = $1 and permission_id = ${managePermission('confidential')}`, [hrConfidential.assignment]);
    expect(await runPolicyExpiry(h.pool, A.id, day)).toMatchObject({ events: 1, notifications: 1 });
    const notice = noticeFor(p.policyCode, 'Synthetic reclassified policy', day);
    expect(await bodies(second)).toContain(notice);
    for (const a of [hr, confidentialReader, hrConfidential]) expect(await bodies(a)).not.toContain(notice);

    // The role ceiling no longer allows managing operational policies: nobody is told, although allowlists still list it.
    const later = '2027-06-22';
    const r = await publish(second, { title: 'Synthetic ceiling policy', expiresOn: later });
    await h.db.query(`update role_permission set effect = 'DENY' where company_id = $1 and permission_id = ${managePermission('operational')}`, [A.id]);
    expect(await runPolicyExpiry(h.pool, A.id, later)).toMatchObject({ events: 1, notifications: 0 });
    expect(await bodies(second)).not.toContain(noticeFor(r.policyCode, 'Synthetic ceiling policy', later));
    await h.db.query(`update role_permission set effect = 'ALLOW' where company_id = $1 and permission_id = ${managePermission('operational')}`, [A.id]);
    await h.db.query(`update role_assignment_permission set active = true where role_assignment_id = $1 and permission_id = ${managePermission('confidential')}`, [hrConfidential.assignment]);
  });

  it('runs with the daily jobs from 08:00 company time on the company-local date, and records its counts with the run', async () => {
    const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    const atLocal = async (hour: number) =>
      (await h.one<{ at: Date }>(`select ($2::date + make_interval(hours => $3)) at time zone business_timezone as at from company where id = $1`, [A.id, today, hour])).at;
    const p = await publish(hr, { title: 'Synthetic scheduled policy', expiresOn: today });
    const notice = noticeFor(p.policyCode, 'Synthetic scheduled policy', today);
    const deps = { db: h.pool, providers: new Map(), systemUserId: hr.user };

    await runScheduledJobs(deps, await atLocal(7));
    expect(await bodies(hr)).not.toContain(notice);
    await runScheduledJobs(deps, await atLocal(10));
    await runScheduledJobs(deps, await atLocal(11));
    expect((await bodies(hr)).filter((b) => b === notice)).toHaveLength(1);
    const run = await h.one<{ outcome: string; detail: { day: string; events: number } }>(
      `select outcome, detail from scheduled_job_run where company_id = $1 and job_code = 'POLICY_EXPIRY' and run_key = $2`,
      [A.id, `POLICY_EXPIRY:${A.id}:${today}`],
    );
    expect(run).toMatchObject({ outcome: 'OK', detail: { day: today, events: 1 } });
  });
});
