// The attention list (FR-082 / DF11, I-36), and opening a case for an employee on probation (FR-080).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CheckField, FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, type EmployeeHit, formatDate, isForbidden, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Notice, Section, StateBadge } from '../../ui';
import { type AttentionList, employeeSearch, ISSUE_TEXT, LIST_EMPLOYEES, READ, useKeys } from './shared';

/** Said in place of the button once the employee's case is opened, in the success colour (the old `.ok` words). */
const OPENED_WORDS = 'text-[var(--good)]';

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
      <Hint>
        Employees on probation in the selected role’s scope whose confirmation cannot move: no case because no policy or more than one applies, or none was opened yet; or an
        open case without a direct manager or an eligible HR reviewer. Nothing is opened, assigned or changed here.
      </Hint>
      {list.isPending && <LoadingLine>Checking…</LoadingLine>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot see the attention list.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>No employee on probation in the selected role’s scope needs attention.</Empty>}
      {items.length > 0 && (
        <Table aria-label="Needs HR attention">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Joined</TableHead>
              <TableHead scope="col">Case</TableHead>
              <TableHead scope="col">What needs attention</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.employeeId}>
                <TableCell>
                  {item.employeeName} <Hint as="span">{item.employeeCode}</Hint>
                </TableCell>
                <TableCell>{formatDate(item.joiningDate)}</TableCell>
                <TableCell>
                  {item.caseId ? (
                    <>
                      <StateBadge state={item.state} />
                      {onOpenCase && (
                        <>
                          {' '}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`View case of ${item.employeeName} (${item.employeeCode}) from the attention list`}
                            onClick={() => onOpenCase(item.caseId!)}
                          >
                            View case
                          </Button>
                        </>
                      )}
                    </>
                  ) : (
                    'No case'
                  )}
                </TableCell>
                <TableCell>
                  <ul className="m-0 pl-[1.1rem]">
                    {item.issues.map((issue) => (
                      <li key={issue}>
                        {ISSUE_TEXT[issue] ?? readable(issue)} <Hint as="span">{issue}</Hint>
                      </li>
                    ))}
                  </ul>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {list.data?.truncated && <Hint role="note">The check stopped before every employee on probation was examined, so more may need attention than are listed here.</Hint>}
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
      <Hint>The planned due date comes from the confirmation policy that applies on the employee’s start date.</Hint>
      {canSearch ? (
        <>
          <FilterBar>
            <FormField>
              Find employee{' '}
              <Input type="search" value={search} maxLength={100} placeholder="Name, code or work email" onChange={(e) => setSearch(e.target.value)} />
            </FormField>
            <CheckField>
              <input type="checkbox" checked={probationOnly} onChange={(e) => setProbationOnly(e.target.checked)} /> Only employees on probation
            </CheckField>
          </FilterBar>
          {term === '' && <Hint>Type a name, employee code or work email to find the employee.</Hint>}
          {term !== '' && hits.isPending && <Hint>Searching…</Hint>}
          {isForbidden(hits.error) ? <NotPermitted>The selected role cannot search employees.</NotPermitted> : <ErrorNote error={hits.error} />}
          {hits.data && hits.data.items.length === 0 && <Empty>{probationOnly ? `No employees on probation match “${term}”.` : `No employees match “${term}”.`}</Empty>}
          {hits.data && hits.data.items.length > 0 && (
            // The table and its count read as one: the count is a line under the rows, not a note of the card.
            <div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Code</TableHead>
                    <TableHead scope="col">Name</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">
                      <span className="sr-only">Action</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hits.data.items.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{e.employeeCode}</TableCell>
                      <TableCell>{e.displayName}</TableCell>
                      <TableCell>
                        <StateBadge state={e.status} />
                      </TableCell>
                      <RowActionsCell>
                        {openedIds.has(e.id) ? (
                          <span className={OPENED_WORDS}>Case opened</span>
                        ) : (
                          <Button type="button" size="sm" disabled={open.isPending} aria-label={`Open case for ${e.displayName} (${e.employeeCode})`} onClick={() => open.mutate(e)}>
                            Open case
                          </Button>
                        )}
                      </RowActionsCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {hits.data.total > hits.data.items.length && (
                <Hint>
                  Showing the first {hits.data.items.length} of {hits.data.total}; refine the search to narrow it down.
                </Hint>
              )}
            </div>
          )}
        </>
      ) : (
        <NotPermitted>The selected role cannot search employees, so it cannot open a case from here.</NotPermitted>
      )}
      {opened && <Notice notice={{ text: `Case opened for ${opened.label}; planned due date ${formatDate(opened.dueDate)}.`, ok: true }} />}
      <ErrorNote error={open.error} />
      {duplicate && <Hint>This employee already has an open or pending confirmation case{can(READ) ? '; find it in the list above' : ''}.</Hint>}
    </Section>
  );
}
