// Employee and job choices for the timesheet forms.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { api, type EmployeeHit, isForbidden, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted } from '../../ui';
import { EMPLOYEE_LIST, MASTER_READ, shown, useKeys } from './shared';
import type { Project, ProjectDetail } from './types';

// ---------------------------------------------------------------------------------------------------------
// Employee and job choices for the forms
// ---------------------------------------------------------------------------------------------------------

/** The employee search's matches, stacked, and one match as a full-width choice on the outline button's hover tint (the old `.choices`). */
const CHOICE_LIST = 'm-0 flex list-none flex-col gap-[0.6rem] p-0';
const CHOICE_BUTTON = 'h-auto w-full justify-start px-4 py-[0.8rem] text-left whitespace-normal';

interface Choice {
  id: string;
  label: string;
}

/** An employee: the signed-in one, the current one, or one found by an employee search (employee.list). */
export function EmployeeField({ label, value, current, onChange }: { label: string; value: string; current?: Choice | null; onChange: (id: string) => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const canSearch = can(EMPLOYEE_LIST);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: keys.employeeSearch(term),
    queryFn: () => api<{ items: EmployeeHit[] }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25' }).toString()}`),
    enabled: canSearch && term !== '',
    retry: retryTransient,
  });
  const choices: Choice[] = [];
  const offer = (c: Choice) => {
    if (!choices.some((x) => x.id === c.id)) choices.push(c);
  };
  if (me?.employeeId) offer({ id: me.employeeId, label: me.displayName ? `You (${me.displayName})` : 'You' });
  if (current) offer(current);
  if (picked) offer(picked);
  const choose = (e: EmployeeHit) => {
    const c = { id: e.id, label: `${e.displayName} (${e.employeeCode})` };
    setPicked(c);
    onChange(c.id);
    setSearch('');
    setTerm('');
  };
  const found = term !== '' ? hits.data : undefined;
  const lower = label.toLowerCase();
  return (
    <>
      <FormField>
        {label}
        <NativeSelect required value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      {!canSearch && <Hint>The selected role cannot search employees, so only the choices above are offered.</Hint>}
      {canSearch && (
        <div className="col-span-full flex flex-col gap-[0.6rem]">
          <FormField>
            Find {choices.length > 0 ? `another ${lower}` : `the ${lower}`}
            <Input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
          </FormField>
          {term !== '' && hits.isLoading && <Hint className="m-0">Searching…</Hint>}
          {isForbidden(hits.error) ? <NotPermitted>The selected role cannot search employees.</NotPermitted> : <ErrorNote error={hits.error} />}
          {found && found.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
          {found && found.items.length > 0 && (
            <ul className={CHOICE_LIST} aria-label={`Matching employees for ${lower}`}>
              {found.items.map((e) => (
                <li key={e.id}>
                  <Button type="button" variant="outline" className={CHOICE_BUTTON} aria-label={`Choose ${e.displayName} (${e.employeeCode}) as ${lower}`} onClick={() => choose(e)}>
                    {e.displayName} ({e.employeeCode}) · {readable(e.status).toLowerCase()}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** A job of an active project (timesheet_master.read): the project first, then one of its active jobs. */
export function JobField({ projectId, jobId, onProject, onJob }: { projectId: string; jobId: string; onProject: (id: string) => void; onJob: (id: string) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const canRead = can(MASTER_READ);
  const projects = useQuery({ queryKey: keys.projectList('true'), queryFn: () => api<{ items: Project[] }>('/v1/timesheet/projects?active=true'), enabled: canRead, retry: retryTransient });
  const detail = useQuery({
    queryKey: keys.project(projectId),
    queryFn: () => api<ProjectDetail>(`/v1/timesheet/projects/${encodeURIComponent(projectId)}`),
    enabled: canRead && projectId !== '',
    retry: retryTransient,
  });
  if (!canRead) return <Hint>The selected role cannot list projects and jobs, so no job can be chosen here.</Hint>;
  const jobs = (shown(detail)?.jobs ?? []).filter((j) => j.active);
  return (
    <>
      <FormField>
        Project
        <NativeSelect
          required
          value={projectId}
          onChange={(e) => {
            onProject(e.target.value);
            onJob('');
          }}
        >
          <option value="">Choose…</option>
          {(shown(projects)?.items ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.code}: {p.name}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField>
        Job
        <NativeSelect required value={jobId} disabled={projectId === ''} onChange={(e) => onJob(e.target.value)}>
          <option value="">{projectId === '' ? 'Choose a project first' : 'Choose…'}</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.code}: {j.name}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <ErrorNote error={projects.error ?? detail.error} />
    </>
  );
}
