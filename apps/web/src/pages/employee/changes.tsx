// Changes to one employee: edits, activation, manager, transfer, shift, joining date and closing a draft.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Action, ActionBar } from '@/components/action-bar';
import { CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { NothingChanged } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { api, ApiError, type EmployeeHit } from '../../api';
import { useSession } from '../../session';
import { ErrorNote, Section } from '../../ui';
import { EmployeePicker, MasterSelect } from './choices';
import { Refusal } from './refusals';
import { EMPLOYEE_DEACTIVATE, EMPLOYEE_UPDATE, EMPLOYEE_UPDATE_PERSONAL, type EmployeeRecord, enc, SHIFT_ASSIGN, SHIFT_READ, type ShiftOption } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Changes to one employee
// ---------------------------------------------------------------------------------------------------------

interface FormProps {
  employee: EmployeeRecord;
  /** A successful change: its words are shown on the record, which is read again. */
  onSaved: (message: string) => void;
  /** The record changed underneath: read it again, leaving what was typed in place. */
  onConflict: () => void;
}

const reloadOnConflict = (onConflict: () => void) => (err: unknown) => {
  if (err instanceof ApiError && (err.code === 'STALE_VERSION' || err.code === 'INVALID_STATE')) onConflict();
};

function EditForm({ employee, onSaved, onConflict, close }: FormProps & { close: () => void }) {
  const { can } = useSession();
  const operational = can(EMPLOYEE_UPDATE);
  // Personal fields are editable only when the server let this role read them: nothing is changed unseen.
  const birthDate = can(EMPLOYEE_UPDATE_PERSONAL) && employee.dateOfBirth !== undefined;
  const anniversary = can(EMPLOYEE_UPDATE_PERSONAL) && employee.serviceAnniversaryDate !== undefined;
  const [form, setForm] = useState({
    displayName: employee.displayName,
    workEmail: employee.workEmail ?? '',
    workPhoneExtension: employee.workPhoneExtension ?? '',
    dateOfBirth: employee.dateOfBirth ?? '',
    serviceAnniversaryDate: employee.serviceAnniversaryDate ?? '',
  });
  // An answer without the field (an older server) never sends it: nothing is changed unseen.
  const extension = operational && employee.workPhoneExtension !== undefined;
  const [unchanged, setUnchanged] = useState(false);
  const save = useMutation({
    mutationFn: (changes: Record<string, string | null>) => api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}`, { method: 'PATCH', body: { expectedVersion: employee.version, ...changes } }),
    onSuccess: () => {
      close();
      onSaved('Details saved.');
    },
    onError: reloadOnConflict(onConflict),
  });
  // Only what differs is sent: the route checks the duty of each group named, and a blank optional value clears it.
  const changes = (): Record<string, string | null> => ({
    ...(operational && form.displayName.trim() !== employee.displayName ? { displayName: form.displayName.trim() } : {}),
    ...(operational && form.workEmail.trim() !== (employee.workEmail ?? '') ? { workEmail: form.workEmail.trim() || null } : {}),
    ...(extension && form.workPhoneExtension.trim() !== (employee.workPhoneExtension ?? '') ? { workPhoneExtension: form.workPhoneExtension.trim() || null } : {}),
    ...(birthDate && form.dateOfBirth !== (employee.dateOfBirth ?? '') ? { dateOfBirth: form.dateOfBirth || null } : {}),
    ...(anniversary && form.serviceAnniversaryDate !== (employee.serviceAnniversaryDate ?? '') ? { serviceAnniversaryDate: form.serviceAnniversaryDate || null } : {}),
  });
  return (
    <FormGrid
      aria-label="Edit details"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const changed = changes();
        const nothing = Object.keys(changed).length === 0;
        setUnchanged(nothing);
        if (nothing) save.reset();
        else save.mutate(changed);
      }}
    >
      {operational && (
        <>
          <FormField>
            Name
            <Input required maxLength={200} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </FormField>
          <FormField>
            Work email
            <Input type="email" maxLength={254} value={form.workEmail} onChange={(e) => setForm({ ...form, workEmail: e.target.value })} />
          </FormField>
          {extension && (
            <FormField>
              Work phone extension
              <Input inputMode="numeric" maxLength={20} value={form.workPhoneExtension} onChange={(e) => setForm({ ...form, workPhoneExtension: e.target.value })} />
            </FormField>
          )}
        </>
      )}
      {birthDate && (
        <FormField>
          Date of birth
          <Input type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} />
        </FormField>
      )}
      {anniversary && (
        <FormField>
          Service anniversary base date
          <Input type="date" value={form.serviceAnniversaryDate} onChange={(e) => setForm({ ...form, serviceAnniversaryDate: e.target.value })} />
        </FormField>
      )}
      <Button type="submit" disabled={save.isPending}>
        Save details
      </Button>
      <div className="col-span-full">
        {unchanged && <NothingChanged />}
        <Refusal error={save.error} />
      </div>
    </FormGrid>
  );
}

/** DF04: the server checks the requirements on the joining date, or today when joining has passed, and names what is missing. */
export function ActivationPanel({ employee, onSaved, onConflict }: FormProps) {
  const [noManagerReason, setNoManagerReason] = useState('');
  const activate = useMutation({
    mutationFn: () =>
      api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/activate`, {
        body: { expectedVersion: employee.version, ...(noManagerReason.trim() ? { noManagerReason: noManagerReason.trim() } : {}) },
      }),
    onSuccess: () => onSaved('Activated. The employee is now on probation from the joining date.'),
    onError: reloadOnConflict(onConflict),
  });
  return (
    <Section title="Activation">
      <FormGrid
        aria-label="Activate"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          activate.mutate();
        }}
      >
        <FormField className="col-span-full">
          Reason for having no manager (only if there is none on the check date)
          <Input maxLength={500} value={noManagerReason} onChange={(e) => setNoManagerReason(e.target.value)} />
        </FormField>
        <Button type="submit" disabled={activate.isPending}>
          Activate
        </Button>
        <div className="col-span-full">
          <Refusal error={activate.error} />
        </div>
      </FormGrid>
    </Section>
  );
}

