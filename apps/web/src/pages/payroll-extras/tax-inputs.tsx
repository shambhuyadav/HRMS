// The tax inputs screen: perquisites (CL-085) and past salary (CL-084 / CL-119).
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatMonth, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { amount, fiscalYearOf, plain, TAX_IMPORT, TAX_READ } from './shared';
import { PAST_SALARY_TEMPLATE, PERQUISITES_TEMPLATE, UploadPanel } from './upload';

// ---------------------------------------------------------------------------------------------------------
// CL-085 perquisites, CL-084 / CL-119 past salary
// ---------------------------------------------------------------------------------------------------------
interface TaxInputs {
  tdsProjection: { status: string; reason: string };
  items: {
    employeeId: string;
    employeeCode: string;
    employeeName: string;
    perquisites: { month: string; perquisiteType: string; value: string; revision: number }[];
    pastSalary: { source: string; fromMonth: string; toMonth: string; taxableSalary: string; tdsDeducted: string; revision: number }[];
  }[];
}

export function TaxInputsPage() {
  const { can } = useSession();
  const [year, setYear] = useState(fiscalYearOf(localDate()));
  const [search, setSearch] = useState('');
  const view = useQuery({
    queryKey: ['payroll-extras', 'tax-inputs', year, search],
    queryFn: () => api<TaxInputs>(`/v1/payroll-extras/tax-inputs?${new URLSearchParams({ fiscalYear: year, ...(search.trim() ? { search: search.trim() } : {}) })}`),
    enabled: can(TAX_READ),
  });
  if (!can(TAX_READ) && !can(TAX_IMPORT)) return <Empty>Perquisites and past salary need the payroll tax input duties.</Empty>;
  return (
    <>
      {can(TAX_READ) && (
        <Section title="Perquisites and past salary">
          {view.data && (
            <p className="hint" role="note">
              Tax projection: {plain(view.data.tdsProjection.status)}. {view.data.tdsProjection.reason}
            </p>
          )}
          <div className="filters">
            <label>
              Financial year
              <input value={year} onChange={(e) => setYear(e.target.value)} pattern="\d{4}-\d{2}" />
            </label>
            <label>
              Name or code
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
          </div>
          <ErrorNote error={view.error} />
          {view.data && view.data.items.length === 0 && <Empty>Nothing is recorded for {year}.</Empty>}
          {view.data && view.data.items.length > 0 && (
            <table aria-label="Recorded inputs">
              <thead>
                <tr>
                  <th scope="col">Employee</th>
                  <th scope="col">Perquisites</th>
                  <th scope="col">Past salary</th>
                </tr>
              </thead>
              <tbody>
                {view.data.items.map((i) => (
                  <tr key={i.employeeId}>
                    <td>
                      {i.employeeName} ({i.employeeCode})
                    </td>
                    <td>{i.perquisites.map((p) => `${formatMonth(p.month)} ${plain(p.perquisiteType)} ${amount(p.value)}`).join('; ') || '—'}</td>
                    <td>{i.pastSalary.map((s) => `${plain(s.source)} ${formatMonth(s.fromMonth)} to ${formatMonth(s.toMonth)}: salary ${amount(s.taxableSalary)}, TDS ${amount(s.tdsDeducted)}`).join('; ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}
      {can(TAX_IMPORT) && (
        <>
          <UploadPanel template={PERQUISITES_TEMPLATE} title="Upload perquisites" fileLabel="Perquisites file" />
          <UploadPanel template={PAST_SALARY_TEMPLATE} title="Upload past salary" fileLabel="Past salary file" />
        </>
      )}
    </>
  );
}
