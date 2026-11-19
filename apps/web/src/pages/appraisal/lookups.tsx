// Appraisal lookups: the cycle, department and employee pickers.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type EmployeeHit, personLabel, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted } from '../../ui';
import { QueryProblem } from './refusals';
import { type Cycle, CYCLE_READ, EMPLOYEE_LIST, FLUSH, type MasterItem, ORG_READ, shown, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Lookups: cycles, departments, employees
// ---------------------------------------------------------------------------------------------------------

function useCycles(enabled = true) {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({
    queryKey: keys.cycleList(''),
    queryFn: () => api<{ items: Cycle[] }>('/v1/appraisal-cycles'),
    enabled: enabled && can(CYCLE_READ),
    retry: retryTransient,
  });
}

function useDepartments() {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({
    queryKey: keys.departments,
    queryFn: () => api<{ items: MasterItem[] }>('/v1/org/departments'),
    enabled: can(ORG_READ),
    retry: retryTransient,
    staleTime: 5 * 60_000,
  });
}

export function CycleSelect({ label, value, onChange, openOnly, allLabel }: { label: string; value: string; onChange: (id: string) => void; openOnly?: boolean; allLabel?: string }) {
  const cycles = useCycles();
  const items = (shown(cycles)?.items ?? []).filter((c) => !openOnly || c.state === 'OPEN');
  return (
    <>
      <label>
        {label}
        <select value={value} onChange={(e) => onChange(e.target.value)} required={!allLabel}>
          <option value="">{cycles.isLoading ? 'Loading…' : (allLabel ?? 'Choose…')}</option>
          {items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code}: {c.name} ({c.state === 'OPEN' ? 'open' : 'closed'})
            </option>
          ))}
        </select>
      </label>
      {cycles.error ? <QueryProblem error={cycles.error} forbidden="The selected role cannot list appraisal cycles." /> : null}
    </>
  );
}

export function DepartmentSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { can } = useSession();
  const departments = useDepartments();
  if (!can(ORG_READ)) return null;
  return (
    <label>
      Department
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All in scope</option>
        {(shown(departments)?.items ?? []).map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} ({d.code})
          </option>
        ))}
      </select>
    </label>
  );
}

/** Whom to enrol: an employee found by an employee search (the server checks row scope and refuses one's own record). */
export function EmployeePicker({ value, onChange }: { value: EmployeeHit | null; onChange: (e: EmployeeHit | null) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const canSearch = can(EMPLOYEE_LIST);
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
  if (!canSearch) return <NotPermitted>The selected role cannot search employees, so it cannot choose whom to enrol.</NotPermitted>;
  const found = term !== '' ? shown(hits) : undefined;
  return (
    <div className="wide">
      <p style={FLUSH}>
        Employee to appraise: <strong>{value ? personLabel(value) : 'none chosen yet'}</strong>{' '}
        {value && (
          <button type="button" className="secondary" onClick={() => onChange(null)}>
            Clear
          </button>
        )}
      </p>
      <label>
        Find the employee
        <input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
      </label>
      {term !== '' && hits.isLoading && <p className="hint">Searching…</p>}
      <QueryProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {found && found.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {found && found.items.length > 0 && (
        <ul className="choices" aria-label="Matching employees">
          {found.items.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                aria-label={`Choose ${personLabel(e)}`}
                onClick={() => {
                  onChange(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {personLabel(e)} · {readable(e.status).toLowerCase()}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
