// The medical claims screen (CL-113).
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formatDate, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { amount, MEDICAL_READ, plain } from './shared';

// ---------------------------------------------------------------------------------------------------------
// CL-113 medical claims
// ---------------------------------------------------------------------------------------------------------
interface MedicalRow {
  employee_code: string;
  employee_name: string;
  department: string;
  claim_id: string;
  claim_state: string;
  payment_state: string;
  expense_date: string;
  category: string;
  merchant: string;
  claimed_amount: string;
  approved_amount: string;
  currency: string;
  line: number;
}

export function MedicalClaimsPage() {
  const { can } = useSession();
  const today = localDate();
  const [filters, setFilters] = useState({ from: `${today.slice(0, 7)}-01`, to: today, search: '' });
  const [asked, setAsked] = useState(filters);
  const claims = useQuery({
    queryKey: ['payroll-extras', 'medical-claims', asked],
    queryFn: () => api<{ items: MedicalRow[] }>(`/v1/payroll-extras/medical-claims?${new URLSearchParams({ from: asked.from, to: asked.to, ...(asked.search.trim() ? { search: asked.search.trim() } : {}) })}`),
    enabled: can(MEDICAL_READ),
  });
  if (!can(MEDICAL_READ)) return <Empty>Medical claims need the expense read duty.</Empty>;
  return (
    <Section title="Medical claims">
      <p className="hint">Medical bills from submitted expense claims, listed by bill date.</p>
      <form
        className="filters"
        aria-label="Medical claim filters"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setAsked(filters);
        }}
      >
        <label>
          From
          <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} required />
        </label>
        <label>
          To
          <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} required />
        </label>
        <label>
          Search
          <input type="search" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
        </label>
        <button type="submit">Show</button>
      </form>
      <ErrorNote error={claims.error} />
      {claims.data && claims.data.items.length === 0 && <Empty>No medical claim in this period.</Empty>}
      {claims.data && claims.data.items.length > 0 && (
        <table aria-label="Medical claims">
          <thead>
            <tr>
              <th scope="col">Employee</th>
              <th scope="col">Department</th>
              <th scope="col">Bill date</th>
              <th scope="col">Category</th>
              <th scope="col">Merchant</th>
              <th scope="col">Claimed</th>
              <th scope="col">Approved</th>
              <th scope="col">Claim</th>
            </tr>
          </thead>
          <tbody>
            {claims.data.items.map((r) => (
              <tr key={`${r.claim_id}-${r.line}`}>
                <td>
                  {r.employee_name} ({r.employee_code})
                </td>
                <td>{r.department || '—'}</td>
                <td>{formatDate(r.expense_date)}</td>
                <td>{r.category}</td>
                <td>{r.merchant}</td>
                <td>{amount(r.claimed_amount)}</td>
                <td>{amount(r.approved_amount)}</td>
                <td>
                  {plain(r.claim_state)}, {plain(r.payment_state)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
