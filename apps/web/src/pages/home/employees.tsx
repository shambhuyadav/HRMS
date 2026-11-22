// The employee list: views, filters, sorting, paging and the list export.

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ButtonRow, FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { ErrorNote, nextSort, Section, SortHeader, sortParams, StateBadge } from '../../ui';
import { words } from './shared';

/** The columns GET /v1/employees and the employee register sort by (employee/service.ts). */
type EmployeeSort = 'employeeCode' | 'displayName' | 'department' | 'location' | 'designation' | 'joiningDate' | 'status';

/** The list's filters, in the address so a dashboard figure opens the list with its own (DF17); the export holds the same (FR-007, I-37). */
const EMPLOYEE_FILTERS = ['status', 'statusGroup', 'departmentId', 'joinedFrom', 'joinedTo'] as const;
/** DF04's lifecycle states, which the list takes as `status`. */
const EMPLOYEE_STATUSES = [
  { code: 'DRAFT', label: 'Draft' },
  { code: 'ACTIVE_PROBATION', label: 'Active (probation)' },
  { code: 'ACTIVE_CONFIRMED', label: 'Active (confirmed)' },
  { code: 'NOTICE', label: 'Notice' },
  { code: 'INACTIVE_SEPARATED', label: 'Separated' },
  { code: 'ARCHIVED', label: 'Archived' },
] as const;
/** A choice that stands for a `statusGroup`, a named set of statuses, rather than one status. */
const GROUP_CHOICE = 'statusGroup:';
/** `statusGroup=ACTIVE`, the set a dashboard's "Active employees" figure counts (DF17). */
const ACTIVE_GROUP = { code: 'ACTIVE', label: 'Active (probation, confirmed or notice)' } as const;
/**
 * BR-003 / FR-006's reference views (I-82 item 3), which the list also takes as `statusGroup`. They are views over DF04's states,
 * not stored statuses, and may overlap: an employee on notice is both Current and On notice. The server decides who is in each.
 */
const EMPLOYEE_VIEWS = [
  { code: 'CURRENT', label: 'Current (probation, confirmed or notice)' },
  { code: 'OFFERED', label: 'Offered (pre-joining, not yet activated)' },
  { code: 'OFFERED_REJECTED', label: 'Offered, rejected (closed before joining)' },
  { code: 'ON_PROBATION', label: 'On probation' },
  { code: 'ON_NOTICE', label: 'On notice' },
  { code: 'LEFT', label: 'Left' },
] as const;
const STATUS_GROUPS: readonly { code: string; label: string }[] = [ACTIVE_GROUP, ...EMPLOYEE_VIEWS];
/** The views beside which offers still with the candidate, or declined, are found in Hiring rather than here. */
const OFFER_VIEWS: readonly string[] = ['OFFERED', 'OFFERED_REJECTED'];
/** Hiring's offer list (hiring-pipeline.tsx), under its own read duty. */
const HIRING_OFFERS = '/hiring/offers';
const OFFER_READ = 'offer.read.operational';
/** FR-007 exports of the record sections (I-82 item 2): confidential, under their own duty, with the list's own filters. */
const SECTION_EXPORT = 'employee.export.private';
const ORG_MASTER_READ = 'org_master.read.operational';

/** A report of this list (FR-007): asked for with exactly the filters and order the list was asked for. */
const useListReport = (reportCode: string, filters: Record<string, string>) => useMutation({ mutationFn: () => api<{ id: string }>('/v1/reports', { body: { reportCode, filters } }) });

