import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, idempotencyKey } from '../api';
import { ESS_PANELS_BY_TAB } from '../screens-registry';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section, StateBadge } from '../ui';
import { DelegatedBadge } from './delegations';

// ---------------------------------------------------------------------------------------------------------
// My ESS (FR-103 to FR-105, FR-109; H3 TN01–TN18). Every tab comes from the API, which decides availability for the
// Employee OWN context; an unavailable tab shows its named reason and links nowhere. Private changes are requests:
// nothing here edits the master record (BR-054).
// ---------------------------------------------------------------------------------------------------------

interface EssTab {
  id: string;
  name: string;
  section: string;
  status: 'AVAILABLE' | 'NOT_PERMITTED' | 'UNAVAILABLE';
  unavailable?: { code: string; message: string };
  links: { rel: string; method: string; href: string }[];
}
interface EssIndex {
  context: { employeeId: string; employeeCode: string | null; employeeName: string | null; roleCode: string; scopeKind: string };
  tabs: EssTab[];
}

type Category = 'PERSONAL' | 'ADDRESS' | 'BANK';
interface FieldSpec {
  key: string;
  label: string;
  type?: 'date' | 'email' | 'tel';
  required?: boolean;
}
/** The H4 field dictionary (I-18); the server validates every value again. */
export const CHANGE_FIELDS: Record<Category, FieldSpec[]> = {
  PERSONAL: [
    { key: 'personalEmail', label: 'Personal email', type: 'email' },
    { key: 'personalPhone', label: 'Personal phone', type: 'tel' },
    { key: 'dateOfBirth', label: 'Date of birth', type: 'date' },
    { key: 'emergencyContactName', label: 'Emergency contact name' },
    { key: 'emergencyContactRelationship', label: 'Emergency contact relationship' },
    { key: 'emergencyContactPhone', label: 'Emergency contact phone', type: 'tel' },
  ],
  ADDRESS: [
    { key: 'line1', label: 'Address line 1', required: true },
    { key: 'line2', label: 'Address line 2' },
    { key: 'city', label: 'City', required: true },
    { key: 'region', label: 'State or region' },
    { key: 'postalCode', label: 'Postal code' },
    { key: 'countryCode', label: 'Country code (2 letters)', required: true },
  ],
  BANK: [
    { key: 'holderName', label: 'Account holder name', required: true },
    { key: 'accountIdentifier', label: 'Account identifier', required: true },
    { key: 'routingReference', label: 'Bank routing reference' },
    { key: 'countryCode', label: 'Bank country code (2 letters)', required: true },
  ],
};
const CATEGORY_OF_TAB: Record<string, Category> = { TN02: 'PERSONAL', TN03: 'BANK', TN04: 'ADDRESS' };
const CATEGORY_LABEL: Record<Category, string> = { PERSONAL: 'personal details', ADDRESS: 'address', BANK: 'bank details' };
const labelOf = (category: Category, key: string) => CHANGE_FIELDS[category].find((f) => f.key === key)?.label ?? key;

/**
 * FR-105 / H3 TN03 / H4 (modules/payroll/cutoff.ts): a bank change effective after the input cutoff of the employee's
 * current open payroll period. A warning only: the submission or decision went through. It names the period and its
 * dates, never a bank value.
 */
interface PayrollCutoffWarning {
  code: 'AFTER_PAYROLL_CUTOFF';
  calendarCode: string;
  periodCode: string;
  inputCutoff: string;
  paymentDate: string;
  effectiveDate: string;
  message: string;
}

function CutoffWarning({ warning }: { warning: PayrollCutoffWarning }) {
  return (
    <p role="status">
      <Badge tone="warn">after payroll cutoff</Badge>{' '}
      {`This bank change takes effect on ${formatDate(warning.effectiveDate)}, after the input cutoff (${formatDate(warning.inputCutoff)}) of payroll period ${warning.periodCode}. ` +
        `The ${warning.periodCode} payment due on ${formatDate(warning.paymentDate)} may still be made to the current bank account.`}
    </p>
  );
}

/** Screens of this app that serve a tab; the server still decides what each one shows. */
const TAB_SCREENS: Record<string, { to: string; label: string; kind?: string }> = {
  TN05: { to: '/employees/{employeeId}/documents', label: 'Open my documents' },
  TN10: { to: '/leave', label: 'Open leave', kind: 'leave_request' },
  TN11: { to: '/me/attendance', label: 'Open my attendance' },
  TN12: { to: '/me/attendance', label: 'Open regularization', kind: 'attendance_correction' },
  TN14: { to: '/expenses', label: 'Open expenses', kind: 'expense_claim' },
};

