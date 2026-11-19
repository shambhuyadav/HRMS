// The increments page: its cycles, cases, off-cycle change and salary sections, each shown to its own grants.

import { useState } from 'react';
import { useSession } from '../../session';
import { NotPermitted, Section } from '../../ui';
import { CasesSection } from './cases';
import { CyclesSection } from './cycles';
import { OffCycleSection } from './off-cycle';
import { SalaryPanel } from './salary';
import { CYCLE_MANAGE, type PickedEmployee, PROPOSE, READ_HISTORY, READ_OPERATIONAL, READ_SALARY, SALARY_MANAGE, SALARY_READ } from './shared';

export function IncrementsPage() {
  const { me, can } = useSession();
  const [salaryEmployee, setSalaryEmployee] = useState<PickedEmployee | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  // The role context and its permissions arrive together; until then nothing is known, so nothing reads as refused.
  if (!me) {
    return (
      <>
        <h1>Increments and salary</h1>
        <p className="hint loading">Loading…</p>
      </>
    );
  }
  // Opening a review and proposing an off-cycle change need a company-wide assignment (the server refuses others).
  const companyWide = me.scopeKind === 'COMPANY';
  const canReadCases = can(READ_OPERATIONAL) || can(READ_SALARY);
  const salaryPanel = can(SALARY_READ) || can(READ_HISTORY) || can(SALARY_MANAGE);

  const showSalary = (employee: PickedEmployee) => {
    setSalaryEmployee(employee);
    setFocusRequest((n) => n + 1);
  };

  return (
    <>
      <h1>Increments and salary</h1>
      {can(CYCLE_MANAGE) && <CyclesSection companyWide={companyWide} />}
      {canReadCases ? (
        <CasesSection onShowSalary={salaryPanel ? showSalary : undefined} />
      ) : (
        <Section title="Increment cases">
          <NotPermitted>The selected role cannot view increment cases.</NotPermitted>
        </Section>
      )}
      {can(PROPOSE) && companyWide && <OffCycleSection />}
      {salaryPanel && <SalaryPanel employee={salaryEmployee} onEmployee={setSalaryEmployee} focusRequest={focusRequest} />}
    </>
  );
}
