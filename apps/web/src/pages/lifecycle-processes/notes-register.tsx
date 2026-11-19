// The notes register (CL-040; FR-018): the register, new notes, voiding, the bulk upload and the register export.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, download, type EmployeeHit, fileToBase64, formatDate, idempotencyKey, isForbidden, localDate, plural, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, NotPermitted, Pager, Section, When } from '../../ui';
import { keepOnPage, ReportExport } from '../leave-admin';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from '../records';
import { NOTE_EXPORT } from './absconding-audit';
import { Refusal } from './refusals';
import { AbscondingMark, EMPLOYEE_LIST, EMPLOYEE_PAGE_SIZE, FIELDS, FILE_NAME, H3, ISO_DATE, Loading, MAX_FILE_BYTES, MAX_FILE_NAME, MAX_NOTE, NOTE_KINDS, NOTE_READ, NOTE_WRITE, noteKindLabel, noteTypeText, Notice, type NoticeState, type Paged, pagedUrl, PATHS, Problem, QueryProblem, ReasonField, RoleReady, SCAN_TEXT, SCAN_TONE, SCROLL, shown, totalOf, useKeys, userText } from './shared';
import type { NoteKind, ScanState } from './types';

// ---------------------------------------------------------------------------------------------------------
// The notes register (CL-040 "Exit Notes/Remarks/Warnings"; FR-018; DF08; DF09; FR-106; migration 0260): every restricted note about
// the employees in the selected role's scope (never the user's own record), filtered by date range, type and status and searched
// by employee name or code or the submitter's name, a page at a time with the total; a new note with an optional supporting file;
// a note withdrawn by mistake is voided with a reason (it stays, marked voided); and the bulk upload (EMPLOYEE_NOTES_V1) through
// the shared import lifecycle. The server checks every right and rule; the screens show only what it returned.
// ---------------------------------------------------------------------------------------------------------
const NOTE_VOID = 'employee_note.void.restricted';
export const NOTE_IMPORT = 'employee_note.import.restricted';
const NOTE_STATUSES: readonly (readonly [string, string])[] = [
  ['ACTIVE', 'Active'],
  ['SUPERSEDED', 'Corrected by a later note'],
  ['VOIDED', 'Voided'],
];
const NOTE_STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { ACTIVE: 'good', SUPERSEDED: 'neutral', VOIDED: 'bad' };
const noteStatusLabel = (s: string) => NOTE_STATUSES.find(([k]) => k === s)?.[1] ?? readable(s);

/** A note as the register lists it (GET /v1/employee-notes). */
interface RegisterNote {
  id: string;
  kind: string;
  /** CL-052 (0283): a warning's category. */
  warningCategory?: string | null;
  noteDate: string;
  body: string;
  source: 'ENTRY' | 'IMPORT';
  status: string;
  supersedesNoteId: string | null;
  supersededByNoteId: string | null;
  void: { reason: string; voidedAt: string; voidedBy: string } | null;
  attachment: { id: string; fileName: string | null; scanState: ScanState } | null;
  createdBy: string;
  submittedByName: string | null;
  createdAt: string;
  employee: { id: string; employeeCode: string; displayName: string };
}
interface RegisterFilters {
  from: string;
  to: string;
  kind: string;
  status: string;
  search: string;
}
const NO_FILTERS: RegisterFilters = { from: '', to: '', kind: '', status: '', search: '' };

export function NotesRegisterScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Exit notes, remarks and warnings</h1>
      <RoleReady>
        {can(NOTE_READ) ? (
          <NotesRegister />
        ) : (
          <Section title="Notes register">
            <NotPermitted>The selected role cannot read restricted notes.</NotPermitted>
          </Section>
        )}
        {can(NOTE_WRITE) && <NewRegisterNote />}
        {can(NOTE_IMPORT) && can(NOTE_WRITE) && (
          <p className="hint">
            <Link to={PATHS.notesUpload}>Upload several notes from a file</Link>
          </p>
        )}
      </RoleReady>
    </>
  );
}

