// Allocation and timesheet-entry imports (FR-046 bulk upload; FR-047 imported entries) through the shared batch screens.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { api, ApiError, fileToBase64, idempotencyKey, pinSession } from '../../api';
import { useSession } from '../../session';
import { ErrorNote, NotPermitted, Section } from '../../ui';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from '../records';
import { ALLOC_IMPORT, ALLOC_MANAGE, type Keys, TS_IMPORT, useKeys, useRoleContext } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screens: allocation and timesheet-entry imports (FR-046 bulk upload; FR-047 imported entries; DF09; FR-106)
// ---------------------------------------------------------------------------------------------------------

/**
 * A timesheet batch template (allocations.ts ALLOCATION_IMPORT_SPEC, line-import.ts LINE_IMPORT_SPEC). The API serves
 * no template file, so the screen states the exact header and what each column holds.
 */
interface TimesheetImport extends ImportTemplate {
  /** The idempotency-key prefix of an upload. */
  keyPrefix: string;
  /** Shown instead of the form when the selected role lacks one of `permissions`. */
  notPermitted: string;
  /** The server's 403 on an upload, in plain words. */
  forbidden: string;
  /** The lists a committed batch changes. */
  changes: (keys: Keys) => readonly (readonly unknown[])[];
}

const COLUMN_COUNT_TEXT = 'The row does not have exactly one cell for each column of the header.';
const OUT_OF_SCOPE_TEXT = 'The employee is outside the scope of your role.';

/** RESOURCE_ALLOCATION_V1 row problems: allocations.ts (its import spec and createAllocation) and imports/batch.ts. */
const ALLOCATION_ROW_PROBLEMS: Record<string, string> = {
  INVALID_DATE: 'startDate or endDate is not a valid calendar date (YYYY-MM-DD).',
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  UNKNOWN_PROJECT: 'No project has this project code.',
  UNKNOWN_JOB: 'The project has no job with this job code.',
  OUT_OF_SCOPE: OUT_OF_SCOPE_TEXT,
  INVALID_PERIOD: 'endDate is before startDate.',
  INVALID_PERCENT: 'allocationPercent must be more than 0 and at most 100, with up to two decimals.',
  EMPLOYEE_NOT_ACTIVE: 'Only an active employee can be allocated.',
  OUTSIDE_EMPLOYMENT: 'The interval is outside the employment (joining date to last working date).',
  INACTIVE_MASTER: 'The job or its project is not active.',
  INVALID_PROJECT_DATES: 'The interval must lie within the job’s and the project’s validity periods.',
  DUPLICATE_ALLOCATION: 'The employee is already allocated to this job for an overlapping interval, by an existing allocation or an earlier row of this file.',
  OVER_ALLOCATED:
    'The employee would be allocated above 100% on a day of the interval, counting the existing allocations and the earlier rows of this file. Above 100% needs an over-allocation exception, recorded with a reason by the employee’s direct manager; an import cannot record one.',
  COLUMN_COUNT: COLUMN_COUNT_TEXT,
};

/** TIMESHEET_LINES_V1 row problems: line-import.ts, the manual entry rules it shares (sheets.ts) and imports/batch.ts. */
const LINE_ROW_PROBLEMS: Record<string, string> = {
  INVALID_DATE: 'workDate is not a valid calendar date (YYYY-MM-DD).',
  INVALID_MINUTES: 'minutes must be whole quarter hours (15, 30, 45 and so on), at most 1440 (24 hours).',
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  OUT_OF_SCOPE: OUT_OF_SCOPE_TEXT,
  UNKNOWN_PROJECT: 'No project has this project code.',
  UNKNOWN_JOB: 'The project has no job with this job code.',
  UNKNOWN_ACTIVITY: 'No activity has this activity code.',
  PERIOD_IN_FUTURE: 'The week of workDate has not started yet; time is recorded only for a week that has started.',
  EMPLOYEE_NOT_ACTIVE: 'Only an active employee records time.',
  OUTSIDE_EMPLOYMENT: 'The work date is outside the employment (joining date to last working date).',
  TIMESHEET_NOT_EDITABLE: 'The employee’s timesheet for that week is not a draft revision, so no line can be added to it. An approved timesheet is corrected only through a reopen request.',
  WORK_DATE_IN_FUTURE: 'Time is recorded only for days already worked.',
  INACTIVE_MASTER: 'The project, job or activity is not active.',
  MASTER_OUT_OF_PERIOD: 'The project, job or activity is not valid on the work date.',
  ACTIVITY_NOT_PERMITTED: 'The job does not permit this activity.',
  NO_ACTIVE_ALLOCATION: 'The employee is not allocated to this job on the work date.',
  DUPLICATE_LINE: 'The employee’s timesheet already has a line for this day, job and activity, or an earlier row of this file adds one.',
  DAILY_LIMIT_EXCEEDED: 'The employee’s lines of this day would total more than 24 hours, counting the lines already recorded and the earlier rows of this file.',
  COLUMN_COUNT: COLUMN_COUNT_TEXT,
};

