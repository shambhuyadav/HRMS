// Cities (CL-006; 0280): GET, POST and PATCH /v1/org/cities. Each city belongs to a state of the state master and is kept like the
// masters, one at a time here or from a CSV file (city-upload.tsx).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckField, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell, RowPanel } from '@/components/row-actions';
import { NothingChanged } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Notice, Section } from '../../ui';
import { CityUpload } from './city-upload';
import { ActiveBadge, MASTER_CREATE, MASTER_UPDATE, ONE_LINE, REFERENCE_READ, Refusal } from './shared';

const CITIES_KEY = ['org-cities'];

/** GET /v1/org/cities. */
export interface City {
  id: string;
  country: string;
  stateCode: string;
  stateName: string;
  stateActive: boolean;
  code: string;
  name: string;
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  version: number;
}

/** A city's own refusals in plain words; the rest read as a master's do. */
const CITY_REFUSALS: Readonly<Record<string, string>> = {
  UNKNOWN_STATE: 'There is no such state in the state master.',
  STATE_NOT_IN_FORCE: 'This state is inactive or outside its period, so no city can be added under it. It is changed on the Reference values screen.',
  INVALID_CITY_CODE: 'A city code starts with a letter or digit and uses only letters, digits, hyphens and underscores, up to 40 characters.',
  INVALID_CITY_NAME: 'A city needs a name of up to 200 characters.',
  DUPLICATE: 'Another city of this state, active or inactive, already has this code.',
};

function CityRefusal({ error }: { error: unknown }) {
  const words = error instanceof ApiError ? CITY_REFUSALS[error.code] : undefined;
  if (!words) return <Refusal error={error} noun="city" />;
  return <Notice notice={{ text: words, ok: false }} />;
}

function NewCity({ states, onCreated }: { states: { code: string; label: string }[]; onCreated: (text: string) => void }) {
  const blank = { stateCode: '', code: '', name: '', validFrom: '', validTo: '' };
  const [form, setForm] = useState(blank);
  const create = useMutation({
    mutationFn: () =>
      api<City>('/v1/org/cities', {
        body: {
          stateCode: form.stateCode,
          code: form.code.trim(),
          name: form.name.trim(),
          ...(form.validFrom ? { validFrom: form.validFrom } : {}),
          ...(form.validTo ? { validTo: form.validTo } : {}),
        },
      }),
    onSuccess: (created) => {
      setForm(blank);
      onCreated(`${created.name} (${created.stateName}) created.`);
    },
  });
  return (
    <Section title="New city">
      <FormGrid
        aria-label="New city"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormField>
          State
          <NativeSelect required value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })}>
            <option value="">Choose a state</option>
            {states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField>
          Code
          <Input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </FormField>
        <FormField>
          Name
          <Input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </FormField>
        <FormField>
          From
          <Input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
        </FormField>
        <FormField>
          Until (not included)
          <Input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
        </FormField>
        <Button type="submit" disabled={create.isPending}>
          Create city
        </Button>
        <div className="col-span-full">
          <CityRefusal error={create.error} />
        </div>
      </FormGrid>
    </Section>
  );
}

function EditCity({ city, onSaved, onConflict }: { city: City; onSaved: () => void; onConflict: () => void }) {
  const [form, setForm] = useState({ name: city.name, validFrom: city.validFrom ?? '', validTo: city.validTo ?? '' });
  const [unchanged, setUnchanged] = useState(false);
  const save = useMutation({
    mutationFn: (changes: Record<string, string | null>) => api<City>(`/v1/org/cities/${city.id}`, { method: 'PATCH', body: { expectedVersion: city.version, ...changes } }),
    onSuccess: onSaved,
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onConflict();
    },
  });
  const changes = (): Record<string, string | null> => ({
    ...(form.name.trim() !== city.name ? { name: form.name.trim() } : {}),
    ...(form.validFrom !== (city.validFrom ?? '') ? { validFrom: form.validFrom || null } : {}),
    ...(form.validTo !== (city.validTo ?? '') ? { validTo: form.validTo || null } : {}),
  });
  return (
    <RowPanel asChild>
      <FormGrid
        aria-label={`Edit ${city.code}`}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          const changed = changes();
          const nothing = Object.keys(changed).length === 0;
          setUnchanged(nothing);
          if (nothing) save.reset();
          else save.mutate(changed);
        }}
      >
        <FormField>
          Name
          <Input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </FormField>
        <FormField>
          From
          <Input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
        </FormField>
        <FormField>
          Until (not included)
          <Input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
        </FormField>
        <Button type="submit" aria-label={`Save ${city.code}`} disabled={save.isPending}>
          Save
        </Button>
        <div className="col-span-full">
          {unchanged && <NothingChanged />}
          <CityRefusal error={save.error} />
        </div>
      </FormGrid>
    </RowPanel>
  );
}

