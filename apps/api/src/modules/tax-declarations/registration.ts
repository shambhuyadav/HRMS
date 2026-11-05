// Tax declarations and investment proofs (FR-036 declaration checking; FR-108; H3 TN08, TN09; H1; BR-053; DF02). Migration
// 0128_tax_declarations. The `tax` group is confidential: the Employee OWN context holds own_tax for its own record (own-ESS),
// and review is a ceiling-only grant of the HR Administrator role, approved per assignment. The rule pack registry uses the
// payroll configuration duties. No tax is calculated, and until a rule pack is activated both tabs say NOT_CONFIGURED.
import type { ModuleRegistration } from '../registry-types.js';

export const taxDeclarationsRegistration: ModuleRegistration = {
  key: 'tax-declarations',
  active: true,
  // F2 "own pending requests": a submitted declaration or proof waits for the reviewer.
  transactionKinds: { tax_declaration: ['SUBMITTED'], tax_proof: ['SUBMITTED'] },
  roleGrants: {
    HR_ADMINISTRATOR: { ceiling: ['tax_declaration.read.tax', 'tax_declaration.review.tax'] },
    EMPLOYEE: { defaultDuties: ['own_tax.read.tax', 'own_tax.submit.tax'] },
  },
  workflows: [
    { kind: 'tax_declaration', steps: [{ sequence: 1, permission: 'tax_declaration.review.tax', selectionRule: 'HR_FALLBACK_LIST' }] },
    { kind: 'tax_proof', steps: [{ sequence: 1, permission: 'tax_declaration.review.tax', selectionRule: 'HR_FALLBACK_LIST' }] },
  ],
  notifications: [
    {
      code: 'TAX_ITEM_ASSIGNED',
      eventType: 'TAX_ITEM_ASSIGNED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'A {{item}} is waiting for your review',
      body: 'A {{item}} of {{employeeName}} ({{employeeCode}}) for {{fiscalPeriodCode}} is waiting for your review.',
      placeholders: ['item', 'employeeName', 'employeeCode', 'fiscalPeriodCode'],
    },
    {
      code: 'TAX_ITEM_DECIDED',
      eventType: 'TAX_ITEM_DECIDED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your {{item}} was {{outcome}}',
      body: 'Your {{item}} for {{fiscalPeriodCode}} was {{outcome}}. No tax is calculated from it here.',
      placeholders: ['item', 'fiscalPeriodCode', 'outcome'],
    },
  ],
  essTabs: [
    {
      tab: 'TN08',
      permissions: ['own_tax.read.tax', 'own_tax.submit.tax'],
      requiresConfiguration: 'TAX_RULE_PACK',
      links: [
        { rel: 'declarations', method: 'GET', href: '/v1/me/tax-declarations' },
        { rel: 'createDraft', method: 'POST', href: '/v1/me/tax-declarations' },
        { rel: 'decisionHistory', method: 'GET', href: '/v1/me/requests?kind=tax_declaration' },
      ],
    },
    {
      tab: 'TN09',
      permissions: ['own_tax.read.tax', 'own_tax.submit.tax'],
      requiresConfiguration: 'TAX_RULE_PACK',
      links: [
        { rel: 'proofs', method: 'GET', href: '/v1/me/tax-proofs' },
        { rel: 'submit', method: 'POST', href: '/v1/me/tax-proofs' },
        { rel: 'decisionHistory', method: 'GET', href: '/v1/me/requests?kind=tax_proof' },
      ],
    },
  ],
};