const ALLOCATION_IMPORT: TimesheetImport = {
  code: 'RESOURCE_ALLOCATION_V1',
  label: 'Allocation import',
  permissions: [ALLOC_IMPORT, ALLOC_MANAGE],
  base: '/v1/timesheet/allocation-imports',
  columns: 'employeeCode,projectCode,jobCode,startDate,endDate,allocationPercent',
  keyLabel: 'Employee @ project/job @ start date',
  noun: ['allocation', 'allocations'],
  verb: 'Create',
  note:
    'Each row allocates the employee with that employee code to a job, named by its project code and job code, from startDate to endDate (YYYY-MM-DD, both days included) at allocationPercent of the employee’s daily capacity (more than 0 and at most 100, up to two decimals). Every row meets the same rules as an allocation entered by hand, counted together with the existing allocations and the rows before it; an import cannot record an over-allocation exception. Rows apply only to employees within your role’s scope.',
  problems: ALLOCATION_ROW_PROBLEMS,
  keyPrefix: 'allocation-import',
  notPermitted: 'The selected role cannot import resource allocations: that needs the allocation import duty and the allocation manage duty, under which every row is applied.',
  forbidden: 'The selected role cannot import resource allocations: that needs the allocation import duty and the allocation manage duty.',
  changes: (keys) => [keys.allocations],
};

const LINE_IMPORT: TimesheetImport = {
  code: 'TIMESHEET_LINES_V1',
  label: 'Timesheet entry import',
  permissions: [TS_IMPORT],
  base: '/v1/timesheet/line-imports',
  columns: 'employeeCode,workDate,projectCode,jobCode,activityCode,minutes,note',
  keyLabel: 'Employee @ work date @ project/job/activity',
  noun: ['timesheet line', 'timesheet lines'],
  verb: 'Record',
  note:
    'Each row records the minutes (whole quarter hours, 15 to 1440) the employee with that employee code worked on workDate (YYYY-MM-DD) on a job, named by its project code and job code, under activityCode; note may be left blank. The line goes into the employee’s draft timesheet of that Monday to Sunday week, which is opened when it does not exist yet; the employee still reviews and submits it. Every row meets the same rules as a line entered by hand, including the allocation to the job and the 24-hour day counted with the lines already recorded and the rows before it. Rows apply only to employees within your role’s scope.',
  problems: LINE_ROW_PROBLEMS,
  keyPrefix: 'line-import',
  notPermitted: 'The selected role cannot import timesheet entries: that needs the timesheet import duty.',
  forbidden: 'The selected role cannot import timesheet entries: that needs the timesheet import duty.',
  changes: (keys) => [keys.sheets, keys.own],
};

/** File-level refusals of an upload or a scan check (imports/jobs.ts, imports/batch.ts, the route's body limit). */
const IMPORT_UPLOAD_WORDS: Record<string, string> = {
  FILE_QUARANTINED: 'The malware scan flagged this file, so nothing in it was read or imported. Upload a clean copy of the file.',
  INVALID_FILE: 'The file is not a valid UTF-8 CSV file.',
  EMPTY_FILE: 'The file has no data rows below its header.',
  TOO_MANY_ROWS: 'A batch holds at most 10,000 rows; split the file.',
  FILE_SIZE: 'An import file must be between 1 byte and 10 MB.',
  PAYLOAD_TOO_LARGE: 'The file is larger than 10 MB.',
  IDEMPOTENCY_KEY_IN_USE: 'This upload could not be matched to your earlier one. Validate the file again to send it as a new upload.',
  FILE_INTEGRITY: 'The file stored for this batch no longer matches what was uploaded, so it was not read. Cancel this import and upload the file again.',
  INVALID_REQUEST: 'The file name cannot contain / \\ < > : " | ? * or control characters, and the file cannot be empty.',
};

