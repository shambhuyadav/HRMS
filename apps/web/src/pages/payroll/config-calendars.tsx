// Payroll configuration: calendars and their periods (FR-030).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { ActivateControl, type CalendarDetail, type CalendarPeriod, Choice, CONFIG_ACTIVATE, CONFIG_MANAGE, CONFIG_STATE, ISO_DAY, MINOR_UNITS, NOT_CONFIG, useCalendarActivation, useCalendars } from './config';
import { PaidDayPolicySection } from './config-paid-days';
import { Missing, Note } from './pickers';
import { Problem } from './problems';
import { CONFIG_READ, Fact, FLUSH, H3, label, PATHS, SCROLL, Status, useKeys } from './shared';

// ---- Calendars and periods (FR-030) ----

export function CalendarsScreen() {
  const { can } = useSession();
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Payroll calendars">
        <Empty>{NOT_CONFIG}</Empty>
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
      <p className="hint">
        No calendar exists by default. A calendar is saved as a draft with its currency, gets its monthly periods, and is activated by someone other than its author; runs and
        inputs use only the periods of an active calendar.
      </p>
      {calendars.isPending && <p className="hint loading">Loading payroll calendars…</p>}
      {calendars.error && <Problem error={calendars.error} act="read" />}
      <Note text={note} />
      {calendars.data && calendars.data.items.length === 0 && <Empty>No payroll calendar is defined, so no payroll can be run yet.</Empty>}
      {calendars.data && calendars.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Payroll calendars">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Currency</th>
                <th>Minor unit</th>
                <th>Periods</th>
                <th>State</th>
                {activator && <th>Activation</th>}
              </tr>
            </thead>
            <tbody>
              {calendars.data.items.map((k) => (
                <tr key={k.id}>
                  <td>
                    <Link to={PATHS.calendar(k.id)} aria-label={`Open calendar ${k.code}`}>
                      {k.code}
                    </Link>
                  </td>
                  <td>{k.name}</td>
                  <td>{k.currencyCode}</td>
                  <td>{label(MINOR_UNITS, String(k.currencyMinorUnit))}</td>
                  <td>{k.periods.length}</td>
                  <td>
                    <Status map={CONFIG_STATE} code={k.state} />
                  </td>
                  {activator && (
                    <td>
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
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <form onSubmit={submit} aria-label="Create a payroll calendar" className="grid-form">
        <label>
          Calendar code
          <input value={f.code} onChange={(e) => set({ code: e.target.value })} maxLength={40} autoComplete="off" />
        </label>
        <label>
          Calendar name
          <input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} autoComplete="off" />
        </label>
        <label>
          Currency (ISO code)
          <input value={f.currencyCode} onChange={(e) => set({ currencyCode: e.target.value })} maxLength={3} autoComplete="off" />
        </label>
        <Choice label="Currency minor unit" value={f.currencyMinorUnit} onChange={(v) => set({ currencyMinorUnit: v })} options={MINOR_UNITS} />
        <div className="row">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Save the calendar as a draft'}
          </button>
        </div>
        <Missing text={problem} />
        <div className="wide">
          <Note text={note} />
          <Problem error={create.error} act="calendar" />
        </div>
      </form>
    </Section>
  );
}

export function CalendarScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Payroll calendar">
        <Empty>{NOT_CONFIG}</Empty>
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
      <Section title={k ? `Payroll calendar ${k.code}` : 'Payroll calendar'} actions={<Link to={PATHS.calendars}>All calendars</Link>}>
        {calendar.isPending && <p className="hint loading">Loading the calendar…</p>}
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
          <p style={FLUSH}>
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
          <p className="hint">
            Each period is one whole calendar month of service with its input cutoff and payment date. A period is fixed once payroll runs, inputs or salary stops use it.
          </p>
          {k.periods.length === 0 && <Empty>The calendar has no periods yet, so it cannot be activated.</Empty>}
          {k.periods.length > 0 && (
            <div style={SCROLL}>
              <table aria-label={`Periods of calendar ${k.code}`}>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Financial year</th>
                    <th>Service period</th>
                    <th>Input cutoff</th>
                    <th>Payment date</th>
                    {manage && <th>Change</th>}
                  </tr>
                </thead>
                <tbody>
                  {k.periods.map((p) => (
                    <tr key={p.id}>
                      <td>{p.periodCode}</td>
                      <td>{p.financialYear}</td>
                      <td>{`${formatDate(p.serviceStart)} to ${formatDate(p.serviceEnd)}`}</td>
                      <td>{formatDate(p.inputCutoff)}</td>
                      <td>{formatDate(p.paymentDate)}</td>
                      {manage && (
                        <td>
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              setNote(null);
                              setEditing(p.id);
                            }}
                            aria-label={`Change the dates of period ${p.periodCode}`}
                          >
                            Change dates
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
    <form onSubmit={submit} aria-label={name} className="grid-form" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3} className="wide">
        {name}
      </h3>
      {!period && (
        <label>
          Period code
          <input value={f.periodCode} onChange={(e) => set({ periodCode: e.target.value })} maxLength={20} autoComplete="off" />
        </label>
      )}
      <label>
        Financial year
        <input value={f.financialYear} onChange={(e) => set({ financialYear: e.target.value })} maxLength={20} autoComplete="off" />
      </label>
      <label>
        Service start
        <input type="date" value={f.serviceStart} onChange={(e) => set({ serviceStart: e.target.value })} />
      </label>
      <label>
        Service end
        <input type="date" value={f.serviceEnd} onChange={(e) => set({ serviceEnd: e.target.value })} />
      </label>
      <label>
        Input cutoff
        <input type="date" value={f.inputCutoff} onChange={(e) => set({ inputCutoff: e.target.value })} />
      </label>
      <label>
        Payment date
        <input type="date" value={f.paymentDate} onChange={(e) => set({ paymentDate: e.target.value })} />
      </label>
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : period ? 'Save the new dates' : 'Add the period'}
        </button>
        {onClose && (
          <button type="button" className="secondary" onClick={onClose} disabled={save.isPending}>
            Close
          </button>
        )}
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Problem error={save.error} act="period" />
      </div>
    </form>
  );
}
