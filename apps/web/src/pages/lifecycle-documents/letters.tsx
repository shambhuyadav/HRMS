// Letters (FR-017, FR-018, FR-055): find an employee, their stored letters, processes and restricted notes.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, download, type EmployeeHit, formatDate, idempotencyKey, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, LIST_PAGE_SIZE, NotPermitted, Pager, Section, StateBadge } from '../../ui';
import { DOWNLOAD_WORDS, Refusal, SEND_WORDS } from './refusals';
import { DELIVERY_LABEL, EMPLOYEE_LIST, EMPLOYEE_PAGE_SIZE, EMPLOYEE_READ, enc, labelOf, LETTER_GENERATE, LETTER_READ, LETTER_SEND, LoadProblem, NOTE_KIND_LABEL, NOTE_READ, type Paged, pagedUrl, PATHS, PROCESS_READ, SCROLL, SR_ONLY, TEMPLATE_READ, totalOf, useKeys, UserRef, UUID, when } from './shared';
import type { Delivery, LetterOutput, NoteItem, ProcessSummary } from './types';

// =========================================================================================================
// Letters (FR-017, FR-018, FR-055): find an employee, their stored letters, processes and restricted notes
// =========================================================================================================
export function LettersScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Letters</h1>
      <p className="hint">
        A letter is prepared for one of an employee’s processes: preview it (nothing is stored or sent), then generate the final letter. The final letter is stored as
        a confidential file and downloaded for manual delivery; sending letters is not available.
        {can(TEMPLATE_READ) && (
          <>
            {' '}
            Templates are kept under <Link to={PATHS.templates}>Letter templates</Link>.
          </>
        )}
      </p>
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
      <form className="row" aria-label="Find an employee" onSubmit={submit}>
        <label className="inline">
          Employee name, code or work email{' '}
          <input type="search" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit">Search</button>
      </form>
      {term !== '' && hits.isPending && <p className="hint">Searching…</p>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {hits.data && hits.data.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {hits.data && hits.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Employees found">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span style={SR_ONLY}>Letters</span>
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
                    <Link to={PATHS.employeeLetters(e.id)} aria-label={`Letters of ${e.displayName} (${e.employeeCode})`}>
                      Letters
                    </Link>
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
      <p className="row">
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
      <p className="hint">
        Final letters exactly as generated, newest first, each with the template revision it was made from and who generated it. Each is a confidential file. Sending
        delivers it to the employee’s own self-service with an in-app notice (never an e-mail attachment); it can also be downloaded for delivery by hand.
      </p>
      {outputs.isPending && <p className="hint loading">Loading the stored letters…</p>}
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
      <button
        type="button"
        className="secondary"
        disabled={send.isPending}
        onClick={() => {
          if (window.confirm('Deliver this letter to the employee’s own self-service? The employee it is about is the only recipient.')) send.mutate();
        }}
      >
        Send to self-service
      </button>
      <Refusal error={send.error} words={SEND_WORDS} />
    </>
  );
}

function OutputTable({ items, employeeId }: { items: readonly LetterOutput[]; employeeId?: string }) {
  const { can } = useSession();
  return (
    <div style={SCROLL}>
      <table aria-label="Stored letters">
        <thead>
          <tr>
            <th scope="col">Template</th>
            <th scope="col">Template revision</th>
            <th scope="col">Output number</th>
            <th scope="col">Generated</th>
            <th scope="col">Generated by</th>
            <th scope="col">Size</th>
            <th scope="col">Delivery</th>
            <th scope="col">
              <span style={SR_ONLY}>Download</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <td>{o.templateCode}</td>
              <td>{o.templateRevision}</td>
              <td>{o.outputNumber}</td>
              <td>
                <time dateTime={o.generatedAt}>{when(o.generatedAt)}</time>
              </td>
              <td>
                <UserRef userId={o.generatedBy} />
              </td>
              <td>{o.byteSize} bytes</td>
              <td>{labelOf(DELIVERY_LABEL, o.deliveryState)}</td>
              <td>
                <OutputDownload output={o} />
                {employeeId && can(LETTER_SEND) && <SendLetter output={o} employeeId={employeeId} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The stored letter's exact content; the server re-checks the grant and scope and records the read. */
export function OutputDownload({ output: o }: { output: LetterOutput }) {
  const open = useMutation({ mutationFn: () => download(`/v1/letter-outputs/${enc(o.id)}/content`) });
  return (
    <>
      <button type="button" className="link" disabled={open.isPending} aria-label={`Download ${o.templateCode} letter ${o.outputNumber}`} onClick={() => open.mutate()}>
        Download
      </button>
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
      <p className="hint">
        Choose the process the letter belongs to. Exit placeholders (resignation date, approved last working date) come from an approved exit only, never from a
        proposal.
      </p>
      {processes.isPending && <p className="hint loading">Loading the employee’s processes…</p>}
      <LoadProblem error={processes.error} forbidden="The selected role cannot list this employee’s processes." missing="This employee is not in the selected role’s scope." />
      {processes.data && items.length === 0 && <Empty>This employee has no processes yet, so no letter can be prepared.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Processes">
            <thead>
              <tr>
                <th scope="col">Process</th>
                <th scope="col">State</th>
                <th scope="col">Effective date</th>
                <th scope="col">
                  <span style={SR_ONLY}>Letter</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.processName} <span className="hint">{p.processCode}</span>
                  </td>
                  <td>
                    <StateBadge state={p.state} />
                  </td>
                  <td>{formatDate(p.effectiveDate)}</td>
                  <td>
                    {p.state === 'CANCELLED' ? (
                      <span className="hint">Cancelled: no letters</span>
                    ) : (
                      <Link to={PATHS.processLetters(p.id)} aria-label={`Prepare a letter for ${p.processName}`}>
                        Prepare a letter
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <p className="hint">
        Visible only to authorised HR. Notes are never changed: a correction is a new note that supersedes the earlier one.
        {can(PROCESS_READ) && (
          <>
            {' '}
            Notes are added on the employee’s <Link to={PATHS.employeeLifecycle(employeeId)}>processes and exit</Link> screen.
          </>
        )}
      </p>
      {notes.isPending && <p className="hint loading">Loading the restricted notes…</p>}
      <LoadProblem error={notes.error} forbidden="The selected role cannot read restricted HR notes." missing="This employee is not in the selected role’s scope." />
      {notes.data && items.length === 0 && <Empty>No restricted notes or warnings are recorded for this employee.</Empty>}
      {items.length > 0 && (
        <ul className="tasks" aria-label="Restricted notes">
          {items.map((n) => (
            <li key={n.id}>
              <div>
                <strong>{labelOf(NOTE_KIND_LABEL, n.kind)}</strong> <span className="hint">recorded {when(n.createdAt)}</span>
                {n.supersededByNoteId && <span className="hint"> · superseded by a later note</span>}
                {n.supersedesNoteId && <span className="hint"> · corrects an earlier note</span>}
                {n.processId && <span className="hint"> · linked to a process</span>}
                {n.exitCaseId && <span className="hint"> · linked to an exit</span>}
              </div>
              {typeof n.body === 'string' && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{n.body}</p>}
            </li>
          ))}
        </ul>
      )}
      {notes.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(notes.data)} onPage={setPage} label="Note pages" noun="note" />}
    </Section>
  );
}

