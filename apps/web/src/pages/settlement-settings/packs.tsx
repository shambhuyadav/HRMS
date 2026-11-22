// The statutory rule packs (I-88) as the settlement reads them: each pack's revisions, their validation by one authorised person and
// their activation by another.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError, formatDate, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Notice, Section } from '../../ui';
import { Item, labelOf, LoadProblem, PACK_STATE_LABEL, Refusal, UserRef, when, type Words } from '../lifecycle-documents';
import {
  ITEM_HEADING,
  MAX_REFERENCE,
  PACK_ACTIVATE,
  PACK_TONE,
  PACK_VALIDATE,
  type PackList,
  type PackRevision,
  READABLE_WIDTH,
  useSettingsKeys,
} from './shared';

const PACK_VALIDATE_WORDS: Words = {
  SOURCE_REQUIRED: `Record where the values were obtained (at most ${MAX_REFERENCE} characters).`,
  VALIDATION_REQUIRED: `Record how the values were validated for the jurisdiction and period (at most ${MAX_REFERENCE} characters).`,
  INVALID_STATE: 'Only an inactive draft is validated, and this revision is no longer one. The rule packs have been reloaded.',
  STALE_VERSION: 'The revision changed after it was loaded. The rule packs have been reloaded: check it and try again.',
  NOT_FOUND: 'This rule pack revision is not available.',
  FORBIDDEN: 'The selected role cannot validate statutory rule packs: that needs its own grant.',
};

const PACK_ACTIVATE_WORDS: Words = {
  SELF_APPROVAL: 'Activated by someone other than the person who wrote or validated it.',
  INVALID_STATE: 'Only a validated revision is activated, and this one is no longer waiting for activation. The rule packs have been reloaded.',
  STALE_VERSION: 'The revision changed after it was loaded. The rule packs have been reloaded: check it and try again.',
  NOT_FOUND: 'This rule pack revision is not available.',
  FORBIDDEN: 'The selected role cannot activate statutory rule packs: that needs its own grant.',
};

const numberIn = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/** A revision's parameters in plain words where the pack is known (GRATUITY), its JSON otherwise. */
function ParametersText({ pack: p }: { pack: PackRevision }) {
  const q = p.parameters ?? {};
  const wageDays = numberIn(q.wageDays);
  const divisor = numberIn(q.wageDivisor);
  const years = numberIn(q.minimumServiceYears);
  const partYear = numberIn(q.partYearMonthsOver);
  const ceiling = typeof q.ceilingAmount === 'string' ? q.ceilingAmount : null;
  const exempt = Array.isArray(q.exemptSeparationTypes) ? q.exemptSeparationTypes.filter((s): s is string => typeof s === 'string') : null;
  if (p.code === 'GRATUITY' && wageDays && divisor && years && partYear && ceiling && exempt) {
    return (
      <>
        {`${wageDays} days’ wages per counted year, a month’s wages / ${divisor}, ${years} years’ continuous service${exempt.length > 0 ? ` (none on ${exempt.join(', ')})` : ''}, a final part-year of more than ${partYear} months counts, ceiling ${ceiling} ${p.currencyCode}`}
      </>
    );
  }
  return <code>{JSON.stringify(q)}</code>;
}

