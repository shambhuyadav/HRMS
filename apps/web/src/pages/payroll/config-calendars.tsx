// Payroll configuration: calendars and their periods (FR-030).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { ActivateControl, type CalendarDetail, type CalendarPeriod, Choice, CONFIG_ACTIVATE, CONFIG_MANAGE, CONFIG_STATE, ISO_DAY, MINOR_UNITS, NOT_CONFIG, useCalendarActivation, useCalendars } from './config';
import { PaidDayPolicySection } from './config-paid-days';
import { Missing, Note } from './pickers';
import { Problem } from './problems';
import { CONFIG_READ, Fact, label, PATHS, Status, useKeys } from './shared';

// ---- Calendars and periods (FR-030) ----

export function CalendarsScreen() {
  const { can } = useSession();
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Payroll calendars">
        <Empty refusal>{NOT_CONFIG}</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <CalendarList />
      {can(CONFIG_MANAGE) && <CalendarForm />}
      <PaidDayPolicySection />
    </div>
  );
}

function CalendarList() {
  const { can } = useSession();
  const calendars = useCalendars();
  const [note, setNote] = useState<string | null>(null);
  const activate = useCalendarActivation(setNote);
  const activator = can(CONFIG_ACTIVATE);
  return (
    <Section title="Payroll calendars">
      <Hint>
        No calendar exists by default. A calendar is saved as a draft with its currency, gets its monthly periods, and is activated by someone other than its author; runs and
        inputs use only the periods of an active calendar.
      </Hint>
      {calendars.isPending && <LoadingLine>Loading payroll calendars…</LoadingLine>}
      {calendars.error && <Problem error={calendars.error} act="read" />}
      <Note text={note} />
      {calendars.data && calendars.data.items.length === 0 && <Empty>No payroll calendar is defined, so no payroll can be run yet.</Empty>}
      {calendars.data && calendars.data.items.length > 0 && (
        <Table aria-label="Payroll calendars">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Currency</TableHead>
              <TableHead scope="col">Minor unit</TableHead>
              <TableHead scope="col">Periods</TableHead>
              <TableHead scope="col">State</TableHead>
              {activator && <TableHead scope="col">Activation</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {calendars.data.items.map((k) => (
              <TableRow key={k.id}>
                <TableCell>
                  <Link to={PATHS.calendar(k.id)} aria-label={`Open calendar ${k.code}`}>
                    {k.code}
                  </Link>
                </TableCell>
                <TableCell>{k.name}</TableCell>
                <TableCell>{k.currencyCode}</TableCell>
                <TableCell>{label(MINOR_UNITS, String(k.currencyMinorUnit))}</TableCell>
                <TableCell>{k.periods.length}</TableCell>
                <TableCell>
                  <Status map={CONFIG_STATE} code={k.state} />
                </TableCell>
                {activator && (
                  <RowActionsCell>
                    <RowActions>
                      <ActivateControl
                        state={k.state}
                        createdBy={k.createdBy}
                        name={`calendar ${k.code}`}
                        busy={activate.isPending}
                        onActivate={() => {
                          setNote(null);
                          activate.mutate(k);
                        }}
                      />
                    </RowActions>
                  </RowActionsCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Problem error={activate.error} act="calendar-activate" />
    </Section>
  );
}

function CalendarForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  const empty = { code: '', name: '', currencyCode: '', currencyMinorUnit: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<CalendarDetail>('/v1/payroll/calendars', { body }),
    onSuccess: (k) => {
      setF(empty);
      setNote(`Calendar ${k.code} saved as a draft: add its periods; someone other than you activates it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.calendars }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const currency = f.currencyCode.trim().toUpperCase();
    if (!f.code.trim() || !f.name.trim()) return setProblem('Give the calendar code and name.');
    if (!/^[A-Z]{3}$/.test(currency)) return setProblem('The currency is a three-letter ISO code.');
    if (!(f.currencyMinorUnit in MINOR_UNITS)) return setProblem('Choose the currency’s minor unit (its number of decimals).');
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({ code: f.code.trim().toUpperCase(), name: f.name.trim(), currencyCode: currency, currencyMinorUnit: Number(f.currencyMinorUnit) });
  };
  return (
    <Section title="New payroll calendar">
      <FormGrid onSubmit={submit} aria-label="Create a payroll calendar">
        <FormField>
          Calendar code
          <Input value={f.code} onChange={(e) => set({ code: e.target.value })} maxLength={40} autoComplete="off" />
        </FormField>
        <FormField>
          Calendar name
          <Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} autoComplete="off" />
        </FormField>
        <FormField>
          Currency (ISO code)
          <Input value={f.currencyCode} onChange={(e) => set({ currencyCode: e.target.value })} maxLength={3} autoComplete="off" />
        </FormField>
        <Choice label="Currency minor unit" value={f.currencyMinorUnit} onChange={(v) => set({ currencyMinorUnit: v })} options={MINOR_UNITS} />
        <ButtonRow>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Save the calendar as a draft'}
          </Button>
        </ButtonRow>
        <Missing text={problem} />
        <div className="col-span-full">
          <Note text={note} />
          <Problem error={create.error} act="calendar" />
        </div>
      </FormGrid>
    </Section>
  );
}

export function CalendarScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Payroll calendar">
        <Empty refusal>{NOT_CONFIG}</Empty>
      </Section>
    );
  }
  return <CalendarView key={id} id={id} />;
}

function CalendarView({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const calendar = useQuery({ queryKey: keys.calendar(id), queryFn: () => api<CalendarDetail>(`/v1/payroll/calendars/${encodeURIComponent(id)}`), retry: retryTransient });
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const activate = useCalendarActivation(setNote);
  const k = calendar.data;
  const manage = can(CONFIG_MANAGE) && k !== undefined && k.state !== 'RETIRED';
  const edited = k?.periods.find((p) => p.id === editing) ?? null;
  return (
    <div className="stack">
      <Section
        title={k ? `Payroll calendar ${k.code}` : 'Payroll calendar'}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={PATHS.calendars}>All calendars</Link>
          </Button>
        }
      >
        {calendar.isPending && <LoadingLine>Loading the calendar…</LoadingLine>}
        {calendar.error && <Problem error={calendar.error} act="read" />}
        <Note text={note} />
        {k && (
          <dl className="kv">
            <Fact term="Name">{k.name}</Fact>
            <Fact term="Currency">{k.currencyCode}</Fact>
            <Fact term="Minor unit">{label(MINOR_UNITS, String(k.currencyMinorUnit))}</Fact>
            <Fact term="State">
              <Status map={CONFIG_STATE} code={k.state} />
            </Fact>
            {k.activatedAt && <Fact term="Activated">{formatDate(k.activatedAt)}</Fact>}
          </dl>
        )}
        {k && can(CONFIG_ACTIVATE) && k.state === 'DRAFT' && (
          <p className="my-1">
            <ActivateControl
              state={k.state}
              createdBy={k.createdBy}
              name={`calendar ${k.code}`}
              busy={activate.isPending}
              onActivate={() => {
                setNote(null);
                activate.mutate(k);
              }}
            />
          </p>
        )}
        <Problem error={activate.error} act="calendar-activate" />
      </Section>
      {k && (
        <Section title="Periods">
          <Hint>Each period is one whole calendar month of service with its input cutoff and payment date. A period is fixed once payroll runs, inputs or salary stops use it.</Hint>
          {k.periods.length === 0 && <Empty>The calendar has no periods yet, so it cannot be activated.</Empty>}
          {k.periods.length > 0 && (
            <Table aria-label={`Periods of calendar ${k.code}`}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Period</TableHead>
                  <TableHead scope="col">Financial year</TableHead>
                  <TableHead scope="col">Service period</TableHead>
                  <TableHead scope="col">Input cutoff</TableHead>
                  <TableHead scope="col">Payment date</TableHead>
                  {manage && <TableHead scope="col">Change</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {k.periods.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.periodCode}</TableCell>
                    <TableCell>{p.financialYear}</TableCell>
                    <TableCell>{`${formatDate(p.serviceStart)} to ${formatDate(p.serviceEnd)}`}</TableCell>
                    <TableCell>{formatDate(p.inputCutoff)}</TableCell>
                    <TableCell>{formatDate(p.paymentDate)}</TableCell>
                    {manage && (
                      <RowActionsCell>
                        <RowActions>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setNote(null);
                              setEditing(p.id);
                            }}
                            aria-label={`Change the dates of period ${p.periodCode}`}
                          >
                            Change dates
                          </Button>
                        </RowActions>
                      </RowActionsCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {manage && edited && (
            <PeriodForm
              key={edited.id}
              calendar={k}
              period={edited}
              onDone={(text) => {
                setEditing(null);
                setNote(text);
              }}
              onClose={() => setEditing(null)}
            />
          )}
          {manage && <PeriodForm calendar={k} period={null} onDone={setNote} />}
        </Section>
      )}
    </div>
  );
}

/** The period form's button: saving, saving a changed period's dates, or adding a new period. */
function periodButtonText(saving: boolean, changing: boolean): string {
  if (saving) return 'Saving…';
  return changing ? 'Save the new dates' : 'Add the period';
}

function PeriodForm({ calendar, period, onDone, onClose }: { calendar: CalendarDetail; period: CalendarPeriod | null; onDone: (text: string) => void; onClose?: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  // A change starts from the period as recorded; a new period starts empty (no default exists).
  const empty = {
    periodCode: period?.periodCode ?? '',
    financialYear: period?.financialYear ?? '',
    serviceStart: period?.serviceStart ?? '',
    serviceEnd: period?.serviceEnd ?? '',
    inputCutoff: period?.inputCutoff ?? '',
    paymentDate: period?.paymentDate ?? '',
  };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      period
        ? api<CalendarPeriod>(`/v1/payroll/periods/${encodeURIComponent(period.id)}`, { method: 'PUT', body: { ...body, expectedVersion: period.version } })
        : api<CalendarPeriod>(`/v1/payroll/calendars/${encodeURIComponent(calendar.id)}/periods`, { body: { periodCode: f.periodCode.trim().toUpperCase(), ...body } }),
    onSuccess: (p) => {
      setF(empty);
      onDone(period ? `The dates of period ${p.periodCode} were changed.` : `Period ${p.periodCode} was added to calendar ${calendar.code}.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.calendars }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const name = period ? `Change the dates of period ${period.periodCode}` : 'Add a period';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    if (!period && !f.periodCode.trim()) return setProblem('Give the period code.');
    if (!f.financialYear.trim()) return setProblem('Give the financial year label.');
    if (![f.serviceStart, f.serviceEnd, f.inputCutoff, f.paymentDate].every((d) => ISO_DAY.test(d))) return setProblem('Give the service start and end, the input cutoff and the payment date.');
    setProblem(null);
    save.reset();
    save.mutate({ financialYear: f.financialYear.trim().toUpperCase(), serviceStart: f.serviceStart, serviceEnd: f.serviceEnd, inputCutoff: f.inputCutoff, paymentDate: f.paymentDate });
  };
  return (
    <FormGrid onSubmit={submit} aria-label={name}>
      <CardSubheading>{name}</CardSubheading>
      {!period && (
        <FormField>
          Period code
          <Input value={f.periodCode} onChange={(e) => set({ periodCode: e.target.value })} maxLength={20} autoComplete="off" />
        </FormField>
      )}
      <FormField>
        Financial year
        <Input value={f.financialYear} onChange={(e) => set({ financialYear: e.target.value })} maxLength={20} autoComplete="off" />
      </FormField>
      <FormField>
        Service start
        <Input type="date" value={f.serviceStart} onChange={(e) => set({ serviceStart: e.target.value })} />
      </FormField>
      <FormField>
        Service end
        <Input type="date" value={f.serviceEnd} onChange={(e) => set({ serviceEnd: e.target.value })} />
      </FormField>
      <FormField>
        Input cutoff
        <Input type="date" value={f.inputCutoff} onChange={(e) => set({ inputCutoff: e.target.value })} />
      </FormField>
      <FormField>
        Payment date
        <Input type="date" value={f.paymentDate} onChange={(e) => set({ paymentDate: e.target.value })} />
      </FormField>
      <ButtonRow>
        <Button type="submit" disabled={save.isPending}>
          {periodButtonText(save.isPending, period !== null)}
        </Button>
        {onClose && (
          <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
            Close
          </Button>
        )}
      </ButtonRow>
      <Missing text={problem} />
      <div className="col-span-full">
        <Problem error={save.error} act="period" />
      </div>
    </FormGrid>
  );
}
