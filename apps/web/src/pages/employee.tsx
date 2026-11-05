// One employee (FR-006, FR-008; BR-001 to BR-004; DF04; DF08; I-55): create, edit, activation, the effective-dated manager,
// transfer and shift changes, and the record, which links to the one employee history for its status history (FR-089;
// employee-history.tsx). Every section is field-group aware: a group the server left out of its answer is not shown, not even
// as a blank, and a form is offered only with the duty its route checks.
//
// The page holds no rule of its own. The server validates every value and refuses in codes, which are said here in plain words
// beside what was typed. Master choices come from the server for the date typed (validOn); a choice a new date no longer offers
// stays chosen and marked, and the server decides on save. These routes take no idempotency key; the ones that take an expected
// version get the version on screen, and a date repeated on a dated change is refused (CHANGE_NOT_LATEST), so a retry cannot apply twice.
//
// Not offered: family, qualification, prior-employment and payroll-identifier sections, whose field dictionary is an open owner
// question (I-48 item 3).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';

const EMPLOYEE_LIST = 'employee.list.operational';
const EMPLOYEE_READ = 'employee.read.operational';
const EMPLOYEE_CREATE = 'employee.create.operational';
const EMPLOYEE_CREATE_PERSONAL = 'employee.create.personal';
const EMPLOYEE_UPDATE = 'employee.update.operational';
const EMPLOYEE_UPDATE_PERSONAL = 'employee.update.personal';
const EMPLOYEE_ACTIVATE = 'employee.activate.operational';
const EMPLOYEE_DEACTIVATE = 'employee.deactivate.operational';
const EMPLOYEE_HISTORY = 'employee.read_history.operational';
const EMPLOYEE_PRIVATE = 'employee.read.private';
const EMPLOYEE_BANK = 'employee.read.bank';
const SHIFT_READ = 'shift.read.operational';
const SHIFT_ASSIGN = 'shift.assign.operational';

