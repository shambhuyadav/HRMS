// The employee mapping screen (FR-088): links between device identities and employees, ended or moved with a reason.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { CheckField, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, pageParams, Pager, Section } from '../../ui';
import { Refusal } from './refusals';
import { EMPLOYEE_LIST, type EmployeeLink, formatInstant, instantOf, type Paged, ProfilePicker } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Employee Mapping
// ---------------------------------------------------------------------------------------------------------

/** The employees a search found, one under another (the old `.choices` list). */
const CHOICE_LIST = 'm-0 flex list-none flex-col gap-[0.6rem] p-0';
/** One found employee: a full-width outline button, its words from the left and wrapping, tinted in the brand colour on hover. */
const CHOICE = 'h-auto w-full justify-start px-4 py-[0.8rem] text-left whitespace-normal hover:border-[var(--accent-bright)] hover:bg-[var(--accent-soft)]';
/** The picker's parts one under another, across the whole row of a form (or the whole width of a stacked one). */
const PICKER = 'col-span-full flex w-full flex-col gap-3';

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
  if (!canSearch) return <Hint>The selected role cannot search employees, so it cannot choose one here.</Hint>;
  return (
    <div className={PICKER}>
      <p className="m-0">
        Employee: <strong>{value ? personLabel(value) : 'nobody chosen yet'}</strong>
      </p>
      <FormField>
        Find the employee
        <Input type="search" maxLength={100} placeholder="Name, employee code or work email" value={search} onChange={(e) => setSearch(e.target.value)} />
      </FormField>
      <ErrorNote error={hits.error} />
      {term !== '' && hits.data?.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {term !== '' && hits.data && hits.data.items.length > 0 && (
        <ul className={CHOICE_LIST} aria-label="Matching employees">
          {hits.data.items.map((e) => (
            <li key={e.id}>
              <Button
                type="button"
                variant="outline"
                className={CHOICE}
                onClick={() => {
                  onChange(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {personLabel(e)}
              </Button>
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
      <FormGrid
        aria-label="New employee link"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormField>
          Device identity
          <Input required maxLength={100} value={key} onChange={(e) => setKey(e.target.value)} />
        </FormField>
        <FormField>
          From
          <Input required type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField>
          Until (optional)
          <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
        <EmployeePicker value={employee} onChange={setEmployee} />
        <Button type="submit" disabled={create.isPending || !employee}>
          Add link
        </Button>
      </FormGrid>
      <Refusal error={create.error} />
    </Section>
  );
}

/** A link's actions, as its row's last cell: end it or move it to another employee, with a reason. */
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
  if (!link.current) return <RowActionsCell />;
  return (
    <RowActionsCell expanded={open !== null || !!(end.error ?? move.error)}>
      <RowActions>
        <Button type="button" variant="danger" size="sm" onClick={() => toggle('end')}>
          End {link.externalEmployeeKey}
        </Button>{' '}
        <Button type="button" variant="outline" size="sm" onClick={() => toggle('move')}>
          Move {link.externalEmployeeKey}
        </Button>
      </RowActions>
      <Refusal error={end.error ?? move.error} />
      {open && (
        <form
          className="mt-3 flex flex-col items-start gap-3"
          aria-label={`${open === 'end' ? 'End' : 'Move'} ${link.externalEmployeeKey}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (open === 'end') end.mutate();
            else move.mutate();
          }}
        >
          {open === 'move' && <EmployeePicker value={employee} onChange={setEmployee} />}
          <FormField>
            {open === 'end' ? 'Ends at' : 'New employee from'}
            <Input required type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </FormField>
          <FormField>
            Reason
            <Textarea required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <Hint>Punches already made under this link stay as they are. This affects later fetches and reprocessing only.</Hint>
          <Button type="submit" disabled={end.isPending || move.isPending || !reason.trim() || (open === 'move' && !employee)}>
            {open === 'end' ? 'Confirm end' : 'Confirm move'}
          </Button>
        </form>
      )}
    </RowActionsCell>
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
        <FilterBar>
          <ProfilePicker
            value={profileId}
            anyLabel="Choose a profile…"
            onChange={(id) => {
              setProfileId(id);
              setPage(1);
            }}
          />
          <FormField>
            Search
            <Input
              type="search"
              maxLength={100}
              placeholder="Device identity, name or employee code"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </FormField>
          <CheckField>
            <input
              type="checkbox"
              checked={currentOnly}
              onChange={(e) => {
                setCurrentOnly(e.target.checked);
                setPage(1);
              }}
            />{' '}
            In force now only
          </CheckField>
        </FilterBar>
        <ErrorNote error={links.error} />
        {links.data?.items.length === 0 && <Empty>No links match.</Empty>}
        {links.data && links.data.items.length > 0 && (
          <>
            <Table aria-label="Employee links">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Device identity</TableHead>
                  <TableHead scope="col">Employee</TableHead>
                  <TableHead scope="col">From</TableHead>
                  <TableHead scope="col">Until</TableHead>
                  <TableHead scope="col">State</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.data.items.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>{l.externalEmployeeKey}</TableCell>
                    <TableCell>{`${l.employeeName} (${l.employeeCode})`}</TableCell>
                    <TableCell>{formatInstant(l.effectiveFrom)}</TableCell>
                    <TableCell>{formatInstant(l.effectiveTo)}</TableCell>
                    <TableCell>
                      <Badge tone={l.current ? 'good' : 'neutral'}>{l.current ? 'In force' : 'Not in force'}</Badge>
                    </TableCell>
                    <LinkActions key={l.version} link={l} onChanged={refresh} />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager page={links.data.page} pageSize={LIST_PAGE_SIZE} total={links.data.total} onPage={setPage} label="Employee link pages" noun="link" />
          </>
        )}
      </Section>
      {profileId !== '' && <NewLink key={profileId} profileId={profileId} onChanged={refresh} />}
    </>
  );
}
