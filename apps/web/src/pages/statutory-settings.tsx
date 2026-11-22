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
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Notice, Section } from '../ui';

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

// The screen's own layout pieces, as utility classes (shadcn/ui move, 20 Nov 2026).
/** The employees a search found, one under another. */
const MATCH_LIST = 'my-3 flex flex-col gap-1 pl-5';
/** A found employee: a link-styled button without a button's height and padding, so it reads as the list item's text. */
const MATCH_BUTTON = 'h-auto p-0';
/** A date of a table: it stays on one line. */
const DATE_CELL = 'whitespace-nowrap';

/** The outcome of recording a setting, as a status (nothing while there is none). */
const recorded = (note: string | null) => (note ? { text: note, ok: true } : null);

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
      <Hint>
        The state of each work location from a date. An employee’s professional tax and labour welfare fund packs are those of the state of their work location on the day valued; a location
        without a state blocks those heads.
      </Hint>
      <ErrorNote error={states.error} />
      {states.data && states.data.items.length === 0 && <Empty>No work location has a state recorded.</Empty>}
      {states.data && states.data.items.length > 0 && (
        <Table aria-label="Work location states">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Location</TableHead>
              <TableHead scope="col">From</TableHead>
              <TableHead scope="col">State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {states.data.items.map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.locationCode}</TableCell>
                <TableCell className={DATE_CELL}>{formatDate(s.effectiveFrom)}</TableCell>
                <TableCell>{s.stateCode}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {can(CONFIG_MANAGE) && (
        <FormGrid
          aria-label="Record a work location state"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setNote(null);
            record.mutate({ locationCode: locationCode.trim(), effectiveFrom, stateCode: stateCode.trim().toUpperCase() });
          }}
        >
          <FormField>
            Location code
            <Input value={locationCode} onChange={(e) => setLocationCode(e.target.value)} required />
          </FormField>
          <FormField>
            From
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
          </FormField>
          <FormField>
            State (two letters)
            <Input value={stateCode} onChange={(e) => setStateCode(e.target.value)} maxLength={2} required />
          </FormField>
          <Button type="submit" disabled={record.isPending}>
            {record.isPending ? 'Recording…' : 'Record the state'}
          </Button>
        </FormGrid>
      )}
      <ErrorNote error={record.error} />
      <Notice notice={recorded(note)} />
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
      <Hint>An employee contributes on wages up to the PF pack’s ceiling unless a joint option to contribute on higher wages is recorded, from its date.</Hint>
      <FormGrid
        aria-label="Find an employee"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setAsked(term.trim());
        }}
      >
        <FormField>
          Employee code or name
          <Input value={term} onChange={(e) => setTerm(e.target.value)} />
        </FormField>
        <Button type="submit" variant="outline">
          Find
        </Button>
      </FormGrid>
      <ErrorNote error={hits.error} />
      {hits.data && hits.data.items.length === 0 && <Empty>No employee matches.</Empty>}
      {hits.data && hits.data.items.length > 0 && (
        <ul aria-label="Matching employees" className={MATCH_LIST}>
          {hits.data.items.map((h) => (
            <li key={h.id}>
              <Button
                type="button"
                variant="link"
                className={MATCH_BUTTON}
                onClick={() => {
                  setEmployee(h);
                  setNote(null);
                }}
              >{`${h.employeeCode} ${h.displayName}`}</Button>
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
            <Table aria-label="PF options">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">From</TableHead>
                  <TableHead scope="col">Basis</TableHead>
                  <TableHead scope="col">Reference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {options.data.items.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className={DATE_CELL}>{formatDate(o.effectiveFrom)}</TableCell>
                    <TableCell>{BASIS[o.contributionBasis] ?? o.contributionBasis}</TableCell>
                    <TableCell>{o.reference}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <FormGrid
            aria-label="Record a PF option"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setNote(null);
              record.mutate({ employeeId: employee.id, effectiveFrom, contributionBasis: basis, reference: reference.trim() });
            }}
          >
            <FormField>
              From
              <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
            </FormField>
            <FormField>
              Basis
              <NativeSelect value={basis} onChange={(e) => setBasis(e.target.value as 'STATUTORY_CEILING' | 'HIGHER_WAGES')}>
                <option value="HIGHER_WAGES">{BASIS.HIGHER_WAGES}</option>
                <option value="STATUTORY_CEILING">{BASIS.STATUTORY_CEILING}</option>
              </NativeSelect>
            </FormField>
            <FormField>
              Reference (the option form)
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} required />
            </FormField>
            <Button type="submit" disabled={record.isPending}>
              {record.isPending ? 'Recording…' : 'Record the option'}
            </Button>
          </FormGrid>
          <ErrorNote error={record.error} />
          <Notice notice={recorded(note)} />
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
        <Empty refusal>The selected role cannot see the statutory settings.</Empty>
      </Section>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {can(CONFIG_READ) && <LocationStates />}
      {/* An employee's PF option says their wages are above the ceiling: read and recorded under the manage duty only (I-85). */}
      {can(CONFIG_MANAGE) && <PfOptions />}
    </div>
  );
}

export const STATUTORY_SETTINGS_SCREENS: ScreenRoute[] = [{ path: PATH, title: 'Statutory settings', permission: CONFIG_READ, nav: true, component: StatutorySettingsScreen }];
