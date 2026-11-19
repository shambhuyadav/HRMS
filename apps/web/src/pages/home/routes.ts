// Navigation exports of the home pages: the screen of the records behind a dashboard figure.

import type { ScreenRoute } from '../../screens';
import { WidgetSourcePage } from './dashboard';

export const HOME_SCREENS: readonly ScreenRoute[] = [{ path: '/dashboard/sources/:code', title: 'Records behind a dashboard figure', permission: 'dashboard.read.operational', nav: false, component: WidgetSourcePage }];
