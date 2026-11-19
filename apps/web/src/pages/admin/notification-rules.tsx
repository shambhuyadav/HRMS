// The notification rules screen (FR-085, FR-061; DF12): every revision of every rule, a new revision, and email rules.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useMemo, useState } from 'react';
import { api, ApiError, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Section } from '../../ui';

// ---------------------------------------------------------------------------------------------------------
// Notification rules (FR-085, FR-061; DF12; decision I-35): every revision of every rule with its wording. A change is
// a new revision effective from a future instant later than the latest one, audited with its reason; the revision it
// supersedes ends exactly then, so one revision is ever in force. Only the wording (approved placeholders only) and,
// for an optional rule, whether it sends can change: event, channel, recipients, timing and retry ceiling carry over,
// and a mandatory rule cannot be switched off. The server decides every rule; this screen only shows what it returned.
// ---------------------------------------------------------------------------------------------------------

/** GET /v1/notifications/rules and POST /v1/notifications/rules/:code/revisions (ceiling only, never a default duty). */
export const MANAGE_RULES = 'notification.manage_rules.operational';

interface RuleRevision {
  id: string;
  code: string;
  revision: number;
  eventType: string;
  channel: string;
  recipientSelector: string;
  optionalEvent: boolean;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  retryCeiling: number;
  templateCode: string;
  templateRevision: number;
  subjectTemplate: string | null;
  bodyTemplate: string;
  approvedPlaceholders: string[];
  proposalReason?: string | null;
  decisionReason?: string | null;
  /** Worked out by the server: PROPOSED or REJECTED until published; then from its clock, IN_FORCE, SCHEDULED or SUPERSEDED. */
  status: string;
}

const RULE_STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  IN_FORCE: { label: 'in force', tone: 'good' },
  SCHEDULED: { label: 'scheduled', tone: 'warn' },
  SUPERSEDED: { label: 'superseded', tone: 'neutral' },
  PROPOSED: { label: 'waiting for approval', tone: 'warn' },
  REJECTED: { label: 'rejected', tone: 'bad' },
};

const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };
const pad2 = (n: number) => String(n).padStart(2, '0');

