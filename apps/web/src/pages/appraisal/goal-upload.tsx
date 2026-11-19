// The KRA upload (FR-041, template APPRAISAL_GOALS_V1): new draft appraisals only, after a preview.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { api, fileToBase64, idempotencyKey, readable } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, NotPermitted, Section, StateBadge } from '../../ui';
import { HeldBatchWatchNote, ImportBatches, TemplateDownload, useBatchFollowUp } from '../records';
import { Refusal } from './refusals';
import { IMPORT, type ImportJob, MANAGE, SCROLL, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: the KRA upload (FR-041, template APPRAISAL_GOALS_V1): new DRAFT appraisals only, after a preview
// ---------------------------------------------------------------------------------------------------------
const ROW_PROBLEMS: Record<string, string> = {
  WEIGHT_TOTAL_NOT_100: 'This employee’s goal weights in the file do not total exactly 100.',
  DUPLICATE_SEQUENCE: 'This goal sequence is already on an earlier row for the same employee and cycle.',
  INVALID_SEQUENCE: 'The sequence is not a whole number from 1 to 100.',
  INVALID_WEIGHT: 'The weight is not a whole number from 1 to 100.',
  INVALID_DESCRIPTION: 'The description is empty or longer than 500 characters.',
  INVALID_TARGET: 'The target is longer than 1,000 characters.',
  UNKNOWN_CYCLE: 'No cycle has this code.',
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  APPRAISAL_EXISTS: 'The employee already has an appraisal in this cycle; an upload only creates new ones.',
  CYCLE_OVERLAP: 'The employee already has an appraisal in an overlapping cycle.',
  CYCLE_CLOSED: 'The cycle is closed.',
  WINDOW_CLOSED: 'The cycle’s goal-setting window is not open today.',
  EMPLOYEE_NOT_ACTIVE: 'The employee is not active.',
  JOINED_AFTER_CYCLE: 'The employee joined after the cycle ends.',
  SELF_ACTION_NOT_ALLOWED: 'This is your own appraisal; you cannot set your own goals.',
  OUT_OF_SCOPE: 'The employee is outside the scope of your role.',
  APPRAISAL_NOT_ENROLLED: 'The first row of this employee and cycle did not enrol an appraisal.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
  BATCH_REJECTED: 'Not applied, because another row of the file has a problem (all or nothing).',
};

export function GoalUploadScreen() {
  const { can } = useSession();
  if (!can(IMPORT) || !can(MANAGE)) {
    return (
      <Section title="KRA upload">
        <NotPermitted>The selected role cannot upload goals: it needs both the appraisal import duty and the goal-setting duty.</NotPermitted>
      </Section>
    );
  }
  return <GoalUpload />;
}

/** The goal upload's batch routes (goal-import.ts; the list and resume routes come from imports/routes.ts). */
const GOAL_IMPORTS = '/v1/appraisal-goal-imports';

function GoalUpload() {
  const keys = useKeys();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  /** One idempotency key per chosen file: uploading the same file again returns the same job. */
  const uploadKey = useRef<string | null>(null);
  // A held upload checked again from the file the server stored (POST /:id/resume), or one of the user's uploads
  // opened from the list.
  const { resume, open, refresh, watch } = useBatchFollowUp(
    GOAL_IMPORTS,
    {
      show: setJob,
      closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)),
      onStart: () => {
        upload.reset();
        act.reset();
        setNotice(null);
      },
    },
    job,
  );
  const upload = useMutation({
    mutationFn: async (f: File) => api<ImportJob>(GOAL_IMPORTS, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: uploadKey.current! } }),
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (j) => {
      setJob(j);
      setFile(null);
      setInputKey((k) => k + 1);
      uploadKey.current = null;
    },
    onSettled: refresh,
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => api<ImportJob>(`${GOAL_IMPORTS}/${id}/${action}`, { method: 'POST' }),
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSettled: refresh,
    onSuccess: (j, v) => {
      setJob(j);
      // A row that fails when applied rejects the whole batch: the answer is then the REJECTED job (200), not an error.
      if (v.action === 'commit' && j.state !== 'COMMITTED') {
        setNotice({ text: 'Nothing was applied: a row failed when the upload was committed, so the whole file was rejected. See the row problems below.', ok: false });
        void qc.invalidateQueries({ queryKey: keys.appraisals });
      } else if (v.action === 'commit') {
        setNotice({
          text: `Applied ${j.acceptedCount ?? 0} row${j.acceptedCount === 1 ? '' : 's'}: the draft appraisals were created with their goals. Nothing was submitted, rated or approved.`,
          ok: true,
        });
        void qc.invalidateQueries({ queryKey: keys.appraisals });
      } else setNotice({ text: 'Discarded the upload; nothing was applied.', ok: true });
    },
  });
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    setNotice(null);
    if (!uploadKey.current) uploadKey.current = idempotencyKey('appraisal-goals');
    upload.mutate(file);
  };
  const problems = job ? job.rows.filter((r) => r.errorCode) : [];
  const held = job?.state === 'UPLOADED';
  const rowCount = job ? (job.rowCount ?? job.rows.length) : 0;
  return (
    <div className="stack">
      <Section title="KRA upload">
        <p className="hint">
          One row per goal: <code>cycleCode,employeeCode,sequence,description,target,weight</code> (template APPRAISAL_GOALS_V1). The rows of one employee and cycle become one new draft appraisal with
          those goals; each employee’s weights must total exactly 100. An upload never submits, rates or approves anything: each employee still enters a self-assessment and the review route decides.
        </p>
        <TemplateDownload base={GOAL_IMPORTS} code="APPRAISAL_GOALS_V1" />
        <form className="grid-form" aria-label="Upload goals" onSubmit={submit} noValidate>
          <label>
            Goal file (CSV)
            <input
              key={inputKey}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                uploadKey.current = null;
              }}
            />
          </label>
          <div className="row">
            <button type="submit" disabled={busy || !file}>
              {upload.isPending ? 'Checking…' : 'Upload and preview'}
            </button>
          </div>
          <Refusal error={upload.error ?? resume.error} action="upload" />
        </form>
        <Notice notice={notice} />
      </Section>
      {job && (
        <Section title={`Upload ${job.fileName ?? ''}`.trim()}>
          <p>
            State: <StateBadge state={job.state} />
            {held ? null : ` · ${rowCount} row${rowCount === 1 ? '' : 's'}`}
          </p>
          {held && (
            <>
              <p role="status">
                The file is waiting for the malware scan, so nothing in it has been read yet. This is usually a short wait. You can discard the upload meanwhile; it stays in your uploads below, so it
                can be opened again after you leave this page.
              </p>
              <div className="row">
                <HeldBatchWatchNote watch={watch} />
                <button type="button" className="secondary" disabled={busy} onClick={() => resume.mutate(job.id)}>
                  Check the scan again
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => act.mutate({ id: job.id, action: 'cancel' })}>
                  Discard the upload
                </button>
                {resume.data?.id === job.id && resume.data.state === 'UPLOADED' && !resume.isPending && <span role="status">Still waiting for the malware scan.</span>}
              </div>
            </>
          )}
          {job.state === 'PREVIEWED' && <p>Every row is valid. Committing creates the draft appraisals in one go; nothing is applied before that.</p>}
          {job.state === 'REJECTED' && <p className="error">The file was rejected as a whole: correct the rows below and upload it again. Nothing was applied.</p>}          {job.rows.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Upload rows">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Cycle / employee # sequence</th>
                    <th>State</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {job.rows.map((r) => (
                    <tr key={r.rowNumber}>
                      <td>{r.rowNumber}</td>
                      <td>{r.businessKey ?? '—'}</td>
                      <td>{readable(r.state)}</td>
                      <td>{r.errorCode ? (ROW_PROBLEMS[r.errorCode] ?? r.errorCode) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {problems.length === 0 && job.state === 'REJECTED' && <Empty>No row-level problem was reported.</Empty>}
          {job.state === 'PREVIEWED' && (
            <div className="row">
              <button type="button" disabled={busy} onClick={() => act.mutate({ id: job.id, action: 'commit' })}>
                {act.isPending ? 'Working…' : 'Commit: create the draft appraisals'}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => act.mutate({ id: job.id, action: 'cancel' })}>
                Discard the upload
              </button>
            </div>
          )}
          <Refusal error={act.error} action={act.variables?.action === 'cancel' ? 'discard' : 'commit'} />
        </Section>
      )}
      <ImportBatches base={GOAL_IMPORTS} title="Your KRA uploads" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </div>
  );
}
