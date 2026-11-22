// The audit trail screen (FR-058): who did what to which record and when, and the payroll trace (FR-057).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, nextSort, pageParams, Pager, Section, SortHeader, sortParams, type SortState, StateBadge } from '../../ui';

// ---------------------------------------------------------------------------------------------------------
// Audit trail (FR-058): who did what to which record and when. Values are never shown here (DF02).
// ---------------------------------------------------------------------------------------------------------

interface AuditEvent {
  id: string;
  occurredAt: string;
  resource: string;
  recordKey: string;
  action: string;
  actorAccountKey: string;
  actingRoleCode: string | null;
  valueGroups: string[];
  changedFields: string[];
  reasonRecorded: boolean;
}

/** A record kind, action or role code as a person reads it: "leave_request" is "Leave request", "ACCESS_DENIED" "Access denied", "HR_ADMINISTRATOR" "HR administrator". */
const codeWords = (code: string) => {
  const words = code.toLowerCase().replace(/_/g, ' ').replace(/\bhr\b/g, 'HR');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The columns GET /v1/audit/events sorts by (audit-trail/service.ts); newest first until one is chosen. */
type AuditSort = 'occurredAt' | 'resource' | 'action' | 'actor';

export function AuditTrailPage() {
  const { can } = useSession();
  const [filters, setFilters] = useState({ resource: '', recordKey: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState<AuditSort>>(null);
  const onSort = (column: AuditSort) => {
    setSort((current) => nextSort(current, column));
    setPage(1);
  };
  const query = new URLSearchParams({ page: String(page), pageSize: '50', ...sortParams(sort) });
  for (const [k, v] of Object.entries(applied)) if (v) query.set(k, v);
  const events = useQuery({ queryKey: ['audit-events', applied, page, sort], queryFn: () => api<{ items: AuditEvent[]; total: number }>(`/v1/audit/events?${query.toString()}`) });
  // "Record kind" offers the kinds the trail holds, in words; without that list (a refusal or a failure) it offers "All" only.
  const kinds = useQuery({ queryKey: ['audit-resources'], queryFn: () => api<{ items: string[] }>('/v1/audit/resources') });
  // BR-026: the export holds the events shown: the same record filters and period, not just the period.
  const exportFilters = Object.fromEntries(Object.entries(applied).filter(([, v]) => v));
  const exportReport = useMutation({ mutationFn: () => api<{ id: string }>('/v1/reports', { body: { reportCode: 'AUDIT_TRAIL', filters: exportFilters } }) });
  const pages = Math.max(1, Math.ceil((events.data?.total ?? 0) / 50));

  return (
    <Section title={`Audit trail${events.data ? ` (${events.data.total})` : ''}`}>
      <FilterBar asChild>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setApplied(filters);
          }}
        >
          <FormField>
            Record kind
            <NativeSelect value={filters.resource} onChange={(e) => setFilters({ ...filters, resource: e.target.value })}>
              <option value="">All</option>
              {(kinds.data?.items ?? []).map((k) => (
                <option key={k} value={k}>
                  {codeWords(k)}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField>
            Record id
            <Input value={filters.recordKey} placeholder="Optional: one record’s id" onChange={(e) => setFilters({ ...filters, recordKey: e.target.value.trim() })} />
          </FormField>
          <FormField>
            From
            <Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          </FormField>
          <FormField>
            To
            <Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
          </FormField>
          <Button type="submit">Show</Button>
          {can('audit.export.operational') && (
            <Button type="button" variant="outline" disabled={!applied.from || !applied.to || exportReport.isPending} onClick={() => exportReport.mutate()}>
              Export these events
            </Button>
          )}
        </form>
      </FilterBar>
      <Hint>Shows who changed which record and when, with the field names involved. Values are never shown here; open the record itself where you hold access.</Hint>
      {exportReport.isSuccess && <StatusNote tone="success">Export requested — download it from Reports when it is ready.</StatusNote>}
      <ErrorNote error={exportReport.error} />
      {events.data?.items.length === 0 && <Empty>No audit events match.</Empty>}
      {!!events.data?.items.length && (
        <Table>
          <TableHeader>
            <TableRow>
              <SortHeader column="occurredAt" label="When" sort={sort} onSort={onSort} />
              <SortHeader column="resource" label="Record" sort={sort} onSort={onSort} />
              <SortHeader column="action" label="Action" sort={sort} onSort={onSort} />
              <SortHeader column="actor" label="Actor" sort={sort} onSort={onSort} />
              <TableHead scope="col">Fields</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.data.items.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{new Date(e.occurredAt).toLocaleString()}</TableCell>
                <TableCell>
                  {codeWords(e.resource)} <Hint as="span">{e.recordKey.slice(0, 8)}</Hint>
                </TableCell>
                <TableCell>{codeWords(e.action)}</TableCell>
                <TableCell>
                  {e.actorAccountKey} {e.actingRoleCode && <Hint as="span">({codeWords(e.actingRoleCode)})</Hint>}
                </TableCell>
                <TableCell>
                  {e.changedFields.join(', ') || '—'}
                  {e.valueGroups.filter((g) => g !== 'operational').map((g) => (
                    <Badge key={g} tone="warn">
                      {g}
                    </Badge>
                  ))}
                  {e.reasonRecorded && <Badge>reason recorded</Badge>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <PagerRow>
        <PagerButton disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </PagerButton>
        <PagerCount>
          Page {page} of {pages}
        </PagerCount>
        <PagerButton disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Next
        </PagerButton>
      </PagerRow>
      <ErrorNote error={events.error} />
      <PayrollTrace />
    </Section>
  );
}

interface TraceAssignment {
  id: string;
  gradeCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  recordedAt: string;
  recordedBy: string | null;
  changedFields: string[];
}
interface TraceRun {
  runId: string;
  revision: number;
  state: string;
  periodCode: string;
  selectedAssignmentId: string | null;
  calculatedAssignmentId: string | null;
  salaryArrangementIds: string[];
}
interface Trace {
  employee: { id: string; code: string; name: string };
  assignments: TraceAssignment[];
  runs: TraceRun[];
  total: number;
}

const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortId = (id: string | null) => (id ? id.slice(0, 8) : 'not recorded');

/**
 * FR-057 "trace who changed an employee grade and which payroll run used it": who recorded each assignment revision and
 * which payroll runs used it. Identifiers and dates only, never an amount; nothing here changes anything.
 */
function PayrollTrace() {
  const [input, setInput] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [page, setPage] = useState(1);
  const trace = useQuery({
    queryKey: ['audit-payroll-trace', employeeId, page],
    enabled: !!employeeId,
    queryFn: () => api<Trace>(`/v1/audit/employees/${encodeURIComponent(employeeId)}/payroll-trace?${pageParams(page)}`),
  });
  const entered = input.trim();
  const t = trace.data;
  return (
    <section aria-label="Grade and payroll trace">
      <h3>Grade and payroll trace</h3>
      <FormGrid
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setEmployeeId(entered);
        }}
      >
        <FormField>
          Employee id
          <Input value={input} onChange={(e) => setInput(e.target.value)} />
        </FormField>
        <Button type="submit" disabled={!UUID_FORM.test(entered)}>
          Trace
        </Button>
      </FormGrid>
      <Hint>Who recorded each assignment and which payroll runs used it. Identifiers and dates only: amounts are never shown here.</Hint>
      <ErrorNote error={trace.error} />
      {t && (
        <>
          <p>
            {t.employee.name} ({t.employee.code})
          </p>
          {t.assignments.length === 0 && <Empty>No assignment is recorded for this employee.</Empty>}
          {t.assignments.length > 0 && (
            <Table aria-label="Assignment revisions">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Assignment</TableHead>
                  <TableHead scope="col">Grade</TableHead>
                  <TableHead scope="col">From</TableHead>
                  <TableHead scope="col">To</TableHead>
                  <TableHead scope="col">Changed</TableHead>
                  <TableHead scope="col">Recorded by</TableHead>
                  <TableHead scope="col">Recorded at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {t.assignments.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{shortId(a.id)}</TableCell>
                    <TableCell>{a.gradeCode ?? '—'}</TableCell>
                    <TableCell>{formatDate(a.effectiveFrom)}</TableCell>
                    <TableCell>{a.effectiveTo ? formatDate(a.effectiveTo) : '—'}</TableCell>
                    <TableCell>{a.changedFields.join(', ') || '—'}</TableCell>
                    <TableCell>{a.recordedBy ?? '—'}</TableCell>
                    <TableCell>{new Date(a.recordedAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {t.runs.length === 0 && <Empty>No payroll run has used this employee.</Empty>}
          {t.runs.length > 0 && (
            <Table aria-label="Payroll runs that used an assignment">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Period</TableHead>
                  <TableHead scope="col">Run</TableHead>
                  <TableHead scope="col">Revision</TableHead>
                  <TableHead scope="col">State</TableHead>
                  <TableHead scope="col">Selected with</TableHead>
                  <TableHead scope="col">Calculated with</TableHead>
                  <TableHead scope="col">Salary arrangements</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {t.runs.map((r) => (
                  <TableRow key={r.runId}>
                    <TableCell>{r.periodCode}</TableCell>
                    <TableCell>{shortId(r.runId)}</TableCell>
                    <TableCell>{r.revision}</TableCell>
                    <TableCell>
                      <StateBadge state={r.state} />
                    </TableCell>
                    <TableCell>{shortId(r.selectedAssignmentId)}</TableCell>
                    <TableCell>{shortId(r.calculatedAssignmentId)}</TableCell>
                    <TableCell>{r.salaryArrangementIds.map(shortId).join(', ') || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pager page={page} pageSize={LIST_PAGE_SIZE} total={t.total} onPage={setPage} label="Payroll run pages" noun="run" />
        </>
      )}
    </section>
  );
}
