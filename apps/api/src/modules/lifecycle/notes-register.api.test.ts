// The employee notes register (BRD coverage CL-040 "Exit Notes/Remarks/Warnings" under FR-015 to FR-018; FR-018 "restrict notes
// and warnings to authorised HR roles"; BR-044 confidential access; BR-026 scope and filters; FR-056 paging and totals; FR-057
// attributable history; DF08 corrections, never deletions; DF09 bulk upload; FR-106 scanned files; migration 0260). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import type { PermissionKey } from '../access/baseline.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let hrNotes: TestActor;
let hrEng: TestActor;
let hrSelf: TestActor;
let hrB: TestActor;
let manager: TestActor;
let employee: TestActor;
let auditor: TestActor;
let engEmp: { id: string; code: string };
let finEmp: { id: string; code: string };
let selfEmp: { id: string; code: string };
let today: string;

const NOTES: PermissionKey[] = ['employee_note.read.restricted', 'employee_note.write.restricted', 'employee_note.void.restricted', 'employee_note.import.restricted'];
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`, 'latin1').toString('base64');
const csv = (lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n`).toString('base64');
const HEADER = 'employeeCode,noteType,noteDate,text';
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

type Note = { id: string; kind: string; noteDate: string; body: string; status: string; source: string; submittedByName: string | null; employee: { id: string; employeeCode: string }; attachment: { scanState: string } | null; void: { reason: string } | null };
const register = async (a: TestActor, query = '') => {
  const res = await h.call(a, 'GET', `/v1/employee-notes${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: Note[]; total: number; page: number; pageSize: number; ownRecordExcluded: boolean };
};
const write = (a: TestActor, employeeId: string, body: object) => h.call(a, 'POST', `/v1/employees/${employeeId}/notes`, body);
const trail = async (companyId: string) =>
  (await h.one<{ t: string }>(`select coalesce(string_agg(coalesce(before_values::text, '') || coalesce(after_values::text, '') || coalesce(reason, ''), ' '), '') as t from audit_event where company_id = $1`, [companyId])).t;

async function newEmployee(departmentId: string, name: string) {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId, displayName: name }));
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { id: string; employeeCode: string };
  await h.setStatus(A, body.id, 'ACTIVE_CONFIRMED');
  return { id: body.id, code: body.employeeCode };
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  engEmp = await newEmployee(A.dept, 'Synthetic Noor Engineer');
  finEmp = await newEmployee(A.financeDept, 'Synthetic Farid Finance');
  selfEmp = await newEmployee(A.dept, 'Synthetic Selma HR');
  hrNotes = await h.actor(A, 'HR_ADMINISTRATOR', { extra: NOTES });
  hrEng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: NOTES, departmentFilter: A.dept });
  hrSelf = await h.actor(A, 'HR_ADMINISTRATOR', { extra: NOTES, employeeId: selfEmp.id });
  hrB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: NOTES });
  manager = await h.actor(A, 'REPORTING_MANAGER');
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: engEmp.id });
  auditor = await h.actor(A, 'AUDITOR');
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('employee notes register (CL-040; FR-018; BR-044)', () => {
  it('FR-018 BR-044: only an HR assignment holding the restricted notes grant reads, writes or voids; plain HR, the manager, the employee and the auditor are refused', async () => {
    const body = { kind: 'WARNING', body: 'Synthetic warning: late twice', noteDate: daysAgo(2) };
    for (const a of [hr, manager, employee, auditor]) {
      expect((await write(a, engEmp.id, body)).statusCode).toBe(403);
      expect((await h.call(a, 'GET', '/v1/employee-notes')).statusCode).toBe(403);
      expect((await h.call(a, 'GET', `/v1/employees/${engEmp.id}/notes`)).statusCode).toBe(403);
    }
    const created = await write(hrNotes, engEmp.id, body);
    expect(created.statusCode, created.body).toBe(201);
    for (const a of [hr, manager, employee, auditor]) {
      expect((await h.call(a, 'POST', `/v1/employee-notes/${created.json().id}/void`, { reason: 'Synthetic' })).statusCode).toBe(403);
    }
    // The employee does not see notes about them anywhere (FR-018 acceptance; no own-ESS exception covers them, H1).
    expect((await h.call(employee, 'GET', `/v1/employee-notes?search=${engEmp.code}`)).statusCode).toBe(403);
    // Without the void right, a notes reader cannot void.
    const readWrite = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['employee_note.read.restricted', 'employee_note.write.restricted'] });
    expect((await h.call(readWrite, 'POST', `/v1/employee-notes/${created.json().id}/void`, { reason: 'Synthetic' })).statusCode).toBe(403);
    expect((await h.call(readWrite, 'POST', '/v1/employee-note-imports', { fileName: 'n.csv', contentBase64: csv([HEADER]), idempotencyKey: uniq('notes-key-') })).statusCode).toBe(403);
  });

  it('CL-040 FR-018: a note records its type, the date it is about, the text and the submitter; a supporting file is served only once the malware scan released it (FR-106)', async () => {
    const res = await write(hrNotes, engEmp.id, { kind: 'PIP', body: 'Synthetic PIP: weekly check-ins for 60 days', noteDate: daysAgo(10), attachment: { fileName: 'pip.pdf', contentBase64: pdf('synthetic pip plan') } });
    expect(res.statusCode, res.body).toBe(201);
    const note = res.json() as { id: string; noteDate: string; attachment: { id: string; scanState: string } };
    expect(note).toMatchObject({ noteDate: daysAgo(10), attachment: { scanState: 'CLEAN' } });
    const listed = (await register(hrNotes, '?kind=PIP')).items.find((n) => n.id === note.id)!;
    expect(listed).toMatchObject({ kind: 'PIP', noteDate: daysAgo(10), body: 'Synthetic PIP: weekly check-ins for 60 days', status: 'ACTIVE', source: 'ENTRY', employee: { id: engEmp.id, employeeCode: engEmp.code } });
    expect(listed.submittedByName).toBeTruthy();
    const file = await h.call(hrNotes, 'GET', `/v1/employee-notes/${note.id}/attachment`);
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('synthetic pip plan');
    expect((await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'READ_CONTENT'`, [note.id])).n).toBe(1);
    // A flagged file is kept quarantined and never served; the note itself stands.
    const flagged = await write(hrNotes, engEmp.id, { kind: 'WARNING', body: 'Synthetic warning with a flagged file', attachment: { fileName: 'w.pdf', contentBase64: pdf(EICAR_TEST_STRING) } });
    expect(flagged.statusCode, flagged.body).toBe(201);
    expect(flagged.json().attachment.scanState).toBe('QUARANTINED');
    expect((await h.call(hrNotes, 'GET', `/v1/employee-notes/${flagged.json().id}/attachment`)).json().error).toBe('FILE_NOT_RELEASED');
    // Today is the default date; a date after today and an unknown type are refused.
    const plain = await write(hrNotes, engEmp.id, { kind: 'APPRECIATION', body: 'Synthetic appreciation for the release' });
    expect(plain.json().noteDate).toBe(today);
    expect((await write(hrNotes, engEmp.id, { kind: 'WARNING', body: 'Synthetic', noteDate: '2999-01-01' })).json().error).toBe('NOTE_DATE_IN_FUTURE');
    expect((await write(hrNotes, engEmp.id, { kind: 'GOSSIP', body: 'Synthetic' })).statusCode).toBe(400);
    // The database refuses a note dated after today even when the service is bypassed.
    await expect(
      h.db.query(
        `insert into employee_note (company_id, employee_id, note_kind, body, note_date, created_by, acting_assignment_id) values ($1, $2, 'NOTE', 'x', '2999-01-01', $3, $4)`,
        [A.id, engEmp.id, hrNotes.user, hrNotes.assignment],
      ),
    ).rejects.toThrow(/cannot be dated after today/);
  });

  it('FR-056 BR-026: the register filters by date range, type and status, searches employee name, code and submitter, and pages with the total of every match', async () => {
    const tag = uniq('Zq');
    const made: string[] = [];
    for (const [kind, ago] of [['EXIT_NOTE', 40], ['OFFER_REJECTION', 30], ['REMARK', 20], ['WARNING', 5]] as const) {
      const r = await write(hrNotes, finEmp.id, { kind, body: `Synthetic ${tag} ${kind}`, noteDate: daysAgo(ago) });
      expect(r.statusCode, r.body).toBe(201);
      made.push(r.json().id);
    }
    const fin = await register(hrNotes, `?search=${encodeURIComponent('Farid')}`);
    expect(fin.items.every((n) => n.employee.id === finEmp.id)).toBe(true);
    expect(fin.total).toBe(4);
    expect(fin.items.map((n) => n.noteDate)).toEqual([daysAgo(5), daysAgo(20), daysAgo(30), daysAgo(40)]);
    expect((await register(hrNotes, `?search=${finEmp.code.toLowerCase()}`)).total).toBe(4);
    expect((await register(hrNotes, `?search=Farid&from=${daysAgo(35)}&to=${daysAgo(10)}`)).items.map((n) => n.kind)).toEqual(['REMARK', 'OFFER_REJECTION']);
    expect((await register(hrNotes, '?search=Farid&kind=EXIT_NOTE')).items.map((n) => n.id)).toEqual([made[0]]);
    // The submitter's name: the HR user is not linked to an employee, so their account key is searched.
    const key = (await h.one<{ k: string }>(`select account_key as k from user_account where id = $1`, [hrNotes.user])).k;
    expect((await register(hrNotes, `?search=${encodeURIComponent(key)}`)).total).toBeGreaterThanOrEqual(4);
    // Paging: the total counts every match; pages hold the rest.
    const page1 = await register(hrNotes, '?search=Farid&pageSize=25&page=1');
    expect(page1).toMatchObject({ page: 1, pageSize: 25, total: 4 });
    expect((await register(hrNotes, '?search=Farid&page=2')).items).toEqual([]);
    expect((await h.call(hrNotes, 'GET', `/v1/employee-notes?from=${daysAgo(1)}&to=${daysAgo(9)}`)).json().error).toBe('INVALID_PERIOD');
    // Status: voiding one leaves three active.
    expect((await h.call(hrNotes, 'POST', `/v1/employee-notes/${made[2]}/void`, { reason: 'Synthetic: entered on the wrong employee' })).statusCode).toBe(200);
    expect((await register(hrNotes, '?search=Farid&status=ACTIVE')).total).toBe(3);
    expect((await register(hrNotes, '?search=Farid&status=VOIDED')).items.map((n) => n.id)).toEqual([made[2]]);
  });

  it('BR-026 BR-044: row scope holds; another company sees nothing; the caller\'s own record is left out of the register and cannot be written', async () => {
    const mine = await write(hrNotes, selfEmp.id, { kind: 'REMARK', body: 'Synthetic remark about Selma' });
    expect(mine.statusCode).toBe(201);
    const eng = await register(hrEng, '?pageSize=100');
    expect(eng.items.length).toBeGreaterThan(0);
    expect(eng.items.every((n) => n.employee.id !== finEmp.id)).toBe(true);
    expect((await h.call(hrEng, 'GET', `/v1/employees/${finEmp.id}/notes`)).statusCode).toBe(404);
    expect((await write(hrEng, finEmp.id, { kind: 'NOTE', body: 'Synthetic' })).statusCode).toBe(404);
    expect((await register(hrB, '?pageSize=100')).total).toBe(0);
    const self = await register(hrSelf, '?pageSize=100');
    expect(self.ownRecordExcluded).toBe(true);
    expect(self.items.some((n) => n.employee.id === selfEmp.id)).toBe(false);
    expect(self.items.some((n) => n.employee.id === engEmp.id)).toBe(true);
    expect((await write(hrSelf, selfEmp.id, { kind: 'APPRECIATION', body: 'Synthetic self praise' })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    expect((await h.call(hrSelf, 'POST', `/v1/employee-notes/${mine.json().id}/void`, { reason: 'Synthetic' })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    expect((await h.call(hrSelf, 'GET', `/v1/employee-notes/${mine.json().id}/attachment`)).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    // A note of another company reads as missing.
    expect((await h.call(hrB, 'POST', `/v1/employee-notes/${mine.json().id}/void`, { reason: 'Synthetic' })).statusCode).toBe(404);
  });

  it('DF08 FR-057: notes are never edited or deleted; a void keeps the note with its reason, once, audited without the text; a corrected note is not voided and a voided one not corrected', async () => {
    const first = (await write(hrNotes, engEmp.id, { kind: 'EXIT_NOTE', body: 'Synthetic exit note: secret handover detail' })).json();
    const voided = await h.call(hrNotes, 'POST', `/v1/employee-notes/${first.id}/void`, { reason: 'Synthetic void reason: duplicate entry' });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json()).toMatchObject({ status: 'VOIDED', body: 'Synthetic exit note: secret handover detail', void: { reason: 'Synthetic void reason: duplicate entry' } });
    expect((await h.call(hrNotes, 'POST', `/v1/employee-notes/${first.id}/void`, { reason: 'again' })).json().error).toBe('ALREADY_VOIDED');
    expect((await write(hrNotes, engEmp.id, { kind: 'EXIT_NOTE', body: 'Synthetic correction', supersedesNoteId: first.id })).json().error).toBe('NOTE_VOIDED');
    const second = (await write(hrNotes, engEmp.id, { kind: 'WARNING', body: 'Synthetic warning to correct' })).json();
    const correction = (await write(hrNotes, engEmp.id, { kind: 'WARNING', body: 'Synthetic corrected warning', supersedesNoteId: second.id })).json();
    expect((await h.call(hrNotes, 'POST', `/v1/employee-notes/${second.id}/void`, { reason: 'Synthetic' })).json().error).toBe('ALREADY_SUPERSEDED');
    const listed = (await register(hrNotes, '?pageSize=100')).items;
    expect(listed.find((n) => n.id === second.id)!.status).toBe('SUPERSEDED');
    expect(listed.find((n) => n.id === correction.id)!.status).toBe('ACTIVE');
    // The database holds the same rules whatever the caller.
    await expect(h.db.query(`update employee_note set body = 'changed' where id = $1`, [first.id])).rejects.toThrow(/append-only/);
    await expect(h.db.query(`delete from employee_note where id = $1`, [first.id])).rejects.toThrow(/append-only/);
    await expect(h.db.query(`delete from employee_note_void where note_id = $1`, [first.id])).rejects.toThrow(/append-only/);
    await expect(
      h.db.query(`insert into employee_note_void (company_id, note_id, employee_id, reason, voided_by, acting_assignment_id) values ($1, $2, $3, 'x', $4, $5)`, [
        A.id,
        second.id,
        engEmp.id,
        hrNotes.user,
        hrNotes.assignment,
      ]),
    ).rejects.toThrow(/corrected note cannot be voided/);
    await expect(
      h.db.query(
        `insert into employee_note (company_id, employee_id, note_kind, body, note_date, supersedes_note_id, created_by, acting_assignment_id) values ($1, $2, 'NOTE', 'x', $3, $4, $5, $6)`,
        [A.id, engEmp.id, today, first.id, hrNotes.user, hrNotes.assignment],
      ),
    ).rejects.toThrow(/voided note cannot be corrected/);
    // Audited (create and void, by whom), never with the text or the reason.
    const actions = (await h.db.query<{ action: string }>(`select action from audit_event where company_id = $1 and record_key = $2 order by occurred_at`, [A.id, first.id])).rows.map((r) => r.action);
    expect(actions).toEqual(['CREATE', 'VOID']);
    const text = await trail(A.id);
    expect(text).not.toContain('secret handover detail');
    expect(text).not.toContain('duplicate entry');
    // A void needs a reason.
    expect((await h.call(hrNotes, 'POST', `/v1/employee-notes/${correction.id}/void`, { reason: '   ' })).json().error).toBe('REASON_REQUIRED');
  });

  it('DF09 FR-018: the bulk upload previews without writing, commits once, refuses repeats, unknown types, future dates, rows out of scope and one\'s own record', async () => {
    const tag = uniq('Bulk');
    const lines = [HEADER, `${engEmp.code},Appreciation,${daysAgo(3)},Synthetic ${tag} praise`, `${finEmp.code},Remarks,${daysAgo(4)},Synthetic ${tag} remark`, `${engEmp.code},PIP,${daysAgo(5)},"Synthetic ${tag} plan, with a comma"`];
    const count = async () => (await h.one<{ n: number }>(`select count(*)::int as n from employee_note where company_id = $1 and body like $2`, [A.id, `%${tag}%`])).n;
    const key = uniq('notes-key-');
    const staged = await h.call(hrNotes, 'POST', '/v1/employee-note-imports', { fileName: 'notes.csv', contentBase64: csv(lines), idempotencyKey: key });
    expect(staged.statusCode, staged.body).toBe(201);
    expect(staged.json()).toMatchObject({ state: 'PREVIEWED', rowCount: 3 });
    expect(staged.json().rows.map((r: { businessKey: string; errorCode: string | null }) => [r.businessKey, r.errorCode])).toEqual([
      [`${engEmp.code}/APPRECIATION/${daysAgo(3)}`, null],
      [`${finEmp.code}/REMARK/${daysAgo(4)}`, null],
      [`${engEmp.code}/PIP/${daysAgo(5)}`, null],
    ]);
    // The preview wrote nothing, and its rows never carry the note text.
    expect(await count()).toBe(0);
    expect(JSON.stringify(staged.json())).not.toContain(tag);
    // The same upload again (same key) is the same batch.
    expect((await h.call(hrNotes, 'POST', '/v1/employee-note-imports', { fileName: 'notes.csv', contentBase64: csv(lines), idempotencyKey: key })).json().id).toBe(staged.json().id);
    const committed = await h.call(hrNotes, 'POST', `/v1/employee-note-imports/${staged.json().id}/commit`);
    expect(committed.json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 3 });
    expect(await count()).toBe(3);
    // Committing again changes nothing.
    expect((await h.call(hrNotes, 'POST', `/v1/employee-note-imports/${staged.json().id}/commit`)).json()).toMatchObject({ state: 'COMMITTED' });
    expect(await count()).toBe(3);
    const imported = (await register(hrNotes, `?search=Farid&kind=REMARK`)).items.find((n) => n.body === `Synthetic ${tag} remark`)!;
    expect(imported).toMatchObject({ source: 'IMPORT', noteDate: daysAgo(4), status: 'ACTIVE' });
    // The same file under a new key: every row is already on record, so the batch is rejected and adds nothing.
    const again = await h.call(hrNotes, 'POST', '/v1/employee-note-imports', { fileName: 'notes.csv', contentBase64: csv(lines), idempotencyKey: uniq('notes-key-') });
    expect(again.json().state).toBe('REJECTED');
    expect(again.json().rows.map((r: { errorCode: string }) => r.errorCode)).toEqual(['DUPLICATE_NOTE', 'DUPLICATE_NOTE', 'DUPLICATE_NOTE']);
    expect(await count()).toBe(3);
    // Row problems are named per row and the whole batch is refused (all or nothing).
    const bad = await h.call(hrNotes, 'POST', '/v1/employee-note-imports', {
      fileName: 'bad.csv',
      contentBase64: csv([
        HEADER,
        `${engEmp.code},Warning,${daysAgo(1)},Synthetic ${tag} fine row`,
        `${engEmp.code},Warning,${daysAgo(1)},Synthetic ${tag} fine row`,
        `${engEmp.code},Gossip,${daysAgo(1)},Synthetic ${tag} bad type`,
        `${engEmp.code},Warning,2999-01-01,Synthetic ${tag} future`,
        `NOBODY-${tag},Warning,${daysAgo(1)},Synthetic ${tag} unknown`,
        `${engEmp.code},Warning,${daysAgo(1)},`,
      ]),
      idempotencyKey: uniq('notes-key-'),
    });
    expect(bad.json().state).toBe('REJECTED');
    expect(bad.json().rows.map((r: { errorCode: string }) => r.errorCode)).toEqual(['BATCH_REJECTED', 'DUPLICATE_IN_BATCH', 'UNKNOWN_NOTE_TYPE', 'NOTE_DATE_IN_FUTURE', 'UNKNOWN_EMPLOYEE', 'INVALID_TEXT']);
    expect(await count()).toBe(3);
    // Scope and own record per row.
    const scoped = await h.call(hrEng, 'POST', '/v1/employee-note-imports', { fileName: 's.csv', contentBase64: csv([HEADER, `${finEmp.code},Warning,${daysAgo(1)},Synthetic ${tag} out of scope`]), idempotencyKey: uniq('notes-key-') });
    expect(scoped.json().rows[0].errorCode).toBe('OUT_OF_SCOPE');
    const own = await h.call(hrSelf, 'POST', '/v1/employee-note-imports', { fileName: 'o.csv', contentBase64: csv([HEADER, `${selfEmp.code},Appreciation,${daysAgo(1)},Synthetic ${tag} own`]), idempotencyKey: uniq('notes-key-') });
    expect(own.json().rows[0].errorCode).toBe('OWN_RECORD');
    // A batch belongs to its submitter.
    expect((await h.call(hrEng, 'GET', `/v1/employee-note-imports/${staged.json().id}`)).statusCode).toBe(404);
    // The published template is exactly the header.
    const template = await h.call(hrNotes, 'GET', '/v1/employee-note-imports/template');
    expect(template.body.trim()).toBe(HEADER);
  });
});
