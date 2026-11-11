// Company policy documents and bulk document mapping (FR-010; DF02; DF09; FR-106; FR-057; BR-043; decision I-38).
//
// Company policies: a policy is a company record with a permanent code, a title, a classification and numbered
// versions, each its own scanned file with an optional expiry. Every role of the company reads OPERATIONAL policies; a
// CONFIDENTIAL one, its title included, exists only for holders of the confidential group, so these screens show
// exactly what the API lists and never hint that anything was left out. Only a version the malware scan released is
// served; versions are immutable (an expiry belongs to its version) and nothing is deleted. Publishing a policy or a
// version and changing a title or classification need the manage duty in an unrestricted company-scope assignment; a
// confidential classification needs the confidential manage group as well. There is no ESS tab for policies (H3
// lists none), so employees read them on the Company policies screen.
// Bulk document mapping: the user stages employee documents (each scanned), then uploads a DOCUMENT_MAPPING_V1 file
// (fileName, employeeCode, documentType, expiresOn) on the shared batch framework: a row-by-row preview, then an
// explicit commit or cancel, all or nothing. An unknown employee code is reported on its row and nothing is assigned.
// A staged file not mapped yet can be discarded by its uploader: it stays on record as discarded (DF08: nothing is
// deleted), is never mapped and frees its file name. The user's staged files are listed a page at a time with the
// total, per state. The user's own mapping batches are listed, so a batch held for the
// malware scan can be opened again, checked again (resumed from its stored file) and then committed or cancelled.
// Staging needs the confidential document upload grant; the mapping file also needs the import duty.
// The server authorises every call and decides every rule; these screens only hide what the selected assignment cannot
// use and render only what the API returned.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, download, fileToBase64, formatDate, idempotencyKey, pinSession } from '../api';
import type { EssPanel, ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Pager, Section } from '../ui';
import { keepOnPage, ReportExport } from './leave-admin';
import { HeldBatchCheck, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useHeldBatchWatch } from './records';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/documents/registration.ts, policies.ts, mapping.ts) and screen paths
// ---------------------------------------------------------------------------------------------------------
/** GET /v1/company-policies, /:id and /v1/company-policy-versions/:id/content (every baseline role). */
const POLICY_READ = 'company_policy.read.operational';
/** POST /v1/company-policies, /:id/versions and PATCH /:id (HR Administrator, unrestricted company scope). */
const POLICY_MANAGE = 'company_policy.manage.operational';
/** A confidential policy, or a classification change to or from confidential, needs this group as well (ceiling only). */
const POLICY_MANAGE_CONFIDENTIAL = 'company_policy.manage.confidential';
/** POST/GET /v1/documents/bulk-uploads; the mapping import needs it too (documents are confidential, DF02). */
const DOCUMENT_UPLOAD = 'document.upload.document';
/** The mapping import is a batch import: /v1/documents/mapping-imports needs the import duty as well. */
const EMPLOYEE_IMPORT = 'employee.import.operational';

const PATHS = {
  policies: '/policies',
  policy: (id: string) => `/policies/${id}`,
  manage: '/documents/policies',
  managePolicy: (id: string) => `/documents/policies/${id}`,
  mapping: '/documents/bulk-mapping',
} as const;

/** The policy code POST /v1/company-policies accepts: an upper-case letter, then up to 39 of A-Z, 0-9 and _. */
const POLICY_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
/** GET /v1/documents/bulk-uploads pages the caller's staged files, newest first: 25, 50 or 100 a page, with the total. */
const STAGED_PAGE_SIZE = 25;
/** GET /v1/documents/mapping-imports pages: 25, 50 or 100 batches. */
const BATCHES_PAGE_SIZE = 25;
const FILE_ACCEPT = 'application/pdf,image/jpeg,image/png';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCROLL: CSSProperties = { overflowX: 'auto' };
const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

// ---------------------------------------------------------------------------------------------------------
// Types: exactly what the API returns (modules/documents/policies.ts and mapping.ts)
// ---------------------------------------------------------------------------------------------------------
type Classification = 'OPERATIONAL' | 'CONFIDENTIAL';

/** The latest version the malware scan released, as GET /v1/company-policies lists it. */
interface CurrentVersion {
  id: string;
  versionNumber: number;
  fileName: string | null;
  mediaType: string;
  byteSize: number | null;
  expiresOn: string | null;
  expired: boolean;
  publishedAt: string;
}

interface PolicyItem {
  id: string;
  policyCode: string;
  title: string;
  classification: Classification;
  version: number;
  latestVersionNumber: number | null;
  /** Null while no version has been released (all waiting for the scan, or quarantined). */
  currentVersion: CurrentVersion | null;
}

interface PolicyVersion {
  id: string;
  versionNumber: number;
  fileName: string | null;
  mediaType: string;
  byteSize: number | null;
  expiresOn: string | null;
  expired: boolean;
  scanState: string | null;
  changeNote: string | null;
  publishedAt: string;
}

interface PolicyDetail {
  id: string;
  policyCode: string;
  title: string;
  classification: Classification;
  /** The record version every change sends back as expectedVersion. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Newest first. */
  versions: PolicyVersion[];
}

/** POST /v1/company-policies (201) and POST /v1/company-policies/:id/versions (201). */
interface Published {
  id: string;
  version: number;
  versionId: string;
  versionNumber: number;
  scanState: string | null;
}

type StagedState = 'UNMAPPED' | 'MAPPED' | 'DISCARDED';

interface StagedFile {
  id: string;
  fileName: string;
  mediaType: string;
  byteSize: number | null;
  scanState: string | null;
  state: StagedState;
  mappedDocumentId: string | null;
  mappedAt: string | null;
  discardedAt: string | null;
  uploadedAt: string;
}

