import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, download, fileToBase64, formatDate, idempotencyKey, pinSession } from '../api';
import { HELD_BATCH_CHECK_INTERVAL_MS, HELD_BATCH_MAX_CHECKS } from '../held-batch-timing';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';

// ---------------------------------------------------------------------------------------------------------
// Batch imports (FR-009, FR-023, DF09, I-13, I-20): upload, row-by-row preview, then an explicit commit or cancel.
// Every batch is all or nothing: any row problem rejects the whole batch, and a commit applies every row or none.
// Every stored file waits for the scan worker unread (FR-106, NFR-S09), so a first upload answers a held batch as a matter of
// course; the screen re-checks it by itself until the preview comes (useHeldBatchWatch). The user's own batches of the selected
// template are listed below the form, so a held batch can be opened again and checked again from its stored file.
// ---------------------------------------------------------------------------------------------------------

/** What an update row would change, as its preview stored it (imports/batch.ts RowChanges): field -> { from, to }. */
type RowChanges = Record<string, { from: string | null; to: string | null } | null>;

/** A published batch template as the preview screens show it; documents.tsx reuses the job view for DOCUMENT_MAPPING_V1. */
export interface ImportTemplate {
  code: string;
  label: string;
  /** Every duty the upload and the commit require together: the import duty, and the duty each row is applied under. */
  permissions: string[];
  /** Upload endpoint; the job lives at `${base}/:id` with /commit and /cancel. */
  base: string;
  columns: string;
  keyLabel: string;
  noun: [singular: string, plural: string];
  verb: string;
  note: string;
  /** An update import: the preview lists each row's proposed changes, fields in this order (any other follows). */
  changeFields?: string[];
  /** Row problems in plain words, by error code; any other code is shown as the server sent it. */
  problems?: Record<string, string>;
}

/** EMPLOYEE_UPDATE_V1 row problems: employee/update-import.ts, imports/batch.ts and the change paths a row goes through. */
const UPDATE_PROBLEMS: Record<string, string> = {
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  DUPLICATE_IN_BATCH: 'This employee is already on an earlier row; each employee may appear on one row only.',
  NO_CHANGE: 'Every cell is blank or matches the current value, so there is nothing to change.',
  // update-import.ts asks for the date whenever an organisation or manager cell is filled in, changed or not.
  EFFECTIVE_DATE_REQUIRED:
    'A row with a department, location, designation, grade or manager code needs effectiveFrom as a valid date (YYYY-MM-DD), even when the code matches the current value.',
  NOTHING_TO_DATE: 'effectiveFrom is filled in, but the row has no department, location, designation, grade or manager change to date; leave effectiveFrom blank.',
  UNKNOWN_DEPARTMENT: 'No active department has this code.',
  UNKNOWN_LOCATION: 'No active location has this code.',
  UNKNOWN_DESIGNATION: 'No active designation has this code.',
  UNKNOWN_GRADE: 'No active grade has this code.',
  UNKNOWN_MANAGER: 'No employee in this company has the manager employee code given.',
  SELF_MANAGER: 'An employee cannot be their own manager.',
  OUT_OF_SCOPE: 'The employee, or the department or location the row moves them to, is outside the scope of your role.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
  INVALID_DISPLAY_NAME: 'The display name is longer than 200 characters.',
  INVALID_WORK_EMAIL: 'The work email is not a valid address.',
  DUPLICATE: 'Another employee already has a value on this row that must be unique, such as the work email.',
  NO_CURRENT_ASSIGNMENT: 'The employee has no current assignment to change.',
  // changes.ts closeCurrentPeriod; no history-correction screen exists yet, so these words do not point to one.
  CHANGE_NOT_LATEST:
    'The employee’s organisation or manager history already has an entry starting on or after this effectiveFrom date; an import can only add a change after the latest one, so use a later effectiveFrom.',
  RULE_VIOLATION: 'The change breaks a rule: for example it takes effect before the joining date, or the manager is not an active employee.',
  INVALID_REFERENCE: 'A code on the row cannot be used: for example the manager is outside the scope of your role.',
};