function NotesRegister() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<RegisterFilters>(NO_FILTERS);
  const [applied, setApplied] = useState<RegisterFilters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<RegisterNote | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const query = new URLSearchParams(
    Object.entries(applied)
      .map(([k, v]) => [k, v.trim()] as [string, string])
      .filter(([, v]) => v !== ''),
  );
  const list = useQuery({
    queryKey: [...keys.notes('register'), query.toString(), page],
    queryFn: () => api<Paged<RegisterNote> & { ownRecordExcluded?: boolean }>(pagedUrl('/v1/employee-notes', page, query)),
    retry: retryTransient,
  });
  const file = useMutation({ mutationFn: (id: string) => download(`/v1/employee-notes/${id}/attachment`) });
  const data = shown(list);
  const field = (k: keyof RegisterFilters) => ({ value: draft[k], onChange: (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value })) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.from && draft.to && draft.to < draft.from) {
      setProblem('The period ends before it starts.');
      return;
    }
    setProblem(null);
    setApplied(draft);
    setPage(1);
  };
  const canVoid = can(NOTE_VOID);
  return (
    <Section title="Notes register">
      <p className="hint">Restricted notes about the employees in the selected role’s scope; notes about your own record are never shown. Notes are never changed or deleted: a correction is a new note, and a note recorded by mistake is voided with a reason and stays on record.</p>
      <form role="search" aria-label="Filter notes" className="stack" onSubmit={submit}>
        <div style={FIELDS}>
          <label>
            From
            <input type="date" {...field('from')} />
          </label>
          <label>
            To
            <input type="date" {...field('to')} />
          </label>
          <label>
            Type
            <select {...field('kind')}>
              <option value="">All types</option>
              {NOTE_KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select {...field('status')}>
              <option value="">Any status</option>
              {NOTE_STATUSES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Employee, code or submitted by
            <input maxLength={100} {...field('search')} />
          </label>
        </div>
        <div className="row">
          <button type="submit">Show notes</button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setDraft(NO_FILTERS);
              setApplied(NO_FILTERS);
              setPage(1);
              setProblem(null);
            }}
          >
            Clear filters
          </button>
        </div>
        <Problem text={problem} />
      </form>
      <Notice notice={notice} />
      {list.isPending && <Loading>Loading the notes…</Loading>}
      <QueryProblem error={list.error} forbidden="The selected role cannot read restricted notes." />
      {data && data.items.length === 0 && <Empty>No notes match.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <p className="hint">{plural(totalOf(data), 'note')} match.</p>
          <table aria-label="Notes">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Employee</th>
                <th scope="col">Type</th>
                <th scope="col">Note</th>
                <th scope="col">Submitted by</th>
                <th scope="col">Status</th>
                <th scope="col">File</th>
                {canVoid && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {data.items.map((n) => (
                <tr key={n.id}>
                  <td>{formatDate(n.noteDate)}</td>
                  <td>
                    {n.employee.displayName} <span className="hint">({n.employee.employeeCode})</span>
                  </td>
                  <td>
                    <Badge tone={n.kind === 'WARNING' || n.kind === 'PIP' ? 'warn' : 'neutral'}>{noteTypeText(n)}</Badge>
                    {n.source === 'IMPORT' && <div className="hint">uploaded</div>}
                  </td>
                  <td>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                    {n.void && <div className="hint">{`Voided: ${n.void.reason}`}</div>}
                    {n.supersedesNoteId && <div className="hint">Corrects an earlier note.</div>}
                  </td>
                  <td>
                    {n.createdBy === me?.userId ? 'You' : (n.submittedByName ?? userText(n.createdBy, null))}
                    <div className="hint">
                      <When at={n.createdAt} />
                    </div>
                  </td>
                  <td>
                    <Badge tone={NOTE_STATUS_TONE[n.status] ?? 'neutral'}>{noteStatusLabel(n.status).toLowerCase()}</Badge>
                  </td>
                  <td>
                    {!n.attachment ? (
                      '—'
                    ) : n.attachment.scanState === 'CLEAN' ? (
                      <button type="button" className="link" disabled={file.isPending} onClick={() => file.mutate(n.id)}>
                        {n.attachment.fileName ?? 'Download the file'}
                      </button>
                    ) : (
                      <Badge tone={SCAN_TONE[n.attachment.scanState ?? ''] ?? 'neutral'}>{SCAN_TEXT[n.attachment.scanState ?? ''] ?? 'not available'}</Badge>
                    )}
                  </td>
                  {canVoid && (
                    <td>
                      {n.status === 'ACTIVE' && (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`Void the ${noteKindLabel(n.kind).toLowerCase()} of ${formatDate(n.noteDate)} about ${n.employee.displayName}`}
                          onClick={() => {
                            setVoiding(n);
                            setNotice(null);
                          }}
                        >
                          Void
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(data)} onPage={setPage} label="Note pages" noun="note" />}
      {can(NOTE_EXPORT) && <NotesRegisterExport filters={applied} />}
      <ErrorNote error={file.error} />
      {voiding && (
        <VoidNoteForm
          key={voiding.id}
          note={voiding}
          onCancel={() => setVoiding(null)}
          onDone={(text) => {
            setVoiding(null);
            setNotice({ text, ok: true });
            void qc.invalidateQueries({ queryKey: keys.notes('register') });
            void qc.invalidateQueries({ queryKey: keys.notes(voiding.employee.id) });
          }}
        />
      )}
    </Section>
  );
}

function VoidNoteForm({ note, onCancel, onDone }: { note: RegisterNote; onCancel: () => void; onDone: (text: string) => void }) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (text: string) => api<RegisterNote>(`/v1/employee-notes/${note.id}/void`, { body: { reason: text } }),
    onSuccess: () => onDone(`Voided the ${noteKindLabel(note.kind).toLowerCase()} about ${note.employee.displayName}; it stays on record, marked voided.`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const text = reason.trim();
    if (!text) {
      setProblem('Say why the note is voided.');
      return;
    }
    setProblem(null);
    save.mutate(text);
  };
  const refusal =
    save.error instanceof ApiError && save.error.code === 'ALREADY_SUPERSEDED'
      ? 'This note was corrected by a later note; void the correction instead.'
      : save.error instanceof ApiError && save.error.code === 'ALREADY_VOIDED'
        ? 'This note was already voided.'
        : null;
  return (
    <form aria-label="Void a note" className="stack" onSubmit={submit}>
      <h3 style={H3}>{`Void the ${noteKindLabel(note.kind).toLowerCase()} of ${formatDate(note.noteDate)} about ${note.employee.displayName}`}</h3>
      <ReasonField label="Why it is voided" value={reason} onChange={setReason} />
      <Problem text={problem ?? refusal} />
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          Void the note
        </button>
        <button type="button" className="secondary" disabled={save.isPending} onClick={onCancel}>
          Keep it
        </button>
      </div>
      {!refusal && <Refusal error={save.error} action="note" />}
    </form>
  );
}

/** A new note about one employee in scope, with an optional supporting file (PDF, JPEG or PNG, scanned before it is served). */
function NewRegisterNote() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [kind, setKind] = useState<NoteKind>('NOTE');
  const [absconding, setAbsconding] = useState(false);
  const [noteDate, setNoteDate] = useState('');
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const results = useQuery({
    enabled: term !== null && can(EMPLOYEE_LIST),
    queryKey: keys.employeeSearch(term ?? ''),
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term ?? '', page: '1', pageSize: String(EMPLOYEE_PAGE_SIZE) }).toString()}`),
    retry: retryTransient,
  });
  const hits = term === null ? undefined : shown(results)?.items;
  const chosen = hits?.find((e) => e.id === employeeId);
  const save = useMutation({
    mutationFn: async (input: { employeeId: string; note: Record<string, unknown>; file: File | null }) =>
      api<{ id: string; attachment: { scanState: ScanState } | null }>(`/v1/employees/${input.employeeId}/notes`, {
        body: { ...input.note, ...(input.file ? { attachment: { fileName: input.file.name, contentBase64: await fileToBase64(input.file) } } : {}) },
      }),
    onSuccess: (created, input) => {
      const scan = created.attachment?.scanState;
      const fileText = scan === 'QUARANTINED' ? ' The malware scan flagged the file, so it will never be served.' : scan === 'PENDING_SCAN' ? ' The file opens once the malware scan releases it.' : '';
      setNotice({ text: `Saved the ${noteTypeText({ kind: String(input.note.kind), warningCategory: (input.note.warningCategory as string | undefined) ?? null })}.${fileText}`, ok: scan !== 'QUARANTINED' });
      setBody('');
      setAbsconding(false);
      setFile(null);
      setNoteDate('');
      setFormKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: keys.notes('register') });
      void qc.invalidateQueries({ queryKey: keys.notes(input.employeeId) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const text = body.trim();
    if (!employeeId) return setProblem('Find and choose the employee the note is about.');
    if (!text) return setProblem('Enter the note.');
    if (noteDate && !ISO_DATE.test(noteDate)) return setProblem('Enter the date as YYYY-MM-DD.');
    if (noteDate && noteDate > localDate()) return setProblem('A note cannot be dated after today.');
    if (file && (file.size === 0 || file.size > MAX_FILE_BYTES)) return setProblem('A file must be between 1 byte and 10 MB.');
    if (file && (file.name.length > MAX_FILE_NAME || !FILE_NAME.test(file.name))) return setProblem('Rename the file: its name has characters that are not accepted.');
    setProblem(null);
    setNotice(null);
    save.mutate({ employeeId, note: { kind, ...(kind === 'WARNING' && absconding ? { warningCategory: 'ABSCONDING' } : {}), body: text, ...(noteDate ? { noteDate } : {}) }, file });
  };
  const dateRefusal = save.error instanceof ApiError && save.error.code === 'NOTE_DATE_IN_FUTURE' ? 'A note cannot be dated after today.' : null;
  const fileRefusal = save.error instanceof ApiError && save.error.code === 'UNSUPPORTED_FILE' ? 'Only PDF, JPEG and PNG files are accepted.' : null;
  return (
    <Section title="New note">
      {!can(EMPLOYEE_LIST) ? (
        <NotPermitted>The selected role cannot search employees, so it cannot choose whom a note is about here.</NotPermitted>
      ) : (
        <>
          <form
            role="search"
            aria-label="Find the employee"
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              setTerm(typed.trim());
              setEmployeeId('');
            }}
          >
            <label>
              Employee name or code
              <input value={typed} maxLength={100} onChange={(e) => setTyped(e.target.value)} />
            </label>
            <button type="submit" className="secondary">
              Find
            </button>
          </form>
          {term !== null && results.isPending && <Loading>Searching…</Loading>}
          {term !== null && <QueryProblem error={results.error} forbidden="The selected role cannot search employees." />}
          {hits && hits.length === 0 && <Empty>No employee in the selected role’s scope matches.</Empty>}
          <form aria-label="New note" className="stack" onSubmit={submit} noValidate>
            <div style={FIELDS}>
              <label>
                Employee
                <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={!hits || hits.length === 0}>
                  <option value="">Choose…</option>
                  {(hits ?? []).map((h) => (
                    <option key={h.id} value={h.id}>
                      {`${h.displayName} (${h.employeeCode})`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Type
                <select value={kind} onChange={(e) => setKind((NOTE_KINDS.find(([k]) => k === e.target.value)?.[0] ?? 'NOTE') as NoteKind)}>
                  {NOTE_KINDS.map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {kind === 'WARNING' && <AbscondingMark checked={absconding} onChange={setAbsconding} />}
              <label>
                Date it is about (blank: today)
                <input type="date" value={noteDate} max={localDate()} onChange={(e) => setNoteDate(e.target.value)} />
              </label>
              <label>
                Supporting file (optional)
                <input key={formKey} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
            </div>
            <ReasonField label="Note (restricted to authorised HR)" value={body} onChange={setBody} max={MAX_NOTE} />
            <Problem text={problem ?? dateRefusal ?? fileRefusal} />
            <div className="row">
              <button type="submit" disabled={save.isPending}>
                {chosen ? `Add the note about ${chosen.displayName}` : 'Add the note'}
              </button>
            </div>
            {!dateRefusal && !fileRefusal && <Refusal error={save.error} action="note" />}
          </form>
          <Notice notice={notice} />
        </>
      )}
    </Section>
  );
}

/** EMPLOYEE_NOTES_V1 (notes-register.ts): the import duty and the write duty each row is applied under. */
const NOTES_IMPORT: ImportTemplate = {
  code: 'EMPLOYEE_NOTES_V1',
  label: 'Employee notes',
  permissions: [NOTE_IMPORT, NOTE_WRITE],
  base: '/v1/employee-note-imports',
  columns: 'employeeCode,noteType,noteDate,text',
  keyLabel: 'Employee / type / date',
  noun: ['note', 'notes'],
  verb: 'Add',
  note: 'One note per row. The type is a code or its name (Appreciation, Exit note, Offer rejection, PIP, Remarks, Warning, Absconding warning, Note); the date is YYYY-MM-DD and not after today.',
  problems: {
    UNKNOWN_NOTE_TYPE: 'The type is not one of Appreciation, Exit note, Offer rejection, PIP, Remarks, Warning, Absconding warning or Note.',
    INVALID_DATE: 'The date is not a valid YYYY-MM-DD date.',
    NOTE_DATE_IN_FUTURE: 'The date is after today.',
    INVALID_TEXT: 'The text is empty or longer than 4000 characters.',
    UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
    OUT_OF_SCOPE: 'The employee is outside the scope of your role.',
    OWN_RECORD: 'This is your own record: another HR user records notes about you.',
    DUPLICATE_IN_BATCH: 'An earlier row of the file has the same employee, type, date and text.',
    DUPLICATE_NOTE: 'This note is already on record (same employee, type, date and text).',
    COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
  },
};

export function NotesUploadScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Notes bulk upload</h1>
      <RoleReady>
        {can(NOTE_IMPORT) && can(NOTE_WRITE) ? (
          <NotesUpload />
        ) : (
          <Section title="Notes bulk upload">
            <NotPermitted>The selected role cannot upload notes: it needs both the restricted notes upload and write rights.</NotPermitted>
          </Section>
        )}
      </RoleReady>
    </>
  );
}

function NotesUpload() {
  const t = NOTES_IMPORT;
  const keys = useKeys();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file: uploading the same file again returns the same batch.
  const uploadKey = useRef<string | null>(null);
  const { resume, open, refresh, watch } = useBatchFollowUp(
    t.base,
    {
      show: setJob,
      closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)),
      onStart: () => {
        upload.reset();
        act.reset();
      },
    },
    job,
  );
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => api<ImportJob>(`${t.base}/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      if (view.state === 'COMMITTED') void qc.invalidateQueries({ queryKey: keys.notes('register') });
    },
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey('employee-notes'));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      act.reset();
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
    onSettled: refresh,
  });
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (file && !busy) upload.mutate(file);
  };
  return (
    <>
      <Section title="Upload notes">
        <form onSubmit={submit} className="stack" aria-label="Upload notes">
          <p className="hint">
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}). {t.note} Nothing is recorded until you add the previewed rows, and a file is applied all or nothing: one row with
            a problem rejects the whole file. Notes are restricted to authorised HR, and notes about your own record are refused.
          </p>
          <TemplateDownload base={t.base} code={t.code} />
          <div className="inline">
            <label>
              Notes file (CSV)
              <input
                key={fileInput}
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  uploadKey.current = null;
                }}
              />
            </label>
            <button type="submit" disabled={!file || busy}>
              Upload and preview
            </button>
          </div>
        </form>
        {isForbidden(upload.error) ? <NotPermitted>The selected role cannot upload notes.</NotPermitted> : <ErrorNote error={upload.error ?? resume.error} />}
        <p className="hint">
          <Link to={PATHS.notes}>Back to the notes register</Link>
        </p>
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title="Your notes uploads" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

