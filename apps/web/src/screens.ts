import type { ComponentType } from 'react';

/**
 * A screen that a page module offers for navigation. Each wave-2 page file exports its screens (and its My ESS
 * panels); App.tsx routes them through screens-registry.ts. The server re-checks every call, so `permission` only
 * decides whether the menu shows the entry.
 */
export interface ScreenRoute {
  /** react-router path, e.g. '/hiring/requisitions/:id'. */
  path: string;
  /** Menu label; screens reached only through links (detail pages) set `nav: false`. */
  title: string;
  /** The menu shows the entry only when the session holds this permission key. */
  permission?: string;
  nav: boolean;
  component: ComponentType;
}

/** A My ESS tab panel (H3) a module renders inside the ESS hub, for the Employee OWN context. */
export interface EssPanel {
  /** H3 tab id, e.g. 'TN13'. */
  tabId: string;
  component: ComponentType;
}
