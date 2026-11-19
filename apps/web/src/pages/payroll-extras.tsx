// Payroll inputs and reports, batch R3 (BRD coverage CL-074 challan master, CL-081 TDS challans, CL-084 / CL-119 past salary, CL-085
// perquisites, CL-097 GL mapping and salary JV, CL-098 liability provisions, CL-100 export for EDOC, CL-113 medical claims; FR-028 to
// FR-039). Every screen re-checks its own keys and the server re-checks every call. Uploads use the shared batch screens (records.tsx):
// a preview first, then an explicit commit, all or nothing. Figures the server cannot work out from configured rules arrive as
// NOT_CONFIGURED with the reason, and the screens show the reason, never a number.
//
// The code is in ./payroll-extras/: one module per screen (challan-master, tds-challans, tax-inputs, medical-claims,
// liability-provisions, salary-jv, edoc-export), shared.ts (permission keys and formatting helpers), upload.tsx (the upload
// panel and its templates), and routes.ts. This entry module re-exports what other modules import from it.
export { ChallanMasterPage } from './payroll-extras/challan-master';
export { EdocExportPage } from './payroll-extras/edoc-export';
export { LiabilityProvisionsPage } from './payroll-extras/liability-provisions';
export { MedicalClaimsPage } from './payroll-extras/medical-claims';
export { PAYROLL_EXTRAS_SCREENS } from './payroll-extras/routes';
export { parseMappingLines, SalaryJvPage } from './payroll-extras/salary-jv';
export { fiscalYearOf } from './payroll-extras/shared';
export { TaxInputsPage } from './payroll-extras/tax-inputs';
export { TdsChallansPage } from './payroll-extras/tds-challans';
export { PAST_SALARY_TEMPLATE, PERQUISITES_TEMPLATE, TDS_CHALLAN_TEMPLATE } from './payroll-extras/upload';