/** The published versioned templates (DF09) and the duty each needs; the server checks both again. */
const TEMPLATES: ImportTemplate[] = [
  {
    code: 'EMPLOYEE_ONBOARDING_V1',
    label: 'Employee onboarding',
    permissions: ['employee.import.operational', 'employee.create.operational'],
    base: '/v1/employees/imports',
    columns: 'employeeCode,displayName,workEmail,joiningDate,employmentType,departmentCode,locationCode,designationCode,gradeCode',
    keyLabel: 'Employee code',
    noun: ['employee', 'employees'],
    verb: 'Create',
    note: 'Personal fields are not imported.',
  },
  {
    // FR-009 update import (I-20): rows apply under the caller's update grant, so its scope and filters hold per row.
    code: 'EMPLOYEE_UPDATE_V1',
    label: 'Employee update',
    permissions: ['employee.import.operational', 'employee.update.operational'],
    base: '/v1/employees/update-imports',
    columns: 'employeeCode,displayName,workEmail,effectiveFrom,departmentCode,locationCode,designationCode,gradeCode,managerEmployeeCode',
    keyLabel: 'Employee code',
    noun: ['employee', 'employees'],
    verb: 'Update',
    note:
      'A blank cell means no change. Organisation changes (department, location, designation, grade) and manager changes need effectiveFrom, the date they take effect (YYYY-MM-DD); leave it and the organisation and manager cells blank on a row that changes only the display name or work email. One row per employee; a manager cannot be removed by import, and personal fields are not imported.',
    changeFields: ['displayName', 'workEmail', 'department', 'location', 'designation', 'grade', 'manager', 'effectiveFrom'],
    problems: UPDATE_PROBLEMS,
  },
  {
    code: 'SHIFT_PLAN_V1',
    label: 'Shift plan',
    permissions: ['shift.import.operational', 'shift.assign.operational'],
    base: '/v1/shifts/plan-imports',
    columns: 'employeeCode,shiftCode,effectiveFrom',
    keyLabel: 'Employee @ effective from',
    noun: ['shift assignment', 'shift assignments'],
    verb: 'Apply',
    note: 'Each row changes the employee’s shift from its effective date; earlier assignments stay in the history.',
    problems: {
      AFTER_LAST_WORKING_DATE: 'The shift would start after the employee’s approved last working date.',
      EMPLOYMENT_ENDED: 'The employment has ended, so no shift can be assigned.',
      BEFORE_JOINING: 'The shift would start before the joining date.',
    },
  },
  {
    // FR-025: every row goes through the single opening-balance route's rules, under the caller's row scope.
    code: 'LEAVE_OPENING_V1',
    label: 'Opening leave balances',
    permissions: ['leave.import.operational', 'leave.adjust.operational'],
    base: '/v1/leave/opening-imports',
    columns: 'employeeCode,leaveType,units,effectiveDate,reason',
    keyLabel: 'Employee @ leave type',
    noun: ['opening balance', 'opening balances'],
    verb: 'Record',
    note: 'One row per employee and leave type. An employee already holding an opening balance of that type rejects the batch, so a batch cannot be applied twice; use an adjustment instead. Your name and the reason stay on each balance.',
    problems: {
      OPENING_EXISTS: 'This employee already has an opening balance of this leave type. Use an adjustment instead.',
      DUPLICATE_IN_BATCH: 'The file already has a row for this employee and leave type.',
      UNKNOWN_LEAVE_TYPE: 'There is no leave type with this code.',
      INVALID_UNITS: 'Units must be a positive number with at most 4 decimals.',
      INVALID_REASON: 'A reason of at most 500 characters is required.',
      OUT_OF_SCOPE: 'This employee is outside your role’s scope, or it is your own balance, which another administrator must record.',
    },
  },
];

export interface ImportRow {
  rowNumber: number;
  businessKey: string;
  state: string;
  errorCode: string | null;
  /** An update import's preview: what the row would change (operational values only). */
  proposedChanges?: RowChanges | null;
}

export interface ImportJob {
  id: string;
  state: string;
  template?: string;
  fileName: string | null;
  rowCount: number | null;
  acceptedCount: number;
  rejectedCount: number;
  rows: ImportRow[];
}

/** Rows shown in the table; a 10,000-row batch is summarised rather than drawn in full. */
const SHOWN_ROWS = 200;
const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

