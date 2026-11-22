// Letters (FR-017, FR-018, FR-055): find an employee, their stored letters, processes and restricted notes.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, download, type EmployeeHit, formatDate, idempotencyKey, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, LIST_PAGE_SIZE, NotPermitted, Pager, Section, StateBadge } from '../../ui';
import { DOWNLOAD_WORDS, Refusal, SEND_WORDS } from './refusals';
import { DELIVERY_LABEL, EMPLOYEE_LIST, EMPLOYEE_PAGE_SIZE, EMPLOYEE_READ, enc, labelOf, LETTER_GENERATE, LETTER_READ, LETTER_SEND, LINK_ROW, LoadProblem, NOTE_KIND_LABEL, NOTE_READ, type Paged, pagedUrl, PATHS, PROCESS_READ, TEMPLATE_READ, totalOf, useKeys, UserRef, UUID, when } from './shared';
import type { Delivery, LetterOutput, NoteItem, ProcessSummary } from './types';

// =========================================================================================================
// Letters (FR-017, FR-018, FR-055): find an employee, their stored letters, processes and restricted notes
// =========================================================================================================
export function LettersScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Letters</h1>
      <Hint>
        A letter is prepared for one of an employee’s processes: preview it (nothing is stored or sent), then generate the final letter. The final letter is stored as
        a confidential file and downloaded for manual delivery; sending letters is not available.
        {can(TEMPLATE_READ) && (
          <>
            {' '}
            Templates are kept under <Link to={PATHS.templates}>Letter templates</Link>.
          </>
        )}
      </Hint>
      <EmployeeFinder />
    </>
  );
}