function importRefusalText(error: unknown, t: TimesheetImport): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'INVALID_HEADER') return `The first line of the file must be exactly the header ${t.columns}.`;
  if (error.code === 'FORBIDDEN') return t.forbidden;
  return IMPORT_UPLOAD_WORDS[error.code] ?? null;
}

function ImportRefusal({ error, t }: { error: unknown; t: TimesheetImport }) {
  if (!error) return null;
  const text = importRefusalText(error, t);
  if (text === null) return <ErrorNote error={error} />;
  return (
    <div role="alert" className="error">
      {text}
      <div className="hint">{(error as ApiError).code}</div>
    </div>
  );
}

export function AllocationImportScreen() {
  return <ImportScreen t={ALLOCATION_IMPORT} />;
}

export function LineImportScreen() {
  return <ImportScreen t={LINE_IMPORT} />;
}

/**
 * Shown only with every key the template's routes require. A role switch starts the screen afresh (keyed by the role
 * context), so a batch previewed under one assignment is never committed under another.
 */
function ImportScreen({ t }: { t: TimesheetImport }) {
  const { can } = useSession();
  const context = useRoleContext();
  if (!t.permissions.every((p) => can(p))) return <NotPermitted>{t.notPermitted}</NotPermitted>;
  return <ImportBatch key={context} t={t} />;
}

/**
 * Upload, row-by-row preview, then an explicit commit or cancel, as the employee imports run (records.tsx): one
 * idempotency key per chosen file. A file waiting for the scan worker is held (UPLOADED) with nothing read, the normal first
 * answer; checking it again, by itself while the screen is open, resumes that batch from the file the server stored (no second
 * upload, no second batch). The user's own batches are listed below, so a held batch can be opened again after leaving the page.
 */
function ImportBatch({ t }: { t: TimesheetImport }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // Validating the same file again (after a lost answer or a double click) returns the same batch; a new file gets a new key.
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };

  // A held batch checked again (POST /:id/resume), or one of the user's batches opened from the list.
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
    mutationFn: async ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => {
      // The decision and any look at the batch after it go out under the role it was made in (BR-046).
      const pinned = pinSession();
      try {
        return await pinned<ImportJob>(`${t.base}/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on (this very decision went through but its answer was lost, or the batch changed
        // since the preview): its job view shows where it stands now.
        const current = await pinned<ImportJob>(`${t.base}/${encodeURIComponent(id)}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onMutate: () => {
      upload.reset();
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      if (view.state === 'COMMITTED') for (const key of t.changes(keys)) void qc.invalidateQueries({ queryKey: key });
    },
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async ({ f, key }: { f: File; key: string }) => api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } }),
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      act.reset();
      // The preview is on screen, so the form starts clean: the next file is a new upload with its own key.
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      // The key is someone else's: the next attempt must use a fresh one.
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
    onSettled: refresh,
  });

  // While a file is checked or a decision is on its way, nothing else starts: its answer would replace a newer view.
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    upload.mutate({ f: file, key: (uploadKey.current ??= idempotencyKey(t.keyPrefix)) });
  };

  return (
    <div className="stack">
      <Section title={t.label}>
        <form onSubmit={submit} className="stack" aria-label={t.label}>
          <p className="hint">
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}). {t.note} Nothing is applied until you commit a preview, and a batch is applied all or
            nothing: one row with a problem rejects the whole batch.
          </p>
          <TemplateDownload base={t.base} code={t.code} />
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
        <ImportRefusal error={upload.error ?? resume.error} t={t} />
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title={`Your ${t.label.toLowerCase()} batches`} openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </div>
  );
}
