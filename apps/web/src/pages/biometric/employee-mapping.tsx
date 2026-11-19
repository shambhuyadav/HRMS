// The employee mapping screen (FR-088): links between device identities and employees, ended or moved with a reason.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, pageParams, Pager, Section } from '../../ui';
import { Refusal } from './refusals';
import { EMPLOYEE_LIST, type EmployeeLink, formatInstant, instantOf, type Paged, ProfilePicker } from './shared';

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
                  <th scope="col"><span className="sr-only">Actions</span></th>
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
