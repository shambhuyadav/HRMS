// Employee processes (FR-016): the screen, the employee finder, an employee's lifecycle page, resignation entry, start.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, type EmployeeHit, formatDate, plural, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, Notice, NotPermitted, Pager, Section, StateBadge } from '../../ui';
import { VerifiedEvidencePicker } from '../exit-finance';
import { EnterSeparationForm } from '../separation-entry';
import { ExitTable } from './exits';
import { ProcessTaskQueue } from './queues';
import { Refusal } from './refusals';
import { RestrictedNotes } from './restricted-notes';
import { CODE, EMPLOYEE_LIST, EMPLOYEE_PAGE_SIZE, EMPLOYEE_READ, EXIT_MANAGE, EXIT_READ, EXIT_TYPE, FIELDS, ISO_DATE, type Paged, pagedUrl, PATHS, Problem, PROCESS_MANAGE, PROCESS_READ, QueryProblem, RoleReady, shown, statusLabel, TEMPLATE_READ, totalOf, typeLabel, useKeys, UUID } from './shared';
import type { ExitCase, ProcessDetail, ProcessSummary, TemplateSummary } from './types';

// ---------------------------------------------------------------------------------------------------------
// Screens: employee processes (FR-016)
// ---------------------------------------------------------------------------------------------------------
export function ProcessesScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Employee processes</h1>
      <RoleReady>
        <ProcessTaskQueue />
        {can(EMPLOYEE_LIST) ? (
          <EmployeeFinder />
        ) : can(PROCESS_MANAGE) ? (
          <Section title="Find an employee">
            <NotPermitted>The selected role cannot search employees. Open an employee’s processes from a task or an exit case.</NotPermitted>
          </Section>
        ) : null}
      </RoleReady>
    </>
  );
}

