// One candidate: the operational record, its duplicate flags, its applications and a new one, and the private contact.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Section } from '../../ui';
import { CandidateDocuments } from './candidate-documents';
import { CANDIDATE_FIELDS, CandidateFields, candidatePatch, candidateProblem, candidateValues, type CandidateValues } from './candidates';
import { FlagList } from './duplicates';
import { APPLY_WORDS, CANDIDATE_WORDS, CONTACT_WORDS, LoadProblem, Refusal } from './refusals';
import { APPLICATION_MANAGE, APPLICATION_READ, BASIS_LABEL, CANDIDATE_MANAGE, CANDIDATE_READ, CandidateStateBadge, CONSENT_LABEL, CONTACT_MANAGE, CONTACT_READ, Denied, DOCUMENT_READ, DOCUMENT_UPLOAD, Done, enc, GROUP, H3, labelOf, LIST, Missing, Notice, PAGE_SIZE, PATHS, Problem, REQUISITION_READ, SCROLL, SR_ONLY, StageBadge, useKeys, useRefresh, UUID } from './shared';
import type { ApplicationView, CandidateView, Contact, ContactSaved, RequisitionPage, RequisitionView } from './types';
import { useActiveVendors } from './vendors';

// ---------------------------------------------------------------------------------------------------------
// One candidate: the operational record, its duplicate flags and applications; private contact and documents for
// eligible Admin assignments only
// ---------------------------------------------------------------------------------------------------------

export function CandidateScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(CANDIDATE_READ)) return <Denied title="Candidate">The selected role cannot view the candidate register.</Denied>;
  if (!UUID.test(id)) return <Missing title="Candidate">This candidate is not available in the selected role’s scope.</Missing>;
  return <CandidateDetail key={id} id={id} />;
}

