// Masters and people for the requisition and budget forms: departments, locations, designations and the hiring manager.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { api, isForbidden, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted } from '../../ui';
import { EMPLOYEE_LIST, type EmployeeHit, KNOWN_QUERY, type MasterItem, type MasterKind, type Option, ORG_READ, type Person, personLabel, REQ_READ, type Requisition, type RequisitionPage, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Masters and people for the forms
// ---------------------------------------------------------------------------------------------------------

export function useOrgList(kind: MasterKind, enabled: boolean) {
  const keys = useKeys();
  return useQuery({
    queryKey: keys.masters(kind),
    queryFn: () => api<{ items: MasterItem[] }>(`/v1/org/${kind}`),
    enabled,
    retry: retryTransient,
    staleTime: 5 * 60_000,
  });
}

/**
 * The departments, locations and designations a requisition may name. A role that can list the masters chooses from
 * the active ones; a role that cannot (a Reporting Manager holds no org_master.read) is offered the values the server
 * returned to it elsewhere: its direct reports' assignments and the requisitions it can see. The value already on a
 * draft is always offered. The server checks every choice.
 */
export function useMasterOptions(current: Pick<Requisition, 'department' | 'location' | 'designation'> | null) {
  const { can } = useSession();
  const keys = useKeys();
  const fromOrg = can(ORG_READ);
  const departments = useOrgList('departments', fromOrg);
  const locations = useOrgList('locations', fromOrg);
  const designations = useOrgList('designations', fromOrg);
  const team = useQuery({
    queryKey: keys.teamAssignments,
    queryFn: () => api<{ items: EmployeeHit[] }>(`/v1/employees?${KNOWN_QUERY}`),
    enabled: !fromOrg && can(EMPLOYEE_LIST),
    retry: retryTransient,
  });
  const seen = useQuery({
    queryKey: keys.requisitionList(KNOWN_QUERY),
    queryFn: () => api<RequisitionPage>(`/v1/hiring/requisitions?${KNOWN_QUERY}`),
    enabled: !fromOrg && can(REQ_READ),
    retry: retryTransient,
  });
  const options = useMemo(() => {
    const out: Record<MasterKind, Option[]> = { departments: [], locations: [], designations: [] };
    const add = (kind: MasterKind, id: string | null | undefined, label: string | null | undefined) => {
      if (id && label && !out[kind].some((o) => o.id === id)) out[kind].push({ id, label });
    };
    if (fromOrg) {
      for (const m of departments.data?.items ?? []) add('departments', m.id, `${m.name} (${m.code})`);
      for (const m of locations.data?.items ?? []) add('locations', m.id, `${m.name} (${m.code})`);
      for (const m of designations.data?.items ?? []) add('designations', m.id, `${m.name} (${m.code})`);
    } else {
      for (const e of team.data?.items ?? []) {
        if (!e.assignment) continue;
        add('departments', e.assignment.departmentId, e.assignment.departmentName);
        add('locations', e.assignment.locationId, e.assignment.locationName);
        add('designations', e.assignment.designationId, e.assignment.designationName);
      }
      for (const r of seen.data?.items ?? []) {
        add('departments', r.department.id, r.department.name);
        add('locations', r.location.id, r.location.name);
        add('designations', r.designation.id, r.designation.name);
      }
    }
    if (current) {
      add('departments', current.department.id, current.department.name);
      add('locations', current.location.id, current.location.name);
      add('designations', current.designation.id, current.designation.name);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }, [fromOrg, departments.data, locations.data, designations.data, team.data, seen.data, current]);
  const loading = departments.isLoading || locations.isLoading || designations.isLoading || team.isLoading || seen.isLoading;
  const error = departments.error ?? locations.error ?? designations.error ?? team.error ?? seen.error ?? null;
  return { options, fromOrg, loading, error };
}

export function MasterSelect({ label, value, options, loading, onChange }: { label: string; value: string; options: Option[]; loading: boolean; onChange: (id: string) => void }) {
  return (
    <FormField>
      {label}
      <NativeSelect required value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{loading ? 'Loading…' : 'Choose…'}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
}

/** One matching employee as a full-width choice, its words wrapping, tinted red on hover (the old `.choices` button; as in the pilot). */
const CHOICE_BUTTON = 'h-auto w-full justify-start px-4 py-[0.8rem] text-left whitespace-normal hover:border-[var(--accent-bright)] hover:bg-[var(--accent-soft)]';

/** The hiring manager: the signed-in employee, the one already on the draft, or one found by an employee search. */
export function HiringManagerField({ value, current, onChange }: { value: string; current: Person | null; onChange: (id: string) => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const canSearch = can(EMPLOYEE_LIST);
  const [picked, setPicked] = useState<Option | null>(null);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: keys.employeeSearch(term),
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25' }).toString()}`),
    enabled: canSearch && term !== '',
    retry: retryTransient,
  });
  const choices: Option[] = [];
  const offer = (o: Option) => {
    if (!choices.some((c) => c.id === o.id)) choices.push(o);
  };
  if (me?.employeeId) offer({ id: me.employeeId, label: me.displayName ? `You (${me.displayName})` : 'You' });
  if (current) offer({ id: current.id, label: personLabel(current) });
  if (picked) offer(picked);
  const choose = (e: EmployeeHit) => {
    const option = { id: e.id, label: `${e.displayName} (${e.employeeCode})` };
    setPicked(option);
    onChange(option.id);
    setSearch('');
    setTerm('');
  };
  const found = term !== '' ? hits.data : undefined;
  return (
    <>
      <FormField>
        Hiring manager
        <NativeSelect required value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      {canSearch && (
        <div className="col-span-full flex flex-col gap-[0.6rem]">
          <FormField>
            Find another hiring manager
            <Input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
          </FormField>
          {term !== '' && hits.isLoading && <Hint className="m-0">Searching…</Hint>}
          {isForbidden(hits.error) ? <NotPermitted>The selected role cannot search employees.</NotPermitted> : <ErrorNote error={hits.error} />}
          {found && found.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
          {found && found.items.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-[0.6rem] p-0" aria-label="Matching employees">
              {found.items.map((e) => (
                <li key={e.id}>
                  <Button
                    type="button"
                    variant="outline"
                    className={CHOICE_BUTTON}
                    aria-label={`Choose ${e.displayName} (${e.employeeCode}) as the hiring manager`}
                    onClick={() => choose(e)}
                  >
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

