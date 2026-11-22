// Changing several people's manager at once (coverage CL-020 "Upload reporting managers", under FR-003 and FR-009). People come from
// the organisation chart's answer (everyone employed today whom the session may list, with their current manager); the change is
// POST /v1/employees/manager-changes, all or nothing, one new manager, one date, one reason. Moving their open approvals is offered
// only to a session holding the routing duty (workflow.reroute_task) and only for a change already in effect (C4: never by itself).
// A different manager for each person, or more than 200 people, goes through the employee update import (EMPLOYEE_UPDATE_V1).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckField, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate, plural } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Notice, Section } from '../ui';
import type { OrgChart, OrgChartNode } from './org-chart';

export const MANAGER_CHANGE_PERMISSION = 'employee.update.operational';
const REROUTE = 'workflow.reroute_task.operational';
export const MANAGER_BULK_LIMIT = 200;
const NONE = '__none__';

interface Result {
  changed: string[];
  unchanged: string[];
  moved: { taskId: string; supersededTaskId: string; ownerEmployeeId: string }[];
  left: number;
}

function refusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'FORBIDDEN') return 'Your role cannot make this change for everyone chosen. Nothing was changed.';
  if (error.status === 422 || error.status === 409) return `${error.message}. Nothing was changed.`;
  return null;
}

