// Employee record sections (FR-007, FR-008; I-82 item 2, decided under owner delegation, 6 Nov 2026; migration 0191): role
// grants and the controlled lists the sections use. Data only. The routes are the employee module's own (employee/routes.ts).
import type { ModuleRegistration } from '../registry-types.js';

export const employeeRecordRegistration: ModuleRegistration = {
  key: 'employee-record',
  active: true,
  roleGrants: {
    // DF02/DF04: confidential maintenance and exports belong to an eligible Admin assignment with an independently approved
    // grant (ceiling only, never a default duty). Reading employee.private is the sensitive-change module's existing grant.
    HR_ADMINISTRATOR: { ceiling: ['employee.manage.private', 'employee.read.payroll_id', 'employee.manage.payroll_id', 'employee.export.private'] },
  },
  // DF04 controlled lists (FR-008 "unknown master references fail validation before save"); a company maintains its own
  // (reference/maintenance.ts). Common Indian HR choices, including the parents-in-law many group insurance covers name.
  referenceValues: {
    FAMILY_RELATIONSHIP: {
      SPOUSE: 'Spouse',
      CHILD: 'Child',
      FATHER: 'Father',
      MOTHER: 'Mother',
      FATHER_IN_LAW: 'Father-in-law',
      MOTHER_IN_LAW: 'Mother-in-law',
      SIBLING: 'Brother or sister',
      OTHER: 'Other',
    },
    QUALIFICATION_LEVEL: {
      SECONDARY: 'Secondary (class 10)',
      HIGHER_SECONDARY: 'Higher secondary (class 12)',
      DIPLOMA: 'Diploma',
      GRADUATE: 'Bachelor’s degree',
      POSTGRADUATE: 'Master’s degree',
      DOCTORATE: 'Doctorate',
      CERTIFICATION: 'Professional certification',
      OTHER: 'Other',
    },
  },
  // Served as form choices to whoever maintains the sections.
  referenceReaders: { FAMILY_RELATIONSHIP: 'employee.manage.private', QUALIFICATION_LEVEL: 'employee.manage.private' },
};