export function ImportsPage() {
  const { can } = useSession();
  const available = TEMPLATES.filter((t) => t.permissions.every((p) => can(p)));
  const [templateCode, setTemplateCode] = useState(available[0]?.code ?? '');
  const template = available.find((t) => t.code === templateCode) ?? available[0];
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file and template: validating the same file again (after a lost answer or a
  // double click) returns the same job instead of a second one. A new file or template gets a new key.
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };

  // A held batch checked again, or one of the user's batches opened from the list (of the selected template).
  const { resume, open, refresh, watch } = useBatchFollowUp(
    template?.base ?? '',
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
    mutationFn: async ({ t, id, action }: { t: ImportTemplate; id: string; action: 'commit' | 'cancel' }) => {
      // The decision and any look at the batch after it go out under the role it was made in (BR-046).
      const send = pinSession();
      try {
        // The routes take no body: committing a committed batch again returns it unchanged.
        return await send<ImportJob>(`${t.base}/${id}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on: this very decision went through but its answer was lost, or the batch was
        // committed, rejected or cancelled since the preview. Its job view shows where it stands now.
        const current = await send<ImportJob>(`${t.base}/${id}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: setJob,
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async ({ t, f }: { t: ImportTemplate; f: File }) => {
      const key = (uploadKey.current ??= idempotencyKey('import'));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSettled: refresh,
    onSuccess: (view) => {
      setJob(view);
      act.reset();
      // The preview is on screen, so the form starts clean: the next file, a corrected one included, is a new upload
      // with its own key (re-choosing a file of the same name must not return this job again).
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      // The key is someone else's: the next attempt must use a fresh one.
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
  });

  if (!template) return <Empty>You cannot import in this role.</Empty>;

  // While a file is checked or a decision on the batch shown is on its way, no other upload starts and the template
  // stays as it is: that answer would replace a newer preview, or bring back a batch the template switch cleared
  // (a switch resets every mutation, but their answers still arrive).
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (file && !busy) upload.mutate({ t: template, f: file });
  };
  const jobTemplate = TEMPLATES.find((t) => t.code === job?.template) ?? template;

  return (
    <>
      <Section title="Import">
        <form onSubmit={submit} className="stack">
          <label>
            Template
            <select
              value={template.code}
              disabled={busy}
              onChange={(e) => {
                setTemplateCode(e.target.value);
                setJob(null);
                uploadKey.current = null;
                upload.reset();
                act.reset();
                resume.reset();
                open.reset();
              }}
            >
              {available.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label} ({t.code})
                </option>
              ))}
            </select>
          </label>
          <p className="hint">
            CSV with exactly the header <code>{template.columns}</code>. {template.note} Nothing is applied until you commit a preview, and a batch is
            applied all or nothing: one row with a problem rejects the whole batch.
          </p>
          <TemplateDownload key={template.code} base={template.base} code={template.code} />
          <div className="inline">
            <label>
              Import file
              <input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={!file || busy}>
              Validate
            </button>
          </div>
        </form>
        <ErrorNote error={upload.error ?? resume.error} />
      </Section>
      {job && (
        <>
          <ImportJobView
            job={job}
            template={jobTemplate}
            pending={act.isPending}
            onAction={(action) => act.mutate({ t: jobTemplate, id: job.id, action })}
            error={act.error}
          />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches
        key={template.base}
        base={template.base}
        title={`Your ${template.label.toLowerCase()} batches`}
        openedId={job?.id ?? null}
        busy={busy}
        onOpen={(id) => open.mutate(id)}
        error={open.error}
      />
    </>
  );
}

export function ImportJobView({
  job,
  template,
  pending,
  onAction,
  error,
}: {
  job: ImportJob;
  template: ImportTemplate;
  pending: boolean;
  onAction: (a: 'commit' | 'cancel') => void;
  error: unknown;
}) {
  const rows = job.rowCount ?? job.rows.length;
  const problems = job.rows.filter((r) => r.errorCode && r.errorCode !== 'BATCH_REJECTED');
  // A rejected batch lists its problem rows first; the rest only explain that they were not applied.
  const ordered = job.state === 'REJECTED' ? [...problems, ...job.rows.filter((r) => !r.errorCode || r.errorCode === 'BATCH_REJECTED')] : job.rows;
  return (
    <Section
      title={`Preview: ${job.fileName ?? 'import'} (${job.template ?? template.code})`}
      actions={
        job.state === 'PREVIEWED' ? (
          <div className="row">
            <button type="button" disabled={pending} onClick={() => onAction('commit')}>
              {template.verb} {plural(rows, template.noun)}
            </button>
            <button type="button" className="secondary" disabled={pending} onClick={() => onAction('cancel')}>
              Cancel import
            </button>
          </div>
        ) : job.state === 'UPLOADED' ? (
          <button type="button" className="secondary" disabled={pending} onClick={() => onAction('cancel')}>
            Cancel import
          </button>
        ) : undefined
      }
    >
      <p>
        <StateBadge state={job.state} /> {job.state === 'UPLOADED' ? null : plural(rows, ['row', 'rows'])}
      </p>
      {job.state === 'UPLOADED' && <p role="status">{HELD_BATCH_NOTE}</p>}
      {job.state === 'PREVIEWED' && <p>{rows === 1 ? 'The row is valid.' : `All ${rows} rows are valid.`} Committing applies every row in one go.</p>}
      {job.state === 'REJECTED' && (
        <p role="status">
          This batch was rejected, so nothing was applied ({plural(problems.length, ['row has', 'rows have'])} a problem). Fix the rows listed below and upload the
          corrected file.
        </p>
      )}
      {job.state === 'COMMITTED' && <p>{job.acceptedCount === 1 ? 'The row was applied.' : `All ${job.acceptedCount} rows were applied.`}</p>}
      {job.state === 'CANCELLED' && <p>Import cancelled; nothing was applied.</p>}
      {template.changeFields && <p className="hint">Each proposed change reads “field: old value -&gt; new value”; — means no value.</p>}
      <table>
        <thead>
          <tr>
            <th>Row</th>
            <th>{template.keyLabel}</th>
            <th>Result</th>
            {template.changeFields && <th>Proposed changes</th>}
            <th>Problem</th>
          </tr>
        </thead>
        <tbody>
          {ordered.slice(0, SHOWN_ROWS).map((r) => (
            <tr key={r.rowNumber}>
              <td>{r.rowNumber}</td>
              <td>{r.businessKey}</td>
              <td>
                <Badge tone={r.state === 'REJECTED' ? 'bad' : 'good'}>{r.state.toLowerCase()}</Badge>
              </td>
              {template.changeFields && (
                <td>
                  <ProposedChanges changes={r.proposedChanges} order={template.changeFields} />
                </td>
              )}
              <td>
                <RowProblem code={r.errorCode} words={template.problems} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ordered.length > SHOWN_ROWS && <p className="hint">Showing the first {SHOWN_ROWS} of {ordered.length} rows.</p>}
      <ErrorNote error={error} />
    </Section>
  );
}

const CHANGE_LIST: CSSProperties = { margin: 0, paddingLeft: '1.1rem' };

/** One proposed change as "field: from -> to": no value is an em dash, and the effective date is a calendar date. */
function changeText(field: string, change: { from: string | null; to: string | null } | null | undefined): string {
  const shown = (value: string | null | undefined) => (value === null || value === undefined ? '—' : field === 'effectiveFrom' ? formatDate(value) : value);
  return `${field}: ${shown(change?.from)} -> ${shown(change?.to)}`;
}

/** A row's proposed changes exactly as the preview stored them, in the template's field order (any other field follows). */
function ProposedChanges({ changes, order }: { changes: RowChanges | null | undefined; order: string[] }) {
  const rank = (field: string) => (order.includes(field) ? order.indexOf(field) : order.length);
  const fields = Object.keys(changes ?? {}).sort((a, b) => rank(a) - rank(b));
  if (!changes || fields.length === 0) return <>—</>;
  return (
    <ul style={CHANGE_LIST}>
      {fields.map((field) => (
        <li key={field}>{changeText(field, changes[field])}</li>
      ))}
    </ul>
  );
}

/** A row's problem: in plain words where the template explains its code, which stays beneath for reference. */
function RowProblem({ code, words }: { code: string | null; words: Record<string, string> | undefined }) {
  if (!code) return <>—</>;
  if (code === 'BATCH_REJECTED') return <>not applied (another row failed)</>;
  const plain = words?.[code];
  if (!plain) return <>{code}</>;
  return (
    <>
      {plain}
      <div className="hint">{code}</div>
    </>
  );
}

/**
 * DF09 published versioned template: GET <base>/template downloads a CSV file holding exactly the header the upload
 * checks and no rows, named by the template code and version (imports/routes.ts), under the upload's own duties, which
 * the server checks again. The import screens here, in timesheet.tsx, appraisal.tsx, documents.tsx and payroll.tsx use it.
 */
export function TemplateDownload({ base, code }: { base: string; code: string }) {
  const get = useMutation({ mutationFn: () => download(`${base}/template`) });
  return (
    <div className="stack">
      <div className="row">
        <button type="button" className="secondary" disabled={get.isPending} onClick={() => get.mutate()}>
          Download the template
        </button>
        <span className="hint">{`${code}.csv: the header line only, ready to fill in.`}</span>
      </div>
      <ErrorNote error={get.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The user's own batches of one import and a batch held for the malware scan (imports/routes.ts; FR-106; NFR-S09): every
// import lists its submitter's batches (GET <base>, paged, job facts only) and resumes a held one from the file the server
// stored (POST <base>/:id/resume), so a held batch is found again after leaving the page and needs no second upload.
// Every stored file waits for the scan worker, so a held batch is the normal first answer: the screen re-checks it by itself.
// The import screens here and in salary, payroll, lifecycle-documents, attendance-admin, timesheet and appraisal use these;
// documents.tsx has its own follow-up calls for the mapping and shares the watch.
// ---------------------------------------------------------------------------------------------------------

/** What a batch waiting for the scan says: a normal short wait, nothing wrong. */
export const HELD_BATCH_NOTE = 'The file is waiting for the malware scan, so nothing in it has been read yet. This is usually a short wait. You can cancel the import meanwhile; the batch stays in your batches below.';

/** GET <base>: one of the caller's own batches, job facts only (GET <base>/:id has the rows). */
export interface ImportBatch {
  id: string;
  state: string;
  template: string | null;
  fileName: string | null;
  rowCount: number | null;
  acceptedCount: number;
  rejectedCount: number;
  scanState: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ImportBatchPage {
  items: ImportBatch[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET <base> pages: 25, 50 or 100 batches. */
const BATCHES_PAGE_SIZE = 25;
const SCROLL: CSSProperties = { overflowX: 'auto' };
const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

/** The query-key prefix of one import's list of batches: every change to one of its batches refreshes it. */
export const importBatchesKey = (base: string) => ['import-batches', base] as const;

/** A batch's state in plain words (imports/jobs.ts). */
const BATCH_STATES: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  UPLOADED: { label: 'waiting for the scan', tone: 'neutral' },
  PREVIEWED: { label: 'previewed, not committed', tone: 'warn' },
  COMMITTED: { label: 'committed', tone: 'good' },
  REJECTED: { label: 'rejected, nothing applied', tone: 'bad' },
  CANCELLED: { label: 'cancelled, nothing applied', tone: 'neutral' },
};

function BatchScan({ state }: { state: string | null }) {
  if (state === 'CLEAN') return <Badge tone="good">released</Badge>;
  if (state === 'QUARANTINED') return <Badge tone="bad">quarantined by the malware scan</Badge>;
  if (state === 'PENDING_SCAN') return <Badge>waiting for the malware scan</Badge>;
  // A batch from before import files were scanned: never committed (imports/jobs.ts commitBatch).
  return <Badge>not scanned</Badge>;
}

const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;

/**
 * The follow-up calls of one import: resuming a batch held for the malware scan from its stored file (still held, or
 * previewed) and opening one of the user's batches from the list. `show` puts the answer on screen; `closed` hears of a
 * held batch the server closed instead (422: its file was quarantined, or is not a valid batch); `onStart` clears the
 * screen's other answers. `refresh` reads the list of batches again; every change to a batch calls it. `job` is the batch
 * on screen: while it is held, `watch` re-checks it by itself. A refusal from an automatic check reads as `resume.error`, as
 * one from the button does, and `resume.reset` clears it.
 */
export function useBatchFollowUp(base: string, on: { show: (job: ImportJob) => void; closed: (id: string) => void; onStart: () => void }, job: Pick<ImportJob, 'id' | 'state'> | null) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: importBatchesKey(base) });
  const resume = useMutation({
    mutationFn: (id: string) => api<ImportJob>(`${base}/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    onMutate: () => {
      on.onStart();
      open.reset();
    },
    onSuccess: (view) => on.show(view),
    onError: (err, id) => {
      if (err instanceof ApiError && err.status === 422) on.closed(id);
    },
    onSettled: refresh,
  });
  const open = useMutation({
    mutationFn: (id: string) => api<ImportJob>(`${base}/${encodeURIComponent(id)}`),
    onMutate: () => {
      on.onStart();
      resume.reset();
    },
    onSuccess: (view) => on.show(view),
  });
  const watch = useHeldBatchWatch(base, job, { show: on.show, closed: on.closed, refresh }, resume.isPending || open.isPending);
  return {
    resume: {
      ...resume,
      error: resume.error ?? watch.error,
      reset: () => {
        resume.reset();
        watch.clearError();
      },
    },
    open,
    refresh,
    watch,
  };
}

export interface HeldBatchWatch {
  /** The screen no longer re-checks this held batch by itself: the manual check, or opening it again, starts over. */
  stopped: boolean;
  /** A refusal from an automatic check; it stays until the screen shows another batch or clears it. */
  error: Error | null;
  clearError: () => void;
}

/**
 * While `job` is a batch waiting for the malware scan and the screen is open, re-checks it through POST <base>/:id/resume every
 * HELD_BATCH_CHECK_INTERVAL_MS, so a normal import reaches its preview without a click. It stops at any other state, after
 * HELD_BATCH_MAX_CHECKS checks and at a refusal, waits while the tab is hidden or `paused` (another call on this batch is on its
 * way), and ends with the screen. Any new view of a held batch (the upload's answer, the manual check, opening it) starts
 * over. Separate from the manual check on purpose: a quiet check clears nobody's error and disables no button. Its answer
 * applies only while the same batch is still held on screen under the role that asked (BR-046), so it can never replace a
 * newer view. A still-held answer changes nothing on screen.
 */
export function useHeldBatchWatch(base: string, job: Pick<ImportJob, 'id' | 'state'> | null, on: { show: (job: ImportJob) => void; closed: (id: string) => void; refresh: () => void }, paused: boolean): HeldBatchWatch {
  const heldId = job?.state === 'UPLOADED' ? job.id : null;
  const [checks, setChecks] = useState(0);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const send = useRef(pinSession());
  const latest = useRef({ heldId, on });
  latest.current = { heldId, on };

  // A new view on screen starts over. When the server closed the batch there is no view, and its refusal stays to be read.
  useEffect(() => {
    if (!job) return;
    send.current = pinSession();
    setChecks(0);
    setRefused(false);
    setError(null);
  }, [job]);

  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // An answer that arrives after the screen has gone is dropped.
  useEffect(
    () => () => {
      latest.current = { ...latest.current, heldId: null };
    },
    [],
  );

  const check = async (id: string) => {
    const pinned = send.current;
    const stale = () => latest.current.heldId !== id || !pinned.isCurrent();
    try {
      const view = await pinned<ImportJob>(`${base}/${encodeURIComponent(id)}/resume`, { method: 'POST' });
      if (stale()) return;
      if (view.state === 'UPLOADED') {
        setChecks((n) => n + 1);
        return;
      }
      latest.current.on.show(view);
      latest.current.on.refresh();
    } catch (err) {
      if (stale()) return;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setError(err);
        setRefused(true);
        // 422: the server closed the batch (its file was quarantined, or is not a valid batch). Any other refusal leaves it on screen.
        if (err.status === 422) latest.current.on.closed(id);
        latest.current.on.refresh();
      } else {
        // No answer, or a server that is struggling: the next check asks again, and the limit still ends it.
        setChecks((n) => n + 1);
      }
    }
  };

  const stopped = heldId !== null && (refused || checks >= HELD_BATCH_MAX_CHECKS);
  const waiting = heldId !== null && !stopped && !hidden && !paused;
  useEffect(() => {
    if (!waiting || heldId === null) return;
    const timer = setTimeout(() => void check(heldId), HELD_BATCH_CHECK_INTERVAL_MS);
    return () => clearTimeout(timer);
    // `checks` re-arms the timer after each answer; `check` reads what it needs through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, heldId, checks, base]);

  return { stopped, error, clearError: () => setError(null) };
}

/** Whether the preview will come by itself, or the screen has stopped checking and the wait is longer than usual. */
export function HeldBatchWatchNote({ watch }: { watch: HeldBatchWatch }) {
  if (watch.error) return null; // the refusal is on screen and says why
  return watch.stopped ? (
    <span role="status">This is taking longer than usual, so this page has stopped checking by itself. The batch is kept: check again here, or open it from your batches below later.</span>
  ) : (
    <span className="hint">The preview appears here by itself once the scan is done.</span>
  );
}

/** Under a batch waiting for the malware scan: how the wait ends, and the manual check of its stored file (POST /:id/resume) for someone who comes back later. */
export function HeldBatchCheck({ job, busy, onCheck, checked, watch }: { job: ImportJob; busy: boolean; onCheck: () => void; checked: ImportJob | undefined; watch: HeldBatchWatch }) {
  if (job.state !== 'UPLOADED') return null;
  return (
    <div className="row">
      <HeldBatchWatchNote watch={watch} />
      <button type="button" className="secondary" disabled={busy} onClick={onCheck}>
        Check the scan again
      </button>
      <span className="hint">Checks the file you uploaded for this batch, without uploading it again; the batch is previewed once the scan releases it.</span>
      {checked?.id === job.id && checked.state === 'UPLOADED' && <span role="status">Still waiting for the malware scan.</span>}
    </div>
  );
}

/** The user's own batches of one import, newest first, a page at a time; Open shows one with its rows. */
export function ImportBatches({ base, title, openedId, busy, onOpen, error }: { base: string; title: string; openedId: string | null; busy: boolean; onOpen: (id: string) => void; error: unknown }) {
  const { stored } = useSession();
  const [page, setPage] = useState(1);
  const list = useQuery({
    // The selected company and assignment are part of the key: a list answered to one role is never shown under another.
    queryKey: [...importBatchesKey(base), stored?.companyId ?? '-', stored?.assignmentId ?? '-', page],
    queryFn: () => api<ImportBatchPage>(`${base}?page=${page}&pageSize=${BATCHES_PAGE_SIZE}`),
    retry: retryTransient,
  });
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / BATCHES_PAGE_SIZE));
  return (
    <Section title={title}>
      <p className="hint">Only you see the files you uploaded here. Open a batch to see its rows; one still waiting for its scan can be checked again and then committed or cancelled.</p>
      {list.isPending && <p className="hint">Loading your batches…</p>}
      {list.error instanceof ApiError && list.error.status === 403 ? (
        <p role="note">
          <Badge tone="warn">not permitted</Badge> The selected role cannot list these batches.
        </p>
      ) : (
        <ErrorNote error={list.error} />
      )}
      {error instanceof ApiError && error.status === 404 ? (
        <div role="alert" className="error">
          This batch is not available to the selected role.
          <div className="hint">{error.code}</div>
        </div>
      ) : (
        <ErrorNote error={error} />
      )}
      {list.data && items.length === 0 && <Empty>{page === 1 ? 'You have not uploaded a file for this import yet.' : 'No batches on this page.'}</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label={title}>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Uploaded</th>
                <th scope="col">Status</th>
                <th scope="col">Malware scan</th>
                <th scope="col">Rows</th>
                <th scope="col">
                  <span style={SR_ONLY}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => {
                const state = BATCH_STATES[b.state];
                const name = b.fileName ?? 'import file';
                return (
                  <tr key={b.id}>
                    <td>{name}</td>
                    <td>{formatDate(b.createdAt)}</td>
                    <td>
                      <Badge tone={state?.tone ?? 'neutral'}>{state?.label ?? b.state}</Badge>
                    </td>
                    <td>
                      <BatchScan state={b.scanState} />
                    </td>
                    <td>{b.state === 'COMMITTED' ? `${b.acceptedCount} applied` : b.rowCount === null ? '—' : String(b.rowCount)}</td>
                    <td>
                      {b.id === openedId ? (
                        <span className="hint">open above</span>
                      ) : (
                        <button type="button" className="secondary" disabled={busy} aria-label={`Open ${name} uploaded ${formatDate(b.createdAt)}`} onClick={() => onOpen(b.id)}>
                          Open
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="row">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Newer batches
          </button>
          <span className="hint">
            Page {page} of {pages}
          </span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Older batches
          </button>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Employee documents (FR-010): confidential; the list needs the read grant, the form the upload grant.
// ---------------------------------------------------------------------------------------------------------

interface DocumentItem {
  id: string;
  documentType: string;
  fileName: string | null;
  mediaType: string;
  byteSize: number | null;
  expiresOn: string | null;
  expired: boolean;
  uploadedAt: string;
  /** FR-106: only a released (CLEAN) file can be opened. */
  scanState?: 'PENDING_SCAN' | 'CLEAN' | 'QUARANTINED' | null;
  verificationState?: 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';
  verificationNote?: string | null;
}

const SCAN_LABEL: Record<string, string> = { PENDING_SCAN: 'waiting for the malware scan', QUARANTINED: 'quarantined by the malware scan' };

export function EmployeeDocumentsPage() {
  const { id = '' } = useParams();
  const { can, me } = useSession();
  const canRead = can('document.read.document');
  const canUpload = can('document.upload.document');
  // The employee's own record is never verified by the employee (the API refuses it too).
  const canVerify = can('document.verify.document') && me?.employeeId !== id;
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ['documents', id], enabled: canRead, queryFn: () => api<{ items: DocumentItem[] }>(`/v1/employees/${id}/documents`) });
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState('GENERAL');
  const [expiresOn, setExpiresOn] = useState('');
  // Remounting the form after an upload clears the chosen file as well as the type and expiry.
  const [formKey, setFormKey] = useState(0);
  const upload = useMutation({
    mutationFn: async (f: File) =>
      api(`/v1/employees/${id}/documents`, {
        body: { documentType, fileName: f.name, contentBase64: await fileToBase64(f), ...(expiresOn ? { expiresOn } : {}) },
      }),
    onSuccess: () => {
      setFile(null);
      setDocumentType('GENERAL');
      setExpiresOn('');
      setFormKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: ['documents', id] });
    },
  });
  const open = useMutation({ mutationFn: (docId: string) => download(`/v1/documents/${docId}/content`) });
  const [rejectNote, setRejectNote] = useState<Record<string, string>>({});
  const verify = useMutation({
    mutationFn: ({ docId, decision }: { docId: string; decision: 'VERIFIED' | 'REJECTED' }) =>
      api(`/v1/documents/${docId}/verification`, { body: { decision, ...(decision === 'REJECTED' ? { note: (rejectNote[docId] ?? '').trim() } : {}) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['documents', id] }),
  });

  return (
    <>
      <p>
        <Link to="/employees">← Employees</Link>
      </p>
      {canRead && (
        <Section title="Documents">
          {docs.data && docs.data.items.length === 0 && <Empty>No documents on record.</Empty>}
          {docs.data && docs.data.items.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>File</th>
                  <th>Expires</th>
                  <th>Uploaded</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs.data.items.map((d) => {
                  const released = d.scanState === undefined || d.scanState === null || d.scanState === 'CLEAN';
                  return (
                    <tr key={d.id}>
                      <td>{d.documentType}</td>
                      <td>{d.fileName ?? '—'}</td>
                      <td>
                        {formatDate(d.expiresOn)} {d.expired && <Badge tone="warn">expired</Badge>}
                      </td>
                      <td>{formatDate(d.uploadedAt)}</td>
                      <td>
                        {!released ? <Badge tone={d.scanState === 'QUARANTINED' ? 'bad' : 'warn'}>{SCAN_LABEL[d.scanState!] ?? d.scanState}</Badge> : <StateBadge state={d.verificationState ?? null} />}
                        {d.verificationNote ? <div className="hint">{d.verificationNote}</div> : null}
                      </td>
                      <td>
                        <button type="button" className="secondary" disabled={!released} onClick={() => open.mutate(d.id)}>
                          Download
                        </button>
                        {canVerify && released && d.verificationState === 'UNVERIFIED' && (
                          <>
                            <button type="button" disabled={verify.isPending} onClick={() => verify.mutate({ docId: d.id, decision: 'VERIFIED' })}>
                              Verify
                            </button>
                            <label>
                              Rejection reason
                              <input value={rejectNote[d.id] ?? ''} onChange={(e) => setRejectNote({ ...rejectNote, [d.id]: e.target.value })} />
                            </label>
                            <button
                              type="button"
                              className="secondary"
                              disabled={verify.isPending || !(rejectNote[d.id] ?? '').trim()}
                              onClick={() => verify.mutate({ docId: d.id, decision: 'REJECTED' })}
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <ErrorNote error={docs.error ?? open.error ?? verify.error} />
        </Section>
      )}
      {canUpload && (
        <Section title="Add a document">
          <form
            key={formKey}
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              if (file) upload.mutate(file);
            }}
          >
            <label>
              Type <input value={documentType} onChange={(e) => setDocumentType(e.target.value.toUpperCase())} />
            </label>
            <label>
              Expires <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </label>
            <input type="file" accept="application/pdf,image/jpeg,image/png" aria-label="Document file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button disabled={!file || upload.isPending}>Upload</button>
          </form>
          <p className="hint">PDF, JPEG or PNG up to 10 MB. Every file is scanned for malware before anyone can open it.</p>
          {upload.isSuccess && (
            <p className="ok">
              {(upload.data as { scanState?: string } | undefined)?.scanState === 'QUARANTINED'
                ? 'The file failed the malware scan and was quarantined; upload another copy.'
                : (upload.data as { scanState?: string } | undefined)?.scanState === 'PENDING_SCAN'
                  ? 'Document uploaded; it can be opened once the malware scan releases it.'
                  : 'Document uploaded.'}
            </p>
          )}
          <ErrorNote error={upload.error} />
        </Section>
      )}
      {!canRead && !canUpload && <Empty>Documents are confidential; this role holds no document grant.</Empty>}
    </>
  );
}