function CandidateDetail({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [flagNotice, setFlagNotice] = useState<string | null>(null);
  const detail = useQuery({ queryKey: keys.candidate(id), queryFn: () => api<CandidateView>(`/v1/hiring/candidates/${enc(id)}`), retry: retryTransient });
  const c = detail.data;
  const reloading = detail.isFetching && !detail.isPending;
  return (
    <>
      <p>
        <Link className="back-link" to={PATHS.candidates}>← Candidates</Link>
      </p>
      <h1>{c ? `${c.fullName} (${c.candidateCode})` : 'Candidate'}</h1>
      {detail.isPending && <p className="hint loading">Loading the candidate…</p>}
      <LoadProblem error={detail.error} forbidden="The selected role cannot view this candidate." missing="This candidate is not available in the selected role’s scope." />
      {c && (
        <>
          <Section title="Candidate">
            <dl className="kv">
              <Item term="Candidate code">{c.candidateCode}</Item>
              <Item term="State">
                <CandidateStateBadge state={c.state} />
              </Item>
              <Item term="Source">{c.source.label}</Item>
              {c.vendor && <Item term="Vendor">{`${c.vendor.name} (${c.vendor.code})`}</Item>}
              <Item term="Skills">{c.skills.length > 0 ? c.skills.join(', ') : '—'}</Item>
              <Item term="Consent">
                {labelOf(CONSENT_LABEL, c.consentStatus)}
                {c.consentRecordedOn ? ` on ${formatDate(c.consentRecordedOn)}` : ''}
              </Item>
              <Item term="Retain until">{c.retainUntil ? formatDate(c.retainUntil) : 'No date recorded'}</Item>
              <Item term="Private contact">{c.contactRecorded ? 'Recorded' : 'Not recorded'}</Item>
              <Item term="Registered">{formatDate(c.createdAt)}</Item>
            </dl>
            {c.state === 'DUPLICATE' && (
              <p className="hint">This record was retired as a duplicate: it takes no new applications, and its history and applications are kept as they are.</p>
            )}
          </Section>
          {can(CANDIDATE_MANAGE) && <EditCandidateForm candidate={c} busy={reloading} />}
          <Section title={`Possible duplicates (${c.duplicateFlags.length})`}>
            <p className="hint">A flag means this record shares a private email address or phone number with another record. A person reviews each flag; records are never merged.</p>
            <Notice text={flagNotice} />
            {c.duplicateFlags.length === 0 ? (
              <Empty>No likely matches are flagged for this candidate.</Empty>
            ) : (
              <FlagList flags={c.duplicateFlags} label={`Possible duplicates of ${c.candidateCode}`} onResolved={setFlagNotice} />
            )}
          </Section>
          <CandidateApplications candidate={c} />
          {(can(CONTACT_READ) || can(CONTACT_MANAGE)) && <PrivateContact candidate={c} />}
          {(can(DOCUMENT_READ) || can(DOCUMENT_UPLOAD)) && <CandidateDocuments candidate={c} />}
        </>
      )}
    </>
  );
}

/**
 * Edits start from the record and send only what the user changed. When the record changes meanwhile (a reload after a
 * conflict, for instance), untouched fields follow it and what the user typed is kept, with a note.
 */
function EditCandidateForm({ candidate: c, busy }: { candidate: CandidateView; busy: boolean }) {
  const { can } = useSession();
  const refresh = useRefresh();
  const [original, setOriginal] = useState(() => candidateValues(c));
  const [typed, setTyped] = useState(() => candidateValues(c));
  const [version, setVersion] = useState(c.version);
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<CandidateValues>) => setTyped((v) => ({ ...v, ...patch }));
  const vendors = useActiveVendors(typed.sourceCode === 'VENDOR' && can(CANDIDATE_READ));

  useEffect(() => {
    if (c.version === version) return;
    const latest = candidateValues(c);
    const touched = CANDIDATE_FIELDS.some((k) => typed[k] !== original[k]);
    const next = { ...typed };
    for (const k of CANDIDATE_FIELDS) if (typed[k] === original[k]) next[k] = latest[k];
    setTyped(next);
    setOriginal(latest);
    setVersion(c.version);
    setChangedMeanwhile(touched);
    // Only a new version of the record re-bases the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.version]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<CandidateView>(`/v1/hiring/candidates/${enc(c.id)}`, { method: 'PATCH', body }),
    onSuccess: (view) => {
      const latest = candidateValues(view);
      setOriginal(latest);
      setTyped(latest);
      setVersion(view.version);
      setChangedMeanwhile(false);
      setProblem(null);
      refresh();
    },
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending || busy) return;
    const patch = candidatePatch(original, typed);
    const missing = candidateProblem(typed) ?? (Object.keys(patch).length === 0 ? 'Nothing has changed yet.' : null);
    setProblem(missing);
    if (missing) {
      save.reset();
      return;
    }
    save.mutate({ ...patch, expectedVersion: version });
  };
  return (
    <Section title="Change the candidate">
      <form className="grid-form" aria-label="Change the candidate" onSubmit={submit} noValidate>
        <CandidateFields values={typed} set={set} vendors={vendors} currentVendor={c.vendor} showState={c.state !== 'DUPLICATE'} />
        {c.state === 'DUPLICATE' && <p className="hint wide">A retired duplicate stays retired; its other details can still be corrected.</p>}
        {changedMeanwhile && (
          <p className="hint wide" role="status">
            Someone changed this candidate meanwhile: the details above show the latest values. Your unsaved changes are kept; save again to apply them.
          </p>
        )}
        <Problem text={problem} />
        {save.error && (
          <div className="wide">
            <Refusal error={save.error} words={CANDIDATE_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={save.isPending || busy}>
            Save changes
          </button>
        </div>
        {save.isSuccess && <Done>Candidate saved.</Done>}
      </form>
    </Section>
  );
}


// ---------------------------------------------------------------------------------------------------------
// A candidate's applications, and a new application to an approved requisition
// ---------------------------------------------------------------------------------------------------------

function CandidateApplications({ candidate: c }: { candidate: CandidateView }) {
  const { can } = useSession();
  const canOpen = can(APPLICATION_READ);
  return (
    <Section title={`Applications (${c.applications.length})`}>
      <p className="hint">A candidate may apply to several requisitions; each application is decided on its own.</p>
      {c.applications.length === 0 ? (
        <Empty>No applications yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label={`Applications of ${c.candidateCode}`}>
            <thead>
              <tr>
                <th scope="col">Requisition</th>
                <th scope="col">Stage</th>
                <th scope="col">In stage since</th>
                {canOpen && (
                  <th scope="col">
                    <span style={SR_ONLY}>Application</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {c.applications.map((a) => (
                <tr key={a.applicationId}>
                  <td>
                    {canOpen ? <Link to={PATHS.requisitionApplications(a.requisitionId)}>{a.requisitionCode}</Link> : a.requisitionCode} <span className="hint">{a.title}</span>
                  </td>
                  <td>
                    <StageBadge stage={a.stage} />
                  </td>
                  <td>{formatDate(a.stageEnteredAt)}</td>
                  {canOpen && (
                    <td>
                      <Link to={PATHS.application(a.applicationId)} aria-label={`Open the application for ${a.requisitionCode}`}>
                        Open
                      </Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(APPLICATION_MANAGE) &&
        can(REQUISITION_READ) &&
        (c.state === 'ACTIVE' ? <ApplyToRequisition candidate={c} /> : <p className="hint">Only an active candidate record can apply to a requisition.</p>)}
    </Section>
  );
}

function requisitionSearchQuery(term: string): string {
  const q = new URLSearchParams({ state: 'APPROVED' });
  if (term) q.set('search', term);
  q.set('page', '1');
  q.set('pageSize', String(PAGE_SIZE));
  return q.toString();
}

function ApplyToRequisition({ candidate: c }: { candidate: CandidateView }) {
  const keys = useKeys();
  const refresh = useRefresh();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const qs = term === null ? '' : requisitionSearchQuery(term);
  const hits = useQuery({ queryKey: keys.requisitions(qs), enabled: term !== null, queryFn: () => api<RequisitionPage>(`/v1/hiring/requisitions?${qs}`), retry: retryTransient });
  const add = useMutation({
    mutationFn: (r: RequisitionView) => api<ApplicationView>(`/v1/hiring/requisitions/${enc(r.id)}/applications`, { body: { candidateId: c.id } }),
    onSuccess: () => refresh(),
    // Applied meanwhile, or the requisition or the candidate moved on: the lists are read again to show the server's state.
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const applied = new Set(c.applications.map((a) => a.requisitionId));
  return (
    <>
      <h3 style={H3}>Apply to a requisition</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(search.trim());
        }}
      >
        <label className="inline">
          Find an approved requisition
          <input type="search" maxLength={100} value={search} placeholder="Code or title" onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Search requisitions
        </button>
      </form>
      {term !== null && hits.isPending && <p className="hint">Searching…</p>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search requisitions." />
      {hits.data && hits.data.items.length === 0 && <Empty>No approved requisitions match.</Empty>}
      {hits.data && hits.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Approved requisitions">
            <thead>
              <tr>
                <th scope="col">Requisition</th>
                <th scope="col">Vacancies</th>
                <th scope="col">Target date</th>
                <th scope="col">
                  <span style={SR_ONLY}>Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {hits.data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.code} <span className="hint">{r.title}</span>
                  </td>
                  <td>{r.vacancies}</td>
                  <td>{formatDate(r.targetDate)}</td>
                  <td>
                    {applied.has(r.id) ? (
                      <span className="hint">Already applied</span>
                    ) : (
                      <button type="button" disabled={add.isPending} aria-label={`Apply to ${r.code}`} onClick={() => add.mutate(r)}>
                        Apply
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hits.data.total > hits.data.items.length && <p className="hint">Showing the first {hits.data.items.length} of {hits.data.total}; refine the search.</p>}
        </div>
      )}
      <Refusal error={add.error} words={APPLY_WORDS} />
      {add.isSuccess && (
        <p className="ok" role="status">
          Application created for {add.data.requisition.code} at the applied stage. <Link to={PATHS.application(add.data.id)}>Open the application</Link>
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Private contact (confidential): read only when asked (each read is audited); recording may raise duplicate flags
// ---------------------------------------------------------------------------------------------------------

function PrivateContact({ candidate: c }: { candidate: CandidateView }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canRead = can(CONTACT_READ);
  const [shown, setShown] = useState(false);
  const contact = useQuery({
    queryKey: keys.contact(c.id),
    enabled: canRead && shown,
    queryFn: () => api<Contact>(`/v1/hiring/candidates/${enc(c.id)}/contact`),
    // Each read is recorded: never repeated on its own, never kept once hidden.
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const hide = () => {
    setShown(false);
    qc.removeQueries({ queryKey: keys.contact(c.id) });
  };
  const data = shown ? contact.data : undefined;
  return (
    <Section title="Private contact (confidential)">
      <p>{c.contactRecorded ? 'A private contact is recorded for this candidate.' : 'No private contact is recorded for this candidate.'}</p>
      {canRead && (
        <>
          <div className="row">
            {shown ? (
              <button type="button" className="secondary" onClick={hide}>
                Hide private contact
              </button>
            ) : (
              <button type="button" className="secondary" onClick={() => setShown(true)}>
                Show private contact
              </button>
            )}
          </div>
          <p className="hint">Each look at the private contact is recorded in the audit trail.</p>
          {shown && contact.isPending && <p className="hint loading">Loading the private contact…</p>}
          {shown && <Refusal error={contact.error} words={CONTACT_WORDS} />}
          {data && (
            <dl className="kv" aria-label="Private contact">
              <Item term="Email address">{data.email ?? 'Not recorded'}</Item>
              <Item term="Phone number">{data.phone ?? 'Not recorded'}</Item>
              <Item term="Last changed">{formatDate(data.updatedAt)}</Item>
            </dl>
          )}
        </>
      )}
      {can(CONTACT_MANAGE) && <ContactForm candidate={c} onSaved={hide} />}
    </Section>
  );
}

function ContactForm({ candidate: c, onSaved }: { candidate: CandidateView; onSaved: () => void }) {
  const refresh = useRefresh();
  const id = useId();
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [removeEmail, setRemoveEmail] = useState(false);
  const [removePhone, setRemovePhone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { email?: string | null; phone?: string | null }) => api<ContactSaved>(`/v1/hiring/candidates/${enc(c.id)}/contact`, { method: 'PUT', body }),
    onSuccess: () => {
      setEmail('');
      setPhone('');
      setRemoveEmail(false);
      setRemovePhone(false);
      setProblem(null);
      // What is shown was read before the change: the next look is a new, recorded read.
      onSaved();
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const body: { email?: string | null; phone?: string | null } = {};
    if (removeEmail) body.email = null;
    else if (email.trim()) body.email = email.trim();
    if (removePhone) body.phone = null;
    else if (phone.trim()) body.phone = phone.trim();
    const missing = Object.keys(body).length === 0 ? 'Enter an email address or a phone number, or choose a recorded value to remove.' : null;
    setProblem(missing);
    if (missing) {
      save.reset();
      return;
    }
    save.mutate(body);
  };
  const saved = save.isSuccess ? save.data : undefined;
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Record the private contact
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label>
          Email address
          <input type="email" maxLength={254} value={email} disabled={removeEmail} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Phone number
          <input type="tel" maxLength={40} value={phone} disabled={removePhone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        {c.contactRecorded && (
          <fieldset className="wide" style={GROUP}>
            <legend>Remove a recorded value</legend>
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={removeEmail} onChange={(e) => setRemoveEmail(e.target.checked)} /> Remove the recorded email address
              </label>
              <label className="check">
                <input type="checkbox" checked={removePhone} onChange={(e) => setRemovePhone(e.target.checked)} /> Remove the recorded phone number
              </label>
            </div>
          </fieldset>
        )}
        <p className="hint wide">A blank field keeps what is recorded. A match with another candidate’s contact is flagged for review; records are never merged.</p>
        <Problem text={problem} />
        {save.error && (
          <div className="wide">
            <Refusal error={save.error} words={CONTACT_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={save.isPending}>
            Save private contact
          </button>
        </div>
        {saved && <ContactSavedNote saved={saved} candidateId={c.id} />}
      </form>
    </>
  );
}

const CONTACT_FIELD_LABEL: Record<string, string> = { email: 'email address', phone: 'phone number' };

function ContactSavedNote({ saved, candidateId }: { saved: ContactSaved; candidateId: string }) {
  const changed = saved.changedFields.map((f) => CONTACT_FIELD_LABEL[f] ?? f);
  return (
    <div className="wide" role="status">
      <p className="ok">{changed.length > 0 ? `Private contact saved: ${changed.join(' and ')} changed.` : 'Private contact saved: nothing changed.'}</p>
      {saved.duplicateFlags.length > 0 && (
        <>
          <p>Flagged for duplicate review (nothing was merged):</p>
          <ul style={LIST} aria-label="New duplicate flags">
            {saved.duplicateFlags.map((f) => {
              const other = f.candidate.id === candidateId ? f.matchedCandidate : f.candidate;
              return (
                <li key={f.flagId}>
                  {labelOf(BASIS_LABEL, f.basis)} as <Link to={PATHS.candidate(other.id)}>{other.fullName}</Link> ({other.candidateCode})
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