const enc = encodeURIComponent;
const words = (code: string) => code.replace(/_/g, ' ').toLowerCase();
/** A private field's key in words: personalEmail reads "Personal email". */
const fieldWords = (key: string) => {
  const spaced = key.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** The types POST /v1/employees accepts (its schema's enum). */
const EMPLOYMENT_TYPES = [
  { code: 'PERMANENT', label: 'Permanent' },
  { code: 'FIXED_TERM', label: 'Fixed term' },
  { code: 'INTERN', label: 'Intern' },
  { code: 'CONTRACTOR', label: 'Contractor' },
] as const;
const employmentTypeLabel = (code: string) => EMPLOYMENT_TYPES.find((t) => t.code === code)?.label ?? words(code);

/**
 * GET /v1/employees/:id. A key the role's assignment does not reach is absent: the personal fields without the personal group,
 * the grade's words without the grade master's read duty, and the no-manager reason without the history duty.
 */
export interface EmployeeRecord {
  id: string;
  employeeCode: string;
  displayName: string;
  workEmail: string | null;
  joiningDate: string;
  confirmationDate: string | null;
  employmentType: string;
  status: string;
  assignment: {
    departmentId: string;
    departmentName: string;
    locationId: string;
    locationName: string;
    designationId: string;
    designationName: string;
    gradeId: string | null;
    gradeCode?: string | null;
    gradeName?: string | null;
  } | null;
  manager: { id: string; employeeCode: string; displayName: string } | null;
  shift?: { id: string; code: string; name: string } | null;
  noManagerReason?: string | null;
  version: number;
  dateOfBirth?: string | null;
  serviceAnniversaryDate?: string | null;
}

interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
}

interface MasterOption {
  id: string;
  code: string;
  name: string;
}

interface ShiftOption {
  id: string;
  code: string;
  name: string;
  inTime: string;
  outTime: string;
  active: boolean;
}

/** The part of GET /v1/employees/:id/history the employee history screen does not carry. */
interface EmploymentHistory {
  leavingDate: string | null;
  priorEmployment: { employeeId: string; employeeCode: string | null } | null;
  nextEmployment: { employeeId: string; employeeCode: string | null } | null;
  shifts: { effectiveFrom: string; effectiveTo: string | null; shiftCode: string; shiftName: string }[];
}

interface PrivateCategory {
  revision: number;
  effectiveFrom: string | null;
  values: Record<string, string | null> | null;
  masked?: boolean;
}
/** GET /v1/employees/:id/private-profile: only the categories the grant reaches. */
interface PrivateProfile {
  personal?: PrivateCategory;
  address?: PrivateCategory;
  bank?: PrivateCategory;
}

const keys = {
  record: (id: string) => ['employee-record', id],
  history: (id: string) => ['employee-history', id],
  privateProfile: (id: string) => ['employee-private-profile', id],
};

// ---------------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------------

/** The requirements ACTIVATION_REQUIREMENTS_MISSING names, each with where to fix it. */
const MISSING_REQUIREMENTS: Readonly<Record<string, string>> = {
  WORK_EMAIL: 'A work email. Add one under Edit details.',
  JOB_ASSIGNMENT: 'A job assignment in force on that date. Add one under Transfer.',
  SHIFT_ASSIGNMENT: 'An active shift in force on that date. Add one under Change shift.',
  MANAGER_OR_NO_MANAGER_REASON: 'A manager in force on that date, or a reason for having none. Use Change manager, or type the reason here.',
};

const FIELD_WORDS: Readonly<Record<string, string>> = {
  employeeCode: 'employee code: it starts with a letter or digit and uses only letters, digits, hyphens and underscores, up to 40 characters',
  displayName: 'name',
  workEmail: 'work email',
  joiningDate: 'joining date',
  effectiveFrom: 'date',
  dateOfBirth: 'date of birth',
  serviceAnniversaryDate: 'service anniversary base date',
};

const GENERIC_RULE = 'The change violates a business rule';

function periodWords(from: string | null, to: string | null): string {
  if (from && to) return `It applies from ${from} until ${to}, not included.`;
  if (to) return `It applies until ${to}, not included.`;
  if (from) return `It applies from ${from}.`;
  return '';
}

function chronologyWords(details: { conflict?: string; effectiveFrom?: string; lastWorkingDate?: string }): string {
  switch (details.conflict) {
    case 'BIRTH_DATE':
      return 'The joining date must be after the date of birth.';
    case 'ASSIGNMENT':
      return `A later job assignment starts on ${details.effectiveFrom}, so the joining date must be before it.`;
    case 'MANAGER':
      return `A manager period starts on ${details.effectiveFrom}, so the joining date cannot be after it.`;
    case 'SHIFT':
      return `A shift period starts on ${details.effectiveFrom}, so the joining date cannot be after it.`;
    case 'PRIOR_EMPLOYMENT':
      return `The new employment must start after the last working date of the prior one, ${details.lastWorkingDate}.`;
    default:
      return 'The date conflicts with the dates already on this record.';
  }
}

/** A refusal in plain words, by code; any other is shown as the server sent it. `rule` names the likely rule of a generic refusal. */
function refusalText(error: unknown, rule?: string): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = (error.details ?? {}) as Record<string, string | undefined>;
  const outside = /^(DEPARTMENT|LOCATION|DESIGNATION|GRADE)_OUTSIDE_VALID_PERIOD$/.exec(error.code);
  if (outside) {
    const noun = outside[1]!.toLowerCase();
    return `This ${noun} is not valid on ${details.date}. ${periodWords(details.validFrom ?? null, details.validTo ?? null)} Choose another ${noun} or another date.`.replace(/\s+/g, ' ');
  }
  switch (error.code) {
    case 'STALE_VERSION':
      return 'This employee changed since you opened this. The record has been reloaded; check it and try again. What you typed is still here.';
    case 'INVALID_STATE':
      return 'This employee is no longer a draft, so this cannot be done. The record has been reloaded.';
    case 'DUPLICATE':
      return 'Another employee already has this employee code or work email.';
    case 'INVALID_REFERENCE':
      return `That choice cannot be used. ${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`;
    case 'CHANGE_NOT_LATEST':
      return 'A change on or after this date is already recorded. A new change must start after the latest one, so use a later date.';
    case 'RULE_VIOLATION':
      return error.message === GENERIC_RULE ? (rule ?? 'The server refused this because it breaks a business rule. Check the dates and values.') : `${error.message}.`;
    case 'REASON_REQUIRED':
      return 'Removing a manager needs a reason. Type one and try again.';
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'This change involves your own record, so another administrator must make it.';
    case 'NO_CHANGE':
      return 'That is already the joining date.';
    case 'CHRONOLOGY_CONFLICT':
      return chronologyWords(details);
    case 'PRIOR_EMPLOYMENT_NOT_ENDED':
      return 'The prior employment has not ended, so this one cannot follow it.';
    case 'EMPLOYMENT_ENDED':
      return 'The employment has ended, so no shift can be assigned.';
    case 'AFTER_LAST_WORKING_DATE':
      return `A shift cannot start after the approved last working date, ${details.lastWorkingDate}.`;
    case 'USER_LINK_OPEN':
      return 'A user account is still linked to this employee. End that link under User accounts first.';
    case 'FORBIDDEN':
      return 'Your role is not permitted to do this for this employee.';
    case 'INVALID_VALUE':
      return 'A date or value is not valid. Check it and try again.';
    case 'INVALID_REQUEST': {
      const field = /(?:body\/|property ')(\w+)/.exec(error.message)?.[1];
      return `The server did not accept the ${(field && FIELD_WORDS[field]) ?? 'values typed'}. Check and try again.`;
    }
    default:
      return null;
  }
}

function Refusal({ error, rule }: { error: unknown; rule?: string }) {
  if (error instanceof ApiError && error.code === 'ACTIVATION_REQUIREMENTS_MISSING') {
    const details = (error.details ?? {}) as { missing?: string[]; checkDate?: string };
    return (
      <div role="alert" className="error">
        <p>This employee cannot be activated yet. The check date is {details.checkDate}. Still missing:</p>
        <ul>
          {details.missing?.map((code) => (
            <li key={code}>{MISSING_REQUIREMENTS[code] ?? words(code)}</li>
          ))}
        </ul>
      </div>
    );
  }
  const text = refusalText(error, rule);
  if (!text) return <ErrorNote error={error} />;
  return (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

/** A record the server would not read: out of scope and nonexistent are the same answer. */
function ReadProblem({ error }: { error: unknown }) {
  if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return <Empty>This employee was not found, or is outside the scope of your role.</Empty>;
  if (error instanceof ApiError && error.status === 403) return <Empty>Your role is not permitted to read this.</Empty>;
  return <ErrorNote error={error} />;
}

// ---------------------------------------------------------------------------------------------------------
// Choices the server offers
// ---------------------------------------------------------------------------------------------------------

/**
 * A master offered for a date: GET /v1/org/:kind?validOn=. What is chosen stays chosen when a new date no longer offers it, so
 * nothing typed vanishes; it is marked, and the server decides on save.
 */
function MasterSelect(props: {
  kind: 'departments' | 'locations' | 'designations' | 'grades';
  label: string;
  value: string;
  /** The current value's name, before any list has been read. */
  known?: string | undefined;
  validOn: string;
  required?: boolean;
  onChange: (id: string) => void;
}) {
  const { kind, label, value, known, validOn, required, onChange } = props;
  const options = useQuery({
    queryKey: ['employee-master-options', kind, validOn],
    queryFn: () => api<{ items: MasterOption[] }>(`/v1/org/${kind}${validOn ? `?validOn=${enc(validOn)}` : ''}`),
  });
  const names = useRef(new Map<string, string>());
  const items = options.data?.items ?? [];
  for (const m of items) names.current.set(m.id, `${m.code} ${m.name}`);
  const offered = items.some((m) => m.id === value);
  return (
    <div>
      <label>
        {label}
        <select required={required} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{required ? `Choose a ${label.toLowerCase()}` : 'None'}</option>
          {value && !offered && (
            <option value={value}>
              {names.current.get(value) ?? known ?? 'The current choice'}
              {options.isSuccess ? ' (not offered on this date)' : ''}
            </option>
          )}
          {items.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code} {m.name}
            </option>
          ))}
        </select>
      </label>
      {options.isSuccess && items.length === 0 && <p className="hint">None is valid on this date.</p>}
      {options.error instanceof ApiError && options.error.status === 403 ? <p className="hint">Your role cannot read this list, so it cannot be chosen here.</p> : <ErrorNote error={options.error} />}
    </div>
  );
}

