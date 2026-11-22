// The requisitions screen (register and decision queues) and the new requisition screen.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, isForbidden, readable, retryTransient } from '../../api';
import { FormProgress } from '../../form-progress';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Section, StateBadge } from '../../ui';
import { useOrgList } from './lookups';
import { Refusal } from './refusals';
import { RequisitionForm } from './requisition-form';
import { RequisitionApprovalQueue, RequisitionValidationQueue } from './requisition-queues';
import {
  ORG_READ,
  PAGE_SIZES,
  PATHS,
  personLabel,
  REQ_CREATE,
  REQ_READ,
  REQUISITION_STATES,
  type RequisitionDetail,
  type RequisitionInput,
  type RequisitionPage,
  shown,
  useKeys,
  UUID,
} from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: requisitions (register with the filters the API offers, and the decision queue)
// ---------------------------------------------------------------------------------------------------------

export function RequisitionsScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Requisitions</h1>
      <RequisitionValidationQueue />
      <RequisitionApprovalQueue />
      {can(REQ_READ) ? (
        <RequisitionRegister />
      ) : (
        <Section title="Requisition register">
          <NotPermitted>The selected role cannot view requisitions.</NotPermitted>
        </Section>
      )}
    </>
  );
}

interface ListFilters {
  state: string;
  departmentId: string;
  search: string;
  page: number;
  pageSize: number;
}

/** `withDepartment`: the department filter is offered (the role can list departments); otherwise none is applied unseen. */
function readFilters(params: URLSearchParams, withDepartment: boolean): ListFilters {
  const state = REQUISITION_STATES.find((s) => s === params.get('state')) ?? '';
  const department = withDepartment ? (params.get('department') ?? '') : '';
  const page = Number(params.get('page') ?? '1');
  return {
    state,
    departmentId: UUID.test(department) ? department : '',
    search: (params.get('search') ?? '').trim().slice(0, 100),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: PAGE_SIZES.find((n) => String(n) === params.get('pageSize')) ?? 25,
  };
}

function listQuery(f: ListFilters): string {
  const q = new URLSearchParams({ page: String(f.page), pageSize: String(f.pageSize) });
  if (f.state) q.set('state', f.state);
  if (f.departmentId) q.set('departmentId', f.departmentId);
  if (f.search) q.set('search', f.search);
  return q.toString();
}

