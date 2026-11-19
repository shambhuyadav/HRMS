// The recruitment vendors screen: company-wide masters, deactivated, never deleted (BR-004).
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Section } from '../../ui';
import { LoadProblem, Refusal, VENDOR_WORDS } from './refusals';
import { CANDIDATE_MANAGE, CANDIDATE_READ, Denied, Done, enc, Problem, SCROLL, SR_ONLY, useKeys, useRefresh } from './shared';
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
      <p className="hint">A vendor is deactivated, never deleted: it keeps its history and its candidates, but new candidates cannot name it.</p>
      <label className="inline check">
        <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive vendors
      </label>
      {list.isPending && <p className="hint loading">Loading vendors…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view recruitment vendors." />
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {list.data && items.length === 0 && (
        <Empty>{`${includeInactive ? 'No vendors yet.' : 'No active vendors.'}${canManage ? ' Add one with the form below.' : ''}`}</Empty>
      )}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Vendors">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                {canManage && (
                  <th scope="col">
                    <span style={SR_ONLY}>Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <VendorRow key={v.id} vendor={v} canManage={canManage} onChanged={setNotice} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
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
      onChanged(body.active === undefined ? `Renamed ${saved.code} to ${saved.name}.` : `${saved.code} is now ${saved.active ? 'active' : 'inactive'}.`);
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
  return (
    <tr>
      <td>{v.code}</td>
      <td>
        {editing ? (
          <form className="row" onSubmit={rename} noValidate>
            <label>
              New name for {v.code}
              <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="submit" disabled={update.isPending}>
              Save name
            </button>
            <button
              type="button"
              className="secondary"
              disabled={update.isPending}
              onClick={() => {
                setEditing(false);
                setName(v.name);
                setProblem(null);
                update.reset();
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          v.name
        )}
      </td>
      <td>
        <Badge tone={v.active ? 'good' : 'neutral'}>{v.active ? 'active' : 'inactive'}</Badge>
      </td>
      {canManage && (
        <td>
          <div className="row">
            {!editing && (
              <button
                type="button"
                className="link"
                aria-label={`Rename ${v.code}`}
                onClick={() => {
                  // Start from the name shown now: the list may have been read again since this row first appeared.
                  setName(v.name);
                  setEditing(true);
                }}
              >
                Rename
              </button>
            )}
            <button
              type="button"
              className="link"
              disabled={update.isPending}
              aria-label={`${v.active ? 'Deactivate' : 'Reactivate'} ${v.code}`}
              onClick={() => update.mutate({ active: !v.active, expectedVersion: v.version })}
            >
              {v.active ? 'Deactivate' : 'Reactivate'}
            </button>
          </div>
          {problem && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
          <Refusal error={update.error} words={VENDOR_WORDS} />
        </td>
      )}
    </tr>
  );
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
    const missing = !code.trim() ? 'Enter the vendor’s code.' : !name.trim() ? 'Enter the vendor’s name.' : null;
    setProblem(missing);
    if (missing) {
      create.reset();
      return;
    }
    create.mutate({ code: code.trim(), name: name.trim() });
  };
  return (
    <Section title="Add a vendor">
      <form className="grid-form" aria-label="Add a vendor" onSubmit={submit} noValidate>
        <label>
          Code (required)
          <input required maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <label>
          Name (required)
          <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="hint wide">The code is stored in capitals and cannot change later.</p>
        <Problem text={problem} />
        {create.error && (
          <div className="wide">
            <Refusal error={create.error} words={VENDOR_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={create.isPending}>
            Add vendor
          </button>
        </div>
        {create.isSuccess && (
          <Done>
            Added {create.data.code} ({create.data.name}).
          </Done>
        )}
      </form>
    </Section>
  );
}

