// Organisation masters (FR-004; BR-004; DF04; I-55; 0102): departments, locations, designations and grades, each with a code, a
// name, an active state and a validity period [from, until). A master is never deleted: it is deactivated or its period is
// closed, and history keeps it. The page holds no rule of its own: the server checks the period, the code and whether a live
// assignment would be stranded (MASTER_IN_USE), and this page says what it answered. A refusal keeps what was typed.
// The company itself (FR-004; DB001; DF05) has its own screen: GET and PATCH /v1/org/company keep a fixed code, a name, the
// business timezone and a controlled deactivation.
// Cities (CL-006; 0280) have their own screen: each belongs to a state of the state master and is kept like the masters above, one at a
// time or from a CSV file (CITY_MASTER_V1) through the shared import steps. The state, bank and qualification masters (CL-005, CL-010,
// CL-007) are company lists kept on the Reference values screen (STATE_IN, BANK, QUALIFICATION); the cities screen says so.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, fileToBase64, formatDate, idempotencyKey } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section } from '../ui';
import { ORG_CHART_PERMISSION, OrgChartPage } from './org-chart';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from './records';

const MASTER_READ = 'org_master.read.operational';
const MASTER_CREATE = 'org_master.create.operational';
const MASTER_UPDATE = 'org_master.update.operational';

export type MasterKind = 'departments' | 'locations' | 'designations' | 'grades';

const KINDS: Readonly<Record<MasterKind, { title: string; noun: string }>> = {
  departments: { title: 'Departments', noun: 'department' },
  locations: { title: 'Locations', noun: 'location' },
  designations: { title: 'Designations', noun: 'designation' },
  grades: { title: 'Grades', noun: 'grade' },
};

/** GET /v1/org/:kind. */
export interface Master {
  id: string;
  code: string;
  name: string;
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  version: number;
}

/** Refusals in plain words, by code; any other is shown as the server sent it. */
function refusalText(error: unknown, noun: string): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'MASTER_IN_USE': {
      const assignments = (error.details as { assignments?: unknown } | undefined)?.assignments;
      const who = typeof assignments === 'number' ? `${assignments} employee ${assignments === 1 ? 'assignment' : 'assignments'}` : 'Employee assignments';
      return `This ${noun} is still in use: ${who} would fall outside it. Move them to another ${noun} first. Nothing was changed.`;
    }
    case 'STALE_VERSION':
      return `This ${noun} changed since you opened it. It has been reloaded; check the values shown and save again.`;
    case 'DUPLICATE':
      return `Another ${noun}, active or inactive, already has this code.`;
    case 'INVALID_PERIOD':
      return 'The end of the period must be after its start.';
    case 'INVALID_REQUEST':
      return 'Check the values. A code starts with a letter or digit and uses only letters, digits, hyphens and underscores, up to 40 characters; a name cannot be blank.';
    case 'FORBIDDEN':
      return 'Your role cannot change this. Masters are changed under this duty with company-wide scope and no department, location or employee filter.';
    default:
      return null;
  }
}

function Refusal({ error, noun }: { error: unknown; noun: string }) {
  const words = refusalText(error, noun);
  if (!words) return <ErrorNote error={error} />;
  return (
    <p role="alert" className="error">
      {words}
    </p>
  );
}

function NewMaster({ kind, onCreated }: { kind: MasterKind; onCreated: (code: string) => void }) {
  const { noun } = KINDS[kind];
  const blank = { code: '', name: '', validFrom: '', validTo: '' };
  const [form, setForm] = useState(blank);
  const create = useMutation({
    mutationFn: () =>
      api<Master>(`/v1/org/${kind}`, {
        body: { code: form.code.trim(), name: form.name.trim(), ...(form.validFrom ? { validFrom: form.validFrom } : {}), ...(form.validTo ? { validTo: form.validTo } : {}) },
      }),
    onSuccess: (created) => {
      setForm(blank);
      onCreated(created.code);
    },
  });
  return (
    <Section title={`New ${noun}`}>
      <form
        className="grid-form"
        aria-label={`New ${noun}`}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Code
          <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </label>
        <label>
          Name
          <input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          From
          <input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
        </label>
        <label>
          Until (not included)
          <input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
        </label>
        <button type="submit" disabled={create.isPending}>
          Create {noun}
        </button>
        <div className="wide">
          <Refusal error={create.error} noun={noun} />
        </div>
      </form>
    </Section>
  );
}

