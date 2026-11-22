// The export for EDOC screen (CL-100).
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, download, idempotencyKey, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Notice, Section } from '../../ui';
import { type BulkJob, jobErrorText, useBulkJob } from '../bulk-jobs';
import { EDOC_EXPORT } from './shared';

// ---------------------------------------------------------------------------------------------------------
// CL-100 export for EDOC
// ---------------------------------------------------------------------------------------------------------

/**
 * Where the export stands, always as a status (the line it replaces kept its role whatever it said): ready in the success colours,
 * failed in the error colours, still being prepared as information.
 */
function ExportStatus({ job }: { job: BulkJob }) {
  if (job.state === 'COMPLETED') return <Notice notice={{ text: `Ready: ${String(job.result.files ?? 0)} payslip PDFs for ${String(job.result.month ?? '')}.`, ok: true }} />;
  if (job.state === 'FAILED') {
    return (
      <StatusNote tone="error" role="status">
        {`The export failed: ${jobErrorText(job.errorCode ?? 'Error')}`}
      </StatusNote>
    );
  }
  return (
    <StatusNote tone="info" role="status">
      {`Preparing the payslips (${job.processed} so far)…`}
    </StatusNote>
  );
}

function EdocJob({ jobId }: { jobId: string }) {
  const job = useBulkJob(jobId);
  const save = useMutation({ mutationFn: () => download(`/v1/payroll-extras/edoc-exports/${encodeURIComponent(jobId)}/download`) });
  const j: BulkJob | undefined = job.data;
  return (
    <>
      <ErrorNote error={job.error} />
      {j && <ExportStatus job={j} />}
      {j?.state === 'COMPLETED' && (
        <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          Download ZIP
        </Button>
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
      <Hint>
        One PDF per issued payslip of the month (the current issue), for the employees in your scope and never your own, in one ZIP. It is prepared in the background; download it within 24 hours.
      </Hint>
      <FilterBar asChild>
        <form
          aria-label="EDOC export"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!start.isPending) start.mutate();
          }}
        >
          <FormField>
            Month
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} max={today.slice(0, 7)} required />
          </FormField>
          <Button type="submit" disabled={start.isPending}>
            Prepare export
          </Button>
        </form>
      </FilterBar>
      <ErrorNote error={start.error} />
      {start.data?.existing && <Hint>Your export of this month is still open (being prepared, or ready to download): it is shown below instead of a new one.</Hint>}
      {jobId && <EdocJob key={jobId} jobId={jobId} />}
    </Section>
  );
}
