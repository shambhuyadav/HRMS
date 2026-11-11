// Statutory filing files over HTTP (batch R4: CL-093 TDS quarterly summary, CL-105 PF new joiners, CL-106 EPFO ECR, CL-107 ESIC monthly
// and half-yearly; FR-036, FR-039, FR-107, FR-108), on real processed payroll. The packs are the seeded drafts, validated by one person
// and activated by another in this fixture's database only: that is not a legal validation, and the migration activates nothing.
// Synthetic people, identifiers and wages only; every figure is worked by hand in the comments (October 2026 has 31 days).
//
//   Asha    Basic 8,000 + DA 2,000 + HRA 4,000 from January: PF on 10,000 (1,200 / 833 / 367, EDLI wages 10,000); ESIC on 14,000
//           (105 / 455); PT 200 (Maharashtra slab 3); LWF in December 12 / 36.
//   Bharat  20,000 + 5,000 + 10,000: PF on 15,000 (1,800 / 1,250 / 550); above the ESIC ceiling; PT 200.
//   Chitra  joins 12 October on Asha's pay: 20 of 31 days, 5,161.29 + 1,290.32 + 2,580.65 = 9,032.26; PF on 6,451.61 (774 / 537 / 237;
//           wages 6,452 in whole rupees, half up as the PF pack recorded); ESIC 68 / 294 on 9,032.26 (up); PT 175 (slab 2).
//   Dev     Basic 3,00,000: PF on 15,000; above the ESIC ceiling; PT 200; TDS deducted (the only deductee); no UAN at first.
//   Esha    (December only, another department) Asha's pay, leaves 15 December after resigning: 6,774.19; ESIC 51 / 221; reason 2.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { APPROVE, approvedExit, calculate, calendar, CONFIG, createRun, grants, head, months, ok, person, PREPARE, PROCESS, processRun, REVIEW, reviewers, SALARY, salary, submitAndApprove } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { OUTPUT_CODES, sampleOf } from './outputs.js';

const REPORT: PermissionKey[] = ['payroll_report.read.amount', 'payroll_report.export.amount'];
const IDS: PermissionKey[] = ['employee.read.payroll_id'];
const DEFINE: PermissionKey[] = ['payroll_statutory.read.operational', 'payroll_statutory_format.define.operational'];
const ACCEPT: PermissionKey[] = ['payroll_statutory.read.operational', 'payroll_statutory_format.accept.operational'];

interface Status {
  status: 'AVAILABLE' | 'NOT_CONFIGURED';
  ready: boolean;
  missing: { code: string; pack?: string }[];
  selfIncluded?: boolean;
  rowCount?: number | null;
  rowErrors?: { employeeCode: string; code: string }[];
  identifierErrorsWithheld?: number;
  warnings: { code: string; count?: number }[];
  totals?: Record<string, string | number> | null;
  packs: { packCode: string; packRevision: number }[];
  files?: { format: string; fileName: string }[];
  format: { revision: number; formatReference: string } | null;
}
interface Format {
  id: string;
  outputCode: string;
  revision: number;
  state: string;
  sampleHash: string;
  validationReference: string | null;
}

