// The requisition form (FR-011 fields): a new draft, or the requester's draft being changed.
import { type FormEvent, type RefObject, useId, useState } from 'react';
import { ErrorNote } from '../../ui';
// The form's groups (fieldset.form-step) are laid out there, wherever the form is shown.
import '../../styles/form-progress.css';
import { HiringManagerField, MasterSelect, useMasterOptions } from './lookups';
import { EMPLOYMENT_TYPE_CODE, EMPLOYMENT_TYPE_SUGGESTIONS, GROUP, H3, parseSkills, type RequisitionDetail, type RequisitionInput, SPACED, TEXTAREA, wholeNumber } from './shared';

// ---------------------------------------------------------------------------------------------------------
// The requisition form (FR-011 fields): a new draft, or the requester's draft being changed
// ---------------------------------------------------------------------------------------------------------

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
    const missing = !title.trim()
      ? 'Enter the position title.'
      : !departmentId
        ? 'Choose the department.'
        : !locationId
          ? 'Choose the location.'
          : !designationId
            ? 'Choose the designation.'
            : !EMPLOYMENT_TYPE_CODE.test(code)
              ? 'Enter the employment type code, for example PERMANENT.'
              : !wholeNumber(count, 1)
                ? 'Enter the number of vacancies as a whole number of at least 1.'
                : reasonType === ''
                  ? 'Choose whether the position is new or a replacement.'
                  : !reason.trim()
                    ? 'Enter the reason for the requisition.'
                    : list.length > 50
                      ? 'List at most 50 skills.'
                      : list.some((s) => s.length > 100)
                        ? 'A skill is at most 100 characters.'
                        : !targetDate
                          ? 'Enter the target date.'
                          : !hiringManagerId
                            ? 'Choose the hiring manager.'
                            : null;
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
    <form ref={formRef} className="grid-form" aria-label={initial ? `Edit draft ${initial.code}` : 'New requisition'} onSubmit={submit} noValidate>
      <fieldset className="form-step">
        <legend>The position</legend>
        <label className="wide">
          Position title
          <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        {!masters.fromOrg && (
          <p className="hint wide">
            The selected role cannot list the company’s departments, locations and designations, so the choices come from your team and the requisitions you can see.
          </p>
        )}
        <MasterSelect label="Department" value={departmentId} options={masters.options.departments} loading={masters.loading} onChange={setDepartmentId} />
        <MasterSelect label="Location" value={locationId} options={masters.options.locations} loading={masters.loading} onChange={setLocationId} />
        <MasterSelect label="Designation" value={designationId} options={masters.options.designations} loading={masters.loading} onChange={setDesignationId} />
        {masters.error ? (
          <div className="wide">
            <ErrorNote error={masters.error} />
          </div>
        ) : null}
        <label>
          Employment type
          <input required list={typesId} maxLength={60} value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} />
        </label>
        {/* Outside the label, so the suggestions do not become part of the field's name. */}
        <datalist id={typesId}>
          {EMPLOYMENT_TYPE_SUGGESTIONS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </datalist>
        <label>
          Vacancies
          <input type="number" required min={1} step={1} inputMode="numeric" value={vacancies} onChange={(e) => setVacancies(e.target.value)} />
        </label>
        <label>
          Target date
          <input type="date" required value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </label>
      </fieldset>
      <fieldset className="form-step">
        <legend>Why it is needed</legend>
        <fieldset className="wide" style={GROUP}>
          <legend>New or replacement</legend>
          <div className="row">
            <label className="check">
              <input type="radio" name={`${id}-reason-type`} value="NEW" required checked={reasonType === 'NEW'} onChange={() => setReasonType('NEW')} /> New position
            </label>
            <label className="check">
              <input type="radio" name={`${id}-reason-type`} value="REPLACEMENT" required checked={reasonType === 'REPLACEMENT'} onChange={() => setReasonType('REPLACEMENT')} />{' '}
              Replacement
            </label>
          </div>
        </fieldset>
        <label className="wide">
          Reason for the requisition
          <textarea required maxLength={2000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        <label className="wide">
          Skills (one per line, or separated by commas)
          <textarea maxLength={5200} rows={3} value={skills} onChange={(e) => setSkills(e.target.value)} style={TEXTAREA} />
        </label>
      </fieldset>
      <fieldset className="form-step">
        <legend>Hiring manager and budget</legend>
        <HiringManagerField value={hiringManagerId} current={initial?.hiringManager ?? null} onChange={setHiringManagerId} />
        <label className="wide">
          Budget exception reason
          <textarea maxLength={2000} rows={2} value={exception} aria-describedby={exceptionHint} onChange={(e) => setException(e.target.value)} style={TEXTAREA} />
        </label>
        <p className="hint wide" id={exceptionHint}>
          {exceeds
            ? 'Required to submit: this requisition exceeds its approved budget or has none. The HR approver approves the exception explicitly.'
            : 'Needed only when the requisition exceeds its approved budget or no budget covers it; the budget check is shown once the draft is saved.'}
        </p>
      </fieldset>
      {problem && (
        <p role="alert" className="error wide">
          {problem}
        </p>
      )}
      <div className="wide row">
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
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
    <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate style={SPACED}>
      <h3 id={`${id}-title`} className="wide" style={H3}>
        {title}
      </h3>
      <label className="wide">
        {label}
        <textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      <p className="hint wide">{hint}</p>
      {problem && (
        <p role="alert" className="error wide">
          {problem}
        </p>
      )}
      <div className="wide row">
        <button type="submit" className="danger" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

