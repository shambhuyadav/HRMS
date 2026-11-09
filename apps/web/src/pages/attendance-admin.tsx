// Attendance administration (FR-019, FR-020; BR-009; DF05; DF09; E05, E07).
//
// Punch imports: the two published templates through the batch framework: upload, dry-run preview, an explicit commit,
// the stored error report and the user's own batches. Unlike the other imports, valid independent events are accepted
// while invalid ones are quarantined for review (DF09): one row with a problem does not stop the others, and a single row
// is never partly accepted.
//
// Attendance policies: revisions with their thresholds, effective period and mappings, a draft maintained by HR and
// activated by someone else, which ends the revision it replaces. Every value comes from the person filling the form; the
// page proposes none. Overtime (decided under owner delegation, 6 Nov 2026, I-78 item 5): with the setting on, a revision
// states its basis, minimum and rounding unit, and evaluation proposes overtime candidates only; nothing pays them.
// The server re-checks every duty and rule; this page only offers what the role can do.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { api, ApiError, download, fileToBase64, idempotencyKey, pinSession } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';
import { HELD_BATCH_NOTE, HeldBatchCheck, ImportBatches, type ImportJob, type ImportRow, TemplateDownload, useBatchFollowUp } from './records';

const IMPORT = 'attendance.import.operational';
const MANAGE = 'attendance_policy.manage.operational';
const ACTIVATE = 'attendance_policy.activate.operational';

// ---------------------------------------------------------------------------------------------------------
// Punch imports
// ---------------------------------------------------------------------------------------------------------

/** The published versioned templates (DF09). */
const TEMPLATES = [
  {
    code: 'ATTENDANCE_PUNCH_V1',
    label: 'Punches, one event per row',
    base: '/v1/attendance/punch-imports',
    columns: 'employeeCode,occurredAt,direction,externalEventKey,sourceIdentity',
    note: 'occurredAt needs its offset, for example 2026-03-02T09:00:00+05:30; direction is IN or OUT. Name the device or source in sourceIdentity when its event keys are its own, so that equal keys of two devices stay two events; a blank source keeps the general import namespace.',
  },
  {
    code: 'ATTENDANCE_IN_OUT_V1',
    label: 'In and out times, one day per row',
    base: '/v1/attendance/in-out-imports',
    columns: 'employeeCode,workDate,inTime,outTime',
    note: 'Times are HH:MM in company time. An out time before the in time is the next calendar day: a night shift belongs to the date it starts. A row with one time is one event, shown as a missing punch when the day is processed.',
  },
] as const;

/** Row results in plain words (attendance/punch-import.ts, imports/batch.ts); any other code is shown as the server sent it. */
const ROW_PROBLEMS: Record<string, string> = {
  UNKNOWN_EMPLOYEE: 'No employee with this code is in the scope of your role.',
  INVALID_TIMESTAMP: 'The time is not a real date and time with its offset.',
  FUTURE_TIMESTAMP: 'The time is later than this submission.',
  INVALID_DIRECTION: 'The direction must be IN or OUT.',
  MISSING_EVENT_KEY: 'The row has no event key.',
  INVALID_EVENT_KEY: 'The event key is longer than 200 characters.',
  INVALID_SOURCE: 'The source may use letters, digits, dots, dashes and underscores, up to 60 characters.',
  CONFLICTING_DUPLICATE_KEY: 'This event key is already stored with a different employee, time or direction, so it was not changed. Check which is right.',
  DUPLICATE_EVENT: 'The same event is already stored under this key, so nothing was added.',
  REPEATED_PUNCH: 'The same employee, time and direction are already stored, or came earlier in this file, under another key of this source.',
  INVALID_DATE: 'The work date is not a real calendar date.',
  INVALID_TIME: 'A time must be HH:MM on the 24-hour clock.',
  MISSING_TIMES: 'The row has neither an in time nor an out time.',
  ZERO_DURATION: 'The in and out times are the same.',
  AMBIGUOUS_LOCAL_TIME: 'A clock change makes this local time ambiguous, so it was not guessed.',
  COLUMN_COUNT: 'The row does not have exactly the columns of the template.',
};

