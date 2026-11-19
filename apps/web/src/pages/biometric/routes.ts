// The biometric screens, as the navigation registry takes them.
import type { ScreenRoute } from '../../screens';
import { BiometricEmployeeMappingPage } from './employee-mapping';
import { BiometricFieldMappingPage } from './field-mapping';
import { BiometricProfilesPage } from './profiles';
import { LINK_MANAGE, MAPPING_MANAGE, PROFILE_MANAGE, READ } from './shared';
import { BiometricSyncMonitorPage } from './sync-monitor';

export const BIOMETRIC_SCREENS: readonly ScreenRoute[] = [
  { path: '/biometric/profiles', title: 'API profiles', permission: PROFILE_MANAGE, nav: true, component: BiometricProfilesPage },
  { path: '/biometric/field-mapping', title: 'Field mapping', permission: MAPPING_MANAGE, nav: true, component: BiometricFieldMappingPage },
  { path: '/biometric/employee-mapping', title: 'Employee mapping', permission: LINK_MANAGE, nav: true, component: BiometricEmployeeMappingPage },
  { path: '/biometric/sync-monitor', title: 'Sync monitor', permission: READ, nav: true, component: BiometricSyncMonitorPage },
];
