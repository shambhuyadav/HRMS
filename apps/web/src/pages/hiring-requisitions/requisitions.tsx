// The requisitions screen (register and decision queues) and the new requisition screen.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, formatDate, isForbidden, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Section, StateBadge } from '../../ui';
import { useOrgList } from './lookups';
import { Refusal } from './refusals';
import { RequisitionForm } from './requisition-form';
import { RequisitionApprovalQueue, RequisitionValidationQueue } from './requisition-queues';
import { FLUSH, ORG_READ, PAGE_SIZES, PATHS, personLabel, REQ_CREATE, REQ_READ, REQUISITION_STATES, type RequisitionDetail, type RequisitionInput, type RequisitionPage, SCROLL, shown, useKeys, UUID } from './shared';

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

  return (
    <Section
      title="Requisition register"
      actions={
        canCreate && me?.employeeId ? (
          <Link to={PATHS.newRequisition} className="primary">
            New requisition
          </Link>
        ) : undefined
      }
    >
      {canCreate && me && !me.employeeId && <p className="hint">A requisition is raised by an employee; this account is not linked to an employee record, so it cannot raise one.</p>}
      <div className="row">
        <label className="inline">
          State
          <select value={filters.state} onChange={(e) => update({ state: e.target.value || null, page: null })}>
            <option value="">All states</option>
            {REQUISITION_STATES.map((s) => (
              <option key={s} value={s}>
                {readable(s)}
              </option>
            ))}
          </select>
        </label>
        {canOrg && (
          <label className="inline">
            Department
            <select value={filters.departmentId} onChange={(e) => update({ department: e.target.value || null, page: null })}>
              <option value="">All departments</option>
              {(departments.data?.items ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.code})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="inline">
          Search
          <input type="search" value={typed} maxLength={100} placeholder="Reference or position title" onChange={(e) => setTyped(e.target.value)} />
        </label>
        <label className="inline">
          Rows per page
          <select value={String(filters.pageSize)} onChange={(e) => update({ pageSize: e.target.value === '25' ? null : e.target.value, page: null })}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.isPending && <p className="hint loading">Loading requisitions…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot view requisitions.</NotPermitted> : <ErrorNote error={list.error} />}
      {data && data.items.length === 0 && data.total > 0 && (
        <p className="hint">
          This page is past the end of the list.{' '}
          <button type="button" className="link" onClick={() => update({ page: null })}>
            Go to the first page
          </button>
        </p>
      )}
      {data && data.total === 0 && (
        <Empty>{filters.state || filters.departmentId || filters.search ? 'No requisitions match these filters.' : 'No requisitions in the selected role’s scope yet.'}</Empty>
      )}
      {data && data.items.length > 0 && (
        <>
          <div style={SCROLL}>
            <table aria-label="Requisitions">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Position</th>
                  <th scope="col">Department</th>
                  <th scope="col">Location</th>
                  <th scope="col">Designation</th>
                  <th scope="col">Vacancies</th>
                  <th scope="col">Filled</th>
                  <th scope="col">Target date</th>
                  <th scope="col">Requester</th>
                  <th scope="col">Hiring manager</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={PATHS.requisition(r.id)}>{r.code}</Link>
                    </td>
                    <td>{r.title}</td>
                    <td>{r.department.name}</td>
                    <td>{r.location.name}</td>
                    <td>{r.designation.name}</td>
                    <td>{r.vacancies}</td>
                    <td>{r.filled}</td>
                    <td>{formatDate(r.targetDate)}</td>
                    <td>{personLabel(r.requester)}</td>
                    <td>{personLabel(r.hiringManager)}</td>
                    <td>
                      <StateBadge state={r.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button type="button" className="secondary" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 <= 1 ? null : String(filters.page - 1) })}>
              Previous
            </button>
            <span>
              Page {Math.min(filters.page, pages)} of {pages} · {data.total} requisitions
            </span>
            <button type="button" className="secondary" disabled={filters.page >= pages} onClick={() => update({ page: String(filters.page + 1) })}>
              Next
            </button>
          </div>
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
  let body: ReactNode;
  if (!can(REQ_CREATE)) body = <NotPermitted>The selected role cannot raise requisitions.</NotPermitted>;
  else if (!me) body = <p className="hint loading">Loading your role…</p>;
  else if (!me.employeeId) body = <p className="hint">A requisition is raised by an employee; this account is not linked to an employee record, so it cannot raise one.</p>;
  else
    body = (
      <>
        <p className="hint">The draft is yours until you submit it: your direct manager validates it, then an HR Administrator approves its budget and headcount.</p>
        <RequisitionForm initial={null} busy={create.isPending} submitLabel="Save draft" onSubmit={(input) => create.mutate(input)} />
        <Refusal error={create.error} action="create" />
      </>
    );
  return (
    <>
      <p style={FLUSH}>
        <Link to={PATHS.requisitions}>Back to requisitions</Link>
      </p>
      <h1>New requisition</h1>
      <Section title="Requisition details">{body}</Section>
    </>
  );
}

