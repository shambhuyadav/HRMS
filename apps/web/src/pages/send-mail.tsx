// HR sends one message to chosen employees by email (BRD coverage CL-041 "Send Mail", under FR-085; DF12 email only once a mail server
// is configured; BR-026 row scope; BR-044 and H7 what an email may carry; migration 0282). The steps: choose people from the
// organisation chart's answer or upload a list of employee codes (HR_MAIL_RECIPIENTS_V1), review who will receive it and why anyone
// will not (POST /v1/hr-mail/recipients), then write the subject and message and send (POST /v1/hr-mail/messages) to the reviewed
// recipients only. The server checks every rule again; this screen says what it answered. With no mail server configured the screen
// says plainly that email is off and offers no send. The email channel sends plain text only, so there is no attachment.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { api, ApiError, fileToBase64, idempotencyKey } from '../api';
import type { ScreenRoute } from '../screens';
import { Empty, ErrorNote, Section } from '../ui';
import type { OrgChart, OrgChartNode } from './org-chart';
import { TemplateDownload } from './records';

export const SEND_MAIL_PERMISSION = 'hr_mail.send.message';
const RECIPIENTS = '/v1/hr-mail/recipients';

/** GET /v1/hr-mail/channel. */
interface Channel {
  email: 'ON' | 'OFF';
  reason?: string;
  attachments: boolean;
  limits: { recipients: number; subject: number; message: number; listRows: number };
}

/** POST /v1/hr-mail/recipients: each recipient's outcome. */
interface Reviewed {
  row?: number;
  employeeId: string | null;
  employeeCode: string | null;
  displayName: string | null;
  workEmail: string | null;
  outcome: string;
}
interface Review {
  recipients: Reviewed[];
  eligible: number;
  refused: number;
  maxRecipients: number;
  tooMany: boolean;
}

/** GET /v1/hr-mail/messages: the sender's own messages. */
interface Sent {
  id: string;
  sentAt: string;
  recipientCount: number;
  subject: string | null;
  delivery: { queued: number; delivered: number; failed: number; suppressed: number };
}

const OUTCOME_WORDS: Record<string, string> = {
  ELIGIBLE: 'Will receive it',
  NOT_FOUND: 'Not found among the people your role can reach',
  NOT_EMPLOYED: 'Not employed now',
  NO_WORK_EMAIL: 'No work email on record',
  INVALID_CODE: 'This row names no employee code',
  DUPLICATE: 'Repeated: counted once',
};

const CONTENT_RULES: Record<string, string> = {
  LONG_NUMBER: 'a long number',
  FORMATTED_NUMBER: 'a number with a separator, such as an amount',
  PERCENTAGE: 'a percentage',
  CURRENCY: 'a currency',
  ACCOUNT_IDENTIFIER: 'an account number',
  LINK: 'a link',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function refusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = (error.details ?? {}) as { rule?: string; max?: number; recipients?: unknown[] };
  switch (error.code) {
    case 'EMAIL_NOT_CONFIGURED':
      return 'Email is off: no mail server is configured, so nothing was sent.';
    case 'CONTENT_NOT_ALLOWED':
      return `An email may not carry ${CONTENT_RULES[details.rule ?? ''] ?? 'this content'}. Write it without figures, amounts, percentages, currency, account numbers or links. Nothing was sent.`;
    case 'INVALID_SUBJECT':
      return `The subject is one line of at most ${details.max ?? 150} characters.`;
    case 'INVALID_MESSAGE':
      return `The message is plain text of at most ${details.max ?? 5000} characters.`;
    case 'RECIPIENTS_NOT_ELIGIBLE':
      return `${plural(details.recipients?.length ?? 0, 'recipient')} can no longer be sent to. Review the recipients again; nothing was sent.`;
    case 'TOO_MANY_RECIPIENTS':
      return `At most ${details.max ?? 500} recipients per message. Nothing was sent.`;
    case 'NO_RECIPIENTS':
      return 'Choose at least one recipient.';
    case 'IDEMPOTENCY_KEY_IN_USE':
      return 'This send was already used for another message. Send again.';
    case 'UPLOAD_QUARANTINED':
      return 'The malware scan flagged the file, so it was not read.';
    case 'SCAN_UNAVAILABLE':
      return 'The file could not be scanned just now. Try again in a moment.';
    case 'INVALID_HEADER':
      return 'The file must have exactly the header employee_code, one employee code per row.';
    case 'EMPTY_FILE':
      return 'The file has no employee codes.';
    case 'TOO_MANY_ROWS':
      return `The file has more than ${details.max ?? 2000} rows.`;
    case 'FORBIDDEN':
      return 'The selected role cannot send mail to employees.';
    default:
      return null;
  }
}

function Refusal({ error }: { error: unknown }) {
  const words = refusal(error);
  if (!words) return <ErrorNote error={error} />;
  return (
    <p role="alert" className="error">
      {words}
    </p>
  );
}

