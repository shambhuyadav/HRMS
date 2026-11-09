// Statutory settings (I-85, FR-039; decided under owner delegation, 6 Nov 2026):
//   /payroll/statutory-settings
//
// The dated settings the statutory evaluator reads, besides the packs themselves:
// - the state of a work location, from a date: the professional tax pack (PT_<state>) and the labour welfare fund pack (LWF_<state>) of
//   an employee are those of the state of their work location on the day valued;
// - an employee's PF contribution basis, from a date: on wages up to the PF pack's ceiling, or on higher wages by a joint option (EPF
//   Scheme para 26(6)). Without one, the ceiling applies.
// Both are payroll configuration (payroll_config: read for the states, manage to record either and to read an employee's options) and
// append-only: a change is a later row, and the row in force on a day is the latest that starts on or before it. The server checks every
// call and every rule; this screen shows what it returned and its refusals in plain words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Section } from '../ui';

const CONFIG_READ = 'payroll_config.read.operational';
const CONFIG_MANAGE = 'payroll_config.manage.operational';
const PATH = '/payroll/statutory-settings';

interface LocationState {
  id: string;
  locationCode: string;
  sequence: number;
  effectiveFrom: string;
  stateCode: string;
}
interface PfOption {
  id: string;
  sequence: number;
  effectiveFrom: string;
  contributionBasis: 'STATUTORY_CEILING' | 'HIGHER_WAGES';
  reference: string;
}
interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
}

const BASIS: Record<string, string> = {
  STATUTORY_CEILING: 'On wages up to the PF ceiling',
  HIGHER_WAGES: 'On higher wages (joint option, para 26(6))',
};

