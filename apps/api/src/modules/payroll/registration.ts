// Payroll calculation, freeze and holds (FR-028 to FR-033, FR-037 as overridden by FR-099 and H2, FR-101; DF05; H2).
// Migration 0043_payroll.
//
// DF02 (v8.2) / OQ27: restricted payroll duties run in a separately approved HR Administrator assignment with an
// exact allowlist; every confidential group (run amounts, inputs, stops, holds and criteria) is a ceiling-only grant
// of that role, approved per assignment, never a default duty. The payroll, finance and treasury roles of the
// baseline keep their operational context: configuration and run status (no amounts). The Employee role gets nothing
// here: calculation previews are never shown to employees (FR-107); own issued outputs and loans belong to the
// payroll-outputs module (TN06, TN15) and own tax records to tax-declarations (TN08, TN09). The daily hold review job is
// holds.ts runPayrollHoldReviews(db, companyId, localDate, systemUserId), wired into the scheduler by the integrator.
import type { ModuleRegistration } from '../registry-types.js';

export const payrollRegistration: ModuleRegistration = {
  key: 'payroll',
  active: true,
  // Processes about employees and company payroll, never an employee's own request.
  transactionKinds: {
    payroll_run: null,
    payroll_run_approval: null,
    payroll_record_cover: null,
    payroll_input_batch: null,
    payroll_salary_stop: null,
    payroll_hold: null,
  },
  roleGrants: {
    HR_ADMINISTRATOR: {
      ceiling: [
        'payroll_config.read.operational',
        'payroll_config.manage.operational',
        'payroll_config.activate.operational',
        'payroll_run.read.operational',
        'payroll_run.read.amount',
        'payroll_run.prepare.amount',
        'payroll_run.review.amount',
        'payroll_run.approve.amount',
        'payroll_run.process.amount',
        'payroll_run.cancel.amount',
        'payroll_input.read.amount',
        'payroll_input.prepare.amount',
        'payroll_input.approve.amount',
        'payroll_stop.read.hold',
        'payroll_stop.propose.hold',
        'payroll_stop.decide.hold',
        'payroll_hold.read.hold',
        'payroll_hold.propose.hold',
        'payroll_hold.decide.hold',
        'payroll_hold.release.hold',
        'payroll_hold.define_criterion.hold',
        'payroll_hold.activate_criterion.hold',
      ],
    },
    // C2 operational contexts (DF02: "Finance/Payroll/Treasury role dashboards remain operational and non-confidential"):
    // configuration and run status (periods, revision, state, counts), never amounts; configuration changes are granted
    // per assignment. Treasury sees which runs are processed, ahead of the bank-file stage (payroll-outputs).
    PAYROLL_OPERATOR: { defaultDuties: ['payroll_config.read.operational', 'payroll_run.read.operational'], ceiling: ['payroll_config.manage.operational'] },
    PAYROLL_APPROVER: { defaultDuties: ['payroll_config.read.operational', 'payroll_run.read.operational'], ceiling: ['payroll_config.activate.operational'] },
    FINANCE_REVIEWER: { defaultDuties: ['payroll_run.read.operational'] },
    TREASURY_OPERATOR: { defaultDuties: ['payroll_run.read.operational'] },
    TREASURY_APPROVER: { defaultDuties: ['payroll_run.read.operational'] },
  },
  operationalFieldGroups: [
    { resource: 'payroll_config', fieldGroup: 'operational' },
    { resource: 'payroll_run', fieldGroup: 'operational' },
  ],
  // DF03: independent reviewers from explicit lists. Runs are reviewed, then approved in a separate stage (its own
  // transaction, excluding preparer and reviewer); covering approvals share the run approvers' list.
  workflows: [
    { kind: 'payroll_run', steps: [{ sequence: 1, permission: 'payroll_run.review.amount', selectionRule: 'HR_FALLBACK_LIST' }] },
    { kind: 'payroll_run_approval', steps: [{ sequence: 1, permission: 'payroll_run.approve.amount', selectionRule: 'HR_FALLBACK_LIST' }] },
    { kind: 'payroll_record_cover', steps: [{ sequence: 1, permission: 'payroll_run.approve.amount', selectionRule: 'HR_FALLBACK_LIST' }] },
    { kind: 'payroll_input_batch', steps: [{ sequence: 1, permission: 'payroll_input.approve.amount', selectionRule: 'HR_FALLBACK_LIST' }] },
    { kind: 'payroll_salary_stop', steps: [{ sequence: 1, permission: 'payroll_stop.decide.hold', selectionRule: 'HR_FALLBACK_LIST' }] },
    { kind: 'payroll_hold', steps: [{ sequence: 1, permission: 'payroll_hold.decide.hold', selectionRule: 'HR_FALLBACK_LIST' }] },
  ],
  // DF04 controlled lists. Tax treatment is recorded as the company declares it (never computed here); input kinds
  // classify FR-031 inputs. Companies add their own values.
  referenceValues: {
    PAYROLL_TAX_TREATMENT: {
      TAXABLE: 'Taxable (as declared by the company)',
      NON_TAXABLE: 'Not taxable (as declared by the company)',
      PER_TAX_RULE_PACK: 'Treatment set by the tax rule pack',
      // I-90 follow-up: the HRA exemption (s.10(13A), rule 2A) computed by the INCOME_TAX pack, in the old regime, from these two.
      HRA_RULE_2A: 'House rent allowance: taxable, less the exemption the income tax pack computes (s.10(13A))',
      SALARY_FOR_HRA: 'Taxable, and salary (Basic and DA) for the house rent allowance exemption and the employer NPS limit',
    },
    PAYROLL_INPUT_KIND: {
      VARIABLE_PAYMENT: 'Variable payment',
      OTHER_INPUT: 'Other approved payroll input',
    },
  },
  // The form choices of those lists (GET /v1/reference-values), under the permission of the form that takes the code:
  // the payroll head revision (tax treatment) and the input batch entry (input kind).
  referenceReaders: {
    PAYROLL_TAX_TREATMENT: 'payroll_config.manage.operational',
    PAYROLL_INPUT_KIND: 'payroll_input.prepare.amount',
  },
  // DF12 / H7: period, revision, step, employee identity and outcome only; never amounts, reasons or bank values.
  notifications: [
    {
      code: 'PAYROLL_RUN_ASSIGNED',
      eventType: 'PAYROLL_RUN_ASSIGNED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Payroll run waiting for your {{step}}',
      body: 'Revision {{revision}} of the {{periodCode}} payroll run is waiting for your {{step}}.',
      placeholders: ['step', 'revision', 'periodCode'],
    },
    {
      code: 'PAYROLL_RUN_RETURNED',
      eventType: 'PAYROLL_RUN_RETURNED',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Payroll run {{periodCode}} returned',
      body: 'Revision {{revision}} of the {{periodCode}} payroll run was returned; revision {{newRevision}} is open as a draft.',
      placeholders: ['revision', 'newRevision', 'periodCode'],
    },
    {
      code: 'PAYROLL_RUN_PROCESSED',
      eventType: 'PAYROLL_RUN_PROCESSED',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Payroll run {{periodCode}} processed',
      body: 'Revision {{revision}} of the {{periodCode}} payroll run was processed and locked.',
      placeholders: ['revision', 'periodCode'],
    },
    {
      code: 'PAYROLL_INPUTS_ASSIGNED',
      eventType: 'PAYROLL_INPUTS_ASSIGNED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Payroll inputs waiting for your decision',
      body: 'A batch of {{lineCount}} payroll inputs for {{periodCode}} is waiting for your decision.',
      placeholders: ['lineCount', 'periodCode'],
    },
    {
      code: 'PAYROLL_INPUTS_DECIDED',
      eventType: 'PAYROLL_INPUTS_DECIDED',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Payroll inputs {{outcome}}',
      body: 'Your batch of {{lineCount}} payroll inputs for {{periodCode}} was {{outcome}}.',
      placeholders: ['lineCount', 'periodCode', 'outcome'],
    },
    {
      code: 'PAYROLL_SALARY_STOP_ASSIGNED',
      eventType: 'PAYROLL_SALARY_STOP_ASSIGNED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Salary stop waiting for your decision',
      body: 'A salary stop for {{employeeName}} ({{employeeCode}}) for {{periodCode}} is waiting for your decision.',
      placeholders: ['employeeName', 'employeeCode', 'periodCode'],
    },
    {
      code: 'PAYROLL_HOLD_ASSIGNED',
      eventType: 'PAYROLL_HOLD_ASSIGNED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Salary hold waiting for your decision',
      body: 'A salary hold for {{employeeName}} ({{employeeCode}}) for {{periodCode}} is waiting for your decision.',
      placeholders: ['employeeName', 'employeeCode', 'periodCode'],
    },
    {
      code: 'PAYROLL_HOLD_STATUS',
      eventType: 'PAYROLL_HOLD_STATUS',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your {{periodCode}} salary payment',
      body: 'Payment of your {{periodCode}} salary {{outcome}}.',
      placeholders: ['periodCode', 'outcome'],
    },
    {
      code: 'PAYROLL_HOLD_REMINDER',
      eventType: 'PAYROLL_HOLD_REMINDER',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Salary hold decision waiting',
      body: 'The salary hold decision for {{employeeCode}} ({{periodCode}}) is still waiting for you.',
      placeholders: ['employeeCode', 'periodCode'],
    },
    {
      code: 'PAYROLL_HOLD_REVIEW_DUE',
      eventType: 'PAYROLL_HOLD_REVIEW_DUE',
      selector: 'FALLBACK_REVIEWERS',
      optional: false,
      subject: 'Salary hold needs review',
      body: 'The salary hold for {{employeeCode}} ({{periodCode}}) is unresolved and needs review.',
      placeholders: ['employeeCode', 'periodCode'],
    },
    {
      code: 'PAYROLL_HOLD_ESCALATION',
      eventType: 'PAYROLL_HOLD_ESCALATION',
      selector: 'FALLBACK_REVIEWERS',
      optional: false,
      subject: 'Salary hold unresolved',
      body: 'The salary hold for {{employeeCode}} ({{periodCode}}) has been unresolved for {{waitingDays}} business days.',
      placeholders: ['employeeCode', 'periodCode', 'waitingDays'],
    },
  ],
};
