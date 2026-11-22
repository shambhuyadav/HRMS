// Process templates (FR-015): the list, a new template, a template with its settings and the task editor.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { ButtonRow, CheckField, FormField, FormGrid, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, NotPermitted, Section, StateBadge } from '../../ui';
import { Refusal, reportGone } from './refusals';
import { CODE, DUE_OFFSET_LIMIT, dueOffsetText, FIELDS, LONG_CODE, MAX_NAME, MAX_TASKS, Notice, type NoticeState, OWNER_ROLES, ownerText, PATHS, Problem, PROCESS_TYPES, QueryProblem, RoleReady, shown, TEMPLATE_MANAGE, TEMPLATE_READ, typeLabel, useKeys, UUID } from './shared';
import type { TemplateDetail, TemplateRevision, TemplateSummary, TemplateTask, TemplateTaskInput } from './types';

// ---------------------------------------------------------------------------------------------------------
// Screens: process templates (FR-015)
// ---------------------------------------------------------------------------------------------------------
export function TemplatesScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Process templates</h1>
      <Hint>
        Checklists for onboarding, probation confirmation, transfer, promotion, exit clearance and other processes: ordered tasks, each with one owner, a required or optional flag, a due date
        and an evidence rule. An employee’s process copies the revision published when it starts.
      </Hint>
      <RoleReady>
        {can(TEMPLATE_READ) ? (
          <TemplateList />
        ) : (
          <Section title="Templates">
            <NotPermitted>The selected role cannot view process templates.</NotPermitted>
          </Section>
        )}
        {can(TEMPLATE_MANAGE) && <NewTemplateForm />}
      </RoleReady>
    </>
  );
}

