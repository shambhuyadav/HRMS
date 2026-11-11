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
    // CL-007 qualification master (0280): common qualification names, offered as suggestions where the section takes a qualification
    // (the entry keeps it as text, so an earlier entry keeps its meaning and a name the list lacks can still be recorded).
    QUALIFICATION: {
      ITI: 'ITI certificate',
      DIPLOMA_ENGINEERING: 'Diploma in Engineering',
      BA: 'B.A.',
      BCOM: 'B.Com',
      BSC: 'B.Sc',
      BBA: 'BBA',
      BCA: 'BCA',
      BE: 'B.E.',
      BTECH: 'B.Tech',
      BED: 'B.Ed',
      LLB: 'LL.B',
      MBBS: 'MBBS',
      MA: 'M.A.',
      MCOM: 'M.Com',
      MSC: 'M.Sc',
      MBA: 'MBA',
      MCA: 'MCA',
      ME: 'M.E.',
      MTECH: 'M.Tech',
      PHD: 'Ph.D',
      CA: 'Chartered Accountant (CA)',
      CS: 'Company Secretary (CS)',
      CMA: 'Cost and Management Accountant (CMA)',
    },
  },
  // Served as form choices to whoever maintains the sections.
  referenceReaders: { FAMILY_RELATIONSHIP: 'employee.manage.private', QUALIFICATION_LEVEL: 'employee.manage.private', QUALIFICATION: 'employee.manage.private' },
};
