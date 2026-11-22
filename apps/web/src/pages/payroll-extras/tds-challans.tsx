// The TDS challans screen (CL-081): challans, the upload, and the reconciliation by month.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
        <FilterBar>
          <FormField>
            Financial year
            <Input value={year} onChange={(e) => setYear(e.target.value)} pattern="\d{4}-\d{2}" />
          </FormField>
        </FilterBar>
        <ErrorNote error={challans.error} />
        {challans.data && challans.data.items.length === 0 && <Empty>No challan is recorded for {year}.</Empty>}
        {challans.data && challans.data.items.length > 0 && (
          <Table aria-label="Challans">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Month</TableHead>
                <TableHead scope="col">Section</TableHead>
                <TableHead scope="col">BSR code</TableHead>
                <TableHead scope="col">Serial</TableHead>
                <TableHead scope="col">Deposited on</TableHead>
                <TableHead scope="col">Amount</TableHead>
                <TableHead scope="col">State</TableHead>
                {manage && <TableHead scope="col">Action</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {challans.data.items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{formatMonth(c.month)}</TableCell>
                  <TableCell>{c.section}</TableCell>
                  <TableCell>{c.bsrCode}</TableCell>
                  <TableCell>{c.challanSerial}</TableCell>
                  <TableCell>{formatDate(c.depositDate)}</TableCell>
                  <TableCell>{amountsHidden ? 'Hidden' : amount(c.amount)}</TableCell>
                  <TableCell>{c.state === 'CANCELLED' ? `cancelled: ${c.cancelReason ?? ''}` : 'recorded'}</TableCell>
                  {manage && (
                    <RowActionsCell>
                      {c.state === 'RECORDED' && (
                        <RowActions>
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            disabled={cancel.isPending}
                            onClick={() => {
                              const reason = window.prompt('Why is this challan cancelled?');
                              if (reason?.trim()) cancel.mutate({ c, reason: reason.trim() });
                            }}
                          >
                            Cancel
                          </Button>
                        </RowActions>
                      )}
                    </RowActionsCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {challans.data && challans.data.items.length > 0 && amountsHidden && <Hint>The amounts deposited are company payroll figures: seeing them needs the payroll report read duty, company-wide.</Hint>}
        <ErrorNote error={cancel.error} />
      </Section>
      {can(REPORT_READ) && (
        <Section title="Deducted and deposited">
          <ErrorNote error={reconciliation.error} />
          {reconciliation.data && (
            <>
              <Hint>Form 24Q: {plain(reconciliation.data.form24Q.status)}. {reconciliation.data.form24Q.reason}</Hint>
              {reconciliation.data.months.length === 0 ? (
                <Empty>Nothing deducted or deposited in {year}.</Empty>
              ) : (
                <Table aria-label="Reconciliation">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Month</TableHead>
                      <TableHead scope="col">TDS deducted</TableHead>
                      <TableHead scope="col">Deposited</TableHead>
                      <TableHead scope="col">Difference</TableHead>
                      <TableHead scope="col">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconciliation.data.months.map((m) => (
                      <TableRow key={m.month}>
                        <TableCell>{formatMonth(m.month)}</TableCell>
                        <TableCell>{amount(m.deducted)}</TableCell>
                        <TableCell>{amount(m.deposited)}</TableCell>
                        <TableCell>{amount(m.difference)}</TableCell>
                        <TableCell>{plain(m.status)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </Section>
      )}
      {manage && (
        <>
          <Section title="Enter a challan">
            <FormGrid
              aria-label="Enter a challan"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                if (!record.isPending) record.mutate();
              }}
            >
              <FormField>
                Month
                <Input type="month" value={form.month} onChange={set('month')} required />
              </FormField>
              <FormField>
                Section
                <Input value={form.section} onChange={set('section')} required maxLength={10} />
              </FormField>
              <FormField>
                BSR code
                <Input value={form.bsrCode} onChange={set('bsrCode')} required maxLength={7} />
              </FormField>
              <FormField>
                Challan serial
                <Input value={form.challanSerial} onChange={set('challanSerial')} required maxLength={5} />
              </FormField>
              <FormField>
                Deposit date
                <Input type="date" value={form.depositDate} onChange={set('depositDate')} required />
              </FormField>
              <FormField>
                Amount
                <Input value={form.amount} onChange={set('amount')} required inputMode="decimal" />
              </FormField>
              <Button type="submit" disabled={record.isPending}>
                Record challan
              </Button>
            </FormGrid>
            <ErrorNote error={record.error} />
          </Section>
          <UploadPanel template={TDS_CHALLAN_TEMPLATE} title="Upload TDS challans" fileLabel="Challan file" />
        </>
      )}
    </>
  );
}