function TemplateList() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.templateList, queryFn: () => api<{ items: TemplateSummary[] }>('/v1/lifecycle-processes'), retry: retryTransient });
  const data = shown(list);
  return (
    <Section title={`Templates${data ? ` (${data.items.length})` : ''}`}>
      {list.isPending && <LoadingLine>Loading the process templates…</LoadingLine>}
      <QueryProblem error={list.error} forbidden="The selected role cannot view process templates." />
      {data && data.items.length === 0 && <Empty>No process templates yet.</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="Process templates">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Type</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Published revision</TableHead>
              <TableHead scope="col">Draft revision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <Link to={PATHS.template(t.id)}>{t.code}</Link>
                </TableCell>
                <TableCell>{t.name}</TableCell>
                <TableCell>{typeLabel(t.processType)}</TableCell>
                <TableCell>{t.active ? 'Active' : 'Inactive'}</TableCell>
                <TableCell>{t.publishedRevision === null ? 'None yet' : `Revision ${t.publishedRevision}`}</TableCell>
                <TableCell>{t.draftRevision === null ? '—' : `Revision ${t.draftRevision}`}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function NewTemplateForm() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const typeListId = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const create = useMutation({
    mutationFn: (body: { code: string; name: string; processType: string }) => api<TemplateDetail>('/v1/lifecycle-processes', { body }),
    onSuccess: (t) => {
      setCode('');
      setName('');
      setType('');
      void qc.invalidateQueries({ queryKey: keys.templates });
      if (can(TEMPLATE_READ)) navigate(PATHS.template(t.id));
      else setNotice({ text: `Created ${t.code} with an empty draft revision 1.`, ok: true });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const c = code.trim();
    const n = name.trim();
    const p = type.trim();
    let issue: string | null = null;
    if (!CODE.test(c)) issue = 'Enter a code of capital letters, digits and underscores that starts with a letter (at most 40 characters).';
    else if (!n) issue = 'Enter the template name.';
    else if (!LONG_CODE.test(p)) issue = 'Enter the process type code, for example ONBOARDING or EXIT.';
    setProblem(issue);
    setNotice(null);
    if (issue) {
      create.reset();
      return;
    }
    create.mutate({ code: c, name: n, processType: p });
  };
  return (
    <Section title="New process template">
      <form aria-label="New process template" className="stack" onSubmit={submit}>
        <div className={FIELDS}>
          <FormField>
            Template code
            <Input value={code} maxLength={40} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </FormField>
          <FormField>
            Template name
            <Input value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField>
            Process type
            <Input list={typeListId} value={type} maxLength={60} onChange={(e) => setType(e.target.value.toUpperCase())} />
          </FormField>
          <datalist id={typeListId}>
            {PROCESS_TYPES.map(([c, label]) => (
              <option key={c} value={c}>
                {label}
              </option>
            ))}
          </datalist>
        </div>
        <Hint className="m-0">
          The template starts with an empty draft revision 1; add its tasks and publish it on the next screen. The process types offered are the ones every company starts with; your company may
          use others.
        </Hint>
        <Problem text={problem} />
        <div>
          <Button type="submit" disabled={create.isPending}>
            Create template
          </Button>
        </div>
        <Refusal error={create.error} action="template-create" />
        <Notice notice={notice} />
      </form>
    </Section>
  );
}

export function TemplateDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  return (
    <>
      <BackLink to={PATHS.templates}>← Process templates</BackLink>
      {!UUID.test(id) ? (
        <Empty>This process template does not exist.</Empty>
      ) : (
        <RoleReady>{!can(TEMPLATE_READ) ? <NotPermitted>The selected role cannot view process templates.</NotPermitted> : <TemplateView key={id} id={id} />}</RoleReady>
      )}
    </>
  );
}

function TemplateView({ id }: { id: string }) {
  const keys = useKeys();
  const { can } = useSession();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: keys.template(id), queryFn: () => api<TemplateDetail>(`/v1/lifecycle-processes/${id}`), retry: retryTransient });
  const [startingRevision, setStartingRevision] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);
  const t = shown(query);
  if (!t) {
    return (
      <>
        {query.isPending && <LoadingLine>Loading the template…</LoadingLine>}
        <QueryProblem error={query.error} forbidden="The selected role cannot view process templates." missing="This process template is not available." />
      </>
    );
  }
  const canManage = can(TEMPLATE_MANAGE);
  const revisions = [...t.revisions].sort((a, b) => b.revision - a.revision);
  const draft = revisions.find((r) => r.state === 'DRAFT') ?? null;
  const published = revisions.find((r) => r.state === 'PUBLISHED') ?? null;
  const nextRevision = (revisions[0]?.revision ?? 0) + 1;
  const saved = (text: string) => {
    setNotice({ text, ok: true });
    void qc.invalidateQueries({ queryKey: keys.templates });
  };
  /** A refusal whose editor goes away once the template reloads (its draft was published or replaced meanwhile). */
  const refused = (text: string) => setNotice({ text, ok: false });
  return (
    <>
      <h1>
        {t.name} ({t.code})
      </h1>
      <dl className="kv">
        <Item term="Type">{typeLabel(t.processType)}</Item>
        <Item term="Status">{t.active ? 'Active: new processes can start from it' : 'Inactive: no new process can start from it'}</Item>
        <Item term="Published revision">{published ? `Revision ${published.revision}, published ${formatDate(published.publishedAt)}` : 'None yet'}</Item>
        <Item term="Draft revision">{draft ? `Revision ${draft.revision}` : '—'}</Item>
      </dl>
      <Notice notice={notice} />
      {canManage && <TemplateSettings template={t} onSaved={saved} />}
      {draft && (
        <Section title={`Draft revision ${draft.revision}`}>
          {canManage ? (
            <TaskEditor key={draft.revision} templateId={t.id} draft={draft} revisionNumber={draft.revision} seed={draft.tasks} onSaved={saved} onGone={refused} />
          ) : (
            <RevisionTasks revision={draft} />
          )}
        </Section>
      )}
      {!draft && canManage && (
        <Section title="New revision">
          {startingRevision ? (
            <TaskEditor
              key={`new:${nextRevision}`}
              templateId={t.id}
              draft={null}
              revisionNumber={nextRevision}
              seed={(published ?? revisions[0])?.tasks ?? []}
              onSaved={(text) => {
                setStartingRevision(false);
                saved(text);
              }}
              onGone={(text) => {
                setStartingRevision(false);
                refused(text);
              }}
              onCancel={() => setStartingRevision(false)}
            />
          ) : (
            <StartRevision revision={nextRevision} onStart={() => setStartingRevision(true)} />
          )}
        </Section>
      )}
      {revisions
        .filter((r) => r.state !== 'DRAFT')
        .map((r) => (
          <Section key={r.revision} title={`Revision ${r.revision}`}>
            <Hint className="m-0">
              <StateBadge state={r.state} />
              {r.publishedAt ? ` published ${formatDate(r.publishedAt)}` : ''}
            </Hint>
            <RevisionTasks revision={r} />
          </Section>
        ))}
    </>
  );
}

