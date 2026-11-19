// Lookups for the asset forms: categories (DF04 controlled list) and employees.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type EmployeeHit, personLabel, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted } from '../../ui';
import { QueryProblem } from './refusals';
import { EMPLOYEE_LIST, FLUSH, shown, useKeys } from './shared';
import type { Category } from './types';

// ---------------------------------------------------------------------------------------------------------
// Lookups: categories (DF04 controlled list) and employees
// ---------------------------------------------------------------------------------------------------------

/** The company's active categories: the register's list (asset.read) or, in the Employee OWN context, the request list. */
export function useCategories(own: boolean, enabled: boolean) {
  const keys = useKeys();
  return useQuery({
    queryKey: own ? keys.ownCategories : keys.categories,
    queryFn: () => api<{ items: Category[] }>(own ? '/v1/me/asset-categories' : '/v1/asset-categories'),
    enabled,
    retry: retryTransient,
    staleTime: 60_000,
  });
}

export function CategorySelect({
  label,
  value,
  onChange,
  categories,
  allLabel,
  current,
}: {
  label: string;
  value: string;
  onChange: (code: string) => void;
  categories: Category[] | undefined;
  allLabel?: string;
  /** The item's category, kept selectable even if it has since been deactivated. */
  current?: Category;
}) {
  const list = categories ?? [];
  const options = current && !list.some((c) => c.code === current.code) ? [current, ...list] : list;
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel ?? 'Choose a category'}</option>
        {options.map((c) => (
          <option key={c.code} value={c.code}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Whom to issue an item to: found by an employee search (the server checks row scope and status, and refuses one's own record). */
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
  if (!canSearch) return <NotPermitted>The selected role cannot search employees, so it cannot choose whom to issue the item to.</NotPermitted>;
  const found = term !== '' ? shown(hits) : undefined;
  return (
    <div className="wide">
      <p style={FLUSH}>
        Issue to: <strong>{value ? personLabel(value) : 'nobody chosen yet'}</strong>{' '}
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
