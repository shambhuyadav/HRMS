// Navigation exports of the employee module: its screens.

import type { ScreenRoute } from '../../screens';
import { NewEmployeePage } from './new-employee';
import { EmployeeRecordPage } from './record-page';
import { EMPLOYEE_CREATE, EMPLOYEE_READ } from './shared';

export const EMPLOYEE_SCREENS: readonly ScreenRoute[] = [
  // The static path wins over /employees/:id in react-router, whatever the order here.
  { path: '/employees/new', title: 'New employee', permission: EMPLOYEE_CREATE, nav: true, component: NewEmployeePage },
  { path: '/employees/:id', title: 'Employee record', permission: EMPLOYEE_READ, nav: false, component: EmployeeRecordPage },
];
