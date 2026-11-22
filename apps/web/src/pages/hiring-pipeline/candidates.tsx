// The candidate register (FR-013): search, state and paging, the candidate fields, and registration.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { ButtonRow, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted, Section } from '../../ui';
import { CANDIDATE_WORDS, LoadProblem, Refusal } from './refusals';
import { CANDIDATE_MANAGE, CANDIDATE_READ, CandidateStateBadge, CONSENT_LABEL, CONSENTS, Denied, labelOf, PAGE_SIZE, parseSkills, PATHS, Problem, SOURCES, useKeys, useRefresh } from './shared';
import type { CandidatePage, CandidateView } from './types';
import { useActiveVendors } from './vendors';

// ---------------------------------------------------------------------------------------------------------
// FR-013 candidate register: search, state, paging and registration
// ---------------------------------------------------------------------------------------------------------

export function CandidatesScreen() {
  const { can } = useSession();
  const canRead = can(CANDIDATE_READ);
  const canManage = can(CANDIDATE_MANAGE);
  if (!canRead && !canManage) return <Denied title="Candidates">The selected role cannot view the candidate register.</Denied>;
  return (
    <>
      <h1>Candidates</h1>
      {canRead ? (
        <CandidateRegister />
      ) : (
        <Section title="Candidate register">
          <NotPermitted>The selected role cannot view the candidate register.</NotPermitted>
        </Section>
      )}
      {canManage && <NewCandidateForm />}
    </>
  );
}

const CANDIDATE_STATE_FILTERS: readonly { value: string; label: string }[] = [
  { value: '', label: 'All states' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'DUPLICATE', label: 'Retired duplicates' },
];

export function candidateListQuery(q: { term: string; state: string; page: number }): string {
  const p = new URLSearchParams();
  if (q.term) p.set('search', q.term);
  if (q.state) p.set('state', q.state);
  p.set('page', String(q.page));
  p.set('pageSize', String(PAGE_SIZE));
  return p.toString();
}

function CandidateRegister() {
  const keys = useKeys();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState({ term: '', state: '', page: 1 });
  const qs = candidateListQuery(query);
  const list = useQuery({ queryKey: keys.candidates(qs), queryFn: () => api<CandidatePage>(`/v1/hiring/candidates?${qs}`), retry: retryTransient });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Section title={`Candidate register${data ? ` (${data.total})` : ''}`}>
      <FilterBar asChild>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery((q) => ({ ...q, term: search.trim(), page: 1 }));
          }}
        >
          <FormField>
            Search code, name or skill
            <Input type="search" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
          </FormField>
          <FormField>
            State
            <NativeSelect value={query.state} onChange={(e) => setQuery((q) => ({ ...q, state: e.target.value, page: 1 }))}>
              {CANDIDATE_STATE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
      </FilterBar>
      {list.isPending && <LoadingLine>Loading candidates…</LoadingLine>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view the candidate register." />
      {data && data.items.length === 0 && <Empty>{query.term ? `No candidates match “${query.term}”.` : 'No candidates in the register.'}</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="Candidate register">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Source</TableHead>
              <TableHead scope="col">Skills</TableHead>
              <TableHead scope="col">Consent</TableHead>
              <TableHead scope="col">Retain until</TableHead>
              <TableHead scope="col">State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.candidateCode}</TableCell>
                <TableCell>
                  <Link to={PATHS.candidate(c.id)}>{c.fullName}</Link>
                </TableCell>
                <TableCell>
                  {c.source.label}
                  {c.vendor && (
                    <Hint as="span" className="block">
                      {` ${c.vendor.name} (${c.vendor.code})`}
                    </Hint>
                  )}
                </TableCell>
                <TableCell>{c.skills.length > 0 ? c.skills.join(', ') : '—'}</TableCell>
                <TableCell>
                  {labelOf(CONSENT_LABEL, c.consentStatus)}
                  {c.consentRecordedOn && (
                    <Hint as="span" className="block">
                      {` on ${formatDate(c.consentRecordedOn)}`}
                    </Hint>
                  )}
                </TableCell>
                <TableCell>{formatDate(c.retainUntil)}</TableCell>
                <TableCell>
                  <CandidateStateBadge state={c.state} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data && pages > 1 && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3 text-sm text-muted-foreground">
          <Button type="button" variant="outline" size="sm" disabled={query.page <= 1} onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))}>
            Previous
          </Button>
          <span className="tabular-nums">
            Page {query.page} of {pages}
          </span>
          <Button type="button" variant="outline" size="sm" disabled={query.page >= pages} onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))}>
            Next
          </Button>
        </div>
      )}
    </Section>
  );
}

