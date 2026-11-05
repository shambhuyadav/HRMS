// Biometric administration: API Profiles, Field Mapping, Employee Mapping and Sync Monitor (FR-086, FR-087, FR-088; BR-035;
// BR-036; BR-037; DF09; DF13).
//
// Profile settings are references to the private store, entered once and never shown again. A mapping revision is versioned
// and approved by someone other than its author, and a safe preview applies nothing. Employee links are ended or moved with a
// reason, never rewritten, and punches already made stay on record. The monitor shows runs and what they rejected or
// quarantined: an unknown identity is reprocessed once a link exists, and an ambiguous local time is settled by a person. A
// conflicting repeat has no action here: nothing overwrites the kept event, and a day that needs changing goes through
// attendance control. The page proposes no value. The server re-checks every duty and rule.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section, StateBadge } from '../ui';

const PROFILE_MANAGE = 'biometric.profile_manage.operational';
const MAPPING_MANAGE = 'biometric.mapping_manage.operational';
const LINK_MANAGE = 'biometric.employee_link_manage.operational';
const SYNC_RUN = 'biometric.sync_run.operational';
const REPROCESS = 'biometric.sync_exception_reprocess.operational';
const READ = 'biometric.read.operational';
const EMPLOYEE_LIST = 'employee.list.operational';

export interface Profile {
  id: string;
  code: string;
  name: string;
  providerTimezone: string;
  paginationMode: string;
  lookbackMinutes: number;
  active: boolean;
  syncedUntil: string | null;
  version: number;
}

export interface MappingField {
  sourcePath: string;
  targetField: string;
  transformCode: string;
  enumConfig: Record<string, string> | null;
  required: boolean;
  defaultCode: string | null;
}

export interface MappingRevision {
  id: string;
  revision: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  dedupeStrategy: string;
  timestampRule: string;
  approved: boolean;
  ownRevision: boolean;
  fields: MappingField[];
}

export interface EmployeeLink {
  id: string;
  externalEmployeeKey: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  current: boolean;
  version: number;
}

export interface SyncRun {
  id: string;
  profileCode: string;
  mappingRevision: number;
  state: string;
  failureCode: string | null;
  windowStart: string;
  windowEnd: string;
  startedAt: string;
  finishedAt: string | null;
  pagesCommitted: number;
  observations: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  quarantined: number;
}

export interface SyncException {
  id: string;
  runId: string;
  profileCode: string;
  outcome: string;
  failureCode: string;
  sourceEventKey: string | null;
  observedAt: string;
  eventId: string | null;
  nextStep: 'REPROCESS' | 'CORRECT_TIME' | 'RESOLVED' | 'NONE';
  evidence: { employeeKey: string; instant: string | null; localTime: string | null; direction: string; deviceId: string | null } | null;
  kept: { employeeKey: string; instant: string; direction: string } | null;
}

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

const formatInstant = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');
/** A date-and-time box reads in the browser's time zone; the server takes the instant. */
const instantOf = (local: string) => new Date(local).toISOString();

const REFUSALS: Readonly<Record<string, string>> = {
  STALE_VERSION: 'This changed since you opened it. It has been reloaded; review it and try again.',
  INVALID_STATE: 'This has already been done. The list has been reloaded.',
  MAPPING_NOT_APPROVED: 'Activation needs an approved mapping revision that is in force.',
  SELF_APPROVAL: 'Whoever wrote a mapping revision cannot approve it; someone else must.',
  OVERLAPPING_PERIOD: 'This overlaps an existing period for the same identity, employee or profile. A revision must start after the one in force; a link needs a free period.',
  INVALID_PERIOD: 'The dates do not fit: an end must be after the start, and a move must fall inside the link’s period.',
  LINK_ENDED: 'This link has already ended. Add a new link instead.',
  NO_CHANGE: 'The link already points to this employee.',
  SELF_ACTION_NOT_ALLOWED: 'You cannot do this on your own employee record; another administrator must.',
  INVALID_REFERENCE: 'That employee is not in this company.',
  DUPLICATE: 'This code is already in use.',
  RUN_IN_PROGRESS: 'A run of this profile is already in progress. Wait for it to end; one that stopped responding ends by itself after its lease.',
  PROFILE_INACTIVE: 'This profile is disabled, so it starts no new runs. Punches already made stay on record.',
  PROVIDER_NOT_CONFIGURED: 'No provider connection is set up for this profile, so nothing can run yet. It needs the device owner’s private provider contract.',
  STILL_UNMATCHED: 'No employee link covers this identity at that time. Add the link in Employee Mapping first.',
  NOT_REPROCESSABLE: 'This event can no longer be reprocessed. The list has been reloaded.',
  NOT_CORRECTABLE: 'This event can no longer be corrected. The list has been reloaded.',
  TIME_NOT_THE_SOURCE_READING: 'The time must read as the device recorded it, in the provider’s time zone. Check the UTC offset.',
  TIME_IN_FUTURE: 'A punch cannot lie in the future.',
};

