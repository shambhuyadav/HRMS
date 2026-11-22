// The duplicate review screen (FR-013): a flag is reviewed by a person; confirming retires one record; nothing is merged.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, ChoiceRow, FilterBar, FormField, FormGrid, LabelledFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { api, formatDate, isConflict, isNotFound, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Section } from '../../ui';
import { FLAG_WORDS, LoadProblem, Refusal } from './refusals';
import { BASIS_LABEL, CANDIDATE_MANAGE, CANDIDATE_READ, CandidateLink, Denied, enc, FlagStateBadge, labelOf, LIMITS, Notice, Problem, useKeys, useRefresh } from './shared';
import type { DuplicateFlag } from './types';

// ---------------------------------------------------------------------------------------------------------
// FR-013 duplicate review: a flag is reviewed by a person; confirming retires one record; nothing is merged
// ---------------------------------------------------------------------------------------------------------

export function DuplicateReviewScreen() {
  const { can } = useSession();
  if (!can(CANDIDATE_READ)) return <Denied title="Duplicate review">The selected role cannot view the candidate register.</Denied>;
  return (
    <>
      <h1>Duplicate review</h1>
      <FlagQueue />
    </>
  );
}

const FLAG_FILTERS: readonly { value: string; label: string }[] = [
  { value: 'OPEN', label: 'Waiting for review' },
  { value: 'NOT_DUPLICATE', label: 'Not duplicates' },
  { value: 'CONFIRMED_DUPLICATE', label: 'Confirmed duplicates' },
  { value: '', label: 'All flags' },
];

