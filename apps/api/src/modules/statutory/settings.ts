// Dated statutory settings the evaluator reads (I-85, decided under owner delegation, 6 Nov 2026; migration 0220):
// - an employee's PF contribution basis (employee_pf_option): on wages up to the PF pack's ceiling, or on higher wages by joint option
//   (EPF Scheme para 26(6)); without a row, the ceiling applies;
// - the professional tax state of a work location (location_pt_state): an employee's PT pack is PT_<state> of the location of their
//   employment assignment on the day valued.
// Both are payroll configuration, written under payroll_config.manage (a ceiling grant, nobody's default duty) and append-only: a change
// is a later row, and the row in force on a day is the latest that starts on or before it. Neither holds an amount. The payroll run
// that uses them is reviewed and approved by others (I-28), and the PF option is read only under the same manage right, because an
// option to contribute on higher wages says the wages are above the ceiling.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { actorOf, advisoryLock, audit, isIsoDate } from '../lifecycle/common.js';

export const PF_BASES = ['STATUTORY_CEILING', 'HIGHER_WAGES'] as const;

const OPTION_VIEW = `select o.id, o.employee_id as "employeeId", o.sequence, to_char(o.effective_from, 'YYYY-MM-DD') as "effectiveFrom",
    o.contribution_basis as "contributionBasis", o.reference, o.created_by as "createdBy", o.created_at as "createdAt"
  from employee_pf_option o`;

export async function listPfOptions(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  return { items: (await db.query(`${OPTION_VIEW} where o.company_id = $1 and o.employee_id = $2 order by o.sequence`, [grant.companyId, employeeId])).rows };
}

export async function recordPfOption(tx: Queryable, grant: AccessGrant, input: { employeeId: string; effectiveFrom: string; contributionBasis: string; reference: string }) {
  if (!(await canAccessEmployee(tx, grant, input.employeeId))) throw notFound();
  if (grant.linkedEmployeeId === input.employeeId) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot record your own PF option');
  if (!isIsoDate(input.effectiveFrom)) throw new HttpError(422, 'INVALID_DATE', 'The effective date is not a valid date', { field: 'effectiveFrom' });
  if (!(PF_BASES as readonly string[]).includes(input.contributionBasis)) throw new HttpError(422, 'INVALID_BASIS', 'The PF contribution basis is STATUTORY_CEILING or HIGHER_WAGES', { field: 'contributionBasis' });
  const reference = input.reference.trim();
  if (reference === '' || reference.length > 200) throw new HttpError(422, 'REFERENCE_REQUIRED', 'Name the option form or record the basis rests on (at most 200 characters)', { field: 'reference' });
  await advisoryLock(tx, `employee_pf_option:${grant.companyId}:${input.employeeId}`);
  await reassertAccess(tx, grant, 'payroll_config', 'manage', ['operational']);
  const id = (
    await tx.query<{ id: string }>(
      `insert into employee_pf_option (company_id, employee_id, sequence, effective_from, contribution_basis, reference, created_by)
       select $1, $2, coalesce(max(sequence), 0) + 1, $3::date, $4, $5, $6 from employee_pf_option where company_id = $1 and employee_id = $2
       returning id`,
      [grant.companyId, input.employeeId, input.effectiveFrom, input.contributionBasis, reference, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'employee_pf_option', id, 'CREATE', null, { operational: { employeeId: input.employeeId, effectiveFrom: input.effectiveFrom, contributionBasis: input.contributionBasis } });
  return (await tx.query(`${OPTION_VIEW} where o.company_id = $1 and o.id = $2`, [grant.companyId, id])).rows[0];
}

const STATE_VIEW = `select s.id, l.code as "locationCode", s.sequence, to_char(s.effective_from, 'YYYY-MM-DD') as "effectiveFrom", s.state_code as "stateCode",
    s.created_by as "createdBy", s.created_at as "createdAt"
  from location_pt_state s join location l on l.company_id = s.company_id and l.id = s.location_id`;

export async function listPtStates(db: Queryable, grant: AccessGrant) {
  return { items: (await db.query(`${STATE_VIEW} where s.company_id = $1 order by l.code, s.sequence`, [grant.companyId])).rows };
}

export async function recordPtState(tx: Queryable, grant: AccessGrant, input: { locationCode: string; effectiveFrom: string; stateCode: string }) {
  if (!isIsoDate(input.effectiveFrom)) throw new HttpError(422, 'INVALID_DATE', 'The effective date is not a valid date', { field: 'effectiveFrom' });
  const state = input.stateCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) throw new HttpError(422, 'INVALID_STATE_CODE', 'Give the two-letter state code of the professional tax pack (PT_<state>)', { field: 'stateCode' });
  const location = (await tx.query<{ id: string }>(`select id from location where company_id = $1 and code = $2`, [grant.companyId, input.locationCode.trim().toUpperCase()])).rows[0];
  if (!location) throw new HttpError(422, 'UNKNOWN_LOCATION', 'No location has that code', { field: 'locationCode' });
  await advisoryLock(tx, `location_pt_state:${grant.companyId}:${location.id}`);
  await reassertAccess(tx, grant, 'payroll_config', 'manage', ['operational']);
  const id = (
    await tx.query<{ id: string }>(
      `insert into location_pt_state (company_id, location_id, sequence, effective_from, state_code, created_by)
       select $1, $2, coalesce(max(sequence), 0) + 1, $3::date, $4, $5 from location_pt_state where company_id = $1 and location_id = $2
       returning id`,
      [grant.companyId, location.id, input.effectiveFrom, state, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'location_pt_state', id, 'CREATE', null, { operational: { locationId: location.id, effectiveFrom: input.effectiveFrom, stateCode: state } });
  return (await tx.query(`${STATE_VIEW} where s.company_id = $1 and s.id = $2`, [grant.companyId, id])).rows[0];
}
