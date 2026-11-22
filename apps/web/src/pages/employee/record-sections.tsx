// Record sections: family, qualifications, prior employment and payroll identifiers (FR-008, I-82 item 2).

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Action } from '@/components/action-bar';
import { CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { NothingChanged } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Notice, Section } from '../../ui';
import { Fact } from './record';
import { ReadProblem, refusalText } from './refusals';
import { EMPLOYEE_MANAGE_PAYROLL_ID, EMPLOYEE_MANAGE_PRIVATE, EMPLOYEE_PAYROLL_ID, EMPLOYEE_PRIVATE, enc, keys, type ListSectionKey, type PayrollIdentifiers, type RecordSectionsAnswer, type SectionEntry, words } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Record sections: family, qualifications, prior employment and payroll identifiers (FR-008, I-82 item 2)
// ---------------------------------------------------------------------------------------------------------

interface SectionField {
  name: string;
  label: string;
  kind: 'text' | 'reference' | 'date' | 'year' | 'boolean';
  required?: boolean;
  /** A reference: the company's controlled list it is chosen from. */
  list?: string;
  /** A reference: the entry's key that carries the chosen value's words. */
  words?: string;
  /** Text: a company list whose labels are offered as suggestions; any other text may still be typed (CL-007 qualification master). */
  suggestions?: string;
}

interface ListSection {
  key: ListSectionKey;
  title: string;
  /** One entry in words, as in "Add a family member". */
  noun: string;
  fields: readonly SectionField[];
}

/**
 * The three list sections and their fields, labelled as the server's dictionary labels them (GET /v1/employee-record-dictionary).
 * A required mark only prompts: the server checks every value against its dictionary and refuses in codes.
 */
const LIST_SECTIONS: readonly ListSection[] = [
  {
    key: 'family-members',
    title: 'Family and dependants',
    noun: 'family member',
    fields: [
      { name: 'relationship', label: 'Relationship', kind: 'reference', required: true, list: 'FAMILY_RELATIONSHIP', words: 'relationshipLabel' },
      { name: 'fullName', label: 'Full name', kind: 'text', required: true },
      { name: 'dateOfBirth', label: 'Date of birth', kind: 'date' },
      { name: 'dependant', label: 'Dependant', kind: 'boolean' },
    ],
  },
  {
    key: 'qualifications',
    title: 'Qualifications',
    noun: 'qualification',
    fields: [
      { name: 'level', label: 'Level', kind: 'reference', required: true, list: 'QUALIFICATION_LEVEL', words: 'levelLabel' },
      { name: 'qualification', label: 'Qualification', kind: 'text', required: true, suggestions: 'QUALIFICATION' },
      { name: 'specialisation', label: 'Specialisation', kind: 'text' },
      { name: 'institution', label: 'Institution or board', kind: 'text' },
      { name: 'completionYear', label: 'Year of completion', kind: 'year' },
    ],
  },
  {
    key: 'prior-employments',
    title: 'Prior employment',
    noun: 'prior employment',
    fields: [
      { name: 'employerName', label: 'Employer', kind: 'text', required: true },
      { name: 'designation', label: 'Designation', kind: 'text' },
      { name: 'fromDate', label: 'From', kind: 'date', required: true },
      { name: 'toDate', label: 'To (inclusive)', kind: 'date', required: true },
    ],
  },
];

/** The payroll identifiers: the key the route takes, the code its answer names, and the format a refusal says. */
const IDENTIFIERS = [
  { key: 'pan', code: 'PAN', label: 'PAN', format: 'five letters, four digits and a letter' },
  { key: 'uan', code: 'UAN', label: 'UAN (EPF)', format: 'twelve digits' },
  { key: 'esicIpNumber', code: 'ESIC_IP', label: 'ESIC IP number', format: 'ten digits' },
] as const;
type IdentifierKey = (typeof IDENTIFIERS)[number]['key'];

