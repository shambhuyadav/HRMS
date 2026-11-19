// The API profiles screen (FR-086): a new profile, and each profile's actions; settings are never shown again.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../../api';
import { Badge, Empty, ErrorNote, Section } from '../../ui';
import { Refusal } from './refusals';
import { formatInstant, type Profile, useProfiles } from './shared';

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
                <th scope="col"><span className="sr-only">Actions</span></th>
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