describe.runIf(isModuleActive('statutory-files') && isModuleActive('payroll') && isModuleActive('lifecycle') && isModuleActive('payroll-extras'))('statutory filing files (CL-093, CL-105 to CL-107)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let idAdmin: TestActor;
  let maker: TestActor;
  let checker: TestActor;
  let filer: TestActor;
  let periods: Record<string, string>;
  let dept: string;
  let leaverDept: string;
  const e: Record<string, string> = {};
  const code: Record<string, string> = {};
  const run: Record<string, string> = {};

  const hex = () => Math.random().toString(16).slice(2, 10).toUpperCase();
  const department = async () => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, 'Synthetic', true) returning id`, [A.id, `D${hex()}`])).id;
  const status = (a: TestActor, output: string, query: string) => h.call(a, 'GET', `/v1/statutory-files/outputs/${output}/status?${query}`);
  const file = (a: TestActor, output: string, query: string) => h.call(a, 'GET', `/v1/statutory-files/outputs/${output}/file?${query}`);
  const setUp = (a: TestActor, outputCode: string, effectiveFrom = '2026-04-01', formatReference = `Synthetic ${outputCode} specification`) =>
    h.call(a, 'POST', '/v1/statutory-files/formats', { outputCode, formatReference, effectiveFrom });
  const accept = (a: TestActor, id: string, sampleHash: string, validationReference = 'Synthetic: portal validator run 0001') =>
    h.call(a, 'POST', `/v1/statutory-files/formats/${id}/acceptance`, { sampleHash, validationReference });
  /** One person sets the format up, another validates its sample and accepts it. */
  const accepted = async (outputCode: string) => {
    const f = await ok<Format>(await setUp(maker, outputCode), 201);
    const sample = await ok<{ sampleHash: string }>(await h.call(checker, 'GET', `/v1/statutory-files/formats/${f.id}/sample`));
    return ok<Format>(await accept(checker, f.id, sample.sampleHash));
  };
  const staff = async (key: string, name: string, pay: [string, string, string], joiningDate = '2026-01-05', departmentId = dept) => {
    e[key] = await person(h, A, hr, { joiningDate, departmentId, locationId: mh, name });
    code[key] = (await h.one<{ employee_code: string }>(`select employee_code from employee where id = $1`, [e[key]])).employee_code;
    const [basic, da, hra] = pay;
    await salary(h, preparer, e[key]!, {
      effectiveFrom: joiningDate,
      monthlyGross: String(Number(basic) + Number(da) + Number(hra)),
      components: [
        { code: 'SF_BASIC', amount: basic },
        ...(da !== '0' ? [{ code: 'SF_DA', amount: da }] : []),
        ...(hra !== '0' ? [{ code: 'SF_HRA', amount: hra }] : []),
      ],
    });
  };
  const identifiers = async (key: string, body: Record<string, string>) => ok(await h.call(idAdmin, 'PUT', `/v1/employees/${e[key]}/payroll-identifiers`, body));
  const processed = async (month: string, departmentIds: string[]) => {
    const created = await createRun(h, preparer, periods[month]!, { departmentIds });
    const calculated = await calculate(h, preparer, created.id);
    expect(calculated.state, JSON.stringify(calculated.exceptions)).toBe('CALCULATED');
    expect(calculated.exceptions.blocking).toBe(0);
    await submitAndApprove(h, { preparer, reviewer, approver }, created.id);
    await processRun(h, processor, created.id);
    return created.id;
  };
  let mh: string;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    idAdmin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['employee.manage.payroll_id', 'employee.manage.private'] });
    maker = await h.actor(A, 'PAYROLL_OPERATOR', { extra: ['payroll_statutory_format.define.operational'] });
    // A Payroll Approver's default scope is ASSIGNED; accepting a company's format needs a company-wide assignment.
    checker = await h.actor(A, 'PAYROLL_APPROVER', { extra: ['payroll_statutory_format.accept.operational'], scope: 'COMPANY' });
    filer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...REPORT, ...IDS, 'employee.read.private', 'payroll_challan.read.operational', 'payroll_challan.manage.operational'] });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);

    const PF_BASE = ['SF_BASIC', 'SF_DA'];
    const GROSS = ['SF_BASIC', 'SF_DA', 'SF_HRA'];
    await head(h, configA, configB, { code: 'SF_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'SF_DA', headType: 'EARNING', basis: 'FIXED', sequence: 2 });
    await head(h, configA, configB, { code: 'SF_HRA', headType: 'EARNING', basis: 'FIXED', sequence: 3 });
    await head(h, configA, configB, { code: 'SF_PF_EE', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'PF_EMPLOYEE', base: PF_BASE, sequence: 20 });
    await head(h, configA, configB, { code: 'SF_ESI_EE', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'ESIC_EMPLOYEE', base: GROSS, sequence: 21 });
    await head(h, configA, configB, { code: 'SF_PT', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'PROFESSIONAL_TAX', base: GROSS, sequence: 22 });
    await head(h, configA, configB, { code: 'SF_LWF_EE', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'LWF_EMPLOYEE', base: GROSS, sequence: 23 });
    await head(h, configA, configB, { code: 'SF_TDS', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'TDS', base: GROSS, sequence: 24 });
    await head(h, configA, configB, { code: 'SF_PF_EPS', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'PF_EMPLOYER_EPS', base: PF_BASE, sequence: 30 });
    await head(h, configA, configB, { code: 'SF_PF_EPF', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'PF_EMPLOYER_EPF', base: PF_BASE, sequence: 31 });
    await head(h, configA, configB, { code: 'SF_PF_EDLI', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'PF_EDLI', base: PF_BASE, sequence: 32 });
    await head(h, configA, configB, { code: 'SF_PF_ADMIN', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'PF_ADMIN', base: PF_BASE, sequence: 33 });
    await head(h, configA, configB, { code: 'SF_ESI_ER', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'ESIC_EMPLOYER', base: GROSS, sequence: 34 });
    await head(h, configA, configB, { code: 'SF_LWF_ER', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'LWF_EMPLOYER', base: GROSS, sequence: 35 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    const site = `L${hex()}`;
    mh = (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, 'Synthetic site', true) returning id`, [A.id, site])).id;
    await ok(await h.call(configA, 'POST', '/v1/statutory/pt-states', { locationCode: site, effectiveFrom: '2026-01-01', stateCode: 'MH' }), 201);
    dept = await department();
    leaverDept = await department();

    await staff('asha', 'Synthetic Asha', ['8000', '2000', '4000']);
    await staff('bharat', 'Synthetic Bharat', ['20000', '5000', '10000']);
    await staff('chitra', 'Synthetic Chitra', ['8000', '2000', '4000'], '2026-10-12');
    await staff('dev', 'Synthetic Dev', ['300000', '0', '0']);
    await staff('esha', 'Synthetic Esha', ['8000', '2000', '4000'], '2026-01-05', leaverDept);
    await identifiers('asha', { uan: '100000000001', esicIpNumber: '3000000001' });
    await identifiers('bharat', { uan: '100000000002' });
    await identifiers('chitra', { uan: '100000000003', esicIpNumber: '3000000003' });
    await identifiers('esha', { uan: '100000000005', esicIpNumber: '3000000005' });
    await ok(await h.call(idAdmin, 'POST', `/v1/employees/${e.chitra}/record-sections/family-members`, { relationship: 'SPOUSE', fullName: 'Synthetic Spouse', dependant: false }), 201);
  }, 600_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('a fresh company: nothing is activated, no format is accepted, and every output answers NOT_CONFIGURED naming what is missing', async () => {
    // The migration and provisioning activate nothing: every statutory pack is a draft, and no format exists.
    expect((await h.db.query(`select distinct state from statutory_rule_pack where company_id = $1`, [A.id])).rows).toEqual([{ state: 'DRAFT' }]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from statutory_file_format where company_id = $1`, [A.id])).n).toBe(0);
    // The new operational group is classified OPERATIONAL (an unclassified group would read as CONFIDENTIAL).
    expect((await h.db.query(`select classification from confidential_field_policy where company_id = $1 and resource_code = 'payroll_statutory_format' and field_group = 'operational'`, [A.id])).rows).toEqual([
      { classification: 'OPERATIONAL' },
    ]);
    const list = await ok<{ items: { code: string; status: string; missing: { code: string }[] }[] }>(await h.call(checker, 'GET', '/v1/statutory-files/outputs'));
    expect(list.items.map((i) => i.code)).toEqual([...OUTPUT_CODES]);
    for (const i of list.items) expect([i.status, i.missing.map((m) => m.code)]).toEqual(['NOT_CONFIGURED', ['RULE_PACK_NOT_ACTIVE', 'FORMAT_NOT_ACCEPTED']]);
    const tds = await ok<Status>(await status(filer, 'TDS_QUARTERLY', 'fiscalYear=2026-27&quarter=3'));
    expect(tds).toMatchObject({ status: 'NOT_CONFIGURED', ready: false, missing: [{ code: 'RULE_PACK_NOT_ACTIVE', pack: 'INCOME_TAX' }, { code: 'FORMAT_NOT_ACCEPTED' }] });
    expect(tds.totals).toBeUndefined();
    const refused = await file(filer, 'ESIC_HALF_YEARLY', 'fiscalYear=2026-27&half=2');
    expect([refused.statusCode, refused.json().error, refused.json().details.missing.map((m: { code: string }) => m.code)]).toEqual([409, 'NOT_CONFIGURED', ['RULE_PACK_NOT_ACTIVE', 'FORMAT_NOT_ACCEPTED']]);
    // A period is required, and checked.
    expect((await status(filer, 'TDS_QUARTERLY', 'fiscalYear=2026-28&quarter=3')).json().error).toBe('INVALID_FISCAL_YEAR');
    expect((await status(filer, 'PF_ECR', '')).json().error).toBe('RUN_REQUIRED');
    expect((await status(filer, 'NOT_AN_OUTPUT', '')).statusCode).toBe(400);
  });

  it('format acceptance: one person sets it up, another validates its sample with a reference; never the author; never edited', async () => {
    expect((await setUp(hr, 'PF_ECR')).statusCode).toBe(403);
    expect((await setUp(checker, 'PF_ECR')).statusCode).toBe(403);
    const f = await ok<Format>(await setUp(maker, 'PF_ECR', '2026-04-01', 'ECR 2.0'), 201);
    expect(f).toMatchObject({ outputCode: 'PF_ECR', revision: 1, state: 'AWAITING_VALIDATION', sampleHash: sampleOf('PF_ECR').hash, validationReference: null });
    const sample = await ok<{ label: string; sampleHash: string; matchesRecorded: boolean; files: { format: string; content: string }[] }>(await h.call(checker, 'GET', `/v1/statutory-files/formats/${f.id}/sample`));
    expect(sample).toMatchObject({ label: 'SAMPLE_NOT_FOR_FILING', sampleHash: f.sampleHash, matchesRecorded: true });
    expect(sample.files[0]!.content.split('\r\n')[0]).toBe('999999999901#~#SAMPLE MEMBER ONE#~#15000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0');
    const download = await h.call(checker, 'GET', `/v1/statutory-files/formats/${f.id}/sample/txt`);
    expect([download.statusCode, download.body]).toEqual([200, sample.files[0]!.content]);
    // The author never validates their own format, even holding the checker's duty on another assignment.
    const both = await h.actor(A, 'HR_ADMINISTRATOR', { user: maker.user, extra: ACCEPT });
    expect([(await accept(both, f.id, f.sampleHash)).statusCode, (await accept(both, f.id, f.sampleHash)).json().error]).toEqual([403, 'NOT_INDEPENDENT']);
    expect((await accept(maker, f.id, f.sampleHash)).statusCode).toBe(403);
    expect((await accept(checker, f.id, '0'.repeat(64))).json().error).toBe('SAMPLE_MISMATCH');
    const done = await ok<Format>(await accept(checker, f.id, f.sampleHash, 'Synthetic: EPFO ECR validation utility run 0001'));
    expect(done).toMatchObject({ state: 'ACCEPTED', validationReference: 'Synthetic: EPFO ECR validation utility run 0001' });
    expect((await accept(checker, f.id, f.sampleHash)).json().error).toBe('INVALID_STATE');
    // Never edited, and the database itself refuses the author's acceptance and another sample.
    await expect(h.db.query(`update statutory_file_format set format_reference = 'Changed' where id = $1`, [f.id])).rejects.toThrow();
    await expect(h.db.query(`delete from statutory_file_format_decision where format_id = $1`, [f.id])).rejects.toThrow();
    const second = await ok<Format>(await setUp(maker, 'PF_ECR', '2026-06-01', 'ECR 2.0 (second)'), 201);
    const direct = (by: string, hash: string) =>
      h.db.query(`insert into statutory_file_format_decision (company_id, format_id, decision, sample_hash, reference, decided_by, acting_assignment_id) values ($1, $2, 'ACCEPTED', $3, 'Synthetic', $4, $5)`, [
        A.id,
        second.id,
        hash,
        by,
        maker.assignment,
      ]);
    await expect(direct(maker.user, second.sampleHash)).rejects.toMatchObject({ code: '23514' });
    await expect(direct(checker.user, 'a'.repeat(64))).rejects.toMatchObject({ code: '23514' });
    // Withdrawn for good, with a reason: the earlier accepted revision is in force again.
    await ok(await accept(checker, second.id, second.sampleHash));
    const inForce = async () => (await ok<{ inForce: { format: { revision: number } | null }[] }>(await h.call(checker, 'GET', '/v1/statutory-files/formats?outputCode=PF_ECR'))).inForce[0]!.format?.revision;
    expect(await inForce()).toBe(2);
    expect((await h.call(maker, 'POST', `/v1/statutory-files/formats/${second.id}/withdrawal`, { reason: 'Synthetic' })).statusCode).toBe(403);
    expect((await ok<Format>(await h.call(checker, 'POST', `/v1/statutory-files/formats/${second.id}/withdrawal`, { reason: 'Synthetic: superseded by the portal' }))).state).toBe('WITHDRAWN');
    expect((await h.call(checker, 'POST', `/v1/statutory-files/formats/${second.id}/withdrawal`, { reason: 'Again' })).json().error).toBe('INVALID_STATE');
    expect(await inForce()).toBe(1);
    const audit = await h.db.query(`select action from audit_event where company_id = $1 and resource_code = 'statutory_file_format' order by occurred_at, action`, [A.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['CREATE', 'ACCEPT', 'CREATE', 'ACCEPT', 'WITHDRAW']);
    // Every other output gets an accepted format too, except the new joiners' (its gate is shown later).
    for (const outputCode of OUTPUT_CODES.filter((c) => c !== 'PF_ECR' && c !== 'PF_NEW_JOINERS')) expect((await accepted(outputCode)).state).toBe('ACCEPTED');
  });

  it('gate on the pack: with its format accepted, the TDS summary stays NOT_CONFIGURED while INCOME_TAX has no ACTIVE revision', async () => {
    const tds = await ok<Status>(await status(filer, 'TDS_QUARTERLY', 'fiscalYear=2026-27&quarter=3'));
    expect(tds).toMatchObject({ status: 'NOT_CONFIGURED', missing: [{ code: 'RULE_PACK_NOT_ACTIVE', pack: 'INCOME_TAX' }], format: { revision: 1 } });
    // Validated by one person and activated by another, in this test database only (not a legal validation).
    const packV = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.validate.operational'] });
    const packA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.activate.operational'] });
    const packs = (await ok<{ items: { id: string; code: string; revision: number; version: number }[] }>(await h.call(hr, 'GET', '/v1/statutory-rule-packs'))).items;
    for (const c of ['PF', 'ESIC', 'PT_MH', 'LWF_MH', 'INCOME_TAX']) {
      const p = packs.find((x) => x.code === c && x.revision === 1)!;
      const v = await ok<{ version: number }>(
        await h.call(packV, 'POST', `/v1/statutory-rule-packs/${p.id}/validate`, { sourceReference: 'Synthetic: the seeded draft', validationReference: 'Synthetic: test fixture only', expectedVersion: p.version }),
      );
      await ok(await h.call(packA, 'POST', `/v1/statutory-rule-packs/${p.id}/activate`, { expectedVersion: v.version }));
    }
    run.october = await processed('2026-10', [dept]);
    await approvedExit(h, A, e.esha!, '2026-11-20', '2026-12-15');
    run.december = await processed('2026-12', [dept, leaverDept]);
  });

  it('the status lists the UAN and IP number errors only to a reader of the payroll identifiers; anyone else gets how many rows have one', async () => {
    const q = `runId=${run.october}`;
    const noIds = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT });
    const s = await ok<Status>(await status(noIds, 'PF_ECR', q));
    // Dev has no UAN yet: the file is not ready, but who lacks one is not said.
    expect(s).toMatchObject({ status: 'AVAILABLE', ready: false, rowErrors: [], identifierErrorsWithheld: 1 });
    expect(JSON.stringify(s)).not.toContain(code.dev!);
    expect(JSON.stringify(s)).not.toContain('MISSING_UAN');
    expect(await ok<Status>(await status(filer, 'PF_ECR', q))).toMatchObject({ rowErrors: [{ employeeCode: code.dev, code: 'MISSING_UAN' }], identifierErrorsWithheld: 0 });
    // A file without identifiers has no such errors to withhold.
    expect(await ok<Status>(await status(noIds, 'PT_STATE_RETURN', q))).toMatchObject({ identifierErrorsWithheld: 0 });
  });

  it('CL-106 ECR: row errors listed (no UAN), no partial file; then the file, named after the pinned PF revision, audited', async () => {
    const q = `runId=${run.october}`;
    const before = await ok<Status>(await status(filer, 'PF_ECR', q));
    expect(before).toMatchObject({ status: 'AVAILABLE', ready: false, rowErrors: [{ employeeCode: code.dev, code: 'MISSING_UAN' }], packs: [{ packCode: 'PF', packRevision: 1 }], format: { revision: 1, formatReference: 'ECR 2.0' } });
    const refused = await file(filer, 'PF_ECR', q);
    expect([refused.statusCode, refused.json().error, refused.json().details.errors]).toEqual([422, 'STATUTORY_FILE_ROW_ERRORS', [{ employeeCode: code.dev, code: 'MISSING_UAN', field: 'uan' }]]);
    await identifiers('dev', { uan: '100000000004' });
    const now = await ok<Status>(await status(filer, 'PF_ECR', q));
    expect(now).toMatchObject({ ready: true, rowCount: 4, rowErrors: [], selfIncluded: false });
    expect(now.totals).toEqual({ members: 4, grossWages: '358032', epfWages: '46452', epsWages: '46452', edliWages: '46452', epfContribution: '5574', epsContribution: '3870', epfEpsDifference: '1704', ncpDays: '0' });
    const res = await file(filer, 'PF_ECR', q);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toContain(`PF_ECR_2026-10_run-${run.october!.slice(0, 8)}-rev1_pack-PF-rev1.txt`);
    expect(now.files).toEqual([{ format: 'txt', fileName: `PF_ECR_2026-10_run-${run.october!.slice(0, 8)}-rev1_pack-PF-rev1.txt` }]);
    // No header line, no trailing line ending; whole rupees (Chitra's 9,032.26 and 6,451.61 half up).
    expect(res.body.endsWith('\n')).toBe(false);
    expect(res.body.split('\r\n').sort()).toEqual(
      [
        '100000000001#~#Synthetic Asha#~#14000#~#10000#~#10000#~#10000#~#1200#~#833#~#367#~#0#~#0',
        '100000000002#~#Synthetic Bharat#~#35000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0',
        '100000000003#~#Synthetic Chitra#~#9032#~#6452#~#6452#~#6452#~#774#~#537#~#237#~#0#~#0',
        '100000000004#~#Synthetic Dev#~#300000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0',
      ].sort(),
    );
    const audit = await h.one<{ record_key: string; after_values: { operational: Record<string, unknown> } }>(
      `select record_key, after_values from audit_event where company_id = $1 and resource_code = 'statutory_file' and action = 'DOWNLOAD' order by occurred_at desc limit 1`,
      [A.id],
    );
    expect(audit.record_key).toBe(run.october);
    expect(audit.after_values.operational).toMatchObject({ outputCode: 'PF_ECR', period: '2026-10', format: 'txt', rows: 4, packs: [{ packCode: 'PF', packRevision: 1 }], formatRevision: 1 });
    // No amount is audited: only the operational group, holding what was produced and from what.
    expect(Object.keys(audit.after_values)).toEqual(['operational']);
    expect(Object.keys(audit.after_values.operational).sort()).toEqual(['contentHash', 'fileName', 'format', 'formatId', 'formatRevision', 'outputCode', 'packs', 'period', 'rows', 'runId']);
  });

  it('who may: the report grant for the status, the export grant and the payroll identifiers for the file, a whole-company scope, and never one’s own pay', async () => {
    const q = `runId=${run.october}`;
    expect((await status(hr, 'PF_ECR', q)).statusCode).toBe(403);
    const noIds = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT });
    expect((await status(noIds, 'PF_ECR', q)).statusCode).toBe(200);
    expect((await file(noIds, 'PF_ECR', q)).statusCode).toBe(403);
    // The PT summary carries no identifiers: the export grant is enough.
    expect((await file(noIds, 'PT_STATE_RETURN', q)).statusCode).toBe(200);
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...REPORT, ...IDS], departmentFilter: dept });
    expect((await status(narrow, 'PF_ECR', q)).json().error).toBe('COMPANY_SCOPE_REQUIRED');
    const own = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...REPORT, ...IDS], employeeId: e.asha! });
    const mine = await ok<Status>(await status(own, 'PF_ECR', q));
    expect(mine).toMatchObject({ status: 'AVAILABLE', ready: false, selfIncluded: true, totals: null, rowErrors: [] });
    expect([(await file(own, 'PF_ECR', q)).statusCode, (await file(own, 'PF_ECR', q)).json().error]).toEqual([403, 'SELF_INCLUDED']);
    // Bharat is not insured under ESIC, so a user linked to him may produce the ESIC file.
    const bharat = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...REPORT, ...IDS], employeeId: e.bharat! });
    expect((await file(bharat, 'ESIC_MONTHLY', q)).statusCode).toBe(200);
    // Only processed payroll: a calculated run is refused.
    const draft = await createRun(h, preparer, periods['2026-11']!, { departmentIds: [dept] });
    await calculate(h, preparer, draft.id);
    expect((await status(filer, 'PF_ECR', `runId=${draft.id}`)).json().error).toBe('RUN_NOT_PROCESSED');
    expect((await file(filer, 'PF_ECR', `runId=${run.october}&format=csv`)).json().error).toBe('FORMAT_NOT_OFFERED');
  });

  it('CL-107 ESIC monthly: insured persons only, days and wages as recorded, a leaver’s reason code and last working day; XLSX and CSV', async () => {
    const october = await ok<Status>(await status(filer, 'ESIC_MONTHLY', `runId=${run.october}`));
    expect(october).toMatchObject({ ready: true, rowCount: 2, warnings: [{ code: 'NOT_COVERED', count: 2 }], totals: { insuredPersons: 2, wages: '23032.26', employeeContribution: '173.00', employerContribution: '749.00' } });
    const csv = await file(filer, 'ESIC_MONTHLY', `runId=${run.october}&format=csv`);
    expect(csv.statusCode, csv.body).toBe(200);
    const lines = csv.body.trimEnd().split('\r\n');
    expect(lines[0]).toContain('"IP Number (10 Digits)"');
    expect(lines.slice(1).sort()).toEqual(['"3000000001","Synthetic Asha","31","14000.00","0",""', '"3000000003","Synthetic Chitra","20","9032.26","0",""']);
    const december = await file(filer, 'ESIC_MONTHLY', `runId=${run.december}&format=csv`);
    expect(december.body).toContain('"3000000005","Synthetic Esha","15","6774.19","2","15/12/2026"');
    const xlsx = await file(filer, 'ESIC_MONTHLY', `runId=${run.october}`);
    expect([xlsx.statusCode, xlsx.headers['content-type'], xlsx.rawPayload.subarray(0, 2).toString('latin1')]).toEqual([200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PK']);
    expect(xlsx.headers['content-disposition']).toContain('_pack-ESIC-rev1.xlsx');
    // A portal upload holds the layout only: no source sheet.
    expect(xlsx.rawPayload.toString('latin1')).not.toContain('Produced from pinned pack revisions');
  });

  it('CL-107 ESIC half-yearly: October to March from both processed runs, with its source stated in the file', async () => {
    const s = await ok<Status>(await status(filer, 'ESIC_HALF_YEARLY', 'fiscalYear=2026-27&half=2'));
    expect(s).toMatchObject({ ready: true, rowCount: 3, packs: [{ packCode: 'ESIC', packRevision: 1 }], totals: { insuredPersons: 3, wages: '57806.45', employeeContribution: '434.00', employerContribution: '1880.00' } });
    const csv = await file(filer, 'ESIC_HALF_YEARLY', 'fiscalYear=2026-27&half=2&format=csv');
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain('"Produced from pinned pack revisions","ESIC revision 1"');
    expect(csv.body).toContain(`"3000000001","Synthetic Asha","${code.asha}","2","62","28000.00","210.00","910.00","1120.00"`);
    expect(csv.body).toContain(`"3000000003","Synthetic Chitra","${code.chitra}","2","51","23032.26","173.00","749.00","922.00"`);
    expect(csv.body).toContain(`"3000000005","Synthetic Esha","${code.esha}","1","15","6774.19","51.00","221.00","272.00"`);
    expect(csv.headers['content-disposition']).toContain('ESIC_HALF_YEARLY_2026-27-H2_pack-ESIC-rev1.csv');
  });

  it('CL-105 PF new joiners: NOT_CONFIGURED until its format is accepted; then the month’s joiners, the spouse’s name only when readable', async () => {
    const q = `runId=${run.october}`;
    const gate = await ok<Status>(await status(filer, 'PF_NEW_JOINERS', q));
    expect(gate).toMatchObject({ status: 'NOT_CONFIGURED', missing: [{ code: 'FORMAT_NOT_ACCEPTED' }] });
    expect((await file(filer, 'PF_NEW_JOINERS', q)).statusCode).toBe(409);
    await accepted('PF_NEW_JOINERS');
    const csv = await file(filer, 'PF_NEW_JOINERS', q);
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain(`"${code.chitra}","100000000003","Synthetic Chitra","12/10/2026","Synthetic Spouse","S"`);
    expect(csv.body).not.toContain('Synthetic Asha');
    const noFamily = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...REPORT, ...IDS] });
    const s = await ok<Status>(await status(noFamily, 'PF_NEW_JOINERS', q));
    expect(s.warnings.map((w) => w.code)).toEqual(['RELATIVE_NAME_OMITTED']);
    const plain = await file(noFamily, 'PF_NEW_JOINERS', q);
    expect(plain.body).toContain(`"${code.chitra}","100000000003","Synthetic Chitra","12/10/2026"\r\n`);
    expect(plain.body).not.toContain('Synthetic Spouse');
  });

  it('C1: a scoped DENY of the payroll identifiers on another assignment of the user refuses the files carrying them; of the family section, drops the relative', async () => {
    const q = `runId=${run.october}`;
    /** A second assignment of `user` in a company role that DENYs `permission`, over one department only (C1 scoped DENY). */
    const denyOver = async (user: string, permission: string, departmentId: string) => {
      const [resource, action, fieldGroup] = permission.split('.');
      const role = (await h.one<{ id: string }>(`insert into role (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, `DENY_${hex()}`])).id;
      const permissionId = (await h.one<{ id: string }>(`select id from permission where resource = $1 and action = $2 and field_group = $3`, [resource, action, fieldGroup])).id;
      await h.db.query(`insert into role_permission (company_id, role_id, permission_id, effect) values ($1, $2, $3, 'DENY')`, [A.id, role, permissionId]);
      const seat = (
        await h.one<{ id: string }>(
          `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, created_by)
           values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', 'ACTIVE', $4, now(), $5) returning id`,
          [A.id, user, role, await h.makeUser(), SYSTEM_ACTOR_ID],
        )
      ).id;
      await h.db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`, [A.id, seat, departmentId]);
    };

    // The payroll identifiers, denied over the leavers' department: every file carrying UAN or IP numbers is refused, and audited.
    const idUser = await h.makeUser();
    const ids = await h.actor(A, 'HR_ADMINISTRATOR', { user: idUser, extra: [...REPORT, ...IDS] });
    expect((await file(ids, 'PF_ECR', q)).statusCode).toBe(200);
    await denyOver(idUser, 'employee.read.payroll_id', leaverDept);
    const refused = await file(ids, 'PF_ECR', q);
    expect([refused.statusCode, refused.json().error]).toEqual([403, 'PAYROLL_ID_SCOPE_DENIED']);
    expect((await file(ids, 'ESIC_MONTHLY', `${q}&format=csv`)).json().error).toBe('PAYROLL_ID_SCOPE_DENIED');
    const audited = await h.db.query(`select 1 from audit_event where company_id = $1 and action = 'ACCESS_DENIED' and actor_user_id = $2 and after_values ->> 'reason' = 'SCOPED_DENY'`, [A.id, idUser]);
    expect(audited.rowCount).toBeGreaterThan(0);
    // The deny matches its permission only: a file without identifiers is still produced.
    expect((await file(ids, 'PT_STATE_RETURN', q)).statusCode).toBe(200);

    // The family section (employee.private), denied over the leavers' department: the new joiners file leaves the relative out.
    const familyUser = await h.makeUser();
    const family = await h.actor(A, 'HR_ADMINISTRATOR', { user: familyUser, extra: [...REPORT, ...IDS, 'employee.read.private'] });
    expect((await file(family, 'PF_NEW_JOINERS', q)).body).toContain('Synthetic Spouse');
    await denyOver(familyUser, 'employee.read.private', leaverDept);
    const plain = await file(family, 'PF_NEW_JOINERS', q);
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.body).toContain('Synthetic Chitra');
    expect(plain.body).not.toContain('Synthetic Spouse');
    expect((await ok<Status>(await status(family, 'PF_NEW_JOINERS', q))).warnings.map((w) => w.code)).toEqual(['RELATIVE_NAME_OMITTED']);
  });

  it('CL-093 TDS quarterly: deductees, salary and TDS deducted from the Form 24Q working data, TDS deposited from the challans, the difference', async () => {
    const tds = await h.db.query<{ month: string; tds: string }>(
      `select to_char(ru.service_start, 'YYYY-MM') as month, sum(l.amount)::numeric(19, 2)::text as tds
         from payroll_line l join payroll_record r on r.id = l.record_id join payroll_run ru on ru.id = r.run_id join pay_component c on c.id = l.component_id
        where r.company_id = $1 and c.code = 'SF_TDS' and ru.state = 'PROCESSED_LOCKED' group by ru.service_start order by 1`,
      [A.id],
    );
    expect(tds.rows.map((r) => r.month)).toEqual(['2026-10', '2026-12']);
    const [oct, dec] = tds.rows.map((r) => r.tds) as [string, string];
    await ok(await h.call(filer, 'POST', '/v1/payroll-extras/tds-challans', { month: '2026-10', section: '192', bsrCode: '0510001', challanSerial: '1', depositDate: '2026-11-07', amount: oct }), 201);
    const s = await ok<Status>(await status(filer, 'TDS_QUARTERLY', 'fiscalYear=2026-27&quarter=3'));
    const total = (Number(oct) + Number(dec)).toFixed(2);
    expect(s).toMatchObject({ status: 'AVAILABLE', ready: true, packs: [{ packCode: 'INCOME_TAX', packRevision: 1 }], warnings: [{ code: 'SHORT_DEPOSITED' }] });
    expect(s.totals).toEqual({ employees: 5, deductees: 1, taxableSalary: expect.any(String), tdsDeducted: total, challans: 1, tdsDeposited: oct, difference: dec });
    const csv = await file(filer, 'TDS_QUARTERLY', 'fiscalYear=2026-27&quarter=3&format=csv');
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain('"Produced from pinned pack revisions","INCOME_TAX revision 1"');
    expect(csv.body).toContain(`"2026-10","4","1",`);
    expect(csv.body).toContain(`"QUARTER","5","1","${String(s.totals!.taxableSalary)}","${total}","1","${oct}","${dec}"`);
  });

  it('PT and LWF state summaries: employees and amounts per slab and state, and a month that is not a contribution month', async () => {
    const pt = await file(filer, 'PT_STATE_RETURN', `runId=${run.october}&format=csv`);
    expect(pt.statusCode, pt.body).toBe(200);
    const table = pt.body.split('\r\n\r\n')[1]!.trimEnd().split('\r\n');
    expect(table).toEqual([
      '"State","Slab","Monthly gross up to","Employees","Tax per employee","Tax"',
      '"MH","2","10000.00","1","175.00","175.00"',
      '"MH","3","","3","200.00","600.00"',
      '"MH","TOTAL","","4","","775.00"',
    ]);
    expect(pt.body).toContain('"Produced from pinned pack revisions","PT_MH revision 1"');
    const october = await ok<Status>(await status(filer, 'LWF_STATE_RETURN', `runId=${run.october}`));
    expect(october).toMatchObject({ status: 'AVAILABLE', rowCount: 0, warnings: [{ code: 'NOT_A_CONTRIBUTION_MONTH', count: 4 }] });
    const lwf = await file(filer, 'LWF_STATE_RETURN', `runId=${run.december}&format=csv`);
    expect(lwf.body.split('\r\n\r\n')[1]!.trimEnd().split('\r\n').slice(1)).toEqual(['"MH","2","","5","60.00","180.00","240.00"', '"MH","TOTAL","","5","60.00","180.00","240.00"']);
  });

  it('gates after the fact: a retired PF revision makes the ECR NOT_CONFIGURED; a format whose sample the build no longer renders does not apply', async () => {
    const packA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.activate.operational'] });
    const pf = (await ok<{ items: { id: string; code: string; state: string; version: number }[] }>(await h.call(hr, 'GET', '/v1/statutory-rule-packs'))).items.find((p) => p.code === 'PF' && p.state === 'ACTIVE')!;
    await ok(await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pf.id}/retire`, { expectedVersion: pf.version, reason: 'Synthetic: the CA withdrew it' }));
    const q = `runId=${run.october}`;
    expect(await ok<Status>(await status(filer, 'PF_ECR', q))).toMatchObject({ status: 'NOT_CONFIGURED', missing: [{ code: 'RULE_PACK_NOT_ACTIVE', pack: 'PF' }] });
    expect((await file(filer, 'PF_ECR', q)).statusCode).toBe(409);
    // An accepted revision recorded against another layout (as an older build's would be) is in force but does not apply.
    const id = (
      await h.one<{ id: string }>(
        `insert into statutory_file_format (company_id, output_code, revision, format_reference, effective_from, layout_version, sample_hash, created_by, acting_assignment_id)
         values ($1, 'ESIC_MONTHLY', 9, 'Older layout', '2026-11-01', 1, $2, $3, $4) returning id`,
        [A.id, 'f'.repeat(64), maker.user, maker.assignment],
      )
    ).id;
    await h.db.query(`insert into statutory_file_format_decision (company_id, format_id, decision, sample_hash, reference, decided_by, acting_assignment_id) values ($1, $2, 'ACCEPTED', $3, 'Synthetic', $4, $5)`, [
      A.id,
      id,
      'f'.repeat(64),
      checker.user,
      checker.assignment,
    ]);
    expect(await ok<Status>(await status(filer, 'ESIC_MONTHLY', q))).toMatchObject({ status: 'NOT_CONFIGURED', missing: [{ code: 'FORMAT_SAMPLE_CHANGED' }] });
    expect((await accept(checker, id, 'f'.repeat(64))).json().error).toBe('INVALID_STATE');
  });
});
