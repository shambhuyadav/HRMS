// Export employee documents to a ZIP (CL-027): what would be exported, then the archive, and the export log.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, download, plural, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Notice, Pager, Section } from '../../ui';
import { Refusal, type Words } from './refusals';

// ---------------------------------------------------------------------------------------------------------
// Export employee documents to a ZIP (CL-027; 0281): filters department, document type and employee; first what would be exported,
// then the archive, built by the server for the selected role's scope with only files the malware scan released. The server
// enforces every rule and bound; this screen shows what it answered, and the export log.
// ---------------------------------------------------------------------------------------------------------
/** GET /v1/documents/export/* and /v1/documents/exports: the bulk export right, beside the single download's read right. */
export const DOCUMENT_EXPORT = 'document.export.document';
const DOCUMENT_READ = 'document.read.document';
export const EXPORT_PATH = '/documents/export';

/**
 * A selection over one archive's bound, in the error tint. It has no role of its own: it is part of the check's outcome, which the
 * status line above it announces.
 */
const OVER_LIMIT = 'm-0 rounded-lg border border-[var(--bad-edge)] bg-[var(--bad-soft)] px-4 py-3 text-sm text-destructive';

interface ExportOptions {
  departments: { id: string; code: string; name: string; active: boolean }[];
  documentTypes: { code: string; label: string; active: boolean }[];
  limits: { files: number; bytes: number };
}
interface ExportSummary {
  documents: number;
  employees: number;
  bytes: number;
  withheld: number;
  withinLimits: boolean;
  limits: { files: number; bytes: number };
}
interface ExportLogItem {
  id: string;
  exportedAt: string;
  documentCount: number;
  employeeCount: number;
  byteSize: string;
  withheldCount: number;
  exportedByName: string | null;
  department: { code: string; name: string } | null;
  documentType: { code: string; label: string } | null;
  employee: { employeeCode: string; displayName: string } | null;
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

const EXPORT_WORDS: Words = {
  NOTHING_TO_EXPORT: (e) => {
    const withheld = (e.details as { withheld?: number } | undefined)?.withheld ?? 0;
    const nothing = 'No released document matches these filters, so nothing was exported.';
    if (withheld <= 0) return nothing;
    return `${nothing} ${plural(withheld, 'file waits', 'files wait')} for the malware scan or ${withheld === 1 ? 'was' : 'were'} quarantined.`;
  },
  EXPORT_TOO_LARGE: (e) => {
    const d = (e.details ?? {}) as { documents?: number; bytes?: number; maxFiles?: number; maxBytes?: number };
    return `This selection is too large for one archive (${plural(d.documents ?? 0, 'file', 'files')}, ${megabytes(d.bytes ?? 0)}; at most ${d.maxFiles ?? 200} files and ${megabytes(d.maxBytes ?? 0)}). Narrow the filters and export in parts.`;
  },
  NOT_FOUND: 'No employee with this code is in the selected role’s scope.',
  UNKNOWN_DEPARTMENT: 'There is no such department.',
  UNKNOWN_DOCUMENT_TYPE: 'There is no such document type.',
  FORBIDDEN: 'The selected role cannot export employee documents: it needs both the export right and the right to read documents.',
};

export function DocumentExportScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Export documents</h1>
      {can(DOCUMENT_EXPORT) && can(DOCUMENT_READ) ? (
        <DocumentExport />
      ) : (
        <Section title="Export documents">
          <NotPermitted>The selected role cannot export employee documents: it needs both the export right and the right to read documents.</NotPermitted>
        </Section>
      )}
    </>
  );
}

/** The check's answer in words: how many files of how many employees, and how many matching ones are left out. */
function summaryText(summary: ExportSummary): string {
  const found =
    summary.documents === 0
      ? 'No released document matches these filters.'
      : `${plural(summary.documents, 'file', 'files')} of ${plural(summary.employees, 'employee', 'employees')}, ${megabytes(summary.bytes)}.`;
  const leftOut = summary.withheld > 0 ? ` ${plural(summary.withheld, 'matching file is', 'matching files are')} not released by the malware scan and will be left out.` : '';
  return found + leftOut;
}