/** An instant shown as the viewer's local date and time. */
export function localDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return `${formatDate(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const readableCode = (code: string) => code.replace(/_/g, ' ').toLowerCase();

/** The API's refusals of a rule revision (modules/notification/rules.ts) in plain words; null for anything else. */
function revisionRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'EFFECTIVE_DATE_NOT_FUTURE':
      return 'A change takes effect from a future date and time only. Choose a later moment.';
    case 'EFFECTIVE_DATE_BEFORE_LATEST':
      return 'A change must take effect after the latest revision of this rule starts. Choose a later moment.';
    case 'MANDATORY_RULE':
      return 'This notification is mandatory and cannot be switched off.';
    case 'NO_CHANGE':
      return 'This revision changes nothing: the wording and whether the notification is sent are as they are now.';
    case 'REVISION_PENDING':
      return 'A change to this rule is already waiting for approval. It has to be decided before another can be proposed.';
    case 'PLACEHOLDER_NOT_APPROVED': {
      const placeholder = (error.details as { placeholder?: string } | undefined)?.placeholder;
      return `The wording uses ${placeholder ? `{{${placeholder}}}` : 'a placeholder'}, which is not approved for this message. Use only the approved placeholders.`;
    }
    case 'VALIDATION_FAILED':
      return 'The message cannot be blank.';
    case 'STALE_VERSION':
      return 'This rule changed since the page loaded it, so nothing was saved. It has been reloaded: check it and schedule the change again.';
    case 'NOT_FOUND':
      return 'This rule is not available in the selected company.';
    case 'FORBIDDEN':
      return 'The selected role cannot change notification rules.';
    default:
      return null;
  }
}

export function NotificationRulesPage() {
  const { can, stored } = useSession();
  const qc = useQueryClient();
  const allowed = can(MANAGE_RULES);
  // The selected company and assignment are part of the key, so one role's answer is never shown under another.
  const key = ['notification-rules', `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`] as const;
  const rules = useQuery({ queryKey: key, enabled: allowed, queryFn: () => api<{ items: RuleRevision[] }>('/v1/notifications/rules') });
  const [editing, setEditing] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<string | null>(null);
  const groups = useMemo(() => {
    const byCode = new Map<string, RuleRevision[]>();
    for (const r of rules.data?.items ?? []) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
    return [...byCode.entries()].map(([code, revisions]) => ({ code, revisions: [...revisions].sort((a, b) => a.revision - b.revision) }));
  }, [rules.data]);
  // An in-app rule whose email rule (CODE_EMAIL) exists in any state, proposed or rejected included, is not offered email again.
  const codes = useMemo(() => new Set(groups.map((g) => g.code)), [groups]);

  if (!allowed) {
    return (
      <Section title="Notification rules">
        <Empty>The selected role cannot change notification rules; that needs the rule-management grant.</Empty>
      </Section>
    );
  }
  return (
    <Section title="Notification rules">
      <p className="hint">
        A change is a new revision that takes effect from a future date and time once someone other than its author approves it; the revision before it then ends at that moment, so
        one revision is in force at a time. Only the wording and, for an optional notification, whether it is sent can change. The event, channel, recipients, timing and retry
        ceiling carry over unchanged.
      </p>
      {scheduled && (
        <p className="ok" role="status">
          {scheduled}
        </p>
      )}
      {rules.isPending && <p className="hint loading">Loading rules…</p>}
      <ErrorNote error={rules.error} />
      {rules.data && groups.length === 0 && <Empty>No notification rules are configured.</Empty>}
      <ul className="tasks">
        {groups.map(({ code, revisions }) => {
          // A rejected revision was never in force: the next change builds on what came before it.
          const latest = [...revisions].reverse().find((r) => r.status !== 'REJECTED') ?? revisions[revisions.length - 1]!;
          const pending = latest.status === 'PROPOSED';
          const inForce = revisions.find((r) => r.status === 'IN_FORCE');
          return (
            <li key={code} aria-label={`Rule ${code}`}>
              <div>
                <strong>{code}</strong> <Badge tone={latest.optionalEvent ? 'neutral' : 'warn'}>{latest.optionalEvent ? 'optional' : 'mandatory'}</Badge>{' '}
                {inForce && <Badge tone={inForce.active ? 'good' : 'neutral'}>{inForce.active ? 'sending now' : 'switched off now'}</Badge>}
              </div>
              <dl className="kv">
                <div>
                  <dt>Event</dt>
                  <dd>{readableCode(latest.eventType)}</dd>
                </div>
                <div>
                  <dt>Channel</dt>
                  <dd>{readableCode(latest.channel)}</dd>
                </div>
                <div>
                  <dt>Recipients</dt>
                  <dd>{readableCode(latest.recipientSelector)}</dd>
                </div>
                <div>
                  <dt>Retry ceiling</dt>
                  <dd>{latest.retryCeiling}</dd>
                </div>
              </dl>
              <table aria-label={`Revisions of ${code}`}>
                <thead>
                  <tr>
                    <th scope="col">Revision</th>
                    <th scope="col">Status</th>
                    <th scope="col">From</th>
                    <th scope="col">Until</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {revisions.map((r) => {
                    const status = RULE_STATUS[r.status] ?? { label: readableCode(r.status), tone: 'neutral' as const };
                    return (
                      <tr key={r.id}>
                        <td>
                          {r.revision} <span className="hint">wording {r.templateRevision}</span>
                        </td>
                        <td>
                          <Badge tone={status.tone}>{status.label}</Badge>
                          {r.status === 'REJECTED' && r.decisionReason ? <div className="hint">{r.decisionReason}</div> : null}
                        </td>
                        <td>{localDateTime(r.effectiveFrom)}</td>
                        <td>{localDateTime(r.effectiveTo)}</td>
                        <td>{r.active ? 'yes' : 'no (switched off)'}</td>
                        <td>{r.subjectTemplate ?? '—'}</td>
                        <td>{r.bodyTemplate}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {editing === code ? (
                <RuleRevisionForm
                  latest={latest}
                  onCancel={() => setEditing(null)}
                  onStale={() => void qc.invalidateQueries({ queryKey: key })}
                  onScheduled={(text) => {
                    setEditing(null);
                    setScheduled(text);
                    void qc.invalidateQueries({ queryKey: key });
                  }}
                />
              ) : editing === `${code}:email` ? (
                <EmailRuleForm
                  source={latest}
                  onCancel={() => setEditing(null)}
                  onProposed={(text) => {
                    setEditing(null);
                    setScheduled(text);
                    void qc.invalidateQueries({ queryKey: key });
                  }}
                />
              ) : (
                <>
                  {pending ? (
                    <p className="hint">A change is waiting for approval; it has to be decided before another can be proposed.</p>
                  ) : (
                    <div className="row">
                      <button
                        type="button"
                        className="secondary"
                        aria-label={`Change ${code}`}
                        onClick={() => {
                          setScheduled(null);
                          setEditing(code);
                        }}
                      >
                        Change
                      </button>
                    </div>
                  )}
                  {latest.channel === 'IN_APP' && !codes.has(`${code}_EMAIL`) && (
                    <div className="row">
                      <button
                        type="button"
                        className="secondary"
                        aria-label={`Propose email for ${code}`}
                        onClick={() => {
                          setScheduled(null);
                          setEditing(`${code}:email`);
                        }}
                      >
                        Propose email
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function RuleRevisionForm({ latest, onScheduled, onStale, onCancel }: { latest: RuleRevision; onScheduled: (text: string) => void; onStale: () => void; onCancel: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [active, setActive] = useState(latest.active);
  const [subject, setSubject] = useState(latest.subjectTemplate ?? '');
  const [body, setBody] = useState(latest.bodyTemplate);
  const [reason, setReason] = useState('');
  // The datetime-local value is the viewer's local time; the API takes the instant.
  const instant = effectiveFrom ? new Date(effectiveFrom) : null;
  const validInstant = instant !== null && !Number.isNaN(instant.getTime());
  const subjectValue = subject.trim() === '' ? null : subject;
  const subjectChanged = subjectValue !== latest.subjectTemplate;
  const bodyChanged = body !== latest.bodyTemplate;
  const activeChanged = active !== latest.active;
  const save = useMutation({
    mutationFn: () =>
      api<{ revision: number; effectiveFrom: string }>(`/v1/notifications/rules/${encodeURIComponent(latest.code)}/revisions`, {
        body: {
          expectedRevision: latest.revision,
          effectiveFrom: instant!.toISOString(),
          reason: reason.trim(),
          ...(activeChanged ? { active } : {}),
          ...(subjectChanged ? { subjectTemplate: subjectValue } : {}),
          ...(bodyChanged ? { bodyTemplate: body } : {}),
        },
      }),
    onSuccess: (r) => onScheduled(`Revision ${r.revision} of ${latest.code} is waiting for approval. Once approved it takes effect from ${localDateTime(r.effectiveFrom)}.`),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') onStale();
    },
  });
  const ready = validInstant && (subjectChanged || bodyChanged || activeChanged) && body.trim() !== '' && reason.trim() !== '' && !save.isPending;
  const refusal = revisionRefusal(save.error);
  return (
    <form
      className="grid-form"
      aria-label={`Change ${latest.code}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save.mutate();
      }}
    >
      <label>
        Takes effect from
        <input type="datetime-local" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </label>
      {latest.optionalEvent ? (
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Send this notification
        </label>
      ) : (
        <p className="hint">Mandatory: this notification cannot be switched off.</p>
      )}
      <label className="wide">
        Subject (optional)
        <input maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="wide">
        Message
        <textarea rows={3} maxLength={1000} style={TEXTAREA} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="hint wide">
        {latest.approvedPlaceholders.length === 0
          ? 'This message has no approved placeholders.'
          : `Approved placeholders: ${latest.approvedPlaceholders.map((p) => `{{${p}}}`).join(', ')}.`}
      </p>
      <label className="wide">
        Reason for the change
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="row wide">
        <button type="submit" disabled={!ready}>
          Propose change
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {save.error ? (
        refusal ? (
          <p role="alert" className="error wide">
            {refusal}
          </p>
        ) : (
          <div className="wide">
            <ErrorNote error={save.error} />
          </div>
        )
      ) : null}
    </form>
  );
}

