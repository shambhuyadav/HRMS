// Full-and-final settlement records over HTTP (FR-052, FR-053, FR-054; DB079; DB080; F1; BR-016; DF02; DF03; DF09).
// Revisions without a calculation (NOT_CONFIGURED; the calculation itself is settlement-calculation.api.test.ts, I-88); lines entered or
// uploaded by an authorised HR Administrator; net = sum of lines;
// independent review and approval; release eligibility that never creates or implies a payment. Synthetic data and
// synthetic pay components (test fixtures) only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { devTokenVerifier } from '../../auth/tokens.js';
import { withTransaction } from '../../db/transaction.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { HR_SETTLEMENT, HR_SETTLEMENT_EXPORT, key, narrowedGrant, person, publishedTemplate, today as businessDate, trailText } from './lifecycle.fixtures.js';
import { createSettlement, markReleaseEligible } from './settlement.js';

describe.runIf(isModuleActive('lifecycle'))('full-and-final settlement (FR-052 to FR-054)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let exitHr: TestActor;
  let prep: TestActor;
  let rev: TestActor;
  let appr: TestActor;
  let rel: TestActor;
  let hrPlain: TestActor;
  let hrFinance: TestActor;
  let hrB: TestActor;
  let payroll: TestActor;
  let manager: TestActor;
  let employee: TestActor;
  let employeeEmp: string;
  let exitId: string;
  let today: string;

  const csv = (rows: string[][]) => Buffer.from(`${rows.map((r) => r.join(',')).join('\r\n')}\r\n`).toString('base64');
  const HEADER = ['employee_code', 'last_working_date', 'component_code', 'amount', 'line_kind'];
  const get = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/settlements/${id}`)).json();
  const tasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/settlements/tasks/mine')).json().items as { taskId: string; kind: string; step: string; settlement: { id: string } | null }[];
  const decide = (a: TestActor, path: 'review' | 'approve', taskId: string, body: Record<string, unknown>) =>
    h.call(a, 'POST', `/v1/settlements/tasks/${taskId}/${path}`, { idempotencyKey: key(), ...body });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    exitHr = await h.actor(A, 'HR_ADMINISTRATOR');
    prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT_EXPORT });
    rev = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    appr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    rel = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT_EXPORT });
    hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
    hrFinance = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT, departmentFilter: A.financeDept });
    hrB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    // A payroll operator may hold the operational view; amounts are never available in that role (DF02).
    payroll = await h.actor(A, 'PAYROLL_OPERATOR', { extra: ['settlement.read.operational'] });
    const managerEmp = await person(h, A, exitHr, { name: 'Maya Manager (synthetic)' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    employeeEmp = await person(h, A, exitHr, { managerId: managerEmp, name: 'Eli Employee (synthetic)' });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
    today = await businessDate(h, A);

    // Synthetic pay components (fixtures; the BRD's payroll configuration is not built here).
    for (const [code, name, kind, active] of [
      ['BASIC', 'Basic pay (synthetic)', 'EARNING', true],
      ['LEAVE_ENC', '=HYPERLINK("synthetic")', 'EARNING', true],
      ['LOAN', 'Loan recovery (synthetic)', 'DEDUCTION', true],
      ['NOTICE_REC', 'Notice recovery (synthetic)', 'DEDUCTION', true],
      ['OLD', 'Retired component (synthetic)', 'EARNING', false],
    ] as const) {
      await h.db.query(`insert into pay_component (company_id, code, name, component_kind, active) values ($1, $2, $3, $4, $5)`, [A.id, code, name, kind, active]);
    }
    // An approved exit with the last working date today.
    expect((await h.call(exitHr, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: exitHr.user, priority: 1 }] })).statusCode).toBe(200);
    exitId = (await h.call(employee, 'POST', '/v1/me/resignation', { proposedLastWorkingDate: today })).json().exitCaseId;
    const mt = (await h.call(manager, 'GET', '/v1/exit-cases/tasks/mine')).json().items[0].taskId;
    await h.call(manager, 'POST', `/v1/exit-cases/tasks/${mt}/recommend`, { recommendedLastWorkingDate: today, idempotencyKey: key() });
    const ht = (await h.call(exitHr, 'GET', '/v1/exit-cases/tasks/mine')).json().items[0].taskId;
    expect((await h.call(exitHr, 'POST', `/v1/exit-cases/tasks/${ht}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).json().state).toBe('APPROVED');
    // The preparer is first on the list, to prove the engine never routes the review or approval to them.
    expect(
      (
        await h.call(exitHr, 'PUT', '/v1/workflows/settlement/fallback-reviewers', {
          reviewers: [
            { userId: prep.user, priority: 1 },
            { userId: rev.user, priority: 2 },
            { userId: appr.user, priority: 3 },
          ],
        })
      ).statusCode,
    ).toBe(200);
  });

  afterAll(async () => {
    await h?.stop();
  });

  let settlementId: string;

  it('reports how a draft is calculated (I-88) and lets only an authorised HR Administrator prepare', async () => {
    expect((await h.call(hrPlain, 'GET', '/v1/settlements/calculation')).json()).toMatchObject({ status: 'AVAILABLE' });
    expect((await h.call(hrPlain, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' })).statusCode).toBe(403);
    expect((await h.call(payroll, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' })).statusCode).toBe(403);
    expect((await h.call(employee, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' })).statusCode).toBe(403);
    expect((await h.call(hrFinance, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' })).statusCode).toBe(404);
    expect((await h.call(hrB, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' })).statusCode).toBe(404);
    expect((await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, {})).json().error).toBe('CURRENCY_REQUIRED');
    // The preparer's choices: active components only, and the approved exits that still need a settlement.
    const components = await h.call(prep, 'GET', '/v1/settlements/pay-components');
    expect(components.statusCode, components.body).toBe(200);
    expect(components.json().items.map((c: { code: string; kind: string }) => [c.code, c.kind])).toEqual([
      ['BASIC', 'EARNING'],
      ['LEAVE_ENC', 'EARNING'],
      ['LOAN', 'DEDUCTION'],
      ['NOTICE_REC', 'DEDUCTION'],
    ]);
    expect((await h.call(hrPlain, 'GET', '/v1/settlements/pay-components')).statusCode).toBe(403);
    const awaiting = async (a: TestActor) => (await h.call(a, 'GET', '/v1/settlements/awaiting-exits')).json().items as { exitCaseId: string; lastWorkingDate: string; latestRevision: number | null }[];
    expect((await awaiting(prep)).find((x) => x.exitCaseId === exitId)).toMatchObject({ lastWorkingDate: today, latestRevision: null });
    expect((await h.call(payroll, 'GET', '/v1/settlements/awaiting-exits')).statusCode).toBe(403);
    expect(await awaiting(hrB)).toEqual([]);
    // docs/09 §6.5: a preparation grant withdrawn after the route guard refuses inside the transaction; nothing is created.
    const narrowed = await narrowedGrant(h, A, await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT }), 'settlement.prepare.amount');
    await expect(withTransaction(h.pool, (tx) => createSettlement(tx, narrowed, exitId, { currencyCode: 'INR' }))).rejects.toMatchObject({ statusCode: 403 });
    expect(await h.one<{ n: number }>(`select count(*)::int as n from settlement where exit_case_id = $1`, [exitId])).toEqual({ n: 0 });
    const created = await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      revision: 1,
      state: 'DRAFT',
      currencyCode: 'INR',
      calculationStatus: 'NOT_CONFIGURED',
      netAmount: '0.0000',
      lines: [],
      paymentStatus: 'NOT_PAID',
      lastWorkingDate: today,
    });
    settlementId = created.json().id;
    // A live revision takes the exit off the work list.
    expect((await awaiting(prep)).map((x) => x.exitCaseId)).not.toContain(exitId);
    expect((await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' })).json().error).toBe('SETTLEMENT_EXISTS');
    // Nothing to submit yet, and nothing to export before approval.
    expect((await h.call(prep, 'POST', `/v1/settlements/${settlementId}/submit`, { expectedVersion: created.json().version })).json().error).toBe('NO_LINES');
    expect((await h.call(prep, 'GET', `/v1/settlements/${settlementId}/export`)).json().error).toBe('NOT_APPROVED');
    // A settlement is prepared only for an approved exit (a resignation still waiting for its decision has none).
    const waitingEmp = await person(h, A, exitHr, { name: 'Wren Waiting (synthetic)' });
    const waiting = await h.actor(A, 'EMPLOYEE', { employeeId: waitingEmp });
    const waitingExit = (await h.call(waiting, 'POST', '/v1/me/resignation', { proposedLastWorkingDate: today })).json().exitCaseId as string;
    expect((await h.call(prep, 'POST', `/v1/exit-cases/${waitingExit}/settlements`, { currencyCode: 'INR' })).json().error).toBe('EXIT_NOT_APPROVED');
  });

  it('validates lines, keeps the net amount equal to their exact sum and needs the notice period for a notice adjustment', async () => {
    let s = await get(prep, settlementId);
    const put = (lines: Record<string, unknown>[], version = s.version) => h.call(prep, 'PUT', `/v1/settlements/${settlementId}/lines`, { lines, expectedVersion: version });
    expect((await put([{ componentCode: 'NOPE', amount: '1' }])).json().error).toBe('UNKNOWN_COMPONENT');
    expect((await put([{ componentCode: 'OLD', amount: '1' }])).json().error).toBe('UNKNOWN_COMPONENT');
    expect((await put([{ componentCode: 'BASIC', amount: '1.23456' }])).json().error).toBe('INVALID_AMOUNT');
    expect((await put([{ componentCode: 'BASIC', amount: '1e3' }])).json().error).toBe('INVALID_AMOUNT');
    expect((await put([{ componentCode: 'BASIC', amount: '-100' }])).json().error).toBe('SIGN_MISMATCH');
    expect((await put([{ componentCode: 'LOAN', amount: '100' }])).json().error).toBe('SIGN_MISMATCH');
    expect((await put([{ componentCode: 'BASIC', amount: '1' }, { componentCode: 'basic', amount: '2' }])).json().error).toBe('DUPLICATE_COMPONENT');
    expect((await put([{ componentCode: 'NOTICE_REC', amount: '-5000', lineKind: 'NOTICE_ADJUSTMENT' }])).json().error).toBe('NOTICE_PERIOD_NOT_RECORDED');
    expect((await put([{ componentCode: 'BASIC', amount: '1' }], 99)).json().error).toBe('STALE_VERSION');
    // Only the preparer of the revision changes it.
    expect((await h.call(rev, 'PUT', `/v1/settlements/${settlementId}/lines`, { lines: [], expectedVersion: s.version })).json().error).toBe('NOT_PREPARER');

    const exit = (await h.call(exitHr, 'GET', `/v1/exit-cases/${exitId}`)).json();
    expect((await h.call(exitHr, 'PUT', `/v1/exit-cases/${exitId}/notice-period`, { contractualNoticeDays: 30, expectedVersion: exit.version })).statusCode).toBe(200);
    const saved = await put([
      { componentCode: 'BASIC', amount: '50000.00' },
      { componentCode: 'LEAVE_ENC', amount: '12345.6789' },
      { componentCode: 'LOAN', amount: '-10000.5' },
      { componentCode: 'NOTICE_REC', amount: '-5000', lineKind: 'NOTICE_ADJUSTMENT' },
    ]);
    expect(saved.statusCode, saved.body).toBe(200);
    s = saved.json();
    expect(s.netAmount).toBe('47345.1789');
    expect(s.lines.map((l: { componentCode: string; amount: string; source: string }) => [l.componentCode, l.amount, l.source])).toEqual([
      ['BASIC', '50000.0000', 'ENTERED'],
      ['LEAVE_ENC', '12345.6789', 'ENTERED'],
      ['LOAN', '-10000.5000', 'ENTERED'],
      ['NOTICE_REC', '-5000.0000', 'ENTERED'],
    ]);
    // The database refuses a net amount that differs from the lines, and a sign against the component kind.
    await expect(h.db.query(`update settlement set net_amount = 1 where id = $1`, [settlementId])).rejects.toThrow(/sum of its lines/);
    await expect(h.db.query(`update settlement_line set amount = -1 where settlement_id = $1 and component_id = (select id from pay_component where company_id = $2 and code = 'BASIC')`, [settlementId, A.id])).rejects.toThrow(/sign/);

    // Amounts are confidential: operational readers see state and revision only.
    const forPayroll = await get(payroll, settlementId);
    expect(forPayroll).toMatchObject({ state: 'DRAFT', revision: 1, currencyCode: 'INR' });
    expect(forPayroll).not.toHaveProperty('netAmount');
    expect(forPayroll).not.toHaveProperty('lines');
    expect(await get(hrPlain, settlementId)).not.toHaveProperty('netAmount');
    expect((await h.call(employee, 'GET', `/v1/settlements/${settlementId}`)).statusCode).toBe(403);
    expect((await h.call(hrB, 'GET', `/v1/settlements/${settlementId}`)).statusCode).toBe(404);
  });

  it('asks the scanner with no transaction open, so a slow scanner holds no connection or lock', async () => {
    const s = await get(prep, settlementId);
    const open: number[] = [];
    const app = buildApp({
      db: h.pool,
      verifier: devTokenVerifier(tokenConfig),
      scanner: {
        scan: async () => {
          open.push((await h.one<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`)).n);
          return { verdict: 'CLEAN' };
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/settlements/${settlementId}/upload`,
        headers: { authorization: `Bearer ${prep.token}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: prep.assignment },
        payload: { contentBase64: csv([['employee', 'amount'], ['x', '1']]), dryRun: true, expectedVersion: s.version },
      });
      expect(res.json().error).toBe('INVALID_TEMPLATE');
    } finally {
      await app.close();
    }
    expect(open).toEqual([0]);
  });

  it('uploads lines atomically with row-level validation and reconciled counts', async () => {
    let s = await get(prep, settlementId);
    const upload = (rows: string[][], dryRun = false) => h.call(prep, 'POST', `/v1/settlements/${settlementId}/upload`, { contentBase64: csv(rows), dryRun, expectedVersion: s.version });
    const code = s.employeeCode as string;
    expect((await upload([['employee', 'amount'], ['x', '1']])).json().error).toBe('INVALID_TEMPLATE');
    // FR-106: a file the malware scan flags is refused before it is read (synthetic EICAR test string).
    const flagged = { contentBase64: Buffer.from(`${HEADER.join(',')}\n${EICAR_TEST_STRING}\n`).toString('base64'), expectedVersion: s.version };
    for (const dryRun of [true, false]) {
      expect((await h.call(prep, 'POST', `/v1/settlements/${settlementId}/upload`, { ...flagged, dryRun })).json().error).toBe('UPLOAD_QUARANTINED');
    }
    const bad = await upload([
      HEADER,
      [code, today, 'BASIC', '40000', ''],
      ['OTHER-CODE', today, 'LOAN', '-1', ''],
      [code, '2020-01-01', 'LOAN', '-1', ''],
      [code, today, 'LOAN', '5', ''],
      [code, today, 'BASIC', '1', ''],
    ]);
    expect(bad.json()).toMatchObject({
      total: 5,
      accepted: 0,
      rejected: 5,
      applied: false,
      errors: [
        { row: 2, code: 'BATCH_REJECTED' },
        { row: 3, code: 'EMPLOYEE_MISMATCH' },
        { row: 4, code: 'DATE_MISMATCH' },
        { row: 5, code: 'SIGN_MISMATCH' },
        { row: 6, code: 'DUPLICATE_COMPONENT' },
      ],
    });
    expect((await get(prep, settlementId)).netAmount).toBe('47345.1789');
    const good = [HEADER, [code, today, 'BASIC', '40000.25', ''], [code, today, 'LEAVE_ENC', '0', ''], [code, today, 'LOAN', '-250.25', 'STANDARD']];
    const dry = await upload(good, true);
    expect(dry.json()).toMatchObject({ dryRun: true, total: 3, accepted: 3, rejected: 0, applied: false, errors: [] });
    expect((await get(prep, settlementId)).netAmount).toBe('47345.1789');
    const applied = await upload(good);
    expect(applied.json()).toMatchObject({ total: 3, accepted: 3, rejected: 0, applied: true });
    s = await get(prep, settlementId);
    expect(s.netAmount).toBe('39750.0000');
    expect(s.lines.map((l: { source: string }) => l.source)).toEqual(['UPLOADED', 'UPLOADED', 'UPLOADED']);
  });

  it('serves the published SETTLEMENT_LINES_V1 template: exactly the header the upload accepts and no rows, under the upload grant (DF09)', async () => {
    const res = await h.call(prep, 'GET', '/v1/settlements/lines/template');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="SETTLEMENT_LINES_V1.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe(`${HEADER.join(',')}\r\n`);
    // Round trip: the template filled in with valid synthetic rows passes the upload's validation (a check changes nothing).
    const s = await get(prep, settlementId);
    const filled = `${res.body}${s.employeeCode},${today},BASIC,40000.25,\r\n${s.employeeCode},${today},LOAN,-250.25,STANDARD\r\n`;
    const checked = await h.call(prep, 'POST', `/v1/settlements/${settlementId}/upload`, { contentBase64: Buffer.from(filled).toString('base64'), dryRun: true, expectedVersion: s.version });
    expect(checked.json()).toMatchObject({ template: 'SETTLEMENT_LINES_V1', dryRun: true, total: 2, accepted: 2, rejected: 0, applied: false, errors: [] });
    expect((await get(prep, settlementId)).version).toBe(s.version);
    // The template alone holds no line to upload.
    const empty = await h.call(prep, 'POST', `/v1/settlements/${settlementId}/upload`, { contentBase64: Buffer.from(res.body).toString('base64'), dryRun: true, expectedVersion: s.version });
    expect(empty.json().error).toBe('EMPTY_FILE');
    // Without the settlement preparation grant (amount group) the template is refused like the upload.
    for (const a of [hrPlain, payroll, employee]) expect((await h.call(a, 'GET', '/v1/settlements/lines/template')).statusCode).toBe(403);
  });

  it('routes review and approval independently of the preparer and of each other; a return creates a new revision', async () => {
    let s = await get(prep, settlementId);
    expect((await h.call(rev, 'POST', `/v1/settlements/${settlementId}/submit`, { expectedVersion: s.version })).json().error).toBe('NOT_PREPARER');
    expect((await h.call(prep, 'POST', `/v1/settlements/${settlementId}/submit`, { expectedVersion: s.version })).statusCode).toBe(200);
    // A submitted revision is frozen.
    expect((await h.call(prep, 'PUT', `/v1/settlements/${settlementId}/lines`, { lines: [], expectedVersion: s.version + 1 })).json().error).toBe('INVALID_STATE');
    await expect(h.db.query(`update settlement_line set amount = amount + 1 where settlement_id = $1 and amount > 0`, [settlementId])).rejects.toThrow(/frozen/);
    expect(await tasks(prep)).toEqual([]);
    const rt = (await tasks(rev)).find((t) => t.settlement?.id === settlementId)!;
    expect(rt.step).toBe('review');
    await dispatchOutbox(h.pool);
    const notice = ((await h.call(rev, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[]).find((n) => n.category === 'SETTLEMENT_ASSIGNED')!;
    expect(notice.body).toContain('waiting for your review');
    expect(notice.body).not.toMatch(/39750|40000/);
    expect((await decide(rev, 'review', rt.taskId, { decision: 'RETURN' })).json().error).toBe('REASON_REQUIRED');
    expect((await decide(rev, 'review', rt.taskId, { decision: 'RETURN', reason: 'Synthetic: loan figure to confirm' })).json().state).toBe('RETURNED');

    // The correction is a new revision copying the returned lines.
    const r2 = await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, {});
    expect(r2.json()).toMatchObject({ revision: 2, state: 'DRAFT', supersedesSettlementId: settlementId, currencyCode: 'INR', netAmount: '39750.0000' });
    expect(r2.json().lines.map((l: { source: string }) => l.source)).toEqual(['COPIED', 'COPIED', 'COPIED']);
    const listed = (await h.call(prep, 'GET', `/v1/exit-cases/${exitId}/settlements`)).json();
    // I-88: the calculation is available; these revisions carry none, so their own status stays NOT_CONFIGURED.
    expect(listed.calculation.status).toBe('AVAILABLE');
    expect(listed.items.map((i: { calculationStatus: string }) => i.calculationStatus)).toEqual(['NOT_CONFIGURED', 'NOT_CONFIGURED']);
    expect(listed.items.map((i: { revision: number; state: string }) => [i.revision, i.state])).toEqual([
      [1, 'RETURNED'],
      [2, 'DRAFT'],
    ]);
    settlementId = r2.json().id;
    s = await get(prep, settlementId);
    expect((await h.call(prep, 'POST', `/v1/settlements/${settlementId}/submit`, { expectedVersion: s.version })).statusCode).toBe(200);

    // Review (never the preparer, though first on the list), then approval by a third person.
    const rt2 = (await tasks(rev)).find((t) => t.settlement?.id === settlementId)!;
    const k = key();
    const [x, y] = await Promise.all([
      h.call(rev, 'POST', `/v1/settlements/tasks/${rt2.taskId}/review`, { decision: 'APPROVE', idempotencyKey: k }),
      h.call(rev, 'POST', `/v1/settlements/tasks/${rt2.taskId}/review`, { decision: 'APPROVE', idempotencyKey: k }),
    ]);
    expect([x.json().state, y.json().state]).toEqual(['REVIEWED', 'REVIEWED']);
    expect([x.json().replayed, y.json().replayed].sort()).toEqual([false, true]);
    expect(await h.one<{ n: number }>(`select count(*)::int as n from settlement_approval where settlement_id = $1`, [settlementId])).toEqual({ n: 1 });
    expect(await tasks(rev)).toEqual([]);
    expect(await tasks(prep)).toEqual([]);
    const at = (await tasks(appr)).find((t) => t.settlement?.id === settlementId)!;
    expect(at.step).toBe('approve');
    // The review route refuses an approval task (step permission), and the reviewer's own route never sees it.
    expect((await decide(appr, 'review', at.taskId, { decision: 'APPROVE' })).statusCode).toBe(404);
    expect((await decide(appr, 'approve', at.taskId, { decision: 'APPROVE' })).json().state).toBe('APPROVED');
    const approved = await get(appr, settlementId);
    expect(approved).toMatchObject({ state: 'APPROVED', netAmount: '39750.0000', paymentStatus: 'NOT_PAID' });
    expect(approved.decisions.map((d: { action: string; decision: string }) => [d.action, d.decision])).toEqual([
      ['review', 'APPROVE'],
      ['approve', 'APPROVE'],
    ]);
    // The trail names each decider and its stage, so a reader can check independence before marking release.
    expect(approved.decisions.map((d: { kind: string; actorUserId: string }) => [d.kind, d.actorUserId])).toEqual([
      ['settlement', rev.user],
      ['settlement_approval', appr.user],
    ]);
    // access-4 follow-up: each decider also by operational identity, in the hiring history's shape; neither decided for someone else.
    expect(approved.decisions.map((d: { decidedBy: Record<string, unknown>; onBehalfOf: unknown }) => [Object.keys(d.decidedBy).sort(), d.decidedBy.userId, d.onBehalfOf])).toEqual([
      [['displayName', 'employeeCode', 'userId'], rev.user, null],
      [['displayName', 'employeeCode', 'userId'], appr.user, null],
    ]);
    await dispatchOutbox(h.pool);
    expect(((await h.call(prep, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[]).some((n) => n.category === 'SETTLEMENT_DECIDED' && n.body.includes('was approved'))).toBe(true);
  });

  it('reaches release eligibility only by an independent marker after complete clearance, never creating a payment', async () => {
    let s = await get(rel, settlementId);
    const mark = (a: TestActor) => h.call(a, 'POST', `/v1/settlements/${settlementId}/release-eligibility`, { expectedVersion: s.version });
    for (const a of [prep, rev, appr]) expect((await mark(a)).json().error).toBe('NOT_INDEPENDENT');
    expect((await mark(hrPlain)).statusCode).toBe(403);
    expect((await mark(rel)).json().error).toBe('CLEARANCE_NOT_STARTED');
    await publishedTemplate(h, exitHr, 'EXIT_F', 'EXIT', [{ code: 'ASSETS', title: 'Return assets', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
    const clearance = (await h.call(exitHr, 'POST', `/v1/employees/${employeeEmp}/processes`, { processCode: 'EXIT_F', exitCaseId: exitId })).json();
    expect((await mark(rel)).json()).toMatchObject({ error: 'CLEARANCE_INCOMPLETE', details: { tasks: ['ASSETS'] } });
    expect((await h.call(exitHr, 'POST', `/v1/employee-process-tasks/${clearance.tasks[0].id}/complete`, { expectedVersion: 1 })).statusCode).toBe(200);

    const payments = async () =>
      h.one<{ n: number }>(
        `select (select count(*) from payment_instruction where company_id = $1) + (select count(*) from payment_allocation where company_id = $1) + (select count(*) from payment_event where company_id = $1) as n`,
        [A.id],
      );
    const before = await payments();
    s = await get(rel, settlementId);
    // docs/09 §6.5: the release grant is resolved again inside the transaction; withdrawn after the guard, nothing changes.
    const narrowed = await narrowedGrant(h, A, await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT }), 'settlement.release.amount');
    await expect(withTransaction(h.pool, (tx) => markReleaseEligible(tx, narrowed, settlementId, { expectedVersion: s.version }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await get(rel, settlementId)).state).toBe('APPROVED');
    const marked = await mark(rel);
    expect(marked.json()).toMatchObject({ state: 'RELEASE_ELIGIBLE', paymentStatus: 'NOT_PAID' });
    expect(await payments()).toEqual(before);
    expect((await mark(rel)).json().error).toBe('INVALID_STATE');
    // FR-054 list: state, employee search and month filters within scope; amounts only with the amount group.
    const code = marked.json().employeeCode as string;
    const month = today.slice(0, 7);
    const listed = (await h.call(rel, 'GET', `/v1/settlements?state=RELEASE_ELIGIBLE&employeeCode=${encodeURIComponent(code.slice(-6).toLowerCase())}&lastWorkingMonth=${month}`)).json();
    expect(listed.items).toEqual([expect.objectContaining({ id: settlementId, revision: 2, netAmount: '39750.0000' })]);
    expect((await h.call(rel, 'GET', `/v1/settlements?state=DRAFT`)).json().items).toEqual([]);
    expect((await h.call(rel, 'GET', `/v1/settlements?lastWorkingMonth=2001-01`)).json().items).toEqual([]);
    const forPayroll = (await h.call(payroll, 'GET', '/v1/settlements')).json().items;
    expect(forPayroll.map((i: { revision: number; state: string }) => [i.revision, i.state])).toEqual([
      [2, 'RELEASE_ELIGIBLE'],
      [1, 'RETURNED'],
    ]);
    expect(forPayroll[0]).not.toHaveProperty('netAmount');
    expect((await h.call(hrFinance, 'GET', '/v1/settlements')).json().items).toEqual([]);
    // Approved revisions are frozen; a later correction needs a new design (no live successor while eligible).
    expect((await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, {})).json().error).toBe('SETTLEMENT_EXISTS');
  });

  it('exports the approved revision with its context, neutralising formulas; totals equal the net amount', async () => {
    expect((await h.call(payroll, 'GET', `/v1/settlements/${settlementId}/export`)).statusCode).toBe(403);
    const res = await h.call(rel, 'GET', `/v1/settlements/${settlementId}/export`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split('\r\n');
    expect(lines).toContain('"state","RELEASE_ELIGIBLE"');
    expect(lines).toContain('"revision",2');
    // A component name a spreadsheet would read as a formula is written as text.
    expect(lines.find((l) => l.startsWith('"LEAVE_ENC"'))).toBe(`"LEAVE_ENC","'=HYPERLINK(""synthetic"")","EARNING","STANDARD",0.0000`);
    expect(lines.at(-1)).toBe('"NET","","","",39750.0000');
    const body = lines.filter((l) => /^"(BASIC|LOAN|LEAVE_ENC|NOTICE_REC)"/.test(l)).map((l) => l.split(',').at(-1)!);
    expect(body).toEqual(['40000.2500', '0.0000', '-250.2500']);
    // Nothing confidential leaks into audit or outbox payloads.
    const trail = await trailText(h, A.id, [settlementId]);
    expect(trail).toContain('RELEASE_ELIGIBLE');
    expect(trail).not.toMatch(/39750|40000|250\.25/);
  });

  it('keeps identities consistent at the database (CI14, CI12)', async () => {
    const other = await person(h, A, exitHr, { name: 'Olga Other (synthetic)' });
    // Direct writes inside a transaction that is rolled back (the typed-root check is deferred to commit).
    const attempt = async (steps: [string, unknown[]][]) => {
      await h.db.query('begin');
      try {
        for (const [sql, params] of steps) await h.db.query(sql, params);
      } finally {
        await h.db.query('rollback');
      }
    };
    const bt = (kind: string, owner: string, state: string, company = A.id): [string, unknown[]] => [
      `insert into business_transaction (id, company_id, kind, owner_employee_id, state) values ('00000000-0000-4000-8000-000000000001', $1, $2, $3, $4)`,
      [company, kind, owner, state],
    ];
    const T = '00000000-0000-4000-8000-000000000001';
    // A settlement's employee resolves through the same exit case: another employee's exit cannot be used.
    const X = '00000000-0000-4000-8000-000000000002';
    const T2 = '00000000-0000-4000-8000-000000000003';
    await expect(
      attempt([
        bt('exit_case', other, 'SUBMITTED'),
        [
          `insert into exit_case (id, company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
           values ($1, $2, $3, $4, 'RESIGNATION', current_date, current_date, current_date, 'SUBMITTED')`,
          [X, A.id, other, T],
        ],
        [`insert into business_transaction (id, company_id, kind, owner_employee_id, state) values ($1, $2, 'settlement', $3, 'DRAFT')`, [T2, A.id, employeeEmp]],
        [
          `insert into settlement (company_id, exit_case_id, employee_id, revision, transaction_id, state, currency_code, prepared_by) values ($1, $2, $3, 1, $4, 'DRAFT', 'INR', $5)`,
          [A.id, X, employeeEmp, T2, prep.user],
        ],
      ]),
    ).rejects.toThrow(/settlement_company_id_exit_case_id_employee_id_fkey|foreign key/);
    // The approval stage belongs to the settlement's employee.
    const firstRevision = (await h.one<{ id: string }>(`select id from settlement where exit_case_id = $1 and revision = 1`, [exitId])).id;
    await expect(
      attempt([
        bt('settlement_approval', other, 'SUBMITTED'),
        [`insert into settlement_approval (company_id, settlement_id, employee_id, transaction_id, state) values ($1, $2, $3, $4, 'SUBMITTED')`, [A.id, firstRevision, other, T]],
      ]),
    ).rejects.toThrow(/foreign key/);
    // A clearance checklist belongs to the exit's employee.
    const process = await h.one<{ process_id: string; revision_id: string }>(
      `select lp.id as process_id, r.id as revision_id from lifecycle_process lp join lifecycle_process_revision r on r.process_id = lp.id and r.state = 'PUBLISHED' where lp.company_id = $1 and lp.code = 'EXIT_F'`,
      [A.id],
    );
    await expect(
      attempt([
        bt('exit_case', other, 'SUBMITTED'),
        [
          `insert into exit_case (id, company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
           values ($1, $2, $3, $4, 'RESIGNATION', current_date, current_date, current_date, 'SUBMITTED')`,
          [X, A.id, other, T],
        ],
        [`insert into business_transaction (id, company_id, kind, owner_employee_id, state) values ($1, $2, 'employee_process', $3, 'OPEN')`, [T2, A.id, employeeEmp]],
        [
          `insert into employee_process (company_id, employee_id, process_id, process_revision_id, transaction_id, effective_date, owner_user_id, exit_case_id, state)
           values ($1, $2, $3, $4, $5, current_date, $6, $7, 'OPEN')`,
          [A.id, employeeEmp, process.process_id, process.revision_id, T2, exitHr.user, X],
        ],
      ]),
    ).rejects.toThrow(/foreign key/);
    // Another company's employee cannot be the subject of an exit.
    await expect(
      attempt([
        [`insert into business_transaction (id, company_id, kind, state) values ($1, $2, 'exit_case', 'SUBMITTED')`, [T, B.id]],
        [
          `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state) values ($1, $2, $3, 'RESIGNATION', current_date, current_date, current_date, 'SUBMITTED')`,
          [B.id, employeeEmp, T],
        ],
      ]),
    ).rejects.toThrow(/foreign key/);
    // One open exit per employee, even written directly.
    await expect(
      attempt([
        bt('exit_case', employeeEmp, 'SUBMITTED'),
        [
          `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state) values ($1, $2, $3, 'RESIGNATION', current_date, current_date, current_date, 'SUBMITTED')`,
          [A.id, employeeEmp, T],
        ],
      ]),
    ).rejects.toThrow(/exit_case_one_open/);
  });

  it('FR-051 FR-053 refuses approving a withdrawal while the settlement is eligible for release (I-81 item 6)', async () => {
    // The exit's last working date is today, so a withdrawal request is still possible; its approval waits for the release-eligible
    // revision to be paid or voided (money may already be moving); a revision not yet eligible would be voided by it instead.
    const w = await h.call(employee, 'POST', `/v1/me/exit-cases/${exitId}/withdrawal-request`, { reason: 'Synthetic second thoughts' });
    expect(w.statusCode, w.body).toBe(201);
    const t = (await h.call(exitHr, 'GET', '/v1/exit-cases/tasks/mine')).json().items.find((i: { kind: string }) => i.kind === 'exit_withdrawal');
    expect((await h.call(exitHr, 'POST', `/v1/exit-withdrawals/tasks/${t.taskId}/decision`, { decision: 'APPROVE', reason: 'Synthetic', idempotencyKey: key() })).json().error).toBe('SETTLEMENT_RELEASE_ELIGIBLE');
    expect((await h.call(exitHr, 'GET', `/v1/exit-cases/${exitId}`)).json().state).toBe('APPROVED');
  });

  it('pages settlements and the exits awaiting one, with the total of every match in row scope (FR-056)', async () => {
    type Page = { items: { id?: string; exitCaseId: string; state?: string }[]; total: number; page?: number; pageSize?: number; calculation?: { status: string } };
    const list = async (a: TestActor, url: string) => {
      const res = await h.call(a, 'GET', url);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Page;
    };
    const all = await list(prep, '/v1/settlements');
    expect(all.total).toBeGreaterThan(0);
    expect(all.items).toHaveLength(all.total);
    expect(all).not.toHaveProperty('page');
    const first = await list(prep, '/v1/settlements?page=1&pageSize=25');
    expect(first).toMatchObject({ total: all.total, page: 1, pageSize: 25, calculation: { status: 'AVAILABLE' } });
    expect(first.items.map((x) => x.id)).toEqual(all.items.slice(0, 25).map((x) => x.id));
    const past = Math.ceil(all.total / 25) + 1;
    expect(await list(prep, `/v1/settlements?page=${past}&pageSize=25`)).toMatchObject({ items: [], total: all.total, page: past, pageSize: 25 });
    // Filters and row scope apply to the total.
    const state = all.items[0]!.state!;
    expect((await list(prep, `/v1/settlements?state=${state}&page=1&pageSize=25`)).total).toBe(all.items.filter((x) => x.state === state).length);
    expect(await list(hrFinance, '/v1/settlements?page=1&pageSize=25')).toMatchObject({ items: [], total: 0 });
    expect(await list(hrB, '/v1/settlements?page=1&pageSize=25')).toMatchObject({ items: [], total: 0 });
    // The preparer's work list pages the same way.
    const awaiting = await list(prep, '/v1/settlements/awaiting-exits');
    expect(awaiting.items).toHaveLength(awaiting.total);
    const awaitingPast = Math.ceil(awaiting.total / 25) + 1;
    expect(await list(prep, `/v1/settlements/awaiting-exits?page=${awaitingPast}&pageSize=25`)).toEqual({ items: [], total: awaiting.total, page: awaitingPast, pageSize: 25 });
    expect(await list(hrB, '/v1/settlements/awaiting-exits?page=1&pageSize=25')).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
  });
});