/**
 * CL-040 follow-up: the register as a file (EMPLOYEE_NOTES_REGISTER, CSV or XLSX), with the filters last applied to the list (the
 * type is sent as `category`), under its own confidential export right. The server applies the row scope and leaves out the user's
 * own record; the text of a note and a void's reason are never in the file.
 */
function NotesRegisterExport({ filters }: { filters: RegisterFilters }) {
  const [format, setFormat] = useState<'CSV' | 'XLSX'>('CSV');
  const sent: Record<string, string> = {
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.kind ? { category: filters.kind } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
  };
  return (
    <div className="stack">
      <p className="hint">
        Export the notes the list shows (its filters as last applied) as a file: the employee, type, date, status, who submitted the note, when it was recorded and whether it was uploaded.
        The text of a note and the reason for a void are never in the file.
      </p>
      <form className="grid-form" aria-label="Notes register export" onSubmit={keepOnPage}>
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value === 'XLSX' ? 'XLSX' : 'CSV')}>
            <option value="CSV">CSV</option>
            <option value="XLSX">XLSX</option>
          </select>
        </label>
      </form>
      <ReportExport key={`${JSON.stringify(sent)}:${format}`} reportCode="EMPLOYEE_NOTES_REGISTER" filters={sent} format={format} label="Export the notes register" />
    </div>
  );
}