/** The candidate fields as typed (strings); the API's body is built from them only when sending. */
export interface CandidateValues {
  fullName: string;
  sourceCode: string;
  vendorId: string;
  skills: string;
  consentStatus: string;
  consentRecordedOn: string;
  retainUntil: string;
  state: string;
}

export const CANDIDATE_FIELDS = ['fullName', 'sourceCode', 'vendorId', 'skills', 'consentStatus', 'consentRecordedOn', 'retainUntil', 'state'] as const;

const EMPTY_CANDIDATE: CandidateValues = {
  fullName: '',
  sourceCode: 'DIRECT',
  vendorId: '',
  skills: '',
  consentStatus: 'NOT_RECORDED',
  consentRecordedOn: '',
  retainUntil: '',
  state: 'ACTIVE',
};

export const candidateValues = (c: CandidateView): CandidateValues => ({
  fullName: c.fullName,
  sourceCode: c.source.code,
  vendorId: c.vendor?.id ?? '',
  skills: c.skills.join(', '),
  consentStatus: c.consentStatus,
  consentRecordedOn: c.consentRecordedOn ?? '',
  retainUntil: c.retainUntil ?? '',
  state: c.state,
});

/** Required-field checks only; whether a source, vendor or date is acceptable is the server's call. */
export function candidateProblem(v: CandidateValues): string | null {
  if (!v.fullName.trim()) return 'Enter the candidate’s full name.';
  if (v.sourceCode === 'VENDOR' && !v.vendorId) return 'Choose the recruitment vendor the candidate came through.';
  if (v.consentStatus !== 'NOT_RECORDED' && !v.consentRecordedOn) return 'Enter the date the consent was given or withdrawn.';
  const skills = parseSkills(v.skills);
  if (skills.length > 50) return 'List at most 50 skills.';
  if (skills.some((s) => s.length > 100)) return 'Keep each skill to 100 characters or fewer.';
  return null;
}

