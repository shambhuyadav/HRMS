// Lookups for the training forms: training modes and feedback questions (DF04 controlled lists) and employees.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ButtonRow, CheckField, FormField, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type EmployeeHit, personLabel, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted } from '../../ui';
import { QueryProblem } from './refusals';
import { EMPLOYEE_LIST, shown, useKeys } from './shared';
import type { Choice } from './types';

// ---------------------------------------------------------------------------------------------------------
// Lookups: training modes and feedback questions (DF04 controlled lists) and employees
// ---------------------------------------------------------------------------------------------------------

/** The employee search's matches, stacked, and one match as a full-width choice on the outline button's hover tint (the old `.choices`). */
const CHOICE_LIST = 'm-0 flex list-none flex-col gap-[0.6rem] p-0';
const CHOICE_BUTTON = 'h-auto w-full justify-start px-4 py-[0.8rem] text-left whitespace-normal';
export function useChoices(kind: 'modes' | 'questions', enabled: boolean) {
  const keys = useKeys();
  return useQuery({
    queryKey: kind === 'modes' ? keys.modes : keys.questions,
    queryFn: () => api<{ items: Choice[] }>(kind === 'modes' ? '/v1/training-modes' : '/v1/training-feedback-questions'),
    enabled,
    retry: retryTransient,
    staleTime: 60_000,
  });
}

/** Finds employees by search (the server checks row scope and status, and refuses one's own record). */
export function EmployeeSearch({ label, onPick, exclude = [] }: { label: string; onPick: (e: EmployeeHit) => void; exclude?: string[] }) {
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
  if (!canSearch) return <NotPermitted>The selected role cannot search employees.</NotPermitted>;
  const found = term !== '' ? shown(hits) : undefined;
  const items = found?.items.filter((e) => !exclude.includes(e.id));
  return (
    <div className="col-span-full flex flex-col gap-[0.6rem]">
      <FormField>
        {label}
        <Input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
      </FormField>
      {term !== '' && hits.isLoading && <Hint className="m-0">Searching…</Hint>}
      <QueryProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {items && items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {items && items.length > 0 && (
        <ul className={CHOICE_LIST} aria-label="Matching employees">
          {items.map((e) => (
            <li key={e.id}>
              <Button
                type="button"
                variant="outline"
                className={CHOICE_BUTTON}
                aria-label={`Choose ${personLabel(e)}`}
                onClick={() => {
                  onPick(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {personLabel(e)} · {readable(e.status).toLowerCase()}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The plan owner: an employee found by search, or the signed-in user's own employee record. */
export function OwnerPicker({ value, onChange }: { value: { id: string; label: string } | null; onChange: (v: { id: string; label: string } | null) => void }) {
  const { me } = useSession();
  // One labelled group, like the fields around it: who is chosen (or that nobody is), the quick choices, then the search.
  return (
    <FramedFieldset legend="Plan owner">
      <ButtonRow>
        {value ? <strong>{value.label}</strong> : <Hint as="span">Not chosen</Hint>}
        {value && (
          <Button type="button" variant="outline" onClick={() => onChange(null)}>
            Clear the owner
          </Button>
        )}
        {me?.employeeId && value?.id !== me.employeeId && (
          <Button type="button" variant="outline" onClick={() => onChange({ id: me.employeeId!, label: me.displayName ?? 'Me' })}>
            Make me the owner
          </Button>
        )}
      </ButtonRow>
      <EmployeeSearch label="Find the owner" onPick={(e) => onChange({ id: e.id, label: personLabel(e) })} />
    </FramedFieldset>
  );
}

export function QuestionChoice({ questions, chosen, onChange, legend }: { questions: Choice[] | undefined; chosen: string[]; onChange: (codes: string[]) => void; legend: string }) {
  if (!questions) return <Hint>Loading the feedback questions…</Hint>;
  if (questions.length === 0) return <Hint>The company has no active feedback question yet.</Hint>;
  return (
    <FramedFieldset legend={legend}>
      {questions.map((q) => (
        <CheckField key={q.code}>
          <input
            type="checkbox"
            checked={chosen.includes(q.code)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, q.code] : chosen.filter((c) => c !== q.code))}
          />{' '}
          {q.label}
        </CheckField>
      ))}
    </FramedFieldset>
  );
}
