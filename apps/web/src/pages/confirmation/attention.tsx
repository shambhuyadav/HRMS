// The attention list (FR-082 / DF11, I-36), and opening a case for an employee on probation (FR-080).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, type EmployeeHit, formatDate, isForbidden, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Section, StateBadge } from '../../ui';
import { type AttentionList, employeeSearch, ISSUE_TEXT, ISSUES, LIST_EMPLOYEES, READ, SCROLL, SR_ONLY, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// FR-080: open a case for an employee on probation (the server sets the planned due date from the policy).
// ---------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------
// FR-082 / DF11 attention list (I-36): missing policy, manager or reviewer, reported for HR review, never resolved here.
// ---------------------------------------------------------------------------------------------------------

/** `onOpenCase` is null when the selected role cannot read cases (no link to a case it could not open). */
export function AttentionPanel({ onOpenCase }: { onOpenCase: ((caseId: string) => void) | null }) {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.attention, queryFn: () => api<AttentionList>('/v1/confirmations/attention'), retry: retryTransient });
  const items = list.data?.items ?? [];
  return (
    <Section title="Needs HR attention">
      <p className="hint">
        Employees on probation in the selected role’s scope whose confirmation cannot move: no case because no policy or more than one applies, or none was opened yet; or an
        open case without a direct manager or an eligible HR reviewer. Nothing is opened, assigned or changed here.
      </p>
      {list.isPending && <p className="hint">Checking…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot see the attention list.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>No employee on probation in the selected role’s scope needs attention.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Needs HR attention">
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Joined</th>
                <th scope="col">Case</th>
                <th scope="col">What needs attention</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.employeeId}>
                  <td>
                    {item.employeeName} <span className="hint">{item.employeeCode}</span>
                  </td>
                  <td>{formatDate(item.joiningDate)}</td>
                  <td>
                    {item.caseId ? (
                      <>
                        <StateBadge state={item.state} />
                        {onOpenCase && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="link"
                              aria-label={`View case of ${item.employeeName} (${item.employeeCode}) from the attention list`}
                              onClick={() => onOpenCase(item.caseId!)}
                            >
                              View case
                            </button>
                          </>
                        )}
                      </>
                    ) : (
                      'No case'
                    )}
                  </td>
                  <td>
                    <ul style={ISSUES}>
                      {item.issues.map((issue) => (
                        <li key={issue}>
                          {ISSUE_TEXT[issue] ?? readable(issue)} <span className="hint">{issue}</span>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data?.truncated && (
        <p className="hint" role="note">
          The check stopped before every employee on probation was examined, so more may need attention than are listed here.
        </p>
      )}
    </Section>
  );
}

export function OpenCasePanel({ onOpened }: { onOpened: (caseId: string) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canSearch = can(LIST_EMPLOYEES);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [probationOnly, setProbationOnly] = useState(true);
  const [opened, setOpened] = useState<{ label: string; dueDate: string } | null>(null);
  const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const hits = useQuery({
    queryKey: keys.employees(term, probationOnly),
    enabled: canSearch && term !== '',
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${employeeSearch(term, probationOnly)}`),
    retry: retryTransient,
  });
  const open = useMutation({
    mutationFn: (employee: EmployeeHit) => api<{ caseId: string; dueDate: string }>('/v1/confirmations', { body: { employeeId: employee.id } }),
    onMutate: () => setOpened(null),
    onSuccess: (result, employee) => {
      setOpened({ label: `${employee.displayName} (${employee.employeeCode})`, dueDate: result.dueDate });
      setOpenedIds((prev) => new Set(prev).add(employee.id));
      void qc.invalidateQueries({ queryKey: keys.allCases });
      void qc.invalidateQueries({ queryKey: keys.attention });
      onOpened(result.caseId);
    },
  });
  const duplicate = open.error instanceof ApiError && open.error.code === 'DUPLICATE';

  return (
    <Section title="Open a confirmation case">
      <p className="hint">The planned due date comes from the confirmation policy that applies on the employee’s start date.</p>
      {canSearch ? (
        <>
          <div className="row">
            <label className="inline">
              Find employee{' '}
              <input type="search" value={search} maxLength={100} placeholder="Name, code or work email" onChange={(e) => setSearch(e.target.value)} />
            </label>
            <label className="inline check">
              <input type="checkbox" checked={probationOnly} onChange={(e) => setProbationOnly(e.target.checked)} /> Only employees on probation
            </label>
          </div>
          {term === '' && <p className="hint">Type a name, employee code or work email to find the employee.</p>}
          {term !== '' && hits.isPending && <p className="hint">Searching…</p>}
          {isForbidden(hits.error) ? <NotPermitted>The selected role cannot search employees.</NotPermitted> : <ErrorNote error={hits.error} />}
          {hits.data && hits.data.items.length === 0 && <Empty>{probationOnly ? `No employees on probation match “${term}”.` : `No employees match “${term}”.`}</Empty>}
          {hits.data && hits.data.items.length > 0 && (
            <div style={SCROLL}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span style={SR_ONLY}>Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {hits.data.items.map((e) => (
                    <tr key={e.id}>
                      <td>{e.employeeCode}</td>
                      <td>{e.displayName}</td>
                      <td>
                        <StateBadge state={e.status} />
                      </td>
                      <td>
                        {openedIds.has(e.id) ? (
                          <span className="ok">Case opened</span>
                        ) : (
                          <button type="button" disabled={open.isPending} aria-label={`Open case for ${e.displayName} (${e.employeeCode})`} onClick={() => open.mutate(e)}>
                            Open case
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hits.data.total > hits.data.items.length && (
                <p className="hint">
                  Showing the first {hits.data.items.length} of {hits.data.total}; refine the search to narrow it down.
                </p>
              )}
            </div>
          )}
        </>
      ) : (
        <NotPermitted>The selected role cannot search employees, so it cannot open a case from here.</NotPermitted>
      )}
      {opened && (
        <p className="ok" role="status">
          Case opened for {opened.label}; planned due date {formatDate(opened.dueDate)}.
        </p>
      )}
      <ErrorNote error={open.error} />
      {duplicate && <p className="hint">This employee already has an open or pending confirmation case{can(READ) ? '; find it in the list above' : ''}.</p>}
    </Section>
  );
}
