// Every business module's registration data (see registry-types.ts). Add a module by importing its
// registration here; the baseline, provisioning and the app pick it up from MODULE_REGISTRATIONS.
import { announcementsRegistration } from './announcements/registration.js';
import { appraisalRegistration } from './appraisal/registration.js';
import { assetsRegistration } from './assets/registration.js';
import { documentExportRegistration } from './documents/export-registration.js';
import { documentsRegistration } from './documents/registration.js';
import { employeeRecordRegistration } from './employee/record-registration.js';
import { hiringRegistration } from './hiring/registration.js';
import { abscondingAuditRegistration } from './lifecycle/absconding-registration.js';
import { lifecycleRegistration } from './lifecycle/registration.js';
import { hrMailRegistration } from './notification/hr-mail-registration.js';
import { orgMastersRegistration } from './org/masters-registration.js';
import { payrollRegistration } from './payroll/registration.js';
import { payrollAdjustmentsRegistration } from './payroll-adjustments/registration.js';
import { payrollExtrasRegistration } from './payroll-extras/registration.js';
import { payrollOutputsRegistration } from './payroll-outputs/registration.js';
import type { ModuleRegistration } from './registry-types.js';
import { reportingRegistration } from './reporting/registration.js';
import { sensitiveChangeRegistration } from './sensitive-change/registration.js';
import { statutoryFilesRegistration } from './statutory-files/registration.js';
import { taxDeclarationsRegistration } from './tax-declarations/registration.js';
import { timesheetRegistration } from './timesheet/registration.js';
import { trainingRegistration } from './training/registration.js';

const ALL_MODULES: readonly ModuleRegistration[] = [
  sensitiveChangeRegistration,
  hiringRegistration,
  appraisalRegistration,
  trainingRegistration,
  timesheetRegistration,
  lifecycleRegistration,
  payrollRegistration,
  payrollOutputsRegistration,
  payrollAdjustmentsRegistration,
  taxDeclarationsRegistration,
  assetsRegistration,
  documentsRegistration,
  employeeRecordRegistration,
  reportingRegistration,
  // CL-005, CL-006, CL-010 (0280): the state, city and bank masters.
  orgMastersRegistration,
  // CL-027 (0281): employee documents exported to a ZIP.
  documentExportRegistration,
  // CL-041 (0282): HR sends one message to chosen employees by email.
  hrMailRegistration,
  // CL-052 (0283): absconding warnings and the absconding audit report.
  abscondingAuditRegistration,
  announcementsRegistration,
  // CL-074 to CL-119 batch R3 (0270): challans, perquisites and past salary, GL mapping and salary JV, provisions, EDOC export.
  payrollExtrasRegistration,
  // CL-093, CL-105 to CL-107 batch R4 (0300): statutory filing files behind active packs and accepted formats.
  statutoryFilesRegistration,
];

/** Modules being built that this run includes (HRMS_DRAFT_MODULES, comma-separated keys; never in production). */
const building = new Set(
  process.env.NODE_ENV === 'production'
    ? []
    : (process.env.HRMS_DRAFT_MODULES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
);

export const MODULE_REGISTRATIONS: readonly ModuleRegistration[] = ALL_MODULES.filter((m) => m.active || building.has(m.key));

export const isModuleActive = (key: string): boolean => MODULE_REGISTRATIONS.some((m) => m.key === key);