export function ManagerChangePage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const chart = useQuery({ queryKey: ['org-chart'], queryFn: () => api<OrgChart>('/v1/org/chart') });
  const people = useMemo(() => chart.data?.items ?? [], [chart.data]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const [department, setDepartment] = useState('');
  const [location, setLocation] = useState('');
  const [manager, setManager] = useState('');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [newManager, setNewManager] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [reason, setReason] = useState('');
  const [moveApprovals, setMoveApprovals] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const today = chart.data?.asOf ?? '';
  const from = effectiveFrom || today;
  const departments = useMemo(() => [...new Set(people.map((p) => p.department).filter((d): d is string => !!d))].sort(), [people]);
  const locations = useMemo(() => [...new Set(people.map((p) => p.location).filter((l): l is string => !!l))].sort(), [people]);
  const managers = useMemo(() => [...new Set(people.map((p) => p.managerId).filter((m): m is string => !!m && byId.has(m)))].map((id) => byId.get(id)!).sort((a, b) => a.name.localeCompare(b.name)), [people, byId]);
  const q = search.trim().toLowerCase();
  const shown = people.filter(
    (p) =>
      (!department || p.department === department) &&
      (!location || p.location === location) &&
      (!manager || (manager === NONE ? !p.managerId : p.managerId === manager)) &&
      (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)),
  );
  const managerName = (id: string | null) => (id ? (byId.get(id)?.name ?? 'Outside your view') : '—');
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

  const change = useMutation({
    mutationFn: () =>
      api<Result>('/v1/employees/manager-changes', {
        body: { employeeIds: [...chosen], managerEmployeeId: newManager, effectiveFrom: from, reason: reason.trim(), ...(moveApprovals ? { moveOpenApprovals: true } : {}) },
      }),
    onSuccess: (r) => {
      const to = byId.get(newManager)?.name ?? 'the new manager';
      const parts = [`${plural(r.changed.length, 'person', 'people')} now report to ${to} from ${formatDate(from)}.`];
      if (r.unchanged.length) parts.push(`${plural(r.unchanged.length, 'person', 'people')} already did and ${r.unchanged.length === 1 ? 'was' : 'were'} left as before.`);
      if (moveApprovals) parts.push(`${plural(r.moved.length, 'open approval')} moved to the new manager; ${r.left} stay with an approver who can still decide them.`);
      setDone(parts.join(' '));
      setChosen(new Set());
      setReason('');
      setMoveApprovals(false);
      void qc.invalidateQueries({ queryKey: ['org-chart'] });
    },
  });

  const future = !!from && !!today && from > today;
  const managerChosen = newManager !== '' && chosen.has(newManager);
  const tooMany = chosen.size > MANAGER_BULK_LIMIT;
  const ready = chosen.size > 0 && newManager !== '' && reason.trim() !== '' && !managerChosen && !tooMany && !(moveApprovals && future) && !change.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    if (ready) change.mutate();
  };
  const refused = refusal(change.error);

  return (
    <>
      <Section title="Change manager">
        <Hint>
          Choose the people, then one new manager, the date it starts and the reason. Everyone changes together or no one does. For a
          different manager per person, or more than {MANAGER_BULK_LIMIT} people, use the <Link to="/imports">employee update import</Link>.
        </Hint>
        {done && <Notice notice={{ text: done, ok: true }} />}
        <ErrorNote error={chart.error} />
        {chart.isPending && <LoadingLine>Loading people…</LoadingLine>}
        {chart.isSuccess && people.length === 0 && <Empty>No one employed today is visible to you.</Empty>}
        {people.length > 0 && (
          <>
            <FilterBar>
              <FormField>
                Department
                <NativeSelect value={department} onChange={(e) => setDepartment(e.target.value)}>
                  <option value="">All</option>
                  {departments.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField>
                Location
                <NativeSelect value={location} onChange={(e) => setLocation(e.target.value)}>
                  <option value="">All</option>
                  {locations.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField>
                Current manager
                <NativeSelect value={manager} onChange={(e) => setManager(e.target.value)}>
                  <option value="">Anyone</option>
                  <option value={NONE}>No manager</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.code})
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField>
                Name or code
                <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
              </FormField>
            </FilterBar>
            {shown.length === 0 ? (
              <Empty>No one matches these filters.</Empty>
            ) : (
              <Table aria-label="People">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">
                      <input type="checkbox" aria-label="Choose everyone shown" checked={allShownChosen} onChange={toggleShown} />
                    </TableHead>
                    <TableHead scope="col">Code</TableHead>
                    <TableHead scope="col">Name</TableHead>
                    <TableHead scope="col">Designation</TableHead>
                    <TableHead scope="col">Department</TableHead>
                    <TableHead scope="col">Current manager</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((p: OrgChartNode) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <input type="checkbox" aria-label={`Choose ${p.name}`} checked={chosen.has(p.id)} onChange={() => toggle(p.id)} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{p.code}</TableCell>
                      <TableCell>{p.name}</TableCell>
                      <TableCell>{p.designation ?? '—'}</TableCell>
                      <TableCell>{p.department ?? '—'}</TableCell>
                      <TableCell>{managerName(p.managerId)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </Section>
      {people.length > 0 && (
        <Section title={chosen.size === 0 ? 'New manager: select people above' : `New manager for ${plural(chosen.size, 'person', 'people')}`}>
          <FormGrid onSubmit={submit} aria-label="New manager">
            <FormField>
              New manager
              <NativeSelect value={newManager} onChange={(e) => setNewManager(e.target.value)} required>
                <option value="">Choose…</option>
                {[...people]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.code})
                    </option>
                  ))}
              </NativeSelect>
            </FormField>
            <FormField>
              Effective from
              <Input type="date" value={from} onChange={(e) => setEffectiveFrom(e.target.value)} required />
            </FormField>
            <FormField>
              Reason
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
            </FormField>
            {can(REROUTE) && (
              // The box beside its words, on a row of its own (in a narrow cell the words wrapped under the box).
              <CheckField className="col-span-full">
                <input type="checkbox" checked={moveApprovals} onChange={(e) => setMoveApprovals(e.target.checked)} /> Also move their open approvals to the new manager
              </CheckField>
            )}
            <Button type="submit" disabled={!ready}>
              {change.isPending ? 'Changing…' : 'Change manager'}
            </Button>
          </FormGrid>
          {/* Why the change cannot be sent: these lines never had the alert role, as they appear while the form is filled in and are read with it. */}
          {managerChosen && <StatusNote tone="error">The new manager is among the people chosen: no one can manage themselves.</StatusNote>}
          {tooMany && <StatusNote tone="error">Choose at most {MANAGER_BULK_LIMIT} people at once, or use the employee update import.</StatusNote>}
          {moveApprovals && future && <StatusNote tone="error">Open approvals can move only once the change is in effect: choose today or an earlier date.</StatusNote>}
          {change.error && (refused ? <StatusNote tone="error">{refused}</StatusNote> : <ErrorNote error={change.error} />)}
          <Hint>
            Open approvals do not follow a new manager by themselves. When moved, each approval the current approver can no longer decide
            goes to whoever now approves it, and the old one is kept on record; approvals someone else can still decide stay where they are.
          </Hint>
        </Section>
      )}
    </>
  );
}

export const MANAGER_CHANGE_SCREENS: readonly ScreenRoute[] = [
  { path: '/employees/manager-change', title: 'Change manager', permission: MANAGER_CHANGE_PERMISSION, nav: true, component: ManagerChangePage },
];