/** Without a draft, a change starts as the next draft revision (a published revision is frozen). */
function StartRevision({ revision, onStart }: { revision: number; onStart: () => void }) {
  return (
    <>
      <Hint>A published revision is frozen. A change is a new draft revision, published when it is ready; running processes keep the revision they started with.</Hint>
      <div>
        <Button type="button" onClick={onStart}>
          Start draft revision {revision}
        </Button>
      </div>
    </>
  );
}

function RevisionTasks({ revision }: { revision: TemplateRevision }) {
  const { me } = useSession();
  if (revision.tasks.length === 0) return <Empty>This revision has no tasks yet.</Empty>;
  return (
    <Table aria-label={`Tasks of revision ${revision.revision}`}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Order</TableHead>
          <TableHead scope="col">Code</TableHead>
          <TableHead scope="col">Task</TableHead>
          <TableHead scope="col">Owner</TableHead>
          <TableHead scope="col">Required</TableHead>
          <TableHead scope="col">Due</TableHead>
          <TableHead scope="col">Evidence</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...revision.tasks]
          .sort((a, b) => a.sequence - b.sequence)
          .map((task) => (
            <TableRow key={task.code}>
              <TableCell>{task.sequence}</TableCell>
              <TableCell>{task.code}</TableCell>
              <TableCell>{task.title}</TableCell>
              <TableCell>{ownerText(task, me?.userId ?? null)}</TableCell>
              <TableCell>{task.required ? 'Required' : 'Optional'}</TableCell>
              <TableCell>{dueOffsetText(task.dueOffsetDays)}</TableCell>
              <TableCell>{task.evidenceRequired ? 'Required' : 'Not required'}</TableCell>
            </TableRow>
          ))}
      </TableBody>
    </Table>
  );
}

function TemplateSettings({ template, onSaved }: { template: TemplateDetail; onSaved: (text: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  // The saved name until something is typed; what was typed stays after a refusal (the version is read when sending).
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? template.name;
  const update = useMutation({
    mutationFn: (body: { name?: string; active?: boolean; expectedVersion: number }) => api<TemplateDetail>(`/v1/lifecycle-processes/${template.id}`, { method: 'PATCH', body }),
    onSuccess: (t, body) => {
      if (body.name !== undefined) setTyped(null);
      onSaved(body.active === undefined ? `Renamed the template to ${t.name}.` : t.active ? 'Activated the template: new processes can start from it.' : 'Deactivated the template: no new process can start from it.');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.templates });
    },
  });
  const setName = (value: string) => setTyped(value);
  const trimmed = name.trim();
  return (
    <Section title="Template settings">
      <FormGrid
        aria-label="Template settings"
        onSubmit={(e) => {
          e.preventDefault();
          if (!update.isPending && trimmed && trimmed !== template.name) update.mutate({ name: trimmed, expectedVersion: template.version });
        }}
      >
        <FormField>
          Template name
          <Input value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <Button type="submit" disabled={update.isPending || !trimmed || trimmed === template.name}>
          Rename
        </Button>
        <Button
          type="button"
          variant={template.active ? 'danger' : 'default'}
          disabled={update.isPending}
          onClick={() => update.mutate({ active: !template.active, expectedVersion: template.version })}
        >
          {template.active ? 'Deactivate template' : 'Activate template'}
        </Button>
      </FormGrid>
      <Refusal error={update.error} action="template-update" />
    </Section>
  );
}

/** A template task being edited; `required` stays unset until chosen (F1: explicit required or optional tasks). */
interface EditableTask {
  key: string;
  code: string;
  title: string;
  ownerKind: 'ROLE' | 'USER';
  ownerRoleCode: string;
  ownerUserId: string;
  required: '' | 'REQUIRED' | 'OPTIONAL';
  dueOffsetDays: string;
  evidenceRequired: boolean;
}