export function PackSection() {
  const keys = useSettingsKeys();
  const list = useQuery({ queryKey: keys.packs, queryFn: () => api<PackList>('/v1/statutory-rule-packs'), retry: retryTransient });
  const [notice, setNotice] = useState<string | null>(null);
  const data = list.data;
  // Every pack this build knows, then any other code a revision carries.
  const codes = data ? [...new Set([...data.definitions.map((d) => d.code), ...data.items.map((p) => p.code)])] : [];
  const titleOf = (code: string) => data?.definitions.find((d) => d.code === code)?.title ?? code;
  return (
    <Section title="Statutory rule packs">
      <Hint>
        Each revision carries its parameters, its currency and the statute they come from. It starts as an inactive draft; one authorised person records where the values
        were obtained and how they were validated, and another activates it. The revision active on the last working date is the one used.
      </Hint>
      <Notice notice={notice ? { text: notice, ok: true } : null} />
      {list.isPending && <LoadingLine>Loading the statutory rule packs…</LoadingLine>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view the statutory rule packs." />
      {data && codes.length === 0 && <Empty>No statutory rule pack is known.</Empty>}
      {codes.map((code) => {
        const revisions = (data?.items ?? []).filter((p) => p.code === code);
        return (
          <div key={code}>
            <CardSubheading>
              {titleOf(code)} <Hint as="span">{code}</Hint>
            </CardSubheading>
            {revisions.length === 0 ? (
              <Empty>No revision yet.</Empty>
            ) : (
              <ul className="tasks" aria-label={`Revisions of ${code}`}>
                {revisions.map((p) => (
                  <PackItem key={p.id} p={p} onNotice={setNotice} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </Section>
  );
}

function PackItem({ p, onNotice }: { p: PackRevision; onNotice: (text: string) => void }) {
  const { can } = useSession();
  const titleId = `${useId()}-title`;
  return (
    <li aria-labelledby={titleId}>
      <h4 id={titleId} className={ITEM_HEADING}>
        {`${p.code} revision ${p.revision}, from ${formatDate(p.effectiveFrom)}`}
      </h4>
      <dl className="kv">
        <Item term="State">
          <Badge tone={PACK_TONE[p.state] ?? 'neutral'}>{labelOf(PACK_STATE_LABEL, p.state)}</Badge>
        </Item>
        <Item term="Currency">{p.currencyCode}</Item>
        <Item term="Parameters">
          <ParametersText pack={p} />
        </Item>
        <Item term="Statute reference">{p.statuteReference}</Item>
        <Item term="Source reference">{p.sourceReference ?? '—'}</Item>
        <Item term="Validation reference">{p.validationReference ?? '—'}</Item>
        <Item term="Written by">{p.createdBy ? <UserRef userId={p.createdBy} /> : '—'}</Item>
        <Item term="Validated">
          {p.validatedAt ? (
            <>
              {when(p.validatedAt)}
              {p.validatedBy && (
                <>
                  {' by '}
                  <UserRef userId={p.validatedBy} />
                </>
              )}
            </>
          ) : (
            'Not yet'
          )}
        </Item>
        <Item term="Activated">
          {p.activatedAt ? (
            <>
              {when(p.activatedAt)}
              {p.activatedBy && (
                <>
                  {' by '}
                  <UserRef userId={p.activatedBy} />
                </>
              )}
            </>
          ) : (
            'Not yet'
          )}
        </Item>
      </dl>
      {p.state === 'DRAFT' && can(PACK_VALIDATE) && <ValidatePack p={p} onNotice={onNotice} />}
      {p.state === 'VALIDATED' && can(PACK_ACTIVATE) && <ActivatePack p={p} onNotice={onNotice} />}
    </li>
  );
}

/** A DRAFT revision is validated: where its values were obtained and how they were checked, against its version. */
function ValidatePack({ p, onNotice }: { p: PackRevision; onNotice: (text: string) => void }) {
  const qc = useQueryClient();
  const keys = useSettingsKeys();
  const [source, setSource] = useState('');
  const [validation, setValidation] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const validate = useMutation({
    mutationFn: (body: { sourceReference: string; validationReference: string; expectedVersion: number }) =>
      api<PackRevision>(`/v1/statutory-rule-packs/${encodeURIComponent(p.id)}/validate`, { body }),
    onSuccess: (r) => {
      setSource('');
      setValidation('');
      onNotice(`${r.code} revision ${r.revision} is validated. It is used once someone other than its author and its validator activates it.`);
      void qc.invalidateQueries({ queryKey: keys.packs });
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: keys.packs });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (validate.isPending) return;
    const s = source.trim();
    const v = validation.trim();
    const missing = !s ? 'Record where the values were obtained.' : !v ? 'Record how the values were validated for the jurisdiction and period.' : null;
    setProblem(missing);
    if (missing !== null) {
      validate.reset();
      return;
    }
    validate.mutate({ sourceReference: s, validationReference: v, expectedVersion: p.version });
  };
  return (
    <form className="flex flex-col gap-3" aria-label={`Validate ${p.code} revision ${p.revision}`} onSubmit={submit}>
      <FormField className={READABLE_WIDTH}>
        Source reference: where the values were obtained (required)
        <Input value={source} maxLength={MAX_REFERENCE} disabled={validate.isPending} onChange={(e) => setSource(e.target.value)} />
      </FormField>
      <FormField className={READABLE_WIDTH}>
        Validation reference: how they were checked for the jurisdiction and period (required)
        <Input value={validation} maxLength={MAX_REFERENCE} disabled={validate.isPending} onChange={(e) => setValidation(e.target.value)} />
      </FormField>
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <ButtonRow>
        <Button type="submit" disabled={validate.isPending}>
          Record the validation
        </Button>
      </ButtonRow>
      <Refusal error={validate.error} words={PACK_VALIDATE_WORDS} noAnswer="No answer came back, so the validation may or may not have been recorded. Reload the page to check." />
    </form>
  );
}

/** A VALIDATED revision is activated against its version by someone who neither wrote nor validated it. */
function ActivatePack({ p, onNotice }: { p: PackRevision; onNotice: (text: string) => void }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const keys = useSettingsKeys();
  const involved = !!me?.userId && (me.userId === p.createdBy || me.userId === p.validatedBy);
  const hintId = `${useId()}-involved`;
  const activate = useMutation({
    mutationFn: () => api<PackRevision>(`/v1/statutory-rule-packs/${encodeURIComponent(p.id)}/activate`, { body: { expectedVersion: p.version } }),
    onSuccess: (r) => {
      onNotice(`${r.code} revision ${r.revision} is active from ${formatDate(r.effectiveFrom)}. A settlement calculated from now on uses it.`);
      void qc.invalidateQueries({ queryKey: keys.packs });
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: keys.packs });
    },
  });
  return (
    <div className="flex flex-col gap-3">
      {involved && <Hint id={hintId}>You wrote or validated this revision, so someone else activates it.</Hint>}
      <ButtonRow>
        <Button type="button" disabled={activate.isPending || involved} aria-describedby={involved ? hintId : undefined} onClick={() => activate.mutate()}>
          {`Activate ${p.code} revision ${p.revision}`}
        </Button>
      </ButtonRow>
      <Refusal error={activate.error} words={PACK_ACTIVATE_WORDS} noAnswer="No answer came back, so the revision may or may not have been activated. Reload the page to check." />
    </div>
  );
}