export function SendMailPage() {
  const qc = useQueryClient();
  const channel = useQuery({ queryKey: ['hr-mail-channel'], queryFn: () => api<Channel>('/v1/hr-mail/channel') });
  const chart = useQuery({ queryKey: ['org-chart'], queryFn: () => api<OrgChart>('/v1/org/chart'), retry: false });
  const people = useMemo(() => chart.data?.items ?? [], [chart.data]);

  const [department, setDepartment] = useState('');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<File | null>(null);
  const [fileInput, setFileInput] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [done, setDone] = useState<string | null>(null);
  // One key per message: a send repeated after a lost answer is the same send; any change of message or recipients is a new one.
  const sendKey = useRef<string | null>(null);
  const changed = () => {
    sendKey.current = null;
    setDone(null);
  };

  const departments = useMemo(() => [...new Set(people.map((p) => p.department).filter((d): d is string => !!d))].sort(), [people]);
  const q = search.trim().toLowerCase();
  const shown = people.filter((p) => (!department || p.department === department) && (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)));
  const allShownChosen = shown.length > 0 && shown.every((p) => chosen.has(p.id));
  const toggle = (id: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleShown = () =>
    setChosen((s) => {
      const next = new Set(s);
      for (const p of shown) {
        if (allShownChosen) next.delete(p.id);
        else next.add(p.id);
      }
      return next;
    });

  const check = useMutation({
    mutationFn: async (from: 'chosen' | 'file') =>
      api<Review>(RECIPIENTS, { body: from === 'chosen' ? { employeeIds: [...chosen] } : { contentBase64: await fileToBase64(file!) } }),
    onMutate: () => {
      changed();
      setReview(null);
    },
    onSuccess: (r) => {
      setReview(r);
      setFile(null);
      setFileInput((n) => n + 1);
    },
  });

  const eligible = (review?.recipients ?? []).filter((r) => r.outcome === 'ELIGIBLE' && r.employeeId);
  const on = channel.data?.email === 'ON';
  const limits = channel.data?.limits;

  const send = useMutation({
    mutationFn: () => {
      const key = (sendKey.current ??= idempotencyKey('hr-mail'));
      return api<{ id: string; recipientCount: number; replayed: boolean }>('/v1/hr-mail/messages', {
        body: { subject: subject.trim(), message, employeeIds: eligible.map((r) => r.employeeId!), idempotencyKey: key },
      });
    },
    onSuccess: (r) => {
      setDone(`Queued for ${plural(r.recipientCount, 'person', 'people')}. The email is sent in the background; its delivery shows below and in the delivery log.`);
      sendKey.current = null;
      setSubject('');
      setMessage('');
      setReview(null);
      setChosen(new Set());
      void qc.invalidateQueries({ queryKey: ['hr-mail-sent'] });
    },
  });

  const ready = on && eligible.length > 0 && !review?.tooMany && subject.trim() !== '' && message.trim() !== '' && !send.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) send.mutate();
  };

  return (
    <>
      <Section title="Send mail">
        <ErrorNote error={channel.error} />
        {channel.data && !on && (
          <p role="alert" className="error">
            Email is off: no mail server is configured, so nothing can be sent. Recipients can still be chosen and reviewed.
          </p>
        )}
        {on && <p role="status">Email is on. A message goes to each recipient’s work email, sent in the background by the email channel with its retries.</p>}
        {limits && (
          <p className="hint">
            One message goes to at most {limits.recipients} employees in your role’s scope who are employed and have a work email. The subject is one line of at most {limits.subject}{' '}
            characters and the message plain text of at most {limits.message}. No attachment: the email channel sends plain text only.
          </p>
        )}
        {done && <p role="status">{done}</p>}
      </Section>

      <Section title="1. Choose the recipients">
        <ErrorNote error={chart.error instanceof ApiError && chart.error.status === 403 ? null : chart.error} />
        {chart.error instanceof ApiError && chart.error.status === 403 && <p className="hint">Your role cannot list people here; upload a list of employee codes instead.</p>}
        {people.length > 0 && (
          <>
            <div className="filters">
              <label>
                Department
                <select value={department} onChange={(e) => setDepartment(e.target.value)}>
                  <option value="">All</option>
                  {departments.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label>
                Name or code
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
            </div>
            {shown.length === 0 ? (
              <Empty>No one matches these filters.</Empty>
            ) : (
              <table aria-label="People">
                <thead>
                  <tr>
                    <th scope="col">
                      <input type="checkbox" aria-label="Choose everyone shown" checked={allShownChosen} onChange={toggleShown} />
                    </th>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Department</th>
                    <th scope="col">Location</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p: OrgChartNode) => (
                    <tr key={p.id}>
                      <td>
                        <input type="checkbox" aria-label={`Choose ${p.name}`} checked={chosen.has(p.id)} onChange={() => toggle(p.id)} />
                      </td>
                      <td>{p.code}</td>
                      <td>{p.name}</td>
                      <td>{p.department ?? '—'}</td>
                      <td>{p.location ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p>
              <button type="button" disabled={chosen.size === 0 || check.isPending} onClick={() => check.mutate('chosen')}>
                Review {plural(chosen.size, 'person', 'people')} chosen
              </button>
            </p>
          </>
        )}
        <form
          className="stack"
          aria-label="Upload a list"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (file && !check.isPending) check.mutate('file');
          }}
        >
          <p className="hint">
            Or upload a CSV file with the header <code>employee_code</code> and one employee code per row (template HR_MAIL_RECIPIENTS_V1). The file is checked for malware and read, never kept.
          </p>
          <TemplateDownload base={RECIPIENTS} code="HR_MAIL_RECIPIENTS_V1" />
          <div className="inline">
            <label>
              List of employee codes (CSV)
              <input key={fileInput} type="file" accept=".csv,text/csv" disabled={check.isPending} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={!file || check.isPending}>
              Review the list
            </button>
          </div>
        </form>
        <Refusal error={check.error} />
      </Section>

      {review && (
        <Section title="2. Review the recipients">
          <p role="status">
            {plural(review.eligible, 'person', 'people')} will receive it{review.refused > 0 ? `; ${review.refused} will not, as shown` : ''}.
          </p>
          {review.tooMany && <p className="error">That is more than {review.maxRecipients} recipients. Send it in parts.</p>}
          <table aria-label="Recipients">
            <thead>
              <tr>
                {review.recipients.some((r) => r.row !== undefined) && <th scope="col">Row</th>}
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Work email</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {review.recipients.map((r, i) => (
                <tr key={`${r.row ?? ''}-${r.employeeId ?? r.employeeCode ?? i}`}>
                  {review.recipients.some((x) => x.row !== undefined) && <td>{r.row ?? ''}</td>}
                  <td>{r.employeeCode ?? '—'}</td>
                  <td>{r.displayName ?? '—'}</td>
                  <td>{r.workEmail ?? '—'}</td>
                  <td>{OUTCOME_WORDS[r.outcome] ?? r.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {review && (
        <Section title="3. Write and send">
          <form className="grid-form" aria-label="Message" onSubmit={submit}>
            <label className="wide">
              Subject
              <input
                value={subject}
                maxLength={limits?.subject ?? 150}
                onChange={(e) => {
                  changed();
                  setSubject(e.target.value);
                }}
                required
              />
            </label>
            <label className="wide">
              Message
              <textarea
                value={message}
                maxLength={limits?.message ?? 5000}
                rows={8}
                onChange={(e) => {
                  changed();
                  setMessage(e.target.value);
                }}
                required
              />
            </label>
            <p className="hint wide">
              Plain text only. An email leaves the system and may be forwarded, so it may not carry figures such as amounts, percentages, currency, account numbers or links.
            </p>
            <button type="submit" disabled={!ready}>
              {send.isPending ? 'Sending…' : `Send to ${plural(eligible.length, 'person', 'people')}`}
            </button>
          </form>
          {!on && channel.data && <p className="hint">Sending is off while email is off.</p>}
          <Refusal error={send.error} />
        </Section>
      )}

      <SentMessages />
    </>
  );
}

/** The sender's own messages and where their delivery stands. */
function SentMessages() {
  const sent = useQuery({ queryKey: ['hr-mail-sent'], queryFn: () => api<{ items: Sent[] }>('/v1/hr-mail/messages') });
  const items = sent.data?.items ?? [];
  return (
    <Section title="Messages you sent">
      <ErrorNote error={sent.error} />
      {sent.isSuccess && items.length === 0 && <Empty>No message sent yet.</Empty>}
      {items.length > 0 && (
        <table aria-label="Messages you sent">
          <thead>
            <tr>
              <th scope="col">Sent</th>
              <th scope="col">Subject</th>
              <th scope="col">Recipients</th>
              <th scope="col">Delivered</th>
              <th scope="col">Waiting</th>
              <th scope="col">Failed</th>
              <th scope="col">Not sent</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>{new Date(m.sentAt).toLocaleString()}</td>
                <td>{m.subject ?? '—'}</td>
                <td>{m.recipientCount}</td>
                <td>{m.delivery.delivered}</td>
                <td>{m.delivery.queued}</td>
                <td>{m.delivery.failed}</td>
                <td>{m.delivery.suppressed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">“Not sent” counts recipients the email channel did not send to on purpose: email off, or someone no longer employed or without a work email when it was sent.</p>
    </Section>
  );
}

/** In the employee lifecycle menu, beside the notes and warnings register (the reference system's "ELC and Letters"). */
export const SEND_MAIL_SCREENS: readonly ScreenRoute[] = [{ path: '/lifecycle/send-mail', title: 'Send mail', permission: SEND_MAIL_PERMISSION, nav: true, component: SendMailPage }];