/** GET /v1/documents/bulk-uploads?page=&pageSize=: one page of the caller's staged files and the total of that state. */
interface StagedPage {
  items: StagedFile[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /v1/documents/mapping-imports: one of the caller's own batches, job facts only (GET /:id has the rows). */
interface MappingBatch {
  id: string;
  state: string;
  template: string | null;
  fileName: string | null;
  rowCount: number | null;
  acceptedCount: number;
  rejectedCount: number;
  scanState: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MappingBatchPage {
  items: MappingBatch[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and a list
 * answered to one assignment (a confidential policy included) must never be shown under another.
 */
function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['documents', context] as const;
    return {
      policies: [...base, 'policies'] as const,
      policy: (id: string) => [...base, 'policy', id] as const,
      staged: [...base, 'staged'] as const,
      stagedIn: (state: string, page: number) => [...base, 'staged', state, page] as const,
      batches: [...base, 'mapping-batches'] as const,
      batchesPage: (page: number) => [...base, 'mapping-batches', page] as const,
    };
  }, [context]);
}

/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;
const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
const isNotFound = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.code === 'INVALID_REQUEST');
const scanStateOf = (e: ApiError) => (e.details as { scanState?: string } | undefined)?.scanState;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words; any other error is shown as the API sent it
// ---------------------------------------------------------------------------------------------------------
type Words = Record<string, string | ((e: ApiError) => string)>;

function wordsFor(error: unknown, words: Words): string | null {
  if (!(error instanceof ApiError)) return null;
  const w = words[error.code];
  return w === undefined ? null : typeof w === 'function' ? w(error) : w;
}

function Refusal({ error, words }: { error: unknown; words: Words }) {
  if (!error) return null;
  const text = wordsFor(error, words);
  if (text === null) return <ErrorNote error={error} />;
  return (
    <div role="alert" className="error">
      {text}
      <div className="hint">{(error as ApiError).code}</div>
    </div>
  );
}

const UPLOAD_WORDS: Words = {
  UNSUPPORTED_FILE: 'Only PDF, JPEG and PNG files are accepted.',
  FILE_SIZE: 'Files must be between 1 byte and 10 MB.',
  PAYLOAD_TOO_LARGE: 'The file is larger than 10 MB.',
};

const DOWNLOAD_WORDS: Words = {
  FILE_NOT_RELEASED: (e) =>
    scanStateOf(e) === 'QUARANTINED' ? 'This version was quarantined by the malware scan and can never be opened.' : 'This version has not been released by the malware scan yet, so it cannot be opened.',
  NOT_FOUND: 'This policy version is not available in the selected role’s company.',
  FORBIDDEN: 'The selected role cannot read company policies.',
};

const PUBLISH_WORDS: Words = {
  ...UPLOAD_WORDS,
  POLICY_EXISTS: 'A policy with this code already exists. Publish a new version from that policy’s page instead.',
  EXPIRY_IN_PAST: 'This expiry date has already passed, and a new version cannot already be expired. Choose a later date or leave it empty.',
  FORBIDDEN:
    'The selected role cannot publish this policy. Company policies are published from an unrestricted company-scope assignment holding the policy duty; a confidential policy also needs the confidential policy grant.',
  INVALID_REQUEST: 'Check the code (an upper-case letter, then upper-case letters, digits or _; at most 40), the title and the file name (no / \\ < > : " | ? * characters).',
};

const VERSION_WORDS: Words = {
  ...UPLOAD_WORDS,
  EXPIRY_IN_PAST: PUBLISH_WORDS.EXPIRY_IN_PAST!,
  STALE_VERSION: 'The policy changed since this page loaded it, so nothing was published. It has been reloaded: check it and publish again.',
  NOT_FOUND: 'This policy is not available in the selected role’s company.',
  FORBIDDEN: 'The selected role cannot publish policy versions: that needs the policy duty in an unrestricted company-scope assignment.',
  INVALID_REQUEST: 'The file name cannot contain / \\ < > : " | ? * or control characters, and a change note has at most 1000 characters.',
};

const CHANGE_WORDS: Words = {
  STALE_VERSION: 'The policy changed since this page loaded it, so nothing was saved. It has been reloaded: check it and save again.',
  NOT_FOUND: 'This policy is not available in the selected role’s company.',
  FORBIDDEN:
    'The selected role cannot make this change. Changing a policy needs the policy duty in an unrestricted company-scope assignment; making a policy confidential, or a confidential one operational, also needs the confidential policy grant.',
  INVALID_REQUEST: 'A title has 1 to 200 characters and cannot be blank.',
};

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Shared pieces: classification, scan state, expiry, version history
// ---------------------------------------------------------------------------------------------------------
function ClassificationBadge({ classification }: { classification: string }) {
  return <Badge tone={classification === 'CONFIDENTIAL' ? 'warn' : 'neutral'}>{classification === 'CONFIDENTIAL' ? 'confidential' : 'operational'}</Badge>;
}

/** FR-106: only a released (CLEAN) file is ever served. */
function ScanBadge({ state }: { state: string | null | undefined }) {
  if (state === 'CLEAN') return <Badge tone="good">released</Badge>;
  if (state === 'QUARANTINED') return <Badge tone="bad">quarantined by the malware scan</Badge>;
  return <Badge tone="warn">waiting for the malware scan</Badge>;
}

function Expiry({ expiresOn, expired }: { expiresOn: string | null; expired: boolean }) {
  return (
    <>
      {expiresOn ? formatDate(expiresOn) : 'No expiry date'}
      {expired && (
        <>
          {' '}
          <Badge tone="warn">expired</Badge>
        </>
      )}
    </>
  );
}

function useOpenVersion() {
  return useMutation({ mutationFn: (versionId: string) => download(`/v1/company-policy-versions/${encodeURIComponent(versionId)}/content`) });
}

/** A version's file in plain words after an upload: released, waiting for the scan, or quarantined for good. */
function scanOutcome(scanState: string | null): string {
  if (scanState === 'CLEAN') return 'The malware scan released it, so everyone who may read this policy can open it now.';
  if (scanState === 'QUARANTINED') return 'The file failed the malware scan and is quarantined: it will never be served. Publish a new version with a clean copy.';
  return 'It is waiting for the malware scan; nobody can open it until the scan releases it.';
}

function VersionHistory({ versions }: { versions: PolicyVersion[] }) {
  const open = useOpenVersion();
  if (versions.length === 0) return <Empty>No versions on record.</Empty>;
  return (
    <>
      <div style={SCROLL}>
        <table aria-label="Versions">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">File</th>
              <th scope="col">Published</th>
              <th scope="col">Expires</th>
              <th scope="col">Malware scan</th>
              <th scope="col">Change note</th>
              <th scope="col">
                <span style={SR_ONLY}>Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td>{v.versionNumber}</td>
                <td>{v.fileName ?? '—'}</td>
                <td>{formatDate(v.publishedAt)}</td>
                <td>
                  <Expiry expiresOn={v.expiresOn} expired={v.expired} />
                </td>
                <td>
                  <ScanBadge state={v.scanState} />
                </td>
                <td>{v.changeNote ?? '—'}</td>
                <td>
                  {v.scanState === 'CLEAN' ? (
                    <button type="button" className="secondary" disabled={open.isPending} aria-label={`Download version ${v.versionNumber}`} onClick={() => open.mutate(v.id)}>
                      Download
                    </button>
                  ) : (
                    <span className="hint">cannot be opened</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Refusal error={open.error} words={DOWNLOAD_WORDS} />
    </>
  );
}

function PolicyFacts({ policy }: { policy: PolicyDetail }) {
  return (
    <dl className="kv">
      <div>
        <dt>Code</dt>
        <dd>{policy.policyCode}</dd>
      </div>
      <div>
        <dt>Classification</dt>
        <dd>
          <ClassificationBadge classification={policy.classification} />
        </dd>
      </div>
      <div>
        <dt>Versions</dt>
        <dd>{policy.versions.length}</dd>
      </div>
      <div>
        <dt>Last changed</dt>
        <dd>{formatDate(policy.updatedAt)}</dd>
      </div>
    </dl>
  );
}

/** The policy named in the address, for the read and the manage detail screens (the same API answer and cache). */
function usePolicy(id: string, enabled: boolean) {
  const keys = useKeys();
  return useQuery({
    queryKey: keys.policy(id),
    enabled: enabled && UUID.test(id),
    queryFn: () => api<PolicyDetail>(`/v1/company-policies/${encodeURIComponent(id)}`),
    retry: retryTransient,
  });
}

function PolicyUnavailable({ error }: { error: unknown }) {
  if (isForbidden(error)) return <NotPermitted>The selected role cannot read company policies.</NotPermitted>;
  if (isNotFound(error)) return <Empty>This policy is not available in the selected role’s company.</Empty>;
  return <ErrorNote error={error} />;
}

// ---------------------------------------------------------------------------------------------------------
// Company policies: the read view every employee of the company has
// ---------------------------------------------------------------------------------------------------------
function PoliciesScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const canRead = can(POLICY_READ);
  const list = useQuery({ queryKey: keys.policies, enabled: canRead, queryFn: () => api<{ items: PolicyItem[] }>('/v1/company-policies'), retry: retryTransient });
  const open = useOpenVersion();

  if (!canRead) {
    return (
      <Section title="Company policies">
        <NotPermitted>The selected role cannot read company policies.</NotPermitted>
      </Section>
    );
  }
  const items = list.data?.items ?? [];
  return (
    <Section title="Company policies" actions={can(POLICY_MANAGE) ? <Link to={PATHS.manage}>Policy upload</Link> : undefined}>
      <p className="hint">Each policy shows its latest version released by the malware scan. An expired version stays on record and is marked expired.</p>
      {list.isPending && <p className="hint">Loading policies…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot read company policies.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>No company policies are published yet.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Company policies">
            <thead>
              <tr>
                <th scope="col">Policy</th>
                <th scope="col">Classification</th>
                <th scope="col">Current version</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span style={SR_ONLY}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.title} <span className="hint">{p.policyCode}</span>
                  </td>
                  <td>
                    <ClassificationBadge classification={p.classification} />
                  </td>
                  <td>
                    {p.currentVersion ? (
                      <>
                        Version {p.currentVersion.versionNumber} <span className="hint">published {formatDate(p.currentVersion.publishedAt)}</span>
                      </>
                    ) : (
                      'No released version yet'
                    )}
                  </td>
                  <td>{p.currentVersion ? <Expiry expiresOn={p.currentVersion.expiresOn} expired={p.currentVersion.expired} /> : '—'}</td>
                  <td>
                    <div className="row">
                      {p.currentVersion && (
                        <button type="button" className="secondary" disabled={open.isPending} aria-label={`Download ${p.title}`} onClick={() => open.mutate(p.currentVersion!.id)}>
                          Download
                        </button>
                      )}
                      <Link to={PATHS.policy(p.id)} aria-label={`Versions of ${p.title}`}>
                        Versions
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Refusal error={open.error} words={DOWNLOAD_WORDS} />
    </Section>
  );
}

function PolicyScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const canRead = can(POLICY_READ);
  const detail = usePolicy(id, canRead);
  const p = detail.data;
  return (
    <>
      <p>
        <Link to={PATHS.policies}>← Company policies</Link>
      </p>
      {!canRead ? (
        <Section title="Company policy">
          <NotPermitted>The selected role cannot read company policies.</NotPermitted>
        </Section>
      ) : !UUID.test(id) || detail.error ? (
        <Section title="Company policy">
          <PolicyUnavailable error={detail.error ?? new ApiError(404, 'NOT_FOUND', 'Not found')} />
        </Section>
      ) : !p ? (
        <p className="hint">Loading the policy…</p>
      ) : (
        <Section title={p.title} actions={can(POLICY_MANAGE) ? <Link to={PATHS.managePolicy(p.id)}>Manage this policy</Link> : undefined}>
          <PolicyFacts policy={p} />
          <h3>Versions</h3>
          <p className="hint">Every version stays on record. Only a version the malware scan released can be opened.</p>
          <VersionHistory versions={p.versions} />
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Policy upload: publish a policy, a new version, or change its title and classification
// ---------------------------------------------------------------------------------------------------------
function ManagePoliciesScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const canManage = can(POLICY_MANAGE);
  const canRead = can(POLICY_READ);
  const list = useQuery({ queryKey: keys.policies, enabled: canManage && canRead, queryFn: () => api<{ items: PolicyItem[] }>('/v1/company-policies'), retry: retryTransient });

  if (!canManage) {
    return (
      <Section title="Policy upload">
        <NotPermitted>The selected role cannot publish company policies.</NotPermitted>
      </Section>
    );
  }
  const items = list.data?.items ?? [];
  return (
    <>
      <PublishPolicyForm />
      <Section title="Published policies">
        {!canRead && <NotPermitted>The selected role cannot list company policies.</NotPermitted>}
        {canRead && list.isPending && <p className="hint">Loading policies…</p>}
        {isForbidden(list.error) ? <NotPermitted>The selected role cannot list company policies.</NotPermitted> : <ErrorNote error={list.error} />}
        {list.data && items.length === 0 && <Empty>No company policies are published yet.</Empty>}
        {items.length > 0 && (
          <div style={SCROLL}>
            <table aria-label="Published policies">
              <thead>
                <tr>
                  <th scope="col">Policy</th>
                  <th scope="col">Classification</th>
                  <th scope="col">Released version</th>
                  <th scope="col">Expires</th>
                  <th scope="col">
                    <span style={SR_ONLY}>Manage</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const released = p.currentVersion?.versionNumber ?? 0;
                  const latest = p.latestVersionNumber ?? 0;
                  return (
                    <tr key={p.id}>
                      <td>
                        {p.title} <span className="hint">{p.policyCode}</span>
                      </td>
                      <td>
                        <ClassificationBadge classification={p.classification} />
                      </td>
                      <td>
                        {p.currentVersion ? `Version ${p.currentVersion.versionNumber}` : 'None released yet'}
                        {latest > released && (
                          <div className="hint">
                            Version {latest} is not released (waiting for the malware scan, or quarantined).
                          </div>
                        )}
                      </td>
                      <td>{p.currentVersion ? <Expiry expiresOn={p.currentVersion.expiresOn} expired={p.currentVersion.expired} /> : '—'}</td>
                      <td>
                        <Link to={PATHS.managePolicy(p.id)} aria-label={`Manage ${p.title}`}>
                          Manage
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function PublishPolicyForm() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canConfidential = can(POLICY_MANAGE_CONFIDENTIAL);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [classification, setClassification] = useState<Classification>('OPERATIONAL');
  const [expiresOn, setExpiresOn] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  // Remounting the form after a publication clears the chosen file as well as the typed fields.
  const [formKey, setFormKey] = useState(0);
  const [done, setDone] = useState<{ id: string; label: string; scanState: string | null } | null>(null);
  const publish = useMutation({
    mutationFn: async (f: File) =>
      api<Published>('/v1/company-policies', {
        body: {
          policyCode: code,
          title: title.trim(),
          classification,
          fileName: f.name,
          contentBase64: await fileToBase64(f),
          ...(expiresOn ? { expiresOn } : {}),
          ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
        },
      }),
    onMutate: () => setDone(null),
    onSuccess: (result) => {
      setDone({ id: result.id, label: `${title.trim()} (${code})`, scanState: result.scanState });
      setCode('');
      setTitle('');
      setClassification('OPERATIONAL');
      setExpiresOn('');
      setChangeNote('');
      setFile(null);
      setFormKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: keys.policies });
    },
  });
  const codeOk = POLICY_CODE.test(code);
  const ready = codeOk && title.trim() !== '' && file !== null && !publish.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && file) publish.mutate(file);
  };

  return (
    <Section title="Publish a new policy">
      <form key={formKey} className="grid-form" aria-label="Publish a new policy" onSubmit={submit}>
        <label>
          Policy code
          <input required maxLength={40} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </label>
        <label>
          Title
          <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Classification
          <select value={classification} onChange={(e) => setClassification(e.target.value as Classification)}>
            <option value="OPERATIONAL">Operational (every employee of the company)</option>
            {canConfidential && <option value="CONFIDENTIAL">Confidential (confidential policy grant only)</option>}
          </select>
        </label>
        <label>
          Expires on (optional)
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
        <label className="wide">
          Change note (optional)
          <input maxLength={1000} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} />
        </label>
        <label className="wide">
          Policy file
          <input type="file" accept={FILE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="wide">
          <button type="submit" disabled={!ready}>
            Publish
          </button>
        </div>
      </form>
      {code !== '' && !codeOk && <p className="hint">A policy code starts with an upper-case letter, followed by up to 39 upper-case letters, digits or _.</p>}
      <p className="hint">
        PDF, JPEG or PNG up to 10 MB. The code is permanent; later changes are new versions. Every file is scanned for malware before anyone can open it.
      </p>
      {done && (
        <p className="ok" role="status">
          Published {done.label}, version 1. {scanOutcome(done.scanState)} <Link to={PATHS.managePolicy(done.id)}>Manage this policy</Link>
        </p>
      )}
      <Refusal error={publish.error} words={PUBLISH_WORDS} />
    </Section>
  );
}

function ManagePolicyScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const canManage = can(POLICY_MANAGE);
  const canRead = can(POLICY_READ);
  const detail = usePolicy(id, canManage && canRead);
  const p = detail.data;
  return (
    <>
      <p>
        <Link to={PATHS.manage}>← Policy upload</Link>
      </p>
      {!canManage || !canRead ? (
        <Section title="Manage company policy">
          <NotPermitted>The selected role cannot manage company policies.</NotPermitted>
        </Section>
      ) : !UUID.test(id) || detail.error ? (
        <Section title="Manage company policy">
          <PolicyUnavailable error={detail.error ?? new ApiError(404, 'NOT_FOUND', 'Not found')} />
        </Section>
      ) : !p ? (
        <p className="hint">Loading the policy…</p>
      ) : (
        <>
          <Section title={`${p.title} (${p.policyCode})`}>
            <PolicyFacts policy={p} />
            <h3>Versions</h3>
            <p className="hint">Versions are kept as published: an expiry date belongs to its version and does not change. To change it, publish a new version.</p>
            <VersionHistory versions={p.versions} />
          </Section>
          <NewVersionForm policy={p} />
          <PolicyChangeForm policy={p} />
        </>
      )}
    </>
  );
}

function NewVersionForm({ policy }: { policy: PolicyDetail }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [expiresOn, setExpiresOn] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [done, setDone] = useState<{ versionNumber: number; scanState: string | null } | null>(null);
  const reload = () => {
    void qc.invalidateQueries({ queryKey: keys.policy(policy.id) });
    void qc.invalidateQueries({ queryKey: keys.policies });
  };
  const publish = useMutation({
    mutationFn: async (f: File) =>
      api<Published>(`/v1/company-policies/${encodeURIComponent(policy.id)}/versions`, {
        body: {
          fileName: f.name,
          contentBase64: await fileToBase64(f),
          expectedVersion: policy.version,
          ...(expiresOn ? { expiresOn } : {}),
          ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
        },
      }),
    onMutate: () => setDone(null),
    onSuccess: (result) => {
      setDone({ versionNumber: result.versionNumber, scanState: result.scanState });
      setExpiresOn('');
      setChangeNote('');
      setFile(null);
      setFormKey((k) => k + 1);
      reload();
    },
    onError: (error) => {
      // Someone else changed the policy: show it as it is now; what was typed stays for the retry.
      if (error instanceof ApiError && error.code === 'STALE_VERSION') reload();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (file && !publish.isPending) publish.mutate(file);
  };
  return (
    <Section title="Publish a new version">
      <form key={formKey} className="grid-form" aria-label="Publish a new version" onSubmit={submit}>
        <label>
          Expires on (optional)
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
        <label className="wide">
          Change note (optional)
          <input maxLength={1000} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} />
        </label>
        <label className="wide">
          Version file
          <input type="file" accept={FILE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="wide">
          <button type="submit" disabled={!file || publish.isPending}>
            Publish version
          </button>
        </div>
      </form>
      <p className="hint">The new version becomes the current one once the malware scan releases it; earlier versions stay on record.</p>
      {done && (
        <p className="ok" role="status">
          Published version {done.versionNumber}. {scanOutcome(done.scanState)}
        </p>
      )}
      <Refusal error={publish.error} words={VERSION_WORDS} />
    </Section>
  );
}

function PolicyChangeForm({ policy }: { policy: PolicyDetail }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canConfidential = can(POLICY_MANAGE_CONFIDENTIAL);
  const [title, setTitle] = useState(policy.title);
  const [classification, setClassification] = useState<Classification>(policy.classification);
  const [saved, setSaved] = useState(false);
  // Whenever the policy changes (this save, or someone else's change found on a reload) the form shows it as it is now.
  useEffect(() => {
    setTitle(policy.title);
    setClassification(policy.classification);
  }, [policy.version, policy.title, policy.classification]);
  const reload = () => {
    void qc.invalidateQueries({ queryKey: keys.policy(policy.id) });
    void qc.invalidateQueries({ queryKey: keys.policies });
  };
  const titleChanged = title.trim() !== policy.title;
  const classificationChanged = classification !== policy.classification;
  const save = useMutation({
    mutationFn: () =>
      api<PolicyDetail>(`/v1/company-policies/${encodeURIComponent(policy.id)}`, {
        method: 'PATCH',
        body: { expectedVersion: policy.version, ...(titleChanged ? { title: title.trim() } : {}), ...(classificationChanged ? { classification } : {}) },
      }),
    onMutate: () => setSaved(false),
    onSuccess: (updated) => {
      qc.setQueryData(keys.policy(policy.id), updated);
      setSaved(true);
      reload();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') reload();
    },
  });
  // A confidential policy, or a change to or from confidential, needs the confidential manage group (DF02).
  const locked = policy.classification === 'CONFIDENTIAL' && !canConfidential;
  const ready = !locked && (titleChanged || classificationChanged) && title.trim() !== '' && !save.isPending;
  return (
    <Section title="Title and classification">
      {locked ? (
        <NotPermitted>Changing a confidential policy also needs the confidential policy grant.</NotPermitted>
      ) : (
        <form
          className="grid-form"
          aria-label="Title and classification"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate();
          }}
        >
          <label className="wide">
            Title
            <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Classification
            <select value={classification} onChange={(e) => setClassification(e.target.value as Classification)}>
              <option value="OPERATIONAL">Operational (every employee of the company)</option>
              {(canConfidential || policy.classification === 'CONFIDENTIAL') && <option value="CONFIDENTIAL">Confidential (confidential policy grant only)</option>}
            </select>
          </label>
          <div className="wide">
            <button type="submit" disabled={!ready}>
              Save
            </button>
          </div>
        </form>
      )}
      <p className="hint">The classification belongs to the policy, so it applies to every version, earlier ones included.</p>
      {classificationChanged && classification === 'OPERATIONAL' && <p role="status">Saving makes every version of this policy readable by every employee of the company.</p>}
      {classificationChanged && classification === 'CONFIDENTIAL' && <p role="status">Saving makes every version of this policy readable only by holders of the confidential policy grant.</p>}
      {saved && (
        <p className="ok" role="status">
          Saved.
        </p>
      )}
      <Refusal error={save.error} words={CHANGE_WORDS} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Bulk document mapping (FR-010, DF09, I-13): stage files, then map them with a DOCUMENT_MAPPING_V1 batch
// ---------------------------------------------------------------------------------------------------------

/** DOCUMENT_MAPPING_V1 row problems: documents/mapping.ts applyRow and imports/batch.ts. Any other code is shown as sent. */
const MAPPING_PROBLEMS: Record<string, string> = {
  FILE_NAME_REQUIRED: 'The fileName cell is empty; name one of your staged files.',
  INVALID_EMPLOYEE_CODE: 'The employee code is not a valid code (letters, digits, - and _, starting with a letter or digit, at most 40 characters).',
  INVALID_EXPIRES_ON: 'expiresOn is not a valid date (YYYY-MM-DD); leave it blank for no expiry.',
  UNKNOWN_FILE: 'You have no staged file with this name waiting to be mapped. Stage it first or check the name; a file already mapped, or discarded, cannot be mapped.',
  FILE_QUARANTINED: 'This staged file failed the malware scan and is quarantined, so it can never be mapped.',
  FILE_NOT_RELEASED: 'This staged file is still waiting for the malware scan; it can be mapped once the scan releases it.',
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code. Nothing is assigned to a guessed employee; correct the code.',
  OUT_OF_SCOPE: 'This employee is outside the scope of your role.',
  UNKNOWN_DOCUMENT_TYPE: 'No active document type has this code.',
  FILE_ALREADY_MAPPED: 'This file was mapped to an employee meanwhile.',
  DUPLICATE_IN_BATCH: 'This file is already named on an earlier row; each staged file may appear on one row only.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
};

const MAPPING_TEMPLATE: ImportTemplate = {
  code: 'DOCUMENT_MAPPING_V1',
  label: 'Document mapping',
  permissions: [EMPLOYEE_IMPORT, DOCUMENT_UPLOAD],
  base: '/v1/documents/mapping-imports',
  columns: 'fileName,employeeCode,documentType,expiresOn',
  keyLabel: 'Employee code',
  noun: ['document', 'documents'],
  verb: 'Map',
  note:
    'Each row assigns one of your staged files, by its file name, to the employee with that code as a document of that type; expiresOn (YYYY-MM-DD) may be left blank. Only files the malware scan released can be mapped, and a mapping is final.',
  problems: MAPPING_PROBLEMS,
};

const MAPPING_UPLOAD_WORDS: Words = {
  FILE_QUARANTINED: 'The malware scan flagged this mapping file, so nothing in it was read and nothing was mapped. Upload a clean copy of the file.',
  INVALID_HEADER: `The first line of the file must be exactly the header ${MAPPING_TEMPLATE.columns}.`,
  INVALID_FILE: 'The file is not a valid UTF-8 CSV file.',
  EMPTY_FILE: 'The file has no rows to map below its header.',
  FILE_SIZE: 'A mapping file must be between 1 byte and 10 MB.',
  PAYLOAD_TOO_LARGE: 'The file is larger than 10 MB.',
  IDEMPOTENCY_KEY_IN_USE: 'This upload could not be matched to your earlier one. Validate the file again to send it as a new upload.',
  FORBIDDEN: 'The selected role cannot map documents: a mapping file needs the import duty and the document upload grant.',
};

const STAGE_WORDS: Words = {
  ...UPLOAD_WORDS,
  FILE_NAME_IN_USE: 'You already staged a file with this name that is waiting to be mapped. Map or discard that file first, or rename this one.',
  FORBIDDEN: 'The selected role cannot stage documents: that needs the document upload grant.',
  INVALID_REQUEST: 'The file name cannot contain / \\ < > : " | ? * or control characters.',
  SESSION_CHANGED: 'Not sent: the role or company changed before this file was staged.',
};

const DISCARD_WORDS: Words = {
  FILE_MAPPED: 'This file has been mapped to an employee meanwhile: it is an employee document now and cannot be discarded.',
  NOT_FOUND: 'This staged file is not available to the selected role.',
  FORBIDDEN: 'The selected role cannot discard staged documents: that needs the document upload grant.',
};

const STAGED_TABS: { state: StagedState; label: string; table: string; empty: string }[] = [
  { state: 'UNMAPPED', label: 'Waiting to be mapped', table: 'Files waiting to be mapped', empty: 'You have no staged files waiting to be mapped.' },
  { state: 'MAPPED', label: 'Mapped', table: 'Mapped files', empty: 'None of your staged files has been mapped yet.' },
  { state: 'DISCARDED', label: 'Discarded', table: 'Discarded files', empty: 'You have not discarded any staged file.' },
];

/** A batch's state in plain words (imports/jobs.ts). */
const BATCH_STATES: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  UPLOADED: { label: 'waiting for the scan', tone: 'neutral' },
  PREVIEWED: { label: 'previewed, not committed', tone: 'warn' },
  COMMITTED: { label: 'committed', tone: 'good' },
  REJECTED: { label: 'rejected, nothing mapped', tone: 'bad' },
  CANCELLED: { label: 'cancelled, nothing mapped', tone: 'neutral' },
};

type StageResult = { fileName: string; scanState: string | null } | { fileName: string; error: unknown };

function stageText(r: StageResult): string {
  if ('error' in r) {
    const e = r.error;
    return wordsFor(e, STAGE_WORDS) ?? (e instanceof ApiError ? `${e.message} (${e.code})` : 'Not staged: no answer came back.');
  }
  if (r.scanState === 'CLEAN') return 'Staged and released by the malware scan; it can be mapped.';
  if (r.scanState === 'QUARANTINED') return 'Staged, but quarantined by the malware scan: it can never be mapped.';
  return 'Staged; waiting for the malware scan. It can be mapped once the scan releases it.';
}

function BulkMappingScreen() {
  const { can } = useSession();
  const canStage = can(DOCUMENT_UPLOAD);
  const canMap = canStage && can(EMPLOYEE_IMPORT);
  if (!canStage) {
    return (
      <Section title="Bulk document mapping">
        <NotPermitted>Employee documents are confidential, and the selected role holds no document upload grant, so it cannot stage or map documents.</NotPermitted>
      </Section>
    );
  }
  return (
    <>
      <StageDocuments />
      <StagedFiles />
      {canMap ? (
        <MappingImport />
      ) : (
        <Section title="Mapping file">
          <NotPermitted>Uploading a mapping file also needs the import duty, which the selected role does not hold.</NotPermitted>
        </Section>
      )}
    </>
  );
}

function StageDocuments() {
  const keys = useKeys();
  const qc = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [inputKey, setInputKey] = useState(0);
  const [results, setResults] = useState<StageResult[]>([]);
  const stage = useMutation({
    mutationFn: async (chosen: File[]) => {
      // One staging request per file, all under the role they were started in (BR-046).
      const send = pinSession();
      const out: StageResult[] = [];
      for (const f of chosen) {
        try {
          const r = await send<{ id: string; fileName: string; scanState: string | null }>('/v1/documents/bulk-uploads', {
            body: { fileName: f.name, contentBase64: await fileToBase64(f) },
          });
          out.push({ fileName: r.fileName, scanState: r.scanState });
        } catch (error) {
          out.push({ fileName: f.name, error });
        }
      }
      return out;
    },
    onMutate: () => setResults([]),
    onSuccess: (out) => {
      setResults(out);
      setFiles([]);
      setInputKey((k) => k + 1);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.staged }),
  });
  const staged = results.filter((r) => !('error' in r)).length;
  return (
    <Section title="Stage documents">
      <form
        className="inline"
        aria-label="Stage documents"
        onSubmit={(e) => {
          e.preventDefault();
          if (files.length > 0 && !stage.isPending) stage.mutate(files);
        }}
      >
        <label>
          Documents to stage
          <input key={inputKey} type="file" multiple accept={FILE_ACCEPT} disabled={stage.isPending} onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </label>
        <button type="submit" disabled={files.length === 0 || stage.isPending}>
          {files.length > 1 ? `Stage ${files.length} files` : 'Stage file'}
        </button>
      </form>
      <p className="hint">
        PDF, JPEG or PNG up to 10 MB each. A staged file waits, unassigned, under its file name until a mapping file assigns it to an employee. Every file is scanned for
        malware first.
      </p>
      {stage.isPending && <p className="hint">Staging…</p>}
      {results.length > 0 && (
        <>
          <p role="status">
            {plural(staged, 'file', 'files')} staged{results.length > staged ? `, ${plural(results.length - staged, 'file', 'files')} not staged` : ''}.
          </p>
          <ul aria-label="Staging results">
            {results.map((r, i) => (
              <li key={`${r.fileName}-${i}`}>
                <strong>{r.fileName}</strong>: {stageText(r)}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function StagedFiles() {
  const keys = useKeys();
  const qc = useQueryClient();
  const [state, setState] = useState<StagedState>('UNMAPPED');
  const [page, setPage] = useState(1);
  const tab = STAGED_TABS.find((t) => t.state === state)!;
  // The file whose discard waits for a second click, and the last one discarded.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState<string | null>(null);
  const list = useQuery({
    queryKey: keys.stagedIn(state, page),
    queryFn: () => api<StagedPage>(`/v1/documents/bulk-uploads?state=${state}&page=${page}&pageSize=${STAGED_PAGE_SIZE}`),
    retry: retryTransient,
  });
  const discard = useMutation({
    mutationFn: (f: StagedFile) => api<StagedFile>(`/v1/documents/bulk-uploads/${encodeURIComponent(f.id)}/discard`, { method: 'POST' }),
    onMutate: () => setDiscarded(null),
    onSuccess: (f) => setDiscarded(f.fileName),
    onSettled: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: keys.staged });
    },
  });
  const show = (next: StagedState) => {
    setState(next);
    setPage(1);
    setConfirming(null);
  };
  const turn = (next: number) => {
    setPage(next);
    setConfirming(null);
  };
  const items = list.data?.items ?? [];
  return (
    <Section
      title="Your staged files"
      actions={
        <div className="row">
          {STAGED_TABS.map((t) => (
            <button key={t.state} type="button" aria-pressed={state === t.state} className={state === t.state ? '' : 'secondary'} onClick={() => show(t.state)}>
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      <p className="hint">
        Only you see the files you staged. A mapped file has become an employee document and cannot be mapped again or discarded. A file waiting to be mapped (one the
        malware scan quarantined, or one staged by mistake) can be discarded: it is kept on record under Discarded, never deleted, and can never be mapped; its file name
        can be staged again.
      </p>
      {discarded && (
        <p className="ok" role="status">
          {discarded} was discarded. It stays on record under Discarded and can never be mapped.
        </p>
      )}
      <Refusal error={discard.error} words={DISCARD_WORDS} />
      {list.isPending && <p className="hint">Loading staged files…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot list staged documents.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>{page === 1 ? tab.empty : 'No staged files on this page.'}</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label={tab.table}>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Staged</th>
                <th scope="col">Malware scan</th>
                {state === 'MAPPED' && <th scope="col">Mapped</th>}
                {state === 'DISCARDED' && <th scope="col">Discarded</th>}
                {state === 'UNMAPPED' && (
                  <th scope="col">
                    <span style={SR_ONLY}>Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <td>{f.fileName}</td>
                  <td>{formatDate(f.uploadedAt)}</td>
                  <td>
                    <ScanBadge state={f.scanState} />
                  </td>
                  {state === 'MAPPED' && <td>{formatDate(f.mappedAt)}</td>}
                  {state === 'DISCARDED' && <td>{formatDate(f.discardedAt)}</td>}
                  {state === 'UNMAPPED' && (
                    <td>
                      {confirming === f.id ? (
                        <div className="row">
                          <button type="button" disabled={discard.isPending} aria-label={`Confirm discarding ${f.fileName}`} onClick={() => discard.mutate(f)}>
                            Yes, discard
                          </button>
                          <button type="button" className="secondary" disabled={discard.isPending} onClick={() => setConfirming(null)}>
                            Keep
                          </button>
                        </div>
                      ) : (
                        <button type="button" className="secondary" disabled={discard.isPending} aria-label={`Discard ${f.fileName}`} onClick={() => setConfirming(f.id)}>
                          Discard
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pager page={page} pageSize={STAGED_PAGE_SIZE} total={list.data.total} onPage={turn} label="Staged file pages" noun="staged file" />}
    </Section>
  );
}

/**
 * The mapping batch, as the employee imports run it (records.tsx): one idempotency key per chosen file, a row-by-row
 * preview, then an explicit commit or cancel. A file waiting for the scan worker is held (UPLOADED) with nothing read, which
 * is the normal first answer; checking it again resumes that batch from its stored file (no second upload, no second batch),
 * by itself while the screen is open. The user's own batches are listed below, so a held batch can be opened again later.
 */
function MappingImport() {
  const keys = useKeys();
  const qc = useQueryClient();
  const t = MAPPING_TEMPLATE;
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };
  // Every change to a batch changes the list of batches, and a commit maps staged files.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.batches });
    void qc.invalidateQueries({ queryKey: keys.staged });
  };

  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => {
      // The decision and any look at the batch after it go out under the role it was made in (BR-046).
      const send = pinSession();
      try {
        return await send<ImportJob>(`${t.base}/${id}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on (this very decision went through but its answer was lost, or the batch changed
        // since the preview): its job view shows where it stands now.
        const current = await send<ImportJob>(`${t.base}/${id}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onSuccess: (view) => setJob(view),
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async ({ f, key }: { f: File; key: string }) => api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } }),
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      act.reset();
      // The preview is on screen, so the form starts clean: the next file is a new upload with its own key.
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) return; // no answer: the same key may be sent again
      if (err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
    onSettled: refresh,
  });
  // A held batch, checked again from the file the server stored (POST /:id/resume): still held, or previewed.
  const resume = useMutation({
    mutationFn: (id: string) => api<ImportJob>(`${t.base}/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    onMutate: () => {
      upload.reset();
      act.reset();
      open.reset();
    },
    onSuccess: (view) => setJob(view),
    onError: (err, id) => {
      // The server closed the held batch (its file was quarantined, or is not a valid batch): it is no longer held.
      if (err instanceof ApiError && err.status < 500) setJob((shown) => (shown?.id === id ? null : shown));
    },
    onSettled: refresh,
  });
  // One of the user's batches, opened from the list.
  const open = useMutation({
    mutationFn: (id: string) => api<ImportJob>(`${t.base}/${encodeURIComponent(id)}`),
    onMutate: () => {
      upload.reset();
      act.reset();
      resume.reset();
    },
    onSuccess: (view) => setJob(view),
  });
  // While a batch waits for the scan the screen re-checks it by itself; the button above stays for someone who comes back later.
  const watch = useHeldBatchWatch(t.base, job, { show: setJob, closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)), refresh }, resume.isPending || open.isPending);

  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    watch.clearError();
    const key = (uploadKey.current ??= idempotencyKey('mapping'));
    upload.mutate({ f: file, key });
  };

  return (
    <>
      <Section title="Mapping file">
        <form onSubmit={submit} className="stack">
          <p className="hint">
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}). {t.note} Nothing is mapped until you commit a preview, and a batch is applied all or
            nothing: one row with a problem, such as an unknown employee code, rejects the whole batch and assigns nothing.
          </p>
          <TemplateDownload base={t.base} code={t.code} />
          <div className="inline">
            <label>
              Mapping CSV file
              <input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={!file || busy}>
              Validate
            </button>
          </div>
        </form>
        <Refusal error={upload.error ?? resume.error ?? watch.error} words={MAPPING_UPLOAD_WORDS} />
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <MappingBatches openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

/** The user's own mapping batches, newest first, a page at a time (GET /v1/documents/mapping-imports). */
function MappingBatches({ openedId, busy, onOpen, error }: { openedId: string | null; busy: boolean; onOpen: (id: string) => void; error: unknown }) {
  const keys = useKeys();
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: keys.batchesPage(page),
    queryFn: () => api<MappingBatchPage>(`${MAPPING_TEMPLATE.base}?page=${page}&pageSize=${BATCHES_PAGE_SIZE}`),
    retry: retryTransient,
  });
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / BATCHES_PAGE_SIZE));
  return (
    <Section title="Your mapping batches">
      <p className="hint">
        Only you see the mapping files you uploaded. Open a batch to see its rows; one still waiting for its scan can be checked again and then committed or cancelled.
      </p>
      {list.isPending && <p className="hint">Loading your mapping batches…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot list mapping batches.</NotPermitted> : <ErrorNote error={list.error} />}
      <Refusal error={error} words={{ NOT_FOUND: 'This batch is not available to the selected role.' }} />
      {list.data && items.length === 0 && <Empty>{page === 1 ? 'You have not uploaded a mapping file yet.' : 'No batches on this page.'}</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Your mapping batches">
            <thead>
              <tr>
                <th scope="col">Mapping file</th>
                <th scope="col">Uploaded</th>
                <th scope="col">Status</th>
                <th scope="col">Malware scan</th>
                <th scope="col">Rows</th>
                <th scope="col">
                  <span style={SR_ONLY}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => {
                const state = BATCH_STATES[b.state];
                const name = b.fileName ?? 'mapping file';
                return (
                  <tr key={b.id}>
                    <td>{name}</td>
                    <td>{formatDate(b.createdAt)}</td>
                    <td>
                      <Badge tone={state?.tone ?? 'neutral'}>{state?.label ?? b.state}</Badge>
                    </td>
                    <td>
                      <ScanBadge state={b.scanState} />
                    </td>
                    <td>{b.state === 'COMMITTED' ? `${b.acceptedCount} mapped` : b.rowCount === null ? '—' : String(b.rowCount)}</td>
                    <td>
                      {b.id === openedId ? (
                        <span className="hint">open above</span>
                      ) : (
                        <button type="button" className="secondary" disabled={busy} aria-label={`Open ${name} uploaded ${formatDate(b.createdAt)}`} onClick={() => onOpen(b.id)}>
                          Open
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="row">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Newer batches
          </button>
          <span className="hint">
            Page {page} of {pages}
          </span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Older batches
          </button>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Mandatory document types and the employee document compliance report (CL-150; FR-010; FR-056; migration 0261;
// modules/documents/requirements.ts and compliance.ts). HR keeps which document types every employee (or every employee of
// one employment type) must hold, as dated configuration: a requirement starts today or later and is ended, never edited or
// deleted, with a reason. The report lists the employees in the role's scope who miss a mandatory type, as on a day; it needs
// its own confidential export right (who lacks which document comes from their confidential documents).
// ---------------------------------------------------------------------------------------------------------
const REQUIREMENT_READ = 'document_requirement.read.operational';
const REQUIREMENT_MANAGE = 'document_requirement.manage.operational';
const COMPLIANCE_EXPORT = 'document_compliance.export.document';
const ORG_READ = 'org_master.read.operational';
const REQUIREMENTS_PATH = '/documents/mandatory-types';

interface CodeLabel {
  code: string;
  label: string;
}
/** A mandatory document type as GET /v1/document-requirements lists it. */
interface Requirement {
  id: string;
  documentType: CodeLabel;
  employmentType: CodeLabel | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  inForceToday: boolean;
  reason: string;
  endReason: string | null;
  version: number;
}
interface RequirementList {
  businessDate: string;
  items: Requirement[];
  options: { documentTypes: CodeLabel[]; employmentTypes: CodeLabel[] };
}

const REQUIREMENT_WORDS: Words = {
  EFFECTIVE_DATE_IN_PAST: 'Choose today or a later date: earlier days keep the rules they had.',
  OVERLAPPING_REQUIREMENT: 'This document type is already mandatory for these employees over an overlapping period. End that requirement first, or start this one after it ends.',
  INVALID_REFERENCE: 'The document type or employment type is unknown or no longer active. Reload the page and choose again.',
  ALREADY_ENDED: 'This requirement has already ended.',
  VERSION_CONFLICT: 'This requirement changed since the page loaded it. It has been reloaded: check it and try again.',
  FORBIDDEN: 'The selected role cannot change mandatory document types: that needs the duty in an unrestricted company-scope assignment.',
};

function requirementState(r: Requirement, today: string): string {
  if (r.effectiveTo !== null && r.effectiveTo <= r.effectiveFrom) return 'withdrawn before it started';
  if (r.inForceToday) return r.effectiveTo ? `in force until ${formatDate(r.effectiveTo)} (last day the day before)` : 'in force';
  if (r.effectiveFrom > today) return `starts on ${formatDate(r.effectiveFrom)}`;
  return `ended on ${formatDate(r.effectiveTo)}`;
}

function MandatoryDocumentsScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Mandatory documents</h1>
      {can(REQUIREMENT_READ) ? (
        <MandatoryTypes />
      ) : (
        <Section title="Mandatory document types">
          <NotPermitted>The selected role cannot read the mandatory document types.</NotPermitted>
        </Section>
      )}
      {can(COMPLIANCE_EXPORT) ? (
        <ComplianceReportForm />
      ) : (
        <Section title="Employee document compliance">
          <NotPermitted>The compliance report needs its own confidential grant: which employee lacks which document comes from their confidential documents.</NotPermitted>
        </Section>
      )}
    </>
  );
}

function MandatoryTypes() {
  const { can, stored } = useSession();
  const qc = useQueryClient();
  const key = ['documents', `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`, 'requirements'] as const;
  const list = useQuery({ queryKey: key, queryFn: () => api<RequirementList>('/v1/document-requirements'), retry: retryTransient });
  const [ending, setEnding] = useState<Requirement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = () => void qc.invalidateQueries({ queryKey: key });
  const data = list.data;
  const canManage = can(REQUIREMENT_MANAGE);
  return (
    <Section title="Mandatory document types">
      <p className="hint">
        Each employee must hold a document of every type in force for them: the company-wide ones and those of their employment type. A requirement starts today or later and is ended with a
        reason; it is never edited or deleted, so earlier days keep the rules they had.
      </p>
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {list.isPending && <p className="hint">Loading the mandatory document types…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot read the mandatory document types.</NotPermitted> : <ErrorNote error={list.error} />}
      {data && data.items.length === 0 && <Empty>No document type is mandatory yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Mandatory document types">
            <thead>
              <tr>
                <th scope="col">Document type</th>
                <th scope="col">Employees</th>
                <th scope="col">From</th>
                <th scope="col">Status</th>
                <th scope="col">Reason</th>
                {canManage && (
                  <th scope="col">
                    <span style={SR_ONLY}>Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.documentType.label}</td>
                  <td>{r.employmentType ? `${r.employmentType.label} only` : 'All employment types'}</td>
                  <td>{formatDate(r.effectiveFrom)}</td>
                  <td>
                    <Badge tone={r.inForceToday ? 'good' : 'neutral'}>{requirementState(r, data.businessDate)}</Badge>
                  </td>
                  <td>
                    {r.reason}
                    {r.endReason && <div className="hint">{`Ended: ${r.endReason}`}</div>}
                  </td>
                  {canManage && (
                    <td>
                      {r.effectiveTo === null && (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`End the requirement for ${r.documentType.label}${r.employmentType ? ` (${r.employmentType.label})` : ''}`}
                          onClick={() => {
                            setEnding(r);
                            setNotice(null);
                          }}
                        >
                          End
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && canManage && ending && (
        <EndRequirementForm
          key={ending.id}
          requirement={ending}
          today={data.businessDate}
          onCancel={() => setEnding(null)}
          onDone={(text) => {
            setEnding(null);
            setNotice(text);
            reload();
          }}
          onStale={reload}
        />
      )}
      {data && canManage && (
        <AddRequirementForm
          list={data}
          onDone={(text) => {
            setNotice(text);
            reload();
          }}
        />
      )}
    </Section>
  );
}

function AddRequirementForm({ list, onDone }: { list: RequirementList; onDone: (text: string) => void }) {
  const [documentType, setDocumentType] = useState('');
  const [employmentType, setEmploymentType] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(list.businessDate);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, string>) => api<Requirement>('/v1/document-requirements', { body }),
    onSuccess: (r) => {
      onDone(`${r.documentType.label} is mandatory for ${r.employmentType ? `${r.employmentType.label} employees` : 'every employee'} from ${formatDate(r.effectiveFrom)}.`);
      setDocumentType('');
      setEmploymentType('');
      setReason('');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    if (!documentType) return setProblem('Choose the document type.');
    if (!effectiveFrom || effectiveFrom < list.businessDate) return setProblem('Choose today or a later start date.');
    if (!reason.trim()) return setProblem('Say why the document type becomes mandatory.');
    setProblem(null);
    save.mutate({ documentType, ...(employmentType ? { employmentType } : {}), effectiveFrom, reason: reason.trim() });
  };
  return (
    <form className="grid-form" aria-label="New mandatory document type" onSubmit={submit} noValidate>
      <h3>Make a document type mandatory</h3>
      <label>
        Document type
        <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
          <option value="">Choose…</option>
          {list.options.documentTypes.map((o) => (
            <option key={o.code} value={o.code}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        For
        <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
          <option value="">All employment types</option>
          {list.options.employmentTypes.map((o) => (
            <option key={o.code} value={o.code}>
              {`${o.label} only`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Starts on
        <input type="date" value={effectiveFrom} min={list.businessDate} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </label>
      <label>
        Reason
        <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          Make it mandatory
        </button>
      </div>
      <Refusal error={save.error} words={REQUIREMENT_WORDS} />
    </form>
  );
}

function EndRequirementForm({ requirement: r, today, onCancel, onDone, onStale }: { requirement: Requirement; today: string; onCancel: () => void; onDone: (text: string) => void; onStale: () => void }) {
  const [effectiveTo, setEffectiveTo] = useState(today);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api<Requirement>(`/v1/document-requirements/${r.id}/end`, { body: { effectiveTo, reason: reason.trim(), expectedVersion: r.version } }),
    onSuccess: (ended) => onDone(`${ended.documentType.label} is no longer mandatory from ${formatDate(ended.effectiveTo)}${ended.employmentType ? ` for ${ended.employmentType.label} employees` : ''}.`),
    onError: (err) => {
      if (err instanceof ApiError && (err.code === 'VERSION_CONFLICT' || err.code === 'ALREADY_ENDED')) onStale();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    if (!effectiveTo || effectiveTo < today) return setProblem('Choose today or a later date.');
    if (!reason.trim()) return setProblem('Say why the requirement ends.');
    setProblem(null);
    save.mutate();
  };
  return (
    <form className="grid-form" aria-label="End a mandatory document type" onSubmit={submit} noValidate>
      <h3>{`End: ${r.documentType.label}${r.employmentType ? ` (${r.employmentType.label} only)` : ''}`}</h3>
      <label>
        No longer mandatory from
        <input type="date" value={effectiveTo} min={today} onChange={(e) => setEffectiveTo(e.target.value)} />
      </label>
      <label>
        Reason
        <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          End the requirement
        </button>
        <button type="button" className="secondary" disabled={save.isPending} onClick={onCancel}>
          Keep it
        </button>
      </div>
      <Refusal error={save.error} words={REQUIREMENT_WORDS} />
    </form>
  );
}

/** The report's filters (compliance.ts): department, location, employee status, as on a day; generated in the background. */
function ComplianceReportForm() {
  const { can } = useSession();
  const canOrg = can(ORG_READ);
  const departments = useQuery({ queryKey: ['compliance-departments'], queryFn: () => api<{ items: { id: string; code: string; name: string }[] }>('/v1/org/departments'), enabled: canOrg, retry: retryTransient });
  const locations = useQuery({ queryKey: ['compliance-locations'], queryFn: () => api<{ items: { id: string; code: string; name: string }[] }>('/v1/org/locations'), enabled: canOrg, retry: retryTransient });
  const [departmentId, setDepartmentId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [statusGroup, setStatusGroup] = useState('ACTIVE');
  const [asOn, setAsOn] = useState('');
  const filters: Record<string, string> = {
    ...(departmentId ? { departmentId } : {}),
    ...(locationId ? { locationId } : {}),
    ...(statusGroup && statusGroup !== 'ACTIVE' ? { statusGroup } : {}),
    ...(asOn ? { to: asOn } : {}),
  };
  return (
    <Section title="Employee document compliance">
      <p className="hint">
        The employees in the selected role’s scope who miss a mandatory document type, with the missing types and their count. A rejected, expired or quarantined document does not count; one
        waiting for its scan or verification does. Generated as a file in the background, then downloaded here or from Reports.
      </p>
      <form className="grid-form" aria-label="Compliance report filters" onSubmit={keepOnPage}>
        {canOrg && (
          <>
            <label>
              Department
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">All departments in scope</option>
                {(departments.data?.items ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Location
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">All locations in scope</option>
                {(locations.data?.items ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          Employees
          <select value={statusGroup} onChange={(e) => setStatusGroup(e.target.value)}>
            <option value="ACTIVE">Active (probation, confirmed, notice)</option>
            <option value="ON_PROBATION">On probation</option>
            <option value="ON_NOTICE">On notice</option>
            <option value="LEFT">Left</option>
          </select>
        </label>
        <label>
          As on (blank: today)
          <input type="date" value={asOn} onChange={(e) => setAsOn(e.target.value)} />
        </label>
      </form>
      <ReportExport reportCode="EMPLOYEE_DOCUMENT_COMPLIANCE" filters={filters} label="Generate the compliance report" />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Export employee documents to a ZIP (CL-027; 0281): filters department, document type and employee; first what would be exported,
// then the archive, built by the server for the selected role's scope with only files the malware scan released. The server
// enforces every rule and bound; this screen shows what it answered, and the export log.
// ---------------------------------------------------------------------------------------------------------
/** GET /v1/documents/export/* and /v1/documents/exports: the bulk export right, beside the single download's read right. */
const DOCUMENT_EXPORT = 'document.export.document';
const DOCUMENT_READ = 'document.read.document';
const EXPORT_PATH = '/documents/export';

interface ExportOptions {
  departments: { id: string; code: string; name: string; active: boolean }[];
  documentTypes: { code: string; label: string; active: boolean }[];
  limits: { files: number; bytes: number };
}
interface ExportSummary {
  documents: number;
  employees: number;
  bytes: number;
  withheld: number;
  withinLimits: boolean;
  limits: { files: number; bytes: number };
}
interface ExportLogItem {
  id: string;
  exportedAt: string;
  documentCount: number;
  employeeCount: number;
  byteSize: string;
  withheldCount: number;
  exportedByName: string | null;
  department: { code: string; name: string } | null;
  documentType: { code: string; label: string } | null;
  employee: { employeeCode: string; displayName: string } | null;
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

const EXPORT_WORDS: Words = {
  NOTHING_TO_EXPORT: (e) => {
    const withheld = (e.details as { withheld?: number } | undefined)?.withheld ?? 0;
    return `No released document matches these filters, so nothing was exported.${withheld > 0 ? ` ${plural(withheld, 'file waits', 'files wait')} for the malware scan or ${withheld === 1 ? 'was' : 'were'} quarantined.` : ''}`;
  },
  EXPORT_TOO_LARGE: (e) => {
    const d = (e.details ?? {}) as { documents?: number; bytes?: number; maxFiles?: number; maxBytes?: number };
    return `This selection is too large for one archive (${plural(d.documents ?? 0, 'file', 'files')}, ${megabytes(d.bytes ?? 0)}; at most ${d.maxFiles ?? 200} files and ${megabytes(d.maxBytes ?? 0)}). Narrow the filters and export in parts.`;
  },
  NOT_FOUND: 'No employee with this code is in the selected role’s scope.',
  UNKNOWN_DEPARTMENT: 'There is no such department.',
  UNKNOWN_DOCUMENT_TYPE: 'There is no such document type.',
  FORBIDDEN: 'The selected role cannot export employee documents: it needs both the export right and the right to read documents.',
};

function DocumentExportScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Export documents</h1>
      {can(DOCUMENT_EXPORT) && can(DOCUMENT_READ) ? (
        <DocumentExport />
      ) : (
        <Section title="Export documents">
          <NotPermitted>The selected role cannot export employee documents: it needs both the export right and the right to read documents.</NotPermitted>
        </Section>
      )}
    </>
  );
}

function DocumentExport() {
  const qc = useQueryClient();
  const options = useQuery({ queryKey: ['document-export-options'], queryFn: () => api<ExportOptions>('/v1/documents/export/options'), retry: retryTransient });
  const [departmentId, setDepartmentId] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  const query = new URLSearchParams({
    ...(departmentId ? { departmentId } : {}),
    ...(documentType ? { documentType } : {}),
    ...(employeeCode.trim() ? { employeeCode: employeeCode.trim() } : {}),
  }).toString();
  // What the archive would hold for exactly these filters; any change of filter asks again.
  const [checked, setChecked] = useState<{ query: string; summary: ExportSummary } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: () => api<ExportSummary>(`/v1/documents/export/summary${query ? `?${query}` : ''}`),
    onMutate: () => setDone(null),
    onSuccess: (summary) => setChecked({ query, summary }),
  });
  const save = useMutation({
    mutationFn: () => download(`/v1/documents/export${query ? `?${query}` : ''}`),
    onSuccess: () => {
      setDone('The archive was downloaded, and the export is recorded in the log below.');
      void qc.invalidateQueries({ queryKey: ['document-exports'] });
    },
  });
  const current = checked?.query === query ? checked.summary : null;
  const limits = options.data?.limits;
  return (
    <>
      <Section title="Export documents to a ZIP">
        <p className="hint">
          One archive of the employees’ documents in the selected role’s scope: a folder per employee code and an export log (export-log.csv) saying who exported what, when and with which
          filters. Only files the malware scan has released are included; the others are counted and left out.
          {limits ? ` One archive holds at most ${limits.files} files and ${megabytes(limits.bytes)}.` : ''} Every export is recorded, with each document it carried.
        </p>
        <form
          className="grid-form"
          aria-label="Export filters"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!check.isPending) check.mutate();
          }}
        >
          <label>
            Department
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">All departments in scope</option>
              {(options.data?.departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Document type
            <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
              <option value="">All types</option>
              {(options.data?.documentTypes ?? []).map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                  {t.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Employee code (blank: everyone)
            <input value={employeeCode} maxLength={60} onChange={(e) => setEmployeeCode(e.target.value)} />
          </label>
          <button type="submit" disabled={check.isPending}>
            Check what would be exported
          </button>
        </form>
        <ErrorNote error={options.error} />
        <Refusal error={check.error} words={EXPORT_WORDS} />
        {current && (
          <div className="stack">
            <p role="status">
              {current.documents === 0
                ? 'No released document matches these filters.'
                : `${plural(current.documents, 'file', 'files')} of ${plural(current.employees, 'employee', 'employees')}, ${megabytes(current.bytes)}.`}
              {current.withheld > 0 ? ` ${plural(current.withheld, 'matching file is', 'matching files are')} not released by the malware scan and will be left out.` : ''}
            </p>
            {!current.withinLimits && <p className="error">This is more than one archive holds. Narrow the filters and export in parts.</p>}
            {current.documents > 0 && current.withinLimits && (
              <p>
                <button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
                  Download the ZIP
                </button>
              </p>
            )}
          </div>
        )}
        {done && <p role="status">{done}</p>}
        <Refusal error={save.error} words={EXPORT_WORDS} />
      </Section>
      <ExportLog />
    </>
  );
}

/** The export log (GET /v1/documents/exports): who exported, when, with which filters, and how many files. */
function ExportLog() {
  const [page, setPage] = useState(1);
  const log = useQuery({ queryKey: ['document-exports', page], queryFn: () => api<{ items: ExportLogItem[]; total: number }>(`/v1/documents/exports?page=${page}&pageSize=25`), retry: retryTransient });
  const items = log.data?.items ?? [];
  return (
    <Section title="Export log">
      <ErrorNote error={log.error} />
      {log.isSuccess && items.length === 0 && <Empty>No export yet.</Empty>}
      {items.length > 0 && (
        <table aria-label="Export log">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">By</th>
              <th scope="col">Filters</th>
              <th scope="col">Files</th>
              <th scope="col">Employees</th>
              <th scope="col">Left out (not released)</th>
            </tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.id}>
                <td>{new Date(x.exportedAt).toLocaleString()}</td>
                <td>{x.exportedByName ?? '—'}</td>
                <td>
                  {[x.department ? `Department ${x.department.name}` : null, x.documentType ? `Type ${x.documentType.label}` : null, x.employee ? `Employee ${x.employee.employeeCode}` : null]
                    .filter(Boolean)
                    .join('; ') || 'None'}
                </td>
                <td>{x.documentCount}</td>
                <td>{x.employeeCount}</td>
                <td>{x.withheldCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager page={page} pageSize={25} total={log.data?.total ?? 0} onPage={setPage} label="Export log pages" noun="export" />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Registry exports (screens.ts types; screens-registry.ts)
// ---------------------------------------------------------------------------------------------------------
export const DOCUMENTS_SCREENS: ScreenRoute[] = [
  { path: PATHS.policies, title: 'Company policies', permission: POLICY_READ, nav: true, component: PoliciesScreen },
  { path: '/policies/:id', title: 'Company policy', permission: POLICY_READ, nav: false, component: PolicyScreen },
  { path: PATHS.manage, title: 'Policy upload', permission: POLICY_MANAGE, nav: true, component: ManagePoliciesScreen },
  { path: '/documents/policies/:id', title: 'Manage company policy', permission: POLICY_MANAGE, nav: false, component: ManagePolicyScreen },
  { path: PATHS.mapping, title: 'Bulk document mapping', permission: DOCUMENT_UPLOAD, nav: true, component: BulkMappingScreen },
  // CL-150 (0261): the mandatory document types and the compliance report.
  { path: REQUIREMENTS_PATH, title: 'Mandatory documents', permission: REQUIREMENT_READ, nav: true, component: MandatoryDocumentsScreen },
  // CL-027 (0281): employee documents exported to a ZIP, with the export log.
  { path: EXPORT_PATH, title: 'Export documents', permission: DOCUMENT_EXPORT, nav: true, component: DocumentExportScreen },
];

/** H3 has no company-policy tab (TN01–TN18), so employees read policies on the Company policies screen instead. */
export const DOCUMENTS_ESS_PANELS: EssPanel[] = [];

/** Policies and document mapping route no decision to a reviewer, so the module has no decision queue. */
export const DOCUMENTS_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [];
