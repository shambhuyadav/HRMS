// Payroll outputs on top of the payroll core: bank files and the salary payment ledger (FR-102; DB112-DB114, DB118;
// H2; BR-052; CI27; CI28; DF07), issued payslips (FR-107; DB117; TN06), payroll reports (FR-038) and statutory
// outputs reported NOT_CONFIGURED (FR-039), loans and advances (FR-034; TN15). Migrations 0045_payroll_outputs,
// 0046_payroll_loans and 0069_payroll_report_exports.
//
// DF02 / OQ27 (as in the payroll core, I-28): every confidential duty (manifest amounts, authorisation, the restricted
// bank file, outcomes, payslip previews and publication, registers) is a ceiling-only grant of the HR Administrator
// role, approved per assignment; never a default duty. The treasury roles keep their operational context: bank file
// template configuration (the treasury operator drafts, the treasury approver validates the sample and activates),
// with the confidential treasury duties held in an eligible Admin assignment. The Employee OWN context reads its own
// issued payslips (own-ESS group `payslip`, H1/BR-053) and reads and requests its own loans (own-ESS group `loan`,
// TN15); Form 16 (TN07) stays unavailable until an applicable statutory template exists (H8), so it is not declared.
// Tax declarations (TN08) and investment proofs (TN09) take their regime and categories only from an active tax rule
// pack (H3), which does not exist, so they are not declared and stay unavailable.
import type { ModuleRegistration } from '../registry-types.js';

export const payrollOutputsRegistration: ModuleRegistration = {
  key: 'payroll-outputs',
  active: true,
  transactionKinds: {},
  roleGrants: {
    HR_ADMINISTRATOR: {
      ceiling: [
        'payroll_bank_template.read.operational',
        'payroll_bank_template.manage.operational',
        'payroll_bank_template.validate.operational',
        'payroll_bank_template.activate.operational',
        'payroll_bank.read.amount',
        'payroll_bank.prepare.amount',
        'payroll_bank.authorize.amount',
        'payroll_bank.download.bank',
        'payroll_bank.record_outcome.amount',
        'payroll_output.read.amount',
        'payroll_output.publish.amount',
        'payroll_report.read.amount',
        // FR-038 / H7 exports of the register, disbursement and comparison (report catalogue; migration 0069).
        'payroll_report.export.amount',
        'payroll_statutory.read.operational',
        'payroll_loan.read.loan',
        'payroll_loan.request.loan',
        'payroll_loan.decide.loan',
        'payroll_loan.disburse.loan',
        'payroll_loan.recover.loan',
      ],
    },
    TREASURY_OPERATOR: {
      defaultDuties: ['payroll_bank_template.read.operational', 'payroll_statutory.read.operational'],
      ceiling: ['payroll_bank_template.manage.operational'],
    },
    TREASURY_APPROVER: {
      defaultDuties: ['payroll_bank_template.read.operational', 'payroll_statutory.read.operational'],
      ceiling: ['payroll_bank_template.validate.operational', 'payroll_bank_template.activate.operational'],
    },
    PAYROLL_OPERATOR: { defaultDuties: ['payroll_statutory.read.operational'] },
    PAYROLL_APPROVER: { defaultDuties: ['payroll_statutory.read.operational'] },
    FINANCE_REVIEWER: { defaultDuties: ['payroll_bank_template.read.operational', 'payroll_statutory.read.operational'] },
    // H1 / BR-053 own-ESS: the employee's own issued payslips only (H3 TN06).
    EMPLOYEE: { defaultDuties: ['payslip.read.payslip', 'own_loan.read.loan', 'own_loan.request.loan'] },
  },
  operationalFieldGroups: [
    { resource: 'payroll_bank_template', fieldGroup: 'operational' },
    { resource: 'payroll_statutory', fieldGroup: 'operational' },
  ],
  // H7: payslip publication notice (period only; never amounts, bank values or document content).
  notifications: [
    {
      code: 'PAYSLIP_PUBLISHED',
      eventType: 'PAYSLIP_PUBLISHED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your payslip for {{periodCode}} is available',
      body: 'Your payslip for {{periodCode}} (version {{version}}) has been published. Publication does not mean the salary has been paid.',
      placeholders: ['periodCode', 'version'],
    },
  ],
  essTabs: [
    {
      tab: 'TN06',
      permissions: ['payslip.read.payslip'],
      links: [
        { rel: 'payslips', method: 'GET', href: '/v1/me/payslips' },
        { rel: 'download', method: 'GET', href: '/v1/me/payslips/{payslipId}/file' },
        // H7: own hold status only (period, state, dates), never the reason or an amount beyond the payslip.
        { rel: 'holdStatus', method: 'GET', href: '/v1/me/payroll-holds' },
      ],
    },
    {
      tab: 'TN15',
      permissions: ['own_loan.read.loan', 'own_loan.request.loan'],
      links: [
        { rel: 'loans', method: 'GET', href: '/v1/me/loans' },
        { rel: 'request', method: 'POST', href: '/v1/me/loans' },
        { rel: 'withdraw', method: 'POST', href: '/v1/me/loans/{loanId}/withdraw' },
      ],
    },
  ],
};