function EmployeeFinder() {
  const keys = useKeys();
  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const results = useQuery({
    enabled: term !== null,
    queryKey: keys.employeeSearch(term ?? ''),
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term ?? '', page: '1', pageSize: String(EMPLOYEE_PAGE_SIZE) }).toString()}`),
    retry: retryTransient,
  });
  const data = term === null ? undefined : shown(results);
  return (
    <Section title="Find an employee">
      <FormGrid
        role="search"
        aria-label="Find an employee"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(typed.trim());
        }}
      >
        <FormField>
          Name or employee code
          <Input value={typed} maxLength={100} onChange={(e) => setTyped(e.target.value)} />
        </FormField>
        <Button type="submit">Search</Button>
      </FormGrid>
      {term !== null && results.isPending && <LoadingLine>Searching…</LoadingLine>}
      {term !== null && <QueryProblem error={results.error} forbidden="The selected role cannot search employees." />}
      {data && data.items.length === 0 && <Empty>No employee in the selected role’s scope matches.</Empty>}
      {data && data.items.length > 0 && (
        <>
          <Table aria-label="Matching employees">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Employee</TableHead>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link to={PATHS.employee(e.id)}>{e.displayName}</Link>
                  </TableCell>
                  <TableCell>{e.employeeCode}</TableCell>
                  <TableCell>{statusLabel(e.status)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {data.total > data.items.length && (
            <Hint>
              Showing the first {data.items.length} of {data.total} matches; refine the search to narrow them.
            </Hint>
          )}
        </>
      )}
    </Section>
  );
}

export function EmployeeLifecycleScreen() {
  const { id = '' } = useParams();
  return (
    <>
      <BackLink to={PATHS.processes}>← Employee processes</BackLink>
      {UUID.test(id) ? (
        <RoleReady>
          <EmployeeLifecycle key={id} employeeId={id} />
        </RoleReady>
      ) : (
        <Empty>This employee does not exist.</Empty>
      )}
    </>
  );
}

/** One employee's processes, exits and restricted notes, with starting a process. */
function EmployeeLifecycle({ employeeId }: { employeeId: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const own = me?.employeeId === employeeId;
  const canReadProcesses = can(PROCESS_READ);
  const canReadExits = can(EXIT_READ);
  const employee = useQuery({
    enabled: can(EMPLOYEE_READ),
    queryKey: keys.employee(employeeId),
    queryFn: () => api<EmployeeHit>(`/v1/employees/${employeeId}`),
    retry: retryTransient,
  });
  const [processPage, setProcessPage] = useState(1);
  const [exitPage, setExitPage] = useState(1);
  const processes = useQuery({
    enabled: canReadProcesses,
    queryKey: [...keys.employeeProcesses(employeeId), processPage],
    queryFn: () => api<Paged<ProcessSummary>>(pagedUrl(`/v1/employees/${employeeId}/processes`, processPage)),
    retry: retryTransient,
  });
  const exits = useQuery({
    enabled: canReadExits,
    queryKey: [...keys.employeeExits(employeeId), exitPage],
    queryFn: () => api<Paged<ExitCase>>(pagedUrl(`/v1/employees/${employeeId}/exit-cases`, exitPage)),
    retry: retryTransient,
  });
  const person = shown(employee);
  const processData = canReadProcesses ? shown(processes) : undefined;
  const exitData = canReadExits ? shown(exits) : undefined;
  const processList = processData?.items;
  const exitList = exitData?.items;
  const firstExit = exitList?.[0];
  const name = person ? `${person.displayName} (${person.employeeCode})` : firstExit ? `${firstExit.employeeName} (${firstExit.employeeCode})` : 'Employee';
  return (
    <>
      <h1>{name}: processes and exit</h1>
      {own && <Hint>This is your own record: processes, exits and notes about you are handled by another HR user.</Hint>}
      <Section title="Processes">
        {!canReadProcesses ? (
          <NotPermitted>The selected role cannot view employee processes.</NotPermitted>
        ) : (
          <>
            {processes.isPending && <LoadingLine>Loading the processes…</LoadingLine>}
            <QueryProblem error={processes.error} forbidden="The selected role cannot view employee processes." missing="This employee is not in the selected role’s scope." />
            {processList && processList.length === 0 && <Empty>No processes for this employee yet.</Empty>}
            {processList && processList.length > 0 && (
              <Table aria-label="Processes">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Process</TableHead>
                    <TableHead scope="col">Type</TableHead>
                    <TableHead scope="col">Revision</TableHead>
                    <TableHead scope="col">State</TableHead>
                    <TableHead scope="col">Effective date</TableHead>
                    <TableHead scope="col">Open tasks</TableHead>
                    <TableHead scope="col">Required still open</TableHead>
                    <TableHead scope="col">Overdue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {processList.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <Link to={PATHS.process(p.id)}>
                          {p.processName} ({p.processCode})
                        </Link>
                      </TableCell>
                      <TableCell>{typeLabel(p.processType)}</TableCell>
                      <TableCell>{p.revision}</TableCell>
                      <TableCell>
                        <StateBadge state={p.state} />
                      </TableCell>
                      <TableCell>{formatDate(p.effectiveDate)}</TableCell>
                      <TableCell>{`${p.openTasks} of ${p.taskCount}`}</TableCell>
                      <TableCell>{p.requiredOpen}</TableCell>
                      <TableCell>{p.overdueTasks > 0 ? <Badge tone="bad">{`${p.overdueTasks} overdue`}</Badge> : '0'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {processData && <Pager page={processPage} pageSize={LIST_PAGE_SIZE} total={totalOf(processData)} onPage={setProcessPage} label="Process pages" noun="process" plural="processes" />}
          </>
        )}
      </Section>
      {can(PROCESS_MANAGE) && !own && <StartProcessForm employeeId={employeeId} exits={exitList} />}
      {can(EXIT_MANAGE) && !own && <EnterResignationForm employeeId={employeeId} />}
      {can(EXIT_MANAGE) && !own && <EnterSeparationForm employeeId={employeeId} exitsKey={keys.exits} />}
      {canReadExits && (
        <Section title="Exit cases">
          {exits.isPending && <LoadingLine>Loading the exit cases…</LoadingLine>}
          <QueryProblem error={exits.error} forbidden="The selected role cannot view exit cases." missing="This employee is not in the selected role’s scope." />
          {exitList && exitList.length === 0 && <Empty>No exit cases for this employee.</Empty>}
          {exitList && exitList.length > 0 && <ExitTable exits={exitList} label="Exit cases of the employee" withEmployee={false} />}
          {exitData && <Pager page={exitPage} pageSize={LIST_PAGE_SIZE} total={totalOf(exitData)} onPage={setExitPage} label="Exit case pages" noun="exit case" />}
        </Section>
      )}
      <RestrictedNotes employeeId={employeeId} own={own} processes={processList ?? []} exits={exitList ?? []} />
    </>
  );
}

/** Refusals of an HR-entered resignation (I-81 item 3), in plain words. */
const ENTER_WORDS: Record<string, string> = {
  OPEN_EXIT_EXISTS: 'The employee already has an open resignation.',
  EMPLOYEE_NOT_ACTIVE: 'Only an active employee can resign.',
  INVALID_LAST_WORKING_DATE: 'The proposed last working date must be a valid date from today.',
  EVIDENCE_NOT_VERIFIED: 'The resignation letter must be released by the malware scan and verified by someone independent first.',
  INVALID_EVIDENCE: 'The evidence must be a document of this employee.',
  SELF_ACTION_NOT_ALLOWED: 'You cannot enter a resignation on your own record.',
};

/**
 * FR-051 (I-81 item 3): a resignation the employee gave outside the system (a letter or e-mail), entered by HR with its reference and
 * the verified document. It follows the same route as the employee's own; whoever enters it never recommends or approves it.
 */
function EnterResignationForm({ employeeId }: { employeeId: string }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const [doc, setDoc] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const enter = useMutation({
    mutationFn: () => api<{ exitCaseId: string }>(`/v1/employees/${employeeId}/resignation`, { body: { proposedLastWorkingDate: date, evidenceReference: reference.trim(), evidenceDocumentIds: [doc] } }),
    onSuccess: () => {
      setDate('');
      setReference('');
      setDoc(null);
      void qc.invalidateQueries({ queryKey: keys.exits });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (enter.isPending) return;
    if (!ISO_DATE.test(date) || !reference.trim() || !doc) return setProblem('Give the proposed last working date, the reference of the resignation received and its verified document.');
    setProblem(null);
    enter.mutate();
  };
  const refusal = enter.error instanceof ApiError ? ENTER_WORDS[enter.error.code] : undefined;
  return (
    <Section title="Enter a resignation received outside the system">
      <Hint>For a resignation the employee handed in by letter or e-mail. It follows the employee’s own route; you will not recommend or approve it.</Hint>
      <FormGrid onSubmit={submit} aria-label="Enter a resignation">
        <FormField>
          Proposed last working date
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </FormField>
        <FormField>
          Reference of the resignation received
          <Input value={reference} maxLength={500} onChange={(e) => setReference(e.target.value)} />
        </FormField>
        <VerifiedEvidencePicker employeeId={employeeId} chosen={doc} onChange={setDoc} legend="The resignation letter or e-mail (released and verified)" />
        <ButtonRow>
          <Button type="submit" disabled={enter.isPending}>
            Enter the resignation
          </Button>
        </ButtonRow>
      </FormGrid>
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      {refusal ? <Notice notice={{ text: refusal, ok: false }} /> : <ErrorNote error={enter.error} />}
      {enter.isSuccess && <Notice notice={{ text: 'The resignation is entered and waits for the manager’s recommendation.', ok: true }} />}
    </Section>
  );
}

function StartProcessForm({ employeeId, exits }: { employeeId: string; exits: ExitCase[] | undefined }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canListTemplates = can(TEMPLATE_READ);
  const templates = useQuery({
    enabled: canListTemplates,
    queryKey: keys.templateList,
    queryFn: () => api<{ items: TemplateSummary[] }>('/v1/lifecycle-processes'),
    retry: retryTransient,
  });
  const listed = shown(templates);
  const startable = (listed?.items ?? []).filter((t) => t.active && t.publishedRevision !== null);
  const [code, setCode] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [exitCaseId, setExitCaseId] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState<ProcessDetail | null>(null);
  const chosen = startable.find((t) => t.code === code) ?? null;
  // Known from the template list; a role that cannot list templates types the code and picks the exit case itself.
  const takesExit = canListTemplates ? chosen?.processType === EXIT_TYPE : true;
  const clearable = (exits ?? []).filter((x) => (x.state === 'APPROVED' || x.state === 'SEPARATED') && !x.released);
  const start = useMutation({
    mutationFn: (body: { processCode: string; effectiveDate?: string; exitCaseId?: string; ownerUserId?: string }) =>
      api<ProcessDetail>(`/v1/employees/${employeeId}/processes`, { body }),
    onSuccess: (p) => {
      setCode('');
      setEffectiveDate('');
      setExitCaseId('');
      setOwnerUserId('');
      setStarted(p);
      void qc.invalidateQueries({ queryKey: keys.processes });
      void qc.invalidateQueries({ queryKey: keys.exits });
    },
    // A clearance checklist started meanwhile, or an exit that moved on: the exits offered here reload.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void qc.invalidateQueries({ queryKey: keys.exits });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (start.isPending) return;
    const processCode = code.trim();
    const owner = ownerUserId.trim();
    let issue: string | null = null;
    if (!CODE.test(processCode)) issue = canListTemplates ? 'Choose the process template.' : 'Enter the template code.';
    else if (canListTemplates && chosen?.processType === EXIT_TYPE && !exitCaseId) issue = 'Choose the approved exit this clearance checklist belongs to.';
    else if (effectiveDate && !ISO_DATE.test(effectiveDate)) issue = 'Enter a valid effective date.';
    else if (owner && !UUID.test(owner)) issue = 'Enter the process owner’s user ID, or leave it empty to own the process yourself.';
    setProblem(issue);
    setStarted(null);
    if (issue) {
      start.reset();
      return;
    }
    start.mutate({
      processCode,
      ...(effectiveDate ? { effectiveDate } : {}),
      ...(takesExit && exitCaseId ? { exitCaseId } : {}),
      ...(owner ? { ownerUserId: owner } : {}),
    });
  };
  return (
    <Section title="Start a process">
      <form aria-label="Start a process" className="stack" onSubmit={submit}>
        <div className={FIELDS}>
          {canListTemplates ? (
            <FormField>
              Process template
              <NativeSelect
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setExitCaseId('');
                }}
              >
                <option value="">Choose a template…</option>
                {startable.map((t) => (
                  <option key={t.id} value={t.code}>
                    {`${t.name} (${t.code}) · ${typeLabel(t.processType)} · revision ${t.publishedRevision}`}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          ) : (
            <FormField>
              Template code
              <Input value={code} maxLength={40} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            </FormField>
          )}
          <FormField>
            Effective date (leave empty for today)
            <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </FormField>
          {takesExit && (
            <FormField>
              {canListTemplates ? 'Exit case' : 'Exit case (exit clearance templates only)'}
              <NativeSelect value={exitCaseId} onChange={(e) => setExitCaseId(e.target.value)}>
                <option value="">{canListTemplates ? 'Choose the exit…' : 'None'}</option>
                {clearable.map((x) => (
                  <option key={x.id} value={x.id}>
                    {`Resigned ${formatDate(x.requestDate)}, last working date ${formatDate(x.lastWorkingDate)} (${readable(x.state).toLowerCase()})`}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          )}
          <FormField>
            Process owner’s user ID (leave empty to own it yourself)
            <Input value={ownerUserId} maxLength={36} onChange={(e) => setOwnerUserId(e.target.value)} />
          </FormField>
        </div>
        {canListTemplates && listed && startable.length === 0 && (
          <Hint className="m-0">
            No active template has a published revision yet. <Link to={PATHS.templates}>Open the process templates</Link>.
          </Hint>
        )}
        {takesExit && canListTemplates && clearable.length === 0 && (
          <Hint className="m-0">This employee has no approved exit without a final release, so an exit clearance checklist cannot start.</Hint>
        )}
        <Problem text={problem} />
        <div>
          <Button type="submit" disabled={start.isPending}>
            Start process
          </Button>
        </div>
        <Refusal error={start.error} action="start" />
        {started && (
          <StatusNote tone="success" role="status">
            {`Started ${started.processName} (${started.processCode}) with ${plural(started.tasks.length, 'task')}. `}
            {can(PROCESS_READ) && <Link to={PATHS.process(started.id)}>Open the process</Link>}
          </StatusNote>
        )}
      </form>
    </Section>
  );
}
