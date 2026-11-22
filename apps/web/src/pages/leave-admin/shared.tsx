// Shared parts of the leave administration screens: shapes, keys and words, and the report export other pages use too.

import { useMutation, useQuery } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { api, download, formatDate } from '../../api';
import { isReportRefusal, reportProblem } from '../../report-failures';
import { ErrorNote, StateBadge } from '../../ui';

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  active: boolean;
  version: number;
}
interface Mapping {
  id: string;
  employmentType: string | null;
  grade: string | null;
  location: string | null;
  priority: number;
}
export interface PolicyRevision {
  id: string;
  leaveType: string;
  leaveTypeName: string;
  paid: boolean;
  revision: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  eligibility: string;
  accrualRule: string;
  annualEntitlement: string;
  minServiceDays: number;
  carryCap: string;
  /** I-78 item 3: 1 (January) .. 12, or null when not set. */
  leaveYearStartMonth?: number | null;
  state: string;
  version: number;
  mappings: Mapping[];
  unmapped: boolean;
  warnings: { code: string; text: string }[];
  overlaps: { policyId: string; revision: number }[];
}
export interface Option {
  id: string;
  code: string;
  name: string;
}
export interface PolicyOptions {
  employmentTypes: Option[];
  grades: Option[];
  locations: Option[];
}

export const MANAGE = 'leave_policy.manage.operational';
export const ACTIVATE = 'leave_policy.activate.operational';

export const mappingText = (m: Mapping) => [m.employmentType && `employment type ${m.employmentType}`, m.grade && `grade ${m.grade}`, m.location && `location ${m.location}`].filter(Boolean).join(', ');
/** A code as words for reading ("FIXED_TERM" reads "fixed term"). */
export const codeWords = (code: string) => code.replace(/_/g, ' ').toLowerCase();
/** Names of the codes a policy carries, from the mapping form's choices; a code it cannot name reads as words. */
const nameIn = (items: Option[] | undefined, code: string) => items?.find((o) => o.code === code)?.name;
/** The same mapping as a sentence for the policy list (the remove buttons' names keep the codes they act on). */
export const mappingWords = (m: Mapping, options?: PolicyOptions) => {
  const type = m.employmentType && (nameIn(options?.employmentTypes, m.employmentType)?.toLowerCase() ?? codeWords(m.employmentType));
  const text = [type && `${type} employees`, m.grade && `grade ${m.grade}`, m.location && `at ${nameIn(options?.locations, m.location) ?? m.location}`].filter(Boolean).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
/**
 * An eligibility code as the employment types it names, joined with commas ("PERMANENT_FIXED_TERM" reads "permanent, fixed
 * term"): the longest known employment type code is taken first, so a code with an underscore of its own stays whole. A code
 * that is not a run of employment types reads as words.
 */
export const eligibilityWords = (code: string, types: Option[] | undefined) => {
  const known = [...(types ?? [])].sort((a, b) => b.code.length - a.code.length);
  const names: string[] = [];
  let rest = code;
  while (rest) {
    const hit = known.find((t) => rest === t.code || rest.startsWith(`${t.code}_`));
    if (!hit) return codeWords(code);
    names.push(hit.name.toLowerCase());
    rest = rest.slice(hit.code.length + 1);
  }
  return names.join(', ');
};
export const periodText = (p: Pick<PolicyRevision, 'effectiveFrom' | 'effectiveTo'>) => `${formatDate(p.effectiveFrom)} – ${p.effectiveTo ? `before ${formatDate(p.effectiveTo)}` : 'no end date'}`;
/** A filter form applies as it changes: Enter in one of its fields does not reload the page. */
export const keepOnPage = (e: FormEvent) => e.preventDefault();

/** The export's button, its state, its download and anything that went wrong, side by side, wrapping on a narrow screen. */
const EXPORT_ROW = 'flex flex-wrap items-center gap-x-4 gap-y-3 not-last:mb-3';

/**
 * Requests a report for the shown filters and offers its download when it is ready: reports are generated in the
 * background and the download re-checks access (FR-056).
 */
export function ReportExport({
  reportCode,
  filters,
  label,
  format,
  disabled = false,
}: {
  reportCode: string;
  filters: Record<string, unknown>;
  label: string;
  format?: 'CSV' | 'XLSX' | undefined;
  /** Shown but not offered yet (the filters it needs are not filled in): the page says what is missing. */
  disabled?: boolean;
}) {
  // FR-046: XLSX only where the report offers it; without a format the report is CSV.
  const request = useMutation({ mutationFn: () => api<{ id: string }>('/v1/reports', { body: { reportCode, filters, ...(format && format !== 'CSV' ? { format } : {}) } }) });
  const id = request.data?.id;
  const status = useQuery({
    queryKey: ['report', id],
    enabled: !!id,
    queryFn: () => api<{ state: string; rowCount: number | null; failureCode: string | null }>(`/v1/reports/${id}`),
    refetchInterval: (q) => (!isReportRefusal(q.state.error) && (q.state.data?.state === 'QUEUED' || q.state.data?.state === 'RUNNING') ? 3000 : false),
  });
  const save = useMutation({ mutationFn: () => download(`/v1/reports/${id}/download`) });
  return (
    <div className={EXPORT_ROW}>
      <Button type="button" variant="outline" disabled={disabled || request.isPending} onClick={() => request.mutate()}>
        {label}
      </Button>
      {status.data && <StateBadge state={status.data.state} />}
      {status.data?.state === 'COMPLETED' && (
        <Button type="button" variant="link" onClick={() => save.mutate()}>
          Download{status.data.rowCount !== null ? ` (${status.data.rowCount} rows)` : ''}
        </Button>
      )}
      {status.data && reportProblem(status.data) && <Hint as="span">{reportProblem(status.data)}</Hint>}
      <ErrorNote error={request.error ?? status.error ?? save.error} />
    </div>
  );
}
