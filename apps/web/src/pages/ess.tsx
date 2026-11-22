import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ButtonRow, CheckField, FormField, FormGrid, LabelledFieldset } from '@/components/form-field';
import { Hint, HintLine } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Tab, TabList } from '@/components/tab-list';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { api, formatDate, idempotencyKey } from '../api';
import { ESS_PANELS_BY_TAB } from '../screens-registry';
import { useSession } from '../session';
import { Badge, CompactEmptyContext, Empty, ErrorNote, LIST_PAGE_SIZE, Notice, Pager, pageParams, Section, StateBadge } from '../ui';
import { DelegatedBadge } from './delegations';

// ---------------------------------------------------------------------------------------------------------
// My ESS (FR-103 to FR-105, FR-109; H3 TN01–TN18). Every tab comes from the API, which decides availability for the
// Employee OWN context; an unavailable tab shows its named reason and links nowhere. Private changes are requests:
// nothing here edits the master record (BR-054).
// ---------------------------------------------------------------------------------------------------------

// Layout pieces of these screens, as utility classes (shadcn/ui move, 20 Nov 2026).
/** The tab groups in one framed box on the card colour, a group to a row (the old `.ess-tabs`). */
const TAB_GROUPS = 'flex flex-col rounded-xl border border-border bg-card px-[1.1rem] py-[0.6rem] shadow-xs';
/** One group's row: its name, then its tabs (a TabList named after the group). */
const TAB_GROUP = 'flex w-full flex-wrap items-center gap-x-4 gap-y-2 border-border py-2';
/** A row after the first is parted from the one above by a hairline. */
const LATER_TAB_GROUP = 'border-t';
/** A group's name, in small capitals beside its tabs; on a phone it takes a line of its own above them. */
const GROUP_NAME = 'flex-[0_0_10rem] text-[0.72rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase phone:basis-full';
/** The tabs not available yet, folded under one muted line between the cards (the old `details.hint`). */
const UNAVAILABLE = 'm-0 text-[0.84rem] text-muted-foreground';
/** The line that opens them, a 44px target on a phone. */
const UNAVAILABLE_SUMMARY = 'w-max cursor-pointer font-semibold phone:py-3';
/** A field in a stacked part keeps the old 560px limit, so a wide card does not stretch it. */
const FIELD_WIDTH = 'max-w-[560px]';
/**
 * A change to review: a card inside the queue's card, its parts in the flow of text (the delegation badge follows the title on its
 * line). It keeps the `card` marker class, so its notes are drawn as a card's own, as they were before the move to shadcn/ui.
 */
const REVIEW_CARD = 'card rounded-xl border border-border bg-card px-5 py-4 shadow-xs';
/** A date in a list stays on one line ("3 Nov 2026", not "3 Nov" over "2026"). */
const DATE_CELL = 'whitespace-nowrap';

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

/**
 * The warning as a status in the warning tint; its sentence, badge first, is one run of text beside the mark. It reads left to right,
 * though on a phone a table cell's values are right-aligned.
 */
