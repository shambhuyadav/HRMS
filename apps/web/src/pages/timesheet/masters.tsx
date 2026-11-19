// Masters (FR-045): projects and the activity catalogue, and the project, job and activity details.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Notice, NotPermitted, Section } from '../../ui';
import { EmployeeField } from './fields';
import { ReadProblem, Refusal } from './refusals';
import { activeText, CODE, H3, MASTER_MANAGE, MASTER_READ, PATHS, periodText, Problem, SCROLL, shown, SPACED, useKeys } from './shared';
import type { Activity, Job, Master, MasterKind, Project, ProjectDetail } from './types';

// ---------------------------------------------------------------------------------------------------------
// Screen: masters (projects and the activity catalogue), and the project, job and activity details
// ---------------------------------------------------------------------------------------------------------
const MASTER_NOUN: Record<MasterKind, string> = { project: 'project', job: 'job', activity: 'activity' };

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
    <label>
      Show {noun}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        <option value="true">Active only</option>
        <option value="false">Inactive only</option>
      </select>
    </label>
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
      <div className="row">
        <ActiveFilter value={active} onChange={setActive} noun="projects" />
      </div>
      <ReadProblem error={list.error} what="projects" />
      {list.isPending && <p className="hint loading">Loading projects…</p>}
      {data && data.items.length === 0 && (
        <Empty>{can(MASTER_MANAGE) ? 'No projects yet. Add the first one below.' : 'No projects yet. Your timesheet administrator sets them up.'}</Empty>
      )}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Projects">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Owner</th>
                <th>Valid</th>
                <th>Status</th>
                <th>Jobs</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={PATHS.project(p.id)}>{p.code}</Link>
                  </td>
                  <td>{p.name}</td>
                  <td>
                    {p.ownerName} ({p.ownerEmployeeCode})
                  </td>
                  <td>{periodText(p)}</td>
                  <td>{activeText(p.active)}</td>
                  <td>{p.jobCount ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <p className="hint">Each job lists the activities people can book time to. Changing whether an activity is productive does not change timesheets already filled in.</p>
      <div className="row">
        <ActiveFilter value={active} onChange={setActive} noun="activities" />
      </div>
      <ReadProblem error={list.error} what="activities" />
      {list.isPending && <p className="hint loading">Loading activities…</p>}
      {data && data.items.length === 0 && (
        <Empty>{can(MASTER_MANAGE) ? 'No activities yet. Add the first one below.' : 'No activities yet. Your timesheet administrator sets them up.'}</Empty>
      )}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Activities">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Productive</th>
                <th>Owner</th>
                <th>Valid</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={PATHS.activity(a.id)}>{a.code}</Link>
                  </td>
                  <td>{a.name}</td>
                  <td>{a.productive ? 'Productive' : 'Not productive'}</td>
                  <td>
                    {a.ownerName} ({a.ownerEmployeeCode})
                  </td>
                  <td>{periodText(a)}</td>
                  <td>{activeText(a.active)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
  const path = kind === 'project' ? '/v1/timesheet/projects' : kind === 'job' ? `/v1/timesheet/projects/${encodeURIComponent(projectId ?? '')}/jobs` : '/v1/timesheet/activities';
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
    <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate style={SPACED}>
      <h3 id={`${id}-title`} className="wide" style={H3}>
        New {noun}
      </h3>
      <label>
        Code
        <input value={f.code} maxLength={40} onChange={(e) => set('code')(e.target.value)} />
      </label>
      <label>
        Name
        <input value={f.name} maxLength={200} onChange={(e) => set('name')(e.target.value)} />
      </label>
      <EmployeeField label="Owner" value={f.owner} onChange={set('owner')} />
      <label>
        Valid from
        <input type="date" value={f.start} onChange={(e) => set('start')(e.target.value)} />
      </label>
      <label>
        Valid to (optional)
        <input type="date" value={f.end} onChange={(e) => set('end')(e.target.value)} />
      </label>
      {kind === 'activity' && (
        // One line, two inline choices; neither is chosen for you (the server takes no default).
        <div className="row wide" role="radiogroup" aria-labelledby={`${id}-productive`}>
          <span id={`${id}-productive`}>Counts as productive time</span>
          <label className="check">
            <input type="radio" name={`${id}-productive`} checked={f.productive === 'yes'} onChange={() => set('productive')('yes')} /> Yes
          </label>
          <label className="check">
            <input type="radio" name={`${id}-productive`} checked={f.productive === 'no'} onChange={() => set('productive')('no')} /> No
          </label>
        </div>
      )}
      <div className="wide">
        <Problem text={problem} />
        <Refusal error={create.error} act="master" />
        <Notice notice={notice} />
        <button type="submit" disabled={create.isPending}>
          Create {noun}
        </button>
      </div>
    </form>
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
    <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate style={SPACED}>
      <h3 id={`${id}-title`} className="wide" style={H3}>
        Change {MASTER_NOUN[kind]} {m.code}
      </h3>
      <label>
        Name
        <input value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <EmployeeField label="Owner" value={f.owner} current={{ id: m.ownerEmployeeId, label: `${m.ownerName} (${m.ownerEmployeeCode})` }} onChange={(owner) => setF((p) => ({ ...p, owner }))} />
      <label>
        Valid from
        <input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
      </label>
      <label>
        Valid to (empty for open-ended)
        <input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
      </label>
      {kind === 'activity' && (
        <label className="check">
          <input type="checkbox" checked={f.productive === true} onChange={(e) => setF({ ...f, productive: e.target.checked })} /> Productive
        </label>
      )}
      <div className="wide">
        <Problem text={problem} />
        <Refusal error={save.error} act="master" />
        <Notice notice={notice} />
        <button type="submit" disabled={save.isPending}>
          Save changes
        </button>
      </div>
    </form>
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
        {detail.isPending && <p className="hint loading">Loading the project…</p>}
        <ReadProblem error={detail.error} what="this project" />
        {p && <MasterFacts m={p} />}
        {p && can(MASTER_MANAGE) && <MasterEdit kind="project" m={p} path={`/v1/timesheet/projects/${encodeURIComponent(p.id)}`} onSaved={() => void qc.invalidateQueries({ queryKey: keys.masters })} />}
      </Section>
      {p && (
        <Section title="Jobs">
          <p className="hint">A job belongs to exactly this project; that never changes.</p>
          {p.jobs.length === 0 ? (
            <Empty>No jobs in this project yet.</Empty>
          ) : (
            <div style={SCROLL}>
              <table aria-label="Jobs">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Owner</th>
                    <th>Valid</th>
                    <th>Status</th>
                    <th>Approved activities</th>
                  </tr>
                </thead>
                <tbody>
                  {p.jobs.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <Link to={PATHS.job(j.id)}>{j.code}</Link>
                      </td>
                      <td>{j.name}</td>
                      <td>
                        {j.ownerName} ({j.ownerEmployeeCode})
                      </td>
                      <td>{periodText(j)}</td>
                      <td>{activeText(j.active)}</td>
                      <td>{j.activities.filter((a) => a.linkActive).map((a) => a.code).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
        {detail.isPending && <p className="hint loading">Loading the job…</p>}
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
        <div style={SCROLL}>
          <table aria-label="Job activities">
            <thead>
              <tr>
                <th>Activity</th>
                <th>Productive</th>
                <th>Activity status</th>
                <th>Link</th>
                {manage && <th>Change</th>}
              </tr>
            </thead>
            <tbody>
              {job.activities.map((a) => (
                <tr key={a.activityId}>
                  <td>
                    {a.code}: {a.name}
                  </td>
                  <td>{a.productive ? 'Productive' : 'Not productive'}</td>
                  <td>{activeText(a.activityActive)}</td>
                  <td>{a.linkActive ? 'Approved' : 'Deactivated'}</td>
                  {manage && (
                    <td>
                      <button type="button" className={a.linkActive ? 'danger' : 'secondary'} disabled={link.isPending} onClick={() => link.mutate({ activityId: a.activityId, active: !a.linkActive })}>
                        {a.linkActive ? `Deactivate ${a.code}` : `Reactivate ${a.code}`}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {manage && (
        <div className="row" style={SPACED}>
          <label>
            Activity to approve for this job
            <select value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose…</option>
              {offer.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code}: {a.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!adding || link.isPending} onClick={() => link.mutate({ activityId: adding, active: true })}>
            Approve activity
          </button>
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
        {detail.isPending && <p className="hint loading">Loading the activity…</p>}
        <ReadProblem error={detail.error} what="this activity" />
        {a && <MasterFacts m={a} extra={<Item term="Productive">{a.productive ? 'Productive' : 'Not productive'}</Item>} />}
        {a && can(MASTER_MANAGE) && <MasterEdit kind="activity" m={a} path={`/v1/timesheet/activities/${encodeURIComponent(a.id)}`} onSaved={() => void qc.invalidateQueries({ queryKey: keys.masters })} />}
      </Section>
    </div>
  );
}
