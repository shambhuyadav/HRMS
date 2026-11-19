// The field mapping screen (FR-087): versioned revisions approved by someone other than their author, and a safe preview.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../../api';
import { Empty, ErrorNote, Section, StateBadge } from '../../ui';
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
