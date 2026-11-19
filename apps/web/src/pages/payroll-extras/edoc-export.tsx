// The export for EDOC screen (CL-100).
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, download, idempotencyKey, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { type BulkJob, jobErrorText, useBulkJob } from '../bulk-jobs';
import { EDOC_EXPORT } from './shared';

// ---------------------------------------------------------------------------------------------------------
// CL-100 export for EDOC
// ---------------------------------------------------------------------------------------------------------
function EdocJob({ jobId }: { jobId: string }) {
  const job = useBulkJob(jobId);
  const save = useMutation({ mutationFn: () => download(`/v1/payroll-extras/edoc-exports/${encodeURIComponent(jobId)}/download`) });
  const j: BulkJob | undefined = job.data;
  return (
    <>
      <ErrorNote error={job.error} />
      {j && (
        <p role="status">
          {j.state === 'COMPLETED'
            ? `Ready: ${String(j.result.files ?? 0)} payslip PDFs for ${String(j.result.month ?? '')}.`
            : j.state === 'FAILED'
              ? `The export failed: ${jobErrorText(j.errorCode ?? 'Error')}`
              : `Preparing the payslips (${j.processed} so far)…`}
        </p>
      )}
      {j?.state === 'COMPLETED' && (
        <button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          Download ZIP
        </button>
      )}
      <ErrorNote error={save.error} />
    </>
  );
}

export function EdocExportPage() {
  const { can } = useSession();
  const today = localDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [jobId, setJobId] = useState<string | null>(null);
  // One export of a month at a time: a repeat while it is open answers that export (existing), which is followed instead.
  const start = useMutation({
    mutationFn: () => api<{ jobId: string; existing?: boolean }>('/v1/payroll-extras/edoc-exports', { body: { month, idempotencyKey: idempotencyKey('edoc') } }),
    onSuccess: (r) => setJobId(r.jobId),
  });
  if (!can(EDOC_EXPORT)) return <Empty>Exporting payslips needs the payroll output export duty.</Empty>;
  return (
    <Section title="Export payslips for EDOC">
      <p className="hint">
        One PDF per issued payslip of the month (the current issue), for the employees in your scope and never your own, in one ZIP. It is prepared in the background; download it within 24 hours.
      </p>
      <form
        className="filters"
        aria-label="EDOC export"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!start.isPending) start.mutate();
        }}
      >
        <label>
          Month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} max={today.slice(0, 7)} required />
        </label>
        <button type="submit" disabled={start.isPending}>
          Prepare export
        </button>
      </form>
      <ErrorNote error={start.error} />
      {start.data?.existing && <p className="hint">Your export of this month is still open (being prepared, or ready to download): it is shown below instead of a new one.</p>}
      {jobId && <EdocJob key={jobId} jobId={jobId} />}
    </Section>
  );
}