function CityRow({ city, canUpdate, onChanged, onSaved }: { city: City; canUpdate: boolean; onChanged: () => void; onSaved: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const setActive = useMutation({
    mutationFn: () => api<City>(`/v1/org/cities/${city.id}`, { method: 'PATCH', body: { expectedVersion: city.version, active: !city.active } }),
    onSuccess: (updated) => onSaved(`${updated.name} ${updated.active ? 'reactivated' : 'deactivated'}.`),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onChanged();
    },
  });
  return (
    <TableRow>
      <TableCell>
        {city.stateName}
        {!city.stateActive && ' (state inactive)'}
      </TableCell>
      <TableCell className={ONE_LINE}>{city.code}</TableCell>
      <TableCell>{city.name}</TableCell>
      <TableCell className={ONE_LINE}>{formatDate(city.validFrom)}</TableCell>
      <TableCell className={ONE_LINE}>{formatDate(city.validTo)}</TableCell>
      <TableCell>
        <ActiveBadge active={city.active} />
      </TableCell>
      <RowActionsCell>
        {canUpdate && (
          <>
            <RowActions>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Edit ${city.code}`}
                aria-expanded={editing}
                onClick={() => {
                  setActive.reset();
                  setEditing(!editing);
                }}
              >
                Edit
              </Button>{' '}
              <Button
                type="button"
                variant={city.active ? 'danger' : 'outline'}
                size="sm"
                aria-label={`${city.active ? 'Deactivate' : 'Reactivate'} ${city.code}`}
                disabled={setActive.isPending}
                onClick={() => setActive.mutate()}
              >
                {city.active ? 'Deactivate' : 'Reactivate'}
              </Button>
            </RowActions>
            {setActive.error && (
              <RowPanel>
                <CityRefusal error={setActive.error} />
              </RowPanel>
            )}
            {editing && (
              <EditCity
                city={city}
                onConflict={onChanged}
                onSaved={() => {
                  setEditing(false);
                  onSaved(`${city.code} saved.`);
                }}
              />
            )}
          </>
        )}
      </RowActionsCell>
    </TableRow>
  );
}

export function CitiesPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [state, setState] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The states a city can be added under: India's list, in force today (GET /v1/reference-values, under the master read duty).
  const states = useQuery({ queryKey: ['org-states', 'IN'], queryFn: () => api<{ items: { code: string; label: string }[] }>('/v1/reference-values?category=STATE_IN') });
  const query = new URLSearchParams({ country: 'IN', ...(state ? { state } : {}), ...(includeInactive ? { includeInactive: 'true' } : {}) });
  const list = useQuery({ queryKey: [...CITIES_KEY, state, includeInactive], queryFn: () => api<{ items: City[] }>(`/v1/org/cities?${query.toString()}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: CITIES_KEY });
  const saved = (message: string) => {
    setNotice(message);
    refresh();
  };
  const items = list.data?.items ?? [];
  const stateOptions = states.data?.items ?? [];
  return (
    <>
      <Section title="Cities">
        <FilterBar>
          <FormField>
            State
            <NativeSelect value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">All states</option>
              {stateOptions.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <CheckField>
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
          </CheckField>
        </FilterBar>
        {notice && <Notice notice={{ text: notice, ok: true }} />}
        <ErrorNote error={list.error ?? states.error} />
        {list.isSuccess && items.length === 0 && <Empty>No city to show.</Empty>}
        {items.length > 0 && (
          <Table aria-label="Cities">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">From</TableHead>
                <TableHead scope="col">Until</TableHead>
                <TableHead scope="col">State of record</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <CityRow key={c.id} city={c} canUpdate={can(MASTER_UPDATE)} onChanged={refresh} onSaved={saved} />
              ))}
            </TableBody>
          </Table>
        )}
        <Hint>
          A city is never deleted: deactivating it or closing its period stops new use and history keeps it. Its state and code never change. The states and union territories of India, the banks
          and the qualifications are company lists of their own (STATE_IN, BANK and QUALIFICATION), kept on the Reference values screen.
          {can(REFERENCE_READ) && (
            <>
              {' '}
              <Link to="/admin/reference-values">Open Reference values</Link>
            </>
          )}
        </Hint>
      </Section>
      {can(MASTER_CREATE) && <NewCity states={stateOptions} onCreated={saved} />}
      {can(MASTER_CREATE) && <CityUpload onCommitted={refresh} />}
    </>
  );
}
