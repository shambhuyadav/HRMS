// The loan request (LOAN_REQUESTS_V1) and salary stop (SALARY_STOPS_V1) uploads through the shared batch screens.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, type EmployeeHit, fileToBase64, formatDate, idempotencyKey, pinSession, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Notice, Section } from '../../ui';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from '../records';
import { byPrefix, EmployeePicker, type EvidenceDocument, evidenceState, usableEvidence } from './pickers';
import { type Act, Problem } from './problems';
import { DOCUMENT_READ, LOAN_REQUEST, PATHS, STOP_PROPOSE, useKeys } from './shared';

/** The file field and its Validate button side by side, their bottoms lined up (the old `div.inline`). */
const FIELD_ROW = 'flex flex-wrap items-end gap-x-4 gap-y-3';

// ---------------------------------------------------------------------------------------------------------
// FR-034 "entry and upload": the LOAN_REQUESTS_V1 upload (payroll-outputs/loan-import.ts) through the shared batch
// screens (records.tsx): template download, row-by-row preview, an explicit all-or-nothing commit or cancel, the user's
// own batches and a batch held for the malware scan. Each row is checked exactly as a request entered above, under the
// same payroll_loan.request.loan grant; every entered request waits for its own independent decision.
// ---------------------------------------------------------------------------------------------------------

/** LOAN_REQUESTS_V1 row problems (loan-import.ts, imports/batch.ts and the request rules of loans.ts) in plain words. */
const LOAN_ROW_PROBLEMS: Record<string, string> = {
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  OUT_OF_SCOPE: 'The employee is outside the scope of the selected role.',
  SELF_ACTION_NOT_ALLOWED: 'This is your own record: a loan for you is requested by you in your Employee role, or entered by someone else.',
  INVALID_LOAN_KIND: 'The loan kind is LOAN or ADVANCE, in capital letters.',
  INVALID_CURRENCY: 'The currency is a three-letter ISO code in capital letters.',
  INVALID_AMOUNT: 'The principal is a positive amount: digits only, no commas, and no more decimals than the currency allows.',
  CURRENCY_NOT_CONFIGURED: 'No active payroll calendar pays in this currency.',
  PURPOSE_REQUIRED: 'Give the purpose of the request (at most 1,000 characters).',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
};

const LOAN_IMPORT: ImportTemplate = {
  code: 'LOAN_REQUESTS_V1',
  label: 'Loan and advance requests',
  permissions: [LOAN_REQUEST],
  base: '/v1/payroll-outputs/loan-imports',
  columns: 'employeeCode,loanKind,currencyCode,principal,purpose',
  keyLabel: 'Employee code',
  noun: ['loan request', 'loan requests'],
  verb: 'Enter',
  note: 'Each row requests a loan or advance for one employee, checked exactly as a request entered on the loans screen: loanKind LOAN or ADVANCE, currencyCode a three-letter code an active payroll calendar pays in, principal as digits with no commas and no more decimals than that currency allows, and the purpose (put it in double quotes if it holds a comma). Loans carry no interest: no approved interest rate is configured. Every request entered waits for an independent decision, loan by loan; the upload approves nothing.',
  problems: LOAN_ROW_PROBLEMS,
};