const SHOWN_ROWS = 200;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function rowsOf(job: ImportJob) {
  const by = (states: string[]) => job.rows.filter((r) => states.includes(r.state));
  return { applied: by(['VALID', 'ACCEPTED']), quarantined: by(['QUARANTINED']), settled: by(['REJECTED']) };
}

const RESULT: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  VALID: { label: 'will be applied', tone: 'good' },
  ACCEPTED: { label: 'applied', tone: 'good' },
  QUARANTINED: { label: 'quarantined', tone: 'bad' },
  REJECTED: { label: 'not added', tone: 'neutral' },
};

function RowResult({ row }: { row: ImportRow }) {
  const result = RESULT[row.state] ?? { label: row.state.toLowerCase(), tone: 'neutral' as const };
  return <Badge tone={result.tone}>{result.label}</Badge>;
}

function RowNote({ row }: { row: ImportRow }) {
  const source = row.proposedChanges?.repeatOfSource?.to;
  if (source) return <>Stored and flagged: {source} already delivered this punch. How the two pair is left to the attendance controller until the pairing rules are approved.</>;
  if (!row.errorCode) return <>—</>;
  return (
    <>
      {ROW_PROBLEMS[row.errorCode] ?? row.errorCode}
      <div className="hint">{row.errorCode}</div>
    </>
  );
}

