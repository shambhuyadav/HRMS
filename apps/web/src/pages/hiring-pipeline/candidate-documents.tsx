// A candidate's CV and other documents (confidential): the list, the approved searchable CV text, and the upload.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, fileToBase64, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Item, Section } from '../../ui';
import { CV_TEXT_WORDS, DOWNLOAD_WORDS, LoadProblem, Refusal, UPLOAD_WORDS } from './refusals';
import { CANDIDATE_DOCUMENT_TYPES, CANDIDATE_READ, CONSENT_LABEL, CV_TEXT_SOURCE_LABEL, CV_TEXT_STATE_LABEL, DOCUMENT_READ, DOCUMENT_TYPE_LABEL, DOCUMENT_UPLOAD, Done, enc, H3, labelOf, MAX_CV_TEXT, MAX_UPLOAD_BYTES, Notice, PATHS, personText, Problem, ScanBadge, SCROLL, SR_ONLY, TEXTAREA, useKeys, useRefresh, useUserId } from './shared';
import type { CandidateDocument, CandidateView, CvText, CvTextApproved, DocumentUploaded } from './types';

// ---------------------------------------------------------------------------------------------------------
// CV and other candidate documents (confidential): scanned before release, released files only for download
// ---------------------------------------------------------------------------------------------------------

export function CandidateDocuments({ candidate: c }: { candidate: CandidateView }) {
  const { can } = useSession();
  const keys = useKeys();
  const canRead = can(DOCUMENT_READ);
  const docs = useQuery({
    queryKey: keys.documents(c.id),
    enabled: canRead,
    queryFn: () => api<{ items: CandidateDocument[] }>(`/v1/hiring/candidates/${enc(c.id)}/documents`),
    retry: retryTransient,
  });
  const open = useMutation({ mutationFn: (d: CandidateDocument) => download(`/v1/hiring/candidate-documents/${enc(d.id)}/content`) });
  return (
    <Section title="CV and documents (confidential)">
      <p className="hint">Every file is scanned for malware and can be opened only once the scan releases it; each opening is recorded in the audit trail.</p>
      {canRead ? (
        <>
          {docs.isPending && <p className="hint loading">Loading documents…</p>}
          <LoadProblem error={docs.error} forbidden="The selected role cannot read this candidate’s documents." missing="This candidate is not available in the selected role’s scope." />
          {docs.data && docs.data.items.length === 0 && <Empty>No documents on record.</Empty>}
          {docs.data && docs.data.items.length > 0 && <DocumentTable items={docs.data.items} showCandidate={false} busy={open.isPending} onOpen={(d) => open.mutate(d)} label="Candidate documents" />}
          <Refusal error={open.error} words={DOWNLOAD_WORDS} />
          {docs.data && <SearchableCvText documents={docs.data.items.filter((d) => d.documentType === 'CV')} />}
        </>
      ) : (
        <p className="hint">The selected role can add documents to this candidate but not read them.</p>
      )}
      {can(DOCUMENT_UPLOAD) && <UploadDocumentForm candidateId={c.id} />}
    </Section>
  );
}

