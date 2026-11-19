// Choices the server offers: master data selects and the employee picker.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type EmployeeHit } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote } from '../../ui';
import { EMPLOYEE_LIST, enc, type MasterOption } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Choices the server offers
// ---------------------------------------------------------------------------------------------------------

/**
 * A master offered for a date: GET /v1/org/:kind?validOn=. What is chosen stays chosen when a new date no longer offers it, so
 * nothing typed vanishes; it is marked, and the server decides on save.
 */
export function MasterSelect(props: {
  kind: 'departments' | 'locations' | 'designations' | 'grades';
  label: string;
  value: string;
  /** The current value's name, before any list has been read. */
  known?: string | undefined;
  validOn: string;
  required?: boolean;
  onChange: (id: string) => void;
}) {
  const { kind, label, value, known, validOn, required, onChange } = props;
  const options = useQuery({
    queryKey: ['employee-master-options', kind, validOn],
    queryFn: () => api<{ items: MasterOption[] }>(`/v1/org/${kind}${validOn ? `?validOn=${enc(validOn)}` : ''}`),
  });
  const names = useRef(new Map<string, string>());
  const items = options.data?.items ?? [];
  for (const m of items) names.current.set(m.id, `${m.code} ${m.name}`);
  const offered = items.some((m) => m.id === value);
  return (
    <div>
      <label>
        {label}
        <select required={required} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{required ? `Choose a ${label.toLowerCase()}` : 'None'}</option>
          {value && !offered && (
            <option value={value}>
              {names.current.get(value) ?? known ?? 'The current choice'}
              {options.isSuccess ? ' (not offered on this date)' : ''}
            </option>
          )}
          {items.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code} {m.name}
            </option>
          ))}
        </select>
      </label>
      {options.isSuccess && items.length === 0 && <p className="hint">None is valid on this date.</p>}
      {options.error instanceof ApiError && options.error.status === 403 ? <p className="hint">Your role cannot read this list, so it cannot be chosen here.</p> : <ErrorNote error={options.error} />}
    </div>
  );
}

/** Found by a search of what the role can see; `filter` narrows it to what the route accepts, and the server checks again. */
export function EmployeePicker({ label, value, onChange, filter }: { label: string; value: EmployeeHit | null; onChange: (e: EmployeeHit | null) => void; filter: Record<string, string> }) {
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: ['employee-picker', term, filter],
    enabled: term !== '' && can(EMPLOYEE_LIST),
    queryFn: () => api<{ items: EmployeeHit[] }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25', ...filter }).toString()}`),
  });
  if (!can(EMPLOYEE_LIST)) return <p className="hint wide">Your role cannot search employees, so it cannot choose one here.</p>;
  return (
    <div className="wide">
      <p>
        {label}: <strong>{value ? `${value.displayName} (${value.employeeCode})` : 'nobody chosen yet'}</strong>{' '}
        {value && (
          <button type="button" className="secondary" onClick={() => onChange(null)}>
            Clear
          </button>
        )}
      </p>
      <label>
        Find by name, code or email
        <input type="search" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <ErrorNote error={hits.error} />
      {hits.isSuccess && term !== '' && hits.data.items.length === 0 && <Empty>Nobody matches “{term}”.</Empty>}
      {term !== '' && !!hits.data?.items.length && (
        <ul className="choices" aria-label="Matching employees">
          {hits.data.items.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {e.displayName} ({e.employeeCode})
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
