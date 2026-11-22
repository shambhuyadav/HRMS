// The medical claims screen (CL-113).
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
      <Hint>Medical bills from submitted expense claims, listed by bill date.</Hint>
      <FilterBar asChild>
        <form
          aria-label="Medical claim filters"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setAsked(filters);
          }}
        >
          <FormField>
            From
            <Input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} required />
          </FormField>
          <FormField>
            To
            <Input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} required />
          </FormField>
          <FormField>
            Search
            <Input type="search" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
          </FormField>
          <Button type="submit">Show</Button>
        </form>
      </FilterBar>
      <ErrorNote error={claims.error} />
      {claims.data && claims.data.items.length === 0 && <Empty>No medical claim in this period.</Empty>}
      {claims.data && claims.data.items.length > 0 && (
        <Table aria-label="Medical claims">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Department</TableHead>
              <TableHead scope="col">Bill date</TableHead>
              <TableHead scope="col">Category</TableHead>
              <TableHead scope="col">Merchant</TableHead>
              <TableHead scope="col">Claimed</TableHead>
              <TableHead scope="col">Approved</TableHead>
              <TableHead scope="col">Claim</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {claims.data.items.map((r) => (
              <TableRow key={`${r.claim_id}-${r.line}`}>
                <TableCell>
                  {r.employee_name} ({r.employee_code})
                </TableCell>
                <TableCell>{r.department || '—'}</TableCell>
                <TableCell>{formatDate(r.expense_date)}</TableCell>
                <TableCell>{r.category}</TableCell>
                <TableCell>{r.merchant}</TableCell>
                <TableCell>{amount(r.claimed_amount)}</TableCell>
                <TableCell>{amount(r.approved_amount)}</TableCell>
                <TableCell>
                  {plain(r.claim_state)}, {plain(r.payment_state)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