export function EmployeesPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ column: EmployeeSort; direction: 'ASC' | 'DESC' }>({ column: 'employeeCode', direction: 'ASC' });
  const filters = Object.fromEntries(EMPLOYEE_FILTERS.flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : []))) as Partial<Record<(typeof EMPLOYEE_FILTERS)[number], string>>;
  // FR-007 "List and export use identical filters": both are built from this one object; the server refuses a reversed range on both.
  const listFilters: Record<string, string> = { ...filters, ...(search ? { search } : {}), ...sortParams(sort) };
  const list = useQuery({
    queryKey: ['employees', listFilters, page],
    queryFn: () =>
      api<{ items: { id: string; employeeCode: string; displayName: string; status: string; assignment: { departmentName: string; locationName: string; designationName: string } | null; joiningDate: string }[]; total: number }>(
        `/v1/employees?${new URLSearchParams({ ...listFilters, page: String(page), pageSize: '25' }).toString()}`,
      ),
  });
  const departmentChoices = can(ORG_MASTER_READ);
  // Inactive departments too: history keeps them, and the list can still be asked who was on one (FR-004).
  const departments = useQuery({
    queryKey: ['employee-filter-departments'],
    enabled: departmentChoices,
    queryFn: () => api<{ items: { id: string; code: string; name: string; active: boolean }[] }>('/v1/org/departments?includeInactive=true'),
  });
  const exportList = useListReport('EMPLOYEE_REGISTER', listFilters);
  const exportFamily = useListReport('EMPLOYEE_FAMILY', listFilters);
  const exportQualifications = useListReport('EMPLOYEE_QUALIFICATIONS', listFilters);
  const exportPriorEmployment = useListReport('EMPLOYEE_PRIOR_EMPLOYMENT', listFilters);
  const sectionExports = [
    { label: 'Export family details', request: exportFamily },
    { label: 'Export qualifications', request: exportQualifications },
    { label: 'Export prior employment', request: exportPriorEmployment },
  ];
  const exports = [exportList, exportFamily, exportQualifications, exportPriorEmployment];
  // A changed list starts again at its first page, and "Requested" no longer describes it.
  const listChanged = () => {
    setPage(1);
    for (const request of exports) request.reset();
  };
  const setFilters = (changes: Partial<Record<(typeof EMPLOYEE_FILTERS)[number], string>>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next);
    listChanged();
  };
  const onSort = (column: EmployeeSort) => {
    setSort((current) => nextSort(current, column));
    listChanged();
  };
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));
  // Either document grant reaches the documents page: reading lists them, uploading adds one (FR-010).
  const documents = can('document.read.document') || can('document.upload.document');
  const statusChoice = filters.status ?? (filters.statusGroup ? `${GROUP_CHOICE}${filters.statusGroup}` : '');
  const groupLabel = (code: string) => STATUS_GROUPS.find((g) => g.code === code)?.label ?? words(code);
  const exportButton = (label: string, request: typeof exportList) => (
    <span key={label}>
      <Button variant="outline" disabled={request.isPending} onClick={() => request.mutate()}>
        {label}
      </Button>{' '}
      {request.isSuccess && (
        <Hint as="span">
          Requested. Download it from <Link to="/reports">Reports</Link>.
        </Hint>
      )}{' '}
    </span>
  );
  // The list's own actions, where people look for them (the card header), for the roles that may take them.
  const headerActions =
    can('employee.create.operational') || can('employee.import.operational') ? (
      <ButtonRow>
        {can('employee.import.operational') && (
          <Button asChild variant="outline" size="sm">
            <Link to="/imports">Import employees</Link>
          </Button>
        )}
        {can('employee.create.operational') && (
          <Button asChild size="sm">
            <Link to="/employees/new">New employee</Link>
          </Button>
        )}
      </ButtonRow>
    ) : undefined;
  return (
    <Section title={`Employees${list.data ? ` (${list.data.total})` : ''}`} actions={headerActions}>
      <FilterBar>
        <FormField>
          Search{' '}
          <Input
            maxLength={100}
            value={search}
            placeholder="Name, code or email"
            onChange={(e) => {
              setSearch(e.target.value);
              listChanged();
            }}
          />
        </FormField>
        <FormField>
          Status{' '}
          <NativeSelect
            value={statusChoice}
            onChange={(e) =>
              setFilters(e.target.value.startsWith(GROUP_CHOICE) ? { status: '', statusGroup: e.target.value.slice(GROUP_CHOICE.length) } : { status: e.target.value, statusGroup: '' })
            }
          >
            <option value="">All</option>
            <option value={`${GROUP_CHOICE}${ACTIVE_GROUP.code}`}>{ACTIVE_GROUP.label}</option>
            <optgroup label="Views">
              {EMPLOYEE_VIEWS.map((v) => (
                <option key={v.code} value={`${GROUP_CHOICE}${v.code}`}>
                  {v.label}
                </option>
              ))}
              {filters.statusGroup && !filters.status && !STATUS_GROUPS.some((g) => g.code === filters.statusGroup) && (
                <option value={`${GROUP_CHOICE}${filters.statusGroup}`}>{words(filters.statusGroup)}</option>
              )}
            </optgroup>
            <optgroup label="Statuses">
              {EMPLOYEE_STATUSES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
              {filters.status && !EMPLOYEE_STATUSES.some((s) => s.code === filters.status) && <option value={filters.status}>{words(filters.status)}</option>}
            </optgroup>
          </NativeSelect>
        </FormField>
        {departmentChoices && (
          <FormField>
            Department{' '}
            <NativeSelect value={filters.departmentId ?? ''} onChange={(e) => setFilters({ departmentId: e.target.value })}>
              <option value="">All</option>
              {departments.data?.items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.active ? '' : ' (inactive)'}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        )}
        <FormField>
          Joined from <Input type="date" value={filters.joinedFrom ?? ''} onChange={(e) => setFilters({ joinedFrom: e.target.value })} />
        </FormField>
        <FormField>
          Joined to <Input type="date" value={filters.joinedTo ?? ''} onChange={(e) => setFilters({ joinedTo: e.target.value })} />
        </FormField>
      </FilterBar>
      {filters.statusGroup && (
        <Hint>
          Status: {groupLabel(filters.statusGroup)}{' '}
          <Button variant="outline" onClick={() => setFilters({ status: '', statusGroup: '' })}>
            Clear
          </Button>
        </Hint>
      )}
      {!departmentChoices && (
        <Hint>
          Your role cannot read the department list, so it cannot choose a department here.{' '}
          {filters.departmentId && (
            <Button variant="outline" onClick={() => setFilters({ departmentId: '' })}>
              Clear the department filter
            </Button>
          )}
        </Hint>
      )}
      <ErrorNote error={departments.error} />
      <Table>
        <TableHeader>
          <TableRow>
            <SortHeader column="employeeCode" label="Code" sort={sort} onSort={onSort} />
            <SortHeader column="displayName" label="Name" sort={sort} onSort={onSort} />
            <SortHeader column="department" label="Department" sort={sort} onSort={onSort} />
            <SortHeader column="location" label="Location" sort={sort} onSort={onSort} />
            <SortHeader column="designation" label="Designation" sort={sort} onSort={onSort} />
            <SortHeader column="joiningDate" label="Joined" sort={sort} onSort={onSort} />
            <SortHeader column="status" label="Status" sort={sort} onSort={onSort} />
            {documents && (
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.data?.items.map((e) => (
            <TableRow key={e.id}>
              <TableCell>{e.employeeCode}</TableCell>
              <TableCell>{can('employee.read.operational') ? <Link to={`/employees/${e.id}`}>{e.displayName}</Link> : e.displayName}</TableCell>
              <TableCell>{e.assignment?.departmentName ?? '—'}</TableCell>
              <TableCell>{e.assignment?.locationName ?? '—'}</TableCell>
              <TableCell>{e.assignment?.designationName ?? '—'}</TableCell>
              <TableCell>{formatDate(e.joiningDate)}</TableCell>
              <TableCell>
                <StateBadge state={e.status} />
              </TableCell>
              {documents && (
                <RowActionsCell>
                  <Link to={`/employees/${e.id}/documents`}>Documents</Link>
                </RowActionsCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
      {filters.statusGroup && !filters.status && OFFER_VIEWS.includes(filters.statusGroup) && can(OFFER_READ) && (
        <Hint>
          Offers still awaiting the candidate’s answer, and offers the candidate declined, are candidates rather than employee records: they stay in Hiring’s{' '}
          <Link to={HIRING_OFFERS}>offer list</Link>.
        </Hint>
      )}
      {(can('employee.export.operational') || can(SECTION_EXPORT)) && (
        <p className="flex flex-wrap items-center gap-2">
          {can('employee.export.operational') && exportButton('Export this list', exportList)}
          {can(SECTION_EXPORT) && sectionExports.map((s) => exportButton(s.label, s.request))}
        </p>
      )}
      <ErrorNote error={list.error ?? exports.find((request) => request.error)?.error} />
    </Section>
  );
}
