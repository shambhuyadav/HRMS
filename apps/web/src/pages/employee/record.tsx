// The record: its facts and the private details (personal and bank) shown only to their own grants.

import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Section, StateBadge } from '../../ui';
import { ReadProblem } from './refusals';
import { EMPLOYEE_BANK, EMPLOYEE_PRIVATE, type EmployeeRecord, employmentTypeLabel, enc, fieldWords, keys, type PrivateCategory, type PrivateProfile } from './shared';

// ---------------------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------------------

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function RecordFacts({ employee: e }: { employee: EmployeeRecord }) {
  return (
    <dl className="kv">
      <Fact label="Employee code">{e.employeeCode}</Fact>
      <Fact label="Name">{e.displayName}</Fact>
      <Fact label="Status">
        <StateBadge state={e.status} />
      </Fact>
      <Fact label="Employment type">{employmentTypeLabel(e.employmentType)}</Fact>
      <Fact label="Work email">{e.workEmail ?? '—'}</Fact>
      {e.workPhoneExtension !== undefined && <Fact label="Work phone extension">{e.workPhoneExtension ?? '—'}</Fact>}
      <Fact label="Joining date">{formatDate(e.joiningDate)}</Fact>
      <Fact label="Confirmation date">{formatDate(e.confirmationDate)}</Fact>
      {e.assignment ? (
        <>
          <Fact label="Department">{e.assignment.departmentName}</Fact>
          <Fact label="Location">{e.assignment.locationName}</Fact>
          <Fact label="Designation">{e.assignment.designationName}</Fact>
          {e.assignment.gradeName && (
            <Fact label="Grade">
              {e.assignment.gradeCode} {e.assignment.gradeName}
            </Fact>
          )}
        </>
      ) : (
        <Fact label="Job assignment">None in force today</Fact>
      )}
      <Fact label="Shift">{e.shift ? `${e.shift.code} ${e.shift.name}` : 'None in force today'}</Fact>
      <Fact label="Manager">
        {e.manager ? (
          <Link to={`/employees/${e.manager.id}`}>
            {e.manager.displayName} ({e.manager.employeeCode})
          </Link>
        ) : (
          'None in force today'
        )}
      </Fact>
      {e.noManagerReason && <Fact label="Reason for having no manager">{e.noManagerReason}</Fact>}
      {e.dateOfBirth !== undefined && <Fact label="Date of birth">{formatDate(e.dateOfBirth)}</Fact>}
      {e.serviceAnniversaryDate !== undefined && <Fact label="Service anniversary base date">{formatDate(e.serviceAnniversaryDate)}</Fact>}
    </dl>
  );
}

function PrivateValues({ title, category }: { title: string; category: PrivateCategory }) {
  const entries = Object.entries(category.values ?? {}).filter(([, v]) => v !== null && v !== '');
  return (
    <>
      <h3>
        {title} {category.masked && <Badge tone="warn">masked</Badge>}
      </h3>
      {entries.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <dl className="kv">
          {entries.map(([key, value]) => (
            <Fact key={key} label={fieldWords(key)}>
              {value}
            </Fact>
          ))}
        </dl>
      )}
    </>
  );
}

/** The private details are offered under either grant. */
export const privateDetailsOffered = (can: (permission: string) => boolean) => can(EMPLOYEE_PRIVATE) || can(EMPLOYEE_BANK);

/**
 * FR-008: private details under the role's own grant, read only when asked for and not kept once left. The server leaves out
 * every category the grant does not reach and masks the bank values without the bank group; this page shows what it answers.
 */
export function PrivateDetails({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  const [shown, setShown] = useState(false);
  const profile = useQuery({
    queryKey: keys.privateProfile(employeeId),
    enabled: shown,
    gcTime: 0,
    queryFn: () => api<PrivateProfile>(`/v1/employees/${enc(employeeId)}/private-profile`),
  });
  if (!privateDetailsOffered(can)) return null;
  return (
    <Section
      title="Private details"
      actions={
        <button type="button" className="secondary" aria-expanded={shown} onClick={() => setShown(!shown)}>
          {shown ? 'Hide private details' : 'Show private details'}
        </button>
      }
    >
      {shown && (
        <>
          {profile.error ? <ReadProblem error={profile.error} /> : null}
          {profile.data?.personal && <PrivateValues title="Personal details" category={profile.data.personal} />}
          {profile.data?.address && <PrivateValues title="Address" category={profile.data.address} />}
          {profile.data?.bank && <PrivateValues title="Bank details" category={profile.data.bank} />}
        </>
      )}
    </Section>
  );
}
