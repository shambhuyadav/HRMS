// The field mapping screen (FR-087): versioned revisions approved by someone other than their author, and a safe preview.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api } from '../../api';
import { Empty, ErrorNote, Notice, Section, StateBadge } from '../../ui';
import { Refusal } from './refusals';
import { formatInstant, instantOf, type MappingRevision, ProfilePicker } from './shared';

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

/** The direction's value map and default, one under another in their cell. */
const VALUES_CELL = 'flex flex-col items-start gap-2';

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
      <FormGrid
        aria-label="New mapping revision"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormField>
          Duplicates by
          <NativeSelect required value={dedupeStrategy} onChange={(e) => setDedupe(e.target.value)}>
            <option value="" disabled>
              Choose…
            </option>
            <option value="PROVIDER_EVENT_KEY">Provider event key</option>
            <option value="FINGERPRINT">Fingerprint</option>
          </NativeSelect>
        </FormField>
        <FormField>
          Time format
          <NativeSelect required value={timestampRule} onChange={(e) => setRule(e.target.value)}>
            <option value="" disabled>
              Choose…
            </option>
            <option value="ISO_WITH_OFFSET">With UTC offset</option>
            <option value="LOCAL_IN_PROVIDER_ZONE">Local in the provider’s zone</option>
          </NativeSelect>
        </FormField>
        <FormField>
          In force from
          <Input required type="datetime-local" value={effectiveFrom} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        {/* The table's own container is the grid item, so it is the wrapper that spans the form's row. */}
        <div className="col-span-full">
          <Table aria-label="Field mapping">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Target</TableHead>
                <TableHead scope="col">Source path</TableHead>
                <TableHead scope="col">Transform</TableHead>
                <TableHead scope="col">Required</TableHead>
                <TableHead scope="col">Values and default</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TARGETS.map((t) => {
                const f = fieldOf(t.field);
                return (
                  <TableRow key={t.field}>
                    <TableHead scope="row">{t.label}</TableHead>
                    <TableCell>
                      <Input aria-label={`${t.label} source path`} maxLength={200} placeholder="field.path" value={f.sourcePath} onChange={(e) => change(t.field, { sourcePath: e.target.value })} />
                    </TableCell>
                    <TableCell>
                      <NativeSelect aria-label={`${t.label} transform`} value={f.transformCode || transformsOf(t.field)[0]} onChange={(e) => change(t.field, { transformCode: e.target.value })}>
                        {transformsOf(t.field).map((code) => (
                          <option key={code} value={code}>
                            {TRANSFORMS[code]}
                          </option>
                        ))}
                      </NativeSelect>
                    </TableCell>
                    <TableCell>
                      <input type="checkbox" aria-label={`${t.label} required`} checked={f.required} onChange={(e) => change(t.field, { required: e.target.checked })} />
                    </TableCell>
                    <TableCell>
                      {t.field === 'DIRECTION' && (
                        <div className={VALUES_CELL}>
                          {f.transformCode === 'ENUM_MAP' && (
                            <Textarea aria-label="Direction values" rows={2} placeholder="device value=IN or OUT, one per line" value={f.enumLines} onChange={(e) => change(t.field, { enumLines: e.target.value })} />
                          )}
                          <NativeSelect aria-label="Direction default" value={f.defaultCode} onChange={(e) => change(t.field, { defaultCode: e.target.value })}>
                            <option value="">No default</option>
                            <option value="IN">IN</option>
                            <option value="OUT">OUT</option>
                          </NativeSelect>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <Button type="submit" disabled={create.isPending}>
          Create revision
        </Button>
      </FormGrid>
      <Hint>A revision applies to nothing until someone other than its author approves it. Once approved it never changes, and it takes over from the revision in force on its start date.</Hint>
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
      className="flex flex-col items-start gap-3"
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
      <FormField>
        Sample records (a JSON list, at most 50)
        <Textarea required rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </FormField>
      {invalid && <Notice notice={{ text: 'Enter the samples as a JSON list, for example [{…}].', ok: false }} />}
      <Button type="submit" variant="outline" disabled={run.isPending}>
        Run preview
      </Button>
      <Hint>Use synthetic samples. A preview applies nothing.</Hint>
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
      <Table aria-label={`Fields of revision ${revision.revision}`}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Target</TableHead>
            <TableHead scope="col">Source path</TableHead>
            <TableHead scope="col">Transform</TableHead>
            <TableHead scope="col">Required</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {revision.fields.map((f) => (
            <TableRow key={f.targetField}>
              <TableCell>{TARGET_LABEL[f.targetField] ?? f.targetField}</TableCell>
              <TableCell>{f.sourcePath}</TableCell>
              <TableCell>{TRANSFORMS[f.transformCode] ?? f.transformCode}</TableCell>
              <TableCell>{f.required ? 'Yes' : 'No'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!revision.approved && !revision.ownRevision && (
        <Button type="button" disabled={approve.isPending} onClick={() => approve.mutate()}>
          Approve revision {revision.revision}
        </Button>
      )}
      {!revision.approved && revision.ownRevision && <Hint>You wrote this revision, so someone else must approve it.</Hint>}{' '}
      <Button type="button" variant="outline" onClick={() => setPreviewing(!previewing)}>
        Preview revision {revision.revision}
      </Button>
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
        {/* A grid of one field, so the choice takes a column's width rather than the whole card's. */}
        <FormGrid asChild>
          <div>
            <ProfilePicker value={profileId} onChange={setProfileId} anyLabel="Choose a profile…" />
          </div>
        </FormGrid>
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
