// DF15 off-cycle change: proposed by HR, decided by a different financial Admin; the employee picker.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, type EmployeeHit, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Notice, NotPermitted, Section, StateBadge } from '../../ui';
import {
  answered,
  BASES,
  type Basis,
  basisLabel,
  DecisionInboxLink,
  EMPLOYEE_PAGE_SIZE,
  employeeLabel,
  LIST_EMPLOYEES,
  LoadProblem,
  moneyProblem,
  type OffCycleBody,
  type PickedEmployee,
  type ProposalResult,
  useKeys,
  useReloadCases,
} from './shared';

// ---------------------------------------------------------------------------------------------------------
// DF15 off-cycle change: proposed by HR, decided by a different financial Admin.
// ---------------------------------------------------------------------------------------------------------

const EMPTY_OFF_CYCLE = { effectiveDate: '', basis: 'MONTHLY_GROSS' as Basis, monthlyGross: '', annualCtc: '', reason: '' };

export function OffCycleSection() {
  const reloadCases = useReloadCases();
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [form, setForm] = useState(EMPTY_OFF_CYCLE);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const propose = useMutation({
    mutationFn: ({ body }: { body: OffCycleBody; label: string }) => api<ProposalResult>('/v1/increment-cases/off-cycle', { body }),
    onMutate: () => setSent(null),
    onSuccess: (_result, { label }) => {
      setSent(label);
      setEmployee(null);
      setForm(EMPTY_OFF_CYCLE);
      reloadCases();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = form.reason.trim();
    const missing =
      (employee === null ? 'Choose the employee first.' : null) ??
      (form.effectiveDate === '' ? 'Enter the effective date.' : null) ??
      moneyProblem(form.monthlyGross, 'the new monthly gross') ??
      moneyProblem(form.annualCtc, 'the new annual CTC') ??
      (text === '' ? 'Enter a reason.' : null);
    setProblem(missing);
    if (missing !== null || employee === null) {
      propose.reset();
      return;
    }
    // The basis decides which figure the increment is measured on; the other is its stated counterpart.
    const monthly = form.basis === 'MONTHLY_GROSS';
    propose.mutate({
      label: employeeLabel(employee),
      body: {
        employeeId: employee.id,
        effectiveDate: form.effectiveDate,
        basis: form.basis,
        proposedAmount: monthly ? form.monthlyGross : form.annualCtc,
        proposedCounterpart: monthly ? form.annualCtc : form.monthlyGross,
        reason: text,
      },
    });
  };

  return (
    <Section title="Propose an off-cycle change">
      <Hint>
        HR proposes an off-cycle change; a different financial Admin decides it in the <DecisionInboxLink />. The salary changes only once it is approved, in the
        currency of the employee’s current salary.
      </Hint>
      <EmployeePicker
        label="Find employee for the off-cycle change"
        selected={employee}
        onSelect={(e) => {
          setEmployee(e);
          setSent(null);
        }}
      />
      <FormGrid aria-label="Off-cycle change" onSubmit={submit}>
        <FormField>
          Effective date
          <Input type="date" required value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
        </FormField>
        <FormField>
          Increment basis
          <NativeSelect value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value as Basis })}>
            {BASES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField>
          New monthly gross
          <Input inputMode="decimal" autoComplete="off" required value={form.monthlyGross} onChange={(e) => setForm({ ...form, monthlyGross: e.target.value })} />
        </FormField>
        <FormField>
          New annual CTC
          <Input inputMode="decimal" autoComplete="off" required value={form.annualCtc} onChange={(e) => setForm({ ...form, annualCtc: e.target.value })} />
        </FormField>
        <Hint>
          The increment and its percentage are measured on the {BASES.find((b) => b.value === form.basis)?.inSentence ?? basisLabel(form.basis)}. Enter both
          figures; neither is worked out from the other.
        </Hint>
        <FormField className="col-span-full">
          Reason (required)
          <Textarea required maxLength={1000} rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </FormField>
        {problem && <Notice notice={{ text: problem, ok: false }} />}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={propose.isPending}>
            Send off-cycle proposal
          </Button>
        </ButtonRow>
      </FormGrid>
      {sent && <Notice notice={{ text: `Off-cycle proposal for ${sent} sent for an independent decision.`, ok: true }} />}
      <ErrorNote error={propose.error} />
    </Section>
  );
}

/** Finds an employee in the selected role's scope (the server limits the list). */
export function EmployeePicker({ label, selected, onSelect }: { label: string; selected: PickedEmployee | null; onSelect: (employee: PickedEmployee | null) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const canSearch = can(LIST_EMPLOYEES);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const hits = useQuery({
    queryKey: keys.employeeSearch(term),
    enabled: canSearch && selected === null && term !== '',
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: String(EMPLOYEE_PAGE_SIZE) })}`),
    retry: retryTransient,
  });
  const found = answered(hits);

  if (selected) {
    return (
      <p>
        Employee: <strong>{employeeLabel(selected)}</strong>{' '}
        <Button type="button" variant="link" size="inline" onClick={() => onSelect(null)}>
          Choose another employee
        </Button>
      </p>
    );
  }
  if (!canSearch) return <NotPermitted>The selected role cannot search employees, so it cannot pick one here.</NotPermitted>;
  const items = found?.items ?? [];
  return (
    <div className="flex flex-col gap-3">
      {/* A name or code is short: the search field keeps a readable width rather than the card's. */}
      <FormField className="max-w-[560px]">
        {label}
        <Input type="search" value={search} maxLength={100} placeholder="Name, code or work email" onChange={(e) => setSearch(e.target.value)} />
      </FormField>
      {term === '' && <Hint>Type a name, employee code or work email.</Hint>}
      {term !== '' && hits.isPending && <Hint>Searching…</Hint>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {found && items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {items.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Choose</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{e.employeeCode}</TableCell>
                  <TableCell>{e.displayName}</TableCell>
                  <TableCell>
                    <StateBadge state={e.status} />
                  </TableCell>
                  <RowActionsCell>
                    <RowActions>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Choose ${e.displayName} (${e.employeeCode})`}
                        onClick={() => onSelect({ id: e.id, employeeCode: e.employeeCode, displayName: e.displayName })}
                      >
                        Choose
                      </Button>
                    </RowActions>
                  </RowActionsCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {found && found.total > items.length && (
            <Hint>
              Showing the first {items.length} of {found.total}; refine the search to narrow it down.
            </Hint>
          )}
        </>
      )}
    </div>
  );
}
