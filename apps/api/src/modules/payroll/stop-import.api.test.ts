// FR-031 salary stop upload over HTTP (SALARY_STOPS_V1; BRD "Upload Stop Salary", CL-087; DF05; H2; BR-050; C4; DF09; FR-106;
// I-13): every row is the proposal POST /payroll/periods/:id/salary-stops makes, under the same grant and hold group, all or nothing;
// every uploaded stop is SUBMITTED and waits for its own independent decision, exactly as a single proposal; a repeated upload never
// duplicates a stop; and the shared follow-up routes (the submitter's own batches, the malware-scan hold, the published template).
// Synthetic employees, reasons and documents only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { isModuleActive } from '../registry.js';
import { calendar, CONFIG, CRITERIA, criterion, DOCUMENTS, evidenceDocument, grants, key, ok, person, reviewers, STOP_DECIDE, STOP_PROPOSE, trailText, VERIFY_DOCUMENTS } from './payroll.fixtures.js';

const HEADER = 'period_code,employee_code,mode,criterion_code,reason,release_criterion,evidence_reference,evidence_document_ids';
const IMPORTS = '/v1/payroll/salary-stop-imports';

type Job = {
  id: string;
  state: string;
  template: string;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  rows: { rowNumber: number; businessKey: string; state: string; errorCode: string | null; proposedChanges: unknown }[];
};
type StopRow = { id: string; employee_id: string; mode: string; state: string; proposed_by: string; reason: string; criterion_id: string | null; transaction_id: string };

const csv = (...rows: string[]) => [HEADER, ...rows].join('\r\n');