function PunchJobView({ job, base, pending, onAction, error }: { job: ImportJob; base: string; pending: boolean; onAction: (a: 'commit' | 'cancel') => void; error: unknown }) {
  const { applied, quarantined, settled } = rowsOf(job);
  const left = quarantined.length + settled.length;
  const report = useMutation({ mutationFn: () => download(`${base}/${job.id}/error-report`) });
  // Rows left out come first; the rest only confirm what was applied.
  const ordered = [...quarantined, ...settled, ...applied];
  return (
    <Section
      title={`Preview: ${job.fileName ?? 'import'} (${job.template ?? ''})`}
      actions={
        job.state === 'PREVIEWED' || job.state === 'UPLOADED' ? (
          <div className="row">
            {job.state === 'PREVIEWED' && (
              <button type="button" disabled={pending} onClick={() => onAction('commit')}>
                {applied.length > 0 ? `Apply ${count(applied.length, 'row', 'rows')}` : 'Close the batch, nothing to apply'}
              </button>
            )}
            <button type="button" className="secondary" disabled={pending} onClick={() => onAction('cancel')}>
              Cancel import
            </button>
          </div>
        ) : undefined
      }
    >
      <p>
        <StateBadge state={job.state} /> {job.state === 'UPLOADED' ? null : count(job.rowCount ?? job.rows.length, 'row', 'rows')}
      </p>
      {job.state === 'UPLOADED' && <p role="status">{HELD_BATCH_NOTE}</p>}
      {job.state === 'PREVIEWED' && (
        <p role="status">
          {count(applied.length, 'row will be applied', 'rows will be applied')}. {count(quarantined.length, 'row is', 'rows are')} quarantined for review and {count(settled.length, 'repeat adds', 'repeats add')} nothing. Nothing is stored until you apply.
        </p>
      )}
      {job.state === 'COMMITTED' && (
        <p role="status">
          {count(job.acceptedCount, 'row was applied', 'rows were applied')}; {count(quarantined.length, 'row stays', 'rows stay')} quarantined and {count(settled.length, 'repeat added', 'repeats added')} nothing. Correct quarantined events and upload them in a new file.
        </p>
      )}
      {job.state === 'CANCELLED' && <p>Import cancelled; nothing was applied.</p>}
      {left > 0 && job.state !== 'UPLOADED' && (
        <div className="row">
          <button type="button" className="secondary" disabled={report.isPending} onClick={() => report.mutate()}>
            Download the error report
          </button>
          <span className="hint">The rows left out, with their cells as submitted.</span>
        </div>
      )}
      <ErrorNote error={report.error} />
      {job.rows.length > 0 && (
        <table aria-label="Rows of this batch">
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Event</th>
              <th scope="col">Result</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {ordered.slice(0, SHOWN_ROWS).map((r) => (
              <tr key={r.rowNumber}>
                <td>{r.rowNumber}</td>
                <td>{r.businessKey}</td>
                <td>
                  <RowResult row={r} />
                </td>
                <td>
                  <RowNote row={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {ordered.length > SHOWN_ROWS && <p className="hint">Showing the first {SHOWN_ROWS} of {ordered.length} rows; the error report has every row left out.</p>}
      <ErrorNote error={error} />
    </Section>
  );
}

export function PunchImportsPage() {
  const [code, setCode] = useState<string>(TEMPLATES[0].code);
  const template = TEMPLATES.find((t) => t.code === code) ?? TEMPLATES[0];
  const [file, setFile] = useState<File | null>(null);
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file and template: validating the same file again returns the same job.
  const uploadKey = useRef<string | null>(null);

  const { resume, open, refresh, watch } = useBatchFollowUp(
    template.base,
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
      const send = pinSession();
      try {
        return await send<ImportJob>(`${template.base}/${id}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on: its job view shows where it stands now.
        const current = await send<ImportJob>(`${template.base}/${id}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onSuccess: setJob,
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey('punches'));
      return api<ImportJob>(template.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onSettled: refresh,
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
  });
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (file && !busy) upload.mutate(file);
  };

  return (
    <>
      <Section title="Import punches">
        <form onSubmit={submit} className="stack">
          <label>
            Template
            <select
              value={template.code}
              disabled={busy}
              onChange={(e) => {
                setCode(e.target.value);
                setJob(null);
                uploadKey.current = null;
                upload.reset();
                act.reset();
              }}
            >
              {TEMPLATES.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label} ({t.code})
                </option>
              ))}
            </select>
          </label>
          <p className="hint">
            CSV with exactly the header <code>{template.columns}</code>. {template.note} Nothing is stored until you apply a preview. Valid rows are applied and invalid ones quarantined for review; importing the same file again adds nothing.
          </p>
          <TemplateDownload key={template.code} base={template.base} code={template.code} />
          <div className="inline">
            <label>
              Import file
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
              Validate
            </button>
          </div>
        </form>
        <ErrorNote error={upload.error ?? resume.error} />
      </Section>
      {job && (
        <>
          <PunchJobView job={job} base={template.base} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches key={template.base} base={template.base} title="Your punch batches" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Attendance policies
// ---------------------------------------------------------------------------------------------------------

interface Mapping {
  id: string;
  grade: string | null;
  location: string | null;
  priority: number;
}
export interface AttendancePolicy {
  id: string;
  code: string;
  revision: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  graceMinutes: number;
  presentPercent: string;
  halfDayPercent: string;
  overtimeEnabled: boolean;
  overtimeBasis?: 'AFTER_SHIFT_END' | 'BEYOND_SCHEDULED_NET' | null;
  overtimeMinimumMinutes?: number | null;
  overtimeRoundingMinutes?: number | null;
  state: string;
  version: number;
  mappings: Mapping[];
  warnings: { code: string; text: string }[];
}
interface Option {
  id: string;
  code: string;
  name: string;
}

interface DraftValues {
  effectiveFrom: string;
  effectiveTo: string;
  graceMinutes: string;
  presentPercent: string;
  halfDayPercent: string;
  overtimeEnabled: boolean;
  overtimeBasis: string;
  overtimeMinimumMinutes: string;
  overtimeRoundingMinutes: string;
}
const BLANK: DraftValues = {
  effectiveFrom: '',
  effectiveTo: '',
  graceMinutes: '',
  presentPercent: '',
  halfDayPercent: '',
  overtimeEnabled: false,
  overtimeBasis: '',
  overtimeMinimumMinutes: '',
  overtimeRoundingMinutes: '',
};

const OVERTIME_BASIS_TEXT: Record<string, string> = {
  AFTER_SHIFT_END: 'minutes worked after the shift ends',
  BEYOND_SCHEDULED_NET: 'minutes worked beyond the scheduled net minutes',
};

/** The API's body: the overtime rules go only with the setting on, and then all three are required by the form. */
const draftBody = (v: DraftValues) => ({
  effectiveFrom: v.effectiveFrom,
  effectiveTo: v.effectiveTo || null,
  graceMinutes: Number(v.graceMinutes),
  presentPercent: v.presentPercent,
  halfDayPercent: v.halfDayPercent,
  overtimeEnabled: v.overtimeEnabled,
  ...(v.overtimeEnabled
    ? { overtimeBasis: v.overtimeBasis, overtimeMinimumMinutes: Number(v.overtimeMinimumMinutes), overtimeRoundingMinutes: Number(v.overtimeRoundingMinutes) }
    : {}),
});

const overtimeText = (p: AttendancePolicy) =>
  !p.overtimeEnabled
    ? 'overtime off'
    : p.overtimeBasis
      ? `overtime candidates: ${OVERTIME_BASIS_TEXT[p.overtimeBasis] ?? p.overtimeBasis}, from ${p.overtimeMinimumMinutes} minutes, rounded down to ${p.overtimeRoundingMinutes}-minute units`
      : 'overtime on, its rules not set (cannot be activated)';

const mappingText = (m: Mapping) => (m.grade || m.location ? [m.grade && `grade ${m.grade}`, m.location && `location ${m.location}`].filter(Boolean).join(', ') : 'the whole company');
const periodText = (p: AttendancePolicy) => (p.effectiveTo ? `from ${p.effectiveFrom}, until before ${p.effectiveTo}` : `from ${p.effectiveFrom}`);
const nameOf = (p: AttendancePolicy) => `${p.code} revision ${p.revision}`;

/** Refusals of a policy change in plain words; any other is shown as the server sent it. */
function refusalText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'POLICY_OVERLAP') {
    const revisions = (error.details as { revisions?: { code: string; revision: number }[] } | undefined)?.revisions ?? [];
    return `This revision ties with ${revisions.map((r) => `${r.code} revision ${r.revision}`).join(', ')} for the same employees in an overlapping period, which processing could not resolve. Change the mappings or the dates, or retire the other revision.`;
  }
  if (error.code === 'SELF_APPROVAL') return 'Whoever wrote or last edited this revision cannot activate it; someone else must.';
  if (error.code === 'INVALID_THRESHOLDS') return 'The present percentage is at most 100, and the half-day percentage is above 0 and below the present percentage.';
  if (error.code === 'INVALID_PERIOD') return 'The end of the period must be after its start, and a retirement cannot extend a revision.';
  if (error.code === 'BACKDATED_RETIREMENT') return 'A revision is retired from today or a later date.';
  if (error.code === 'STALE_VERSION') return 'This revision changed since you opened it. It has been reloaded; try again.';
  if (error.code === 'OVERTIME_RULES_REQUIRED') return 'With overtime on, state its basis, its minimum and its rounding unit.';
  return null;
}

function PolicyRefusal({ error }: { error: unknown }) {
  const words = refusalText(error);
  if (!words) return <ErrorNote error={error} />;
  return (
    <p role="alert" className="error">
      {words}
    </p>
  );
}

function DraftFields({ values, onChange }: { values: DraftValues; onChange: (v: DraftValues) => void }) {
  const field = (key: Exclude<keyof DraftValues, 'overtimeEnabled'>) => ({ value: values[key], onChange: (e: { target: { value: string } }) => onChange({ ...values, [key]: e.target.value }) });
  const overtime = values.overtimeEnabled && (
    <>
      <label>
        Overtime basis
        <select required {...field('overtimeBasis')}>
          <option value="">Choose a basis</option>
          <option value="AFTER_SHIFT_END">Minutes after the shift ends</option>
          <option value="BEYOND_SCHEDULED_NET">Minutes beyond the scheduled net minutes</option>
        </select>
      </label>
      <label>
        Overtime from (minutes)
        <input required inputMode="numeric" pattern="\d{1,4}" {...field('overtimeMinimumMinutes')} />
      </label>
      <label>
        Rounded down to units of (minutes)
        <input required inputMode="numeric" pattern="[1-9]\d{0,3}" {...field('overtimeRoundingMinutes')} />
      </label>
    </>
  );
  return (
    <>
      <label>
        Effective from
        <input type="date" required {...field('effectiveFrom')} />
      </label>
      <label>
        Effective until (exclusive, optional)
        <input type="date" {...field('effectiveTo')} />
      </label>
      <label>
        Grace (minutes)
        <input required inputMode="numeric" pattern="\d{1,4}" {...field('graceMinutes')} />
      </label>
      <label>
        Present from (% of scheduled net minutes)
        <input required inputMode="decimal" pattern="\d{1,3}(\.\d{1,2})?" {...field('presentPercent')} />
      </label>
      <label>
        Half day from (% of scheduled net minutes)
        <input required inputMode="decimal" pattern="\d{1,3}(\.\d{1,2})?" {...field('halfDayPercent')} />
      </label>
      <label className="check">
        <input type="checkbox" checked={values.overtimeEnabled} onChange={(e) => onChange({ ...values, overtimeEnabled: e.target.checked })} /> Overtime candidates (proposed for a manager's
        decision; never paid from here)
      </label>
      {overtime}
    </>
  );
}

function NewRevision({ onChanged }: { onChanged: () => void }) {
  const [code, setCode] = useState('');
  const [values, setValues] = useState(BLANK);
  const create = useMutation({
    mutationFn: () => api('/v1/attendance/policies', { body: { code: code.trim().toUpperCase(), ...draftBody(values) } }),
    onSuccess: () => {
      setCode('');
      setValues(BLANK);
      onChanged();
    },
  });
  return (
    <Section title="New policy revision">
      <form
        className="grid-form"
        aria-label="New policy revision"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Policy code
          <input required maxLength={40} pattern="[A-Za-z][A-Za-z0-9_]*" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <DraftFields values={values} onChange={setValues} />
        <button type="submit" disabled={create.isPending}>
          Create draft
        </button>
      </form>
      <p className="hint">An existing code gets its next revision; a new code starts at revision 1. The revision stays a draft, applying to nobody, until it is mapped and someone other than its author activates it.</p>
      <PolicyRefusal error={create.error} />
    </Section>
  );
}

function AddMapping({ policy, onDone }: { policy: AttendancePolicy; onDone: () => void }) {
  const options = useQuery({ queryKey: ['attendance-policy-options'], queryFn: () => api<{ grades: Option[]; locations: Option[] }>('/v1/attendance/policy-options') });
  const [choice, setChoice] = useState({ gradeId: '', locationId: '' });
  const add = useMutation({
    mutationFn: () => api(`/v1/attendance/policies/${policy.id}/mappings`, { body: { expectedVersion: policy.version, ...(choice.gradeId ? { gradeId: choice.gradeId } : {}), ...(choice.locationId ? { locationId: choice.locationId } : {}) } }),
    onSuccess: onDone,
  });
  const select = (label: string, key: keyof typeof choice, items: Option[] | undefined) => (
    <label>
      {label}
      <select value={choice[key]} onChange={(e) => setChoice({ ...choice, [key]: e.target.value })}>
        <option value="">Any</option>
        {items?.map((o) => (
          <option key={o.id} value={o.id}>
            {o.code}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="grid-form"
      aria-label={`Map ${nameOf(policy)}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      {select('Grade', 'gradeId', options.data?.grades)}
      {select('Location', 'locationId', options.data?.locations)}
      <button type="submit" disabled={add.isPending}>
        Add mapping
      </button>
      <p className="hint">Leaving both as Any maps the whole company, at the lowest priority.</p>
      <ErrorNote error={options.error ?? add.error} />
    </form>
  );
}

function RevisionActions({ policy, canManage, canActivate, onChanged }: { policy: AttendancePolicy; canManage: boolean; canActivate: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState<'edit' | 'map' | 'retire' | null>(null);
  const [values, setValues] = useState<DraftValues>({
    effectiveFrom: policy.effectiveFrom,
    effectiveTo: policy.effectiveTo ?? '',
    graceMinutes: String(policy.graceMinutes),
    presentPercent: policy.presentPercent,
    halfDayPercent: policy.halfDayPercent,
    overtimeEnabled: policy.overtimeEnabled,
    overtimeBasis: policy.overtimeBasis ?? '',
    overtimeMinimumMinutes: policy.overtimeMinimumMinutes == null ? '' : String(policy.overtimeMinimumMinutes),
    overtimeRoundingMinutes: policy.overtimeRoundingMinutes == null ? '' : String(policy.overtimeRoundingMinutes),
  });
  const [retire, setRetire] = useState({ effectiveTo: '', reason: '' });
  const done = () => {
    setOpen(null);
    onChanged();
  };
  // A stale version reloads the list, so the next attempt reviews the revision as it now stands.
  const refreshOnError = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'STALE_VERSION') onChanged();
  };
  const edit = useMutation({ mutationFn: () => api(`/v1/attendance/policies/${policy.id}`, { method: 'PATCH', body: { expectedVersion: policy.version, ...draftBody(values) } }), onSuccess: done, onError: refreshOnError });
  const remove = useMutation({ mutationFn: (mappingId: string) => api(`/v1/attendance/policies/${policy.id}/mappings/${mappingId}/remove`, { body: { expectedVersion: policy.version } }), onSuccess: onChanged, onError: refreshOnError });
  const activate = useMutation({ mutationFn: () => api(`/v1/attendance/policies/${policy.id}/activate`, { body: { expectedVersion: policy.version } }), onSuccess: done, onError: refreshOnError });
  const retireIt = useMutation({ mutationFn: () => api(`/v1/attendance/policies/${policy.id}/retire`, { body: { expectedVersion: policy.version, effectiveTo: retire.effectiveTo, reason: retire.reason.trim() } }), onSuccess: done, onError: refreshOnError });
  const name = nameOf(policy);
  const toggle = (which: 'edit' | 'map' | 'retire') => setOpen(open === which ? null : which);
  return (
    <>
      {policy.state === 'DRAFT' && canManage && (
        <>
          <button type="button" className="link" onClick={() => toggle('edit')}>
            Edit {name}
          </button>{' '}
          <button type="button" className="link" onClick={() => toggle('map')}>
            Map {name}
          </button>{' '}
          {policy.mappings.map((m) => (
            <button key={m.id} type="button" className="link" disabled={remove.isPending} onClick={() => remove.mutate(m.id)}>
              Remove {mappingText(m)}
            </button>
          ))}
        </>
      )}
      {policy.state === 'DRAFT' && canActivate && (
        <button type="button" className="link" disabled={activate.isPending} onClick={() => activate.mutate()}>
          Activate {name}
        </button>
      )}
      {policy.state === 'ACTIVE' && canActivate && (
        <button type="button" className="link" onClick={() => toggle('retire')}>
          Retire {name}
        </button>
      )}
      <PolicyRefusal error={remove.error ?? activate.error} />
      {open === 'edit' && (
        <form
          className="grid-form"
          aria-label={`Edit ${name}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            edit.mutate();
          }}
        >
          <DraftFields values={values} onChange={setValues} />
          <button type="submit" disabled={edit.isPending}>
            Save draft
          </button>
          <PolicyRefusal error={edit.error} />
        </form>
      )}
      {open === 'map' && <AddMapping policy={policy} onDone={done} />}
      {open === 'retire' && (
        <form
          className="grid-form"
          aria-label={`Retire ${name}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            retireIt.mutate();
          }}
        >
          <label>
            No longer applies from
            <input type="date" required value={retire.effectiveTo} onChange={(e) => setRetire({ ...retire, effectiveTo: e.target.value })} />
          </label>
          <label className="wide">
            Reason for retiring
            <input required maxLength={500} value={retire.reason} onChange={(e) => setRetire({ ...retire, reason: e.target.value })} />
          </label>
          <button type="submit" disabled={retireIt.isPending}>
            Confirm retirement
          </button>
          <PolicyRefusal error={retireIt.error} />
        </form>
      )}
    </>
  );
}

export function AttendancePoliciesPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const canManage = can(MANAGE);
  const canActivate = can(ACTIVATE);
  const revisions = useQuery({ queryKey: ['attendance-policies'], queryFn: () => api<{ items: AttendancePolicy[] }>('/v1/attendance/policies') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['attendance-policies'] });
  const items = revisions.data?.items ?? [];
  return (
    <>
      <Section title="Attendance policy revisions">
        <ErrorNote error={revisions.error} />
        {revisions.isSuccess && items.length === 0 && <Empty>No attendance policy revisions yet.</Empty>}
        {items.length > 0 && (
          <table aria-label="Attendance policy revisions">
            <thead>
              <tr>
                <th scope="col">Revision</th>
                <th scope="col">State</th>
                <th scope="col">Period</th>
                <th scope="col">Thresholds</th>
                <th scope="col">Mapped to</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>{nameOf(p)}</td>
                  <td>
                    <StateBadge state={p.state} />
                  </td>
                  <td>{periodText(p)}</td>
                  <td>
                    {`Grace ${p.graceMinutes} minutes; present from ${Number(p.presentPercent)}%; half day from ${Number(p.halfDayPercent)}%; ${overtimeText(p)}`}
                  </td>
                  <td>
                    {p.mappings.length > 0 && (
                      <ul>
                        {p.mappings.map((m) => (
                          <li key={m.id}>{mappingText(m)}</li>
                        ))}
                      </ul>
                    )}
                    {p.warnings.map((w) => (
                      <p key={w.code} role="note">
                        <Badge tone="warn">{w.code === 'UNMAPPED' ? 'unmapped' : 'overlap'}</Badge> {w.text}
                      </p>
                    ))}
                  </td>
                  <td>
                    <RevisionActions key={p.version} policy={p} canManage={canManage} canActivate={canActivate} onChanged={refresh} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          When two revisions apply, the mapping naming more of grade and location wins. Activating a revision ends the earlier revision of its code on the new revision’s first day. The present and half-day percentages count against scheduled net minutes; on a half weekly-off, against half of them. Overtime
          candidates are minutes proposed for a manager’s decision, counted from the same punch pairs as worked time: every worked minute on a weekly off or holiday, and on a working day only a present one. Nothing pays them.
        </p>
      </Section>
      {canManage && <NewRevision onChanged={refresh} />}
    </>
  );
}

export const ATTENDANCE_ADMIN_SCREENS: readonly ScreenRoute[] = [
  { path: '/attendance/punch-imports', title: 'Punch imports', permission: IMPORT, nav: true, component: PunchImportsPage },
  { path: '/attendance/policies', title: 'Attendance policies', permission: MANAGE, nav: true, component: AttendancePoliciesPage },
];
