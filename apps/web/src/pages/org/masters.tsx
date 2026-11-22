// The four organisation masters (FR-004; BR-004; DF04; I-55): departments, locations, designations and grades, each a list with its
// state, an edit form opened on a row, deactivation and reactivation, and a form for a new one.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell, RowPanel } from '@/components/row-actions';
import { NothingChanged } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Notice, Section } from '../../ui';
import { ActiveBadge, KINDS, MASTER_CREATE, MASTER_UPDATE, type Master, type MasterKind, ONE_LINE, Refusal } from './shared';

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
      <FormGrid
        aria-label={`New ${noun}`}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
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
          Create {noun}
        </Button>
        <div className="col-span-full">
          <Refusal error={create.error} noun={noun} />
        </div>
      </FormGrid>
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
    <RowPanel asChild>
      <FormGrid
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
        <Button type="submit" aria-label={`Save ${master.code}`} disabled={save.isPending}>
          Save
        </Button>
        <div className="col-span-full">
          {unchanged && <NothingChanged />}
          <Refusal error={save.error} noun={noun} />
        </div>
      </FormGrid>
    </RowPanel>
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
    <TableRow>
      <TableCell className={ONE_LINE}>{master.code}</TableCell>
      <TableCell>{master.name}</TableCell>
      <TableCell className={ONE_LINE}>{formatDate(master.validFrom)}</TableCell>
      <TableCell className={ONE_LINE}>{formatDate(master.validTo)}</TableCell>
      <TableCell>
        <ActiveBadge active={master.active} />
      </TableCell>
      <RowActionsCell>
        {canUpdate && (
          <>
            <RowActions>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Edit ${master.code}`}
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
                variant={master.active ? 'danger' : 'outline'}
                size="sm"
                aria-label={`${master.active ? 'Deactivate' : 'Reactivate'} ${master.code}`}
                disabled={setActive.isPending}
                onClick={() => setActive.mutate()}
              >
                {master.active ? 'Deactivate' : 'Reactivate'}
              </Button>
            </RowActions>
            {setActive.error && (
              <RowPanel>
                <Refusal error={setActive.error} noun={noun} />
              </RowPanel>
            )}
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
      </RowActionsCell>
    </TableRow>
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
        <CheckField className="mb-3">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
        </CheckField>
        {notice && <Notice notice={{ text: notice, ok: true }} />}
        <ErrorNote error={list.error} />
        {list.isSuccess && items.length === 0 && <Empty>No {noun} to show.</Empty>}
        {items.length > 0 && (
          <Table aria-label={title}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">From</TableHead>
                <TableHead scope="col">Until</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((m) => (
                <MasterRow key={m.id} kind={kind} master={m} canUpdate={can(MASTER_UPDATE)} onChanged={refresh} onSaved={saved} />
              ))}
            </TableBody>
          </Table>
        )}
        <Hint>
          A {noun} is never deleted. Deactivating it or closing its period stops new use and history keeps it; neither is allowed while a live assignment would be left outside it. Until is the first day it no longer applies; a blank date leaves that side open.
        </Hint>
      </Section>
      {can(MASTER_CREATE) && <NewMaster kind={kind} onCreated={(code) => saved(`${code} created.`)} />}
    </>
  );
}

export const DepartmentsPage = () => <MasterPage kind="departments" />;
export const LocationsPage = () => <MasterPage kind="locations" />;
export const DesignationsPage = () => <MasterPage kind="designations" />;
export const GradesPage = () => <MasterPage kind="grades" />;
