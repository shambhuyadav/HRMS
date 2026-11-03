// FR-034 loan and advance upload over HTTP (LOAN_REQUESTS_V1; H3 TN15; I-32; C4; DF09; FR-106; I-13): every row is the
// request POST /payroll-outputs/employees/:id/loans makes, under the same grant and confidential loan group, all or
// nothing; every uploaded loan is REQUESTED and waits for its own independent decision, exactly as a single request;
// and the shared follow-up routes (the submitter's own batches, the malware-scan hold, the published template).
// Synthetic employees, amounts and purposes only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { calendar, CONFIG, head, months, ok, person, today, trailText } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';

const L = (a: string) => `payroll_loan.${a}.loan` as PermissionKey;
const ENTER: PermissionKey[] = [L('read'), L('request')];
const DECIDE: PermissionKey[] = [L('read'), L('decide')];
const MAKER: PermissionKey[] = [L('read'), L('request'), L('decide')];
const HEADER = 'employeeCode,loanKind,currencyCode,principal,purpose';
const IMPORTS = '/v1/payroll-outputs/loan-imports';

type Job = { id: string; state: string; template: string; rowCount: number; acceptedCount: number; rejectedCount: number; rows: { rowNumber: number; businessKey: string; state: string; errorCode: string | null; proposedChanges: unknown }[] };
type LoanRow = { id: string; state: string; request_origin: string; requested_by: string; loan_kind: string; principal: string; purpose: string; idempotency_key: string | null; decided_at: string | null };

const csv = (...rows: string[]) => [HEADER, ...rows].join('\r\n');

