// The employee record page: the record with its changes, sections and employment history.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate } from '../../api';
import { placeFact, type ProfileFact, ProfileHeader, profileSubtitle } from '../../profile-header';
import { type BarSection, SectionBar } from '../../section-bar';
import { useSession } from '../../session';
import { Empty, Notice, Section } from '../../ui';
import { ActivationPanel, Changes, changeDuties } from './changes';
import { Fact, PrivateDetails, privateDetailsOffered, RecordFacts } from './record';
import { RECORD_SECTIONS_TITLE, RecordSectionsPanel, recordSectionsOffered } from './record-sections';
import { ReadProblem } from './refusals';
import { EMPLOYEE_ACTIVATE, EMPLOYEE_HISTORY, EMPLOYEE_LIST, type EmployeeRecord, type EmploymentHistory, employmentTypeLabel, enc, keys } from './shared';

const HISTORY_TITLE = 'Employment history';

/** The record's key facts for its header card: only what the record itself answered. */
function headerFacts(e: EmployeeRecord): ProfileFact[] {
  return [
    ...placeFact(e.assignment?.departmentName, e.assignment?.locationName),
    { icon: 'calendar', text: `Joined ${formatDate(e.joiningDate)}`, title: 'Date joined' },
    ...(e.manager ? [{ icon: 'users' as const, text: `Reports to ${e.manager.displayName}`, title: 'Reporting manager' }] : []),
  ];
}

/**
 * Status changes, joining date corrections, job assignments and managers are read on the one employee history (FR-089;
 * employee-history.tsx), under this same duty, and are not repeated here. This section keeps only what that screen does not
 * carry: shift periods, the last working date and the employments linked to this one.
 */
function HistorySection({ employeeId }: { employeeId: string }) {
  const history = useQuery({ queryKey: keys.history(employeeId), queryFn: () => api<EmploymentHistory>(`/v1/employees/${enc(employeeId)}/history`) });
  const h = history.data;
  return (
    <Section title={HISTORY_TITLE}>
      <p>
        <Link to={`/employee-history/${employeeId}`}>Status and employment history</Link>
      </p>
      {history.error ? <ReadProblem error={history.error} /> : null}
      {h && (
        <>
          <dl className="kv">
            <Fact label="Last working date">{formatDate(h.leavingDate)}</Fact>
            {h.priorEmployment && (
              <Fact label="Follows the employment">
                <Link to={`/employees/${h.priorEmployment.employeeId}`}>{h.priorEmployment.employeeCode ?? 'Prior employment'}</Link>
              </Fact>
            )}
            {h.nextEmployment && (
              <Fact label="Followed by the employment">
                <Link to={`/employees/${h.nextEmployment.employeeId}`}>{h.nextEmployment.employeeCode ?? 'Next employment'}</Link>
              </Fact>
            )}
          </dl>
          <h3>Shifts</h3>
          {h.shifts.length === 0 ? (
            <Empty>Nothing recorded yet.</Empty>
          ) : (
            <Table aria-label="Shifts">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">From</TableHead>
                  <TableHead scope="col">Until</TableHead>
                  <TableHead scope="col">Shift</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {h.shifts.map((s, i) => (
                  <TableRow key={i}>
                    <TableCell>{formatDate(s.effectiveFrom)}</TableCell>
                    <TableCell>{s.effectiveTo ? formatDate(s.effectiveTo) : 'Open'}</TableCell>
                    <TableCell>
                      {s.shiftCode} {s.shiftName}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </Section>
  );
}

function EmployeeRecordView({ id }: { id: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const record = useQuery({ queryKey: keys.record(id), queryFn: () => api<EmployeeRecord>(`/v1/employees/${enc(id)}`) });
  const reload = () => {
    void qc.invalidateQueries({ queryKey: keys.record(id) });
    void qc.invalidateQueries({ queryKey: keys.history(id) });
    void qc.invalidateQueries({ queryKey: ['employees'] });
  };
  const onSaved = (message: string) => {
    setNotice(message);
    reload();
  };
  const employee = record.data;
  // Either document grant reaches the documents page, as on the employee list (FR-010).
  const documents = can('document.read.document') || can('document.upload.document');
  const title = employee ? `${employee.displayName} (${employee.employeeCode})` : '';
  // The bar names the sections this record shows, under the same duties that show them.
  const sections: BarSection[] = employee
    ? [
        { key: 'overview', label: 'Overview', heading: title },
        ...(employee.status === 'DRAFT' && can(EMPLOYEE_ACTIVATE) ? [{ key: 'activation', label: 'Activation', heading: 'Activation' }] : []),
        ...(changeDuties(can, employee).offered ? [{ key: 'changes', label: 'Changes', heading: 'Change this record' }] : []),
        ...(privateDetailsOffered(can) ? [{ key: 'private', label: 'Private details', heading: 'Private details' }] : []),
        ...(recordSectionsOffered(can) ? [{ key: 'family', label: 'Family and qualifications', heading: RECORD_SECTIONS_TITLE }] : []),
        ...(can(EMPLOYEE_HISTORY) ? [{ key: 'history', label: 'History', heading: HISTORY_TITLE }] : []),
      ]
    : [];
  return (
    <>
      {can(EMPLOYEE_LIST) && <BackLink to="/employees">← Employees</BackLink>}
      {record.error ? <ReadProblem error={record.error} /> : null}
      {employee && (
        <>
          <ProfileHeader
            name={employee.displayName}
            subtitle={profileSubtitle(employee.employeeCode, employee.assignment?.designationName, employmentTypeLabel(employee.employmentType))}
            status={employee.status}
            facts={headerFacts(employee)}
          />
          <SectionBar sections={sections} />
          <Section
            title={title}
            actions={
              documents ? (
                <Button asChild variant="outline" size="sm">
                  <Link to={`/employees/${employee.id}/documents`}>Documents</Link>
                </Button>
              ) : undefined
            }
          >
            {notice && <Notice notice={{ text: notice, ok: true }} />}
            <RecordFacts employee={employee} />
          </Section>
          {employee.status === 'DRAFT' && can(EMPLOYEE_ACTIVATE) && <ActivationPanel employee={employee} onSaved={onSaved} onConflict={reload} />}
          <Changes employee={employee} onSaved={onSaved} onConflict={reload} />
          <PrivateDetails employeeId={employee.id} />
          <RecordSectionsPanel employeeId={employee.id} />
          {can(EMPLOYEE_HISTORY) && <HistorySection employeeId={employee.id} />}
        </>
      )}
    </>
  );
}

/** A new address is a new record: nothing typed or noted for one employee carries over to another. */
export function EmployeeRecordPage() {
  const { id = '' } = useParams();
  return <EmployeeRecordView key={id} id={id} />;
}
