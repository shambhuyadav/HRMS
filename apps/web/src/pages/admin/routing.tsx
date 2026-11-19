// The reviewer routing screen (DF03): each kind's steps, the HR fallback list, and stranded tasks to reroute.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Section } from '../../ui';

// ---------------------------------------------------------------------------------------------------------
// Reviewer routing (DF03): each kind's steps and the explicit HR fallback list.
// ---------------------------------------------------------------------------------------------------------

interface RoutingKind {
  kind: string;
  routingKind: string | null;
  steps: { sequence: number; permission: string; selectionRule: string; conditionCode: string | null }[];
  fallbackReviewers: { userId: string; accountKey: string; priority: number; eligible: boolean }[];
}

function FallbackEditor({ kind, current, onSaved }: { kind: string; current: RoutingKind['fallbackReviewers']; onSaved: () => void }) {
  const candidates = useQuery({
    queryKey: ['routing-candidates', kind],
    queryFn: () => api<{ items: { userId: string; accountKey: string; employeeCode: string | null; displayName: string | null }[] }>(`/v1/workflows/${kind}/candidates`),
  });
  const [selected, setSelected] = useState<string[]>(current.filter((r) => r.eligible).map((r) => r.userId));
  const save = useMutation({
    mutationFn: () => api(`/v1/workflows/${kind}/fallback-reviewers`, { method: 'PUT', body: { reviewers: selected.map((userId, i) => ({ userId, priority: i + 1 })) } }),
    onSuccess: onSaved,
  });
  const toggle = (id: string) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="stack">
      {candidates.data?.items.length === 0 && <Empty>Nobody currently holds the decision permission for this kind.</Empty>}
      {candidates.data?.items.map((c) => (
        <label key={c.userId} className="check">
          <input type="checkbox" checked={selected.includes(c.userId)} onChange={() => toggle(c.userId)} /> {c.displayName ?? c.accountKey}{' '}
          <span className="hint">
            {c.accountKey}
            {selected.includes(c.userId) ? ` · priority ${selected.indexOf(c.userId) + 1}` : ''}
          </span>
        </label>
      ))}
      <div className="row">
        <button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          Save list
        </button>
      </div>
      <p className="hint">Priority follows the order in which reviewers are ticked.</p>
      <ErrorNote error={save.error ?? candidates.error} />
    </div>
  );
}

/** GET /v1/workflows/stranded-tasks (workflow.manage) and POST /v1/workflows/tasks/:id/reroute (workflow.reroute_task; I-84 item 1). */
const MANAGE_ROUTING = 'workflow.manage.operational';
const REROUTE_TASK = 'workflow.reroute_task.operational';

/** An open task its assignee can no longer decide (workflow/engine.ts strandedTasks): operational fields only. */
interface StrandedTask {
  taskId: string;
  kind: string;
  transactionId: string;
  ownerEmployeeId: string | null;
  ownerEmployeeCode: string | null;
  ownerName: string | null;
  assignedAt: string;
  assigneeUserId: string;
  assigneeAccountKey: string;
  step: number;
  delegationId: string | null;
}

/**
 * C4 "Changed organisation or manager" (DF03; I-57 item 3; I-84 item 1): open tasks in the caller's row scope whose assignee can no
 * longer decide them (a changed manager, scope or grant, or a delegation that ended). Nobody else sees them, and a task never moves by
 * itself. A reroute keeps the stranded task on record (superseded) and gives the same step to whoever the step's rule now selects: the
 * person rerouting never chooses the reviewer, never reroutes their own request, and gives a reason, which is audited; the new
 * assignee is told. The server decides every rule; this panel offers the action only with the reroute duty.
 */