function CutoffWarning({ warning }: { warning: PayrollCutoffWarning }) {
  return (
    <Alert asChild variant="warning" className="text-left">
      <p role="status">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertDescription asChild className="block">
          <span>
            <Badge tone="warn">after payroll cutoff</Badge>{' '}
            {`This bank change takes effect on ${formatDate(warning.effectiveDate)}, after the input cutoff (${formatDate(warning.inputCutoff)}) of payroll period ${warning.periodCode}. ` +
              `The ${warning.periodCode} payment due on ${formatDate(warning.paymentDate)} may still be made to the current bank account.`}
          </span>
        </AlertDescription>
      </p>
    </Alert>
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

/** A tab's name in the app's sentence case ("My Profile" from the server reads "My profile"). */
const tabName = (name: string) => (name === 'My Profile' ? 'My profile' : name);

export function MyEssPage() {
  const index = useQuery({ queryKey: ['ess-index'], queryFn: () => api<EssIndex>('/v1/me/ess') });
  // A link may open a given tab (/me?tab=TN13 from the Timesheets list); otherwise the profile tab.
  const [params] = useSearchParams();
  const [selected, setSelected] = useState(() => params.get('tab') ?? 'TN01');
  if (index.error) return <ErrorNote error={index.error} />;
  if (!index.data) return <p>Loading…</p>;
  const { context, tabs } = index.data;
  const available = tabs.filter((t) => t.status === 'AVAILABLE');
  const tab = tabs.find((t) => t.id === selected) ?? available[0] ?? tabs[0]!;
  // Only what the employee can use is a tab; an unavailable one is listed once, with its reason, below the tabs. One opened by a
  // link (/me?tab=…) keeps its tab, so its reason shows in the panel.
  const shownTabs = tabs.filter((t) => t.status === 'AVAILABLE' || t.id === tab.id);
  const unavailable = tabs.filter((t) => !shownTabs.includes(t));
  const sections = [...new Set(shownTabs.map((t) => t.section))];
  return (
    <>
      {/* H3: the own-record context indicator, in the reader's words. */}
      <Hint aria-label="Own record">
        Your own requests and records{context.employeeName ? ` · ${context.employeeName}` : ''}
        {context.employeeCode ? ` (${context.employeeCode})` : ''}
      </Hint>
      <div className={TAB_GROUPS}>
        {sections.map((section, index) => (
          <div key={section} className={cn(TAB_GROUP, index > 0 && LATER_TAB_GROUP)}>
            <strong className={GROUP_NAME}>{section}</strong>
            <TabList aria-label={section}>
              {shownTabs
                .filter((t) => t.section === section)
                .map((t) => (
                  <Tab key={t.id} id={`ess-tab-${t.id}`} selected={t.id === tab.id} aria-controls="ess-panel" onClick={() => setSelected(t.id)}>
                    {tabName(t.name)}
                  </Tab>
                ))}
            </TabList>
          </div>
        ))}
      </div>
      {unavailable.length > 0 && (
        <details className={UNAVAILABLE}>
          <summary className={UNAVAILABLE_SUMMARY}>{`Not available to you yet (${unavailable.length})`}</summary>
          <ul aria-label="Not available yet">
            {unavailable.map((t) => (
              <li key={t.id}>{`${tabName(t.name)}: ${t.unavailable?.message ?? 'Not available.'}`}</li>
            ))}
          </ul>
        </details>
      )}
      <div role="tabpanel" id="ess-panel" aria-labelledby={`ess-tab-${tab.id}`}>
        <CompactEmptyContext.Provider value={true}>
          <TabPanel tab={tab} />
        </CompactEmptyContext.Provider>
      </div>
    </>
  );
}

function TabPanel({ tab }: { tab: EssTab }) {
  const { me } = useSession();
  if (tab.status !== 'AVAILABLE') {
    return (
      <Section title={tabName(tab.name)}>
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
  const screenLink = screen && (
    <Button asChild variant="outline" size="sm">
      <Link to={screen.to.replace('{employeeId}', me?.employeeId ?? '')}>{screen.label}</Link>
    </Button>
  );
  return (
    <Section title={tab.name} actions={screenLink}>
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
    <dl className="kv">
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
    <Section title="My profile">
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
      <Hint>
        Changes to your {CATEGORY_LABEL[category]} are requests: an HR Administrator reviews them before anything changes.
        {category === 'BANK' ? ' A bank change needs a supporting document. A change after the payroll cutoff applies to later payments.' : ''}
      </Hint>
      <ErrorNote error={requests.error ?? act.error} />
      {submitted && (
        <>
          <Notice notice={{ text: 'Request submitted for review.', ok: true }} />
          {submitted.warning && !listedWarning(submitted.requestId) && <CutoffWarning warning={submitted.warning} />}
        </>
      )}
      {mine.length === 0 ? (
        <Empty>No requests yet.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Requested</TableHead>
              <TableHead scope="col">Effective</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Notes</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mine.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  {r.changedFields.map((f) => (
                    <div key={f}>
                      {labelOf(category, f)}: {r.proposed[f] ?? '(cleared)'}
                    </div>
                  ))}
                </TableCell>
                <TableCell className={DATE_CELL}>{formatDate(r.effectiveDate)}</TableCell>
                <TableCell>
                  <StateBadge state={r.state} />
                  {r.pendingWith ? <HintLine>with {r.pendingWith}</HintLine> : null}
                </TableCell>
                <TableCell>
                  {r.employeeMessage ?? (r.state === 'CONFLICT' ? 'Your details changed meanwhile; revise and submit again.' : '')}
                  {r.payrollCutoffWarning && <CutoffWarning warning={r.payrollCutoffWarning} />}
                </TableCell>
                <RowActionsCell>
                  <RowActions>
                    {canSubmit && r.state === 'DRAFT' && (
                      <Button type="button" size="sm" onClick={() => act.mutate({ r, action: 'submit' })}>
                        Submit
                      </Button>
                    )}
                    {canSubmit && ['DRAFT', 'SUBMITTED', 'IN_REVIEW'].includes(r.state) && (
                      <Button type="button" variant="danger" size="sm" onClick={() => act.mutate({ r, action: 'withdraw' })}>
                        Withdraw
                      </Button>
                    )}
                    {canSubmit && ['RETURNED', 'CONFLICT'].includes(r.state) && (
                      <Button type="button" size="sm" onClick={() => act.mutate({ r, action: 'revise' })}>
                        Revise
                      </Button>
                    )}
                  </RowActions>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {canSubmit && (
        <FormGrid
          key={formKey}
          aria-label={`New ${CATEGORY_LABEL[category]} request`}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <h3>New request</h3>
          {CHANGE_FIELDS[category].map((f) => (
            <FormField key={f.key}>
              {f.label}
              <Input type={f.type ?? 'text'} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            </FormField>
          ))}
          <FormField>
            Effective from (leave empty for today)
            <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </FormField>
          <FormField>
            Reason
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          {documents.data && documents.data.items.length > 0 && (
            <LabelledFieldset legend="Supporting documents">
              {documents.data.items.map((d) => (
                <CheckField key={d.id}>
                  <input
                    type="checkbox"
                    checked={evidence.includes(d.id)}
                    onChange={(e) => setEvidence(e.target.checked ? [...evidence, d.id] : evidence.filter((x) => x !== d.id))}
                  />
                  {d.fileName ?? d.documentType}
                </CheckField>
              ))}
            </LabelledFieldset>
          )}
          <ErrorNote error={save.error} />
          <Button type="submit" disabled={Object.keys(typed).length === 0 || reason.trim() === '' || save.isPending}>
            Save draft
          </Button>
        </FormGrid>
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Raised</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Decisions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.data.items.map((r) => (
            <TableRow key={r.transactionId}>
              <TableCell className={DATE_CELL}>{formatDate(r.createdAt)}</TableCell>
              <TableCell>
                <StateBadge state={r.state} />
                {r.pendingWith ? <HintLine>with {r.pendingWith}</HintLine> : null}
                {r.predecessorRequestId ? <HintLine>Raised again after a rejected request</HintLine> : null}
              </TableCell>
              <TableCell>{r.decisions.length === 0 ? '—' : r.decisions.map((d) => `step ${d.step}: ${d.decision.toLowerCase()} on ${formatDate(d.decidedAt)}`).join('; ')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
          <Notice notice={{ text: `${decided.label}: ${DECIDED_STATE[decided.result.state] ?? decided.result.state.replace(/_/g, ' ').toLowerCase()}.`, ok: true }} />
          {decided.result.payrollCutoffWarning && <CutoffWarning warning={decided.result.payrollCutoffWarning} />}
        </>
      )}
      {items.length === 0 ? (
        <Empty>No changes are waiting for you.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((t) => (
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
          ))}
        </div>
      )}
    </Section>
  );
}

/** The evidence a change carries, by document type; when it has none, whether it needs some. */
function evidenceText(r: NonNullable<ReviewTask['request']>): string {
  if (r.evidence.length > 0) return r.evidence.map((e) => e.documentType).join(', ');
  return r.evidenceRequired ? 'required but missing' : 'none';
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
    <article className={REVIEW_CARD} aria-label={`Change of ${CATEGORY_LABEL[r.category]} for ${r.employeeName}`}>
      <h3 className="mt-0">
        {r.employeeName} ({r.employeeCode}): {CATEGORY_LABEL[r.category]}, effective {formatDate(r.effectiveDate)} <StateBadge state={r.state} />
      </h3>
      <DelegatedBadge taskId={task.taskId} />
      {!r.baseHolds && <Notice notice={{ text: "The employee's approved details changed after this request was based on them; approving will end it in conflict.", ok: false }} />}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Field</TableHead>
            <TableHead scope="col">Now</TableHead>
            <TableHead scope="col">Requested</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {r.changedFields.map((f) => (
            <TableRow key={f}>
              <TableCell>{labelOf(r.category, f)}</TableCell>
              <TableCell>{r.before[f] ?? '—'}</TableCell>
              <TableCell>{r.proposed[f] ?? '(cleared)'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p>Employee&apos;s reason: {r.reason}</p>
      <p>
        Evidence: {evidenceText(r)}
      </p>
      {r.payrollCutoffWarning && <CutoffWarning warning={r.payrollCutoffWarning} />}
      <ErrorNote error={start.error ?? decide.error} />
      {r.state === 'SUBMITTED' ? (
        <Button type="button" className="mt-3" onClick={() => start.mutate()} disabled={start.isPending}>
          Start review
        </Button>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <FormField className={FIELD_WIDTH}>
            Private note (required to approve; never shown to the employee)
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <FormField className={FIELD_WIDTH}>
            Message to the employee (required to return or reject)
            <Input value={message} onChange={(e) => setMessage(e.target.value)} />
          </FormField>
          <ButtonRow>
            <Button type="button" disabled={!reason.trim() || decide.isPending} onClick={() => decide.mutate('APPROVE')}>
              Approve
            </Button>
            <Button type="button" variant="outline" disabled={!message.trim() || decide.isPending} onClick={() => decide.mutate('RETURN')}>
              Return
            </Button>
            <Button type="button" variant="outline" disabled={!message.trim() || decide.isPending} onClick={() => decide.mutate('REJECT')}>
              Reject
            </Button>
          </ButtonRow>
        </div>
      )}
    </article>
  );
}