function newCandidateBody(v: CandidateValues): Record<string, unknown> {
  const skills = parseSkills(v.skills);
  return {
    fullName: v.fullName.trim(),
    sourceCode: v.sourceCode,
    ...(v.sourceCode === 'VENDOR' ? { vendorId: v.vendorId } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    consentStatus: v.consentStatus,
    ...(v.consentStatus !== 'NOT_RECORDED' ? { consentRecordedOn: v.consentRecordedOn } : {}),
    ...(v.retainUntil ? { retainUntil: v.retainUntil } : {}),
  };
}

/** Only what the user changed: a concurrent change to another field is kept (the server merges the patch). */
export function candidatePatch(original: CandidateValues, typed: CandidateValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (typed.fullName.trim() !== original.fullName.trim()) patch.fullName = typed.fullName.trim();
  if (typed.sourceCode !== original.sourceCode) patch.sourceCode = typed.sourceCode;
  // Leaving the vendor source drops the vendor on the server; a vendor source always names its vendor.
  if (typed.sourceCode === 'VENDOR' && (typed.sourceCode !== original.sourceCode || typed.vendorId !== original.vendorId)) patch.vendorId = typed.vendorId;
  if (parseSkills(typed.skills).join('\n') !== parseSkills(original.skills).join('\n')) patch.skills = parseSkills(typed.skills);
  if (typed.consentStatus !== original.consentStatus || typed.consentRecordedOn !== original.consentRecordedOn) {
    patch.consentStatus = typed.consentStatus;
    patch.consentRecordedOn = typed.consentStatus === 'NOT_RECORDED' ? null : typed.consentRecordedOn;
  }
  if (typed.retainUntil !== original.retainUntil) patch.retainUntil = typed.retainUntil || null;
  if (typed.state !== original.state) patch.state = typed.state;
  return patch;
}

export function CandidateFields({
  values: v,
  set,
  vendors,
  currentVendor,
  showState,
}: {
  values: CandidateValues;
  set: (patch: Partial<CandidateValues>) => void;
  vendors: ReturnType<typeof useActiveVendors>;
  currentVendor: { id: string; code: string; name: string } | null;
  showState: boolean;
}) {
  const active = vendors.data?.items ?? [];
  // A candidate's current vendor may be inactive now: it stays selectable for that candidate only.
  const options = currentVendor && !active.some((x) => x.id === currentVendor.id) ? [{ ...currentVendor, current: true }, ...active.map((x) => ({ ...x, current: false }))] : active.map((x) => ({ ...x, current: false }));
  return (
    <>
      <FormField>
        Full name (required)
        <Input required maxLength={200} value={v.fullName} onChange={(e) => set({ fullName: e.target.value })} />
      </FormField>
      <FormField>
        Source
        <NativeSelect value={v.sourceCode} onChange={(e) => set({ sourceCode: e.target.value, vendorId: '' })}>
          {SOURCES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      {v.sourceCode === 'VENDOR' && (
        <FormField>
          Recruitment vendor (required)
          <NativeSelect required value={v.vendorId} onChange={(e) => set({ vendorId: e.target.value })}>
            <option value="">{vendors.isLoading ? 'Loading vendors…' : 'Choose a vendor…'}</option>
            {options.map((x) => (
              <option key={x.id} value={x.id}>
                {`${x.name} (${x.code})${x.current ? ' (current)' : ''}`}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      )}
      {v.sourceCode === 'VENDOR' && vendors.data && options.length === 0 && (
        <Hint>
          No active vendors yet: add one under <Link to={PATHS.vendors}>Recruitment vendors</Link>.
        </Hint>
      )}
      {v.sourceCode === 'VENDOR' && vendors.error && (
        <div className="col-span-full">
          <LoadProblem error={vendors.error} forbidden="The selected role cannot list the recruitment vendors." />
        </div>
      )}
      <FormField className="col-span-full">
        Skills (separated by commas)
        <Input maxLength={5000} value={v.skills} onChange={(e) => set({ skills: e.target.value })} />
      </FormField>
      <FormField>
        Consent
        <NativeSelect value={v.consentStatus} onChange={(e) => set({ consentStatus: e.target.value, ...(e.target.value === 'NOT_RECORDED' ? { consentRecordedOn: '' } : {}) })}>
          {CONSENTS.map((c) => (
            <option key={c} value={c}>
              {labelOf(CONSENT_LABEL, c)}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      {v.consentStatus !== 'NOT_RECORDED' && (
        <FormField>
          {v.consentStatus === 'WITHDRAWN' ? 'Consent withdrawn on (required)' : 'Consent given on (required)'}
          <Input type="date" required value={v.consentRecordedOn} onChange={(e) => set({ consentRecordedOn: e.target.value })} />
        </FormField>
      )}
      <FormField>
        Retain until (optional)
        <Input type="date" value={v.retainUntil} onChange={(e) => set({ retainUntil: e.target.value })} />
      </FormField>
      {showState && (
        <FormField>
          Record state
          <NativeSelect value={v.state} onChange={(e) => set({ state: e.target.value })}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </NativeSelect>
        </FormField>
      )}
    </>
  );
}

function NewCandidateForm() {
  const { can } = useSession();
  const refresh = useRefresh();
  const [values, setValues] = useState<CandidateValues>(EMPTY_CANDIDATE);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<CandidateValues>) => setValues((v) => ({ ...v, ...patch }));
  const vendors = useActiveVendors(values.sourceCode === 'VENDOR' && can(CANDIDATE_READ));
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<CandidateView>('/v1/hiring/candidates', { body }),
    // A registered candidate starts the form clean; a refused one keeps what was typed.
    onSuccess: () => {
      setValues(EMPTY_CANDIDATE);
      setProblem(null);
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const missing = candidateProblem(values);
    setProblem(missing);
    if (missing) {
      create.reset();
      return;
    }
    create.mutate(newCandidateBody(values));
  };
  return (
    <Section title="Register a candidate">
      <FormGrid aria-label="Register a candidate" onSubmit={submit} noValidate>
        <CandidateFields values={values} set={set} vendors={vendors} currentVendor={null} showState={false} />
        <Hint>
          Private contacts and CVs are confidential: an eligible Admin records them on the candidate’s page. A likely duplicate is flagged for review, never merged.
        </Hint>
        <Problem text={problem} />
        {create.error && (
          <div className="col-span-full">
            <Refusal error={create.error} words={CANDIDATE_WORDS} />
          </div>
        )}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={create.isPending}>
            Register candidate
          </Button>
        </ButtonRow>
        {create.isSuccess && (
          <StatusNote tone="success" role="status">
            Registered {create.data.candidateCode}. <Link to={PATHS.candidate(create.data.id)}>Open {create.data.fullName}</Link>
          </StatusNote>
        )}
      </FormGrid>
    </Section>
  );
}