function EditMaster({ kind, master, onSaved, onConflict }: { kind: MasterKind; master: Master; onSaved: () => void; onConflict: () => void }) {
  const { noun } = KINDS[kind];
  const [form, setForm] = useState({ name: master.name, validFrom: master.validFrom ?? '', validTo: master.validTo ?? '' });
  const [unchanged, setUnchanged] = useState(false);
  const save = useMutation({
    mutationFn: (changes: Record<string, string | null>) => api<Master>(`/v1/org/${kind}/${master.id}`, { method: 'PATCH', body: { expectedVersion: master.version, ...changes } }),
    onSuccess: onSaved,
    // A stale version reloads the list; what was typed stays, and the next save goes against the version now shown.
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onConflict();
    },
  });
  // Only what differs from the record as it now stands is sent; an emptied date clears it.
  const changes = (): Record<string, string | null> => ({
    ...(form.name.trim() !== master.name ? { name: form.name.trim() } : {}),
    ...(form.validFrom !== (master.validFrom ?? '') ? { validFrom: form.validFrom || null } : {}),
    ...(form.validTo !== (master.validTo ?? '') ? { validTo: form.validTo || null } : {}),
  });
  return (
    <form
      className="grid-form"
      aria-label={`Edit ${master.code}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const changed = changes();
        const nothing = Object.keys(changed).length === 0;
        setUnchanged(nothing);
        if (nothing) save.reset();
        else save.mutate(changed);
      }}
    >
      <label>
        Name
        <input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label>
        From
        <input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
      </label>
      <label>
        Until (not included)
        <input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
      </label>
      <button type="submit" disabled={save.isPending}>
        Save {master.code}
      </button>
      <div className="wide">
        {unchanged && <p role="status">Nothing changed.</p>}
        <Refusal error={save.error} noun={noun} />
      </div>
    </form>
  );
}

function MasterRow({ kind, master, canUpdate, onChanged, onSaved }: { kind: MasterKind; master: Master; canUpdate: boolean; onChanged: () => void; onSaved: (message: string) => void }) {
  const { noun } = KINDS[kind];
  const [editing, setEditing] = useState(false);
  const setActive = useMutation({
    mutationFn: () => api<Master>(`/v1/org/${kind}/${master.id}`, { method: 'PATCH', body: { expectedVersion: master.version, active: !master.active } }),
    onSuccess: (updated) => onSaved(`${updated.code} ${updated.active ? 'reactivated' : 'deactivated'}.`),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onChanged();
    },
  });
  return (
    <tr>
      <td>{master.code}</td>
      <td>{master.name}</td>
      <td>{formatDate(master.validFrom)}</td>
      <td>{formatDate(master.validTo)}</td>
      <td>{master.active ? <Badge tone="good">active</Badge> : <Badge>inactive</Badge>}</td>
      <td>
        {canUpdate && (
          <>
            <button
              type="button"
              className="link"
              aria-expanded={editing}
              onClick={() => {
                setActive.reset();
                setEditing(!editing);
              }}
            >
              Edit {master.code}
            </button>{' '}
            <button type="button" className="link" disabled={setActive.isPending} onClick={() => setActive.mutate()}>
              {master.active ? 'Deactivate' : 'Reactivate'} {master.code}
            </button>
            <Refusal error={setActive.error} noun={noun} />
            {editing && (
              <EditMaster
                kind={kind}
                master={master}
                onConflict={onChanged}
                onSaved={() => {
                  setEditing(false);
                  onSaved(`${master.code} saved.`);
                }}
              />
            )}
          </>
        )}
      </td>
    </tr>
  );
}

function MasterPage({ kind }: { kind: MasterKind }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const { title, noun } = KINDS[kind];
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['org-master', kind, includeInactive],
    queryFn: () => api<{ items: Master[] }>(`/v1/org/${kind}${includeInactive ? '?includeInactive=true' : ''}`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['org-master', kind] });
  const saved = (message: string) => {
    setNotice(message);
    refresh();
  };
  const items = list.data?.items ?? [];
  return (
    <>
      <Section title={title}>
        <label className="inline">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
        </label>
        {notice && <p role="status">{notice}</p>}
        <ErrorNote error={list.error} />
        {list.isSuccess && items.length === 0 && <Empty>No {noun} to show.</Empty>}
        {items.length > 0 && (
          <table aria-label={title}>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">From</th>
                <th scope="col">Until</th>
                <th scope="col">State</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <MasterRow key={m.id} kind={kind} master={m} canUpdate={can(MASTER_UPDATE)} onChanged={refresh} onSaved={saved} />
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          A {noun} is never deleted. Deactivating it or closing its period stops new use and history keeps it; neither is allowed while a live assignment would be left outside it. Until is the first day it no longer applies; a blank date leaves that side open.
        </p>
      </Section>
      {can(MASTER_CREATE) && <NewMaster kind={kind} onCreated={(code) => saved(`${code} created.`)} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------------------------------------

/** GET /v1/org/company. */
export interface Company {
  id: string;
  code: string;
  name: string;
  businessTimezone: string;
  active: boolean;
  version: number;
}

const COMPANY_KEY = ['org-company'];

/** The company's own refusals in plain words; the rest read as a master's do. */
function CompanyRefusal({ error }: { error: unknown }) {
  if (error instanceof ApiError) {
    const details = (error.details ?? {}) as { employees?: number; roleAssignments?: number };
    const own: string | null =
      error.code === 'INVALID_TIMEZONE'
        ? 'That is not a timezone the server knows. Use a name such as Asia/Kolkata.'
        : error.code === 'INVALID_NAME' || error.code === 'INVALID_REQUEST'
          ? 'Check the values. A company needs a name, up to 200 characters, and a timezone.'
          : error.code === 'COMPANY_IN_USE'
            ? `This company is still in use: ${details.employees ?? 0} employed and ${details.roleAssignments ?? 0} other role assignments. End them first. Nothing was changed.`
            : null;
    if (own) {
      return (
        <p role="alert" className="error">
          {own}
        </p>
      );
    }
  }
  return <Refusal error={error} noun="company" />;
}

function CompanyForm({ company, onSaved, onConflict }: { company: Company; onSaved: (message: string) => void; onConflict: () => void }) {
  const [form, setForm] = useState({ name: company.name, businessTimezone: company.businessTimezone });
  const [unchanged, setUnchanged] = useState(false);
  const save = useMutation({
    mutationFn: (changes: Record<string, string>) => api<Company>('/v1/org/company', { method: 'PATCH', body: { expectedVersion: company.version, ...changes } }),
    onSuccess: () => onSaved('Company saved.'),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onConflict();
    },
  });
  // Only what differs from the company as it now stands is sent.
  const changes = (): Record<string, string> => ({
    ...(form.name.trim() !== company.name ? { name: form.name.trim() } : {}),
    ...(form.businessTimezone.trim() !== company.businessTimezone ? { businessTimezone: form.businessTimezone.trim() } : {}),
  });
  return (
    <form
      className="grid-form"
      aria-label="Edit company"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const changed = changes();
        const nothing = Object.keys(changed).length === 0;
        setUnchanged(nothing);
        if (nothing) save.reset();
        else save.mutate(changed);
      }}
    >
      <label>
        Name
        <input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label>
        Business timezone
        <input required maxLength={100} value={form.businessTimezone} onChange={(e) => setForm({ ...form, businessTimezone: e.target.value })} />
      </label>
      <button type="submit" disabled={save.isPending}>
        Save company
      </button>
      <p className="hint wide">The business date follows the timezone from the moment it is saved.</p>
      <div className="wide">
        {unchanged && <p role="status">Nothing changed.</p>}
        <CompanyRefusal error={save.error} />
      </div>
    </form>
  );
}

/** FR-004 "allow controlled deactivation": asked twice, because nobody can act in the company afterwards, this person included. */
function CompanyDeactivation({ company, onDeactivated, onConflict }: { company: Company; onDeactivated: () => void; onConflict: () => void }) {
  const [asked, setAsked] = useState(false);
  const deactivate = useMutation({
    mutationFn: () => api<Company>('/v1/org/company', { method: 'PATCH', body: { expectedVersion: company.version, active: false } }),
    onSuccess: onDeactivated,
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onConflict();
    },
  });
  return (
    <Section title="Deactivate this company">
      <p className="hint">Refused while anyone is still employed or anyone else holds a role in it. Once deactivated, nobody can act in the company, you included, and nothing on these screens can bring it back.</p>
      {asked ? (
        <p>
          <button type="button" disabled={deactivate.isPending} onClick={() => deactivate.mutate()}>
            Confirm deactivating {company.code}
          </button>{' '}
          <button type="button" className="secondary" onClick={() => setAsked(false)}>
            Keep it active
          </button>
        </p>
      ) : (
        <p>
          <button type="button" className="secondary" onClick={() => setAsked(true)}>
            Deactivate {company.code}
          </button>
        </p>
      )}
      <CompanyRefusal error={deactivate.error} />
    </Section>
  );
}

export function CompanyPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [deactivated, setDeactivated] = useState(false);
  // Nothing can be read once it is deactivated, so the page stops asking and says so.
  const company = useQuery({ queryKey: COMPANY_KEY, enabled: !deactivated, queryFn: () => api<Company>('/v1/org/company') });
  const refresh = () => void qc.invalidateQueries({ queryKey: COMPANY_KEY });
  if (deactivated) {
    return (
      <Section title="Company">
        <p role="status">The company has been deactivated. Nobody can act in it now, you included.</p>
      </Section>
    );
  }
  const c = company.data;
  return (
    <>
      <Section title="Company">
        {notice && <p role="status">{notice}</p>}
        <ErrorNote error={company.error} />
        {c && (
          <dl className="kv">
            <div>
              <dt>Code</dt>
              <dd>{c.code}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd>{c.name}</dd>
            </div>
            <div>
              <dt>Business timezone</dt>
              <dd>{c.businessTimezone}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{c.active ? <Badge tone="good">active</Badge> : <Badge>inactive</Badge>}</dd>
            </div>
          </dl>
        )}
        <p className="hint">The code never changes: a new code is a new company.</p>
        {c && can(MASTER_UPDATE) && (
          <CompanyForm
            company={c}
            onConflict={refresh}
            onSaved={(message) => {
              setNotice(message);
              refresh();
            }}
          />
        )}
      </Section>
      {c?.active && can(MASTER_UPDATE) && <CompanyDeactivation company={c} onConflict={refresh} onDeactivated={() => setDeactivated(true)} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Cities (CL-006; 0280): GET, POST and PATCH /v1/org/cities, and the CITY_MASTER_V1 upload at /v1/org/city-imports.
// ---------------------------------------------------------------------------------------------------------

const REFERENCE_READ = 'reference_value.read.operational';
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
function CityRefusal({ error }: { error: unknown }) {
  const own: Record<string, string> = {
    UNKNOWN_STATE: 'There is no such state in the state master.',
    STATE_NOT_IN_FORCE: 'This state is inactive or outside its period, so no city can be added under it. It is changed on the Reference values screen.',
    INVALID_CITY_CODE: 'A city code starts with a letter or digit and uses only letters, digits, hyphens and underscores, up to 40 characters.',
    INVALID_CITY_NAME: 'A city needs a name of up to 200 characters.',
    DUPLICATE: 'Another city of this state, active or inactive, already has this code.',
  };
  const words = error instanceof ApiError ? own[error.code] : undefined;
  if (!words) return <Refusal error={error} noun="city" />;
  return (
    <p role="alert" className="error">
      {words}
    </p>
  );
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
      <form
        className="grid-form"
        aria-label="New city"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          State
          <select required value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })}>
            <option value="">Choose a state</option>
            {states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Code
          <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </label>
        <label>
          Name
          <input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          From
          <input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
        </label>
        <label>
          Until (not included)
          <input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
        </label>
        <button type="submit" disabled={create.isPending}>
          Create city
        </button>
        <div className="wide">
          <CityRefusal error={create.error} />
        </div>
      </form>
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
    <form
      className="grid-form"
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
      <label>
        Name
        <input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label>
        From
        <input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
      </label>
      <label>
        Until (not included)
        <input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
      </label>
      <button type="submit" disabled={save.isPending}>
        Save {city.code}
      </button>
      <div className="wide">
        {unchanged && <p role="status">Nothing changed.</p>}
        <CityRefusal error={save.error} />
      </div>
    </form>
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
    <tr>
      <td>
        {city.stateName}
        {!city.stateActive && ' (state inactive)'}
      </td>
      <td>{city.code}</td>
      <td>{city.name}</td>
      <td>{formatDate(city.validFrom)}</td>
      <td>{formatDate(city.validTo)}</td>
      <td>{city.active ? <Badge tone="good">active</Badge> : <Badge>inactive</Badge>}</td>
      <td>
        {canUpdate && (
          <>
            <button
              type="button"
              className="link"
              aria-expanded={editing}
              onClick={() => {
                setActive.reset();
                setEditing(!editing);
              }}
            >
              Edit {city.code}
            </button>{' '}
            <button type="button" className="link" disabled={setActive.isPending} onClick={() => setActive.mutate()}>
              {city.active ? 'Deactivate' : 'Reactivate'} {city.code}
            </button>
            <CityRefusal error={setActive.error} />
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
      </td>
    </tr>
  );
}

const CITY_TEMPLATE: ImportTemplate = {
  code: 'CITY_MASTER_V1',
  label: 'Cities',
  permissions: [MASTER_CREATE],
  base: '/v1/org/city-imports',
  columns: 'stateCode,cityCode,cityName',
  keyLabel: 'State / city code',
  noun: ['city', 'cities'],
  verb: 'Add',
  note: 'One new city per row: the two-letter code of an Indian state or union territory (for example MH), a city code unique within that state, and the city’s name.',
  problems: {
    UNKNOWN_STATE: 'There is no such state in the state master.',
    STATE_NOT_IN_FORCE: 'The state is inactive or outside its period.',
    INVALID_CITY_CODE: 'The city code is not valid: letters, digits, hyphens and underscores, up to 40.',
    INVALID_CITY_NAME: 'The city name is empty or longer than 200 characters.',
    DUPLICATE_CITY: 'This state already has a city with this code.',
    DUPLICATE_IN_BATCH: 'An earlier row of the file has the same state and city code.',
    COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
  },
};

/** The CITY_MASTER_V1 upload: stage the file, read the preview, add the cities or cancel; all rows or none. */
function CityUpload({ onCommitted }: { onCommitted: () => void }) {
  const t = CITY_TEMPLATE;
  const [file, setFile] = useState<File | null>(null);
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file: uploading the same file again returns the same batch.
  const uploadKey = useRef<string | null>(null);
  const { resume, open, refresh, watch } = useBatchFollowUp(
    t.base,
    {
      show: setJob,
      closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)),
      onStart: () => {
        upload.reset();
        act.reset();
      },
    },
    job,
  );
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => api<ImportJob>(`${t.base}/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      if (view.state === 'COMMITTED') onCommitted();
    },
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey('cities'));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      act.reset();
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
    onSettled: refresh,
  });
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  return (
    <>
      <Section title="Upload cities">
        <form
          className="stack"
          aria-label="Upload cities"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (file && !busy) upload.mutate(file);
          }}
        >
          <p className="hint">
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}). {t.note} Nothing is added until you add the previewed rows, and a file is applied all or nothing: one row
            with a problem rejects the whole file.
          </p>
          <TemplateDownload base={t.base} code={t.code} />
          <div className="inline">
            <label>
              Cities file (CSV)
              <input
                key={fileInput}
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  uploadKey.current = null;
                }}
              />
            </label>
            <button type="submit" disabled={!file || busy}>
              Upload and preview
            </button>
          </div>
        </form>
        <ErrorNote error={upload.error ?? resume.error} />
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title="Your city uploads" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
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
        <div className="filters">
          <label>
            State
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">All states</option>
              {stateOptions.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
          </label>
        </div>
        {notice && <p role="status">{notice}</p>}
        <ErrorNote error={list.error ?? states.error} />
        {list.isSuccess && items.length === 0 && <Empty>No city to show.</Empty>}
        {items.length > 0 && (
          <table aria-label="Cities">
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">From</th>
                <th scope="col">Until</th>
                <th scope="col">State of record</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <CityRow key={c.id} city={c} canUpdate={can(MASTER_UPDATE)} onChanged={refresh} onSaved={saved} />
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          A city is never deleted: deactivating it or closing its period stops new use and history keeps it. Its state and code never change. The states and union territories of India, the banks
          and the qualifications are company lists of their own (STATE_IN, BANK and QUALIFICATION), kept on the Reference values screen.
          {can(REFERENCE_READ) && (
            <>
              {' '}
              <Link to="/admin/reference-values">Open Reference values</Link>
            </>
          )}
        </p>
      </Section>
      {can(MASTER_CREATE) && <NewCity states={stateOptions} onCreated={saved} />}
      {can(MASTER_CREATE) && <CityUpload onCommitted={refresh} />}
    </>
  );
}

export const DepartmentsPage = () => <MasterPage kind="departments" />;
export const LocationsPage = () => <MasterPage kind="locations" />;
export const DesignationsPage = () => <MasterPage kind="designations" />;
export const GradesPage = () => <MasterPage kind="grades" />;

export const ORG_SCREENS: readonly ScreenRoute[] = [
  { path: '/organisation/company', title: 'Company', permission: MASTER_READ, nav: true, component: CompanyPage },
  { path: '/organisation/chart', title: 'Organisation chart', permission: ORG_CHART_PERMISSION, nav: true, component: OrgChartPage },
  { path: '/organisation/departments', title: 'Departments', permission: MASTER_READ, nav: true, component: DepartmentsPage },
  { path: '/organisation/locations', title: 'Locations', permission: MASTER_READ, nav: true, component: LocationsPage },
  { path: '/organisation/designations', title: 'Designations', permission: MASTER_READ, nav: true, component: DesignationsPage },
  { path: '/organisation/grades', title: 'Grades', permission: MASTER_READ, nav: true, component: GradesPage },
  // CL-006 (0280): cities by state, one at a time or from a file.
  { path: '/organisation/cities', title: 'Cities', permission: MASTER_READ, nav: true, component: CitiesPage },
];