/** Found by a search of what the role can see; `filter` narrows it to what the route accepts, and the server checks again. */
function EmployeePicker({ label, value, onChange, filter }: { label: string; value: EmployeeHit | null; onChange: (e: EmployeeHit | null) => void; filter: Record<string, string> }) {
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: ['employee-picker', term, filter],
    enabled: term !== '' && can(EMPLOYEE_LIST),
    queryFn: () => api<{ items: EmployeeHit[] }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25', ...filter }).toString()}`),
  });
  if (!can(EMPLOYEE_LIST)) return <p className="hint wide">Your role cannot search employees, so it cannot choose one here.</p>;
  return (
    <div className="wide">
      <p>
        {label}: <strong>{value ? `${value.displayName} (${value.employeeCode})` : 'nobody chosen yet'}</strong>{' '}
        {value && (
          <button type="button" className="secondary" onClick={() => onChange(null)}>
            Clear
          </button>
        )}
      </p>
      <label>
        Find by name, code or email
        <input type="search" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <ErrorNote error={hits.error} />
      {hits.isSuccess && term !== '' && hits.data.items.length === 0 && <Empty>Nobody matches “{term}”.</Empty>}
      {term !== '' && !!hits.data?.items.length && (
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
                {e.displayName} ({e.employeeCode})
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// New employee
// ---------------------------------------------------------------------------------------------------------

export function NewEmployeePage() {
  const { can } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    employeeCode: '',
    displayName: '',
    workEmail: '',
    joiningDate: '',
    employmentType: '',
    departmentId: '',
    locationId: '',
    designationId: '',
    gradeId: '',
    dateOfBirth: '',
    serviceAnniversaryDate: '',
  });
  const [prior, setPrior] = useState<EmployeeHit | null>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const personal = can(EMPLOYEE_CREATE_PERSONAL);
  const create = useMutation({
    mutationFn: () =>
      api<EmployeeRecord>('/v1/employees', {
        body: {
          employeeCode: form.employeeCode.trim(),
          displayName: form.displayName.trim(),
          joiningDate: form.joiningDate,
          employmentType: form.employmentType,
          departmentId: form.departmentId,
          locationId: form.locationId,
          designationId: form.designationId,
          ...(form.workEmail.trim() ? { workEmail: form.workEmail.trim() } : {}),
          ...(form.gradeId ? { gradeId: form.gradeId } : {}),
          ...(personal && form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
          ...(personal && form.serviceAnniversaryDate ? { serviceAnniversaryDate: form.serviceAnniversaryDate } : {}),
          ...(prior ? { priorEmployeeId: prior.id } : {}),
        },
      }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['employees'] });
      navigate(`/employees/${created.id}`);
    },
  });
  return (
    <Section title="New employee">
      <form
        className="grid-form"
        aria-label="New employee"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Employee code
          <input required value={form.employeeCode} onChange={(e) => set({ employeeCode: e.target.value })} />
        </label>
        <label>
          Name
          <input required maxLength={200} value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} />
        </label>
        <label>
          Work email
          <input type="email" maxLength={254} value={form.workEmail} onChange={(e) => set({ workEmail: e.target.value })} />
        </label>
        <label>
          Joining date
          <input type="date" required value={form.joiningDate} onChange={(e) => set({ joiningDate: e.target.value })} />
        </label>
        <label>
          Employment type
          <select required value={form.employmentType} onChange={(e) => set({ employmentType: e.target.value })}>
            <option value="">Choose a type</option>
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <MasterSelect kind="departments" label="Department" required value={form.departmentId} validOn={form.joiningDate} onChange={(departmentId) => set({ departmentId })} />
        <MasterSelect kind="locations" label="Location" required value={form.locationId} validOn={form.joiningDate} onChange={(locationId) => set({ locationId })} />
        <MasterSelect kind="designations" label="Designation" required value={form.designationId} validOn={form.joiningDate} onChange={(designationId) => set({ designationId })} />
        <MasterSelect kind="grades" label="Grade" value={form.gradeId} validOn={form.joiningDate} onChange={(gradeId) => set({ gradeId })} />
        {personal && (
          <>
            <label>
              Date of birth
              <input type="date" value={form.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} />
            </label>
            <label>
              Service anniversary base date
              <input type="date" value={form.serviceAnniversaryDate} onChange={(e) => set({ serviceAnniversaryDate: e.target.value })} />
            </label>
          </>
        )}
        <EmployeePicker label="Follows the ended employment of" value={prior} onChange={setPrior} filter={{ status: 'INACTIVE_SEPARATED' }} />
        <button type="submit" disabled={create.isPending}>
          Create employee
        </button>
        <p className="hint wide">A new employee starts as a draft. Activation, the manager and the shift are on their record, which opens once this is saved.</p>
        <div className="wide">
          <Refusal error={create.error} />
        </div>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Changes to one employee
// ---------------------------------------------------------------------------------------------------------

interface FormProps {
  employee: EmployeeRecord;
  /** A successful change: its words are shown on the record, which is read again. */
  onSaved: (message: string) => void;
  /** The record changed underneath: read it again, leaving what was typed in place. */
  onConflict: () => void;
}

const reloadOnConflict = (onConflict: () => void) => (err: unknown) => {
  if (err instanceof ApiError && (err.code === 'STALE_VERSION' || err.code === 'INVALID_STATE')) onConflict();
};

/** An action behind a button. Open forms stay open while others are used, so a form left half-filled keeps its values. */
function Action({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && children(() => setOpen(false))}
    </div>
  );
}

