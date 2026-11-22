// Shared by the settlement settings screen: permission keys, paths and limits, the API's shapes, labels, query keys and layout classes.
import { useMemo } from 'react';
import { useSession } from '../../session';
import { RATE_BASIS_LABEL } from '../lifecycle-documents';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/lifecycle/settlement-calculation-routes.ts; payroll and lifecycle registrations; migration 0235) and paths
// ---------------------------------------------------------------------------------------------------------
export const POLICY_READ = 'payroll_config.read.operational';
export const POLICY_MANAGE = 'payroll_config.manage.operational';
export const POLICY_ACTIVATE = 'payroll_config.activate.operational';
export const PACK_READ = 'statutory_pack.read.operational';
export const PACK_VALIDATE = 'statutory_pack.validate.operational';
export const PACK_ACTIVATE = 'statutory_pack.activate.operational';
export const SETTLEMENT_READ = 'settlement.read.operational';

export const PATH = '/lifecycle/settlement-settings';
export const SETTLEMENTS_PATH = '/lifecycle/settlements';

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A cap of units (settlement-policy.ts): up to 4 digits and 4 decimal places. */
export const CAP = /^\d{1,4}(\.\d{1,4})?$/;
export const MAX_CODE = 40;
export const MAX_REFERENCE = 500;
export const MAX_ENCASHABLE = 50;

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/lifecycle/settlement-policy.ts, modules/statutory/rule-packs.ts)
// ---------------------------------------------------------------------------------------------------------
export interface PolicyDefaults {
  encashmentRateBasis: string;
  encashmentDivisor: number;
  noticeRateBasis: string;
  noticeDivisor: number;
  encashableMaxUnits: string;
}

export interface PolicyRevision {
  id: string;
  revision: number;
  effectiveFrom: string;
  basicComponentCode: string;
  daComponentCode: string | null;
  encashmentComponentCode: string | null;
  encashmentRateBasis: string;
  encashmentDivisor: number;
  noticeComponentCode: string | null;
  noticeRateBasis: string;
  noticeDivisor: number;
  gratuityComponentCode: string | null;
  encashable: { leaveType: string; maxUnits: string }[];
  /** DRAFT, ACTIVE, SUPERSEDED or CANCELLED. */
  state: string;
  createdBy: string | null;
  activatedBy: string | null;
  activatedAt: string | null;
  version: number;
}

export interface PolicyList {
  defaults: PolicyDefaults;
  rateBases: string[];
  items: PolicyRevision[];
}

export interface PackRevision {
  id: string;
  code: string;
  revision: number;
  effectiveFrom: string;
  currencyCode: string;
  parameters: Record<string, unknown>;
  statuteReference: string;
  sourceReference: string | null;
  validationReference: string | null;
  /** DRAFT, VALIDATED, ACTIVE or RETIRED. */
  state: string;
  createdBy: string | null;
  validatedBy: string | null;
  validatedAt: string | null;
  activatedBy: string | null;
  activatedAt: string | null;
  version: number;
}

export interface PackList {
  definitions: { code: string; title: string }[];
  items: PackRevision[];
}

// ---------------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------------
export const POLICY_STATE_LABEL: Record<string, string> = {
  DRAFT: 'Draft: not in force until someone else activates it',
  ACTIVE: 'Active',
  SUPERSEDED: 'Superseded',
  CANCELLED: 'Cancelled',
};
export const POLICY_TONE: Record<string, 'good' | 'warn' | 'bad'> = { DRAFT: 'warn', ACTIVE: 'good' };
export const PACK_TONE: Record<string, 'good' | 'warn' | 'bad'> = { DRAFT: 'warn', VALIDATED: 'warn', ACTIVE: 'good' };
export const RATE_BASES = Object.keys(RATE_BASIS_LABEL);

/** Query keys carry the selected company and assignment (as lifecycle-documents.tsx useKeys): one cache across role switches. */
export function useSettingsKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(
    () => ({
      policies: ['settlement-settings', context, 'policies'] as const,
      packs: ['settlement-settings', context, 'statutory-packs'] as const,
    }),
    [context],
  );
}

// ---------------------------------------------------------------------------------------------------------
// Layout pieces, as utility classes (shadcn/ui move, 20 Nov 2026). The shared helpers (FormField, Hint, Table …) cover fields, hints
// and tables; these cover the headings, rows of fields, widths and links this screen has and they do not.
// ---------------------------------------------------------------------------------------------------------
/** A revision's heading inside its list item. */
export const ITEM_HEADING = 'my-1 text-[0.95rem]';
/** Fields of one group side by side in columns at least 210px wide, their bottoms lined up (the old `.row` of fields). */
export const FIELD_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] items-end gap-[0.95rem_1.1rem]';
/** An encashable leave type's two fields and its remove button side by side, wrapping on a narrow screen; each FormField is `w-auto`. */
export const FIELD_ROW = 'flex flex-wrap items-end gap-x-[1.1rem] gap-y-[0.95rem]';
/** A reference field keeps a readable width in a one-column form, as the old `.stack > label > input` rule had it. */
export const READABLE_WIDTH = 'max-w-[560px]';
/** Links side by side under the page's title (the old `p.row`). */
export const LINK_ROW = 'flex flex-wrap items-center gap-x-4 gap-y-1';