const MAPPING_ERRORS: Readonly<Record<string, string>> = {
  EMPLOYEE_KEY_REQUIRED: 'the employee identity must be mapped and required',
  PUNCH_INSTANT_REQUIRED: 'the punch time must be mapped and required',
  DIRECTION_OR_APPROVED_DEFAULT_REQUIRED: 'the direction must be required or have a default',
  DIRECTION_ENUM_INVALID: 'the direction values must map to IN or OUT',
  EVENT_KEY_REQUIRED_FOR_STRATEGY: 'duplicates by provider event key need the event key mapped and required',
};

function Refusal({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return <ErrorNote error={error} />;
  if (error.code === 'MAPPING_INVALID') {
    const errors = (error.details as { errors?: string[] } | undefined)?.errors ?? [];
    const words = errors.map((code) => (code.startsWith('INVALID_PATH:') ? `the source path of ${code.slice(13)} is not a plain field path` : (MAPPING_ERRORS[code] ?? code)));
    return (
      <p role="alert" className="error">
        This mapping cannot be used: {words.join('; ')}.
      </p>
    );
  }
  const words = REFUSALS[error.code];
  if (!words) return <ErrorNote error={error} />;
  return (
    <p role="alert" className="error">
      {words}
    </p>
  );
}

const useProfiles = () => useQuery({ queryKey: ['biometric', 'profiles'], queryFn: () => api<{ items: Profile[] }>('/v1/biometric/profiles') });

function ProfilePicker({ value, onChange, anyLabel }: { value: string; onChange: (id: string) => void; anyLabel: string }) {
  const profiles = useProfiles();
  return (
    <label>
      Profile
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{anyLabel}</option>
        {profiles.data?.items.map((p) => (
          <option key={p.id} value={p.id}>
            {p.code} · {p.name}
          </option>
        ))}
      </select>
      <ErrorNote error={profiles.error} />
    </label>
  );
}

// ---------------------------------------------------------------------------------------------------------
// API Profiles
// ---------------------------------------------------------------------------------------------------------

const NEW_PROFILE = { code: '', name: '', requestConfigReference: '', authReference: '', providerTimezone: '', paginationMode: '', scheduleReference: '', lookbackMinutes: '' };

function NewProfile({ onChanged }: { onChanged: () => void }) {
  const [v, setV] = useState(NEW_PROFILE);
  const set = (key: keyof typeof NEW_PROFILE) => (e: { target: { value: string } }) => setV({ ...v, [key]: e.target.value });
  const create = useMutation({
    mutationFn: () => api('/v1/biometric/profiles', { body: { ...v, code: v.code.trim(), name: v.name.trim(), lookbackMinutes: Number(v.lookbackMinutes) } }),
    onSuccess: () => {
      setV(NEW_PROFILE);
      onChanged();
    },
  });
  return (
    <Section title="New profile">
      <form
        className="grid-form"
        aria-label="New profile"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Code
          <input required maxLength={40} pattern="[A-Z][A-Z0-9_]*" value={v.code} onChange={set('code')} />
        </label>
        <label>
          Name
          <input required maxLength={200} value={v.name} onChange={set('name')} />
        </label>
        <label>
          Provider time zone
          <input required maxLength={64} placeholder="Area/City" value={v.providerTimezone} onChange={set('providerTimezone')} />
        </label>
        <label>
          Pagination
          <select required value={v.paginationMode} onChange={set('paginationMode')}>
            <option value="" disabled>
              Choose…
            </option>
            <option value="CURSOR">Cursor</option>
            <option value="PAGE_NUMBER">Page number</option>
          </select>
        </label>
        <label>
          Lookback (minutes)
          <input required type="number" min={1} max={20160} value={v.lookbackMinutes} onChange={set('lookbackMinutes')} />
        </label>
        <label>
          Request settings reference
          <input required maxLength={300} autoComplete="off" value={v.requestConfigReference} onChange={set('requestConfigReference')} />
        </label>
        <label>
          Credential reference
          <input required maxLength={300} autoComplete="off" value={v.authReference} onChange={set('authReference')} />
        </label>
        <label>
          Schedule reference
          <input required maxLength={300} autoComplete="off" value={v.scheduleReference} onChange={set('scheduleReference')} />
        </label>
        <button type="submit" disabled={create.isPending}>
          Create profile
        </button>
      </form>
      <p className="hint">Enter references to the private store, never a secret itself; they are not shown again. A new profile stays disabled until it is activated with an approved mapping.</p>
      <Refusal error={create.error} />
    </Section>
  );
}

function ProfileActions({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const activate = useMutation({ mutationFn: () => api(`/v1/biometric/profiles/${profile.id}/activate`, { method: 'POST' }), onSettled: onChanged });
  const disable = useMutation({
    mutationFn: () => api(`/v1/biometric/profiles/${profile.id}/disable`, { body: { reason: reason.trim(), expectedVersion: profile.version } }),
    onSuccess: () => {
      setOpen(false);
      setReason('');
    },
    onSettled: onChanged,
  });
  return (
    <>
      {profile.active ? (
        <button type="button" className="link" onClick={() => setOpen(!open)}>
          Disable {profile.code}
        </button>
      ) : (
        <button type="button" className="link" disabled={activate.isPending} onClick={() => activate.mutate()}>
          Activate {profile.code}
        </button>
      )}
      <Refusal error={activate.error ?? disable.error} />
      {open && (
        <form
          className="stack"
          aria-label={`Disable ${profile.code}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            disable.mutate();
          }}
        >
          <label>
            Reason
            <textarea required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className="hint">New runs stop. A run under way finishes, and punches already made stay on record.</p>
          <button type="submit" disabled={disable.isPending || !reason.trim()}>
            Confirm disable
          </button>
        </form>
      )}
    </>
  );
}

export function BiometricProfilesPage() {
  const qc = useQueryClient();
  const profiles = useProfiles();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['biometric', 'profiles'] });
  return (
    <>
      <Section title="Biometric API profiles">
        <ErrorNote error={profiles.error} />
        {profiles.data?.items.length === 0 && <Empty>No profiles yet.</Empty>}
        {profiles.data && profiles.data.items.length > 0 && (
          <table aria-label="Profiles">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Time zone</th>
                <th scope="col">Lookback</th>
                <th scope="col">Synced until</th>
                <th scope="col">State</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {profiles.data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.code}</td>
                  <td>{p.name}</td>
                  <td>{p.providerTimezone}</td>
                  <td>{p.lookbackMinutes} minutes</td>
                  <td>{formatInstant(p.syncedUntil)}</td>
                  <td>
                    <Badge tone={p.active ? 'good' : 'neutral'}>{p.active ? 'Active' : 'Disabled'}</Badge>
                  </td>
                  <td>
                    <ProfileActions key={p.version} profile={p} onChanged={refresh} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <NewProfile onChanged={refresh} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Field Mapping
// ---------------------------------------------------------------------------------------------------------

/** FR-086: typed paths to allowlisted targets through allowlisted transforms, never an expression. */
const TARGETS = [
  { field: 'EMPLOYEE_KEY', label: 'Employee identity' },
  { field: 'PUNCH_INSTANT', label: 'Punch time' },
  { field: 'DIRECTION', label: 'Direction' },
  { field: 'EVENT_KEY', label: 'Event key' },
  { field: 'DEVICE_ID', label: 'Device' },
] as const;
const TARGET_LABEL: Readonly<Record<string, string>> = Object.fromEntries(TARGETS.map((t) => [t.field, t.label]));
const TRANSFORMS: Readonly<Record<string, string>> = { IDENTITY: 'As received', TRIM: 'Trim spaces', UPPER: 'Upper case', ENUM_MAP: 'Map values', PARSE_INSTANT: 'Parse time' };

interface FieldDraft {
  sourcePath: string;
  transformCode: string;
  required: boolean;
  enumLines: string;
  defaultCode: string;
}
const EMPTY_FIELD: FieldDraft = { sourcePath: '', transformCode: '', required: false, enumLines: '', defaultCode: '' };

const transformsOf = (target: string) => (target === 'PUNCH_INSTANT' ? ['PARSE_INSTANT'] : target === 'DIRECTION' ? ['IDENTITY', 'TRIM', 'UPPER', 'ENUM_MAP'] : ['IDENTITY', 'TRIM', 'UPPER']);

/** "0=IN" per line. */
function enumOf(lines: string): Record<string, string> {
  return Object.fromEntries(
    lines
      .split('\n')
      .map((l) => l.split('='))
      .filter((p) => p.length === 2 && p[0]!.trim() !== '')
      .map((p) => [p[0]!.trim(), p[1]!.trim()]),
  );
}

function NewRevision({ profileId, onChanged }: { profileId: string; onChanged: () => void }) {
  const [dedupeStrategy, setDedupe] = useState('');
  const [timestampRule, setRule] = useState('');
  const [effectiveFrom, setFrom] = useState('');
  const [fields, setFields] = useState<Record<string, FieldDraft>>({});
  const fieldOf = (target: string) => fields[target] ?? EMPTY_FIELD;
  const change = (target: string, patch: Partial<FieldDraft>) => setFields({ ...fields, [target]: { ...fieldOf(target), ...patch } });
  const create = useMutation({
    mutationFn: () =>
      api(`/v1/biometric/profiles/${profileId}/mappings`, {
        body: {
          dedupeStrategy,
          timestampRule,
          effectiveFrom: instantOf(effectiveFrom),
          fields: TARGETS.filter((t) => fieldOf(t.field).sourcePath.trim() !== '').map((t) => {
            const f = fieldOf(t.field);
            return {
              sourcePath: f.sourcePath.trim(),
              targetField: t.field,
              transformCode: f.transformCode || transformsOf(t.field)[0],
              required: f.required,
              ...(f.transformCode === 'ENUM_MAP' ? { enumConfig: enumOf(f.enumLines) } : {}),
              ...(t.field === 'DIRECTION' && f.defaultCode ? { defaultCode: f.defaultCode } : {}),
            };
          }),
        },
      }),
    onSuccess: () => {
      setFields({});
      setFrom('');
      onChanged();
    },
  });
  return (
    <Section title="New mapping revision">
      <form
        className="grid-form"
        aria-label="New mapping revision"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Duplicates by
          <select required value={dedupeStrategy} onChange={(e) => setDedupe(e.target.value)}>
            <option value="" disabled>
              Choose…
            </option>
            <option value="PROVIDER_EVENT_KEY">Provider event key</option>
            <option value="FINGERPRINT">Fingerprint</option>
          </select>
        </label>
        <label>
          Time format
          <select required value={timestampRule} onChange={(e) => setRule(e.target.value)}>
            <option value="" disabled>
              Choose…
            </option>
            <option value="ISO_WITH_OFFSET">With UTC offset</option>
            <option value="LOCAL_IN_PROVIDER_ZONE">Local in the provider’s zone</option>
          </select>
        </label>
        <label>
          In force from
          <input required type="datetime-local" value={effectiveFrom} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <table className="wide" aria-label="Field mapping">
          <thead>
            <tr>
              <th scope="col">Target</th>
              <th scope="col">Source path</th>
              <th scope="col">Transform</th>
              <th scope="col">Required</th>
              <th scope="col">Values and default</th>
            </tr>
          </thead>
          <tbody>
            {TARGETS.map((t) => {
              const f = fieldOf(t.field);
              return (
                <tr key={t.field}>
                  <th scope="row">{t.label}</th>
                  <td>
                    <input aria-label={`${t.label} source path`} maxLength={200} placeholder="field.path" value={f.sourcePath} onChange={(e) => change(t.field, { sourcePath: e.target.value })} />
                  </td>
                  <td>
                    <select aria-label={`${t.label} transform`} value={f.transformCode || transformsOf(t.field)[0]} onChange={(e) => change(t.field, { transformCode: e.target.value })}>
                      {transformsOf(t.field).map((code) => (
                        <option key={code} value={code}>
                          {TRANSFORMS[code]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input type="checkbox" aria-label={`${t.label} required`} checked={f.required} onChange={(e) => change(t.field, { required: e.target.checked })} />
                  </td>
                  <td>
                    {t.field === 'DIRECTION' && f.transformCode === 'ENUM_MAP' && (
                      <textarea aria-label="Direction values" rows={2} placeholder="device value=IN or OUT, one per line" value={f.enumLines} onChange={(e) => change(t.field, { enumLines: e.target.value })} />
                    )}
                    {t.field === 'DIRECTION' && (
                      <select aria-label="Direction default" value={f.defaultCode} onChange={(e) => change(t.field, { defaultCode: e.target.value })}>
                        <option value="">No default</option>
                        <option value="IN">IN</option>
                        <option value="OUT">OUT</option>
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button type="submit" disabled={create.isPending}>
          Create revision
        </button>
      </form>
      <p className="hint">A revision applies to nothing until someone other than its author approves it. Once approved it never changes, and it takes over from the revision in force on its start date.</p>
      <Refusal error={create.error} />
    </Section>
  );
}

function Preview({ revision }: { revision: MappingRevision }) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const run = useMutation({
    mutationFn: (records: unknown[]) =>
      api<{ results: ({ ok: true; value: { employeeKey: string; direction: string; instant: { value: string } } } | { ok: false; code: string })[] }>(`/v1/biometric/mappings/${revision.id}/preview`, { body: { records } }),
  });
  return (
    <form
      className="stack"
      aria-label={`Preview revision ${revision.revision}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        try {
          const parsed: unknown = JSON.parse(text);
          if (!Array.isArray(parsed)) throw new Error('not a list');
          setInvalid(false);
          run.mutate(parsed);
        } catch {
          setInvalid(true);
        }
      }}
    >
      <label>
        Sample records (a JSON list, at most 50)
        <textarea required rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {invalid && (
        <p role="alert" className="error">
          Enter the samples as a JSON list, for example [{'{'}…{'}'}].
        </p>
      )}
      <button type="submit" className="secondary" disabled={run.isPending}>
        Run preview
      </button>
      <p className="hint">Use synthetic samples. A preview applies nothing.</p>
      <Refusal error={run.error} />
      {run.data && (
        <ol aria-label="Preview results">
          {run.data.results.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: results answer the samples in order
            <li key={i}>{r.ok ? `${r.value.employeeKey} · ${r.value.instant.value} · ${r.value.direction}` : `Refused: ${r.code}`}</li>
          ))}
        </ol>
      )}
    </form>
  );
}

function RevisionCard({ revision, onChanged }: { revision: MappingRevision; onChanged: () => void }) {
  const [previewing, setPreviewing] = useState(false);
  const approve = useMutation({ mutationFn: () => api(`/v1/biometric/mappings/${revision.id}/approve`, { method: 'POST' }), onSettled: onChanged });
  return (
    <Section title={`Revision ${revision.revision}`}>
      <p>
        <StateBadge state={revision.approved ? 'APPROVED' : 'DRAFT'} /> {`in force from ${formatInstant(revision.effectiveFrom)}`}
        {revision.effectiveTo ? `, until ${formatInstant(revision.effectiveTo)}` : ''}
        {`; duplicates by ${revision.dedupeStrategy === 'FINGERPRINT' ? 'fingerprint' : 'provider event key'}; ${revision.timestampRule === 'ISO_WITH_OFFSET' ? 'times with a UTC offset' : 'local times in the provider’s zone'}`}
      </p>
      <table aria-label={`Fields of revision ${revision.revision}`}>
        <thead>
          <tr>
            <th scope="col">Target</th>
            <th scope="col">Source path</th>
            <th scope="col">Transform</th>
            <th scope="col">Required</th>
          </tr>
        </thead>
        <tbody>
          {revision.fields.map((f) => (
            <tr key={f.targetField}>
              <td>{TARGET_LABEL[f.targetField] ?? f.targetField}</td>
              <td>{f.sourcePath}</td>
              <td>{TRANSFORMS[f.transformCode] ?? f.transformCode}</td>
              <td>{f.required ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!revision.approved && !revision.ownRevision && (
        <button type="button" disabled={approve.isPending} onClick={() => approve.mutate()}>
          Approve revision {revision.revision}
        </button>
      )}
      {!revision.approved && revision.ownRevision && <p className="hint">You wrote this revision, so someone else must approve it.</p>}{' '}
      <button type="button" className="secondary" onClick={() => setPreviewing(!previewing)}>
        Preview revision {revision.revision}
      </button>
      <Refusal error={approve.error} />
      {previewing && <Preview revision={revision} />}
    </Section>
  );
}

export function BiometricFieldMappingPage() {
  const qc = useQueryClient();
  const [profileId, setProfileId] = useState('');
  const revisions = useQuery({
    queryKey: ['biometric', 'mappings', profileId],
    queryFn: () => api<{ items: MappingRevision[] }>(`/v1/biometric/profiles/${profileId}/mappings`),
    enabled: profileId !== '',
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['biometric', 'mappings', profileId] });
  return (
    <>
      <Section title="Field mapping">
        <ProfilePicker value={profileId} onChange={setProfileId} anyLabel="Choose a profile…" />
        <ErrorNote error={revisions.error} />
        {revisions.data?.items.length === 0 && <Empty>This profile has no mapping revisions yet.</Empty>}
      </Section>
      {revisions.data?.items.map((r) => (
        <RevisionCard key={`${r.id}-${String(r.approved)}`} revision={r} onChanged={refresh} />
      ))}
      {profileId !== '' && <NewRevision key={profileId} profileId={profileId} onChanged={refresh} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Employee Mapping
// ---------------------------------------------------------------------------------------------------------

interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
}
const personLabel = (p: EmployeeHit) => `${p.displayName} (${p.employeeCode})`;

function EmployeePicker({ value, onChange }: { value: EmployeeHit | null; onChange: (e: EmployeeHit | null) => void }) {
  const { can } = useSession();
  const canSearch = can(EMPLOYEE_LIST);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: ['biometric', 'employee-search', term],
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25' }).toString()}`),
    enabled: canSearch && term !== '',
  });
  if (!canSearch) return <p className="hint">The selected role cannot search employees, so it cannot choose one here.</p>;
  return (
    <div className="wide">
      <p>
        Employee: <strong>{value ? personLabel(value) : 'nobody chosen yet'}</strong>
      </p>
      <label>
        Find the employee
        <input type="search" maxLength={100} placeholder="Name, employee code or work email" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <ErrorNote error={hits.error} />
      {term !== '' && hits.data?.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {term !== '' && hits.data && hits.data.items.length > 0 && (
        <ul className="choices" aria-label="Matching employees">
          {hits.data.items.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {personLabel(e)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewLink({ profileId, onChanged }: { profileId: string; onChanged: () => void }) {
  const [key, setKey] = useState('');
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api(`/v1/biometric/profiles/${profileId}/links`, {
        body: { externalEmployeeKey: key.trim(), employeeId: employee!.id, effectiveFrom: instantOf(from), ...(to ? { effectiveTo: instantOf(to) } : {}) },
      }),
    onSuccess: () => {
      setKey('');
      setEmployee(null);
      setFrom('');
      setTo('');
      onChanged();
    },
  });
  return (
    <Section title="New employee link">
      <form
        className="grid-form"
        aria-label="New employee link"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Device identity
          <input required maxLength={100} value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label>
          From
          <input required type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Until (optional)
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <EmployeePicker value={employee} onChange={setEmployee} />
        <button type="submit" disabled={create.isPending || !employee}>
          Add link
        </button>
      </form>
      <Refusal error={create.error} />
    </Section>
  );
}

function LinkActions({ link, onChanged }: { link: EmployeeLink; onChanged: () => void }) {
  const [open, setOpen] = useState<'end' | 'move' | null>(null);
  const [at, setAt] = useState('');
  const [reason, setReason] = useState('');
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const done = {
    onSuccess: () => {
      setOpen(null);
      setAt('');
      setReason('');
      setEmployee(null);
    },
    onSettled: onChanged,
  };
  const end = useMutation({ mutationFn: () => api(`/v1/biometric/links/${link.id}/end`, { body: { effectiveTo: instantOf(at), reason: reason.trim(), expectedVersion: link.version } }), ...done });
  const move = useMutation({
    mutationFn: () => api(`/v1/biometric/links/${link.id}/supersede`, { body: { employeeId: employee!.id, effectiveFrom: instantOf(at), reason: reason.trim(), expectedVersion: link.version } }),
    ...done,
  });
  const toggle = (which: 'end' | 'move') => setOpen(open === which ? null : which);
  if (!link.current) return null;
  return (
    <>
      <button type="button" className="link" onClick={() => toggle('end')}>
        End {link.externalEmployeeKey}
      </button>{' '}
      <button type="button" className="link" onClick={() => toggle('move')}>
        Move {link.externalEmployeeKey}
      </button>
      <Refusal error={end.error ?? move.error} />
      {open && (
        <form
          className="stack"
          aria-label={`${open === 'end' ? 'End' : 'Move'} ${link.externalEmployeeKey}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (open === 'end') end.mutate();
            else move.mutate();
          }}
        >
          {open === 'move' && <EmployeePicker value={employee} onChange={setEmployee} />}
          <label>
            {open === 'end' ? 'Ends at' : 'New employee from'}
            <input required type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
          <label>
            Reason
            <textarea required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className="hint">Punches already made under this link stay as they are. This affects later fetches and reprocessing only.</p>
          <button type="submit" disabled={end.isPending || move.isPending || !reason.trim() || (open === 'move' && !employee)}>
            {open === 'end' ? 'Confirm end' : 'Confirm move'}
          </button>
        </form>
      )}
    </>
  );
}

export function BiometricEmployeeMappingPage() {
  const qc = useQueryClient();
  const [profileId, setProfileId] = useState('');
  const [search, setSearch] = useState('');
  const [currentOnly, setCurrentOnly] = useState(false);
  const [page, setPage] = useState(1);
  const query = `${pageParams(page)}${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}${currentOnly ? '&current=true' : ''}`;
  const links = useQuery({
    queryKey: ['biometric', 'links', profileId, query],
    queryFn: () => api<Paged<EmployeeLink>>(`/v1/biometric/profiles/${profileId}/links?${query}`),
    enabled: profileId !== '',
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['biometric', 'links', profileId] });
  return (
    <>
      <Section title="Employee mapping">
        <div className="grid-form">
          <ProfilePicker
            value={profileId}
            anyLabel="Choose a profile…"
            onChange={(id) => {
              setProfileId(id);
              setPage(1);
            }}
          />
          <label>
            Search
            <input
              type="search"
              maxLength={100}
              placeholder="Device identity, name or employee code"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={currentOnly}
              onChange={(e) => {
                setCurrentOnly(e.target.checked);
                setPage(1);
              }}
            />{' '}
            In force now only
          </label>
        </div>
        <ErrorNote error={links.error} />
        {links.data?.items.length === 0 && <Empty>No links match.</Empty>}
        {links.data && links.data.items.length > 0 && (
          <>
            <table aria-label="Employee links">
              <thead>
                <tr>
                  <th scope="col">Device identity</th>
                  <th scope="col">Employee</th>
                  <th scope="col">From</th>
                  <th scope="col">Until</th>
                  <th scope="col">State</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {links.data.items.map((l) => (
                  <tr key={l.id}>
                    <td>{l.externalEmployeeKey}</td>
                    <td>{`${l.employeeName} (${l.employeeCode})`}</td>
                    <td>{formatInstant(l.effectiveFrom)}</td>
                    <td>{formatInstant(l.effectiveTo)}</td>
                    <td>
                      <Badge tone={l.current ? 'good' : 'neutral'}>{l.current ? 'In force' : 'Not in force'}</Badge>
                    </td>
                    <td>
                      <LinkActions key={l.version} link={l} onChanged={refresh} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={links.data.page} pageSize={LIST_PAGE_SIZE} total={links.data.total} onPage={setPage} label="Employee link pages" noun="link" />
          </>
        )}
      </Section>
      {profileId !== '' && <NewLink key={profileId} profileId={profileId} onChanged={refresh} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Sync Monitor
// ---------------------------------------------------------------------------------------------------------

const FAILURES: Readonly<Record<string, string>> = {
  UNKNOWN_EMPLOYEE: 'No employee is linked to this identity',
  AMBIGUOUS_LOCAL_TIME: 'The local time is ambiguous or does not exist (daylight saving)',
  CONFLICTING_PAYLOAD: 'Same event key, different content',
  MISSING_EVENT_KEY: 'No event key',
  INVALID_TIMESTAMP: 'Invalid time',
  INVALID_DIRECTION: 'Invalid direction',
  FETCH_FAILED: 'The provider could not be reached after the retries',
  PROCESSING_FAILED: 'A page could not be saved',
  LEASE_EXPIRED: 'The run stopped responding and was ended',
};
const failureText = (code: string | null) => (code ? (FAILURES[code] ?? code) : '—');

function StartRun({ onChanged }: { onChanged: () => void }) {
  const [profileId, setProfileId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const start = useMutation({
    mutationFn: () => api<SyncRun>(`/v1/biometric/profiles/${profileId}/runs`, { body: { windowStart: instantOf(from), windowEnd: instantOf(to) } }),
    onSettled: onChanged,
  });
  return (
    <Section title="Fetch now">
      <form
        className="grid-form"
        aria-label="Fetch now"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        <ProfilePicker value={profileId} onChange={setProfileId} anyLabel="Choose a profile…" />
        <label>
          Window from
          <input required type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Window to
          <input required type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="submit" disabled={start.isPending || !profileId}>
          Start run
        </button>
      </form>
      <p className="hint">Repeating a window is safe: a punch already accepted is counted as a duplicate, never added twice.</p>
      <Refusal error={start.error} />
      {start.data && <p role="status">{`Run ended ${start.data.state}: ${start.data.accepted} accepted, ${start.data.duplicates} duplicates, ${start.data.quarantined} quarantined, ${start.data.rejected} rejected.`}</p>}
    </Section>
  );
}

function RunList({ profileId }: { profileId: string }) {
  const [state, setState] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const params = { ...(profileId ? { profileId } : {}), ...(state ? { state } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const query = `${pageParams(page)}&${new URLSearchParams(params).toString()}`;
  const runs = useQuery({ queryKey: ['biometric', 'runs', query], queryFn: () => api<Paged<SyncRun>>(`/v1/biometric/runs?${query}`) });
  useEffect(() => setPage(1), [profileId]);
  return (
    <Section title="Runs">
      <div className="grid-form">
        <label>
          State
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="RUNNING">Running</option>
            <option value="COMPLETED">Completed</option>
            <option value="PARTIAL">Partial</option>
            <option value="FAILED">Failed</option>
          </select>
        </label>
        <label>
          Started from
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          Started to
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      <ErrorNote error={runs.error} />
      {runs.data?.items.length === 0 && <Empty>No runs match.</Empty>}
      {runs.data && runs.data.items.length > 0 && (
        <>
          <table aria-label="Runs">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Started</th>
                <th scope="col">Window</th>
                <th scope="col">State</th>
                <th scope="col">Mapping</th>
                <th scope="col">Pages</th>
                <th scope="col">Received</th>
                <th scope="col">Accepted</th>
                <th scope="col">Duplicates</th>
                <th scope="col">Quarantined</th>
                <th scope="col">Rejected</th>
                <th scope="col">Problem</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.profileCode}</td>
                  <td>{formatInstant(r.startedAt)}</td>
                  <td>{`${formatInstant(r.windowStart)} to ${formatInstant(r.windowEnd)}`}</td>
                  <td>
                    <StateBadge state={r.state} />
                  </td>
                  <td>Revision {r.mappingRevision}</td>
                  <td>{r.pagesCommitted}</td>
                  <td>{r.observations}</td>
                  <td>{r.accepted}</td>
                  <td>{r.duplicates}</td>
                  <td>{r.quarantined}</td>
                  <td>{r.rejected}</td>
                  <td>{failureText(r.failureCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={runs.data.page} pageSize={LIST_PAGE_SIZE} total={runs.data.total} onPage={setPage} label="Run pages" noun="run" />
          <p className="hint">A partial or failed run keeps its checkpoint at the last saved page, and missing punches never count as an absence because of it.</p>
        </>
      )}
    </Section>
  );
}

const evidenceText = (e: NonNullable<SyncException['evidence']>) => `${e.employeeKey} · ${e.instant ? formatInstant(e.instant) : `${e.localTime ?? 'no time'} (device time)`} · ${e.direction}`;

function ExceptionActions({ row, onChanged }: { row: SyncException; onChanged: () => void }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const reprocess = useMutation({ mutationFn: () => api(`/v1/biometric/events/${row.eventId}/reprocess`, { method: 'POST' }), onSettled: onChanged });
  const correct = useMutation({ mutationFn: () => api(`/v1/biometric/events/${row.eventId}/correct`, { body: { normalisedTime: time.trim(), reason: reason.trim() } }), onSettled: onChanged });
  if (row.nextStep === 'RESOLVED') return <Badge tone="good">Since accepted</Badge>;
  if (row.failureCode === 'CONFLICTING_PAYLOAD') {
    return (
      <span className="hint">
        The kept event was not overwritten. To change the day, use <Link to="/attendance/control">attendance control</Link>.
      </span>
    );
  }
  if (!can(REPROCESS)) return null;
  if (row.nextStep === 'REPROCESS') {
    return (
      <>
        <button type="button" className="link" disabled={reprocess.isPending} onClick={() => reprocess.mutate()}>
          Reprocess {row.sourceEventKey}
        </button>
        <Refusal error={reprocess.error} />
      </>
    );
  }
  if (row.nextStep !== 'CORRECT_TIME') return null;
  return (
    <>
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        Correct time of {row.sourceEventKey}
      </button>
      {open && (
        <form
          className="stack"
          aria-label={`Correct time of ${row.sourceEventKey}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            correct.mutate();
          }}
        >
          <label>
            Time with its UTC offset
            <input required maxLength={40} placeholder="YYYY-MM-DDThh:mm:ss±hh:mm" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label>
            Reason
            <textarea required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className="hint">Confirm the reading on the device. The offset settles which of the two readings of a repeated hour this is. The record as received stays on file.</p>
          <button type="submit" disabled={correct.isPending || !reason.trim()}>
            Confirm correction
          </button>
          <Refusal error={correct.error} />
        </form>
      )}
    </>
  );
}

function ExceptionList({ profileId }: { profileId: string }) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const [openOnly, setOpenOnly] = useState(true);
  const [page, setPage] = useState(1);
  const params = { ...(profileId ? { profileId } : {}), ...(outcome ? { outcome } : {}), ...(openOnly ? { open: 'true' } : {}) };
  const query = `${pageParams(page)}&${new URLSearchParams(params).toString()}`;
  const rows = useQuery({ queryKey: ['biometric', 'exceptions', query], queryFn: () => api<Paged<SyncException>>(`/v1/biometric/exceptions?${query}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['biometric', 'exceptions'] });
    void qc.invalidateQueries({ queryKey: ['biometric', 'runs'] });
  };
  useEffect(() => setPage(1), [profileId]);
  return (
    <Section title="Rejected and quarantined records">
      <div className="grid-form">
        <label>
          Outcome
          <select
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="QUARANTINED">Quarantined</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => {
              setOpenOnly(e.target.checked);
              setPage(1);
            }}
          />{' '}
          Leave out those since accepted
        </label>
      </div>
      <ErrorNote error={rows.error} />
      {rows.data?.items.length === 0 && <Empty>Nothing to show.</Empty>}
      {rows.data && rows.data.items.length > 0 && (
        <>
          <table aria-label="Rejected and quarantined records">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Received</th>
                <th scope="col">Outcome</th>
                <th scope="col">Why</th>
                <th scope="col">Event key</th>
                <th scope="col">Device said</th>
                <th scope="col">Kept on record</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.profileCode}</td>
                  <td>{formatInstant(r.observedAt)}</td>
                  <td>
                    <StateBadge state={r.outcome} />
                  </td>
                  <td>{failureText(r.failureCode)}</td>
                  <td>{r.sourceEventKey ?? '—'}</td>
                  <td>{r.evidence ? evidenceText(r.evidence) : '—'}</td>
                  <td>{r.kept ? `${r.kept.employeeKey} · ${formatInstant(r.kept.instant)} · ${r.kept.direction}` : '—'}</td>
                  <td>
                    <ExceptionActions row={r} onChanged={refresh} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={rows.data.page} pageSize={LIST_PAGE_SIZE} total={rows.data.total} onPage={setPage} label="Record pages" noun="record" />
        </>
      )}
    </Section>
  );
}

export function BiometricSyncMonitorPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [profileId, setProfileId] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['biometric', 'runs'] });
    void qc.invalidateQueries({ queryKey: ['biometric', 'exceptions'] });
  };
  return (
    <>
      <Section title="Biometric sync monitor">
        <ProfilePicker value={profileId} onChange={setProfileId} anyLabel="All profiles" />
      </Section>
      <RunList profileId={profileId} />
      <ExceptionList profileId={profileId} />
      {can(SYNC_RUN) && <StartRun onChanged={refresh} />}
    </>
  );
}

export const BIOMETRIC_SCREENS: readonly ScreenRoute[] = [
  { path: '/biometric/profiles', title: 'API profiles', permission: PROFILE_MANAGE, nav: true, component: BiometricProfilesPage },
  { path: '/biometric/field-mapping', title: 'Field mapping', permission: MAPPING_MANAGE, nav: true, component: BiometricFieldMappingPage },
  { path: '/biometric/employee-mapping', title: 'Employee mapping', permission: LINK_MANAGE, nav: true, component: BiometricEmployeeMappingPage },
  { path: '/biometric/sync-monitor', title: 'Sync monitor', permission: READ, nav: true, component: BiometricSyncMonitorPage },
];