export function LoanUploadScreen() {
  const { can } = useSession();
  if (!can(LOAN_REQUEST)) {
    return (
      <Section title="Loan and advance upload">
        <Empty>The selected role cannot enter loan requests: that needs the loan request grant.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <LoanUpload />
    </div>
  );
}

function LoanUpload() {
  const keys = useKeys();
  // A committed batch entered loan requests: the loan list and the decision queue show them.
  return (
    <TemplateUpload
      template={LOAN_IMPORT}
      title="Upload loan and advance requests"
      form="Upload loan requests"
      fileLabel="Loan requests file"
      keyPrefix="payroll-loan-import"
      act="loan-upload"
      pending="Nothing is requested"
      link={<Link to={PATHS.loans}>Loans and advances</Link>}
      committed="Every request entered waits for an independent decision, loan by loan: someone other than you and the employee decides each one."
      batches="Your loan request batches"
      onCommitted={(qc) => void qc.invalidateQueries({ queryKey: keys.loansAll })}
    />
  );
}

/**
 * An upload through the shared batch screens (records.tsx): the template and its rules, a row-by-row preview, an explicit
 * all-or-nothing commit or cancel, a batch held for the malware scan, and the user's own batches of this template.
 */
function TemplateUpload({
  template: t,
  title,
  form,
  fileLabel,
  keyPrefix,
  act: problemAct,
  pending,
  link,
  committed,
  batches,
  onCommitted,
}: {
  template: ImportTemplate;
  title: string;
  form: string;
  fileLabel: string;
  keyPrefix: string;
  act: Act;
  pending: string;
  link: ReactNode;
  committed: string;
  batches: string;
  onCommitted: (qc: ReturnType<typeof useQueryClient>) => void;
}) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file: validating the same file again (after a lost answer) returns the same batch.
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };
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
      const send = pinSession();
      try {
        return await send<ImportJob>(`${t.base}/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on (this very decision went through but its answer was lost): its view says where it stands.
        const current = await send<ImportJob>(`${t.base}/${encodeURIComponent(id)}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      if (view.state === 'COMMITTED') onCommitted(qc);
    },
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey(keyPrefix));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
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
      <Section title={title}>
        <form onSubmit={submit} aria-label={form} className="flex flex-col gap-3">
          <Hint>
            {/* The header is one long word of comma-joined column names: it may break anywhere, or it runs out of the card on a phone. */}
            CSV with exactly the header <code className="break-all">{t.columns}</code> (template {t.code}). {t.note} {pending} until you commit a preview, and a batch is applied all or nothing:
            one row with a problem rejects the whole batch. {link}
          </Hint>
          <TemplateDownload base={t.base} code={t.code} />
          <div className={FIELD_ROW}>
            <FormField className="w-auto">
              {fileLabel}
              <Input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </FormField>
            <Button type="submit" disabled={!file || busy}>
              Validate
            </Button>
          </div>
        </form>
        <Problem error={upload.error ?? resume.error} act={problemAct} />
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          {job.state === 'COMMITTED' && <Notice notice={{ text: committed, ok: true }} />}
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title={batches} openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-031 "Upload Stop Salary" (CL-087; I-66 payroll-6): the SALARY_STOPS_V1 upload (payroll/stop-import.ts) through the shared
// batch screens. Each row is checked exactly as a salary stop proposed one at a time on the salary holds and stops screen,
// under the same payroll_stop.propose.hold grant; every proposed stop waits for its own independent decision, which confirms
// its mode. Evidence documents are named by id, so the screen looks an employee's usable documents up.
// ---------------------------------------------------------------------------------------------------------

/** SALARY_STOPS_V1 row problems (stop-import.ts, imports/batch.ts and the proposal rules of inputs.ts) in plain words. */
const STOP_ROW_PROBLEMS: Record<string, string> = {
  UNKNOWN_PERIOD: 'No period of an active payroll calendar has this period code.',
  PERIOD_AMBIGUOUS: 'More than one active payroll calendar has a period with this code.',
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  OUT_OF_SCOPE: 'The employee is outside the scope of the selected role.',
  SELF_ACTION_NOT_ALLOWED: 'This is your own record: someone else proposes a salary stop for you.',
  INVALID_MODE: 'The mode is HOLD_DISBURSEMENT or EXCLUDE_CALCULATION, in capital letters, or blank (blank withholds the payment).',
  UNKNOWN_CRITERION: 'No hold criterion has this code.',
  HOLD_CRITERION_NOT_ACTIVE: 'Withholding a payment needs the code of an active hold criterion; none is active until a validated criterion is activated.',
  RELEASE_CRITERION_REQUIRED: 'Withholding a payment needs the release criterion (at most 1,000 characters).',
  NOT_A_HOLD: 'Leaving the employee out of the calculation is not a payment hold: leave the criterion code and the release criterion blank.',
  REASON_REQUIRED: 'Give the reason for the salary stop (at most 1,000 characters).',
  EVIDENCE_REQUIRED: 'Give the evidence reference and the id of at least one released, verified document of the employee.',
  INVALID_DOCUMENT_IDS: 'The evidence document ids are one to ten different document ids, separated by semicolons.',
  EVIDENCE_NOT_VERIFIED: 'An evidence document has not been released by the malware scan and verified by an independent reviewer.',
  INVALID_EVIDENCE: 'An evidence document is not a document of this employee.',
  STOP_EXISTS: 'The employee already has a salary stop for this period (from an earlier row, upload or proposal).',
  PERIOD_PROCESSED: 'The payroll of this employee for the period is processed: a hold of the processed record goes through a hold case.',
  FORBIDDEN: 'The selected role no longer holds the salary stop proposal grant.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
};

