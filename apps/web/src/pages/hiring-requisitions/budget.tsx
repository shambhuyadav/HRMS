// One manpower budget line: summary, the revision in progress, a new revision and the revision history.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, isConflict, isForbidden, isNotFound, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Item, NotPermitted, Section, StateBadge, When } from '../../ui';
import { Refusal } from './refusals';
import { BUDGET_MANAGE, BUDGET_READ, type BudgetDetail, byWhom, FLUSH, lineLabel, PATHS, periodText, type RevisionSaved, SCROLL, shown, SPACED, TEXTAREA, useKeys, UUID, wholeNumber } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Screen: one budget line (summary, the revision in progress, a new revision, the revision history)
// ---------------------------------------------------------------------------------------------------------

export function BudgetDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(BUDGET_READ)) {
    return (
      <>
        <h1>Manpower budget</h1>
        <NotPermitted>The selected role cannot view manpower budgets.</NotPermitted>
      </>
    );
  }
  if (!UUID.test(id)) {
    return (
      <>
        <p style={FLUSH}>
          <Link to={PATHS.budgets}>Back to manpower budgets</Link>
        </p>
        <h1>Manpower budget</h1>
        <Empty>This budget line is not available in the selected role’s scope.</Empty>
      </>
    );
  }
  return <BudgetDetailView key={id} id={id} />;
}

type BudgetCommand =
  | { kind: 'revision-create'; body: { headcount: number; reason: string } }
  | { kind: 'revision-update'; revisionId: string; body: { headcount: number; reason: string; expectedVersion: number } }
  | { kind: 'revision-submit'; revisionId: string; expectedVersion: number }
  | { kind: 'revision-withdraw'; revisionId: string };

