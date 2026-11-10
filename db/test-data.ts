// Test accounts and dummy data in an existing company of a production database (the owner's request of 10 Nov 2026: one sign-in per
// role and dummy data for testing, inside the real company; records there are permanent and can only be deactivated later). Every test
// record is marked: organisation codes start with "T-", employee codes with "T", emails end in "@hrstop.test" (a reserved name that is
// nobody's mailbox). One transaction: all of it or nothing; a second run changes nothing.
// What it writes, the way the development seed does (apps/api/src/dev/seed.ts) — directly, in the shapes the rules require:
//   departments, locations, designations, grades; a general shift; 16 active employees with assignments, shifts and a reporting chain;
//   two holidays per test location; leave opening balances; the company's draft leave, attendance and expense policies activated (by the
//   test HR account, not their author); five test accounts, one per role, their grants recorded as approved by TEST_DATA_APPROVER (a
//   person, never the system account) with the purpose naming this request.
// Usage on the server (deploy/scripts/test-data.sh runs it and adds the Keycloak sign-ins):
//   TEST_DATA_COMPANY=HRMS TEST_DATA_APPROVER=<the System Administrator's email> TEST_DATA_CONFIRM=permanent-test-records npx tsx db/test-data.ts
import pg from 'pg';
import { SYSTEM_ACTOR_ID } from '../apps/api/src/audit/actors.js';
import { BASELINE_ROLES, parsePermissionKey } from '../apps/api/src/modules/access/baseline.js';
import { withGrantBootstrap } from '../apps/api/src/modules/access/provision.js';

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
};
if (process.env.TEST_DATA_CONFIRM !== 'permanent-test-records') {
  throw new Error('Test data in this database is permanent (records can only be deactivated): set TEST_DATA_CONFIRM=permanent-test-records');
}
const companyCode = required('TEST_DATA_COMPANY');
const approverKey = required('TEST_DATA_APPROVER').toLowerCase();
const PURPOSE = 'Test account with dummy data for testing, requested by the owner on 10 Nov 2026';

export const TEST_ACCOUNTS = [
  { key: 'demo.sysadmin@hrstop.test', roles: ['SYSTEM_ADMINISTRATOR'], employee: null },
  { key: 'demo.hr@hrstop.test', roles: ['HR_ADMINISTRATOR', 'EMPLOYEE'], employee: 'T007' },
  { key: 'demo.manager@hrstop.test', roles: ['REPORTING_MANAGER', 'EMPLOYEE'], employee: 'T001' },
  { key: 'demo.employee@hrstop.test', roles: ['EMPLOYEE'], employee: 'T002' },
  { key: 'demo.auditor@hrstop.test', roles: ['AUDITOR'], employee: null },
] as const;

const DEPARTMENTS = [['T-MGT', 'Management'], ['T-ENG', 'Engineering'], ['T-HR', 'Human Resources'], ['T-FIN', 'Finance'], ['T-SAL', 'Sales']];
const LOCATIONS = [['T-MUM', 'Mumbai Office'], ['T-PUN', 'Pune Office']];
const DESIGNATIONS = [
  ['T-CEO', 'Chief Executive Officer'], ['T-EM', 'Engineering Manager'], ['T-SSE', 'Senior Software Engineer'], ['T-SE', 'Software Engineer'],
  ['T-HRM', 'HR Manager'], ['T-HRE', 'HR Executive'], ['T-FM', 'Finance Manager'], ['T-ACC', 'Accountant'], ['T-SM', 'Sales Manager'], ['T-SLE', 'Sales Executive'],
];
const GRADES = [['T-G1', 'Grade 1'], ['T-G2', 'Grade 2'], ['T-G3', 'Grade 3'], ['T-G4', 'Grade 4']];
// code, name, department, designation, grade, location, manager, joining date
const EMPLOYEES: [string, string, string, string, string, string, string | null, string][] = [
  ['T000', 'Neha Kapoor', 'T-MGT', 'T-CEO', 'T-G4', 'T-MUM', null, '2023-04-03'],
  ['T001', 'Rohan Mehta', 'T-ENG', 'T-EM', 'T-G3', 'T-MUM', 'T000', '2024-01-15'],
  ['T002', 'Priya Nair', 'T-ENG', 'T-SE', 'T-G1', 'T-MUM', 'T001', '2025-06-02'],
  ['T003', 'Arjun Verma', 'T-ENG', 'T-SSE', 'T-G2', 'T-MUM', 'T001', '2024-08-19'],
  ['T004', 'Sneha Kulkarni', 'T-ENG', 'T-SE', 'T-G1', 'T-PUN', 'T001', '2025-02-10'],
  ['T005', 'Vikram Singh', 'T-ENG', 'T-SE', 'T-G1', 'T-PUN', 'T001', '2025-09-01'],
  ['T006', 'Rahul Gupta', 'T-ENG', 'T-SSE', 'T-G2', 'T-PUN', 'T001', '2024-11-25'],
  ['T007', 'Ananya Iyer', 'T-HR', 'T-HRM', 'T-G3', 'T-MUM', 'T000', '2023-11-01'],
  ['T008', 'Divya Pillai', 'T-HR', 'T-HRE', 'T-G1', 'T-MUM', 'T007', '2025-03-17'],
  ['T009', 'Kabir Shah', 'T-FIN', 'T-FM', 'T-G3', 'T-MUM', 'T000', '2023-09-11'],
  ['T010', 'Meera Joshi', 'T-FIN', 'T-ACC', 'T-G2', 'T-MUM', 'T009', '2024-05-06'],
  ['T011', 'Karan Malhotra', 'T-FIN', 'T-ACC', 'T-G1', 'T-MUM', 'T009', '2025-08-18'],
  ['T012', 'Aditya Rao', 'T-SAL', 'T-SM', 'T-G3', 'T-PUN', 'T000', '2024-02-01'],
  ['T013', 'Isha Patel', 'T-SAL', 'T-SLE', 'T-G1', 'T-PUN', 'T012', '2025-10-13'],
  ['T014', 'Nikhil Desai', 'T-SAL', 'T-SLE', 'T-G1', 'T-PUN', 'T012', '2025-04-07'],
  ['T015', 'Pooja Menon', 'T-SAL', 'T-SLE', 'T-G1', 'T-MUM', 'T012', '2025-01-20'],
];
const HOLIDAYS = [['2026-12-25', 'Christmas'], ['2027-01-26', 'Republic Day']];
const OPENING_BALANCES = [['ANNUAL', '12'], ['SICK', '6'], ['CASUAL', '6']];