export function MyEssPage() {
  const index = useQuery({ queryKey: ['ess-index'], queryFn: () => api<EssIndex>('/v1/me/ess') });
  const [selected, setSelected] = useState('TN01');
  if (index.error) return <ErrorNote error={index.error} />;
  if (!index.data) return <p>Loading…</p>;
  const { context, tabs } = index.data;
  const tab = tabs.find((t) => t.id === selected) ?? tabs[0]!;
  const sections = [...new Set(tabs.map((t) => t.section))];
  return (
    <>
      {/* H3: the own-record context indicator. */}
      <p className="hint" aria-label="Own record">
        My ESS for {context.employeeName ?? 'your record'}
        {context.employeeCode ? ` (${context.employeeCode})` : ''} · Employee role, own record only
      </p>
      <div className="ess-tabs">
        {sections.map((section) => (
          <div key={section} role="tablist" aria-label={section}>
            <strong>{section}</strong>
            {tabs
              .filter((t) => t.section === section)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`ess-tab-${t.id}`}
                  aria-selected={t.id === tab.id}
                  aria-controls="ess-panel"
                  className={t.id === tab.id ? '' : 'secondary'}
                  onClick={() => setSelected(t.id)}
                >
                  {t.name}
                  {t.status !== 'AVAILABLE' ? ' (unavailable)' : ''}
                </button>
              ))}
          </div>
        ))}
      </div>
      <div role="tabpanel" id="ess-panel" aria-labelledby={`ess-tab-${tab.id}`}>
        <TabPanel tab={tab} />
      </div>
    </>
  );
}

function TabPanel({ tab }: { tab: EssTab }) {
  const { me } = useSession();
  if (tab.status !== 'AVAILABLE') {
    return (
      <Section title={tab.name}>
        <Empty>{tab.unavailable?.message ?? 'Not available.'}</Empty>
      </Section>
    );
  }
  // Wave-2 modules serve their own tabs (screens-registry.ts): the API decided the tab is available to this context.
  const ModulePanel = ESS_PANELS_BY_TAB[tab.id];
  if (ModulePanel) return <ModulePanel />;
  const category = CATEGORY_OF_TAB[tab.id];
  if (tab.id === 'TN01') return <PrivateProfilePanel />;
  if (category) return <SensitiveChangePanel category={category} title={tab.name} />;
  const screen = TAB_SCREENS[tab.id];
  return (
    <Section title={tab.name} actions={screen ? <Link to={screen.to.replace('{employeeId}', me?.employeeId ?? '')}>{screen.label}</Link> : undefined}>
      {screen?.kind ? <DecisionHistory key={screen.kind} kind={screen.kind} /> : <Empty>Use the linked screen for this tab.</Empty>}
    </Section>
  );
}

interface PrivateProfile {
  personal?: { revision: number; effectiveFrom: string | null; values: Record<string, string> };
  address?: { revision: number; effectiveFrom: string | null; values: Record<string, string> };
  bank?: { revision: number; effectiveFrom: string | null; masked: boolean; values: Record<string, string | null> | null };
}

