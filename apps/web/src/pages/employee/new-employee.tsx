// New employee: the draft record form, its fields grouped into steps with their progress above it (form-progress.tsx).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ButtonRow, FormField, FormGrid, FormStep } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
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
        <FormGrid
          ref={formRef}
          aria-label="New employee"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <FormStep legend="Identity and contact">
            <FormField>
              Employee code
              <Input required value={form.employeeCode} onChange={(e) => set({ employeeCode: e.target.value })} />
            </FormField>
            <FormField>
              Name
              <Input required maxLength={200} value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} />
            </FormField>
            <FormField>
              Work email
              <Input type="email" maxLength={254} value={form.workEmail} onChange={(e) => set({ workEmail: e.target.value })} />
            </FormField>
            <FormField>
              Work phone extension
              <Input inputMode="numeric" maxLength={20} value={form.workPhoneExtension} onChange={(e) => set({ workPhoneExtension: e.target.value })} />
            </FormField>
          </FormStep>
          <FormStep legend="Employment terms">
            <FormField>
              Joining date
              <Input type="date" required value={form.joiningDate} onChange={(e) => set({ joiningDate: e.target.value })} />
            </FormField>
            <FormField>
              Employment type
              <NativeSelect required value={form.employmentType} onChange={(e) => set({ employmentType: e.target.value })}>
                <option value="">Choose a type</option>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </FormStep>
          <FormStep legend="Job assignment">
            <MasterSelect kind="departments" label="Department" required value={form.departmentId} validOn={form.joiningDate} onChange={(departmentId) => set({ departmentId })} />
            <MasterSelect kind="locations" label="Location" required value={form.locationId} validOn={form.joiningDate} onChange={(locationId) => set({ locationId })} />
            <MasterSelect kind="designations" label="Designation" required value={form.designationId} validOn={form.joiningDate} onChange={(designationId) => set({ designationId })} />
            <MasterSelect kind="grades" label="Grade" value={form.gradeId} validOn={form.joiningDate} onChange={(gradeId) => set({ gradeId })} />
          </FormStep>
          {personal && (
            <FormStep legend="Personal details">
              <FormField>
                Date of birth
                <Input type="date" value={form.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} />
              </FormField>
              <FormField>
                Service anniversary base date
                <Input type="date" value={form.serviceAnniversaryDate} onChange={(e) => set({ serviceAnniversaryDate: e.target.value })} />
              </FormField>
            </FormStep>
          )}
          {/* Most new employees are new to the company: the link to an earlier employment is asked only when needed. */}
          <details className="[&[open]>summary]:mb-[0.6rem]">
            <summary className="w-max cursor-pointer text-[0.86rem] font-semibold text-[var(--accent)] phone:py-3">Rehiring a former employee?</summary>
            <EmployeePicker label="Follows the ended employment of" value={prior} onChange={setPrior} filter={{ status: 'INACTIVE_SEPARATED' }} />
          </details>
          <Hint>A new employee starts as a draft. Activation, the manager and the shift are on their record, which opens once this is saved.</Hint>
          <ButtonRow className="col-span-full">
            <Button type="submit" disabled={create.isPending}>
              Create employee
            </Button>
          </ButtonRow>
          <div className="col-span-full">
            <Refusal error={create.error} />
          </div>
        </FormGrid>
      </Section>
    </>
  );
}