function EditForm({ employee, onSaved, onConflict, close }: FormProps & { close: () => void }) {
  const { can } = useSession();
  const operational = can(EMPLOYEE_UPDATE);
  // Personal fields are editable only when the server let this role read them: nothing is changed unseen.
  const birthDate = can(EMPLOYEE_UPDATE_PERSONAL) && employee.dateOfBirth !== undefined;
  const anniversary = can(EMPLOYEE_UPDATE_PERSONAL) && employee.serviceAnniversaryDate !== undefined;
  const [form, setForm] = useState({ displayName: employee.displayName, workEmail: employee.workEmail ?? '', dateOfBirth: employee.dateOfBirth ?? '', serviceAnniversaryDate: employee.serviceAnniversaryDate ?? '' });
  const [unchanged, setUnchanged] = useState(false);
  const save = useMutation({
    mutationFn: (changes: Record<string, string | null>) => api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}`, { method: 'PATCH', body: { expectedVersion: employee.version, ...changes } }),
    onSuccess: () => {
      close();
      onSaved('Details saved.');
    },
    onError: reloadOnConflict(onConflict),
  });
  // Only what differs is sent: the route checks the duty of each group named, and a blank optional value clears it.
  const changes = (): Record<string, string | null> => ({
    ...(operational && form.displayName.trim() !== employee.displayName ? { displayName: form.displayName.trim() } : {}),
    ...(operational && form.workEmail.trim() !== (employee.workEmail ?? '') ? { workEmail: form.workEmail.trim() || null } : {}),
    ...(birthDate && form.dateOfBirth !== (employee.dateOfBirth ?? '') ? { dateOfBirth: form.dateOfBirth || null } : {}),
    ...(anniversary && form.serviceAnniversaryDate !== (employee.serviceAnniversaryDate ?? '') ? { serviceAnniversaryDate: form.serviceAnniversaryDate || null } : {}),
  });
  return (
    <form
      className="grid-form"
      aria-label="Edit details"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const changed = changes();
        const nothing = Object.keys(changed).length === 0;
        setUnchanged(nothing);
        if (nothing) save.reset();
        else save.mutate(changed);
      }}
    >
      {operational && (
        <>
          <label>
            Name
            <input required maxLength={200} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label>
            Work email
            <input type="email" maxLength={254} value={form.workEmail} onChange={(e) => setForm({ ...form, workEmail: e.target.value })} />
          </label>
        </>
      )}
      {birthDate && (
        <label>
          Date of birth
          <input type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} />
        </label>
      )}
      {anniversary && (
        <label>
          Service anniversary base date
          <input type="date" value={form.serviceAnniversaryDate} onChange={(e) => setForm({ ...form, serviceAnniversaryDate: e.target.value })} />
        </label>
      )}
      <button type="submit" disabled={save.isPending}>
        Save details
      </button>
      <div className="wide">
        {unchanged && <p role="status">Nothing changed.</p>}
        <Refusal error={save.error} />
      </div>
    </form>
  );
}

/** DF04: the server checks the requirements on the joining date, or today when joining has passed, and names what is missing. */
function ActivationPanel({ employee, onSaved, onConflict }: FormProps) {
  const [noManagerReason, setNoManagerReason] = useState('');
  const activate = useMutation({
    mutationFn: () =>
      api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/activate`, {
        body: { expectedVersion: employee.version, ...(noManagerReason.trim() ? { noManagerReason: noManagerReason.trim() } : {}) },
      }),
    onSuccess: () => onSaved('Activated. The employee is now on probation from the joining date.'),
    onError: reloadOnConflict(onConflict),
  });
  return (
    <Section title="Activation">
      <form
        className="grid-form"
        aria-label="Activate"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          activate.mutate();
        }}
      >
        <label className="wide">
          Reason for having no manager (only if there is none on the check date)
          <input maxLength={500} value={noManagerReason} onChange={(e) => setNoManagerReason(e.target.value)} />
        </label>
        <button type="submit" disabled={activate.isPending}>
          Activate
        </button>
        <div className="wide">
          <Refusal error={activate.error} />
        </div>
      </form>
    </Section>
  );
}

