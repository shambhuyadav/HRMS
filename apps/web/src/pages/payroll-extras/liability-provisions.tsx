// The liability provisions screen (CL-098).
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
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
        <form
          className="filters"
          aria-label="As on"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setAsked(asOf);
          }}
        >
          <label>
            As on
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
          </label>
          <button type="submit">Show</button>
        </form>
        <ErrorNote error={data.error} />
        {d && (
          <table aria-label="Provision items">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Status</th>
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((i) => (
                <tr key={i.item}>
                  <td>{ITEM_LABEL[i.item] ?? i.item}</td>
                  <td>{i.status === 'CALCULATED' ? 'calculated' : `${plain(i.status)}: ${plain(i.reason ?? '')}`}</td>
                  <td>{i.status === 'CALCULATED' ? i.totals.map((t) => `${t.currencyCode} ${amount(t.amount)}`).join(', ') || '0.00' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      {d && d.departments.length > 0 && (
        <Section title="By department">
          <table aria-label="By department">
            <thead>
              <tr>
                <th scope="col">Department</th>
                {d.items.map((i) => (
                  <th scope="col" key={i.item}>
                    {ITEM_LABEL[i.item] ?? i.item}
                  </th>
                ))}
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {d.departments.map((g) => (
                <tr key={`${g.departmentCode}-${g.currencyCode}`}>
                  <td>{g.department || 'No department'}</td>
                  {d.items.map((i) => (
                    <td key={i.item}>{amount(g.amounts[i.item])}</td>
                  ))}
                  <td>
                    {g.currencyCode} {amount(g.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {d && d.rows.length > 0 && (
        <Section title="Employees">
          <table aria-label="Employee provisions">
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Department</th>
                <th scope="col">Item</th>
                <th scope="col">Amount</th>
                <th scope="col">Basis</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r, n) => (
                <tr key={`${r.item}-${r.employeeCode}-${n}`}>
                  <td>
                    {r.employeeName} ({r.employeeCode})
                  </td>
                  <td>{r.department || '—'}</td>
                  <td>{ITEM_LABEL[r.item] ?? r.item}</td>
                  <td>{r.status === 'CALCULATED' ? amount(r.amount) : plain(r.status)}</td>
                  <td>
                    {r.basis}
                    {r.vested ? ` (vested: ${r.vested.toLowerCase()})` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}