const client = new pg.Client({ connectionString: required('DATABASE_URL') });
await client.connect();
try {
  await client.query('begin');
  const company = (await client.query<{ id: string }>(`select id from company where code = $1 and active`, [companyCode])).rows[0];
  if (!company) throw new Error(`No active company ${companyCode}`);
  const c = company.id;
  if ((await client.query(`select 1 from employee where company_id = $1 and employee_code = 'T000'`, [c])).rowCount) {
    console.log('Test data is already there; nothing changed.');
    await client.query('rollback');
    process.exit(0);
  }
  const approver = (await client.query<{ id: string }>(`select id from user_account where account_key = $1 and active`, [approverKey])).rows[0];
  if (!approver) throw new Error(`No active account ${approverKey} to record as the grants' approver`);

  const ids = new Map<string, string>();
  const master = async (table: string, code: string, name: string) => {
    const id = (await client.query<{ id: string }>(`insert into ${table} (company_id, code, name, active, created_by) values ($1, $2, $3, true, $4) returning id`, [c, code, name, SYSTEM_ACTOR_ID])).rows[0]!.id;
    ids.set(code, id);
  };
  for (const [code, name] of DEPARTMENTS) await master('department', code!, name!);
  for (const [code, name] of LOCATIONS) await master('location', code!, name!);
  for (const [code, name] of DESIGNATIONS) await master('designation', code!, name!);
  for (const [code, name] of GRADES) await master('grade', code!, name!);

  const shift = (
    await client.query<{ id: string }>(
      `insert into shift (company_id, code, name, in_time, out_time, spans_midnight, buffer_minutes, active, created_by)
       values ($1, 'T-GEN', 'General shift 09:30-18:30', '09:30', '18:30', false, 15, true, $2) returning id`,
      [c, SYSTEM_ACTOR_ID],
    )
  ).rows[0]!.id;
  await client.query(`insert into shift_break (company_id, shift_id, sequence, start_offset_minutes, end_offset_minutes) values ($1, $2, 1, 240, 270)`, [c, shift]);

  const ref = async (category: string, code: string) =>
    (await client.query<{ id: string }>(`select id from reference_value where company_id = $1 and category = $2 and code = $3`, [c, category, code])).rows[0]!.id;
  const permanent = await ref('EMPLOYMENT_TYPE', 'PERMANENT');
  const confirmed = await ref('EMPLOYEE_STATUS', 'ACTIVE_CONFIRMED');
  const holidayType = await ref('HOLIDAY_TYPE', 'HOLIDAY');

  const employees = new Map<string, string>();
  for (const [code, name, dept, desig, grade, loc, , joined] of EMPLOYEES) {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}@hrstop.test`;
    const id = (
      await client.query<{ id: string }>(
        `insert into employee (company_id, employee_code, display_name, work_email, joining_date, employment_type_id, status_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [c, code, name, email, joined, permanent, confirmed, SYSTEM_ACTOR_ID],
      )
    ).rows[0]!.id;
    employees.set(code, id);
    await client.query(
      `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, grade_id, effective_from) values ($1, $2, $3, $4, $5, $6, $7)`,
      [c, id, ids.get(dept), ids.get(loc), ids.get(desig), ids.get(grade), joined],
    );
    await client.query(`insert into shift_assignment (company_id, employee_id, shift_id, effective_from) values ($1, $2, $3, $4)`, [c, id, shift, joined]);
  }
  for (const [code, , , , , , manager, joined] of EMPLOYEES) {
    if (manager) await client.query(`insert into manager_assignment (company_id, employee_id, manager_employee_id, effective_from) values ($1, $2, $3, $4)`, [c, employees.get(code), employees.get(manager), joined]);
  }
  for (const [loc] of LOCATIONS) {
    for (const [date, name] of HOLIDAYS) {
      await client.query(`insert into holiday (company_id, location_id, holiday_date, holiday_type_id, name, created_by) values ($1, $2, $3, $4, $5, $6)`, [c, ids.get(loc!), date, holidayType, name, SYSTEM_ACTOR_ID]);
    }
  }
  for (const [type, units] of OPENING_BALANCES) {
    await client.query(
      `insert into leave_movement (company_id, employee_id, leave_type_id, movement_kind, units, effective_date, idempotency_key, reason)
       select $1, e.id, t.id, 'OPENING', $3::numeric, greatest(e.joining_date, date '2026-01-01'), 'testdata:opening:' || e.employee_code || ':' || t.code, 'Test data opening balance'
         from employee e join leave_type t on t.company_id = e.company_id and t.code = $2
        where e.company_id = $1 and e.employee_code like 'T%' and e.employee_code ~ '^T[0-9]{3}$'`,
      [c, type, units],
    );
  }

  const user = async (key: string) =>
    (await client.query<{ id: string }>(`insert into user_account (account_key, active, created_by) values ($1, true, $2) on conflict (account_key) do update set active = true returning id`, [key, SYSTEM_ACTOR_ID])).rows[0]!.id;
  const users = new Map<string, string>();
  for (const a of TEST_ACCOUNTS) {
    const userId = await user(a.key);
    users.set(a.key, userId);
    if (a.employee) await client.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, created_by) values ($1, $2, $3, '2026-01-01', $4)`, [c, userId, employees.get(a.employee), SYSTEM_ACTOR_ID]);
    for (const roleCode of a.roles) {
      const role = BASELINE_ROLES.find((r) => r.code === roleCode)!;
      await withGrantBootstrap(client, async () => {
        const assignment = (
          await client.query<{ id: string }>(
            `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, purpose, created_by)
             select $1, $2, r.id, $4, date '2026-01-01', 'ACTIVE', $5, now(), $6, $7 from role r where r.company_id = $1 and r.code = $3 returning id`,
            [c, userId, roleCode, role.defaultScope, approver.id, PURPOSE, SYSTEM_ACTOR_ID],
          )
        ).rows[0]!.id;
        for (const key of role.defaultDuties) {
          const { resource, action, fieldGroup } = parsePermissionKey(key);
          await client.query(
            `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from)
             select $1, $2, p.id, true, date '2026-01-01' from permission p where p.resource = $3 and p.action = $4 and p.field_group = $5`,
            [c, assignment, resource, action, fieldGroup],
          );
        }
      });
    }
  }

  // The company's draft policies (from provisioning, authored by the system account) activated by the test HR account (author ≠ activator).
  const activated: string[] = [];
  for (const table of ['leave_policy', 'attendance_policy', 'expense_policy']) {
    const r = await client.query(`update ${table} set state = 'ACTIVE', activated_by = $2, activated_at = now() where company_id = $1 and state = 'DRAFT'`, [c, users.get('demo.hr@hrstop.test')]);
    activated.push(`${table}: ${r.rowCount}`);
  }

  await client.query('commit');
  console.log(JSON.stringify({
    company: companyCode,
    masters: { departments: DEPARTMENTS.length, locations: LOCATIONS.length, designations: DESIGNATIONS.length, grades: GRADES.length },
    employees: EMPLOYEES.length,
    holidays: LOCATIONS.length * HOLIDAYS.length,
    accounts: TEST_ACCOUNTS.map((a) => `${a.key}: ${a.roles.join(' + ')}${a.employee ? ` (${a.employee})` : ''}`),
    policiesActivated: activated,
  }, null, 1));
} catch (err) {
  await client.query('rollback').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
