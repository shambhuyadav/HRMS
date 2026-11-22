// The requisition form (FR-011 fields): a new draft, or the requester's draft being changed.
import { type FormEvent, type RefObject, useId, useState } from 'react';
import { ButtonRow, CheckField, FormField, FormGrid, FormStep } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ErrorNote, Notice } from '../../ui';
import { HiringManagerField, MasterSelect, useMasterOptions } from './lookups';
import { EMPLOYMENT_TYPE_CODE, EMPLOYMENT_TYPE_SUGGESTIONS, parseSkills, type RequisitionDetail, type RequisitionInput, wholeNumber } from './shared';

// ---------------------------------------------------------------------------------------------------------
// The requisition form (FR-011 fields): a new draft, or the requester's draft being changed
// ---------------------------------------------------------------------------------------------------------

/** The legend of a group of choices inside a step ("New or replacement"), in the old legend's size, weight and colour. */
const CHOICE_LEGEND = 'px-[0.35rem] text-[0.82rem] font-semibold text-foreground';
/** Radio buttons side by side, wrapping on a narrow screen. */
const OPTION_ROW = 'flex flex-wrap items-center gap-2';

/** What the form holds when it is sent, as its own checks read it (the code upper-cased, the skills split). */
interface TypedRequisition {
  title: string;
  departmentId: string;
  locationId: string;
  designationId: string;
  employmentTypeCode: string;
  vacancyCount: string;
  reasonType: '' | 'NEW' | 'REPLACEMENT';
  reason: string;
  skillList: string[];
  targetDate: string;
  hiringManagerId: string;
}

/** The first required field missing or malformed, in words; null when the form can be sent. */
function firstProblem(typed: TypedRequisition): string | null {
  if (!typed.title.trim()) return 'Enter the position title.';
  if (!typed.departmentId) return 'Choose the department.';
  if (!typed.locationId) return 'Choose the location.';
  if (!typed.designationId) return 'Choose the designation.';
  if (!EMPLOYMENT_TYPE_CODE.test(typed.employmentTypeCode)) return 'Enter the employment type code, for example PERMANENT.';
  if (!wholeNumber(typed.vacancyCount, 1)) return 'Enter the number of vacancies as a whole number of at least 1.';
  if (typed.reasonType === '') return 'Choose whether the position is new or a replacement.';
  if (!typed.reason.trim()) return 'Enter the reason for the requisition.';
  if (typed.skillList.length > 50) return 'List at most 50 skills.';
  if (typed.skillList.some((s) => s.length > 100)) return 'A skill is at most 100 characters.';
  if (!typed.targetDate) return 'Enter the target date.';
  if (!typed.hiringManagerId) return 'Choose the hiring manager.';
  return null;
}

