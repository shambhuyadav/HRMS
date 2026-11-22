// Masters (FR-045): projects and the activity catalogue, and the project, job and activity details.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { CheckField, ChoiceRow, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { api, ApiError, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Notice, NotPermitted, Section } from '../../ui';
import { EmployeeField } from './fields';
import { ReadProblem, Refusal } from './refusals';
import { activeText, CODE, FIELD_ROW, FORM_END, MASTER_MANAGE, MASTER_READ, PATHS, periodText, Problem, shown, useKeys } from './shared';
import type { Activity, Job, Master, MasterKind, Project, ProjectDetail } from './types';

// ---------------------------------------------------------------------------------------------------------
// Screen: masters (projects and the activity catalogue), and the project, job and activity details
// ---------------------------------------------------------------------------------------------------------
const MASTER_NOUN: Record<MasterKind, string> = { project: 'project', job: 'job', activity: 'activity' };

/** The question at the start of a ChoiceRow of radio buttons, in a field's words' size and weight, like the fields above it. */
const CHOICE_QUESTION = 'text-[0.83rem] font-medium text-[var(--body)]';

export function MastersScreen() {
  const { can } = useSession();
  if (!can(MASTER_READ)) return <NotPermitted>The selected role cannot see the timesheet masters.</NotPermitted>;
  return (
    <div className="stack">
      <ProjectList />
      <ActivityList />
    </div>
  );
}

function ActiveFilter({ value, onChange, noun }: { value: string; onChange: (v: string) => void; noun: string }) {
  return (
    <FormField>
      Show {noun}
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        <option value="true">Active only</option>
        <option value="false">Inactive only</option>
      </NativeSelect>
    </FormField>
  );
}