function BudgetDetailView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: keys.budget(id), queryFn: () => api<BudgetDetail>(`/v1/hiring/budgets/${encodeURIComponent(id)}`), retry: retryTransient });
  const b = shown(detail);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /** A new revision saved starts its form clean. */
  const [formKey, setFormKey] = useState(0);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.budgets });
    void qc.invalidateQueries({ queryKey: keys.budgetTasks });
  };
  const run = useMutation({
    mutationFn: (c: BudgetCommand): Promise<unknown> => {
      switch (c.kind) {
        case 'revision-create':
          return api<RevisionSaved>(`/v1/hiring/budgets/${encodeURIComponent(id)}/revisions`, { body: c.body });
        case 'revision-update':
          return api<RevisionSaved>(`/v1/hiring/budget-revisions/${encodeURIComponent(c.revisionId)}`, { method: 'PUT', body: c.body });
        case 'revision-submit':
          return api(`/v1/hiring/budget-revisions/${encodeURIComponent(c.revisionId)}/submit`, { body: { expectedVersion: c.expectedVersion } });
        case 'revision-withdraw':
          return api(`/v1/hiring/budget-revisions/${encodeURIComponent(c.revisionId)}/withdraw`, { method: 'POST' });
      }
    },
    onMutate: () => setNotice(null),
    onSuccess: (result, c) => {
      refresh();
      switch (c.kind) {
        case 'revision-create': {
          const saved = result as RevisionSaved;
          setFormKey((k) => k + 1);
          setNotice(`Draft revision${saved.revision === undefined ? '' : ` ${saved.revision}`} saved with headcount ${saved.headcount}. Submit it for approval when it is ready.`);
          break;
        }
        case 'revision-update':
          setEditing(false);
          setNotice(`Draft revision saved with headcount ${(result as RevisionSaved).headcount}.`);
          break;
        case 'revision-submit':
          setEditing(false);
          setNotice('Revision submitted. An independent HR Administrator approves or rejects it; the headcount in force changes only when it is approved.');
          break;
        case 'revision-withdraw':
          setEditing(false);
          setNotice('Revision withdrawn.');
          break;
      }
    },
    onError: (error) => {
      if (isConflict(error) || isNotFound(error)) refresh();
    },
  });

  const reloading = detail.isFetching && !detail.isPending;
  const busy = run.isPending || reloading;
  const myUserId = me?.userId ?? null;
  const open = b?.openRevision ?? null;
  const openRow = open ? b?.revisions.find((x) => x.revisionId === open.revisionId) : undefined;
  const mine = !!openRow && myUserId !== null && openRow.preparedBy === myUserId;
  const canManage = can(BUDGET_MANAGE);

  return (
    <>
      <p style={FLUSH}>
        <Link to={PATHS.budgets}>Back to manpower budgets</Link>
      </p>
      <h1>Manpower budget</h1>
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {detail.isPending && <p className="hint loading">Loading the budget line…</p>}
      {isForbidden(detail.error) ? (
        <NotPermitted>The selected role cannot view this budget line.</NotPermitted>
      ) : isNotFound(detail.error) ? (
        <Empty>This budget line is not available in the selected role’s scope.</Empty>
      ) : (
        <ErrorNote error={detail.error} />
      )}
      {b && (
        <>
          <Section title={lineLabel(b)}>
            <dl className="kv">
              <Item term="Department">{b.departmentName}</Item>
              <Item term="Location">{b.locationName}</Item>
              <Item term="Designation">{b.designationName}</Item>
              <Item term="Period">{periodText(b)}</Item>
              <Item term="Headcount in force">{b.approvedHeadcount ?? 'None approved yet'}</Item>
              <Item term="Committed">{b.committed}</Item>
            </dl>
            <p className="hint">Committed counts the vacancies of approved requisitions on this line, plus the placements of closed ones.</p>
          </Section>

          {open && (
            <Section title={`Revision ${open.revision} in progress`}>
              <dl className="kv">
                <Item term="Headcount">{open.headcount}</Item>
                <Item term="State">
                  <StateBadge state={open.state} />
                </Item>
                {openRow && <Item term="Reason">{openRow.reason}</Item>}
                {openRow && <Item term="Prepared by">{byWhom(openRow.preparedBy, myUserId)}</Item>}
              </dl>
              {open.state === 'SUBMITTED' && <p className="hint">Waiting for an independent HR Administrator’s decision.</p>}
              {canManage && openRow && !mine && <p className="hint">Another HR user prepared this revision; only they can change, submit or withdraw it.</p>}
              {canManage && openRow && mine && (
                <>
                  <div className="row">
                    {open.state === 'DRAFT' && (
                      <>
                        <button type="button" className="secondary" aria-expanded={editing} disabled={busy} onClick={() => setEditing((v) => !v)}>
                          Change draft
                        </button>
                        <button type="button" disabled={busy} onClick={() => run.mutate({ kind: 'revision-submit', revisionId: openRow.revisionId, expectedVersion: openRow.version })}>
                          Submit for approval
                        </button>
                      </>
                    )}
                    <button type="button" className="danger" disabled={busy} onClick={() => run.mutate({ kind: 'revision-withdraw', revisionId: openRow.revisionId })}>
                      Withdraw revision
                    </button>
                  </div>
                  {editing && open.state === 'DRAFT' && (
                    <RevisionForm
                      label={`Change draft revision ${open.revision}`}
                      initial={{ headcount: openRow.headcount, reason: openRow.reason }}
                      submitLabel="Save draft"
                      busy={busy}
                      onSubmit={(body) => run.mutate({ kind: 'revision-update', revisionId: openRow.revisionId, body: { ...body, expectedVersion: openRow.version } })}
                      onCancel={() => setEditing(false)}
                    />
                  )}
                </>
              )}
            </Section>
          )}

          {!open && canManage && (
            <Section title="New revision">
              <p className="hint">A revision changes the headcount in force only once an independent HR Administrator approves it.</p>
              <RevisionForm
                key={formKey}
                label="New revision"
                initial={null}
                submitLabel="Save draft revision"
                busy={busy}
                onSubmit={(body) => run.mutate({ kind: 'revision-create', body })}
              />
            </Section>
          )}

          <Refusal error={run.error} action={run.variables?.kind ?? 'revision-update'} />

          <Section title="Revision history">
            {b.revisions.length === 0 ? (
              <Empty>No revisions recorded yet.</Empty>
            ) : (
              <div style={SCROLL}>
                <table aria-label="Revision history">
                  <thead>
                    <tr>
                      <th scope="col">Revision</th>
                      <th scope="col">Headcount</th>
                      <th scope="col">Reason</th>
                      <th scope="col">State</th>
                      <th scope="col">Prepared by</th>
                      <th scope="col">Submitted</th>
                      <th scope="col">Decided</th>
                      <th scope="col">Decided by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.revisions.map((v) => (
                      <tr key={v.revisionId}>
                        <td>{v.revision}</td>
                        <td>{v.headcount}</td>
                        <td>{v.reason}</td>
                        <td>
                          <StateBadge state={v.state} />
                        </td>
                        <td>{byWhom(v.preparedBy, myUserId)}</td>
                        <td>
                          <When at={v.submittedAt} />
                        </td>
                        <td>
                          <When at={v.decidedAt} />
                        </td>
                        <td>{byWhom(v.decidedBy, myUserId)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}

function RevisionForm({
  label,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: { headcount: number; reason: string } | null;
  submitLabel: string;
  busy: boolean;
  onSubmit: (body: { headcount: number; reason: string }) => void;
  onCancel?: () => void;
}) {
  const [headcount, setHeadcount] = useState(initial ? String(initial.headcount) : '');
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const count = headcount.trim();
    const text = reason.trim();
    const missing = !wholeNumber(count, 0) ? 'Enter the headcount as a whole number (0 or more).' : !text ? 'Enter the reason for the revision.' : null;
    setProblem(missing);
    if (missing !== null || busy) return;
    onSubmit({ headcount: Number(count), reason: text });
  };
  return (
    <form className="grid-form" aria-label={label} onSubmit={submit} noValidate style={SPACED}>
      <label>
        Headcount
        <input type="number" required min={0} step={1} inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
      </label>
      <label className="wide">
        Reason (required)
        <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      {problem && (
        <p role="alert" className="error wide">
          {problem}
        </p>
      )}
      <div className="wide row">
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

