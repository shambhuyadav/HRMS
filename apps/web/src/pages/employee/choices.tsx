// Choices the server offers: master data selects and the employee picker.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
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
    <FormField
      hint={
        <>
          {options.isSuccess && items.length === 0 && <FieldDescription>None is valid on this date.</FieldDescription>}
          {options.error instanceof ApiError && options.error.status === 403 ? (
            <FieldDescription>Your role cannot read this list, so it cannot be chosen here.</FieldDescription>
          ) : (
            <ErrorNote error={options.error} />
          )}
        </>
      }
    >
      {label}
      <NativeSelect required={required} value={value} onChange={(e) => onChange(e.target.value)}>
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
      </NativeSelect>
    </FormField>
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
  if (!can(EMPLOYEE_LIST)) return <Hint className="col-span-full">Your role cannot search employees, so it cannot choose one here.</Hint>;
  return (
    <div className="col-span-full">
      <p>
        {label}: <strong>{value ? `${value.displayName} (${value.employeeCode})` : 'nobody chosen yet'}</strong>{' '}
        {value && (
          <Button type="button" variant="outline" onClick={() => onChange(null)}>
            Clear
          </Button>
        )}
      </p>
      <FormField>
        Find by name, code or email
        <Input type="search" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
      </FormField>
      <ErrorNote error={hits.error} />
      {hits.isSuccess && term !== '' && hits.data.items.length === 0 && <Empty>Nobody matches “{term}”.</Empty>}
      {term !== '' && !!hits.data?.items.length && (
        <ul className="m-0 mt-3 flex list-none flex-col gap-[0.6rem] p-0" aria-label="Matching employees">
          {hits.data.items.map((e) => (
            <li key={e.id}>
              <Button
                type="button"
                variant="outline"
                className="h-auto w-full justify-start px-4 py-[0.8rem] text-left whitespace-normal"
                onClick={() => {
                  onChange(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {e.displayName} ({e.employeeCode})
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
