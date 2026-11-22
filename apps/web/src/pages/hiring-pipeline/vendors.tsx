// The recruitment vendors screen: company-wide masters, deactivated, never deleted (BR-004).
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ButtonRow, CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Section } from '../../ui';
import { LoadProblem, Refusal, VENDOR_WORDS } from './refusals';
import { CANDIDATE_MANAGE, CANDIDATE_READ, Denied, enc, Notice, Problem, useKeys, useRefresh } from './shared';
import type { Vendor } from './types';

// ---------------------------------------------------------------------------------------------------------
// Hiring / Masters / Vendor: company-wide masters, deactivated, never deleted (BR-004)
// ---------------------------------------------------------------------------------------------------------

export function VendorsScreen() {
  const { can } = useSession();
  if (!can(CANDIDATE_READ)) return <Denied title="Recruitment vendors">The selected role cannot view recruitment vendors.</Denied>;
  return (
    <>
      <h1>Recruitment vendors</h1>
      <VendorList />
      {can(CANDIDATE_MANAGE) && <NewVendorForm />}
    </>
  );
}

export function useActiveVendors(enabled: boolean) {
  const keys = useKeys();
  return useQuery({ queryKey: keys.vendors(false), enabled, queryFn: () => api<{ items: Vendor[] }>('/v1/hiring/vendors'), retry: retryTransient });
}

function VendorList() {
  const { can } = useSession();
  const keys = useKeys();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery({
    queryKey: keys.vendors(includeInactive),
    queryFn: () => api<{ items: Vendor[] }>(`/v1/hiring/vendors${includeInactive ? '?includeInactive=true' : ''}`),
    retry: retryTransient,
  });
  const canManage = can(CANDIDATE_MANAGE);
  const items = list.data?.items ?? [];
  return (
    <Section title="Vendors">
      <Hint>A vendor is deactivated, never deleted: it keeps its history and its candidates, but new candidates cannot name it.</Hint>
      <CheckField>
        <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive vendors
      </CheckField>
      {list.isPending && <LoadingLine>Loading vendors…</LoadingLine>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view recruitment vendors." />
      <Notice text={notice} />
      {list.data && items.length === 0 && (
        <Empty>{`${includeInactive ? 'No vendors yet.' : 'No active vendors.'}${canManage ? ' Add one with the form below.' : ''}`}</Empty>
      )}
      {items.length > 0 && (
        <Table aria-label="Vendors">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Status</TableHead>
              {canManage && (
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((v) => (
              <VendorRow key={v.id} vendor={v} canManage={canManage} onChanged={setNotice} />
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

/** What a vendor change did, in words: a rename, or the vendor's new status. */
function changedText(saved: Vendor, statusChanged: boolean): string {
  if (!statusChanged) return `Renamed ${saved.code} to ${saved.name}.`;
  return `${saved.code} is now ${saved.active ? 'active' : 'inactive'}.`;
}

function VendorRow({ vendor: v, canManage, onChanged }: { vendor: Vendor; canManage: boolean; onChanged: (notice: string) => void }) {
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(v.name);
  const [problem, setProblem] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (body: { name?: string; active?: boolean; expectedVersion: number }) => api<Vendor>(`/v1/hiring/vendors/${enc(v.id)}`, { method: 'PATCH', body }),
    onSuccess: (saved, body) => {
      setEditing(false);
      setName(saved.name);
      setProblem(null);
      onChanged(changedText(saved, body.active !== undefined));
      refresh();
    },
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (update.isPending) return;
    const text = name.trim();
    setProblem(text ? null : 'Enter the vendor’s name.');
    if (!text) return;
    update.mutate({ name: text, expectedVersion: v.version });
  };
  // A refusal shown beside the row's buttons is free text: the cell then wraps it rather than keeping to the buttons' width.
  const refused = problem !== null || update.error !== null;
  return (
    <TableRow>
      <TableCell>{v.code}</TableCell>
      <TableCell>
        {editing ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={rename} noValidate>
            <FormField className="w-auto">
              New name for {v.code}
              <Input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <Button type="submit" disabled={update.isPending}>
              Save name
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={update.isPending}
              onClick={() => {
                setEditing(false);
                setName(v.name);
                setProblem(null);
                update.reset();
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          v.name
        )}
      </TableCell>
      <TableCell>
        <Badge tone={v.active ? 'good' : 'neutral'}>{v.active ? 'active' : 'inactive'}</Badge>
      </TableCell>
      {canManage && (
        <RowActionsCell expanded={refused}>
          <RowActions>
            {!editing && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Rename ${v.code}`}
                onClick={() => {
                  // Start from the name shown now: the list may have been read again since this row first appeared.
                  setName(v.name);
                  setEditing(true);
                }}
              >
                Rename
              </Button>
            )}
            <Button
              type="button"
              variant={v.active ? 'danger' : 'outline'}
              size="sm"
              disabled={update.isPending}
              aria-label={`${v.active ? 'Deactivate' : 'Reactivate'} ${v.code}`}
              onClick={() => update.mutate({ active: !v.active, expectedVersion: v.version })}
            >
              {v.active ? 'Deactivate' : 'Reactivate'}
            </Button>
          </RowActions>
          <Problem text={problem} />
          <Refusal error={update.error} words={VENDOR_WORDS} />
        </RowActionsCell>
      )}
    </TableRow>
  );
}

/** Required-field checks only; whether a code is free is the server's call. */
function vendorProblem(code: string, name: string): string | null {
  if (!code.trim()) return 'Enter the vendor’s code.';
  if (!name.trim()) return 'Enter the vendor’s name.';
  return null;
}

function NewVendorForm() {
  const refresh = useRefresh();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { code: string; name: string }) => api<Vendor>('/v1/hiring/vendors', { body }),
    onSuccess: () => {
      setCode('');
      setName('');
      setProblem(null);
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const missing = vendorProblem(code, name);
    setProblem(missing);
    if (missing) {
      create.reset();
      return;
    }
    create.mutate({ code: code.trim(), name: name.trim() });
  };
  return (
    <Section title="Add a vendor">
      <FormGrid aria-label="Add a vendor" onSubmit={submit} noValidate>
        <FormField>
          Code (required)
          <Input required maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />
        </FormField>
        <FormField>
          Name (required)
          <Input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <Hint>The code is stored in capitals and cannot change later.</Hint>
        <Problem text={problem} />
        {create.error && (
          <div className="col-span-full">
            <Refusal error={create.error} words={VENDOR_WORDS} />
          </div>
        )}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={create.isPending}>
            Add vendor
          </Button>
        </ButtonRow>
        {create.isSuccess && (
          <StatusNote tone="success" role="status">
            Added {create.data.code} ({create.data.name}).
          </StatusNote>
        )}
      </FormGrid>
    </Section>
  );
}