function ManagerForm({ employee, onSaved, close }: FormProps & { close: () => void }) {
  const [manager, setManager] = useState<EmployeeHit | null>(null);
  const [remove, setRemove] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [reason, setReason] = useState('');
  const change = useMutation({
    mutationFn: () =>
      api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/manager`, {
        body: { managerEmployeeId: remove ? null : manager!.id, effectiveFrom, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      }),
    onSuccess: () => {
      close();
      onSaved(`Manager change saved, effective ${effectiveFrom}. The record shows it from that date; earlier periods stay in the history.`);
    },
  });
  return (
    <form
      className="grid-form"
      aria-label="Change manager"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      {!remove && <EmployeePicker label="New manager" value={manager} onChange={setManager} filter={{ statusGroup: 'ACTIVE' }} />}
      <label className="check wide">
        <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> No manager from this date
      </label>
      <label>
        Effective from
        <input type="date" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </label>
      <label>
        Reason
        <input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button type="submit" disabled={change.isPending || (!remove && !manager)}>
        Save manager change
      </button>
      <p className="hint wide">Open approval tasks stay with the manager who holds them.</p>
      <div className="wide">
        <Refusal error={change.error} rule="This would break a rule: the new manager may already report to this employee, directly or through others." />
      </div>
    </form>
  );
}

function TransferForm({ employee, onSaved, close }: FormProps & { close: () => void }) {
  const current = employee.assignment;
  const [form, setForm] = useState({ departmentId: current?.departmentId ?? '', locationId: current?.locationId ?? '', designationId: current?.designationId ?? '', gradeId: current?.gradeId ?? '', effectiveFrom: '', reason: '' });
  const change = useMutation({
    mutationFn: () =>
      api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/assignment`, {
        body: {
          departmentId: form.departmentId,
          locationId: form.locationId,
          designationId: form.designationId,
          effectiveFrom: form.effectiveFrom,
          ...(form.gradeId ? { gradeId: form.gradeId } : {}),
          ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
        },
      }),
    onSuccess: () => {
      close();
      onSaved(`Transfer saved, effective ${form.effectiveFrom}. The record shows it from that date; earlier periods stay in the history.`);
    },
  });
  return (
    <form
      className="grid-form"
      aria-label="Transfer"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      <label>
        Effective from
        <input type="date" required value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
      </label>
      <MasterSelect kind="departments" label="Department" required value={form.departmentId} known={current?.departmentName} validOn={form.effectiveFrom} onChange={(departmentId) => setForm({ ...form, departmentId })} />
      <MasterSelect kind="locations" label="Location" required value={form.locationId} known={current?.locationName} validOn={form.effectiveFrom} onChange={(locationId) => setForm({ ...form, locationId })} />
      <MasterSelect kind="designations" label="Designation" required value={form.designationId} known={current?.designationName} validOn={form.effectiveFrom} onChange={(designationId) => setForm({ ...form, designationId })} />
      <MasterSelect kind="grades" label="Grade" value={form.gradeId} validOn={form.effectiveFrom} onChange={(gradeId) => setForm({ ...form, gradeId })} />
      <label className="wide">
        Reason
        <input maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </label>
      <button type="submit" disabled={change.isPending}>
        Save transfer
      </button>
      <div className="wide">
        <Refusal error={change.error} />
      </div>
    </form>
  );
}

