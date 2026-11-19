// The document screens, as the navigation registry takes them.
import type { ComponentType } from 'react';
import type { EssPanel, ScreenRoute } from '../../screens';
import { BulkMappingScreen } from './bulk-mapping';
import { DOCUMENT_EXPORT, DocumentExportScreen, EXPORT_PATH } from './document-export';
import { ManagePoliciesScreen, ManagePolicyScreen } from './manage-policies';
import { MandatoryDocumentsScreen, REQUIREMENT_READ, REQUIREMENTS_PATH } from './mandatory-documents';
import { PoliciesScreen, PolicyScreen } from './policies';
import { DOCUMENT_UPLOAD, PATHS, POLICY_MANAGE, POLICY_READ } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Registry exports (screens.ts types; screens-registry.ts)
// ---------------------------------------------------------------------------------------------------------
export const DOCUMENTS_SCREENS: ScreenRoute[] = [
  { path: PATHS.policies, title: 'Company policies', permission: POLICY_READ, nav: true, component: PoliciesScreen },
  { path: '/policies/:id', title: 'Company policy', permission: POLICY_READ, nav: false, component: PolicyScreen },
  { path: PATHS.manage, title: 'Policy upload', permission: POLICY_MANAGE, nav: true, component: ManagePoliciesScreen },
  { path: '/documents/policies/:id', title: 'Manage company policy', permission: POLICY_MANAGE, nav: false, component: ManagePolicyScreen },
  { path: PATHS.mapping, title: 'Bulk document mapping', permission: DOCUMENT_UPLOAD, nav: true, staffOnly: true, component: BulkMappingScreen },
  // CL-150 (0261): the mandatory document types and the compliance report.
  { path: REQUIREMENTS_PATH, title: 'Mandatory documents', permission: REQUIREMENT_READ, nav: true, component: MandatoryDocumentsScreen },
  // CL-027 (0281): employee documents exported to a ZIP, with the export log.
  { path: EXPORT_PATH, title: 'Export documents', permission: DOCUMENT_EXPORT, nav: true, component: DocumentExportScreen },
];

/** H3 has no company-policy tab (TN01–TN18), so employees read policies on the Company policies screen instead. */
export const DOCUMENTS_ESS_PANELS: EssPanel[] = [];

/** Policies and document mapping route no decision to a reviewer, so the module has no decision queue. */
export const DOCUMENTS_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [];
