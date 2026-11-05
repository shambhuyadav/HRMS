// Appraisal report, export and KRA/goal upload over HTTP (FR-041, FR-044; F1 "no forced distribution" and "upload
// creates DRAFT"; DF02; DF09; I-13), with the caller's own goal-upload batches and resuming one held for the malware scan
// (FR-106). Synthetic data only: example.test addresses and made-up names and goals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../../db/queryable.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { AccessGrant } from '../access/authorize.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { isModuleActive } from '../registry.js';
import { appraisalWorld, confirm, enrol, HR_OVERSIGHT, openCycle, person, RATER, rate, selfAssess, type World } from './appraisal.fixtures.js';
import { cycleExport, EXPORT_ROW_LIMIT } from './reports.js';

describe.runIf(isModuleActive('appraisal'))('appraisal: reports, export and goal upload', () => {
  let h: Harness;
  let A: Company;
  let w: World;
  let cycle: { id: string; code: string };
  let otherManagerEmp: string;
  let otherManager: TestActor;
  let hrFin: TestActor;
  const codes: Record<string, string> = {};

  const codeOf = async (id: string) => (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [id])).c;
  const appraisee = async (managerId: string, name: string, departmentId?: string) => {
    const id = await person(h, A, w.hr, { managerId, name, ...(departmentId ? { departmentId } : {}) });
    codes[name] = await codeOf(id);
    return { id, actor: await h.actor(A, 'EMPLOYEE', { employeeId: id }) };
  };
  const upload = (a: TestActor, lines: string[], idempotencyKey: string) =>
    h.call(a, 'POST', '/v1/appraisal-goal-imports', { fileName: 'goals.csv', contentBase64: Buffer.from(`${lines.join('\n')}\n`).toString('base64'), idempotencyKey });
  const HEADER = 'cycleCode,employeeCode,sequence,description,target,weight';

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await appraisalWorld(h, A);
    cycle = await openCycle(h, w);
    otherManagerEmp = await person(h, A, w.hr, { name: 'Synthetic Finance Manager', departmentId: A.financeDept });
    otherManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: otherManagerEmp, extra: RATER });
    hrFin = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept, extra: HR_OVERSIGHT });

    // Two completed (4.10 and 3.00), one under rating (finance), one cancelled.
    const done1 = await appraisee(w.managerEmp, 'Synthetic Done One');
    const id1 = (await enrol(h, w.hr, cycle.id, done1.id)).id;
    await selfAssess(h, done1.actor, id1, [3, 3, 3]);
    await rate(h, w.manager, id1, [3, 4, 5]);
    await confirm(h, w.rev1, id1);
    const done2 = await appraisee(w.managerEmp, '=Synthetic Formula Person');
    const id2 = (await enrol(h, w.hr, cycle.id, done2.id)).id;
    await selfAssess(h, done2.actor, id2, [3, 3, 3]);
    await rate(h, w.manager, id2, [3, 3, 3]);
    await confirm(h, w.rev1, id2);
    const pending = await appraisee(otherManagerEmp, 'Synthetic Finance Person', A.financeDept);
    const id3 = (await enrol(h, w.hr, cycle.id, pending.id)).id;
    await selfAssess(h, pending.actor, id3, [4, 4, 4]);
    const gone = await appraisee(w.managerEmp, 'Synthetic Gone Person');
    const v4 = await enrol(h, w.hr, cycle.id, gone.id);
    expect((await h.call(w.hr, 'POST', `/v1/appraisals/${v4.id}/cancel`, { reason: 'Synthetic leaver', expectedVersion: v4.version })).statusCode).toBe(200);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('reports the selected population by state; exact result counts only with the rating grant, no targets (FR-044)', async () => {
    const full = (await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${cycle.id}/report`)).json();
    expect(full).toMatchObject({
      cycle: { id: cycle.id, code: cycle.code },
      filters: { departmentId: null },
      scope: 'COMPANY',
      population: 3,
      byState: { DRAFT: 0, SUBMITTED: 1, IN_REVIEW: 0, RETURNED: 0, APPROVED: 2, CANCELLED: 1 },
      ratings: { completed: 2, distribution: [{ finalRating: '3.00', count: 1 }, { finalRating: '4.10', count: 1 }] },
    });
    // The counts reconcile to the completed population; F1: no forced distribution, bins or targets.
    const distribution = full.ratings.distribution as { count: number }[];
    expect(distribution.reduce((s, d) => s + d.count, 0)).toBe(full.byState.APPROVED);
    expect(JSON.stringify(full)).not.toMatch(/target|expected|bell/i);
    // Without the confidential grant the rating part is absent, not hidden.
    const plain = (await h.call(w.hrPlain, 'GET', `/v1/appraisal-cycles/${cycle.id}/report`)).json();
    expect(plain).toMatchObject({ population: 3, byState: { APPROVED: 2 } });
    expect(plain).not.toHaveProperty('ratings');
    // Filters and row scope narrow the population.
    expect((await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${cycle.id}/report?departmentId=${A.financeDept}`)).json()).toMatchObject({ population: 1, byState: { SUBMITTED: 1, APPROVED: 0 } });
    expect((await h.call(hrFin, 'GET', `/v1/appraisal-cycles/${cycle.id}/report`)).json()).toMatchObject({ population: 1, ratings: { completed: 0, distribution: [] } });
    // The team manager (rating grant) sees the two completed team members; the employee has no report duty.
    expect((await h.call(w.manager, 'GET', `/v1/appraisal-cycles/${cycle.id}/report`)).json()).toMatchObject({ scope: 'TEAM', population: 2, ratings: { completed: 2 } });
    expect((await h.call(otherManager, 'GET', `/v1/appraisal-cycles/${cycle.id}/report`)).json()).toMatchObject({ population: 1 });
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: await person(h, A, w.hr) });
    expect((await h.call(employee, 'GET', `/v1/appraisal-cycles/${cycle.id}/report`)).statusCode).toBe(403);
  });

  it('exports within scope with restricted columns left out entirely, context lines and formula-safe cells (DF09)', async () => {
    const plain = await h.call(w.hrPlain, 'GET', `/v1/appraisal-cycles/${cycle.id}/export`);
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.headers['content-type']).toContain('text/csv');
    const plainLines = plain.body.split('\r\n');
    const { startDate, endDate } = (await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${cycle.id}`)).json();
    // DF09, FR-065, I-66: the leading block every report file carries, ended by a blank line.
    const blank = plainLines.indexOf('');
    const context = Object.fromEntries(plainLines.slice(0, blank).map((l) => l.replace(/^"|"$/g, '').split('","')));
    expect(Object.keys(context)).toEqual(['Report', 'Report code', 'Company', 'Acting role', 'Row scope', 'Period', 'Filters', 'Generated at', 'Rows']);
    expect(context).toMatchObject({ Report: 'Appraisal export', 'Report code': 'APPRAISAL_EXPORT', 'Acting role': 'HR_ADMINISTRATOR', 'Row scope': 'COMPANY', Period: `${startDate} to ${endDate}`, Filters: `cycle: ${cycle.code}; department: all in scope` });
    expect(context['Generated at']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /);
    expect(plainLines[blank + 1]).toMatch(/^"Employee code"/);
    expect(Number(context.Rows)).toBe(plainLines.slice(blank + 2).filter((l) => l !== '').length);
    // A filtered reader's file says so.
    const scoped = (await h.call(hrFin, 'GET', `/v1/appraisal-cycles/${cycle.id}/export`)).body;
    expect(scoped).toContain('"Row scope","COMPANY; departments FIN"');
    const header = plainLines.find((l) => l.startsWith('"Employee code"'))!;
    expect(header).not.toContain('Final rating');
    expect(plain.body).not.toMatch(/\b4\.10\b|\b3\.00\b/);
    expect(plain.body).toContain(`"'=Synthetic Formula Person"`);

    const full = await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${cycle.id}/export`);
    expect(full.body).toContain('"Weighted manager result","Final rating"');
    const row = full.body.split('\r\n').find((l) => l.startsWith(`"${codes['Synthetic Done One']}"`))!;
    expect(row).toContain('"APPROVED"');
    expect(row).toMatch(/"4\.10","4\.10"$/);
    // Scope applies to exports as to every read.
    expect((await h.call(hrFin, 'GET', `/v1/appraisal-cycles/${cycle.id}/export`)).body).not.toContain(codes['Synthetic Done One']!);
    expect((await h.call(w.manager, 'GET', `/v1/appraisal-cycles/${cycle.id}/export`)).statusCode).toBe(403);
    const audit = await h.one<{ after_values: { operational: { ratingColumns: boolean; rows: number } } }>(
      `select after_values from audit_event where company_id = $1 and action = 'EXPORT' and actor_user_id = $2 order by occurred_at desc limit 1`,
      [A.id, w.hr.user],
    );
    expect(audit.after_values.operational).toMatchObject({ ratingColumns: true, rows: 4 });
  });

  it('refuses an export above its row bound instead of truncating it silently (FR-044 reconciliation)', async () => {
    // A stand-in database: the cycle, then one row more than the bound; nothing else may be asked (no audit row).
    const asked: string[] = [];
    const fake: Queryable = {
      query: async (text: string) => {
        asked.push(text);
        if (text.includes('from appraisal_cycle c')) return { rows: [{ id: cycle.id, code: cycle.code, start_date: '2026-04-01', end_date: '2027-03-31', state: 'OPEN' }] } as never;
        if (text.includes('from appraisal a')) return { rows: Array.from({ length: EXPORT_ROW_LIMIT + 1 }, (_, i) => ({ employee_code: `SYN-${i}` })) } as never;
        throw new Error('unexpected query');
      },
    };
    const grant: AccessGrant = {
      allowed: true,
      userId: w.hr.user,
      companyId: A.id,
      assignmentId: w.hr.assignment,
      roleCode: 'HR_ADMINISTRATOR',
      accessClass: 'ADMIN',
      scopeKind: 'COMPANY',
      filters: { departments: [], locations: [], employees: [] },
      deniedScopes: [],
      allowedFieldGroups: ['operational'],
      ownEssFieldGroups: [],
      deniedFieldGroups: [],
      linkedEmployeeId: null,
      at: new Date(),
      businessDate: w.today,
    };
    await expect(cycleExport(fake, grant, cycle.id, {})).rejects.toMatchObject({ statusCode: 422, code: 'EXPORT_TOO_LARGE', details: { limit: EXPORT_ROW_LIMIT } });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain(`limit ${EXPORT_ROW_LIMIT + 1}`);
  });

  it('a goal upload creates DRAFT appraisals only, after a preview, all-or-nothing (FR-041, F1)', async () => {
    const u1 = await appraisee(w.managerEmp, 'Synthetic Upload One');
    const u2 = await appraisee(w.managerEmp, 'Synthetic Upload Two');
    const lines = [
      HEADER,
      `${cycle.code.toLowerCase()},${codes['Synthetic Upload One']!.toLowerCase()},1,Synthetic uploaded goal A,,60`,
      `${cycle.code},${codes['Synthetic Upload One']},2,Synthetic uploaded goal B,Synthetic target,40`,
      `${cycle.code},${codes['Synthetic Upload Two']},1,Synthetic uploaded goal C,,100`,
    ];
    expect((await upload(w.manager, lines, 'appraisal-upload-1')).statusCode).toBe(403);
    const previewed = await upload(w.hr, lines, 'appraisal-upload-1');
    expect(previewed.statusCode, previewed.body).toBe(201);
    expect(previewed.json()).toMatchObject({ state: 'PREVIEWED', template: 'APPRAISAL_GOALS_V1', rowCount: 3 });
    expect((previewed.json().rows as { state: string }[]).every((r) => r.state === 'VALID')).toBe(true);
    // A preview applies nothing.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from appraisal where employee_id = any($1::uuid[])`, [[u1.id, u2.id]])).n).toBe(0);
    // The same idempotency key returns the same job.
    expect((await upload(w.hr, lines, 'appraisal-upload-1')).statusCode).toBe(200);
    const committed = await h.call(w.hr, 'POST', `/v1/appraisal-goal-imports/${previewed.json().id}/commit`);
    expect(committed.json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 3, rejectedCount: 0 });
    const created = (await h.call(w.hr, 'GET', `/v1/appraisals?cycleId=${cycle.id}&employeeId=${u1.id}`)).json().items as Record<string, unknown>[];
    expect(created).toMatchObject([{ state: 'DRAFT', source: 'UPLOAD', goalCount: 2, goalWeightTotal: 100, taskStatus: 'AWAITING_SELF_ENTRY' }]);
    const detail = (await h.call(w.hr, 'GET', `/v1/appraisals/${created[0]!.id}`)).json();
    expect(detail.goals).toMatchObject([
      { sequence: 1, description: 'Synthetic uploaded goal A', target: null, weight: 60 },
      { sequence: 2, description: 'Synthetic uploaded goal B', target: 'Synthetic target', weight: 40 },
    ]);
    // Nothing is submitted, rated or approved by an upload: the employee still self-assesses and the route decides.
    expect(detail.revisions).toMatchObject([{ revision: 1, state: 'DRAFT', submittedAt: null }]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from approval_instance i join appraisal a on a.transaction_id = i.transaction_id where a.employee_id = any($1::uuid[])`, [[u1.id, u2.id]])).n).toBe(0);
    expect(await selfAssess(h, u2.actor, ((await h.call(w.hr, 'GET', `/v1/appraisals?employeeId=${u2.id}`)).json().items as { id: string }[])[0]!.id, [5])).toMatchObject({ state: 'SUBMITTED' });
  });

  it('rejects the whole upload on any row error with row-level codes (DF09, I-13)', async () => {
    const v1 = await appraisee(w.managerEmp, 'Synthetic Reject One');
    const v2 = await appraisee(w.managerEmp, 'Synthetic Reject Two');
    const fin = await appraisee(otherManagerEmp, 'Synthetic Reject Finance', A.financeDept);
    const existing = await appraisee(w.managerEmp, 'Synthetic Reject Existing');
    await enrol(h, w.hr, cycle.id, existing.id);
    const res = await upload(
      w.hr,
      [
        HEADER,
        `${cycle.code},${codes['Synthetic Reject One']},1,Synthetic goal,,50`,
        `${cycle.code},${codes['Synthetic Reject One']},2,Synthetic goal,,40`,
        `${cycle.code},${codes['Synthetic Reject Two']},1,Synthetic goal,,50`,
        `${cycle.code},${codes['Synthetic Reject Two']},1,Synthetic goal,,50`,
        `${cycle.code},NOBODY-SYNTHETIC,1,Synthetic goal,,100`,
        `NO-SUCH-CYCLE,${codes['Synthetic Reject Finance']},1,Synthetic goal,,100`,
        `${cycle.code},${codes['Synthetic Reject Existing']},1,Synthetic goal,,100`,
        `${cycle.code},${codes['Synthetic Reject Finance']},1,Synthetic goal,,100.5`,
      ],
      'appraisal-upload-2',
    );
    expect(res.statusCode, res.body).toBe(201);
    const job = res.json() as { state: string; rows: { rowNumber: number; errorCode: string | null }[] };
    expect(job.state).toBe('REJECTED');
    expect(job.rows.map((r) => r.errorCode)).toEqual([
      'WEIGHT_TOTAL_NOT_100',
      'WEIGHT_TOTAL_NOT_100',
      'BATCH_REJECTED',
      'DUPLICATE_SEQUENCE',
      'UNKNOWN_EMPLOYEE',
      'UNKNOWN_CYCLE',
      'APPRAISAL_EXISTS',
      'INVALID_WEIGHT',
    ]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from appraisal where employee_id = any($1::uuid[])`, [[v1.id, v2.id, fin.id]])).n).toBe(0);
    // A department-filtered HR imports only within its scope.
    const scoped = await upload(hrFin, [HEADER, `${cycle.code},${codes['Synthetic Reject One']},1,Synthetic goal,,100`], 'appraisal-upload-3');
    expect((scoped.json().rows as { errorCode: string }[])[0]!.errorCode).toBe('OUT_OF_SCOPE');
    expect((await upload(w.hr, ['cycle,employee', 'x,y'], 'appraisal-upload-4')).json().error).toBe('INVALID_HEADER');
  });

  followUpSuite({
    path: '/v1/appraisal-goal-imports',
    template: 'APPRAISAL_GOALS_V1',
    harness: () => h,
    company: () => A,
    submitter: () => h.actor(A, 'HR_ADMINISTRATOR'),
    // The manager sets goals but holds no import duty.
    denied: async () => [await h.actor(A, 'REPORTING_MANAGER'), await h.actor(A, 'AUDITOR')],
    // A new appraisee each time, with two goals totalling 100 in the open cycle (nothing is committed).
    validFile: async () => {
      const code = await codeOf(await person(h, A, w.hr, { managerId: w.managerEmp, name: 'Synthetic Follow-up Appraisee' }));
      return { text: [HEADER, `${cycle.code},${code},1,Synthetic follow-up goal A,,70`, `${cycle.code},${code},2,Synthetic follow-up goal B,Synthetic target,30`].join('\n'), rows: 2 };
    },
  });
});
