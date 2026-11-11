// Statutory filing files, batch R4 (BRD coverage CL-093, CL-105, CL-106, CL-107; FR-036, FR-039, FR-107, FR-108; migration
// 0300_statutory_file_formats). Data only.
//
// DF02: an accepted statutory file format is company configuration (operational). Setting one up (payroll_statutory_format.define) and
// validating its sample and accepting or withdrawing it (payroll_statutory_format.accept) are a maker-checker pair, ceiling-only grants
// approved per assignment, never default duties: the HR Administrator may hold either, the Payroll Operator sets formats up and the
// Payroll Approver accepts them (the service and the database refuse the author's own acceptance). Reading the outputs, formats and
// samples is the existing payroll_statutory.read.operational. The files reuse the confidential report grants (payroll_report.read.amount,
// payroll_report.export.amount) and employee.read.payroll_id for the UAN and IP numbers; nothing new is confidential.
import type { ModuleRegistration } from '../registry-types.js';

export const statutoryFilesRegistration: ModuleRegistration = {
  key: 'statutory-files',
  active: true,
  transactionKinds: {},
  roleGrants: {
    HR_ADMINISTRATOR: { ceiling: ['payroll_statutory_format.define.operational', 'payroll_statutory_format.accept.operational'] },
    PAYROLL_OPERATOR: { ceiling: ['payroll_statutory_format.define.operational'] },
    PAYROLL_APPROVER: { ceiling: ['payroll_statutory_format.accept.operational'] },
  },
  operationalFieldGroups: [{ resource: 'payroll_statutory_format', fieldGroup: 'operational' }],
};