const toEditable = (t: TemplateTask, key: string): EditableTask => ({
  key,
  code: t.code,
  title: t.title,
  ownerKind: t.ownerUserId ? 'USER' : 'ROLE',
  ownerRoleCode: t.ownerRoleCode ?? '',
  ownerUserId: t.ownerUserId ?? '',
  required: t.required ? 'REQUIRED' : 'OPTIONAL',
  dueOffsetDays: String(t.dueOffsetDays),
  evidenceRequired: t.evidenceRequired,
});
const blankTask = (key: string): EditableTask => ({
  key,
  code: '',
  title: '',
  ownerKind: 'ROLE',
  ownerRoleCode: '',
  ownerUserId: '',
  required: '',
  dueOffsetDays: '0',
  evidenceRequired: false,
});
const editorSignature = (rows: EditableTask[]) => JSON.stringify(rows.map(({ key: _key, ...rest }) => rest));
/** The required-or-optional choice as the editor keeps it; anything else is "not chosen yet". */
const requiredChoice = (value: string): EditableTask['required'] => (value === 'REQUIRED' || value === 'OPTIONAL' ? value : '');

/** What publishing needs, or what it does once the saved draft is ready. */
function publishingText(dirty: boolean, taskCount: number): string {
  if (dirty) return 'Save the draft before publishing it.';
  if (taskCount === 0) return 'Add at least one task and save the draft before publishing it.';
  return 'Publishing freezes this revision and retires the one published before; new processes copy its tasks.';
}

/** The tasks as the API takes them, or the first problem found (the server checks everything again). */
function checkTasks(rows: EditableTask[]): { tasks: TemplateTaskInput[] } | { problem: string } {
  if (rows.length > MAX_TASKS) return { problem: `A revision holds at most ${MAX_TASKS} tasks.` };
  const tasks: TemplateTaskInput[] = [];
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const n = i + 1;
    const code = r.code.trim();
    const title = r.title.trim();
    const days = r.dueOffsetDays.trim();
    if (!CODE.test(code)) return { problem: `Task ${n}: enter a code of capital letters, digits and underscores that starts with a letter (at most 40 characters).` };
    if (seen.has(code)) return { problem: `Task ${n}: the code ${code} is used by another task; each code appears once.` };
    seen.add(code);
    if (!title) return { problem: `Task ${n}: enter the task title.` };
    if (r.required === '') return { problem: `Task ${n}: choose whether the task is required or optional.` };
    if (!/^-?\d{1,4}$/.test(days) || Math.abs(Number(days)) > DUE_OFFSET_LIMIT) {
      return { problem: `Task ${n}: the due date is a whole number of days from the effective date, between -${DUE_OFFSET_LIMIT} and ${DUE_OFFSET_LIMIT}.` };
    }
    let owner: { ownerRoleCode: string } | { ownerUserId: string };
    if (r.ownerKind === 'ROLE') {
      const role = r.ownerRoleCode.trim();
      if (!LONG_CODE.test(role)) return { problem: `Task ${n}: enter the owner role code, for example HR_ADMINISTRATOR.` };
      owner = { ownerRoleCode: role };
    } else {
      const user = r.ownerUserId.trim();
      if (!UUID.test(user)) return { problem: `Task ${n}: enter the owner’s user ID.` };
      owner = { ownerUserId: user };
    }
    tasks.push({ code, title, ...owner, required: r.required === 'REQUIRED', dueOffsetDays: Number(days), evidenceRequired: r.evidenceRequired });
  }
  return { tasks };
}

/** Publishing refusals after which the draft is gone once the template reloads (published meanwhile, or out of reach). */
const PUBLISH_GONE: ReadonlySet<string> = new Set(['INVALID_STATE', 'NOT_FOUND']);
/** Saving a new revision: a stale version means another draft replaced this editor (reported to the screen). */
const STALE_ONLY: ReadonlySet<string> = new Set(['STALE_VERSION']);

/**
 * The ordered tasks of a draft revision, saved as a whole against the draft's version; without a draft, saving opens
 * the next revision. A saved draft is published from here, never with unsaved changes. When the draft reloads with
 * another version (a save from here, or a change made elsewhere), the editor shows it, unless that would lose unsaved
 * changes: those are kept, and saving them replaces the reloaded version.
 */
