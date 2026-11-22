// The organisation screens, as the navigation registry takes them.
import type { ScreenRoute } from '../../screens';
import { ORG_CHART_PERMISSION, OrgChartPage } from '../org-chart';
import { CitiesPage } from './cities';
import { CompanyPage } from './company';
import { DepartmentsPage, DesignationsPage, GradesPage, LocationsPage } from './masters';
import { MASTER_READ } from './shared';

export const ORG_SCREENS: readonly ScreenRoute[] = [
  { path: '/organisation/company', title: 'Company', permission: MASTER_READ, nav: true, component: CompanyPage },
  { path: '/organisation/chart', title: 'Organisation chart', permission: ORG_CHART_PERMISSION, nav: true, component: OrgChartPage },
  { path: '/organisation/departments', title: 'Departments', permission: MASTER_READ, nav: true, component: DepartmentsPage },
  { path: '/organisation/locations', title: 'Locations', permission: MASTER_READ, nav: true, component: LocationsPage },
  { path: '/organisation/designations', title: 'Designations', permission: MASTER_READ, nav: true, component: DesignationsPage },
  { path: '/organisation/grades', title: 'Grades', permission: MASTER_READ, nav: true, component: GradesPage },
  // CL-006 (0280): cities by state, one at a time or from a file.
  { path: '/organisation/cities', title: 'Cities', permission: MASTER_READ, nav: true, component: CitiesPage },
];