describe.runIf(isModuleActive('payroll-outputs'))('loan and advance upload (FR-034 "entry and upload", TN15)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let maker: TestActor;
  let decider: TestActor;
  let auditor: TestActor;
  let businessMonth: string;

  const upload = (a: TestActor, text: string, idempotencyKey = uniq('loan-import-')) =>
    h.call(a, 'POST', IMPORTS, { fileName: 'loan-requests.csv', contentBase64: Buffer.from(text).toString('base64'), idempotencyKey });
  const codeOf = async (employeeId: string) => (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [employeeId])).c;
  const employee = async (opts: { departmentId?: string } = {}) => {
    const id = await person(h, A, hr, opts);
    return { id, code: await codeOf(id) };
  };
  const loansOf = async (...employeeIds: string[]) =>
    (
      await h.db.query<LoanRow>(
        `select id, state, request_origin, requested_by, loan_kind, principal::text as principal, purpose, idempotency_key, decided_at
           from payroll_loan where employee_id = any($1::uuid[]) order by requested_at, principal`,
        [employeeIds],
      )
    ).rows;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: MAKER });
    decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE });
    auditor = await h.actor(A, 'AUDITOR');
    // An active INR payroll calendar (two decimals) and an input-valued deduction head for the recovery.
    await calendar(h, configA, configB, months(2026));
    await head(h, configA, configB, { code: 'LU_RECOVERY', headType: 'DEDUCTION', basis: 'INPUT', sequence: 1 });
    businessMonth = (await today(h, A)).slice(0, 7);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('previews without entering anything, then enters every row as a REQUESTED loan that waits for its own independent decision', async () => {
    const one = await employee();
    const two = await employee();
    const res = await upload(maker, csv(`${one.code.toLowerCase()},LOAN,INR,6789.25,Synthetic household purchase`,`${two.code},ADVANCE,INR,1500.5,"Synthetic advance, school fees"`, `${one.code},ADVANCE,INR,250,Synthetic travel advance`));
    expect(res.statusCode, res.body).toBe(201);
    const job = res.json() as Job;
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'LOAN_REQUESTS_V1', rowCount: 3 });
    expect(job.rows.map((r) => [r.businessKey, r.state])).toEqual([
      [one.code, 'VALID'],
      [two.code, 'VALID'],
      [one.code, 'VALID'],
    ]);
    // The import rows keep the employee code only: never a principal or a purpose.
    expect(job.rows.every((r) => r.proposedChanges === null)).toBe(true);
    expect(JSON.stringify(job)).not.toContain('6789');
    expect(JSON.stringify(job)).not.toContain('household');
    expect(await loansOf(one.id, two.id)).toEqual([]);

    const done = (await h.call(maker, 'POST', `${IMPORTS}/${job.id}/commit`)).json() as Job;
    expect(done).toMatchObject({ state: 'COMMITTED', acceptedCount: 3, rejectedCount: 0 });
    // Each row is a request as the single Admin-entered request makes it: REQUESTED, undecided, entered by the uploader.
    const loans = await loansOf(one.id, two.id);
    expect(loans.map((l) => [l.loan_kind, l.principal, l.purpose, l.state, l.request_origin, l.requested_by, l.decided_at, l.idempotency_key])).toEqual(
      expect.arrayContaining([
        ['LOAN', '6789.2500', 'Synthetic household purchase','REQUESTED', 'ADMIN', maker.user, null, null],
        ['ADVANCE', '1500.5000', 'Synthetic advance, school fees', 'REQUESTED', 'ADMIN', maker.user, null, null],
        ['ADVANCE', '250.0000', 'Synthetic travel advance', 'REQUESTED', 'ADMIN', maker.user, null, null],
      ]),
    );
    expect(loans).toHaveLength(3);
    // Each is audited as the single request audits it.
    const requests = await h.db.query(`select 1 from audit_event where company_id = $1 and resource_code = 'payroll_loan' and action = 'REQUEST' and actor_user_id = $2 and record_key = any($3::uuid[])`, [
      A.id,
      maker.user,
      loans.map((l) => l.id),
    ]);
    expect(requests.rowCount).toBe(3);

    // Every uploaded loan is in the decision queue on its own and is decided loan by loan, never by the uploader.
    const queued = await ok<{ items: { id: string }[] }>(await h.call(decider, 'GET', `/v1/payroll-outputs/loans?state=REQUESTED&employeeId=${one.id}`));
    expect(queued.items.map((l) => l.id).sort()).toEqual(loans.filter((l) => l.principal !== '1500.5000').map((l) => l.id).sort());
    const decide = async (a: TestActor, id: string, body: Record<string, unknown>) => {
      const l = await ok<{ version: number }>(await h.call(decider, 'GET', `/v1/payroll-outputs/loans/${id}`));
      return h.call(a, 'POST', `/v1/payroll-outputs/loans/${id}/decision`, { expectedVersion: l.version, ...body });
    };
    for (const l of loans) expect((await decide(maker, l.id, { decision: 'REJECT', reason: 'Synthetic: x' })).json().error).toBe('NOT_INDEPENDENT');
    const [first, second, third] = [loans.find((l) => l.principal === '6789.2500')!, loans.find((l) => l.principal === '1500.5000')!, loans.find((l) => l.principal === '250.0000')!];
    const schedule = [{ dueMonth: businessMonth, amount: '6789.25' }];
    expect(await ok(await decide(decider, first.id, { decision: 'APPROVE', recoveryComponentCode: 'LU_RECOVERY', installments: schedule }))).toMatchObject({ state: 'APPROVED' });
    expect(await ok(await decide(decider, second.id, { decision: 'REJECT', reason: 'Synthetic: not eligible' }))).toMatchObject({ state: 'REJECTED' });
    expect((await loansOf(one.id, two.id)).find((l) => l.id === third.id)).toMatchObject({ state: 'REQUESTED', decided_at: null });

    // Committing again changes nothing.
    expect((await h.call(maker, 'POST', `${IMPORTS}/${job.id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 3 });
    expect(await loansOf(one.id, two.id)).toHaveLength(3);
    // No principal or purpose in operational audit values or the outbox.
    const trail = await trailText(h, A.id);
    for (const t of [trail.operational, trail.outbox]) {
      expect(t).not.toContain('6789');
      expect(t).not.toContain('Synthetic household purchase');
    }
  });

  it('applies exactly the rules of the single request: one row with a problem rejects the whole batch and enters nothing', async () => {
    const e = await employee();
    const valid = await employee();
    const cases: [string, string][] = [
      [`${e.code},LOAN,INR,6000.00,`, 'PURPOSE_REQUIRED'],
      [`${e.code},GIFT,INR,100.00,Synthetic`, 'INVALID_LOAN_KIND'],
      [`${e.code},LOAN,inr,100.00,Synthetic`, 'INVALID_CURRENCY'],
      [`${e.code},LOAN,INR,"1,000.00",Synthetic`, 'INVALID_AMOUNT'],
      [`${e.code},LOAN,INR,100.123,Synthetic`, 'INVALID_AMOUNT'],
      [`${e.code},LOAN,INR,0,Synthetic`, 'INVALID_AMOUNT'],
      [`${e.code},LOAN,USD,100.00,Synthetic`, 'CURRENCY_NOT_CONFIGURED'],
      [`NOBODY-${uniq('x')},LOAN,INR,100.00,Synthetic`, 'UNKNOWN_EMPLOYEE'],
      [`${e.code},LOAN,INR,100.00`, 'COLUMN_COUNT'],
    ];
    const job = (await upload(maker, csv(...cases.map(([row]) => row), `${valid.code},LOAN,INR,100.00,Synthetic valid row`))).json() as Job;
    expect(job.state).toBe('REJECTED');
    expect(job.rows.map((r) => r.errorCode)).toEqual([...cases.map(([, code]) => code), 'BATCH_REJECTED']);
    expect(job.rows.every((r) => r.state === 'REJECTED')).toBe(true);
    expect((await h.call(maker, 'POST', `${IMPORTS}/${job.id}/commit`)).statusCode).toBe(409);
    expect(await loansOf(e.id, valid.id)).toEqual([]);
    // The single request refuses the same values in the same words (the route schema answers 400 for the cell patterns).
    const single = (body: Record<string, unknown>) =>
      h.call(maker, 'POST', `/v1/payroll-outputs/employees/${e.id}/loans`, { loanKind: 'LOAN', currencyCode: 'INR', principal: '100.00', purpose: 'Synthetic', ...body });
    expect((await single({ currencyCode: 'USD' })).json().error).toBe('CURRENCY_NOT_CONFIGURED');
    expect((await single({ principal: '100.123' })).json().error).toBe('INVALID_AMOUNT');
    expect((await single({ principal: '0' })).json().error).toBe('INVALID_AMOUNT');
    expect((await single({ purpose: ' ' })).json().error).toBe('PURPOSE_REQUIRED');
    for (const over of [{ loanKind: 'GIFT' }, { currencyCode: 'inr' }, { principal: '1,000.00' }]) expect((await single(over)).statusCode, JSON.stringify(over)).toBe(400);
    expect(await loansOf(e.id)).toEqual([]);

    // A row that becomes invalid before the commit rejects the batch: the uploader is now the second employee.
    const linked = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ENTER });
    const previewed = (await upload(linked, csv(`${e.code},LOAN,INR,100.00,Synthetic one`, `${valid.code},LOAN,INR,200.00,Synthetic two`))).json() as Job;
    expect(previewed.state).toBe('PREVIEWED');
    await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [A.id, linked.user, valid.id]);
    const done = (await h.call(linked, 'POST', `${IMPORTS}/${previewed.id}/commit`)).json() as Job;
    expect(done.state).toBe('REJECTED');
    expect(done.rows.map((r) => r.errorCode)).toEqual(['BATCH_REJECTED', 'SELF_ACTION_NOT_ALLOWED']);
    expect(await loansOf(e.id, valid.id)).toEqual([]);
  });

  it('needs payroll_loan.request with the loan group; row scope and never-self apply per row; a batch is its submitter’s; a replay changes nothing', async () => {
    const inDept = await employee();
    const finance = await employee({ departmentId: A.financeDept });
    const file = csv(`${finance.code},ADVANCE,INR,900.00,Synthetic finance advance`, `${inDept.code},ADVANCE,INR,100.00,Synthetic advance`);
    for (const a of [hr, decider, auditor]) {
      expect((await upload(a, file)).statusCode).toBe(403);
      expect((await h.call(a, 'GET', `${IMPORTS}/template`)).statusCode).toBe(403);
      expect((await h.call(a, 'GET', IMPORTS)).statusCode).toBe(403);
    }
    // Row scope: an employee outside the role's department filter.
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ENTER, departmentFilter: A.dept });
    expect(((await upload(narrow, file)).json() as Job).rows.map((r) => r.errorCode)).toEqual(['OUT_OF_SCOPE', 'BATCH_REJECTED']);
    // Never the caller's own record, as the single request refuses it.
    const own = await employee();
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ENTER, employeeId: own.id });
    expect(((await upload(self, csv(`${own.code},LOAN,INR,100.00,Synthetic own`))).json() as Job).rows.map((r) => r.errorCode)).toEqual(['SELF_ACTION_NOT_ALLOWED']);
    expect((await h.call(self, 'POST', `/v1/payroll-outputs/employees/${own.id}/loans`, { loanKind: 'LOAN', currencyCode: 'INR', principal: '100.00', purpose: 'Synthetic own' })).json().error).toBe(
      'SELF_ACTION_NOT_ALLOWED',
    );
    // Another company's Admin holding the duty finds none of this company's employees.
    const B = await h.makeCompany();
    const foreign = await h.actor(B, 'HR_ADMINISTRATOR', { extra: ENTER });
    expect(((await upload(foreign, csv(`${inDept.code},ADVANCE,INR,100.00,Synthetic`))).json() as Job).rows.map((r) => r.errorCode)).toEqual(['UNKNOWN_EMPLOYEE']);

    // A batch belongs to its submitter; the same upload again under its key is the same batch, before and after commit.
    const other = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ENTER });
    const k = uniq('loan-import-');
    const single = csv(`${inDept.code},ADVANCE,INR,100.00,Synthetic replayed advance`);
    const job = (await upload(maker, single, k)).json() as Job;
    expect(job.state).toBe('PREVIEWED');
    for (const path of ['', '/commit', '/cancel']) expect((await h.call(other, path ? 'POST' : 'GET', `${IMPORTS}/${job.id}${path}`)).statusCode, path).toBe(404);
    expect((await upload(other, single, k)).json().error).toBe('IDEMPOTENCY_KEY_IN_USE');
    const again = await upload(maker, single, k);
    expect([again.statusCode, again.json().id]).toEqual([200, job.id]);
    expect((await h.call(maker, 'POST', `${IMPORTS}/${job.id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 1 });
    expect((await h.call(maker, 'POST', `${IMPORTS}/${job.id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 1 });
    const replayed = await upload(maker, single, k);
    expect([replayed.statusCode, replayed.json().id, replayed.json().state]).toEqual([200, job.id, 'COMMITTED']);
    expect(await loansOf(inDept.id, finance.id)).toEqual([expect.objectContaining({ principal: '100.0000', state: 'REQUESTED' })]);
    expect((await upload(maker, 'employeeCode,loanKind,currencyCode,principal,purpose,interestRate\r\nX,LOAN,INR,1,x,1.5')).json().error).toBe('INVALID_HEADER');
  });

  it('serves the published LOAN_REQUESTS_V1 template: exactly the header the upload checks and no rows (DF09)', async () => {
    const res = await h.call(maker, 'GET', `${IMPORTS}/template`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="LOAN_REQUESTS_V1.csv"');
    expect(res.body).toBe(`${HEADER}\r\n`);
  });

  followUpSuite({
    path: IMPORTS,
    template: 'LOAN_REQUESTS_V1',
    harness: () => h,
    company: () => A,
    submitter: () => h.actor(A, 'HR_ADMINISTRATOR', { extra: ENTER }),
    denied: async () => [await h.actor(A, 'HR_ADMINISTRATOR'), await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE }), await h.actor(A, 'AUDITOR')],
    // Nothing is committed, so any employee in scope will do.
    validFile: async () => {
      const e = await employee();
      return { text: csv(`${e.code},ADVANCE,INR,100.00,Synthetic advance`), rows: 1 };
    },
  });
});