function ShiftForm({ employee, onSaved, close }: FormProps & { close: () => void }) {
  const { can } = useSession();
  const [shiftId, setShiftId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const shifts = useQuery({ queryKey: ['employee-shift-options'], enabled: can(SHIFT_READ), queryFn: () => api<{ items: ShiftOption[] }>('/v1/shifts') });
  const change = useMutation({
    mutationFn: () => api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/shift`, { body: { shiftId, effectiveFrom } }),
    onSuccess: () => {
      close();
      onSaved(`Shift change saved, effective ${effectiveFrom}. Earlier periods stay in the history.`);
    },
  });
  if (!can(SHIFT_READ)) return <p className="hint">Your role cannot read the shift master, so it cannot choose a shift here.</p>;
  return (
    <form
      className="grid-form"
      aria-label="Change shift"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      <label>
        Shift
        <select required value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
          <option value="">Choose a shift</option>
          {shifts.data?.items
            .filter((s) => s.active)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} {s.name} ({s.inTime}-{s.outTime})
              </option>
            ))}
        </select>
      </label>
      <label>
        Effective from
        <input type="date" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </label>
      <button type="submit" disabled={change.isPending}>
        Save shift change
      </button>
      <div className="wide">
        <ErrorNote error={shifts.error} />
        <Refusal error={change.error} />
      </div>
    </form>
  );
}

function JoiningDateForm({ employee, onSaved, onConflict, close }: FormProps & { close: () => void }) {
  const [joiningDate, setJoiningDate] = useState(employee.joiningDate);
  const [reason, setReason] = useState('');
  const correct = useMutation({
    mutationFn: () => api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/joining-date`, { body: { expectedVersion: employee.version, joiningDate, reason: reason.trim() } }),
    onSuccess: () => {
      close();
      onSaved(`Joining date corrected to ${joiningDate}. The earlier date stays on record.`);
    },
    onError: reloadOnConflict(onConflict),
  });
  return (
    <form
      className="grid-form"
      aria-label="Correct joining date"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        correct.mutate();
      }}
    >
      <label>
        Joining date
        <input type="date" required value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} />
      </label>
      <label className="wide">
        Reason
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button type="submit" disabled={correct.isPending}>
        Save joining date
      </button>
      <div className="wide">
        <Refusal error={correct.error} />
      </div>
    </form>
  );
}