describe.runIf(isModuleActive('payroll'))('salary stop upload (FR-031 "Upload Stop Salary", SALARY_STOPS_V1)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let maker: TestActor;
  let decider: TestActor;
  let uploader: TestActor;
  let verifier: TestActor;
  let crit: { id: string; code: string };
  // A period code that cannot occur in a timestamp (the batch list must not show a row's first cell).
  const PERIOD = 'SYN-NOV-26';

  const upload = (a: TestActor, text: string, idempotencyKey = uniq('stop-import-')) =>
    h.call(a, 'POST', IMPORTS, { fileName: 'salary-stops.csv', contentBase64: Buffer.from(text).toString('base64'), idempotencyKey });
  const codeOf = async (employeeId: string) => (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [employeeId])).c;
  /** An employee in scope with one released, verified evidence document. */
  const employee = async (opts: { departmentId?: string } = {}) => {
    const id = await person(h, A, hr, opts);
    return { id, code: await codeOf(id), doc: await evidenceDocument(h, uploader, verifier, id) };
  };
  const stopsOf = async (...employeeIds: string[]) =>
    (
      await h.db.query<StopRow>(
        `select id, employee_id, mode, state, proposed_by, reason, criterion_id, transaction_id from payroll_salary_stop where employee_id = any($1::uuid[]) order by created_at, id`,
        [employeeIds],
      )
    ).rows;
  const taskOf = async (a: TestActor, stopId: string) =>
    ((await h.call(a, 'GET', '/v1/payroll/salary-stops/tasks/mine')).json().items as { taskId: string; stop: { id: string } | null }[]).find((x) => x.stop?.id === stopId)?.taskId;
  const withhold = (e: { code: string; doc: string }, over: Partial<Record<'period' | 'mode' | 'criterion' | 'reason' | 'release' | 'reference' | 'docs', string>> = {}) =>
    [
      over.period ?? PERIOD,
      e.code,
      over.mode ?? 'HOLD_DISBURSEMENT',
      over.criterion ?? crit.code,
      over.reason ?? 'Synthetic contractual stop',
      over.release ?? 'Synthetic clearance received',
      over.reference ?? 'SYNTH-CASE-1',
      over.docs ?? e.doc,
    ].join(',');

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(CONFIG, CRITERIA) });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(CONFIG, CRITERIA) });
    maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(STOP_PROPOSE, STOP_DECIDE) });
    decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: STOP_DECIDE });
    uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    await reviewers(h, hr, 'payroll_salary_stop', [maker, decider]);
    await calendar(h, configA, configB, [{ code: PERIOD, start: '2026-11-01', end: '2026-11-30' }]);
    const code = uniq('STOP_UPLOAD_');
    crit = { id: await criterion(h, configA, configB, { code, scopeMode: 'FULL_ONLY' }), code };
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('FR-031: previews without proposing anything, then proposes every row as a SUBMITTED stop that waits for its own independent decision', async () => {
    const held = await employee();
    const excluded = await employee();
    const res = await upload(
      maker,
      csv(
        withhold({ ...held, code: held.code.toLowerCase() }, { period: PERIOD.toLowerCase(), criterion: crit.code.toLowerCase(), reason: '"Synthetic stop, contract clause 4"' }),
        [PERIOD, excluded.code, 'EXCLUDE_CALCULATION', '', 'Synthetic exclusion', '', 'SYNTH-CASE-2', excluded.doc].join(','),
      ),
    );
    expect(res.statusCode, res.body).toBe(201);
    const job = res.json() as Job;
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'SALARY_STOPS_V1', rowCount: 2 });
    expect(job.rows.map((r) => [r.businessKey, r.state])).toEqual([
      [`${PERIOD}/${held.code}`, 'VALID'],
      [`${PERIOD}/${excluded.code}`, 'VALID'],
    ]);
    // The import rows keep the period and employee codes only: never a reason or a document.
    expect(job.rows.every((r) => r.proposedChanges === null)).toBe(true);
    expect(JSON.stringify(job)).not.toContain('Synthetic stop');
    expect(JSON.stringify(job)).not.toContain(held.doc);
    expect(await stopsOf(held.id, excluded.id)).toEqual([]);

    const done = (await h.call(maker, 'POST', `${IMPORTS}/${job.id}/commit`)).json() as Job;
    expect(done).toMatchObject({ state: 'COMMITTED', acceptedCount: 2, rejectedCount: 0 });
    // Each row is a proposal as the single one makes it: SUBMITTED, undecided, proposed by the uploader, with its mode and evidence.
    const stops = (await stopsOf(held.id, excluded.id)).sort((a, b) => (a.employee_id === held.id ? -1 : b.employee_id === held.id ? 1 : 0));
    expect(stops.map((s) => [s.employee_id, s.mode, s.state, s.proposed_by, s.reason, s.criterion_id])).toEqual([
      [held.id, 'HOLD_DISBURSEMENT', 'SUBMITTED', maker.user, 'Synthetic stop, contract clause 4', crit.id],
      [excluded.id, 'EXCLUDE_CALCULATION', 'SUBMITTED', maker.user, 'Synthetic exclusion', null],
    ]);
    const evidence = await h.db.query(`select document_id from transaction_evidence where transaction_id = any($1::uuid[]) order by document_id`, [stops.map((s) => s.transaction_id)]);
    expect(evidence.rows.map((r) => r.document_id).sort()).toEqual([held.doc, excluded.doc].sort());
    const proposals = await h.db.query(`select 1 from audit_event where company_id = $1 and resource_code = 'payroll_salary_stop' and action = 'PROPOSE' and actor_user_id = $2 and record_key = any($3::uuid[])`, [
      A.id,
      maker.user,
      stops.map((s) => s.id),
    ]);
    expect(proposals.rowCount).toBe(2);

    // Every uploaded stop has its own task, never the uploader's, and is decided stop by stop; the decider confirms the mode.
    const [heldStop, excludedStop] = [stops[0]!, stops[1]!];
    expect(await taskOf(maker, heldStop.id)).toBeUndefined();
    expect(await taskOf(maker, excludedStop.id)).toBeUndefined();
    const heldTask = (await taskOf(decider, heldStop.id))!;
    const excludedTask = (await taskOf(decider, excludedStop.id))!;
    expect(heldTask).not.toBe(excludedTask);
    expect((await h.call(decider, 'POST', `/v1/payroll/stop-tasks/${heldTask}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).json().error).toBe('MODE_NOT_CONFIRMED');
    expect(await ok(await h.call(decider, 'POST', `/v1/payroll/stop-tasks/${heldTask}/decision`, { decision: 'APPROVE', confirmMode: 'HOLD_DISBURSEMENT', idempotencyKey: key() }))).toMatchObject({
      state: 'APPROVED',
    });
    expect(await ok(await h.call(decider, 'POST', `/v1/payroll/stop-tasks/${excludedTask}/decision`, { decision: 'REJECT', reason: 'Synthetic: not needed', idempotencyKey: key() }))).toMatchObject({
      state: 'REJECTED',
    });

    // Committing again changes nothing.
    expect((await h.call(maker, 'POST', `${IMPORTS}/${job.id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 2 });
    expect(await stopsOf(held.id, excluded.id)).toHaveLength(2);
    // No reason in operational audit values or the outbox.
    const trail = await trailText(h, A.id);
    for (const t of [trail.operational, trail.outbox]) expect(t).not.toContain('contract clause 4');
  });

  it('FR-031, BR-050: applies exactly the rules of a single proposal: one row with a problem rejects the whole batch and proposes nothing', async () => {
    const e = await employee();
    const other = await employee();
    const valid = await employee();
    const unverified = await evidenceDocument(h, uploader, verifier, e.id, { verify: false });
    // A criterion whose only revision is retired: no longer active.
    const retiredCode = uniq('STOP_RETIRED_');
    const retired = await criterion(h, configA, configB, { code: retiredCode });
    const current = ((await h.call(configA, 'GET', '/v1/payroll/hold-criteria')).json().items as { id: string; version: number }[]).find((c) => c.id === retired)!;
    await ok(await h.call(configB, 'POST', `/v1/payroll/hold-criteria/${retired}/retire`, { reason: 'Synthetic retirement', expectedVersion: current.version }));
    const cases: [string, string][] = [
      [withhold(e, { mode: 'WITHHOLD' }), 'INVALID_MODE'],
      [withhold(e, { period: 'NOPE-99' }), 'UNKNOWN_PERIOD'],
      [withhold({ code: `NOBODY-${uniq('x')}`, doc: e.doc }), 'UNKNOWN_EMPLOYEE'],
      [withhold(e, { criterion: uniq('NO_SUCH_CRIT_') }), 'UNKNOWN_CRITERION'],
      [withhold(e, { criterion: '' }), 'HOLD_CRITERION_NOT_ACTIVE'],
      [withhold(e, { criterion: retiredCode }), 'HOLD_CRITERION_NOT_ACTIVE'],
      [withhold(e, { release: '' }), 'RELEASE_CRITERION_REQUIRED'],
      [withhold(e, { mode: 'EXCLUDE_CALCULATION', release: '' }), 'NOT_A_HOLD'],
      [withhold(e, { reason: '' }), 'REASON_REQUIRED'],
      [withhold(e, { reference: '' }), 'EVIDENCE_REQUIRED'],
      [withhold(e, { docs: '' }), 'EVIDENCE_REQUIRED'],
      [withhold(e, { docs: 'not-a-document-id' }), 'INVALID_DOCUMENT_IDS'],
      [withhold(e, { docs: `${e.doc};${e.doc}` }), 'INVALID_DOCUMENT_IDS'],
      [withhold(e, { docs: unverified }), 'EVIDENCE_NOT_VERIFIED'],
      [withhold(e, { docs: other.doc }), 'INVALID_EVIDENCE'],
      [[PERIOD, e.code, '', crit.code, 'Synthetic'].join(','), 'COLUMN_COUNT'],
    ];
    const job = (await upload(maker, csv(...cases.map(([row]) => row), withhold(valid)))).json() as Job;
    expect(job.state).toBe('REJECTED');
    expect(job.rows.map((x) => x.errorCode)).toEqual([...cases.map(([, code]) => code), 'BATCH_REJECTED']);
    expect(job.rows.every((x) => x.state === 'REJECTED')).toBe(true);
    expect((await h.call(maker, 'POST', `${IMPORTS}/${job.id}/commit`)).statusCode).toBe(409);
    expect(await stopsOf(e.id, other.id, valid.id)).toEqual([]);

    // The single proposal refuses the same values in the same words.
    const periodId = (await h.one<{ id: string }>(`select id from payroll_period where company_id = $1 and period_code = $2`, [A.id, PERIOD])).id;
    const single = (body: Record<string, unknown>) =>
      h.call(maker, 'POST', `/v1/payroll/periods/${periodId}/salary-stops`, {
        employeeId: e.id,
        criterionId: crit.id,
        reason: 'Synthetic',
        releaseCriterion: 'Synthetic clearance',
        evidenceReference: 'SYNTH-CASE-1',
        evidenceDocumentIds: [e.doc],
        ...body,
      });
    expect((await single({ criterionId: retired })).json().error).toBe('HOLD_CRITERION_NOT_ACTIVE');
    expect((await single({ mode: 'EXCLUDE_CALCULATION' })).json().error).toBe('NOT_A_HOLD');
    expect((await single({ evidenceDocumentIds: [unverified] })).json().error).toBe('EVIDENCE_NOT_VERIFIED');
    expect((await single({ evidenceDocumentIds: [other.doc] })).json().error).toBe('INVALID_EVIDENCE');
    expect((await single({ evidenceDocumentIds: [] })).json().error).toBe('EVIDENCE_REQUIRED');
    expect((await single({ evidenceDocumentIds: [e.doc, e.doc] })).statusCode).toBe(400);
    expect(await stopsOf(e.id)).toEqual([]);
  });

  it('FR-031: a repeated upload never duplicates a stop: the same upload under its key is the same batch, the same file under a new key proposes nothing again', async () => {
    const e = await employee();
    const file = csv(withhold(e));
    const k = uniq('stop-import-');
    const first = (await upload(maker, file, k)).json() as Job;
    expect(first.state).toBe('PREVIEWED');
    // The same upload again (a lost answer): the same batch, nothing read twice.
    const again = await upload(maker, file, k);
    expect(again.statusCode).toBe(200);
    expect((again.json() as Job).id).toBe(first.id);
    expect((await h.call(maker, 'POST', `${IMPORTS}/${first.id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 1 });
    expect((await upload(maker, file, k)).json()).toMatchObject({ id: first.id, state: 'COMMITTED' });
    expect(await stopsOf(e.id)).toHaveLength(1);
    // The same file under a new key: refused as the single proposal refuses a second live stop.
    const repeat = (await upload(maker, file)).json() as Job;
    expect(repeat.state).toBe('REJECTED');
    expect(repeat.rows.map((r) => r.errorCode)).toEqual(['STOP_EXISTS']);
    // Two rows for one employee and period in one file: the second is refused the same way.
    const f = await employee();
    const twice = (await upload(maker, csv(withhold(f), withhold(f, { reason: 'Synthetic second' })))).json() as Job;
    expect(twice.rows.map((r) => r.errorCode)).toEqual(['BATCH_REJECTED', 'STOP_EXISTS']);
    expect(await stopsOf(e.id, f.id)).toHaveLength(1);
  });

  it('FR-031, C4: needs payroll_stop.propose with the hold group; row scope and never-self apply per row; another company finds no employee', async () => {
    const inDept = await employee();
    const finance = await employee({ departmentId: A.financeDept });
    const file = csv(withhold(finance), withhold(inDept));
    for (const a of [hr, decider, await h.actor(A, 'AUDITOR')]) {
      expect((await upload(a, file)).statusCode).toBe(403);
      expect((await h.call(a, 'GET', `${IMPORTS}/template`)).statusCode).toBe(403);
      expect((await h.call(a, 'GET', IMPORTS)).statusCode).toBe(403);
    }
    // Row scope: an employee outside the role's department filter.
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: STOP_PROPOSE, departmentFilter: A.dept });
    expect(((await upload(narrow, file)).json() as Job).rows.map((r) => r.errorCode)).toEqual(['OUT_OF_SCOPE', 'BATCH_REJECTED']);
    // Never the caller's own record, as the single proposal refuses it.
    const own = await employee();
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: STOP_PROPOSE, employeeId: own.id });
    expect(((await upload(self, csv(withhold(own)))).json() as Job).rows.map((r) => r.errorCode)).toEqual(['SELF_ACTION_NOT_ALLOWED']);
    // Another company's Admin holding the duty finds none of this company's employees (nor its period of an inactive calendar).
    const B = await h.makeCompany();
    const foreign = await h.actor(B, 'HR_ADMINISTRATOR', { extra: STOP_PROPOSE });
    expect(((await upload(foreign, csv(withhold(inDept)))).json() as Job).rows.map((r) => r.errorCode)).toEqual(['UNKNOWN_PERIOD']);
    expect(await stopsOf(inDept.id, finance.id, own.id)).toEqual([]);

    // The published template: exactly the header the upload checks, no rows.
    const template = await h.call(maker, 'GET', `${IMPORTS}/template`);
    expect(template.statusCode).toBe(200);
    expect(template.headers['content-disposition']).toContain('SALARY_STOPS_V1.csv');
    expect(template.body).toBe(`${HEADER}\r\n`);
  });

  followUpSuite({
    path: IMPORTS,
    template: 'SALARY_STOPS_V1',
    harness: () => h,
    company: () => A,
    submitter: () => h.actor(A, 'HR_ADMINISTRATOR', { extra: STOP_PROPOSE }),
    denied: async () => [await h.actor(A, 'HR_ADMINISTRATOR'), await h.actor(A, 'HR_ADMINISTRATOR', { extra: STOP_DECIDE }), await h.actor(A, 'AUDITOR')],
    // Nothing is committed, so any employee in scope with verified evidence will do.
    validFile: async () => {
      const e = await employee();
      return { text: csv(withhold(e)), rows: 1 };
    },
  });
});