function LocationStates() {
  const { can } = useSession();
  const qc = useQueryClient();
  const states = useQuery({ queryKey: ['statutory-settings', 'location-states'], queryFn: () => api<{ items: LocationState[] }>('/v1/statutory/pt-states') });
  const [locationCode, setLocationCode] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: (body: { locationCode: string; effectiveFrom: string; stateCode: string }) => api<LocationState>('/v1/statutory/pt-states', { body }),
    onSuccess: (s) => {
      setNote(`Recorded: ${s.locationCode} is in ${s.stateCode} from ${formatDate(s.effectiveFrom)}.`);
      setLocationCode('');
      setEffectiveFrom('');
      setStateCode('');
      void qc.invalidateQueries({ queryKey: ['statutory-settings', 'location-states'] });
    },
  });
  return (
    <Section title="Work location states">
      <p className="hint">
        The state of each work location from a date. An employee’s professional tax and labour welfare fund packs are those of the state of their work location on the day valued; a location
        without a state blocks those heads.
      </p>
      <ErrorNote error={states.error} />
      {states.data && states.data.items.length === 0 && <Empty>No work location has a state recorded.</Empty>}
      {states.data && states.data.items.length > 0 && (
        <table aria-label="Work location states">
          <thead>
            <tr>
              <th>Location</th>
              <th>From</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {states.data.items.map((s) => (
              <tr key={s.id}>
                <td>{s.locationCode}</td>
                <td>{formatDate(s.effectiveFrom)}</td>
                <td>{s.stateCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {can(CONFIG_MANAGE) && (
        <form
          className="row"
          aria-label="Record a work location state"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setNote(null);
            record.mutate({ locationCode: locationCode.trim(), effectiveFrom, stateCode: stateCode.trim().toUpperCase() });
          }}
        >
          <label>
            Location code
            <input value={locationCode} onChange={(e) => setLocationCode(e.target.value)} required />
          </label>
          <label>
            From
            <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
          </label>
          <label>
            State (two letters)
            <input value={stateCode} onChange={(e) => setStateCode(e.target.value)} maxLength={2} required />
          </label>
          <button type="submit" disabled={record.isPending}>
            {record.isPending ? 'Recording…' : 'Record the state'}
          </button>
        </form>
      )}
      <ErrorNote error={record.error} />
      {note && <p role="status">{note}</p>}
    </Section>
  );
}

function PfOptions() {
  const qc = useQueryClient();
  const [term, setTerm] = useState('');
  const [asked, setAsked] = useState('');
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [basis, setBasis] = useState<'STATUTORY_CEILING' | 'HIGHER_WAGES'>('HIGHER_WAGES');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const hits = useQuery({
    queryKey: ['statutory-settings', 'employee-search', asked],
    enabled: asked.length > 0,
    queryFn: () => api<{ items: EmployeeHit[] }>(`/v1/employees?${new URLSearchParams({ search: asked, page: '1', pageSize: '10' }).toString()}`),
  });
  const options = useQuery({
    queryKey: ['statutory-settings', 'pf-options', employee?.id],
    enabled: employee !== null,
    queryFn: () => api<{ items: PfOption[] }>(`/v1/statutory/pf-options?employeeId=${encodeURIComponent(employee!.id)}`),
  });
  const record = useMutation({
    mutationFn: (body: { employeeId: string; effectiveFrom: string; contributionBasis: string; reference: string }) => api<PfOption>('/v1/statutory/pf-options', { body }),
    onSuccess: (o) => {
      setNote(`Recorded: ${BASIS[o.contributionBasis] ?? o.contributionBasis} from ${formatDate(o.effectiveFrom)}.`);
      setEffectiveFrom('');
      setReference('');
      void qc.invalidateQueries({ queryKey: ['statutory-settings', 'pf-options', employee?.id] });
    },
  });
  return (
    <Section title="PF contribution basis">
      <p className="hint">An employee contributes on wages up to the PF pack’s ceiling unless a joint option to contribute on higher wages is recorded, from its date.</p>
      <form
        className="row"
        aria-label="Find an employee"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setAsked(term.trim());
        }}
      >
        <label>
          Employee code or name
          <input value={term} onChange={(e) => setTerm(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Find
        </button>
      </form>
      <ErrorNote error={hits.error} />
      {hits.data && hits.data.items.length === 0 && <Empty>No employee matches.</Empty>}
      {hits.data && hits.data.items.length > 0 && (
        <ul aria-label="Matching employees">
          {hits.data.items.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="link"
                onClick={() => {
                  setEmployee(h);
                  setNote(null);
                }}
              >{`${h.employeeCode} ${h.displayName}`}</button>
            </li>
          ))}
        </ul>
      )}
      {employee && (
        <>
          <h3>{`${employee.employeeCode} ${employee.displayName}`}</h3>
          <ErrorNote error={options.error} />
          {options.data && options.data.items.length === 0 && <Empty>No option recorded: contributions are on wages up to the ceiling.</Empty>}
          {options.data && options.data.items.length > 0 && (
            <table aria-label="PF options">
              <thead>
                <tr>
                  <th>From</th>
                  <th>Basis</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {options.data.items.map((o) => (
                  <tr key={o.id}>
                    <td>{formatDate(o.effectiveFrom)}</td>
                    <td>{BASIS[o.contributionBasis] ?? o.contributionBasis}</td>
                    <td>{o.reference}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form
            className="row"
            aria-label="Record a PF option"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setNote(null);
              record.mutate({ employeeId: employee.id, effectiveFrom, contributionBasis: basis, reference: reference.trim() });
            }}
          >
            <label>
              From
              <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
            </label>
            <label>
              Basis
              <select value={basis} onChange={(e) => setBasis(e.target.value as 'STATUTORY_CEILING' | 'HIGHER_WAGES')}>
                <option value="HIGHER_WAGES">{BASIS.HIGHER_WAGES}</option>
                <option value="STATUTORY_CEILING">{BASIS.STATUTORY_CEILING}</option>
              </select>
            </label>
            <label>
              Reference (the option form)
              <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} required />
            </label>
            <button type="submit" disabled={record.isPending}>
              {record.isPending ? 'Recording…' : 'Record the option'}
            </button>
          </form>
          <ErrorNote error={record.error} />
          {note && <p role="status">{note}</p>}
        </>
      )}
    </Section>
  );
}

function StatutorySettingsScreen() {
  const { can } = useSession();
  if (!can(CONFIG_READ) && !can(CONFIG_MANAGE)) {
    return (
      <Section title="Statutory settings">
        <Empty>The selected role cannot see the statutory settings.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      {can(CONFIG_READ) && <LocationStates />}
      {/* An employee's PF option says their wages are above the ceiling: read and recorded under the manage duty only (I-85). */}
      {can(CONFIG_MANAGE) && <PfOptions />}
    </div>
  );
}

export const STATUTORY_SETTINGS_SCREENS: ScreenRoute[] = [{ path: PATH, title: 'Statutory settings', permission: CONFIG_READ, nav: true, component: StatutorySettingsScreen }];