export function RequisitionForm({
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
  formRef,
}: {
  initial: RequisitionDetail | null;
  /** Sending, or the requisition is reloading: nothing is sent meanwhile. */
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: RequisitionInput) => void;
  onCancel?: () => void;
  /** The form element, for a page that shows the form's progress beside it. */
  formRef?: RefObject<HTMLFormElement>;
}) {
  const id = useId();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [departmentId, setDepartmentId] = useState(initial?.department.id ?? '');
  const [locationId, setLocationId] = useState(initial?.location.id ?? '');
  const [designationId, setDesignationId] = useState(initial?.designation.id ?? '');
  const [employmentType, setEmploymentType] = useState(initial?.employmentType ?? '');
  const [vacancies, setVacancies] = useState(initial ? String(initial.vacancies) : '');
  const [reasonType, setReasonType] = useState<'' | 'NEW' | 'REPLACEMENT'>(initial?.reasonType === 'NEW' || initial?.reasonType === 'REPLACEMENT' ? initial.reasonType : '');
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [skills, setSkills] = useState(initial ? initial.skills.join('\n') : '');
  const [targetDate, setTargetDate] = useState(initial?.targetDate ?? '');
  const [hiringManagerId, setHiringManagerId] = useState(initial?.hiringManager.id ?? '');
  const [exception, setException] = useState(initial?.budgetExceptionReason ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const masters = useMasterOptions(initial);
  const exceeds = initial?.budgetCheck ? initial.budgetCheck.budgetStatus !== 'WITHIN_BUDGET' : false;

  // Required-field and format checks only; whether the values are acceptable (active masters, an active hiring
  // manager, the budget) is the server's call.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = employmentType.trim().toUpperCase();
    const count = vacancies.trim();
    const list = parseSkills(skills);
    const missing = firstProblem({
      title,
      departmentId,
      locationId,
      designationId,
      employmentTypeCode: code,
      vacancyCount: count,
      reasonType,
      reason,
      skillList: list,
      targetDate,
      hiringManagerId,
    });
    setProblem(missing);
    if (missing !== null || reasonType === '' || busy) return;
    onSubmit({
      title: title.trim(),
      departmentId,
      locationId,
      designationId,
      employmentType: code,
      vacancies: Number(count),
      reasonType,
      reason: reason.trim(),
      skills: list,
      targetDate,
      hiringManagerId,
      budgetExceptionReason: exception.trim() || null,
    });
  };

  const typesId = `${id}-types`;
  const exceptionHint = `${id}-exception`;
  // The fields keep their order, labels and checks; they are only grouped, so a page can show the groups as steps (form-progress.tsx).
  return (
    <FormGrid ref={formRef} aria-label={initial ? `Edit draft ${initial.code}` : 'New requisition'} onSubmit={submit} noValidate>
      <FormStep legend="The position">
        <FormField className="col-span-full">
          Position title
          <Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        {!masters.fromOrg && (
          <Hint>The selected role cannot list the company’s departments, locations and designations, so the choices come from your team and the requisitions you can see.</Hint>
        )}
        <MasterSelect label="Department" value={departmentId} options={masters.options.departments} loading={masters.loading} onChange={setDepartmentId} />
        <MasterSelect label="Location" value={locationId} options={masters.options.locations} loading={masters.loading} onChange={setLocationId} />
        <MasterSelect label="Designation" value={designationId} options={masters.options.designations} loading={masters.loading} onChange={setDesignationId} />
        {masters.error ? (
          <div className="col-span-full">
            <ErrorNote error={masters.error} />
          </div>
        ) : null}
        <FormField>
          Employment type
          <Input required list={typesId} maxLength={60} value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} />
        </FormField>
        {/* Outside the label, so the suggestions do not become part of the field's name. */}
        <datalist id={typesId}>
          {EMPLOYMENT_TYPE_SUGGESTIONS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </datalist>
        <FormField>
          Vacancies
          <Input type="number" required min={1} step={1} inputMode="numeric" value={vacancies} onChange={(e) => setVacancies(e.target.value)} />
        </FormField>
        <FormField>
          Target date
          <Input type="date" required value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </FormField>
      </FormStep>
      <FormStep legend="Why it is needed">
        <FieldSet className="col-span-full gap-[0.55rem]">
          <legend className={CHOICE_LEGEND}>New or replacement</legend>
          <div className={OPTION_ROW}>
            <CheckField>
              <input type="radio" name={`${id}-reason-type`} value="NEW" required checked={reasonType === 'NEW'} onChange={() => setReasonType('NEW')} /> New position
            </CheckField>
            <CheckField>
              <input type="radio" name={`${id}-reason-type`} value="REPLACEMENT" required checked={reasonType === 'REPLACEMENT'} onChange={() => setReasonType('REPLACEMENT')} />{' '}
              Replacement
            </CheckField>
          </div>
        </FieldSet>
        <FormField className="col-span-full">
          Reason for the requisition
          <Textarea required maxLength={2000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <FormField className="col-span-full">
          Skills (one per line, or separated by commas)
          <Textarea maxLength={5200} rows={3} value={skills} onChange={(e) => setSkills(e.target.value)} />
        </FormField>
      </FormStep>
      <FormStep legend="Hiring manager and budget">
        <HiringManagerField value={hiringManagerId} current={initial?.hiringManager ?? null} onChange={setHiringManagerId} />
        <FormField className="col-span-full">
          Budget exception reason
          <Textarea maxLength={2000} rows={2} value={exception} aria-describedby={exceptionHint} onChange={(e) => setException(e.target.value)} />
        </FormField>
        <Hint id={exceptionHint}>
          {exceeds
            ? 'Required to submit: this requisition exceeds its approved budget or has none. The HR approver approves the exception explicitly.'
            : 'Needed only when the requisition exceeds its approved budget or no budget covers it; the budget check is shown once the draft is saved.'}
        </Hint>
      </FormStep>
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <ButtonRow className="col-span-full">
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </ButtonRow>
    </FormGrid>
  );
}

/** A reason-only form (discarding a draft, closing a requisition); it stays filled in after a refusal. */
export function ReasonForm({
  title,
  label,
  hint,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  hint: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    setProblem(text ? null : 'Enter a reason.');
    if (!text || busy) return;
    onSubmit(text);
  };
  return (
    <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
      <h3 id={`${id}-title`} className="text-[1rem]">
        {title}
      </h3>
      <FormField className="col-span-full">
        {label}
        <Textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <Hint>{hint}</Hint>
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <ButtonRow className="col-span-full">
        <Button type="submit" variant="danger" disabled={busy}>
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </ButtonRow>
    </FormGrid>
  );
}
