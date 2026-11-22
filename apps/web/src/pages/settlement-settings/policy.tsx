// The settlement policy (FR-052; I-88): its revisions, the activation of a draft by someone other than its author, and a new draft
// revision, prefilled with the server's defaults.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { ButtonRow, FormField, FormGrid, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate, formatUnits, isConflict, localDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Notice, Section } from '../../ui';
import { labelOf, LoadProblem, RATE_BASIS_LABEL, Refusal, UserRef, when, type Words } from '../lifecycle-documents';
import {
  CAP,
  DATE,
  FIELD_GRID,
  FIELD_ROW,
  MAX_CODE,
  MAX_ENCASHABLE,
  POLICY_ACTIVATE,
  POLICY_MANAGE,
  POLICY_STATE_LABEL,
  POLICY_TONE,
  type PolicyDefaults,
  type PolicyList,
  type PolicyRevision,
  RATE_BASES,
  useSettingsKeys,
} from './shared';

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words
// ---------------------------------------------------------------------------------------------------------
/** The fields a refusal names (`details.field`), as the form labels them. */
const FIELD_LABEL: Record<string, string> = {
  effectiveFrom: 'the date it takes effect',
  basicComponentCode: 'the Basic component',
  daComponentCode: 'the DA component',
  encashmentComponentCode: 'the encashment component',
  noticeComponentCode: 'the notice recovery component',
  gratuityComponentCode: 'the gratuity component',
  encashmentDivisor: 'the encashment divisor',
  noticeDivisor: 'the notice recovery divisor',
  encashable: 'the encashable leave types',
};

const detail = (e: ApiError, key: string): unknown => (e.details as Record<string, unknown> | undefined)?.[key];
const capitalised = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const fieldOf = (e: ApiError) => {
  const field = detail(e, 'field');
  return typeof field === 'string' ? labelOf(FIELD_LABEL, field) : 'a field';
};
/** A refusal about one encashable leave type names its row (`details.index`, from 0). */
function atRow(e: ApiError, text: string): string {
  const index = detail(e, 'index');
  return typeof index === 'number' ? `Encashable leave type ${index + 1}: ${text}` : capitalised(text);
}
const codeIn = (e: ApiError, key: string) => {
  const value = detail(e, key);
  return typeof value === 'string' ? value : '';
};

const POLICY_WORDS: Words = {
  INVALID_DATE: 'Enter the date the revision takes effect as a valid date.',
  UNKNOWN_COMPONENT: (e) => `No active pay component has the code ${codeIn(e, 'componentCode') || 'given'} for ${fieldOf(e)}.`,
  COMPONENT_KIND_INVALID: (e) =>
    `${capitalised(fieldOf(e))} must be ${detail(e, 'field') === 'noticeComponentCode' ? 'a deduction' : 'an earning'}${codeIn(e, 'componentCode') ? `, and ${codeIn(e, 'componentCode')} is not` : ''}.`,
  BASIC_COMPONENT_REQUIRED: 'Name the pay component that stands for Basic.',
  DA_IS_BASIC: 'DA and Basic are different pay components: name another one for DA, or none.',
  UNKNOWN_LEAVE_TYPE: (e) => atRow(e, `no active leave type has the code ${codeIn(e, 'leaveType') || 'given'}.`),
  LEAVE_TYPE_NOT_PAID: (e) => atRow(e, `only a paid leave type is encashable${codeIn(e, 'leaveType') ? `, and ${codeIn(e, 'leaveType')} is unpaid` : ''}.`),
  INVALID_CAP: (e) => atRow(e, 'the cap is a number of units above zero, with up to 4 digits and 4 decimal places.'),
  DUPLICATE_LEAVE_TYPE: (e) => atRow(e, 'this leave type is already listed; each leave type appears once.'),
  ENCASHMENT_COMPONENT_REQUIRED: 'Name the earning component an encashment is paid on, or list no encashable leave type.',
  INVALID_DIVISOR: (e) => `${capitalised(fieldOf(e))} is a whole number of days from 1 to 31.`,
  INVALID_REQUEST:
    'Check the entries: codes have at most 40 characters, a divisor is a whole number from 1 to 31, a cap has up to 4 digits and 4 decimal places, and at most 50 leave types are encashable.',
  FORBIDDEN: 'The selected role cannot write settlement policy revisions: that needs the payroll configuration duty.',
};