function FlagQueue() {
  const keys = useKeys();
  const [state, setState] = useState('OPEN');
  // Kept here: a reviewed flag leaves the waiting list (and the list itself may go) once it reloads.
  const [notice, setNotice] = useState<string | null>(null);
  const flags = useQuery({
    queryKey: keys.flags(state),
    queryFn: () => api<{ items: DuplicateFlag[] }>(`/v1/hiring/duplicate-flags${state ? `?state=${state}` : ''}`),
    retry: retryTransient,
  });
  const items = flags.data?.items ?? [];
  return (
    <Section title="Likely matches">
      <Hint>
        A flag means two records share a private email address or phone number. A person reviews each flag and nothing is merged: confirming a duplicate retires
        the record you choose, which then takes no new applications; both records, their history and their applications are kept.
      </Hint>
      <FilterBar>
        <FormField>
          Show
          <NativeSelect value={state} onChange={(e) => setState(e.target.value)}>
            {FLAG_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </FilterBar>
      {flags.isPending && <LoadingLine>Loading flags…</LoadingLine>}
      <LoadProblem error={flags.error} forbidden="The selected role cannot view duplicate flags." />
      <Notice text={notice} />
      {flags.data && items.length === 0 && <Empty>{state === 'OPEN' ? 'No flags are waiting for review.' : 'No flags to show.'}</Empty>}
      {items.length > 0 && <FlagList flags={items} label="Duplicate flags" onResolved={setNotice} />}
      {items.length >= LIMITS.flags && <Hint>Showing the latest {LIMITS.flags} flags.</Hint>}
    </Section>
  );
}

export function FlagList({ flags, label, onResolved }: { flags: DuplicateFlag[]; label: string; onResolved: (notice: string) => void }) {
  return (
    <ul className="tasks" aria-label={label}>
      {flags.map((f) => (
        <FlagItem key={f.flagId} flag={f} onResolved={onResolved} />
      ))}
    </ul>
  );
}

type Resolution = '' | 'NOT_DUPLICATE' | 'CONFIRMED_DUPLICATE';

/** The review's required answers, checked before sending; whether they hold is the server's call. */
function reviewProblem(resolution: Resolution, retire: string, note: string): string | null {
  if (resolution === '') return 'Choose whether the two records are the same person.';
  if (resolution === 'CONFIRMED_DUPLICATE' && !retire) return 'Choose which of the two records is the duplicate to retire.';
  if (!note) return 'Enter a note on the review.';
  return null;
}

function FlagItem({ flag: f, onResolved }: { flag: DuplicateFlag; onResolved: (notice: string) => void }) {
  const { can } = useSession();
  const refresh = useRefresh();
  const id = useId();
  const [resolution, setResolution] = useState<Resolution>('');
  const [retire, setRetire] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const pair = `${f.candidate.candidateCode} and ${f.matchedCandidate.candidateCode}`;
  const resolve = useMutation({
    mutationFn: (body: { resolution: string; retireCandidateId?: string; note: string }) =>
      api<{ flagId: string; state: string; retiredCandidateId: string | null }>(`/v1/hiring/duplicate-flags/${enc(f.flagId)}/resolve`, { body }),
    onSuccess: (result) => {
      const retired = [f.candidate, f.matchedCandidate].find((c) => c.id === result.retiredCandidateId);
      onResolved(
        result.state === 'CONFIRMED_DUPLICATE'
          ? `Confirmed ${pair} as the same person: ${retired?.candidateCode ?? 'the chosen record'} is retired; nothing was merged.`
          : `Recorded ${pair} as different people.`,
      );
      setResolution('');
      setRetire('');
      setNote('');
      setProblem(null);
      refresh();
    },
    onError: (error) => {
      if (isConflict(error) || isNotFound(error)) refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (resolve.isPending) return;
    const text = note.trim();
    const missing = reviewProblem(resolution, retire, text);
    setProblem(missing);
    if (missing || resolution === '') {
      resolve.reset();
      return;
    }
    resolve.mutate({ resolution, ...(resolution === 'CONFIRMED_DUPLICATE' ? { retireCandidateId: retire } : {}), note: text });
  };
  const retiredRecord = [f.candidate, f.matchedCandidate].find((c) => c.id === f.retiredCandidateId);
  return (
    <li aria-labelledby={`${id}-title`}>
      <CardSubheading id={`${id}-title`}>
        {pair}: {labelOf(BASIS_LABEL, f.basis).toLowerCase()}
      </CardSubheading>
      <dl className="kv">
        <Item term="Record">
          <CandidateLink candidate={f.candidate} withState />
        </Item>
        <Item term="Matching record">
          <CandidateLink candidate={f.matchedCandidate} withState />
        </Item>
        <Item term="Flagged">{formatDate(f.flaggedAt)}</Item>
        <Item term="Review">
          <FlagStateBadge state={f.state} />
        </Item>
        {f.resolvedAt && <Item term="Reviewed">{formatDate(f.resolvedAt)}</Item>}
        {f.resolutionNote && <Item term="Review note">{f.resolutionNote}</Item>}
        {retiredRecord && <Item term="Retired record">{retiredRecord.candidateCode}</Item>}
      </dl>
      {f.state === 'OPEN' && can(CANDIDATE_MANAGE) && (
        <FormGrid aria-label={`Review ${pair}`} onSubmit={submit} noValidate>
          <LabelledFieldset legend="Are they the same person?">
            <ChoiceRow>
              <CheckField>
                <input type="radio" name={`${id}-resolution`} value="NOT_DUPLICATE" checked={resolution === 'NOT_DUPLICATE'} onChange={() => setResolution('NOT_DUPLICATE')} />{' '}
                No, different people
              </CheckField>
              <CheckField>
                <input
                  type="radio"
                  name={`${id}-resolution`}
                  value="CONFIRMED_DUPLICATE"
                  checked={resolution === 'CONFIRMED_DUPLICATE'}
                  onChange={() => setResolution('CONFIRMED_DUPLICATE')}
                />{' '}
                Yes, the same person
              </CheckField>
            </ChoiceRow>
          </LabelledFieldset>
          {resolution === 'CONFIRMED_DUPLICATE' && (
            <LabelledFieldset legend="Record to retire">
              <ChoiceRow>
                {[f.candidate, f.matchedCandidate].map((c) => (
                  <CheckField key={c.id}>
                    <input type="radio" name={`${id}-retire`} value={c.id} checked={retire === c.id} onChange={() => setRetire(c.id)} /> Retire {c.candidateCode} ({c.fullName})
                  </CheckField>
                ))}
              </ChoiceRow>
              <Hint>The retired record takes no new applications; nothing is merged, and its history and applications stay as they are.</Hint>
            </LabelledFieldset>
          )}
          <FormField className="col-span-full">
            Review note (required)
            <Textarea required maxLength={1000} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
          <Problem text={problem} />
          {resolve.error && (
            <div className="col-span-full">
              <Refusal error={resolve.error} words={FLAG_WORDS} />
            </div>
          )}
          <ButtonRow className="col-span-full">
            <Button type="submit" disabled={resolve.isPending}>
              Record review
            </Button>
          </ButtonRow>
        </FormGrid>
      )}
    </li>
  );
}