function EmployeeFinder() {
  const { can } = useSession();
  const keys = useKeys();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const hits = useQuery({
    enabled: can(EMPLOYEE_LIST) && term !== '',
    queryKey: keys.employeeSearch(term),
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: String(EMPLOYEE_PAGE_SIZE) }).toString()}`),
    retry: retryTransient,
  });
  if (!can(EMPLOYEE_LIST)) {
    return (
      <Section title="Find an employee">
        <NotPermitted>The selected role cannot search employees. Open an employee’s letters from their process instead.</NotPermitted>
      </Section>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTerm(search.trim());
  };
  return (
    <Section title="Find an employee">
      {/* The search over the list it fills, drawn as a list's filters are. */}
      <FilterBar asChild>
        <form aria-label="Find an employee" onSubmit={submit}>
          <FormField>
            Employee name, code or work email{' '}
            <Input type="search" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
          </FormField>
          <Button type="submit">Search</Button>
        </form>
      </FilterBar>
      {term !== '' && hits.isPending && <Hint>Searching…</Hint>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {hits.data && hits.data.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {hits.data && hits.data.items.length > 0 && (
        <>
          <Table aria-label="Employees found">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Letters</span>
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
                    <Link to={PATHS.employeeLetters(e.id)} aria-label={`Letters of ${e.displayName} (${e.employeeCode})`}>
                      Letters
                    </Link>
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
        </>
      )}
    </Section>
  );
}

export function EmployeeLettersScreen() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) {
    return (
      <>
        <h1>Employee letters</h1>
        <Empty>This address does not name an employee.</Empty>
      </>
    );
  }
  return <EmployeeLetters key={id} employeeId={id} />;
}

function EmployeeLetters({ employeeId }: { employeeId: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const own = !!me?.employeeId && me.employeeId === employeeId;
  const employee = useQuery({
    enabled: can(EMPLOYEE_READ),
    queryKey: keys.employee(employeeId),
    queryFn: () => api<EmployeeHit>(`/v1/employees/${enc(employeeId)}`),
    retry: retryTransient,
  });
  const who = employee.data ? `${employee.data.displayName} (${employee.data.employeeCode})` : null;
  return (
    <>
      <h1>{who ? `Letters of ${who}` : 'Employee letters'}</h1>
      <p className={LINK_ROW}>
        <Link to={PATHS.letters}>Find another employee</Link>
        {can(PROCESS_READ) && <Link to={PATHS.employeeLifecycle(employeeId)}>Processes and exit of this employee</Link>}
      </p>
      {own ? (
        <Section title="Letters">
          <Empty>This is your own record. Letters and restricted notes about your own record are not available in this role.</Empty>
        </Section>
      ) : (
        <>
          <StoredLetters employeeId={employeeId} />
          {can(LETTER_GENERATE) && <ProcessesForLetters employeeId={employeeId} />}
          {can(NOTE_READ) && <RestrictedNotes employeeId={employeeId} />}
        </>
      )}
    </>
  );
}

function StoredLetters({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  if (!can(LETTER_READ)) {
    return (
      <Section title="Stored letters">
        <NotPermitted>The selected role cannot read stored letters: they need the confidential letter grant.</NotPermitted>
      </Section>
    );
  }
  return <StoredLetterList employeeId={employeeId} />;
}

function StoredLetterList({ employeeId }: { employeeId: string }) {
  const keys = useKeys();
  const [page, setPage] = useState(1);
  const outputs = useQuery({
    queryKey: [...keys.outputs(employeeId), page],
    queryFn: () => api<Paged<LetterOutput>>(pagedUrl(`/v1/employees/${enc(employeeId)}/letter-outputs`, page)),
    retry: retryTransient,
  });
  const items = outputs.data?.items ?? [];
  return (
    <Section title="Stored letters">
      <Hint>
        Final letters exactly as generated, newest first, each with the template revision it was made from and who generated it. Each is a confidential file. Sending
        delivers it to the employee’s own self-service with an in-app notice (never an e-mail attachment); it can also be downloaded for delivery by hand.
      </Hint>
      {outputs.isPending && <LoadingLine>Loading the stored letters…</LoadingLine>}
      <LoadProblem error={outputs.error} forbidden="The selected role cannot read stored letters." missing="This employee is not in the selected role’s scope." />
      {outputs.data && items.length === 0 && <Empty>No letters have been generated for this employee.</Empty>}
      {items.length > 0 && <OutputTable items={items} employeeId={employeeId} />}
      {outputs.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(outputs.data)} onPage={setPage} label="Stored letter pages" noun="letter" />}
    </Section>
  );
}

/** FR-018 (I-81 item 9): in-app delivery of one stored letter to its employee, after the sender confirms the recipient. */
function SendLetter({ output, employeeId }: { output: LetterOutput; employeeId: string }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: () => api<Delivery>(`/v1/letter-outputs/${enc(output.id)}/send`, { body: { recipientEmployeeId: employeeId, idempotencyKey: idempotencyKey('letter-send') } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.outputs(employeeId) }),
  });
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={send.isPending}
        onClick={() => {
          if (window.confirm('Deliver this letter to the employee’s own self-service? The employee it is about is the only recipient.')) send.mutate();
        }}
      >
        Send to self-service
      </Button>
      <Refusal error={send.error} words={SEND_WORDS} />
    </>
  );
}

function OutputTable({ items, employeeId }: { items: readonly LetterOutput[]; employeeId?: string }) {
  const { can } = useSession();
  return (
    <Table aria-label="Stored letters">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Template</TableHead>
          <TableHead scope="col">Template revision</TableHead>
          <TableHead scope="col">Output number</TableHead>
          <TableHead scope="col">Generated</TableHead>
          <TableHead scope="col">Generated by</TableHead>
          <TableHead scope="col">Size</TableHead>
          <TableHead scope="col">Delivery</TableHead>
          <TableHead scope="col">
            <span className="sr-only">Download</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((o) => (
          <TableRow key={o.id}>
            <TableCell>{o.templateCode}</TableCell>
            <TableCell>{o.templateRevision}</TableCell>
            <TableCell>{o.outputNumber}</TableCell>
            <TableCell>
              <time dateTime={o.generatedAt}>{when(o.generatedAt)}</time>
            </TableCell>
            <TableCell>
              <UserRef userId={o.generatedBy} />
            </TableCell>
            <TableCell>{o.byteSize} bytes</TableCell>
            <TableCell>{labelOf(DELIVERY_LABEL, o.deliveryState)}</TableCell>
            {/* A refused download or delivery is said under its button, so this cell is not drawn to the buttons' width. */}
            <TableCell>
              <RowActions className="flex-wrap">
                <OutputDownload output={o} />
                {employeeId && can(LETTER_SEND) && <SendLetter output={o} employeeId={employeeId} />}
              </RowActions>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The stored letter's exact content; the server re-checks the grant and scope and records the read. */
export function OutputDownload({ output: o }: { output: LetterOutput }) {
  const open = useMutation({ mutationFn: () => download(`/v1/letter-outputs/${enc(o.id)}/content`) });
  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={open.isPending} aria-label={`Download ${o.templateCode} letter ${o.outputNumber}`} onClick={() => open.mutate()}>
        Download
      </Button>
      <Refusal error={open.error} words={DOWNLOAD_WORDS} />
    </>
  );
}

function ProcessesForLetters({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  if (!can(PROCESS_READ)) {
    return (
      <Section title="Prepare a letter">
        <NotPermitted>The selected role cannot list this employee’s processes, and a letter is prepared for one of them.</NotPermitted>
      </Section>
    );
  }
  return <ProcessList employeeId={employeeId} />;
}

function ProcessList({ employeeId }: { employeeId: string }) {
  const keys = useKeys();
  const [page, setPage] = useState(1);
  const processes = useQuery({
    queryKey: [...keys.processes(employeeId), page],
    queryFn: () => api<Paged<ProcessSummary>>(pagedUrl(`/v1/employees/${enc(employeeId)}/processes`, page)),
    retry: retryTransient,
  });
  const items = processes.data?.items ?? [];
  return (
    <Section title="Prepare a letter">
      <Hint>
        Choose the process the letter belongs to. Exit placeholders (resignation date, approved last working date) come from an approved exit only, never from a
        proposal.
      </Hint>
      {processes.isPending && <LoadingLine>Loading the employee’s processes…</LoadingLine>}
      <LoadProblem error={processes.error} forbidden="The selected role cannot list this employee’s processes." missing="This employee is not in the selected role’s scope." />
      {processes.data && items.length === 0 && <Empty>This employee has no processes yet, so no letter can be prepared.</Empty>}
      {items.length > 0 && (
        <Table aria-label="Processes">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Process</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Effective date</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Letter</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  {p.processName} <Hint as="span">{p.processCode}</Hint>
                </TableCell>
                <TableCell>
                  <StateBadge state={p.state} />
                </TableCell>
                <TableCell>{formatDate(p.effectiveDate)}</TableCell>
                <RowActionsCell>
                  {p.state === 'CANCELLED' ? (
                    <Hint as="span">Cancelled: no letters</Hint>
                  ) : (
                    <Link to={PATHS.processLetters(p.id)} aria-label={`Prepare a letter for ${p.processName}`}>
                      Prepare a letter
                    </Link>
                  )}
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {processes.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(processes.data)} onPage={setPage} label="Process pages" noun="process" plural="processes" />}
    </Section>
  );
}

/** FR-018 restricted notes, read only: each shown exactly as the server returned it, its text only when returned. */
function RestrictedNotes({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [page, setPage] = useState(1);
  const notes = useQuery({
    queryKey: [...keys.notes(employeeId), page],
    queryFn: () => api<Paged<NoteItem>>(pagedUrl(`/v1/employees/${enc(employeeId)}/notes`, page)),
    retry: retryTransient,
  });
  const items = notes.data?.items ?? [];
  return (
    <Section title="Restricted HR notes and warnings">
      <Hint>
        Visible only to authorised HR. Notes are never changed: a correction is a new note that supersedes the earlier one.
        {can(PROCESS_READ) && (
          <>
            {' '}
            Notes are added on the employee’s <Link to={PATHS.employeeLifecycle(employeeId)}>processes and exit</Link> screen.
          </>
        )}
      </Hint>
      {notes.isPending && <LoadingLine>Loading the restricted notes…</LoadingLine>}
      <LoadProblem error={notes.error} forbidden="The selected role cannot read restricted HR notes." missing="This employee is not in the selected role’s scope." />
      {notes.data && items.length === 0 && <Empty>No restricted notes or warnings are recorded for this employee.</Empty>}
      {items.length > 0 && (
        <ul className="tasks" aria-label="Restricted notes">
          {items.map((n) => (
            <li key={n.id}>
              <div>
                <strong>{labelOf(NOTE_KIND_LABEL, n.kind)}</strong> <Hint as="span">recorded {when(n.createdAt)}</Hint>
                {n.supersededByNoteId && <Hint as="span"> · superseded by a later note</Hint>}
                {n.supersedesNoteId && <Hint as="span"> · corrects an earlier note</Hint>}
                {n.processId && <Hint as="span"> · linked to a process</Hint>}
                {n.exitCaseId && <Hint as="span"> · linked to an exit</Hint>}
              </div>
              {typeof n.body === 'string' && <p className="m-0 whitespace-pre-wrap">{n.body}</p>}
            </li>
          ))}
        </ul>
      )}
      {notes.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(notes.data)} onPage={setPage} label="Note pages" noun="note" />}
    </Section>
  );
}