/** A field a section refusal names (details.field), in words. */
const SECTION_FIELD_WORDS: Readonly<Record<string, string>> = {
  relationship: 'relationship',
  fullName: 'full name',
  dateOfBirth: 'date of birth',
  dependant: 'dependant answer',
  level: 'qualification level',
  qualification: 'qualification',
  specialisation: 'specialisation',
  institution: 'institution or board',
  completionYear: 'year of completion',
  employerName: 'employer',
  designation: 'designation',
  fromDate: 'start date',
  toDate: 'end date',
  reason: 'reason',
};

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A refusal of a section entry in plain words; a code not named here reads as the record's other refusals do. */
function sectionRefusalText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = (error.details ?? {}) as { field?: string; joiningDate?: string };
  const field = (details.field ? SECTION_FIELD_WORDS[details.field] : undefined) ?? 'value';
  switch (error.code) {
    case 'UNKNOWN_FIELD':
      return 'The server does not keep one of the fields sent, so nothing was saved. Reload the page and try again.';
    case 'FIELD_REQUIRED':
      return `The ${field} is required. Fill it in and try again.`;
    case 'INVALID_FIELD':
      return `The ${field} is not valid. Check it and try again.`;
    case 'INVALID_REFERENCE':
      return `That ${field} is not on the company’s list. Choose one of the values offered.`;
    case 'INVALID_DATE':
      return `The ${field} must be a calendar date, and not in the future.`;
    case 'INVALID_PERIOD':
      return 'The prior employment ends before it starts. Check the start and end dates.';
    case 'CHRONOLOGY_CONFLICT':
      return `A prior employment must end before the joining date of this employment${details.joiningDate ? `, ${details.joiningDate}` : ''}.`;
    case 'STALE_VERSION':
      return 'This entry changed since you opened it. The sections have been reloaded; check it and try again. What you typed is still here.';
    case 'ENTRY_REMOVED':
      return 'This entry has been removed, so it can no longer be changed. The sections have been reloaded.';
    default:
      return refusalText(error);
  }
}

/** A refusal of the payroll identifiers in plain words. The value typed is never repeated. */
function identifierRefusalText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'INVALID_IDENTIFIER': {
      const named = IDENTIFIERS.find((i) => i.key === (error.details as { field?: string } | undefined)?.field);
      return named ? `The ${named.label} is ${named.format}. Check it and try again.` : 'An identifier is not in its format. Check it and try again.';
    }
    case 'NO_CHANGE':
      return 'Nothing differs from the identifiers on record, so nothing was saved.';
    case 'STALE_VERSION':
      return 'The payroll identifiers changed since you opened this. They have been reloaded; check them and try again. What you typed is still here.';
    default:
      return refusalText(error);
  }
}

/** A refusal in the words `say` gives it, or the server's own when it has none. */
function SaidRefusal({ error, say }: { error: unknown; say: (error: unknown) => string | null }) {
  const text = say(error);
  if (!text) return <ErrorNote error={error} />;
  return <Notice notice={{ text, ok: false }} />;
}

/** The sections moved on underneath: read them again, leaving what was typed in place. */
const reloadOnSectionConflict = (onConflict: () => void, codes: readonly string[]) => (err: unknown) => {
  if (err instanceof ApiError && codes.includes(err.code)) onConflict();
};

interface SectionChangeProps {
  employeeId: string;
  /** A successful change: its words are shown, and the sections are read again. */
  onSaved: (message: string) => void;
  /** The sections changed underneath: read them again. */
  onConflict: () => void;
}