function ManagerForm({ employee, onSaved, close }: FormProps & { close: () => void }) {
  const [manager, setManager] = useState<EmployeeHit | null>(null);
  const [remove, setRemove] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [reason, setReason] = useState('');
  const change = useMutation({
    mutationFn: () =>
      api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/manager`, {
        body: { managerEmployeeId: remove ? null : manager!.id, effectiveFrom, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      }),
    onSuccess: () => {
      close();
      onSaved(`Manager change saved, effective ${effectiveFrom}. The record shows it from that date; earlier periods stay in the history.`);
    },
  });
  return (
    <FormGrid
      aria-label="Change manager"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      {!remove && <EmployeePicker label="New manager" value={manager} onChange={setManager} filter={{ statusGroup: 'ACTIVE' }} />}
      <CheckField className="col-span-full">
        <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> No manager from this date
      </CheckField>
      <FormField>
        Effective from
        <Input type="date" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </FormField>
      <FormField>
        Reason
        <Input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <Button type="submit" disabled={change.isPending || (!remove && !manager)}>
        Save manager change
      </Button>
      <Hint>Open approval tasks stay with the manager who holds them.</Hint>
      <div className="col-span-full">
        <Refusal error={change.error} rule="This would break a rule: the new manager may already report to this employee, directly or through others." />
      </div>
    </FormGrid>
  );
}

function TransferForm({ employee, onSaved, close }: FormProps & { close: () => void }) {
  const current = employee.assignment;
  const [form, setForm] = useState({ departmentId: current?.departmentId ?? '', locationId: current?.locationId ?? '', designationId: current?.designationId ?? '', gradeId: current?.gradeId ?? '', effectiveFrom: '', reason: '' });
  const change = useMutation({
    mutationFn: () =>
      api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/assignment`, {
        body: {
          departmentId: form.departmentId,
          locationId: form.locationId,
          designationId: form.designationId,
          effectiveFrom: form.effectiveFrom,
          ...(form.gradeId ? { gradeId: form.gradeId } : {}),
          ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
        },
      }),
    onSuccess: () => {
      close();
      onSaved(`Transfer saved, effective ${form.effectiveFrom}. The record shows it from that date; earlier periods stay in the history.`);
    },
  });
  return (
    <FormGrid
      aria-label="Transfer"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      <FormField>
        Effective from
        <Input type="date" required value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
      </FormField>
      <MasterSelect kind="departments" label="Department" required value={form.departmentId} known={current?.departmentName} validOn={form.effectiveFrom} onChange={(departmentId) => setForm({ ...form, departmentId })} />
      <MasterSelect kind="locations" label="Location" required value={form.locationId} known={current?.locationName} validOn={form.effectiveFrom} onChange={(locationId) => setForm({ ...form, locationId })} />
      <MasterSelect kind="designations" label="Designation" required value={form.designationId} known={current?.designationName} validOn={form.effectiveFrom} onChange={(designationId) => setForm({ ...form, designationId })} />
      <MasterSelect kind="grades" label="Grade" value={form.gradeId} validOn={form.effectiveFrom} onChange={(gradeId) => setForm({ ...form, gradeId })} />
      <FormField className="col-span-full">
        Reason
        <Input maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </FormField>
      <Button type="submit" disabled={change.isPending}>
        Save transfer
      </Button>
      <div className="col-span-full">
        <Refusal error={change.error} />
      </div>
    </FormGrid>
  );
}