function ProjectList() {
  const { can } = useSession();
  const keys = useKeys();
  const [active, setActive] = useState('');
  const list = useQuery({
    queryKey: keys.projectList(active),
    queryFn: () => api<{ items: Project[] }>(`/v1/timesheet/projects${active ? `?active=${active}` : ''}`),
    retry: retryTransient,
  });
  const data = shown(list);
  return (
    <Section title="Projects">
      <FilterBar>
        <ActiveFilter value={active} onChange={setActive} noun="projects" />
      </FilterBar>
      <ReadProblem error={list.error} what="projects" />
      {list.isPending && <LoadingLine>Loading projects…</LoadingLine>}
      {data && data.items.length === 0 && (
        <Empty>{can(MASTER_MANAGE) ? 'No projects yet. Add the first one below.' : 'No projects yet. Your timesheet administrator sets them up.'}</Empty>
      )}
      {data && data.items.length > 0 && (
        <Table aria-label="Projects">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Owner</TableHead>
              <TableHead scope="col">Valid</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Jobs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <Link to={PATHS.project(p.id)}>{p.code}</Link>
                </TableCell>
                <TableCell>{p.name}</TableCell>
                <TableCell>
                  {p.ownerName} ({p.ownerEmployeeCode})
                </TableCell>
                <TableCell>{periodText(p)}</TableCell>
                <TableCell>{activeText(p.active)}</TableCell>
                <TableCell>{p.jobCount ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {can(MASTER_MANAGE) && <NewMasterForm kind="project" />}
    </Section>
  );
}

function ActivityList() {
  const { can } = useSession();
  const keys = useKeys();
  const [active, setActive] = useState('');
  const list = useQuery({
    queryKey: keys.activityList(active),
    queryFn: () => api<{ items: Activity[] }>(`/v1/timesheet/activities${active ? `?active=${active}` : ''}`),
    retry: retryTransient,
  });
  const data = shown(list);
  return (
    <Section title="Activity catalogue">
      <Hint>Each job lists the activities people can book time to. Changing whether an activity is productive does not change timesheets already filled in.</Hint>
      <FilterBar>
        <ActiveFilter value={active} onChange={setActive} noun="activities" />
      </FilterBar>
      <ReadProblem error={list.error} what="activities" />
      {list.isPending && <LoadingLine>Loading activities…</LoadingLine>}
      {data && data.items.length === 0 && (
        <Empty>{can(MASTER_MANAGE) ? 'No activities yet. Add the first one below.' : 'No activities yet. Your timesheet administrator sets them up.'}</Empty>
      )}
      {data && data.items.length > 0 && (
        <Table aria-label="Activities">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Productive</TableHead>
              <TableHead scope="col">Owner</TableHead>
              <TableHead scope="col">Valid</TableHead>
              <TableHead scope="col">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <Link to={PATHS.activity(a.id)}>{a.code}</Link>
                </TableCell>
                <TableCell>{a.name}</TableCell>
                <TableCell>{a.productive ? 'Productive' : 'Not productive'}</TableCell>
                <TableCell>
                  {a.ownerName} ({a.ownerEmployeeCode})
                </TableCell>
                <TableCell>{periodText(a)}</TableCell>
                <TableCell>{activeText(a.active)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {can(MASTER_MANAGE) && <NewMasterForm kind="activity" />}
    </Section>
  );
}

interface MasterBody {
  code: string;
  name: string;
  ownerEmployeeId: string;
  startDate: string;
  endDate: string | null;
  productive?: boolean;
}

/** Where a new master is created: a job always under its project. */
function createPath(kind: MasterKind, projectId: string | undefined): string {
  if (kind === 'project') return '/v1/timesheet/projects';
  if (kind === 'job') return `/v1/timesheet/projects/${encodeURIComponent(projectId ?? '')}/jobs`;
  return '/v1/timesheet/activities';
}

/** A new project, a new job in a project (fixed at creation) or a new activity (productive chosen explicitly). */
function NewMasterForm({ kind, projectId }: { kind: MasterKind; projectId?: string }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const noun = MASTER_NOUN[kind];
  const empty = { code: '', name: '', owner: '', start: '', end: '', productive: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const set = (k: keyof typeof empty) => (v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const path = createPath(kind, projectId);
  const create = useMutation({
    mutationFn: (body: MasterBody) => api<Master>(path, { body }),
    onSuccess: (m) => {
      setF(empty);
      setNotice({ text: `Created ${noun} ${m.code}.`, ok: true });
      void qc.invalidateQueries({ queryKey: keys.masters });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    setNotice(null);
    const missing = [!CODE.test(f.code) && 'a code (letters, digits, - or _, at most 40)', !f.name.trim() && 'a name', !f.owner && 'an owner', !f.start && 'a start date', kind === 'activity' && !f.productive && 'whether the activity is productive'].filter(Boolean);
    if (missing.length > 0) {
      setProblem(`Enter ${missing.join(', ')}.`);
      create.reset();
      return;
    }
    setProblem(null);
    create.mutate({ code: f.code.trim(), name: f.name.trim(), ownerEmployeeId: f.owner, startDate: f.start, endDate: f.end || null, ...(kind === 'activity' ? { productive: f.productive === 'yes' } : {}) });
  };
  return (
    <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
      <CardSubheading id={`${id}-title`}>New {noun}</CardSubheading>
      <FormField>
        Code
        <Input value={f.code} maxLength={40} onChange={(e) => set('code')(e.target.value)} />
      </FormField>
      <FormField>
        Name
        <Input value={f.name} maxLength={200} onChange={(e) => set('name')(e.target.value)} />
      </FormField>
      <EmployeeField label="Owner" value={f.owner} onChange={set('owner')} />
      <FormField>
        Valid from
        <Input type="date" value={f.start} onChange={(e) => set('start')(e.target.value)} />
      </FormField>
      <FormField>
        Valid to (optional)
        <Input type="date" value={f.end} onChange={(e) => set('end')(e.target.value)} />
      </FormField>
      {kind === 'activity' && (
        // One line, two inline choices; neither is chosen for you (the server takes no default).
        <ChoiceRow className="col-span-full" role="radiogroup" aria-labelledby={`${id}-productive`}>
          <span id={`${id}-productive`} className={CHOICE_QUESTION}>
            Counts as productive time
          </span>
          <CheckField>
            <input type="radio" name={`${id}-productive`} checked={f.productive === 'yes'} onChange={() => set('productive')('yes')} /> Yes
          </CheckField>
          <CheckField>
            <input type="radio" name={`${id}-productive`} checked={f.productive === 'no'} onChange={() => set('productive')('no')} /> No
          </CheckField>
        </ChoiceRow>
      )}
      <div className={FORM_END}>
        <Problem text={problem} />
        <Refusal error={create.error} act="master" />
        <Notice notice={notice} />
        <Button type="submit" className="self-start" disabled={create.isPending}>
          Create {noun}
        </Button>
      </div>
    </FormGrid>
  );
}

function MasterFacts({ m, extra }: { m: Master; extra?: ReactNode }) {
  return (
    <dl className="kv">
      <Item term="Code">{m.code}</Item>
      <Item term="Name">{m.name}</Item>
      <Item term="Owner">
        {m.ownerName} ({m.ownerEmployeeCode})
      </Item>
      <Item term="Valid">{periodText(m)}</Item>
      <Item term="Status">{activeText(m.active)}</Item>
      {extra}
    </dl>
  );
}

/** Changes a master against its version; only the changed fields are sent (the code never changes). */
function MasterEdit({ kind, m, path, onSaved }: { kind: MasterKind; m: Master & { productive?: boolean }; path: string; onSaved: () => void }) {
  const id = useId();
  const initial = { name: m.name, owner: m.ownerEmployeeId, start: m.startDate, end: m.endDate ?? '', active: m.active, productive: m.productive };
  const [f, setF] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Master>(path, { method: 'PATCH', body }),
    onSuccess: () => {
      setNotice({ text: `Saved ${MASTER_NOUN[kind]} ${m.code}.`, ok: true });
      onSaved();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') onSaved();
    },
  });
  // A newer version arrived (after a save or a reload): the form starts from it.
  useEffect(() => setF({ name: m.name, owner: m.ownerEmployeeId, start: m.startDate, end: m.endDate ?? '', active: m.active, productive: m.productive }), [m.version, m.name, m.ownerEmployeeId, m.startDate, m.endDate, m.active, m.productive]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    setNotice(null);
    const body: Record<string, unknown> = { expectedVersion: m.version };
    if (f.name.trim() !== m.name) body.name = f.name.trim();
    if (f.owner !== m.ownerEmployeeId) body.ownerEmployeeId = f.owner;
    if (f.start !== m.startDate) body.startDate = f.start;
    if ((f.end || null) !== m.endDate) body.endDate = f.end || null;
    if (f.active !== m.active) body.active = f.active;
    if (kind === 'activity' && f.productive !== m.productive) body.productive = f.productive;
    if (!f.name.trim() || !f.start) {
      setProblem('Enter a name and a start date.');
      return;
    }
    if (Object.keys(body).length < 2) {
      setProblem('Change at least one field to save.');
      return;
    }
    setProblem(null);
    save.mutate(body);
  };
  return (
    <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
      <CardSubheading id={`${id}-title`}>
        Change {MASTER_NOUN[kind]} {m.code}
      </CardSubheading>
      <FormField>
        Name
        <Input value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </FormField>
      <EmployeeField label="Owner" value={f.owner} current={{ id: m.ownerEmployeeId, label: `${m.ownerName} (${m.ownerEmployeeCode})` }} onChange={(owner) => setF((p) => ({ ...p, owner }))} />
      <FormField>
        Valid from
        <Input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
      </FormField>
      <FormField>
        Valid to (empty for open-ended)
        <Input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
      </FormField>
      <CheckField>
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
      </CheckField>
      {kind === 'activity' && (
        <CheckField>
          <input type="checkbox" checked={f.productive === true} onChange={(e) => setF({ ...f, productive: e.target.checked })} /> Productive
        </CheckField>
      )}
      <div className={FORM_END}>
        <Problem text={problem} />
        <Refusal error={save.error} act="master" />
        <Notice notice={notice} />
        <Button type="submit" className="self-start" disabled={save.isPending}>
          Save changes
        </Button>
      </div>
    </FormGrid>
  );
}

export function ProjectScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: keys.project(id), queryFn: () => api<ProjectDetail>(`/v1/timesheet/projects/${encodeURIComponent(id)}`), enabled: can(MASTER_READ), retry: retryTransient });
  if (!can(MASTER_READ)) return <NotPermitted>The selected role cannot see the timesheet masters.</NotPermitted>;
  const p = shown(detail);
  return (
    <div className="stack">
      <p>
        <Link to={PATHS.masters}>All projects and activities</Link>
      </p>
      <Section title={p ? `Project ${p.code}: ${p.name}` : 'Project'}>
        {detail.isPending && <LoadingLine>Loading the project…</LoadingLine>}
        <ReadProblem error={detail.error} what="this project" />
        {p && <MasterFacts m={p} />}
        {p && can(MASTER_MANAGE) && <MasterEdit kind="project" m={p} path={`/v1/timesheet/projects/${encodeURIComponent(p.id)}`} onSaved={() => void qc.invalidateQueries({ queryKey: keys.masters })} />}
      </Section>
      {p && (
        <Section title="Jobs">
          <Hint>A job belongs to exactly this project; that never changes.</Hint>
          {p.jobs.length === 0 ? (
            <Empty>No jobs in this project yet.</Empty>
          ) : (
            <Table aria-label="Jobs">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Code</TableHead>
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Owner</TableHead>
                  <TableHead scope="col">Valid</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Approved activities</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.jobs.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>
                      <Link to={PATHS.job(j.id)}>{j.code}</Link>
                    </TableCell>
                    <TableCell>{j.name}</TableCell>
                    <TableCell>
                      {j.ownerName} ({j.ownerEmployeeCode})
                    </TableCell>
                    <TableCell>{periodText(j)}</TableCell>
                    <TableCell>{activeText(j.active)}</TableCell>
                    <TableCell>{j.activities.filter((a) => a.linkActive).map((a) => a.code).join(', ') || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {can(MASTER_MANAGE) && <NewMasterForm kind="job" projectId={p.id} />}
        </Section>
      )}
    </div>
  );
}

export function JobScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: keys.job(id), queryFn: () => api<Job>(`/v1/timesheet/jobs/${encodeURIComponent(id)}`), enabled: can(MASTER_READ), retry: retryTransient });
  if (!can(MASTER_READ)) return <NotPermitted>The selected role cannot see the timesheet masters.</NotPermitted>;
  const j = shown(detail);
  return (
    <div className="stack">
      {j && (
        <p>
          <Link to={PATHS.project(j.projectId)}>
            Project {j.projectCode}: {j.projectName}
          </Link>
        </p>
      )}
      <Section title={j ? `Job ${j.code}: ${j.name}` : 'Job'}>
        {detail.isPending && <LoadingLine>Loading the job…</LoadingLine>}
        <ReadProblem error={detail.error} what="this job" />
        {j && <MasterFacts m={j} extra={<Item term="Project">{`${j.projectCode ?? ''}: ${j.projectName ?? ''}`}</Item>} />}
        {j && can(MASTER_MANAGE) && <MasterEdit kind="job" m={j} path={`/v1/timesheet/jobs/${encodeURIComponent(j.id)}`} onSaved={() => void qc.invalidateQueries({ queryKey: keys.masters })} />}
      </Section>
      {j && <JobActivities job={j} />}
    </div>
  );
}

/** F1 approved job activities: link an activity to the job, or deactivate and reactivate a link (kept on record). */
function JobActivities({ job }: { job: Job }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const manage = can(MASTER_MANAGE);
  const [adding, setAdding] = useState('');
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const catalogue = useQuery({ queryKey: keys.activityList('true'), queryFn: () => api<{ items: Activity[] }>('/v1/timesheet/activities?active=true'), enabled: manage, retry: retryTransient });
  const link = useMutation({
    mutationFn: (v: { activityId: string; active: boolean }) => api<Job>(`/v1/timesheet/jobs/${encodeURIComponent(job.id)}/activities/${encodeURIComponent(v.activityId)}`, { method: 'PUT', body: { active: v.active } }),
    onSuccess: (_j, v) => {
      setAdding('');
      setNotice({ text: v.active ? 'The activity is approved for this job.' : 'The link is deactivated; it stays on record.', ok: true });
      void qc.invalidateQueries({ queryKey: keys.masters });
    },
  });
  const linked = new Set(job.activities.map((a) => a.activityId));
  const offer = (shown(catalogue)?.items ?? []).filter((a) => !linked.has(a.id));
  return (
    <Section title="Approved activities">
      {job.activities.length === 0 ? (
        <Empty>No activity is linked to this job yet.</Empty>
      ) : (
        <Table aria-label="Job activities">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Activity</TableHead>
              <TableHead scope="col">Productive</TableHead>
              <TableHead scope="col">Activity status</TableHead>
              <TableHead scope="col">Link</TableHead>
              {manage && <TableHead scope="col">Change</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {job.activities.map((a) => (
              <TableRow key={a.activityId}>
                <TableCell>
                  {a.code}: {a.name}
                </TableCell>
                <TableCell>{a.productive ? 'Productive' : 'Not productive'}</TableCell>
                <TableCell>{activeText(a.activityActive)}</TableCell>
                <TableCell>{a.linkActive ? 'Approved' : 'Deactivated'}</TableCell>
                {manage && (
                  <RowActionsCell>
                    <RowActions>
                      <Button
                        type="button"
                        variant={a.linkActive ? 'danger' : 'outline'}
                        size="sm"
                        disabled={link.isPending}
                        onClick={() => link.mutate({ activityId: a.activityId, active: !a.linkActive })}
                      >
                        {a.linkActive ? `Deactivate ${a.code}` : `Reactivate ${a.code}`}
                      </Button>
                    </RowActions>
                  </RowActionsCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {manage && (
        <div className={cn('mt-3', FIELD_ROW)}>
          <FormField className="w-auto">
            Activity to approve for this job
            <NativeSelect value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose…</option>
              {offer.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code}: {a.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <Button type="button" disabled={!adding || link.isPending} onClick={() => link.mutate({ activityId: adding, active: true })}>
            Approve activity
          </Button>
        </div>
      )}
      <Refusal error={link.error} act="master" />
      <Notice notice={notice} />
    </Section>
  );
}

export function ActivityScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: keys.activity(id), queryFn: () => api<Activity>(`/v1/timesheet/activities/${encodeURIComponent(id)}`), enabled: can(MASTER_READ), retry: retryTransient });
  if (!can(MASTER_READ)) return <NotPermitted>The selected role cannot see the timesheet masters.</NotPermitted>;
  const a = shown(detail);
  return (
    <div className="stack">
      <p>
        <Link to={PATHS.masters}>All projects and activities</Link>
      </p>
      <Section title={a ? `Activity ${a.code}: ${a.name}` : 'Activity'}>
        {detail.isPending && <LoadingLine>Loading the activity…</LoadingLine>}
        <ReadProblem error={detail.error} what="this activity" />
        {a && <MasterFacts m={a} extra={<Item term="Productive">{a.productive ? 'Productive' : 'Not productive'}</Item>} />}
        {a && can(MASTER_MANAGE) && <MasterEdit kind="activity" m={a} path={`/v1/timesheet/activities/${encodeURIComponent(a.id)}`} onSaved={() => void qc.invalidateQueries({ queryKey: keys.masters })} />}
      </Section>
    </div>
  );
}
