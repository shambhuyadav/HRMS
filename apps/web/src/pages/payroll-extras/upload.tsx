// The batch upload panel (through the shared import screens) and the upload templates of the payroll extras screens.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError, fileToBase64, idempotencyKey } from '../../api';
import { ErrorNote, Section } from '../../ui';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from '../records';
import { CHALLAN_MANAGE, TAX_IMPORT } from './shared';

/** The file field and its Validate button side by side, their bottoms lined up (the old `div.inline`). */
const FIELD_ROW = 'flex flex-wrap items-end gap-x-4 gap-y-3';

// ---------------------------------------------------------------------------------------------------------
// A batch upload through the shared import screens (preview, commit or cancel, the caller's own batches).
// ---------------------------------------------------------------------------------------------------------
export function UploadPanel({ template: t, title, fileLabel }: { template: ImportTemplate; title: string; fileLabel: string }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
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
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey(t.code.toLowerCase()));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onSettled: refresh,
    onSuccess: (view) => {
      setJob(view);
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => api<ImportJob>(`${t.base}/${id}/${action}`, { method: 'POST' }),
    onSuccess: (view) => {
      setJob(view);
      void qc.invalidateQueries({ queryKey: ['payroll-extras'] });
    },
    onSettled: refresh,
  });
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  return (
    <>
      <Section title={title}>
        <form
          className="flex flex-col gap-3"
          aria-label={title}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (file && !busy) upload.mutate(file);
          }}
        >
          <Hint>
            {/* The header is one long word of comma-joined column names: it may break anywhere, or it runs out of the card on a phone. */}
            CSV with exactly the header <code className="break-all">{t.columns}</code>. {t.note} Nothing is applied until you commit the preview, and one row with a problem rejects the whole file.
          </Hint>
          <TemplateDownload base={t.base} code={t.code} />
          <div className={FIELD_ROW}>
            <FormField className="w-auto">
              {fileLabel}
              <Input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </FormField>
            <Button type="submit" disabled={!file || busy}>
              Validate
            </Button>
          </div>
        </form>
        <ErrorNote error={upload.error ?? resume.error} />
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title={`Your ${t.label.toLowerCase()} batches`} openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

const EMPLOYEE_PROBLEMS = {
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  OUT_OF_SCOPE: 'This employee is outside your role’s scope.',
  OWN_RECORD: 'This is your own record; another administrator must record it.',
  NOT_EMPLOYED_IN_MONTH: 'The employee had not joined by this month.',
  FUTURE_MONTH: 'This month has not started yet.',
  DUPLICATE_IN_BATCH: 'The file already has a row for the same key.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
};

export const TDS_CHALLAN_TEMPLATE: ImportTemplate = {
  code: 'TDS_CHALLAN_V1',
  label: 'TDS challan',
  permissions: [CHALLAN_MANAGE],
  base: '/v1/payroll-extras/tds-challan-imports',
  columns: 'month,section,bsrCode,challanSerial,depositDate,amount',
  keyLabel: 'BSR code @ deposit date @ serial',
  noun: ['challan', 'challans'],
  verb: 'Record',
  note: 'Each row is one deposit: the month (YYYY-MM) whose tax it pays, the section, the bank’s 7-digit BSR code, the challan serial number, the deposit date and the amount.',
  problems: {
    CHALLAN_EXISTS: 'A challan with this BSR code, deposit date and serial number is already recorded.',
    INVALID_MONTH: 'The month must be written YYYY-MM.',
    FUTURE_MONTH: 'This month has not started yet.',
    INVALID_SECTION: 'The section is 1 to 10 letters or digits, for example 192.',
    INVALID_BSR_CODE: 'A BSR code is 7 digits.',
    INVALID_CHALLAN_SERIAL: 'The challan serial number is up to 5 digits.',
    INVALID_DEPOSIT_DATE: 'The deposit date must be written YYYY-MM-DD.',
    FUTURE_DEPOSIT_DATE: 'The deposit date is after today.',
    DEPOSIT_BEFORE_MONTH: 'Tax of a month is deposited on or after the first day of that month.',
    INVALID_AMOUNT: 'The amount is a number above zero with at most 2 decimals.',
    DUPLICATE_IN_BATCH: 'The file already has this challan on an earlier row.',
  },
};

export const PERQUISITES_TEMPLATE: ImportTemplate = {
  code: 'PERQUISITES_V1',
  label: 'Perquisites',
  permissions: [TAX_IMPORT],
  base: '/v1/payroll-extras/perquisite-imports',
  columns: 'employeeCode,month,perquisiteType,value',
  keyLabel: 'Employee @ month @ type',
  noun: ['perquisite', 'perquisites'],
  verb: 'Record',
  note: 'Each row is the taxable value of one perquisite of an employee for a month (YYYY-MM), by a type code such as RENT_FREE_ACCOMMODATION. A row for a key already recorded replaces it as a new revision; the earlier value stays on record.',
  changeFields: ['value'],
  problems: { ...EMPLOYEE_PROBLEMS, INVALID_MONTH: 'The month must be written YYYY-MM.', INVALID_PERQUISITE_TYPE: 'The type is a code of capital letters, digits and _.', INVALID_VALUE: 'The value is a number of at least zero with at most 2 decimals.' },
};

export const PAST_SALARY_TEMPLATE: ImportTemplate = {
  code: 'PAST_SALARY_V1',
  label: 'Past salary',
  permissions: [TAX_IMPORT],
  base: '/v1/payroll-extras/past-salary-imports',
  columns: 'employeeCode,financialYear,source,fromMonth,toMonth,taxableSalary,tdsDeducted',
  keyLabel: 'Employee @ year @ source',
  noun: ['past salary', 'past salaries'],
  verb: 'Record',
  note: 'Each row is the taxable salary paid and the tax deducted in a financial year (2026-27) over its months, before this payroll ran here (BEFORE_GO_LIVE) or by an earlier employer (PREVIOUS_EMPLOYER).',
  changeFields: ['taxableSalary', 'tdsDeducted'],
  problems: {
    ...EMPLOYEE_PROBLEMS,
    INVALID_FISCAL_YEAR: 'The financial year is written like 2026-27.',
    INVALID_SOURCE: 'The source is BEFORE_GO_LIVE or PREVIOUS_EMPLOYER.',
    INVALID_MONTHS: 'The months are written YYYY-MM, the first not after the last.',
    MONTHS_OUTSIDE_YEAR: 'Both months must fall in the financial year given.',
    AFTER_JOINING: 'An earlier employer’s months end by the month the employee joined here.',
    OVERLAPS_PROCESSED_PAYROLL: 'These months overlap payroll already processed here, which the tax projection already counts.',
    INVALID_AMOUNT: 'Amounts are numbers of at least zero with at most 2 decimals.',
  },
};