function ValueList({ category, values }: { category: Category; values: Record<string, string | null> | null | undefined }) {
  const entries = Object.entries(values ?? {}).filter(([, v]) => v !== null && v !== '');
  if (entries.length === 0) return <Empty>Nothing recorded yet.</Empty>;
  return (
    <dl className="facts">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{labelOf(category, k)}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function PrivateProfilePanel() {
  const profile = useQuery({ queryKey: ['ess-private-profile'], queryFn: () => api<PrivateProfile>('/v1/me/private-profile') });
  if (profile.error) return <ErrorNote error={profile.error} />;
  const p = profile.data;
  return (
    <Section title="My Profile">
      {!p ? (
        <p>Loading…</p>
      ) : (
        <>
          <h3>Personal details</h3>
          <ValueList category="PERSONAL" values={p.personal?.values} />
          <h3>Address</h3>
          <ValueList category="ADDRESS" values={p.address?.values} />
          <h3>Bank details{p.bank?.masked ? ' (masked)' : ''}</h3>
          <ValueList category="BANK" values={p.bank?.values} />
        </>
      )}
    </Section>
  );
}

interface ChangeRequest {
  id: string;
  category: Category;
  state: string;
  effectiveDate: string;
  changedFields: string[];
  proposed: Record<string, string | null>;
  before: Record<string, string | null>;
  employeeMessage: string | null;
  pendingWith: string | null;
  decisions: { decision: string; decidedAt: string }[];
  version: number;
  /** A pending bank change effective after the payroll cutoff (GET /v1/me/sensitive-changes; FR-105). */
  payrollCutoffWarning?: PayrollCutoffWarning;
}
interface OwnDocument {
  id: string;
  documentType: string;
  fileName?: string;
}

function SensitiveChangePanel({ category, title }: { category: Category; title: string }) {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const requests = useQuery({ queryKey: ['ess-sensitive-changes'], queryFn: () => api<{ items: ChangeRequest[] }>('/v1/me/sensitive-changes') });
  const documents = useQuery({
    queryKey: ['ess-own-documents', me?.employeeId],
    enabled: !!me?.employeeId && can('document.read.document'),
    queryFn: () => api<{ items: OwnDocument[] }>(`/v1/employees/${me?.employeeId}/documents`),
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [effectiveDate, setEffectiveDate] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<string[]>([]);
  const [formKey, setFormKey] = useState(0);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['ess-sensitive-changes'] });
    void qc.invalidateQueries({ queryKey: ['ess-private-profile'] });
    void qc.invalidateQueries({ queryKey: ['ess-index'] });
  };
  const typed = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]));
  const save = useMutation({
    mutationFn: () =>
      api('/v1/me/sensitive-changes', {
        body: { category, values: typed, reason: reason.trim(), ...(effectiveDate ? { effectiveDate } : {}), ...(evidence.length ? { evidenceDocumentIds: evidence } : {}) },
      }),
    onSuccess: () => {
      setValues({});
      setEffectiveDate('');
      setReason('');
      setEvidence([]);
      setFormKey((k) => k + 1);
      refresh();
    },
  });
  // What the last submission answered: a bank change after the payroll cutoff carries a warning (FR-105).
  const [submitted, setSubmitted] = useState<{ requestId: string; warning: PayrollCutoffWarning | null } | null>(null);
  const act = useMutation({
    mutationFn: ({ r, action }: { r: ChangeRequest; action: 'submit' | 'withdraw' | 'revise' }) =>
      api<{ requestId?: string; payrollCutoffWarning?: PayrollCutoffWarning }>(`/v1/me/sensitive-changes/${r.id}/${action}`, {
        method: 'POST',
        ...(action === 'submit' ? { body: { expectedVersion: r.version } } : {}),
      }),
    onMutate: () => setSubmitted(null),
    onSuccess: (result, { r, action }) => {
      if (action === 'submit') setSubmitted({ requestId: r.id, warning: result?.payrollCutoffWarning ?? null });
      refresh();
    },
  });
  const mine = (requests.data?.items ?? []).filter((r) => r.category === category);
  // The list carries the warning of every pending bank change; the submission's own copy is shown only until then.
  const listedWarning = (id: string) => mine.some((r) => r.id === id && r.payrollCutoffWarning);
  const canSubmit = can('sensitive_change.submit.private');
  return (
    <Section title={title}>
      <p className="hint">
        Changes to your {CATEGORY_LABEL[category]} are requests: an HR Administrator reviews them before anything changes.
        {category === 'BANK' ? ' A bank change needs a supporting document. A change after the payroll cutoff applies to later payments.' : ''}
      </p>
      <ErrorNote error={requests.error ?? act.error} />
      {submitted && (
        <>
          <p className="ok" role="status">
            Request submitted for review.
          </p>
          {submitted.warning && !listedWarning(submitted.requestId) && <CutoffWarning warning={submitted.warning} />}
        </>
      )}
      {mine.length === 0 ? (
        <Empty>No requests yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Requested</th>
              <th>Effective</th>
              <th>Status</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mine.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.changedFields.map((f) => (
                    <div key={f}>
                      {labelOf(category, f)}: {r.proposed[f] ?? '(cleared)'}
                    </div>
                  ))}
                </td>
                <td>{formatDate(r.effectiveDate)}</td>
                <td>
                  <StateBadge state={r.state} />
                  {r.pendingWith ? <div className="hint">with {r.pendingWith}</div> : null}
                </td>
                <td>
                  {r.employeeMessage ?? (r.state === 'CONFLICT' ? 'Your details changed meanwhile; revise and submit again.' : '')}
                  {r.payrollCutoffWarning && <CutoffWarning warning={r.payrollCutoffWarning} />}
                </td>
                <td>
                  {canSubmit && r.state === 'DRAFT' && (
                    <button type="button" onClick={() => act.mutate({ r, action: 'submit' })}>
                      Submit
                    </button>
                  )}
                  {canSubmit && ['DRAFT', 'SUBMITTED', 'IN_REVIEW'].includes(r.state) && (
                    <button type="button" className="secondary" onClick={() => act.mutate({ r, action: 'withdraw' })}>
                      Withdraw
                    </button>
                  )}
                  {canSubmit && ['RETURNED', 'CONFLICT'].includes(r.state) && (
                    <button type="button" onClick={() => act.mutate({ r, action: 'revise' })}>
                      Revise
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canSubmit && (
        <form
          key={formKey}
          aria-label={`New ${CATEGORY_LABEL[category]} request`}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <h3>New request</h3>
          {CHANGE_FIELDS[category].map((f) => (
            <label key={f.key}>
              {f.label}
              <input type={f.type ?? 'text'} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            </label>
          ))}
          <label>
            Effective from (leave empty for today)
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
          <label>
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {documents.data && documents.data.items.length > 0 && (
            <fieldset>
              <legend>Supporting documents</legend>
              {documents.data.items.map((d) => (
                <label key={d.id}>
                  <input
                    type="checkbox"
                    checked={evidence.includes(d.id)}
                    onChange={(e) => setEvidence(e.target.checked ? [...evidence, d.id] : evidence.filter((x) => x !== d.id))}
                  />
                  {d.fileName ?? d.documentType}
                </label>
              ))}
            </fieldset>
          )}
          <ErrorNote error={save.error} />
          <button type="submit" disabled={Object.keys(typed).length === 0 || reason.trim() === '' || save.isPending}>
            Save draft
          </button>
        </form>
      )}
    </Section>
  );
}

interface OwnRequest {
  transactionId: string;
  requestId: string | null;
  kind: string;
  state: string;
  pendingWith: string | null;
  createdAt: string;
  decisions: { step: number; decision: string; decidedAt: string }[];
  /** DF03: the rejected request this one raises again. */
  predecessorRequestId?: string | null;
}

/** FR-109: own requests with who they wait for and their decisions (never the reviewers' comments), a page at a time (FR-056). */
function DecisionHistory({ kind }: { kind: string }) {
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: ['ess-own-requests', kind, page],
    queryFn: () => api<{ items: OwnRequest[]; total: number }>(`/v1/me/requests?kind=${kind}&${pageParams(page)}`),
  });
  if (history.error) return <ErrorNote error={history.error} />;
  if (!history.data) return <p>Loading…</p>;
  if (history.data.items.length === 0 && page === 1) return <Empty>No requests yet.</Empty>;
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Raised</th>
            <th>Status</th>
            <th>Decisions</th>
          </tr>
        </thead>
        <tbody>
          {history.data.items.map((r) => (
            <tr key={r.transactionId}>
              <td>{formatDate(r.createdAt)}</td>
              <td>
                <StateBadge state={r.state} />
                {r.pendingWith ? <div className="hint">with {r.pendingWith}</div> : null}
                {r.predecessorRequestId ? <div className="hint">Raised again after a rejected request</div> : null}
              </td>
              <td>{r.decisions.length === 0 ? '—' : r.decisions.map((d) => `step ${d.step}: ${d.decision.toLowerCase()} on ${formatDate(d.decidedAt)}`).join('; ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} pageSize={LIST_PAGE_SIZE} total={history.data.total} onPage={setPage} label="Request pages" noun="request" />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Independent HR review of sensitive changes (FR-104, FR-105). The reviewer starts the review, verifies the evidence,
// then approves with a private reason, or returns/rejects with a message the employee will see.
// ---------------------------------------------------------------------------------------------------------

interface ReviewTask {
  taskId: string;
  request:
    | (ChangeRequest & {
        employeeName: string;
        employeeCode: string;
        current: Record<string, string | null> | null;
        baseHolds: boolean;
        evidenceRequired: boolean;
        reason: string;
        evidence: { documentId: string; documentType: string }[];
        /** A bank change effective after the payroll input cutoff (FR-105); absent otherwise. */
        payrollCutoffWarning?: PayrollCutoffWarning;
      })
    | null;
}

/** POST /v1/sensitive-changes/tasks/:id/decision. */
interface DecisionResult {
  requestId: string;
  state: string;
  replayed: boolean;
  payrollCutoffWarning?: PayrollCutoffWarning;
}

const DECIDED_STATE: Record<string, string> = {
  APPLIED: 'approved and applied',
  SCHEDULED: 'approved; it applies on its effective date',
  RETURNED: 'returned to the employee',
  REJECTED: 'rejected',
  CONFLICT: 'ended in conflict, because the employee’s approved details changed meanwhile',
};

export function SensitiveChangeReviewPage() {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['sensitive-review'], queryFn: () => api<{ items: ReviewTask[] }>('/v1/sensitive-changes/tasks/mine') });
  // The decided request leaves the queue, so what its decision answered (a payroll cutoff warning included) is kept here.
  const [decided, setDecided] = useState<{ label: string; result: DecisionResult } | null>(null);
  if (tasks.error) return <ErrorNote error={tasks.error} />;
  if (!tasks.data) return <p>Loading…</p>;
  const items = tasks.data.items.filter((t) => t.request);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['sensitive-review'] });
  return (
    <Section title="Private detail changes to review">
      {decided && (
        <>
          <p className="ok" role="status">
            {decided.label}: {DECIDED_STATE[decided.result.state] ?? decided.result.state.replace(/_/g, ' ').toLowerCase()}.
          </p>
          {decided.result.payrollCutoffWarning && <CutoffWarning warning={decided.result.payrollCutoffWarning} />}
        </>
      )}
      {items.length === 0 ? (
        <Empty>No changes are waiting for you.</Empty>
      ) : (
        items.map((t) => (
          <ReviewItem
            key={t.taskId}
            task={t}
            onStarted={() => {
              setDecided(null);
              refresh();
            }}
            onDecided={(label, result) => {
              setDecided({ label, result });
              refresh();
            }}
          />
        ))
      )}
    </Section>
  );
}

function ReviewItem({ task, onStarted, onDecided }: { task: ReviewTask; onStarted: () => void; onDecided: (label: string, result: DecisionResult) => void }) {
  const r = task.request!;
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const label = `${r.employeeName} (${r.employeeCode}), ${CATEGORY_LABEL[r.category]}`;
  const start = useMutation({ mutationFn: () => api(`/v1/sensitive-changes/tasks/${task.taskId}/start-review`, { method: 'POST' }), onSuccess: onStarted });
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'RETURN' | 'REJECT') =>
      api<DecisionResult>(`/v1/sensitive-changes/tasks/${task.taskId}/decision`, {
        body: { decision, idempotencyKey: idempotencyKey('sensitive'), ...(reason.trim() ? { reason: reason.trim() } : {}), ...(message.trim() ? { employeeMessage: message.trim() } : {}) },
      }),
    onSuccess: (result) => onDecided(label, result),
  });
  return (
    <article className="card" aria-label={`Change of ${CATEGORY_LABEL[r.category]} for ${r.employeeName}`}>
      <h3>
        {r.employeeName} ({r.employeeCode}): {CATEGORY_LABEL[r.category]}, effective {formatDate(r.effectiveDate)} <StateBadge state={r.state} />
      </h3>
      <DelegatedBadge taskId={task.taskId} />
      {!r.baseHolds && (
        <p role="alert" className="error">
          The employee&apos;s approved details changed after this request was based on them; approving will end it in conflict.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Now</th>
            <th>Requested</th>
          </tr>
        </thead>
        <tbody>
          {r.changedFields.map((f) => (
            <tr key={f}>
              <td>{labelOf(r.category, f)}</td>
              <td>{r.before[f] ?? '—'}</td>
              <td>{r.proposed[f] ?? '(cleared)'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Employee&apos;s reason: {r.reason}</p>
      <p>
        Evidence: {r.evidence.length === 0 ? (r.evidenceRequired ? 'required but missing' : 'none') : r.evidence.map((e) => e.documentType).join(', ')}
      </p>
      {r.payrollCutoffWarning && <CutoffWarning warning={r.payrollCutoffWarning} />}
      <ErrorNote error={start.error ?? decide.error} />
      {r.state === 'SUBMITTED' ? (
        <button type="button" onClick={() => start.mutate()} disabled={start.isPending}>
          Start review
        </button>
      ) : (
        <>
          <label>
            Private note (required to approve; never shown to the employee)
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label>
            Message to the employee (required to return or reject)
            <input value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <button type="button" disabled={!reason.trim() || decide.isPending} onClick={() => decide.mutate('APPROVE')}>
            Approve
          </button>
          <button type="button" className="secondary" disabled={!message.trim() || decide.isPending} onClick={() => decide.mutate('RETURN')}>
            Return
          </button>
          <button type="button" className="secondary" disabled={!message.trim() || decide.isPending} onClick={() => decide.mutate('REJECT')}>
            Reject
          </button>
        </>
      )}
    </article>
  );
}