const POLICY_ACTIVATE_WORDS: Words = {
  SELF_APPROVAL: 'A policy is activated by someone other than its author.',
  INVALID_STATE: 'Only a draft revision is activated, and this one is no longer a draft. The revisions have been reloaded.',
  STALE_VERSION: 'The revision changed after it was loaded. The revisions have been reloaded: check it and try again.',
  NOT_FOUND: 'This policy revision is not available.',
  FORBIDDEN: 'The selected role cannot activate settlement policy revisions: that needs the payroll configuration activation duty.',
};

// =========================================================================================================
// Settlement policy
// =========================================================================================================
const rateLabel = (basis: string) => labelOf(RATE_BASIS_LABEL, basis);
const encashableText = (items: PolicyRevision['encashable']) => (items.length === 0 ? 'None' : items.map((e) => `${e.leaveType} up to ${formatUnits(e.maxUnits)}`).join(', '));

export function PolicySection() {
  const { can } = useSession();
  const keys = useSettingsKeys();
  const list = useQuery({ queryKey: keys.policies, queryFn: () => api<PolicyList>('/v1/settlements/policies'), retry: retryTransient });
  const [notice, setNotice] = useState<string | null>(null);
  const data = list.data;
  return (
    <>
      <Section title="Settlement policy">
        <Hint>
          The pay components that stand for Basic and DA, the components an encashment, a notice recovery and a gratuity are paid or recovered on, the daily rate of
          encashment and of notice recovery (a monthly rate basis divided by a number of days), and the leave types that are encashable, each up to its cap. The revision
          in force on an employee’s last working date is the one their settlement is calculated under.
        </Hint>
        {data && (
          <Hint>
            {`Defaults for a field left out: encashment on ${rateLabel(data.defaults.encashmentRateBasis)} / ${data.defaults.encashmentDivisor}, notice recovery on ${rateLabel(
              data.defaults.noticeRateBasis,
            )} / ${data.defaults.noticeDivisor}, an encashable leave type capped at ${formatUnits(data.defaults.encashableMaxUnits)} units. No leave type is encashable unless listed.`}
          </Hint>
        )}
        <Notice notice={notice ? { text: notice, ok: true } : null} />
        {list.isPending && <LoadingLine>Loading the settlement policy…</LoadingLine>}
        <LoadProblem error={list.error} forbidden="The selected role cannot view the settlement policy." />
        {data && data.items.length === 0 && <Empty>No settlement policy revision yet: until one is active, the calculation shows encashment, notice recovery and gratuity as not configured.</Empty>}
        {data && data.items.length > 0 && <PolicyTable items={data.items} onNotice={setNotice} />}
      </Section>
      {data && can(POLICY_MANAGE) && <NewPolicyRevision data={data} onNotice={setNotice} />}
    </>
  );
}

