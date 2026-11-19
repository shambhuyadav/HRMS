// DF15 off-cycle change: proposed by HR, decided by a different financial Admin; the employee picker.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { api, type EmployeeHit, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Section, StateBadge } from '../../ui';
import { answered, BASES, type Basis, basisLabel, DecisionInboxLink, EMPLOYEE_PAGE_SIZE, employeeLabel, FLUSH, LIST_EMPLOYEES, LoadProblem, moneyProblem, type OffCycleBody, PANEL, type PickedEmployee, type ProposalResult, SCROLL, SR_ONLY, TEXTAREA, useKeys, useReloadCases } from './shared';

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
      <p className="hint">
        HR proposes an off-cycle change; a different financial Admin decides it in the <DecisionInboxLink />. The salary changes only once it is approved, in the
        currency of the employee’s current salary.
      </p>
      <EmployeePicker
        label="Find employee for the off-cycle change"
        selected={employee}
        onSelect={(e) => {
          setEmployee(e);
          setSent(null);
        }}
      />
      <form className="grid-form" aria-label="Off-cycle change" style={PANEL} onSubmit={submit}>
        <label>
          Effective date
          <input type="date" required value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
        </label>
        <label>
          Increment basis
          <select value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value as Basis })}>
            {BASES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          New monthly gross
          <input inputMode="decimal" autoComplete="off" required value={form.monthlyGross} onChange={(e) => setForm({ ...form, monthlyGross: e.target.value })} />
        </label>
        <label>
          New annual CTC
          <input inputMode="decimal" autoComplete="off" required value={form.annualCtc} onChange={(e) => setForm({ ...form, annualCtc: e.target.value })} />
        </label>
        <p className="hint wide">
          The increment and its percentage are measured on the {BASES.find((b) => b.value === form.basis)?.inSentence ?? basisLabel(form.basis)}. Enter both
          figures; neither is worked out from the other.
        </p>
        <label className="wide">
          Reason (required)
          <textarea required maxLength={1000} rows={3} style={TEXTAREA} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </label>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        <div className="wide row">
          <button type="submit" disabled={propose.isPending}>
            Send off-cycle proposal
          </button>
        </div>
      </form>
      {sent && (
        <p className="ok" role="status">
          Off-cycle proposal for {sent} sent for an independent decision.
        </p>
      )}
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
        <button type="button" className="link" onClick={() => onSelect(null)}>
          Choose another employee
        </button>
      </p>
    );
  }
  if (!canSearch) return <NotPermitted>The selected role cannot search employees, so it cannot pick one here.</NotPermitted>;
  const items = found?.items ?? [];
  return (
    <div className="stack">
      <label className="inline" style={FLUSH}>
        {label}
        <input type="search" value={search} maxLength={100} placeholder="Name, code or work email" onChange={(e) => setSearch(e.target.value)} />
      </label>
      {term === '' && <p className="hint">Type a name, employee code or work email.</p>}
      {term !== '' && hits.isPending && <p className="hint">Searching…</p>}
      <LoadProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {found && items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span style={SR_ONLY}>Choose</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>{e.employeeCode}</td>
                  <td>{e.displayName}</td>
                  <td>
                    <StateBadge state={e.status} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Choose ${e.displayName} (${e.employeeCode})`}
                      onClick={() => onSelect({ id: e.id, employeeCode: e.employeeCode, displayName: e.displayName })}
                    >
                      Choose
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {found && found.total > items.length && (
            <p className="hint">
              Showing the first {items.length} of {found.total}; refine the search to narrow it down.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
