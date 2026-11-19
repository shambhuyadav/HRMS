// Navigation exports of the asset module: its screens, its My ESS panel and its decision queue.

import type { ComponentType } from 'react';
import type { EssPanel, ScreenRoute } from '../../screens';
import { AssetDetailScreen } from './asset';
import { EmployeeAssetsScreen } from './employee-assets';
import { MyAssetsPanel } from './ess';
import { RegisterScreen } from './register';
import { CustodyRequestQueue, RequestsScreen } from './requests';
import { ASSET_MANAGE, ASSET_READ, PATHS, REQUEST_DECIDE } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires these)
// ---------------------------------------------------------------------------------------------------------

/**
 * Screens of the assets module; detail screens are reached through links (nav: false). The register's menu entry is
 * keyed to asset.manage (an Admin duty) rather than asset.read, which the Employee role also holds for its own items on
 * My ESS TN16; the screens themselves check asset.read, as the API does, and the API also requires an unrestricted
 * company-scope assignment for the register.
 */
export const ASSETS_SCREENS: ScreenRoute[] = [
  { path: PATHS.register, title: 'Asset register', permission: ASSET_MANAGE, nav: true, component: RegisterScreen },
  { path: '/assets/items/:id', title: 'Asset', permission: ASSET_READ, nav: false, component: AssetDetailScreen },
  { path: '/assets/employees/:id', title: 'Employee’s items', permission: ASSET_READ, nav: false, component: EmployeeAssetsScreen },
  { path: PATHS.requests, title: 'Custody requests', permission: REQUEST_DECIDE, nav: true, component: RequestsScreen },
];

/** H3 TN16 in the Employee OWN context (registration essTabs: own assets, acknowledgment, categories, requests). */
export const ASSETS_ESS_PANELS: EssPanel[] = [{ tabId: 'TN16', component: MyAssetsPanel }];

/** The custody-request decision queue (GET /v1/asset-requests/tasks/mine; asset_request.decide), also on the Custody requests screen. */
export const ASSETS_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: REQUEST_DECIDE, title: 'Custody requests', component: CustodyRequestQueue },
];
