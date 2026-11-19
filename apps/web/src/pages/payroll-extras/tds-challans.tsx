// The TDS challans screen (CL-081): challans, the upload, and the reconciliation by month.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formatDate, formatMonth, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { amount, CHALLAN_MANAGE, CHALLAN_READ, fiscalYearOf, plain, REPORT_READ } from './shared';
import { TDS_CHALLAN_TEMPLATE, UploadPanel } from './upload';

// ---------------------------------------------------------------------------------------------------------
// CL-081 TDS challans
// ---------------------------------------------------------------------------------------------------------
interface TdsChallan {
  id: string;
  month: string;
  section: string;
  bsrCode: string;
  challanSerial: string;
  depositDate: string;
  /** Null when the amounts are hidden (amountsHidden). */
  amount: string | null;
  source: string;
  state: string;
  cancelReason: string | null;
  version: number;
}

/** The year's challans; without the payroll report read duty the amounts and totals are hidden (null). */
interface ChallanList {
  amountsHidden?: boolean;
  items: TdsChallan[];
  months: { month: string; deposited: string | null }[];
}

interface Reconciliation {
  form24Q: { status: string; reason: string };
  months: { month: string; deducted: string; deposited: string; difference: string; status: string }[];
}

export function TdsChallansPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [year, setYear] = useState(fiscalYearOf(localDate()));
  const challans = useQuery({
    queryKey: ['payroll-extras', 'tds-challans', year],
    queryFn: () => api<ChallanList>(`/v1/payroll-extras/tds-challans?fiscalYear=${encodeURIComponent(year)}`),
  });
  const reconciliation = useQuery({
    queryKey: ['payroll-extras', 'tds-reconciliation', year],
    queryFn: () => api<Reconciliation>(`/v1/payroll-extras/tds-reconciliation?fiscalYear=${encodeURIComponent(year)}`),
    enabled: can(REPORT_READ),
  });
  // No section is assumed: the section numbers change with the Income-tax Act in force, so the user enters the challan's own.
  const blank = { month: '', section: '', bsrCode: '', challanSerial: '', depositDate: '', amount: '' };
  const [form, setForm] = useState(blank);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payroll-extras'] });
  const record = useMutation({
    mutationFn: () => api<TdsChallan>('/v1/payroll-extras/tds-challans', { body: form }),
    onSuccess: () => {
      setForm(blank);
      refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: ({ c, reason }: { c: TdsChallan; reason: string }) => api<TdsChallan>(`/v1/payroll-extras/tds-challans/${c.id}/cancel`, { body: { reason, expectedVersion: c.version } }),
    onSuccess: refresh,
  });
  if (!can(CHALLAN_READ)) return <Empty>TDS challans need the challan read duty.</Empty>;
  const manage = can(CHALLAN_MANAGE);
  const amountsHidden = challans.data?.amountsHidden === true;
  return (
    <>
      <Section title="TDS challans">
        <div className="filters">
          <label>
            Financial year
            <input value={year} onChange={(e) => setYear(e.target.value)} pattern="\d{4}-\d{2}" />
          </label>
        </div>
        <ErrorNote error={challans.error} />
        {challans.data && challans.data.items.length === 0 && <Empty>No challan is recorded for {year}.</Empty>}
        {challans.data && challans.data.items.length > 0 && (
          <table aria-label="Challans">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Section</th>
                <th scope="col">BSR code</th>
                <th scope="col">Serial</th>
                <th scope="col">Deposited on</th>
                <th scope="col">Amount</th>
                <th scope="col">State</th>
                {manage && <th scope="col">Action</th>}
              </tr>
            </thead>
            <tbody>
              {challans.data.items.map((c) => (
                <tr key={c.id}>
                  <td>{formatMonth(c.month)}</td>
                  <td>{c.section}</td>
                  <td>{c.bsrCode}</td>
                  <td>{c.challanSerial}</td>
                  <td>{formatDate(c.depositDate)}</td>
                  <td>{amountsHidden ? 'Hidden' : amount(c.amount)}</td>
                  <td>{c.state === 'CANCELLED' ? `cancelled: ${c.cancelReason ?? ''}` : 'recorded'}</td>
                  {manage && (
                    <td>
                      {c.state === 'RECORDED' && (
                        <button
                          type="button"
                          disabled={cancel.isPending}
                          onClick={() => {
                            const reason = window.prompt('Why is this challan cancelled?');
                            if (reason?.trim()) cancel.mutate({ c, reason: reason.trim() });
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {challans.data && challans.data.items.length > 0 && amountsHidden && <p className="hint">The amounts deposited are company payroll figures: seeing them needs the payroll report read duty, company-wide.</p>}
        <ErrorNote error={cancel.error} />
      </Section>
      {can(REPORT_READ) && (
        <Section title="Deducted and deposited">
          <ErrorNote error={reconciliation.error} />
          {reconciliation.data && (
            <>
              <p className="hint">Form 24Q: {plain(reconciliation.data.form24Q.status)}. {reconciliation.data.form24Q.reason}</p>
              {reconciliation.data.months.length === 0 ? (
                <Empty>Nothing deducted or deposited in {year}.</Empty>
              ) : (
                <table aria-label="Reconciliation">
                  <thead>
                    <tr>
                      <th scope="col">Month</th>
                      <th scope="col">TDS deducted</th>
                      <th scope="col">Deposited</th>
                      <th scope="col">Difference</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconciliation.data.months.map((m) => (
                      <tr key={m.month}>
                        <td>{formatMonth(m.month)}</td>
                        <td>{amount(m.deducted)}</td>
                        <td>{amount(m.deposited)}</td>
                        <td>{amount(m.difference)}</td>
                        <td>{plain(m.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </Section>
      )}
      {manage && (
        <>
          <Section title="Enter a challan">
            <form
              className="grid-form"
              aria-label="Enter a challan"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                if (!record.isPending) record.mutate();
              }}
            >
              <label>
                Month
                <input type="month" value={form.month} onChange={set('month')} required />
              </label>
              <label>
                Section
                <input value={form.section} onChange={set('section')} required maxLength={10} />
              </label>
              <label>
                BSR code
                <input value={form.bsrCode} onChange={set('bsrCode')} required maxLength={7} />
              </label>
              <label>
                Challan serial
                <input value={form.challanSerial} onChange={set('challanSerial')} required maxLength={5} />
              </label>
              <label>
                Deposit date
                <input type="date" value={form.depositDate} onChange={set('depositDate')} required />
              </label>
              <label>
                Amount
                <input value={form.amount} onChange={set('amount')} required inputMode="decimal" />
              </label>
              <button type="submit" disabled={record.isPending}>
                Record challan
              </button>
            </form>
            <ErrorNote error={record.error} />
          </Section>
          <UploadPanel template={TDS_CHALLAN_TEMPLATE} title="Upload TDS challans" fileLabel="Challan file" />
        </>
      )}
    </>
  );
}