/** A choice from the company's controlled list. A value the list no longer offers stays chosen and marked; the server decides on save. */
function ReferenceSelect(props: { category: string; label: string; value: string; known?: string | undefined; required?: boolean | undefined; onChange: (code: string) => void }) {
  const { category, label, value, known, required, onChange } = props;
  const options = useQuery({
    queryKey: ['employee-reference-values', category],
    queryFn: () => api<{ items: { code: string; label: string }[] }>(`/v1/reference-values?category=${enc(category)}`),
  });
  const items = options.data?.items ?? [];
  const offered = items.some((o) => o.code === value);
  return (
    <FormField
      hint={
        <>
          {options.isSuccess && items.length === 0 && <FieldDescription>The company’s list has no values yet.</FieldDescription>}
          {options.error instanceof ApiError && options.error.status === 403 ? (
            <FieldDescription>Your role cannot read this list, so it cannot be chosen here.</FieldDescription>
          ) : (
            <ErrorNote error={options.error} />
          )}
        </>
      }
    >
      {label}
      <NativeSelect required={required} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{`Choose a ${label.toLowerCase()}`}</option>
        {value && !offered && (
          <option value={value}>
            {known || words(value)}
            {options.isSuccess ? ' (no longer offered)' : ''}
          </option>
        )}
        {items.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
}

type EntryValues = Record<string, string | boolean>;

/** A form's starting values: the entry's own, or blank for a new one. */
const entryValues = (section: ListSection, entry?: SectionEntry): EntryValues =>
  Object.fromEntries(
    section.fields.map((f) => {
      const value = entry?.[f.name];
      return [f.name, f.kind === 'boolean' ? value === true : value === null || value === undefined ? '' : String(value)];
    }),
  );

/**
 * The body a route takes. A change names every field, a blank optional one as null (cleared); an addition names only what was
 * typed. A year typed in digits goes as a number; anything else goes as typed, for the server to refuse.
 */
function entryBody(section: ListSection, values: EntryValues, change: boolean): Record<string, string | number | boolean | null> {
  const body: Record<string, string | number | boolean | null> = {};
  for (const f of section.fields) {
    const value = values[f.name] ?? '';
    if (typeof value === 'boolean') {
      body[f.name] = value;
      continue;
    }
    const text = value.trim();
    if (text) body[f.name] = f.kind === 'year' && /^\d+$/.test(text) ? Number(text) : text;
    else if (change) body[f.name] = null;
  }
  return body;
}

/** A field of an entry as a table shows it: a chosen value by its words, a flag as Yes or No. */
function cellText(f: SectionField, entry: SectionEntry): string {
  const value = (f.words ? entry[f.words] : undefined) ?? entry[f.name];
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return f.kind === 'date' ? formatDate(String(value)) : String(value);
}

function EntryField({ field: f, value, known, onChange }: { field: SectionField; value: string | boolean; known?: string | undefined; onChange: (value: string | boolean) => void }) {
  if (f.kind === 'boolean') {
    return (
      <CheckField>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {f.label}
      </CheckField>
    );
  }
  const text = typeof value === 'string' ? value : '';
  if (f.kind === 'reference') return <ReferenceSelect category={f.list ?? ''} label={f.label} value={text} known={known} required={f.required} onChange={onChange} />;
  const listId = f.suggestions ? `suggest-${f.name}` : undefined;
  return (
    <FormField>
      {f.label}
      <Input
        type={f.kind === 'date' ? 'date' : f.kind === 'year' ? 'number' : 'text'}
        required={f.required}
        maxLength={f.kind === 'text' ? 200 : undefined}
        value={text}
        list={listId}
        onChange={(e) => onChange(e.target.value)}
      />
      {f.suggestions && listId && <Suggestions id={listId} category={f.suggestions} />}
    </FormField>
  );
}

/**
 * CL-007: the company's list of names (the qualification master) as suggestions for a text field. The field stays free text, so an
 * entry recorded before the list, or a name the list lacks, is kept as typed; a role that cannot read the list just gets no suggestions.
 */
function Suggestions({ id, category }: { id: string; category: string }) {
  const options = useQuery({
    queryKey: ['employee-reference-values', category],
    queryFn: () => api<{ items: { code: string; label: string }[] }>(`/v1/reference-values?category=${enc(category)}`),
    retry: false,
  });
  return (
    <datalist id={id}>
      {(options.data?.items ?? []).map((o) => (
        <option key={o.code} value={o.label} />
      ))}
    </datalist>
  );
}

/** Adds an entry, or changes one naming the version read. What was typed stays when the server refuses it. */
function EntryForm({ employeeId, section, entry, onSaved, onConflict, close }: SectionChangeProps & { section: ListSection; entry?: SectionEntry; close: () => void }) {
  const [values, setValues] = useState(() => entryValues(section, entry));
  const path = `/v1/employees/${enc(employeeId)}/record-sections/${section.key}`;
  const save = useMutation({
    mutationFn: () =>
      entry
        ? api<{ id: string }>(`${path}/${enc(entry.id)}`, { method: 'PUT', body: { ...entryBody(section, values, true), expectedVersion: entry.version } })
        : api<{ id: string }>(path, { body: entryBody(section, values, false) }),
    onSuccess: () => {
      close();
      onSaved(`${sentence(section.noun)} ${entry ? 'saved' : 'added'}.`);
    },
    onError: reloadOnSectionConflict(onConflict, ['STALE_VERSION', 'ENTRY_REMOVED']),
  });
  return (
    <FormGrid
      aria-label={entry ? `Edit ${section.noun}` : `Add a ${section.noun}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {section.fields.map((f) => (
        <EntryField
          key={f.name}
          field={f}
          value={values[f.name] ?? ''}
          known={f.words && entry ? String(entry[f.words] ?? '') : undefined}
          onChange={(value) => setValues({ ...values, [f.name]: value })}
        />
      ))}
      <Button type="submit" disabled={save.isPending}>
        Save {section.noun}
      </Button>
      {entry && (
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
      )}
      <div className="col-span-full">
        <SaidRefusal error={save.error} say={sectionRefusalText} />
      </div>
    </FormGrid>
  );
}

/** DF08: an entry recorded in error is removed with a reason and stays on record, read only. */
function RemoveEntryForm({ employeeId, section, entry, onSaved, onConflict, close }: SectionChangeProps & { section: ListSection; entry: SectionEntry; close: () => void }) {
  const [reason, setReason] = useState('');
  const remove = useMutation({
    mutationFn: () =>
      api<{ id: string; removed: boolean }>(`/v1/employees/${enc(employeeId)}/record-sections/${section.key}/${enc(entry.id)}/remove`, {
        body: { reason: reason.trim(), expectedVersion: entry.version },
      }),
    onSuccess: () => {
      close();
      onSaved(`${sentence(section.noun)} removed. It stays on record, read only, under Show removed entries.`);
    },
    onError: reloadOnSectionConflict(onConflict, ['STALE_VERSION', 'ENTRY_REMOVED']),
  });
  return (
    <FormGrid
      aria-label={`Remove ${section.noun}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        remove.mutate();
      }}
    >
      <p>
        {section.fields
          .slice(0, 2)
          .map((f) => cellText(f, entry))
          .join(', ')}
      </p>
      <FormField className="col-span-full">
        Reason
        <Input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <Button type="submit" disabled={remove.isPending}>
        Confirm removal
      </Button>
      <Button type="button" variant="outline" onClick={close}>
        Cancel
      </Button>
      <div className="col-span-full">
        <SaidRefusal error={remove.error} say={sectionRefusalText} />
      </div>
    </FormGrid>
  );
}

function ListSectionView({ section, entries, ...changes }: SectionChangeProps & { section: ListSection; entries: SectionEntry[] }) {
  const { can } = useSession();
  const manage = can(EMPLOYEE_MANAGE_PRIVATE);
  const [open, setOpen] = useState<{ mode: 'edit' | 'remove'; entry: SectionEntry } | null>(null);
  // The entry as last read. One gone from the list (removed elsewhere) keeps its form open, so the refusal stays readable.
  const current = open ? (entries.find((e) => e.id === open.entry.id) ?? open.entry) : null;
  const removed = entries.some((e) => e.removedAt);
  const close = () => setOpen(null);
  return (
    <>
      <h3>{section.title}</h3>
      {entries.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <Table aria-label={section.title}>
          <TableHeader>
            <TableRow>
              {section.fields.map((f) => (
                <TableHead key={f.name} scope="col">
                  {f.label}
                </TableHead>
              ))}
              {(manage || removed) && (
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id}>
                {section.fields.map((f) => (
                  <TableCell key={f.name}>{cellText(f, e)}</TableCell>
                ))}
                {(manage || removed) && (
                  // A removal's reason is free text: the cell takes the room it needs, wrapping rather than widening the table.
                  <RowActionsCell expanded={!!e.removedAt}>
                    {e.removedAt ? (
                      <>
                        <Badge tone="warn">removed</Badge> {formatDate(e.removedAt)}
                        {e.removalReason ? `: ${e.removalReason}` : ''}
                      </>
                    ) : (
                      manage && (
                        <RowActions>
                          <Button type="button" variant="outline" size="sm" onClick={() => setOpen({ mode: 'edit', entry: e })}>
                            Edit
                          </Button>{' '}
                          <Button type="button" variant="danger" size="sm" onClick={() => setOpen({ mode: 'remove', entry: e })}>
                            Remove
                          </Button>
                        </RowActions>
                      )
                    )}
                  </RowActionsCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {manage &&
        open &&
        current &&
        (open.mode === 'edit' ? (
          <EntryForm key={`edit-${current.id}`} {...changes} section={section} entry={current} close={close} />
        ) : (
          <RemoveEntryForm key={`remove-${current.id}`} {...changes} section={section} entry={current} close={close} />
        ))}
      {manage && <Action label={`Add a ${section.noun}`}>{(closeAdd) => <EntryForm {...changes} section={section} close={closeAdd} />}</Action>}
    </>
  );
}

const NO_IDENTIFIERS: Readonly<Record<IdentifierKey, string>> = { pan: '', uan: '', esicIpNumber: '' };
const NONE_CLEARED: Readonly<Record<IdentifierKey, boolean>> = { pan: false, uan: false, esicIpNumber: false };

/**
 * Sends only the identifiers typed or cleared (null clears one), naming the version read; one left blank stays as it is. Nothing
 * is filled in from the record, and what was typed is cleared once saved, never shown again.
 */
function PayrollIdentifiersForm({ employeeId, identifiers, onSaved, onConflict, close }: SectionChangeProps & { identifiers: PayrollIdentifiers; close: () => void }) {
  const [typed, setTyped] = useState<Record<IdentifierKey, string>>({ ...NO_IDENTIFIERS });
  const [cleared, setCleared] = useState<Record<IdentifierKey, boolean>>({ ...NONE_CLEARED });
  const [unchanged, setUnchanged] = useState(false);
  const save = useMutation({
    mutationFn: (changes: Partial<Record<IdentifierKey, string | null>>) =>
      api<{ employeeId: string; recorded: string[]; changed: string[]; version: number }>(`/v1/employees/${enc(employeeId)}/payroll-identifiers`, {
        method: 'PUT',
        body: { ...changes, ...(identifiers.version === null ? {} : { expectedVersion: identifiers.version }) },
      }),
    onSuccess: (answer) => {
      setTyped({ ...NO_IDENTIFIERS });
      setCleared({ ...NONE_CLEARED });
      close();
      const changed = answer.changed.map((code) => IDENTIFIERS.find((i) => i.code === code)?.label ?? words(code));
      onSaved(`Payroll identifiers saved${changed.length ? `: ${changed.join(', ')} changed` : ''}.`);
    },
    onError: reloadOnSectionConflict(onConflict, ['STALE_VERSION']),
  });
  const changes = () => {
    const out: Partial<Record<IdentifierKey, string | null>> = {};
    for (const { key } of IDENTIFIERS) {
      if (cleared[key]) out[key] = null;
      else if (typed[key].trim()) out[key] = typed[key].trim();
    }
    return out;
  };
  return (
    <FormGrid
      aria-label="Change payroll identifiers"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const changed = changes();
        const nothing = Object.keys(changed).length === 0;
        setUnchanged(nothing);
        if (nothing) save.reset();
        else save.mutate(changed);
      }}
    >
      {IDENTIFIERS.map((i) => (
        <Field key={i.key} className="gap-2">
          <FormField>
            {i.label}
            <Input autoComplete="off" spellCheck={false} maxLength={40} disabled={cleared[i.key]} value={typed[i.key]} onChange={(e) => setTyped({ ...typed, [i.key]: e.target.value })} />
          </FormField>
          {identifiers.values[i.key] !== null && (
            <CheckField>
              <input type="checkbox" checked={cleared[i.key]} onChange={(e) => setCleared({ ...cleared, [i.key]: e.target.checked })} /> Clear the {i.label}
            </CheckField>
          )}
        </Field>
      ))}
      <Button type="submit" disabled={save.isPending}>
        Save payroll identifiers
      </Button>
      <Hint>Type only the identifiers to change: one left blank stays as it is.</Hint>
      <div className="col-span-full">
        {unchanged && <NothingChanged />}
        <SaidRefusal error={save.error} say={identifierRefusalText} />
      </div>
    </FormGrid>
  );
}

function PayrollIdentifiersView({ identifiers, ...changes }: SectionChangeProps & { identifiers: PayrollIdentifiers }) {
  const { can } = useSession();
  return (
    <>
      <h3>
        Payroll identifiers {identifiers.masked && <Badge tone="warn">masked</Badge>}
      </h3>
      <dl className="kv">
        {IDENTIFIERS.map((i) => (
          <Fact key={i.key} label={i.label}>
            {identifiers.values[i.key] ?? '—'}
          </Fact>
        ))}
      </dl>
      {can(EMPLOYEE_MANAGE_PAYROLL_ID) && <Action label="Change payroll identifiers">{(close) => <PayrollIdentifiersForm {...changes} identifiers={identifiers} close={close} />}</Action>}
    </>
  );
}

/** The record sections are offered under the private-details grant or the payroll-identifier grant. */
export const recordSectionsOffered = (can: (permission: string) => boolean) => can(EMPLOYEE_PRIVATE) || can(EMPLOYEE_PAYROLL_ID);

/** The record sections' title, as the panel's heading reads it. */
export const RECORD_SECTIONS_TITLE = 'Family, qualifications and prior employment';

/**
 * FR-008 record sections (I-82 item 2) under the role's own grant, read only when asked for and not kept once left. The server
 * leaves out every part the grant does not read and masks the identifiers without the payroll-identifier group; this page shows
 * what it answers. A form is offered only with the duty its route checks and only beside a part that was read, so nothing is
 * changed unseen and a change names the version read. The server refuses a change to one's own record.
 */
export function RecordSectionsPanel({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [shown, setShown] = useState(false);
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sections = useQuery({
    queryKey: [...keys.recordSections(employeeId), includeRemoved],
    enabled: shown,
    gcTime: 0,
    // Asking for removed entries keeps the parts on screen while they are read again, so a half-filled form stays.
    placeholderData: keepPreviousData,
    queryFn: () => api<RecordSectionsAnswer>(`/v1/employees/${enc(employeeId)}/record-sections${includeRemoved ? '?includeRemoved=true' : ''}`),
  });
  if (!recordSectionsOffered(can)) return null;
  const reload = () => void qc.invalidateQueries({ queryKey: keys.recordSections(employeeId) });
  const changes: SectionChangeProps = {
    employeeId,
    onConflict: reload,
    onSaved: (message) => {
      setNotice(message);
      reload();
    },
  };
  const data = sections.data;
  const lists = LIST_SECTIONS.flatMap((section) => {
    const entries = data?.[section.key];
    return entries ? [{ section, entries }] : [];
  });
  const identifiers = data?.['payroll-identifiers'];
  return (
    <Section
      title={RECORD_SECTIONS_TITLE}
      actions={
        // A long label wraps on a narrow screen rather than running past the card.
        <Button type="button" variant="outline" className="h-auto min-h-[var(--control-h)] shrink py-1.5 whitespace-normal" aria-expanded={shown} onClick={() => setShown(!shown)}>
          {shown ? 'Hide family, qualifications and prior employment' : 'Show family, qualifications and prior employment'}
        </Button>
      }
    >
      {shown && (
        <>
          {notice && <Notice notice={{ text: notice, ok: true }} />}
          {sections.error ? <ReadProblem error={sections.error} /> : null}
          {lists.length > 0 && (
            <CheckField>
              <input type="checkbox" checked={includeRemoved} onChange={(e) => setIncludeRemoved(e.target.checked)} /> Show removed entries
            </CheckField>
          )}
          {lists.map(({ section, entries }) => (
            <ListSectionView key={section.key} {...changes} section={section} entries={entries} />
          ))}
          {identifiers && <PayrollIdentifiersView {...changes} identifiers={identifiers} />}
        </>
      )}
    </Section>
  );
}