export function DocumentTable({
  items,
  showCandidate,
  showMatch = false,
  busy,
  onOpen,
  label,
}: {
  items: CandidateDocument[];
  showCandidate: boolean;
  /** CV search hits: whether the hit matched the approved searchable text (never the text itself). */
  showMatch?: boolean;
  busy: boolean;
  onOpen: (d: CandidateDocument) => void;
  label: string;
}) {
  const { can } = useSession();
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            {showCandidate && <th scope="col">Candidate</th>}
            <th scope="col">Type</th>
            <th scope="col">File</th>
            <th scope="col">Uploaded</th>
            <th scope="col">Malware scan</th>
            {showMatch && <th scope="col">Approved CV text</th>}
            <th scope="col">
              <span style={SR_ONLY}>Download</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              {showCandidate && <td>{can(CANDIDATE_READ) ? <Link to={PATHS.candidate(d.candidateId)}>{d.candidateCode}</Link> : d.candidateCode}</td>}
              <td>{labelOf(DOCUMENT_TYPE_LABEL, d.documentType)}</td>
              <td>{d.fileName ?? '—'}</td>
              <td>{formatDate(d.uploadedAt)}</td>
              <td>
                <ScanBadge state={d.scanState} />
              </td>
              {showMatch && <td>{d.contentMatch ? <Badge tone="good">matched in approved CV text</Badge> : '—'}</td>}
              <td>
                {d.scanState === 'CLEAN' ? (
                  <button type="button" className="secondary" disabled={busy} aria-label={`Download ${d.fileName ?? labelOf(DOCUMENT_TYPE_LABEL, d.documentType)}`} onClick={() => onOpen(d)}>
                    Download
                  </button>
                ) : (
                  <span className="hint">{d.scanState === 'QUARANTINED' ? 'Never available' : 'Available once released'}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-013 approved searchable CV content (I-82 item 4): approved by an eligible Admin, read only when asked (audited)
// ---------------------------------------------------------------------------------------------------------

export const PRE: CSSProperties = { whiteSpace: 'pre-wrap', fontFamily: 'inherit', border: '1px solid var(--line)', borderRadius: 6, padding: '0.75rem', margin: '0.5rem 0', maxHeight: '24rem', overflowY: 'auto' };

function SearchableCvText({ documents }: { documents: CandidateDocument[] }) {
  if (documents.length === 0) return null;
  return (
    <>
      <p className="hint">
        Searchable CV text: nothing is searchable on upload. The CV search matches only text an eligible Admin approved for a released CV of a candidate whose consent is
        given, and it never shows that text. No text extraction is configured, so the Admin types or pastes the text from the CV. Each look at an approved text is
        recorded in the audit trail.
      </p>
      {documents.map((d) => (
        <CvTextPanel key={d.id} document={d} />
      ))}
    </>
  );
}

function CvTextPanel({ document: d }: { document: CandidateDocument }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const refresh = useRefresh();
  const userId = useUserId();
  const id = useId();
  const name = d.fileName ?? labelOf(DOCUMENT_TYPE_LABEL, d.documentType);
  const [shown, setShown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const text = useQuery({
    queryKey: keys.cvText(d.id),
    enabled: shown,
    queryFn: () => api<CvText>(`/v1/hiring/candidate-documents/${enc(d.id)}/searchable-text`),
    // Each read is recorded: never repeated on its own, never kept once hidden.
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const hide = () => {
    setShown(false);
    qc.removeQueries({ queryKey: keys.cvText(d.id) });
  };
  // What is shown was read before a change: the next look is a new, recorded read.
  const done = (message: string) => {
    hide();
    setNotice(message);
    refresh();
  };
  const data = shown ? text.data : undefined;
  return (
    <div role="region" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} style={H3}>
        Searchable text of {name}
      </h3>
      <div className="row">
        {shown ? (
          <button type="button" className="secondary" onClick={hide}>
            Hide searchable text
          </button>
        ) : (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setNotice(null);
              setShown(true);
            }}
          >
            Show searchable text
          </button>
        )}
      </div>
      <Notice text={notice} />
      {shown && text.isPending && <p className="hint loading">Loading the searchable text…</p>}
      {shown && <Refusal error={text.error} words={CV_TEXT_WORDS} />}
      {data && (
        <>
          <dl className="kv" aria-label={`Status of the searchable text of ${name}`}>
            <Item term="Searchable now">
              {data.searchable
                ? 'Yes: the CV search matches this approved text'
                : data.approved
                  ? 'No: the text is approved, but the candidate’s consent is no longer given or the retention date has passed'
                  : 'No: no text of this CV is approved for search'}
            </Item>
            <Item term="Candidate consent">{labelOf(CONSENT_LABEL, data.consentStatus)}</Item>
            {data.approved && (
              <>
                <Item term="Approved">{`${formatDate(data.approved.approvedAt)}${data.approved.approvedByPerson ? ` by ${personText(data.approved.approvedByPerson, userId)}` : ''}`}</Item>
                <Item term="Source">{labelOf(CV_TEXT_SOURCE_LABEL, data.approved.source)}</Item>
              </>
            )}
          </dl>
          {data.approved && (
            <pre style={PRE} aria-label={`Approved searchable text of ${name}`}>
              {data.approved.content}
            </pre>
          )}
          {data.history.length > 0 && (
            <div style={SCROLL}>
              <table aria-label={`Approvals of the searchable text of ${name}`}>
                <thead>
                  <tr>
                    <th scope="col">State</th>
                    <th scope="col">Source</th>
                    <th scope="col">Approved</th>
                    <th scope="col">Revoked</th>
                    <th scope="col">Reason for revoking</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((h) => (
                    <tr key={h.id}>
                      <td>{labelOf(CV_TEXT_STATE_LABEL, h.state)}</td>
                      <td>{labelOf(CV_TEXT_SOURCE_LABEL, h.source)}</td>
                      <td>{`${formatDate(h.approvedAt)}${h.approvedByPerson ? ` by ${personText(h.approvedByPerson, userId)}` : ''}`}</td>
                      <td>{formatDate(h.revokedAt)}</td>
                      <td>{h.revocationReason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {can(DOCUMENT_UPLOAD) && (
        <>
          <CvTextApproveForm document={d} name={name} onDone={done} />
          <CvTextRevokeForm document={d} name={name} onDone={done} />
        </>
      )}
    </div>
  );
}

/** The Admin types or pastes the text; an empty submit asks the server to extract it, which is not configured. */
function CvTextApproveForm({ document: d, name, onDone }: { document: CandidateDocument; name: string; onDone: (notice: string) => void }) {
  const [content, setContent] = useState('');
  const approve = useMutation({
    mutationFn: (body: { content?: string }) => api<CvTextApproved>(`/v1/hiring/candidate-documents/${enc(d.id)}/searchable-text`, { body }),
    onSuccess: (result) => {
      setContent('');
      onDone(
        `Approved as the searchable text of ${name} (${result.length} characters)${result.replacedCvTextId ? '; the text approved before it is revoked' : ''}. The CV search matches it and never shows it.`,
      );
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (approve.isPending) return;
    approve.mutate(content === '' ? {} : { content });
  };
  return (
    <form className="grid-form" aria-label={`Approve searchable text of ${name}`} onSubmit={submit} noValidate>
      <label className="wide">
        Text of the CV, typed or pasted from the released file
        <textarea maxLength={MAX_CV_TEXT} rows={6} value={content} onChange={(e) => setContent(e.target.value)} style={TEXTAREA} />
      </label>
      <p className="hint wide">
        Approving replaces any text approved before. The text is kept as approved (line breaks normalised, up to 100,000 characters); only the CV search uses it, and it
        never appears in search results, notifications or the audit trail.
      </p>
      {approve.error && (
        <div className="wide">
          <Refusal error={approve.error} words={CV_TEXT_WORDS} />
        </div>
      )}
      <div className="wide row">
        <button type="submit" disabled={approve.isPending}>
          Approve as searchable text
        </button>
      </div>
    </form>
  );
}

function CvTextRevokeForm({ document: d, name, onDone }: { document: CandidateDocument; name: string; onDone: (notice: string) => void }) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: (body: { reason: string }) => api<{ id: string; candidateDocumentId: string; state: string }>(`/v1/hiring/candidate-documents/${enc(d.id)}/searchable-text/revoke`, { body }),
    onSuccess: () => {
      setReason('');
      setProblem(null);
      onDone(`The searchable text of ${name} is revoked: the CV search no longer matches it.`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (revoke.isPending) return;
    const text = reason.trim();
    setProblem(text ? null : 'Enter why the searchable text is revoked.');
    if (!text) {
      revoke.reset();
      return;
    }
    revoke.mutate({ reason: text });
  };
  return (
    <form className="grid-form" aria-label={`Revoke searchable text of ${name}`} onSubmit={submit} noValidate>
      <label className="wide">
        Reason for revoking the searchable text (required)
        <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      <Problem text={problem} />
      {revoke.error && (
        <div className="wide">
          <Refusal error={revoke.error} words={CV_TEXT_WORDS} />
        </div>
      )}
      <div className="wide row">
        <button type="submit" className="danger" disabled={revoke.isPending}>
          Revoke searchable text
        </button>
      </div>
    </form>
  );
}

function uploadedText(scanState: string): string {
  if (scanState === 'QUARANTINED') return 'The file failed the malware scan and was quarantined: it can never be opened.';
  if (scanState === 'CLEAN') return 'Uploaded and released by the malware scan.';
  return 'Uploaded. The file is waiting for the malware scan and can be opened once it is released.';
}

function UploadDocumentForm({ candidateId }: { candidateId: string }) {
  const refresh = useRefresh();
  const id = useId();
  const [documentType, setDocumentType] = useState('CV');
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file after an upload.
  const [inputKey, setInputKey] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: async ({ type, f }: { type: string; f: File }) =>
      api<DocumentUploaded>(`/v1/hiring/candidates/${enc(candidateId)}/documents`, { body: { documentType: type, fileName: f.name, contentBase64: await fileToBase64(f) } }),
    onSuccess: () => {
      setDocumentType('CV');
      setFile(null);
      setInputKey((k) => k + 1);
      setProblem(null);
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (upload.isPending) return;
    const missing = file === null ? 'Choose a file to upload.' : file.size > MAX_UPLOAD_BYTES ? 'Files can be at most 10 MB.' : null;
    setProblem(missing);
    if (missing || file === null) {
      upload.reset();
      return;
    }
    upload.mutate({ type: documentType, f: file });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Add a document
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <label>
          Document type
          <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
            {CANDIDATE_DOCUMENT_TYPES.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          File (PDF, JPEG or PNG, up to 10 MB)
          <input key={inputKey} type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <Problem text={problem} />
        {upload.error && (
          <div className="wide">
            <Refusal error={upload.error} words={UPLOAD_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={upload.isPending}>
            Upload
          </button>
        </div>
        {upload.isSuccess && <Done>{uploadedText(upload.data.scanState)}</Done>}
      </form>
    </>
  );
}