function CloseDraftForm({ employee, onSaved, onConflict, close }: FormProps & { close: () => void }) {
  const [reason, setReason] = useState('');
  const closeDraft = useMutation({
    mutationFn: () => api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/close-draft`, { body: { expectedVersion: employee.version, reason: reason.trim() } }),
    onSuccess: () => {
      close();
      onSaved('Draft closed. The record, its code and its work email are kept.');
    },
    onError: reloadOnConflict(onConflict),
  });
  return (
    <form
      className="grid-form"
      aria-label="Close draft"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        closeDraft.mutate();
      }}
    >
      <label className="wide">
        Reason
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button type="submit" disabled={closeDraft.isPending}>
        Confirm closing the draft
      </button>
      <p className="hint wide">For someone who never joined. The record stays on file as archived.</p>
      <div className="wide">
        <Refusal error={closeDraft.error} />
      </div>
    </form>
  );
}

function Changes(props: FormProps) {
  const { can } = useSession();
  const { employee } = props;
  const draft = employee.status === 'DRAFT';
  const update = can(EMPLOYEE_UPDATE);
  const edit = update || (can(EMPLOYEE_UPDATE_PERSONAL) && (employee.dateOfBirth !== undefined || employee.serviceAnniversaryDate !== undefined));
  const assign = can(SHIFT_ASSIGN);
  const closeDraft = draft && can(EMPLOYEE_DEACTIVATE);
  if (!edit && !update && !assign && !closeDraft) return null;
  return (
    <Section title="Change this record">
      {edit && <Action label="Edit details">{(close) => <EditForm {...props} close={close} />}</Action>}
      {update && <Action label="Change manager">{(close) => <ManagerForm {...props} close={close} />}</Action>}
      {update && <Action label="Transfer">{(close) => <TransferForm {...props} close={close} />}</Action>}
      {assign && <Action label="Change shift">{(close) => <ShiftForm {...props} close={close} />}</Action>}
      {draft && update && <Action label="Correct joining date">{(close) => <JoiningDateForm {...props} close={close} />}</Action>}
      {closeDraft && <Action label="Close draft">{(close) => <CloseDraftForm {...props} close={close} />}</Action>}
      {(update || assign) && <p className="hint">Manager, transfer and shift changes are dated: the current period closes on that date, and a new change must start after the latest one.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------------------

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function RecordFacts({ employee: e }: { employee: EmployeeRecord }) {
  return (
    <dl className="kv">
      <Fact label="Employee code">{e.employeeCode}</Fact>
      <Fact label="Name">{e.displayName}</Fact>
      <Fact label="Status">
        <StateBadge state={e.status} />
      </Fact>
      <Fact label="Employment type">{employmentTypeLabel(e.employmentType)}</Fact>
      <Fact label="Work email">{e.workEmail ?? '—'}</Fact>
      <Fact label="Joining date">{formatDate(e.joiningDate)}</Fact>
      <Fact label="Confirmation date">{formatDate(e.confirmationDate)}</Fact>
      {e.assignment ? (
        <>
          <Fact label="Department">{e.assignment.departmentName}</Fact>
          <Fact label="Location">{e.assignment.locationName}</Fact>
          <Fact label="Designation">{e.assignment.designationName}</Fact>
          {e.assignment.gradeName && (
            <Fact label="Grade">
              {e.assignment.gradeCode} {e.assignment.gradeName}
            </Fact>
          )}
        </>
      ) : (
        <Fact label="Job assignment">None in force today</Fact>
      )}
      <Fact label="Shift">{e.shift ? `${e.shift.code} ${e.shift.name}` : 'None in force today'}</Fact>
      <Fact label="Manager">
        {e.manager ? (
          <Link to={`/employees/${e.manager.id}`}>
            {e.manager.displayName} ({e.manager.employeeCode})
          </Link>
        ) : (
          'None in force today'
        )}
      </Fact>
      {e.noManagerReason && <Fact label="Reason for having no manager">{e.noManagerReason}</Fact>}
      {e.dateOfBirth !== undefined && <Fact label="Date of birth">{formatDate(e.dateOfBirth)}</Fact>}
      {e.serviceAnniversaryDate !== undefined && <Fact label="Service anniversary base date">{formatDate(e.serviceAnniversaryDate)}</Fact>}
    </dl>
  );
}

function PrivateValues({ title, category }: { title: string; category: PrivateCategory }) {
  const entries = Object.entries(category.values ?? {}).filter(([, v]) => v !== null && v !== '');
  return (
    <>
      <h3>
        {title} {category.masked && <Badge tone="warn">masked</Badge>}
      </h3>
      {entries.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <dl className="kv">
          {entries.map(([key, value]) => (
            <Fact key={key} label={fieldWords(key)}>
              {value}
            </Fact>
          ))}
        </dl>
      )}
    </>
  );
}

/**
 * FR-008: private details under the role's own grant, read only when asked for and not kept once left. The server leaves out
 * every category the grant does not reach and masks the bank values without the bank group; this page shows what it answers.
 */
function PrivateDetails({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  const [shown, setShown] = useState(false);
  const profile = useQuery({
    queryKey: keys.privateProfile(employeeId),
    enabled: shown,
    gcTime: 0,
    queryFn: () => api<PrivateProfile>(`/v1/employees/${enc(employeeId)}/private-profile`),
  });
  if (!can(EMPLOYEE_PRIVATE) && !can(EMPLOYEE_BANK)) return null;
  return (
    <Section
      title="Private details"
      actions={
        <button type="button" className="secondary" aria-expanded={shown} onClick={() => setShown(!shown)}>
          {shown ? 'Hide private details' : 'Show private details'}
        </button>
      }
    >
      {shown && (
        <>
          {profile.error ? <ReadProblem error={profile.error} /> : null}
          {profile.data?.personal && <PrivateValues title="Personal details" category={profile.data.personal} />}
          {profile.data?.address && <PrivateValues title="Address" category={profile.data.address} />}
          {profile.data?.bank && <PrivateValues title="Bank details" category={profile.data.bank} />}
        </>
      )}
    </Section>
  );
}

/**
 * Status changes, joining date corrections, job assignments and managers are read on the one employee history (FR-089;
 * employee-history.tsx), under this same duty, and are not repeated here. This section keeps only what that screen does not
 * carry: shift periods, the last working date and the employments linked to this one.
 */
function HistorySection({ employeeId }: { employeeId: string }) {
  const history = useQuery({ queryKey: keys.history(employeeId), queryFn: () => api<EmploymentHistory>(`/v1/employees/${enc(employeeId)}/history`) });
  const h = history.data;
  return (
    <Section title="Employment history">
      <p>
        <Link to={`/employee-history/${employeeId}`}>Status and employment history</Link>
      </p>
      {history.error ? <ReadProblem error={history.error} /> : null}
      {h && (
        <>
          <dl className="kv">
            <Fact label="Last working date">{formatDate(h.leavingDate)}</Fact>
            {h.priorEmployment && (
              <Fact label="Follows the employment">
                <Link to={`/employees/${h.priorEmployment.employeeId}`}>{h.priorEmployment.employeeCode ?? 'Prior employment'}</Link>
              </Fact>
            )}
            {h.nextEmployment && (
              <Fact label="Followed by the employment">
                <Link to={`/employees/${h.nextEmployment.employeeId}`}>{h.nextEmployment.employeeCode ?? 'Next employment'}</Link>
              </Fact>
            )}
          </dl>
          <h3>Shifts</h3>
          {h.shifts.length === 0 ? (
            <Empty>Nothing recorded yet.</Empty>
          ) : (
            <table aria-label="Shifts">
              <thead>
                <tr>
                  <th scope="col">From</th>
                  <th scope="col">Until</th>
                  <th scope="col">Shift</th>
                </tr>
              </thead>
              <tbody>
                {h.shifts.map((s, i) => (
                  <tr key={i}>
                    <td>{formatDate(s.effectiveFrom)}</td>
                    <td>{s.effectiveTo ? formatDate(s.effectiveTo) : 'Open'}</td>
                    <td>
                      {s.shiftCode} {s.shiftName}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Section>
  );
}

function EmployeeRecordView({ id }: { id: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const record = useQuery({ queryKey: keys.record(id), queryFn: () => api<EmployeeRecord>(`/v1/employees/${enc(id)}`) });
  const reload = () => {
    void qc.invalidateQueries({ queryKey: keys.record(id) });
    void qc.invalidateQueries({ queryKey: keys.history(id) });
    void qc.invalidateQueries({ queryKey: ['employees'] });
  };
  const onSaved = (message: string) => {
    setNotice(message);
    reload();
  };
  const employee = record.data;
  // Either document grant reaches the documents page, as on the employee list (FR-010).
  const documents = can('document.read.document') || can('document.upload.document');
  return (
    <>
      {can(EMPLOYEE_LIST) && <Link to="/employees">← Employees</Link>}
      {record.error ? <ReadProblem error={record.error} /> : null}
      {employee && (
        <>
          <Section title={`${employee.displayName} (${employee.employeeCode})`} actions={documents ? <Link to={`/employees/${employee.id}/documents`}>Documents</Link> : undefined}>
            {notice && <p role="status">{notice}</p>}
            <RecordFacts employee={employee} />
            <p className="hint">Family, qualification, prior-employment and payroll-identifier sections are not offered: their field dictionary is an open owner question.</p>
          </Section>
          {employee.status === 'DRAFT' && can(EMPLOYEE_ACTIVATE) && <ActivationPanel employee={employee} onSaved={onSaved} onConflict={reload} />}
          <Changes employee={employee} onSaved={onSaved} onConflict={reload} />
          <PrivateDetails employeeId={employee.id} />
          {can(EMPLOYEE_HISTORY) && <HistorySection employeeId={employee.id} />}
        </>
      )}
    </>
  );
}

/** A new address is a new record: nothing typed or noted for one employee carries over to another. */
export function EmployeeRecordPage() {
  const { id = '' } = useParams();
  return <EmployeeRecordView key={id} id={id} />;
}

export const EMPLOYEE_SCREENS: readonly ScreenRoute[] = [
  // The static path wins over /employees/:id in react-router, whatever the order here.
  { path: '/employees/new', title: 'New employee', permission: EMPLOYEE_CREATE, nav: true, component: NewEmployeePage },
  { path: '/employees/:id', title: 'Employee record', permission: EMPLOYEE_READ, nav: false, component: EmployeeRecordPage },
];