function StrandedTasks() {
  const { can } = useSession();
  const qc = useQueryClient();
  const stranded = useQuery({ queryKey: ['stranded-tasks'], queryFn: () => api<{ items: StrandedTask[] }>('/v1/workflows/stranded-tasks') });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const reroute = useMutation({
    mutationFn: ({ task, reason }: { task: StrandedTask; reason: string }) =>
      api<{ taskId: string; supersededTaskId: string; assigneeUserId: string }>(`/v1/workflows/tasks/${encodeURIComponent(task.taskId)}/reroute`, { body: { reason } }),
    onMutate: () => setNote(null),
    onSuccess: (_r, { task }) => {
      setReasons((prev) => {
        const next = { ...prev };
        delete next[task.taskId];
        return next;
      });
      setNote(`The ${task.kind.replace(/_/g, ' ')} task${task.ownerEmployeeCode ? ` of ${task.ownerEmployeeCode}` : ''} was rerouted: a new task went to the reviewer its step now selects, and the stranded one is kept as superseded.`);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['stranded-tasks'] }),
  });
  const mayReroute = can(REROUTE_TASK);
  const items = stranded.data?.items ?? [];
  return (
    <Section title="Stranded tasks">
      <p className="hint">
        Open approval tasks in your scope that their assignee can no longer decide, for example after a change of manager, scope or role, or when the delegation they were
        assigned under ended. A task never moves by itself. Rerouting keeps it on record and gives the step to whoever its rule now selects: you never choose the reviewer, and
        you cannot reroute your own request.
        {mayReroute ? '' : ' The selected role cannot reroute tasks.'}
      </p>
      {stranded.data && items.length === 0 && <Empty>No stranded tasks in your scope.</Empty>}
      {items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table aria-label="Stranded tasks">
            <thead>
              <tr>
                <th>Request</th>
                <th>Employee</th>
                <th>Assigned to</th>
                <th>Since</th>
                {mayReroute && <th>Reroute</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((t) => {
                const who = t.ownerEmployeeCode ? `${t.ownerEmployeeCode}${t.ownerName ? ` ${t.ownerName}` : ''}` : 'No employee (company-wide)';
                const reason = reasons[t.taskId] ?? '';
                return (
                  <tr key={t.taskId}>
                    <td>
                      {`${t.kind.replace(/_/g, ' ')}, step ${t.step}`} {t.delegationId && <Badge tone="warn">delegated</Badge>}
                    </td>
                    <td>{who}</td>
                    <td>{t.assigneeAccountKey}</td>
                    <td>{formatDate(t.assignedAt)}</td>
                    {mayReroute && (
                      <td>
                        <div className="row">
                          <input
                            aria-label={`Reason to reroute the task of ${who}`}
                            placeholder="Reason"
                            maxLength={500}
                            value={reason}
                            onChange={(e) => setReasons({ ...reasons, [t.taskId]: e.target.value })}
                          />
                          <button
                            type="button"
                            className="secondary"
                            disabled={!reason.trim() || reroute.isPending}
                            onClick={() => reroute.mutate({ task: t, reason: reason.trim() })}
                            aria-label={`Reroute the task of ${who}`}
                          >
                            Reroute
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      <ErrorNote error={reroute.error ?? stranded.error} />
    </Section>
  );
}

export function RoutingPage() {
  const { can } = useSession();
  return (
    <div className="stack">
      <ReviewerRouting />
      {can(MANAGE_ROUTING) && <StrandedTasks />}
    </div>
  );
}

/** Who reviews a step, in words (the permission behind it is the server's business, not the reader's). */
const RULE_WORDS: Readonly<Record<string, string>> = {
  DIRECT_MANAGER: 'the direct manager',
  HR_FALLBACK_LIST: 'the HR reviewer list',
};
const sentence = (code: string) => {
  const words = code.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * A listed reviewer by name. The routing list carries only the account; the kind's candidates (who can decide it now, the same
 * list the editor ticks from, fetched once per kind) give the person's name. One who can no longer decide is not a candidate,
 * so they keep their account key.
 */
function ReviewerName({ kind, userId, accountKey }: { kind: string; userId: string; accountKey: string }) {
  const candidates = useQuery({
    queryKey: ['routing-candidates', kind],
    queryFn: () => api<{ items: { userId: string; accountKey: string; employeeCode: string | null; displayName: string | null }[] }>(`/v1/workflows/${kind}/candidates`),
  });
  const name = candidates.data?.items.find((c) => c.userId === userId)?.displayName;
  return <span title={accountKey}>{name ?? accountKey}</span>;
}

function ReviewerRouting() {
  const qc = useQueryClient();
  const routing = useQuery({ queryKey: ['routing'], queryFn: () => api<{ items: RoutingKind[] }>('/v1/workflows') });
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Section title="Reviewer routing">
      <ul className="tasks">
        {routing.data?.items.map((k) => (
          <li key={k.kind}>
            <div>
              <strong>{sentence(k.kind)}</strong>{' '}
              <span className="hint">{k.steps.map((s) => `Step ${s.sequence}: ${RULE_WORDS[s.selectionRule] ?? s.selectionRule.replace(/_/g, ' ').toLowerCase()}`).join(' → ')}</span>
            </div>
            {k.routingKind ? (
              <div className="hint">Uses the {k.routingKind.replace(/_/g, ' ')} fallback list.</div>
            ) : (
              <>
                <div>
                  Fallback reviewers:{' '}
                  {k.fallbackReviewers.length === 0
                    ? 'none'
                    : k.fallbackReviewers.map((r) => (
                        <Badge key={r.userId} tone={r.eligible ? 'good' : 'bad'}>
                          {r.priority}. <ReviewerName kind={k.kind} userId={r.userId} accountKey={r.accountKey} />
                          {r.eligible ? '' : ' (no longer eligible)'}
                        </Badge>
                      ))}
                </div>
                {editing === k.kind ? (
                  <FallbackEditor
                    kind={k.kind}
                    current={k.fallbackReviewers}
                    onSaved={() => {
                      setEditing(null);
                      void qc.invalidateQueries({ queryKey: ['routing'] });
                    }}
                  />
                ) : (
                  <div className="row">
                    <button type="button" className="secondary" onClick={() => setEditing(k.kind)}>
                      Edit list
                    </button>
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <ErrorNote error={routing.error} />
    </Section>
  );
}
