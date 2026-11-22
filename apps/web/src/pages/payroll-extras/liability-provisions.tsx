// The liability provisions screen (CL-098).
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FilterBar, FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { amount, plain, REPORT_READ, SALARY_READ } from './shared';

// ---------------------------------------------------------------------------------------------------------
// CL-098 liability provisions
// ---------------------------------------------------------------------------------------------------------
interface Provisions {
  asOf: string;
  employees: number;
  items: { item: string; status: string; reason: string | null; totals: { currencyCode: string; amount: string }[]; rows: number; unresolved: number }[];
  departments: { departmentCode: string; department: string; currencyCode: string; amounts: Record<string, string>; total: string }[];
  rows: { item: string; status: string; employeeCode: string; employeeName: string; department: string; amount: string | null; vested: string; basis: string }[];
}

const ITEM_LABEL: Record<string, string> = { GRATUITY: 'Gratuity', STATUTORY_BONUS: 'Statutory bonus', LEAVE_ENCASHMENT: 'Leave encashment', NOTICE_PAY: 'Notice pay' };

export function LiabilityProvisionsPage() {
  const { can } = useSession();
  const [asOf, setAsOf] = useState(localDate());
  const [asked, setAsked] = useState(asOf);
  const data = useQuery({
    queryKey: ['payroll-extras', 'liability-provisions', asked],
    queryFn: () => api<Provisions>(`/v1/payroll-extras/liability-provisions?asOf=${encodeURIComponent(asked)}`),
    enabled: can(REPORT_READ) && can(SALARY_READ),
  });
  if (!can(REPORT_READ)) return <Empty>Liability provisions need the payroll report read duty.</Empty>;
  // Every figure is worked from salaries: the salary read duty too (and the salary history duty for an earlier date, which the server checks).
  if (!can(SALARY_READ)) return <Empty>Liability provisions are worked from salaries: they need the salary read duty as well.</Empty>;
  const d = data.data;
  return (
    <>
      <Section title="Liability provisions">
        <FilterBar asChild>
          <form
            aria-label="As on"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setAsked(asOf);
            }}
          >
            <FormField>
              As on
              <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
            </FormField>
            <Button type="submit">Show</Button>
          </form>
        </FilterBar>
        <ErrorNote error={data.error} />
        {d && (
          <Table aria-label="Provision items">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Item</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.items.map((i) => (
                <TableRow key={i.item}>
                  <TableCell>{ITEM_LABEL[i.item] ?? i.item}</TableCell>
                  <TableCell>{i.status === 'CALCULATED' ? 'calculated' : `${plain(i.status)}: ${plain(i.reason ?? '')}`}</TableCell>
                  <TableCell>{i.status === 'CALCULATED' ? i.totals.map((t) => `${t.currencyCode} ${amount(t.amount)}`).join(', ') || '0.00' : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      {d && d.departments.length > 0 && (
        <Section title="By department">
          <Table aria-label="By department">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Department</TableHead>
                {d.items.map((i) => (
                  <TableHead scope="col" key={i.item}>
                    {ITEM_LABEL[i.item] ?? i.item}
                  </TableHead>
                ))}
                <TableHead scope="col">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.departments.map((g) => (
                <TableRow key={`${g.departmentCode}-${g.currencyCode}`}>
                  <TableCell>{g.department || 'No department'}</TableCell>
                  {d.items.map((i) => (
                    <TableCell key={i.item}>{amount(g.amounts[i.item])}</TableCell>
                  ))}
                  <TableCell>
                    {g.currencyCode} {amount(g.total)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
      {d && d.rows.length > 0 && (
        <Section title="Employees">
          <Table aria-label="Employee provisions">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Employee</TableHead>
                <TableHead scope="col">Department</TableHead>
                <TableHead scope="col">Item</TableHead>
                <TableHead scope="col">Amount</TableHead>
                <TableHead scope="col">Basis</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.rows.map((r, n) => (
                <TableRow key={`${r.item}-${r.employeeCode}-${n}`}>
                  <TableCell>
                    {r.employeeName} ({r.employeeCode})
                  </TableCell>
                  <TableCell>{r.department || '—'}</TableCell>
                  <TableCell>{ITEM_LABEL[r.item] ?? r.item}</TableCell>
                  <TableCell>{r.status === 'CALCULATED' ? amount(r.amount) : plain(r.status)}</TableCell>
                  <TableCell>
                    {r.basis}
                    {r.vested ? ` (vested: ${r.vested.toLowerCase()})` : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
    </>
  );
}
