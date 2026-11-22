// The API profiles screen (FR-086): a new profile, and each profile's actions; settings are never shown again.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
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
      <FormGrid
        aria-label="New profile"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormField>
          Code
          <Input required maxLength={40} pattern="[A-Z][A-Z0-9_]*" value={v.code} onChange={set('code')} />
        </FormField>
        <FormField>
          Name
          <Input required maxLength={200} value={v.name} onChange={set('name')} />
        </FormField>
        <FormField>
          Provider time zone
          <Input required maxLength={64} placeholder="Area/City" value={v.providerTimezone} onChange={set('providerTimezone')} />
        </FormField>
        <FormField>
          Pagination
          <NativeSelect required value={v.paginationMode} onChange={set('paginationMode')}>
            <option value="" disabled>
              Choose…
            </option>
            <option value="CURSOR">Cursor</option>
            <option value="PAGE_NUMBER">Page number</option>
          </NativeSelect>
        </FormField>
        <FormField>
          Lookback (minutes)
          <Input required type="number" min={1} max={20160} value={v.lookbackMinutes} onChange={set('lookbackMinutes')} />
        </FormField>
        <FormField>
          Request settings reference
          <Input required maxLength={300} autoComplete="off" value={v.requestConfigReference} onChange={set('requestConfigReference')} />
        </FormField>
        <FormField>
          Credential reference
          <Input required maxLength={300} autoComplete="off" value={v.authReference} onChange={set('authReference')} />
        </FormField>
        <FormField>
          Schedule reference
          <Input required maxLength={300} autoComplete="off" value={v.scheduleReference} onChange={set('scheduleReference')} />
        </FormField>
        <Button type="submit" disabled={create.isPending}>
          Create profile
        </Button>
      </FormGrid>
      <Hint>Enter references to the private store, never a secret itself; they are not shown again. A new profile stays disabled until it is activated with an approved mapping.</Hint>
      <Refusal error={create.error} />
    </Section>
  );
}

/** A profile's actions, as its row's last cell: activate or disable, and the reason a disable asks for. */
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
    <RowActionsCell expanded={open || !!(activate.error ?? disable.error)}>
      <RowActions>
        {profile.active ? (
          <Button type="button" variant="danger" size="sm" onClick={() => setOpen(!open)}>
            Disable {profile.code}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={activate.isPending} onClick={() => activate.mutate()}>
            Activate {profile.code}
          </Button>
        )}
      </RowActions>
      <Refusal error={activate.error ?? disable.error} />
      {open && (
        <form
          className="mt-3 flex flex-col items-start gap-3"
          aria-label={`Disable ${profile.code}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            disable.mutate();
          }}
        >
          <FormField>
            Reason
            <Textarea required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <Hint>New runs stop. A run under way finishes, and punches already made stay on record.</Hint>
          <Button type="submit" disabled={disable.isPending || !reason.trim()}>
            Confirm disable
          </Button>
        </form>
      )}
    </RowActionsCell>
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
          <Table aria-label="Profiles">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Time zone</TableHead>
                <TableHead scope="col">Lookback</TableHead>
                <TableHead scope="col">Synced until</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.data.items.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.code}</TableCell>
                  <TableCell>{p.name}</TableCell>
                  <TableCell>{p.providerTimezone}</TableCell>
                  <TableCell>{p.lookbackMinutes} minutes</TableCell>
                  <TableCell>{formatInstant(p.syncedUntil)}</TableCell>
                  <TableCell>
                    <Badge tone={p.active ? 'good' : 'neutral'}>{p.active ? 'Active' : 'Disabled'}</Badge>
                  </TableCell>
                  <ProfileActions key={p.version} profile={p} onChanged={refresh} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      <NewProfile onChanged={refresh} />
    </>
  );
}