function ShiftForm({ employee, onSaved, close }: FormProps & { close: () => void }) {
  const { can } = useSession();
  const [shiftId, setShiftId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const shifts = useQuery({ queryKey: ['employee-shift-options'], enabled: can(SHIFT_READ), queryFn: () => api<{ items: ShiftOption[] }>('/v1/shifts') });
  const change = useMutation({
    mutationFn: () => api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/shift`, { body: { shiftId, effectiveFrom } }),
    onSuccess: () => {
      close();
      onSaved(`Shift change saved, effective ${effectiveFrom}. Earlier periods stay in the history.`);
    },
  });
  if (!can(SHIFT_READ)) return <Hint>Your role cannot read the shift master, so it cannot choose a shift here.</Hint>;
  return (
    <FormGrid
      aria-label="Change shift"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      <FormField>
        Shift
        <NativeSelect required value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
          <option value="">Choose a shift</option>
          {shifts.data?.items
            .filter((s) => s.active)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} {s.name} ({s.inTime}-{s.outTime})
              </option>
            ))}
        </NativeSelect>
      </FormField>
      <FormField>
        Effective from
        <Input type="date" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </FormField>
      <Button type="submit" disabled={change.isPending}>
        Save shift change
      </Button>
      <div className="col-span-full">
        <ErrorNote error={shifts.error} />
        <Refusal error={change.error} />
      </div>
    </FormGrid>
  );
}

function JoiningDateForm({ employee, onSaved, onConflict, close }: FormProps & { close: () => void }) {
  const [joiningDate, setJoiningDate] = useState(employee.joiningDate);
  const [reason, setReason] = useState('');
  const correct = useMutation({
    mutationFn: () => api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/joining-date`, { body: { expectedVersion: employee.version, joiningDate, reason: reason.trim() } }),
    onSuccess: () => {
      close();
      onSaved(`Joining date corrected to ${joiningDate}. The earlier date stays on record.`);
    },
    onError: reloadOnConflict(onConflict),
  });
  return (
    <FormGrid
      aria-label="Correct joining date"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        correct.mutate();
      }}
    >
      <FormField>
        Joining date
        <Input type="date" required value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} />
      </FormField>
      <FormField className="col-span-full">
        Reason
        <Input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <Button type="submit" disabled={correct.isPending}>
        Save joining date
      </Button>
      <div className="col-span-full">
        <Refusal error={correct.error} />
      </div>
    </FormGrid>
  );
}

function CloseDraftForm({ employee, onSaved, onConflict, close }: FormProps & { close: () => void }) {
  const [reason, setReason] = useState('');
  const closeDraft = useMutation({
    mutationFn: () => api<EmployeeRecord>(`/v1/employees/${enc(employee.id)}/close-draft`, { body: { expectedVersion: employee.version, reason: reason.trim() } }),
    onSuccess: () => {
      close();
      onSaved('Draft closed. The record, its code and its work email are kept.');
    },
    onError: reloadOnConflict(onConflict),
  });
  return (
    <FormGrid
      aria-label="Close draft"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        closeDraft.mutate();
      }}
    >
      <FormField className="col-span-full">
        Reason
        <Input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <Button type="submit" disabled={closeDraft.isPending}>
        Confirm closing the draft
      </Button>
      <Hint>For someone who never joined. The record stays on file as archived.</Hint>
      <div className="col-span-full">
        <Refusal error={closeDraft.error} />
      </div>
    </FormGrid>
  );
}

/** The changes the role may make to this record; the record offers its changes only when one of them holds. */
export function changeDuties(can: (permission: string) => boolean, employee: EmployeeRecord) {
  const draft = employee.status === 'DRAFT';
  const update = can(EMPLOYEE_UPDATE);
  const edit = update || (can(EMPLOYEE_UPDATE_PERSONAL) && (employee.dateOfBirth !== undefined || employee.serviceAnniversaryDate !== undefined));
  const assign = can(SHIFT_ASSIGN);
  const closeDraft = draft && can(EMPLOYEE_DEACTIVATE);
  return { draft, update, edit, assign, closeDraft, offered: edit || update || assign || closeDraft };
}

export function Changes(props: FormProps) {
  const { can } = useSession();
  const { employee } = props;
  const { draft, update, edit, assign, closeDraft, offered } = changeDuties(can, employee);
  if (!offered) return null;
  return (
    <Section title="Change this record">
      <ActionBar>
        {edit && <Action label="Edit details">{(close) => <EditForm {...props} close={close} />}</Action>}
        {update && <Action label="Change manager">{(close) => <ManagerForm {...props} close={close} />}</Action>}
        {update && <Action label="Transfer">{(close) => <TransferForm {...props} close={close} />}</Action>}
        {assign && <Action label="Change shift">{(close) => <ShiftForm {...props} close={close} />}</Action>}
        {draft && update && <Action label="Correct joining date">{(close) => <JoiningDateForm {...props} close={close} />}</Action>}
        {closeDraft && <Action label="Close draft">{(close) => <CloseDraftForm {...props} close={close} />}</Action>}
      </ActionBar>
      {(update || assign) && <Hint>Manager, transfer and shift changes are dated: the current period closes on that date, and a new change must start after the latest one.</Hint>}
    </Section>
  );
}