function PolicyTable({ items, onNotice }: { items: readonly PolicyRevision[]; onNotice: (text: string) => void }) {
  const { can } = useSession();
  const activate = can(POLICY_ACTIVATE) && items.some((p) => p.state === 'DRAFT');
  return (
    <Table aria-label="Settlement policy revisions">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Revision</TableHead>
          <TableHead scope="col">From</TableHead>
          <TableHead scope="col">State</TableHead>
          <TableHead scope="col">Basic</TableHead>
          <TableHead scope="col">DA</TableHead>
          <TableHead scope="col">Encashment</TableHead>
          <TableHead scope="col">Encashable leave</TableHead>
          <TableHead scope="col">Notice recovery</TableHead>
          <TableHead scope="col">Gratuity</TableHead>
          <TableHead scope="col">Written by</TableHead>
          <TableHead scope="col">Activated</TableHead>
          {activate && (
            <TableHead scope="col">
              <span className="sr-only">Activate</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((p) => (
          <TableRow key={p.id}>
            <TableCell>{p.revision}</TableCell>
            <TableCell className="whitespace-nowrap">{formatDate(p.effectiveFrom)}</TableCell>
            <TableCell>
              <Badge tone={POLICY_TONE[p.state] ?? 'neutral'}>{labelOf(POLICY_STATE_LABEL, p.state)}</Badge>
            </TableCell>
            <TableCell>{p.basicComponentCode}</TableCell>
            <TableCell>{p.daComponentCode ?? '—'}</TableCell>
            <TableCell>{`${p.encashmentComponentCode ?? 'No component'}: ${rateLabel(p.encashmentRateBasis)} / ${p.encashmentDivisor}`}</TableCell>
            <TableCell>{encashableText(p.encashable)}</TableCell>
            <TableCell>{`${p.noticeComponentCode ?? 'No component'}: ${rateLabel(p.noticeRateBasis)} / ${p.noticeDivisor}`}</TableCell>
            <TableCell>{p.gratuityComponentCode ?? '—'}</TableCell>
            <TableCell>{p.createdBy ? <UserRef userId={p.createdBy} /> : '—'}</TableCell>
            <TableCell>
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
                '—'
              )}
            </TableCell>
            {activate && (p.state === 'DRAFT' ? <ActivatePolicyCell p={p} onNotice={onNotice} /> : <TableCell />)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** A DRAFT revision is activated against its version by someone other than its author: the row's last cell, with its button. */
function ActivatePolicyCell({ p, onNotice }: { p: PolicyRevision; onNotice: (text: string) => void }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const keys = useSettingsKeys();
  const author = !!me?.userId && me.userId === p.createdBy;
  const hintId = `${useId()}-author`;
  const activate = useMutation({
    mutationFn: () => api<PolicyRevision>(`/v1/settlements/policies/${encodeURIComponent(p.id)}/activate`, { body: { expectedVersion: p.version } }),
    onSuccess: (r) => {
      onNotice(`Revision ${r.revision} of the settlement policy is active from ${formatDate(r.effectiveFrom)}.`);
      void qc.invalidateQueries({ queryKey: keys.policies });
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: keys.policies });
    },
  });
  // The cell needs room for the note to the author or a refusal; with only its button it stays as narrow as the button.
  const saysMore = author || activate.error !== null;
  return (
    <RowActionsCell expanded={saysMore}>
      <div className="flex flex-col gap-3">
        <RowActions>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={activate.isPending || author}
            aria-describedby={author ? hintId : undefined}
            onClick={() => activate.mutate()}
          >
            {`Activate revision ${p.revision}`}
          </Button>
        </RowActions>
        {author && (
          <Hint as="span" id={hintId}>
            You wrote this revision, so someone else activates it.
          </Hint>
        )}
        <Refusal error={activate.error} words={POLICY_ACTIVATE_WORDS} noAnswer="No answer came back, so the revision may or may not have been activated. Reload the page to check." />
      </div>
    </RowActionsCell>
  );
}

interface EncashableRow {
  key: number;
  leaveType: string;
  maxUnits: string;
}

interface PolicyForm {
  effectiveFrom: string;
  basic: string;
  da: string;
  encashmentComponent: string;
  encashmentRateBasis: string;
  encashmentDivisor: string;
  encashable: EncashableRow[];
  noticeComponent: string;
  noticeRateBasis: string;
  noticeDivisor: string;
  gratuityComponent: string;
}

const blankForm = (d: PolicyDefaults): PolicyForm => ({
  effectiveFrom: localDate(),
  basic: '',
  da: '',
  encashmentComponent: '',
  encashmentRateBasis: d.encashmentRateBasis,
  encashmentDivisor: String(d.encashmentDivisor),
  encashable: [],
  noticeComponent: '',
  noticeRateBasis: d.noticeRateBasis,
  noticeDivisor: String(d.noticeDivisor),
  gratuityComponent: '',
});

const wholeDivisor = (text: string) => /^\d{1,2}$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 31;

/** POST /v1/settlements/policies: a new DRAFT revision, prefilled with the server's defaults; activated by someone else. */
function NewPolicyRevision({ data, onNotice }: { data: PolicyList; onNotice: (text: string) => void }) {
  const qc = useQueryClient();
  const keys = useSettingsKeys();
  const next = useRef(0);
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const values = form ?? blankForm(data.defaults);
  const bases = data.rateBases.length > 0 ? data.rateBases : RATE_BASES;
  const change = (patch: Partial<PolicyForm>) => setForm({ ...values, ...patch });
  const changeRow = (key: number, patch: Partial<EncashableRow>) => change({ encashable: values.encashable.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PolicyRevision>('/v1/settlements/policies', { body }),
    onSuccess: (r) => {
      setForm(null);
      onNotice(`Revision ${r.revision} written as a draft from ${formatDate(r.effectiveFrom)}. It is not in force until someone other than you activates it.`);
      void qc.invalidateQueries({ queryKey: keys.policies });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    const code = (text: string) => text.trim().toUpperCase();
    // Format checks only: components, kinds and leave types are the server's to check.
    let missing: string | null = null;
    if (!DATE.test(values.effectiveFrom)) missing = 'Enter the date the revision takes effect.';
    else if (!code(values.basic)) missing = 'Name the pay component that stands for Basic.';
    else if (!wholeDivisor(values.encashmentDivisor)) missing = 'The encashment divisor is a whole number of days from 1 to 31.';
    else if (!wholeDivisor(values.noticeDivisor)) missing = 'The notice recovery divisor is a whole number of days from 1 to 31.';
    else {
      values.encashable.forEach((r, i) => {
        if (missing !== null) return;
        if (!code(r.leaveType)) missing = `Encashable leave type ${i + 1}: enter the leave type code.`;
        else if (r.maxUnits.trim() && (!CAP.test(r.maxUnits.trim()) || Number(r.maxUnits) <= 0)) {
          missing = `Encashable leave type ${i + 1}: the cap is a number of units above zero, with up to 4 digits and 4 decimal places.`;
        }
      });
    }
    setProblem(missing);
    if (missing !== null) {
      save.reset();
      return;
    }
    const optional = (key: string, text: string) => (code(text) ? { [key]: code(text) } : {});
    save.mutate({
      effectiveFrom: values.effectiveFrom,
      basicComponentCode: code(values.basic),
      ...optional('daComponentCode', values.da),
      ...optional('encashmentComponentCode', values.encashmentComponent),
      encashmentRateBasis: values.encashmentRateBasis,
      encashmentDivisor: Number(values.encashmentDivisor),
      ...(values.encashable.length > 0
        ? { encashable: values.encashable.map((r) => ({ leaveType: code(r.leaveType), ...(r.maxUnits.trim() ? { maxUnits: r.maxUnits.trim() } : {}) })) }
        : {}),
      ...optional('noticeComponentCode', values.noticeComponent),
      noticeRateBasis: values.noticeRateBasis,
      noticeDivisor: Number(values.noticeDivisor),
      ...optional('gratuityComponentCode', values.gratuityComponent),
    });
  };
  const busy = save.isPending;
  const basisSelect = (label: string, value: string, onChange: (v: string) => void) => (
    <FormField>
      {label}
      <NativeSelect value={value} disabled={busy} onChange={(e) => onChange(e.target.value)}>
        {bases.map((b) => (
          <option key={b} value={b}>
            {rateLabel(b)}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
  return (
    <Section title="New revision">
      <FormGrid aria-label="New settlement policy revision" onSubmit={submit}>
        <Hint>
          A new revision is written as a draft and takes effect from its date once someone other than you activates it; an active revision of the same date is then
          superseded. Pay component and leave type codes are those of this company; the server checks them.
        </Hint>
        <FormField>
          Takes effect from
          <Input type="date" value={values.effectiveFrom} disabled={busy} onChange={(e) => change({ effectiveFrom: e.target.value })} />
        </FormField>
        <FormField>
          Basic component (required)
          <Input value={values.basic} maxLength={MAX_CODE} disabled={busy} onChange={(e) => change({ basic: e.target.value.toUpperCase() })} />
        </FormField>
        <FormField>
          DA component (optional)
          <Input value={values.da} maxLength={MAX_CODE} disabled={busy} onChange={(e) => change({ da: e.target.value.toUpperCase() })} />
        </FormField>
        <FramedFieldset legend="Leave encashment">
          <div className={FIELD_GRID}>
            <FormField>
              Encashment component (an earning)
              <Input value={values.encashmentComponent} maxLength={MAX_CODE} disabled={busy} onChange={(e) => change({ encashmentComponent: e.target.value.toUpperCase() })} />
            </FormField>
            {basisSelect('Encashment rate basis', values.encashmentRateBasis, (v) => change({ encashmentRateBasis: v }))}
            <FormField>
              Encashment divisor (days)
              <Input value={values.encashmentDivisor} inputMode="numeric" maxLength={2} disabled={busy} onChange={(e) => change({ encashmentDivisor: e.target.value })} />
            </FormField>
          </div>
          {values.encashable.length === 0 && <Hint>No leave type is encashable. Add one to make it encashable.</Hint>}
          {values.encashable.map((r, i) => (
            <div className={FIELD_ROW} key={r.key}>
              <FormField className="w-auto">
                {`Encashable leave type ${i + 1}`}
                <Input value={r.leaveType} maxLength={MAX_CODE} disabled={busy} onChange={(e) => changeRow(r.key, { leaveType: e.target.value.toUpperCase() })} />
              </FormField>
              <FormField className="w-auto">
                {`Cap of leave type ${i + 1} (units)`}
                <Input
                  value={r.maxUnits}
                  inputMode="decimal"
                  maxLength={9}
                  placeholder={formatUnits(data.defaults.encashableMaxUnits)}
                  disabled={busy}
                  onChange={(e) => changeRow(r.key, { maxUnits: e.target.value })}
                />
              </FormField>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                aria-label={`Remove encashable leave type ${i + 1}`}
                onClick={() => change({ encashable: values.encashable.filter((x) => x.key !== r.key) })}
              >
                Remove
              </Button>
            </div>
          ))}
          <ButtonRow>
            <Button
              type="button"
              variant="outline"
              disabled={busy || values.encashable.length >= MAX_ENCASHABLE}
              onClick={() => change({ encashable: [...values.encashable, { key: next.current++, leaveType: '', maxUnits: '' }] })}
            >
              Add an encashable leave type
            </Button>
          </ButtonRow>
          <Hint>{`A cap left blank is ${formatUnits(data.defaults.encashableMaxUnits)} units.`}</Hint>
        </FramedFieldset>
        <FramedFieldset legend="Notice recovery">
          <div className={FIELD_GRID}>
            <FormField>
              Notice recovery component (a deduction)
              <Input value={values.noticeComponent} maxLength={MAX_CODE} disabled={busy} onChange={(e) => change({ noticeComponent: e.target.value.toUpperCase() })} />
            </FormField>
            {basisSelect('Notice recovery rate basis', values.noticeRateBasis, (v) => change({ noticeRateBasis: v }))}
            <FormField>
              Notice recovery divisor (days)
              <Input value={values.noticeDivisor} inputMode="numeric" maxLength={2} disabled={busy} onChange={(e) => change({ noticeDivisor: e.target.value })} />
            </FormField>
          </div>
        </FramedFieldset>
        <FormField>
          Gratuity component (an earning)
          <Input value={values.gratuityComponent} maxLength={MAX_CODE} disabled={busy} onChange={(e) => change({ gratuityComponent: e.target.value.toUpperCase() })} />
        </FormField>
        {problem && <Notice notice={{ text: problem, ok: false }} />}
        <ButtonRow>
          <Button type="submit" disabled={busy}>
            Write the draft revision
          </Button>
        </ButtonRow>
        <Refusal
          error={save.error}
          words={POLICY_WORDS}
          noAnswer="No answer came back, so the revision may or may not have been written. Reload the page and check the revisions before trying again."
        />
      </FormGrid>
    </Section>
  );
}
