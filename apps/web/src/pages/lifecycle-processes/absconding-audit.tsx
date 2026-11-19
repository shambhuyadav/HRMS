// The absconding audit report (CL-052): the screen that requests it under its own export right.

import { useState } from 'react';
import { localDate } from '../../api';
import { useSession } from '../../session';
import { NotPermitted, Section } from '../../ui';
import { keepOnPage, ReportExport } from '../leave-admin';
import { Problem, RoleReady } from './shared';

// ---------------------------------------------------------------------------------------------------------
// The absconding audit report (CL-052; 0283): the absconding warnings issued from a date (and up to one, if given) about the employees
// in the selected role's scope: employee, date, type, number, status and who issued them, never the text. Generated in the background
// by the report framework (ABSCONDING_AUDIT) under its own confidential export right; the company is the selected role's.
// ---------------------------------------------------------------------------------------------------------
export const NOTE_EXPORT = 'employee_note.export.restricted';
export const ABSCONDING_AUDIT_PATH = '/lifecycle/absconding-audit';

export function AbscondingAuditScreen() {
  const { can, me } = useSession();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filters: Record<string, string> = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const reversed = from !== '' && to !== '' && to < from;
  return (
    <>
      <h1>Absconding audit</h1>
      <RoleReady>
        {can(NOTE_EXPORT) ? (
          <Section title="Absconding warnings issued">
            <p className="hint">
              Lists every absconding warning about the employees in the selected role’s scope{me?.companyName ? ` at ${me.companyName}` : ''}, dated on or after the day chosen: the employee,
              the warning’s date, its number among the employee’s warnings in force, whether it was corrected or voided, and who issued it. The text of a warning is never in the
              report. A warning counts as an absconding warning when it was marked so when written (a warning without the mark is not counted). Generated as a file in the
              background, then downloaded here or from Reports.
            </p>
            <form className="grid-form" aria-label="Absconding audit filters" onSubmit={keepOnPage}>
              <label>
                Warning issued from
                <input type="date" required value={from} max={localDate()} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                Up to (blank: today)
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </form>
            {!from && <p className="hint">Choose the date the warnings were issued from.</p>}
            {reversed && <Problem text="The end is before the start." />}
            {from && !reversed && <ReportExport reportCode="ABSCONDING_AUDIT" filters={filters} label="Generate the absconding audit" />}
          </Section>
        ) : (
          <Section title="Absconding warnings issued">
            <NotPermitted>The selected role cannot export the absconding audit: it needs its own confidential export right.</NotPermitted>
          </Section>
        )}
      </RoleReady>
    </>
  );
}
