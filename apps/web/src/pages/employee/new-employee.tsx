// New employee: the draft record form, its fields grouped into steps with their progress above it (form-progress.tsx).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type EmployeeHit } from '../../api';
import { FormProgress } from '../../form-progress';
import { useSession } from '../../session';
import { Section } from '../../ui';
import { EmployeePicker, MasterSelect } from './choices';
import { Refusal } from './refusals';
import { EMPLOYEE_CREATE_PERSONAL, type EmployeeRecord, EMPLOYMENT_TYPES } from './shared';

// ---------------------------------------------------------------------------------------------------------
// New employee
// ---------------------------------------------------------------------------------------------------------

export function NewEmployeePage() {
  const { can } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    employeeCode: '',
    displayName: '',
    workEmail: '',
    workPhoneExtension: '',
    joiningDate: '',
    employmentType: '',
    departmentId: '',
    locationId: '',
    designationId: '',
    gradeId: '',
    dateOfBirth: '',
    serviceAnniversaryDate: '',
  });
  const [prior, setPrior] = useState<EmployeeHit | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const personal = can(EMPLOYEE_CREATE_PERSONAL);
  const create = useMutation({
    mutationFn: () =>
      api<EmployeeRecord>('/v1/employees', {
        body: {
          employeeCode: form.employeeCode.trim(),
          displayName: form.displayName.trim(),
          joiningDate: form.joiningDate,
          employmentType: form.employmentType,
          departmentId: form.departmentId,
          locationId: form.locationId,
          designationId: form.designationId,
          ...(form.workEmail.trim() ? { workEmail: form.workEmail.trim() } : {}),
          ...(form.workPhoneExtension.trim() ? { workPhoneExtension: form.workPhoneExtension.trim() } : {}),
          ...(form.gradeId ? { gradeId: form.gradeId } : {}),
          ...(personal && form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
          ...(personal && form.serviceAnniversaryDate ? { serviceAnniversaryDate: form.serviceAnniversaryDate } : {}),
          ...(prior ? { priorEmployeeId: prior.id } : {}),
        },
      }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['employees'] });
      navigate(`/employees/${created.id}`);
    },
  });
  // The fields keep their order, labels and checks; they are only grouped, and the steps above the form follow the groups.
  return (
    <>
      <FormProgress form={formRef} label="New employee" />
      <Section title="New employee">
        <form
          ref={formRef}
          className="grid-form"
          aria-label="New employee"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <fieldset className="form-step">
            <legend>Identity and contact</legend>
            <label>
              Employee code
              <input required value={form.employeeCode} onChange={(e) => set({ employeeCode: e.target.value })} />
            </label>
            <label>
              Name
              <input required maxLength={200} value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} />
            </label>
            <label>
              Work email
              <input type="email" maxLength={254} value={form.workEmail} onChange={(e) => set({ workEmail: e.target.value })} />
            </label>
            <label>
              Work phone extension
              <input inputMode="numeric" maxLength={20} value={form.workPhoneExtension} onChange={(e) => set({ workPhoneExtension: e.target.value })} />
            </label>
          </fieldset>
          <fieldset className="form-step">
            <legend>Employment terms</legend>
            <label>
              Joining date
              <input type="date" required value={form.joiningDate} onChange={(e) => set({ joiningDate: e.target.value })} />
            </label>
            <label>
              Employment type
              <select required value={form.employmentType} onChange={(e) => set({ employmentType: e.target.value })}>
                <option value="">Choose a type</option>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <fieldset className="form-step">
            <legend>Job assignment</legend>
            <MasterSelect kind="departments" label="Department" required value={form.departmentId} validOn={form.joiningDate} onChange={(departmentId) => set({ departmentId })} />
            <MasterSelect kind="locations" label="Location" required value={form.locationId} validOn={form.joiningDate} onChange={(locationId) => set({ locationId })} />
            <MasterSelect kind="designations" label="Designation" required value={form.designationId} validOn={form.joiningDate} onChange={(designationId) => set({ designationId })} />
            <MasterSelect kind="grades" label="Grade" value={form.gradeId} validOn={form.joiningDate} onChange={(gradeId) => set({ gradeId })} />
          </fieldset>
          {personal && (
            <fieldset className="form-step">
              <legend>Personal details</legend>
              <label>
                Date of birth
                <input type="date" value={form.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} />
              </label>
              <label>
                Service anniversary base date
                <input type="date" value={form.serviceAnniversaryDate} onChange={(e) => set({ serviceAnniversaryDate: e.target.value })} />
              </label>
            </fieldset>
          )}
          {/* Most new employees are new to the company: the link to an earlier employment is asked only when needed. */}
          <details className="wide form-more">
            <summary>Rehiring a former employee?</summary>
            <EmployeePicker label="Follows the ended employment of" value={prior} onChange={setPrior} filter={{ status: 'INACTIVE_SEPARATED' }} />
          </details>
          <p className="hint wide">A new employee starts as a draft. Activation, the manager and the shift are on their record, which opens once this is saved.</p>
          <div className="wide row">
            <button type="submit" disabled={create.isPending}>
              Create employee
            </button>
          </div>
          <div className="wide">
            <Refusal error={create.error} />
          </div>
        </form>
      </Section>
    </>
  );
}
