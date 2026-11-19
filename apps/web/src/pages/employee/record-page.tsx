// The employee record page: the record with its changes, sections and employment history.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { ActivationPanel, Changes } from './changes';
import { Fact, PrivateDetails, RecordFacts } from './record';
import { RecordSectionsPanel } from './record-sections';
import { ReadProblem } from './refusals';
import { EMPLOYEE_ACTIVATE, EMPLOYEE_HISTORY, EMPLOYEE_LIST, type EmployeeRecord, type EmploymentHistory, enc, keys } from './shared';

/**
 * Status changes, joining date corrections, job assignments and managers are read on the one employee history (FR-089;
 * employee-history.tsx), under this same duty, and are not repeated here. This section keeps only what that screen does not
 * carry: shift periods, the last working date and the employments linked to this one.
 */
function HistorySection({ employeeId }: { employeeId: string }) {
  const history = useQuery({ queryKey: keys.history(employeeId), queryFn: () => api<EmploymentHistory>(`/v1/employees/${enc(employeeId)}/history`) });
  const h = history.data;
  return (
    <Section title="Employment history">
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
            <table aria-label="Shifts">
              <thead>
                <tr>
                  <th scope="col">From</th>
                  <th scope="col">Until</th>
                  <th scope="col">Shift</th>
                </tr>
              </thead>
              <tbody>
                {h.shifts.map((s, i) => (
                  <tr key={i}>
                    <td>{formatDate(s.effectiveFrom)}</td>
                    <td>{s.effectiveTo ? formatDate(s.effectiveTo) : 'Open'}</td>
                    <td>
                      {s.shiftCode} {s.shiftName}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
  return (
    <>
      {can(EMPLOYEE_LIST) && <Link className="back-link" to="/employees">← Employees</Link>}
      {record.error ? <ReadProblem error={record.error} /> : null}
      {employee && (
        <>
          <Section title={`${employee.displayName} (${employee.employeeCode})`} actions={documents ? <Link to={`/employees/${employee.id}/documents`}>Documents</Link> : undefined}>
            {notice && <p role="status">{notice}</p>}
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