function DocumentExport() {
  const qc = useQueryClient();
  const options = useQuery({ queryKey: ['document-export-options'], queryFn: () => api<ExportOptions>('/v1/documents/export/options'), retry: retryTransient });
  const [departmentId, setDepartmentId] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  const query = new URLSearchParams({
    ...(departmentId ? { departmentId } : {}),
    ...(documentType ? { documentType } : {}),
    ...(employeeCode.trim() ? { employeeCode: employeeCode.trim() } : {}),
  }).toString();
  // What the archive would hold for exactly these filters; any change of filter asks again.
  const [checked, setChecked] = useState<{ query: string; summary: ExportSummary } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: () => api<ExportSummary>(`/v1/documents/export/summary${query ? `?${query}` : ''}`),
    onMutate: () => setDone(null),
    onSuccess: (summary) => setChecked({ query, summary }),
  });
  const save = useMutation({
    mutationFn: () => download(`/v1/documents/export${query ? `?${query}` : ''}`),
    onSuccess: () => {
      setDone('The archive was downloaded, and the export is recorded in the log below.');
      void qc.invalidateQueries({ queryKey: ['document-exports'] });
    },
  });
  const current = checked?.query === query ? checked.summary : null;
  const limits = options.data?.limits;
  return (
    <>
      <Section title="Export documents to a ZIP">
        <Hint>
          One archive of the employees’ documents in the selected role’s scope: a folder per employee code and an export log (export-log.csv) saying who exported what, when and with which
          filters. Only files the malware scan has released are included; the others are counted and left out.
          {limits ? ` One archive holds at most ${limits.files} files and ${megabytes(limits.bytes)}.` : ''} Every export is recorded, with each document it carried.
        </Hint>
        <FilterBar asChild>
          <form
            aria-label="Export filters"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (!check.isPending) check.mutate();
            }}
          >
            <FormField>
              Department
              <NativeSelect value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">All departments in scope</option>
                {(options.data?.departments ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.active ? '' : ' (inactive)'}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              Document type
              <NativeSelect value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
                <option value="">All types</option>
                {(options.data?.documentTypes ?? []).map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                    {t.active ? '' : ' (inactive)'}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              Employee code (blank: everyone)
              <Input value={employeeCode} maxLength={60} onChange={(e) => setEmployeeCode(e.target.value)} />
            </FormField>
            <Button type="submit" disabled={check.isPending}>
              Check what would be exported
            </Button>
          </form>
        </FilterBar>
        <ErrorNote error={options.error} />
        <Refusal error={check.error} words={EXPORT_WORDS} />
        {current && (
          <div className="flex flex-col gap-3">
            <StatusNote tone="info" role="status">
              {summaryText(current)}
            </StatusNote>
            {!current.withinLimits && <p className={OVER_LIMIT}>This is more than one archive holds. Narrow the filters and export in parts.</p>}
            {current.documents > 0 && current.withinLimits && (
              <p>
                <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
                  Download the ZIP
                </Button>
              </p>
            )}
          </div>
        )}
        {done && <Notice notice={{ text: done, ok: true }} />}
        <Refusal error={save.error} words={EXPORT_WORDS} />
      </Section>
      <ExportLog />
    </>
  );
}

/** The filters an export was made with, in words; "None" when it took everything in scope. */
function filtersText(x: ExportLogItem): string {
  const parts = [x.department ? `Department ${x.department.name}` : null, x.documentType ? `Type ${x.documentType.label}` : null, x.employee ? `Employee ${x.employee.employeeCode}` : null];
  return parts.filter(Boolean).join('; ') || 'None';
}

/** The export log (GET /v1/documents/exports): who exported, when, with which filters, and how many files. */
function ExportLog() {
  const [page, setPage] = useState(1);
  const log = useQuery({ queryKey: ['document-exports', page], queryFn: () => api<{ items: ExportLogItem[]; total: number }>(`/v1/documents/exports?page=${page}&pageSize=25`), retry: retryTransient });
  const items = log.data?.items ?? [];
  return (
    <Section title="Export log">
      <ErrorNote error={log.error} />
      {log.isSuccess && items.length === 0 && <Empty>No export yet.</Empty>}
      {items.length > 0 && (
        <Table aria-label="Export log">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">When</TableHead>
              <TableHead scope="col">By</TableHead>
              <TableHead scope="col">Filters</TableHead>
              <TableHead scope="col">Files</TableHead>
              <TableHead scope="col">Employees</TableHead>
              <TableHead scope="col">Left out (not released)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((x) => (
              <TableRow key={x.id}>
                <TableCell>{new Date(x.exportedAt).toLocaleString()}</TableCell>
                <TableCell>{x.exportedByName ?? '—'}</TableCell>
                <TableCell>{filtersText(x)}</TableCell>
                <TableCell>{x.documentCount}</TableCell>
                <TableCell>{x.employeeCount}</TableCell>
                <TableCell>{x.withheldCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pager page={page} pageSize={25} total={log.data?.total ?? 0} onPage={setPage} label="Export log pages" noun="export" />
    </Section>
  );
}
