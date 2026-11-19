// The payroll extras screens, as the navigation registry takes them.
import type { ScreenRoute } from '../../screens';
import { ChallanMasterPage } from './challan-master';
import { EdocExportPage } from './edoc-export';
import { LiabilityProvisionsPage } from './liability-provisions';
import { MedicalClaimsPage } from './medical-claims';
import { SalaryJvPage } from './salary-jv';
import { CHALLAN_READ, EDOC_EXPORT, MAPPING_READ, MEDICAL_READ, REPORT_READ, TAX_READ } from './shared';
import { TaxInputsPage } from './tax-inputs';
import { TdsChallansPage } from './tds-challans';

export const PAYROLL_EXTRAS_SCREENS: readonly ScreenRoute[] = [
  { path: '/payroll/challan-master', title: 'Challan master', permission: CHALLAN_READ, nav: true, component: ChallanMasterPage },
  { path: '/payroll/tds-challans', title: 'TDS challans', permission: CHALLAN_READ, nav: true, component: TdsChallansPage },
  { path: '/payroll/tax-inputs', title: 'Perquisites and past salary', permission: TAX_READ, nav: true, component: TaxInputsPage },
  { path: '/payroll/medical-claims', title: 'Medical claims', permission: MEDICAL_READ, nav: true, staffOnly: true, component: MedicalClaimsPage },
  { path: '/payroll/liability-provisions', title: 'Liability provisions', permission: REPORT_READ, nav: true, component: LiabilityProvisionsPage },
  { path: '/payroll/salary-jv', title: 'GL mapping and salary JV', permission: MAPPING_READ, nav: true, component: SalaryJvPage },
  { path: '/payroll/edoc-export', title: 'Export payslips for EDOC', permission: EDOC_EXPORT, nav: true, component: EdocExportPage },
];