function RequisitionRegister() {
  const { can, me } = useSession();
  const keys = useKeys();
  const [params, setParams] = useSearchParams();
  const canOrg = can(ORG_READ);
  const filters = readFilters(params, canOrg);
  const [typed, setTyped] = useState(filters.search);
  const applied = useRef(filters.search);
  applied.current = filters.search;
  const departments = useOrgList('departments', canOrg);

  const update = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  // The search is sent once typing pauses; any filter change starts again at the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      const term = typed.trim().slice(0, 100);
      if (term !== applied.current) update({ search: term || null, page: null });
    }, 300);
    return () => clearTimeout(t);
    // Only typing starts a search; the address changing (back/forward) does not resend what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` changes with the address, which must not start a search
  }, [typed]);

  const query = listQuery(filters);
  const list = useQuery({ queryKey: keys.requisitionList(query), queryFn: () => api<RequisitionPage>(`/v1/hiring/requisitions?${query}`), retry: retryTransient });
  const data = shown(list);
  const pages = data ? Math.max(1, Math.ceil(data.total / filters.pageSize)) : 1;
  const canCreate = can(REQ_CREATE);

  const filtered = filters.state || filters.departmentId || filters.search;
  return (
    <Section
      title="Requisition register"
      actions={
        canCreate && me?.employeeId ? (
          <Button asChild size="sm">
            <Link to={PATHS.newRequisition}>New requisition</Link>
          </Button>
        ) : undefined
      }
    >
      {canCreate && me && !me.employeeId && <Hint>A requisition is raised by an employee; this account is not linked to an employee record, so it cannot raise one.</Hint>}
      <FilterBar>
        <FormField>
          State
          <NativeSelect value={filters.state} onChange={(e) => update({ state: e.target.value || null, page: null })}>
            <option value="">All states</option>
            {REQUISITION_STATES.map((s) => (
              <option key={s} value={s}>
                {readable(s)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        {canOrg && (
          <FormField>
            Department
            <NativeSelect value={filters.departmentId} onChange={(e) => update({ department: e.target.value || null, page: null })}>
              <option value="">All departments</option>
              {(departments.data?.items ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.code})
                </option>
              ))}
            </NativeSelect>
          </FormField>
        )}
        <FormField>
          Search
          <Input type="search" value={typed} maxLength={100} placeholder="Reference or position title" onChange={(e) => setTyped(e.target.value)} />
        </FormField>
        <FormField>
          Rows per page
          <NativeSelect value={String(filters.pageSize)} onChange={(e) => update({ pageSize: e.target.value === '25' ? null : e.target.value, page: null })}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </FilterBar>
      {list.isPending && <LoadingLine>Loading requisitions…</LoadingLine>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot view requisitions.</NotPermitted> : <ErrorNote error={list.error} />}
      {data && data.items.length === 0 && data.total > 0 && (
        <Hint>
          This page is past the end of the list.{' '}
          <Button type="button" variant="link" size="inline" onClick={() => update({ page: null })}>
            Go to the first page
          </Button>
        </Hint>
      )}
      {data && data.total === 0 && <Empty>{filtered ? 'No requisitions match these filters.' : 'No requisitions in the selected role’s scope yet.'}</Empty>}
      {data && data.items.length > 0 && (
        <>
          <Table aria-label="Requisitions">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Reference</TableHead>
                <TableHead scope="col">Position</TableHead>
                <TableHead scope="col">Department</TableHead>
                <TableHead scope="col">Location</TableHead>
                <TableHead scope="col">Designation</TableHead>
                <TableHead scope="col">Vacancies</TableHead>
                <TableHead scope="col">Filled</TableHead>
                <TableHead scope="col">Target date</TableHead>
                <TableHead scope="col">Requester</TableHead>
                <TableHead scope="col">Hiring manager</TableHead>
                <TableHead scope="col">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link to={PATHS.requisition(r.id)}>{r.code}</Link>
                  </TableCell>
                  <TableCell>{r.title}</TableCell>
                  <TableCell>{r.department.name}</TableCell>
                  <TableCell>{r.location.name}</TableCell>
                  <TableCell>{r.designation.name}</TableCell>
                  <TableCell>{r.vacancies}</TableCell>
                  <TableCell>{r.filled}</TableCell>
                  <TableCell>{formatDate(r.targetDate)}</TableCell>
                  <TableCell>{personLabel(r.requester)}</TableCell>
                  <TableCell>{personLabel(r.hiringManager)}</TableCell>
                  <TableCell>
                    <StateBadge state={r.state} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PagerRow>
            <PagerButton disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 <= 1 ? null : String(filters.page - 1) })}>
              Previous
            </PagerButton>
            <PagerCount>
              Page {Math.min(filters.page, pages)} of {pages} · {data.total} requisitions
            </PagerCount>
            <PagerButton disabled={filters.page >= pages} onClick={() => update({ page: String(filters.page + 1) })}>
              Next
            </PagerButton>
          </PagerRow>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: a new requisition (the caller's own draft)
// ---------------------------------------------------------------------------------------------------------

export function NewRequisitionScreen() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (body: RequisitionInput) => api<RequisitionDetail>('/v1/hiring/requisitions', { body }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: keys.requisitions });
      navigate(PATHS.requisition(created.id), { state: { notice: `Draft ${created.code} saved. Check its budget, then submit it for approval.` } });
    },
  });
  const formRef = useRef<HTMLFormElement>(null);
  let body: ReactNode;
  if (!can(REQ_CREATE)) body = <NotPermitted>The selected role cannot raise requisitions.</NotPermitted>;
  else if (!me) body = <LoadingLine>Loading your role…</LoadingLine>;
  else if (!me.employeeId) body = <Hint>A requisition is raised by an employee; this account is not linked to an employee record, so it cannot raise one.</Hint>;
  else
    body = (
      <>
        <Hint>The draft is yours until you submit it: your direct manager validates it, then an HR Administrator approves its budget and headcount.</Hint>
        <RequisitionForm initial={null} busy={create.isPending} submitLabel="Save draft" onSubmit={(input) => create.mutate(input)} formRef={formRef} />
        <Refusal error={create.error} action="create" />
      </>
    );
  return (
    <>
      <BackLink to={PATHS.requisitions}>Back to requisitions</BackLink>
      <h1>New requisition</h1>
      {/* The form's groups as steps, above its card so they stay in view while the form scrolls; shown once the form is. */}
      <FormProgress form={formRef} label="New requisition" />
      <Section title="Requisition details">{body}</Section>
    </>
  );
}

