// Shared by the document screens: permission keys, screen paths and limits, the API's shapes and query keys.
import { type CSSProperties, useMemo } from 'react';
import { ApiError } from '../../api';
import { useSession } from '../../session';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/documents/registration.ts, policies.ts, mapping.ts) and screen paths
// ---------------------------------------------------------------------------------------------------------
/** GET /v1/company-policies, /:id and /v1/company-policy-versions/:id/content (every baseline role). */
export const POLICY_READ = 'company_policy.read.operational';
/** POST /v1/company-policies, /:id/versions and PATCH /:id (HR Administrator, unrestricted company scope). */
export const POLICY_MANAGE = 'company_policy.manage.operational';
/** A confidential policy, or a classification change to or from confidential, needs this group as well (ceiling only). */
export const POLICY_MANAGE_CONFIDENTIAL = 'company_policy.manage.confidential';
/** POST/GET /v1/documents/bulk-uploads; the mapping import needs it too (documents are confidential, DF02). */
export const DOCUMENT_UPLOAD = 'document.upload.document';
/** The mapping import is a batch import: /v1/documents/mapping-imports needs the import duty as well. */
export const EMPLOYEE_IMPORT = 'employee.import.operational';

export const PATHS = {
  policies: '/policies',
  policy: (id: string) => `/policies/${id}`,
  manage: '/documents/policies',
  managePolicy: (id: string) => `/documents/policies/${id}`,
  mapping: '/documents/bulk-mapping',
} as const;

/** The policy code POST /v1/company-policies accepts: an upper-case letter, then up to 39 of A-Z, 0-9 and _. */
export const POLICY_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
/** GET /v1/documents/bulk-uploads pages the caller's staged files, newest first: 25, 50 or 100 a page, with the total. */
export const STAGED_PAGE_SIZE = 25;
/** GET /v1/documents/mapping-imports pages: 25, 50 or 100 batches. */
export const BATCHES_PAGE_SIZE = 25;
export const FILE_ACCEPT = 'application/pdf,image/jpeg,image/png';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SCROLL: CSSProperties = { overflowX: 'auto' };
export const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

// ---------------------------------------------------------------------------------------------------------
// Types: exactly what the API returns (modules/documents/policies.ts and mapping.ts)
// ---------------------------------------------------------------------------------------------------------
export type Classification = 'OPERATIONAL' | 'CONFIDENTIAL';

/** The latest version the malware scan released, as GET /v1/company-policies lists it. */
interface CurrentVersion {
  id: string;
  versionNumber: number;
  fileName: string | null;
  mediaType: string;
  byteSize: number | null;
  expiresOn: string | null;
  expired: boolean;
  publishedAt: string;
}

export interface PolicyItem {
  id: string;
  policyCode: string;
  title: string;
  classification: Classification;
  version: number;
  latestVersionNumber: number | null;
  /** Null while no version has been released (all waiting for the scan, or quarantined). */
  currentVersion: CurrentVersion | null;
}

export interface PolicyVersion {
  id: string;
  versionNumber: number;
  fileName: string | null;
  mediaType: string;
  byteSize: number | null;
  expiresOn: string | null;
  expired: boolean;
  scanState: string | null;
  changeNote: string | null;
  publishedAt: string;
}

export interface PolicyDetail {
  id: string;
  policyCode: string;
  title: string;
  classification: Classification;
  /** The record version every change sends back as expectedVersion. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Newest first. */
  versions: PolicyVersion[];
}

/** POST /v1/company-policies (201) and POST /v1/company-policies/:id/versions (201). */
export interface Published {
  id: string;
  version: number;
  versionId: string;
  versionNumber: number;
  scanState: string | null;
}

export type StagedState = 'UNMAPPED' | 'MAPPED' | 'DISCARDED';

export interface StagedFile {
  id: string;
  fileName: string;
  mediaType: string;
  byteSize: number | null;
  scanState: string | null;
  state: StagedState;
  mappedDocumentId: string | null;
  mappedAt: string | null;
  discardedAt: string | null;
  uploadedAt: string;
}

/** GET /v1/documents/bulk-uploads?page=&pageSize=: one page of the caller's staged files and the total of that state. */
export interface StagedPage {
  items: StagedFile[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /v1/documents/mapping-imports: one of the caller's own batches, job facts only (GET /:id has the rows). */
interface MappingBatch {
  id: string;
  state: string;
  template: string | null;
  fileName: string | null;
  rowCount: number | null;
  acceptedCount: number;
  rejectedCount: number;
  scanState: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MappingBatchPage {
  items: MappingBatch[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and a list
 * answered to one assignment (a confidential policy included) must never be shown under another.
 */
export function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['documents', context] as const;
    return {
      policies: [...base, 'policies'] as const,
      policy: (id: string) => [...base, 'policy', id] as const,
      staged: [...base, 'staged'] as const,
      stagedIn: (state: string, page: number) => [...base, 'staged', state, page] as const,
      batches: [...base, 'mapping-batches'] as const,
      batchesPage: (page: number) => [...base, 'mapping-batches', page] as const,
    };
  }, [context]);
}

export const isNotFound = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.code === 'INVALID_REQUEST');
export const scanStateOf = (e: ApiError) => (e.details as { scanState?: string } | undefined)?.scanState;