function TaskEditor({
  templateId,
  draft,
  revisionNumber,
  seed,
  onSaved,
  onGone,
  onCancel,
}: {
  templateId: string;
  draft: TemplateRevision | null;
  revisionNumber: number;
  seed: TemplateTask[];
  onSaved: (text: string) => void;
  /** A refusal after which this editor goes away once the template reloads. */
  onGone: (text: string) => void;
  onCancel?: () => void;
}) {
  const keys = useKeys();
  const qc = useQueryClient();
  const roleListId = useId();
  const counter = useRef(0);
  const initial = useMemo(() => [...seed].sort((a, b) => a.sequence - b.sequence).map((t) => toEditable(t, `seed-${t.sequence}`)), [seed]);
  const [rows, setRows] = useState<EditableTask[]>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  /** The draft version the rows were loaded from, its tasks, and whether a save from here waits for its reload. */
  const [loaded, setLoaded] = useState<{ version: number | null; rows: EditableTask[]; saved: boolean }>({ version: draft?.version ?? null, rows: initial, saved: false });
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  if (draft !== null && draft.version !== loaded.version) {
    const unsaved = !loaded.saved && editorSignature(rows) !== editorSignature(loaded.rows);
    setLoaded({ version: draft.version, rows: initial, saved: false });
    if (!unsaved) setRows(initial);
    setChangedElsewhere(unsaved);
  }
  const dirty = draft === null || editorSignature(rows) !== editorSignature(initial);
  const reload = (error: ApiError) => {
    if (error.code === 'STALE_VERSION' || error.code === 'INVALID_STATE' || error.status === 404) void qc.invalidateQueries({ queryKey: keys.templates });
  };
  const save = useMutation({
    mutationFn: (tasks: TemplateTaskInput[]) =>
      api<TemplateDetail>(`/v1/lifecycle-processes/${templateId}/draft`, { method: 'PUT', body: draft ? { tasks, expectedVersion: draft.version } : { tasks } }),
    onSuccess: () => {
      setLoaded((prev) => ({ ...prev, saved: true }));
      setChangedElsewhere(false);
      onSaved(draft ? `Saved draft revision ${draft.revision}.` : `Started draft revision ${revisionNumber}.`);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      reload(error);
      // Without a draft, a stale version means another draft revision was started meanwhile: it replaces this editor.
      if (draft === null && error.code === 'STALE_VERSION') onGone('Another draft revision was started meanwhile and has been loaded; the tasks here were not saved.');
    },
  });
  const publish = useMutation({
    mutationFn: (d: TemplateRevision) => api<TemplateDetail>(`/v1/lifecycle-processes/${templateId}/publish`, { body: { revision: d.revision, expectedVersion: d.version } }),
    onSuccess: (_t, d) => onSaved(`Published revision ${d.revision}. New processes copy its tasks; running processes keep theirs.`),
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      reload(error);
      reportGone(error, 'publish', PUBLISH_GONE, onGone);
    },
  });
  const busy = save.isPending || publish.isPending;
  const patch = (key: string, change: Partial<EditableTask>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const move = (index: number, by: -1 | 1) =>
    setRows((prev) => {
      const next = [...prev];
      const [row] = next.splice(index, 1);
      if (row) next.splice(index + by, 0, row);
      return next;
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || loaded.saved) return;
    const checked = checkTasks(rows);
    if ('problem' in checked) {
      setProblem(checked.problem);
      save.reset();
      return;
    }
    setProblem(null);
    save.mutate(checked.tasks);
  };
  return (
    <form aria-label={`Tasks of draft revision ${revisionNumber}`} className="stack" onSubmit={submit}>
      <Hint className="m-0">
        Tasks run in this order. Each has exactly one owner: a role (whoever holds it and can reach the employee) or a named user. A required task can never be skipped, and a process closes only
        when every required task is complete. The due date counts days from the process’s effective date.
      </Hint>
      {changedElsewhere && !save.error && (
        <Hint role="status" className="m-0">
          This draft was saved elsewhere since you started editing. Your unsaved changes are kept: saving them replaces that version, and discarding them loads it.
        </Hint>
      )}
      {rows.length === 0 && <Empty>No tasks yet. Add the first task.</Empty>}
      {rows.map((r, i) => (
        <FramedFieldset key={r.key} legend={<>Task {i + 1}</>}>
          <div className={FIELDS}>
            <FormField>
              Code
              <Input value={r.code} maxLength={40} onChange={(e) => patch(r.key, { code: e.target.value.toUpperCase() })} />
            </FormField>
            <FormField>
              Title
              <Input value={r.title} maxLength={MAX_NAME} onChange={(e) => patch(r.key, { title: e.target.value })} />
            </FormField>
            <FormField>
              Owner type
              <NativeSelect value={r.ownerKind} onChange={(e) => patch(r.key, { ownerKind: e.target.value === 'USER' ? 'USER' : 'ROLE' })}>
                <option value="ROLE">A role</option>
                <option value="USER">A named user</option>
              </NativeSelect>
            </FormField>
            {r.ownerKind === 'ROLE' ? (
              <FormField>
                Owner role code
                <Input list={roleListId} value={r.ownerRoleCode} maxLength={60} onChange={(e) => patch(r.key, { ownerRoleCode: e.target.value.toUpperCase() })} />
              </FormField>
            ) : (
              <FormField>
                Owner user ID
                <Input value={r.ownerUserId} maxLength={36} onChange={(e) => patch(r.key, { ownerUserId: e.target.value })} />
              </FormField>
            )}
            <FormField>
              Required or optional
              <NativeSelect value={r.required} onChange={(e) => patch(r.key, { required: requiredChoice(e.target.value) })}>
                <option value="">Choose…</option>
                <option value="REQUIRED">Required (cannot be skipped)</option>
                <option value="OPTIONAL">Optional (can be skipped with a reason)</option>
              </NativeSelect>
            </FormField>
            <FormField>
              Due (days from the effective date)
              <Input type="number" step={1} min={-DUE_OFFSET_LIMIT} max={DUE_OFFSET_LIMIT} value={r.dueOffsetDays} onChange={(e) => patch(r.key, { dueOffsetDays: e.target.value })} />
            </FormField>
            <CheckField>
              <input type="checkbox" checked={r.evidenceRequired} onChange={(e) => patch(r.key, { evidenceRequired: e.target.checked })} /> Evidence file required
            </CheckField>
          </div>
          <ButtonRow>
            <Button type="button" variant="outline" disabled={i === 0} onClick={() => move(i, -1)}>
              Move up
            </Button>
            <Button type="button" variant="outline" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
              Move down
            </Button>
            <Button type="button" variant="outline" onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>
              Remove
            </Button>
          </ButtonRow>
        </FramedFieldset>
      ))}
      <datalist id={roleListId}>
        {OWNER_ROLES.map(([c, label]) => (
          <option key={c} value={c}>
            {label}
          </option>
        ))}
      </datalist>
      <ButtonRow>
        <Button
          type="button"
          variant="outline"
          disabled={rows.length >= MAX_TASKS}
          onClick={() => {
            counter.current += 1;
            setRows((prev) => [...prev, blankTask(`new-${counter.current}`)]);
          }}
        >
          Add a task
        </Button>
        <Button type="submit" disabled={busy || !dirty || loaded.saved}>
          {draft ? 'Save draft' : `Save as draft revision ${revisionNumber}`}
        </Button>
        {draft && dirty && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setRows(initial);
              setProblem(null);
              setChangedElsewhere(false);
              save.reset();
            }}
          >
            Discard changes
          </Button>
        )}
        {onCancel && (
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </ButtonRow>
      <Problem text={problem} />
      <Refusal error={save.error} action="draft-save" except={draft === null ? STALE_ONLY : undefined} />
      {draft && (
        <div className="stack">
          <Hint className="m-0">{publishingText(dirty, draft.tasks.length)}</Hint>
          <div>
            <Button type="button" disabled={busy || dirty || draft.tasks.length === 0} onClick={() => publish.mutate(draft)}>
              Publish revision {draft.revision}
            </Button>
          </div>
          <Refusal error={publish.error} action="publish" except={PUBLISH_GONE} />
        </div>
      )}
    </form>
  );
}