/** The API's refusals of an email proposal (rules.ts proposeEmailRule) in plain words; the revision refusals cover the rest. */
function emailRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'EMAIL_RULE_EXISTS':
      return 'This notification already has an email rule. Change that rule instead.';
    case 'NOT_AN_IN_APP_RULE':
      return 'Email is proposed from an in-app notification only.';
    case 'CODE_TOO_LONG':
      return 'This notification’s code is too long to take an email rule.';
    default:
      return revisionRefusal(error);
  }
}

/**
 * FR-085 "configurable supported channels"; DF12: email for one event, proposed beside its in-app rule (POST
 * /v1/notifications/rules/:code/email). Like any rule change it waits for someone else to approve it, and nothing is sent until the
 * server also has email (SMTP) settings. Blank wording lets the server derive a safe subject and message from the in-app one.
 */
function EmailRuleForm({ source, onProposed, onCancel }: { source: RuleRevision; onProposed: (text: string) => void; onCancel: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  const instant = effectiveFrom ? new Date(effectiveFrom) : null;
  const validInstant = instant !== null && !Number.isNaN(instant.getTime());
  const save = useMutation({
    mutationFn: () =>
      api<{ code: string; effectiveFrom: string }>(`/v1/notifications/rules/${encodeURIComponent(source.code)}/email`, {
        body: {
          effectiveFrom: instant!.toISOString(),
          reason: reason.trim(),
          ...(subject.trim() ? { subjectTemplate: subject.trim() } : {}),
          ...(body.trim() ? { bodyTemplate: body.trim() } : {}),
        },
      }),
    onSuccess: (r) => onProposed(`Email for ${source.code} is waiting for approval as ${r.code}. Once approved it applies from ${localDateTime(r.effectiveFrom)}; nothing is sent until email is set up on the server.`),
  });
  const ready = validInstant && reason.trim() !== '' && !save.isPending;
  const refusal = emailRefusal(save.error);
  return (
    <form
      className="grid-form"
      aria-label={`Propose email for ${source.code}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save.mutate();
      }}
    >
      <label>
        Takes effect from
        <input type="datetime-local" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </label>
      <label className="wide">
        Email subject (optional)
        <input maxLength={150} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="wide">
        Email message (optional)
        <textarea rows={3} maxLength={1000} style={TEXTAREA} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="hint wide">
        Left blank, the email takes a safe subject and message from the in-app notification. Recipients, timing and retries are the in-app
        notification’s.{' '}
        {source.approvedPlaceholders.length > 0 && `Approved placeholders: ${source.approvedPlaceholders.map((p) => `{{${p}}}`).join(', ')}.`}
      </p>
      <label className="wide">
        Reason
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="row wide">
        <button type="submit" disabled={!ready}>
          Propose email
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {save.error ? (
        refusal ? (
          <p role="alert" className="error wide">
            {refusal}
          </p>
        ) : (
          <div className="wide">
            <ErrorNote error={save.error} />
          </div>
        )
      ) : null}
    </form>
  );
}