const STOP_IMPORT: ImportTemplate = {
  code: 'SALARY_STOPS_V1',
  label: 'Salary stops',
  permissions: [STOP_PROPOSE],
  base: '/v1/payroll/salary-stop-imports',
  columns: 'period_code,employee_code,mode,criterion_code,reason,release_criterion,evidence_reference,evidence_document_ids',
  keyLabel: 'Period / employee code',
  noun: ['salary stop', 'salary stops'],
  verb: 'Propose',
  note: 'Each row proposes a salary stop for one employee and period, checked exactly as a stop proposed on the salary holds and stops screen: period_code a period of an active payroll calendar; mode HOLD_DISBURSEMENT (the payment is withheld; a blank mode means this) with the criterion_code of an active hold criterion and the release_criterion, or EXCLUDE_CALCULATION (the employee is left out of the calculation, an exceptional mode) with both left blank; the reason; the evidence_reference; and evidence_document_ids, the ids of one to ten released, verified documents of the employee separated by semicolons (look them up below). Put a cell in double quotes if it holds a comma. Every stop proposed waits for an independent decision, stop by stop, which confirms its mode; the upload approves nothing.',
  problems: STOP_ROW_PROBLEMS,
};

export function StopUploadScreen() {
  const { can } = useSession();
  if (!can(STOP_PROPOSE)) {
    return (
      <Section title="Salary stop upload">
        <Empty>The selected role cannot propose salary stops: that needs the salary stop proposal grant.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <TemplateUpload
        template={STOP_IMPORT}
        title="Upload salary stops"
        form="Upload salary stops"
        fileLabel="Salary stops file"
        keyPrefix="payroll-stop-import"
        act="stop-upload"
        pending="Nothing is proposed"
        link={<Link to={PATHS.holds}>Salary holds and stops</Link>}
        committed="Every salary stop proposed waits for an independent decision, stop by stop: someone other than you and the employee decides each one and confirms its mode."
        batches="Your salary stop batches"
        onCommitted={(qc) => void qc.invalidateQueries(byPrefix('payroll-stop'))}
      />
      <EvidenceIdLookup />
    </div>
  );
}

/** An employee's documents with their ids, for the evidence_document_ids column (only released, verified ones are usable). */
function EvidenceIdLookup() {
  const { can } = useSession();
  const keys = useKeys();
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const docs = useQuery({
    queryKey: keys.documents(employee?.id ?? ''),
    queryFn: () => api<{ items: EvidenceDocument[] }>(`/v1/employees/${encodeURIComponent(employee!.id)}/documents`),
    enabled: can(DOCUMENT_READ) && employee !== null,
    retry: retryTransient,
  });
  return (
    <Section title="Evidence document ids">
      {!can(DOCUMENT_READ) ? (
        <Hint>The selected role cannot list employees’ documents, so it cannot look the evidence document ids up here.</Hint>
      ) : (
        <div className="flex flex-col gap-3">
          <Hint>Choose an employee to see their documents and ids. Only a document released by the malware scan and verified can be evidence.</Hint>
          <FormGrid asChild>
            <div>
              <EmployeePicker title="Employee" value={employee} onChange={setEmployee} />
            </div>
          </FormGrid>
          {employee && docs.isPending && <LoadingLine>Loading the employee’s documents…</LoadingLine>}
          {docs.error && <Problem error={docs.error} act="read" />}
          {employee && docs.data && docs.data.items.length === 0 && <Empty>The employee has no documents yet.</Empty>}
          {employee && docs.data && docs.data.items.length > 0 && (
            <Table aria-label="Evidence documents and their ids">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Document</TableHead>
                  <TableHead scope="col">Uploaded</TableHead>
                  <TableHead scope="col">State</TableHead>
                  <TableHead scope="col">Document id</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.data.items.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{`${readable(d.documentType)}${d.fileName ? ` · ${d.fileName}` : ''}`}</TableCell>
                    <TableCell>{formatDate(d.uploadedAt)}</TableCell>
                    <TableCell>{usableEvidence(d) ? <Badge tone="good">usable</Badge> : evidenceState(d)}</TableCell>
                    <TableCell>{usableEvidence(d) ? <code>{d.id}</code> : <Hint as="span">not usable</Hint>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </Section>
  );
}
