// Shared parts of the payroll configuration screens: keys, shapes, labels, the choice and activation controls, data hooks.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { api, retryTransient } from '../../api';
import { useSession } from '../../session';
import { CONFIG_READ, useKeys } from './shared';

// =========================================================================================================
// Payroll configuration (FR-028 to FR-030, FR-032; DF05; H2; I-28): calendars and their periods, the paid-day
// policy, pay components and their head revisions, and the salary components of an arrangement. No default exists
// on purpose, so nothing is prefilled: every business value is the company's own choice. Each draft is activated by
// someone other than its author; the server checks every rule and its refusals are explained in words.
// =========================================================================================================

export const CONFIG_MANAGE = 'payroll_config.manage.operational';
export const CONFIG_ACTIVATE = 'payroll_config.activate.operational';
export const SALARY_READ = 'salary.read.salary';
export const SALARY_MANAGE = 'salary.manage.salary';

export interface CalendarPeriod {
  id: string;
  periodCode: string;
  financialYear: string;
  serviceStart: string;
  serviceEnd: string;
  inputCutoff: string;
  paymentDate: string;
  version: number;
}
export interface CalendarDetail {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  currencyMinorUnit: number;
  state: string;
  createdBy: string | null;
  activatedAt: string | null;
  version: number;
  periods: CalendarPeriod[];
}
export interface PayComponent {
  id: string;
  code: string;
  name: string;
  componentKind: string;
  active: boolean;
  headInEffect: { revisionId: string; revision: number; effectiveFrom: string; inUse: boolean; headType: string | null; calculationBasis: string | null } | null;
}
export interface HeadRevision {
  id: string;
  componentCode: string;
  componentName: string;
  componentKind: string;
  revision: number;
  effectiveFrom: string;
  inUse: boolean;
  headType: string | null;
  calculationBasis: string | null;
  roundingRule: string | null;
  taxTreatment: string | null;
  rulePackCode: string | null;
  displaySequence: number | null;
  baseComponentCodes: string[];
  state: string;
  createdBy: string | null;
  version: number;
}
export interface PaidDayPolicy {
  id: string;
  revision: number;
  effectiveFrom: string;
  attendanceBasis: string;
  absentUnpaidUnits: string | null;
  halfDayUnpaidUnits: string | null;
  state: string;
  createdBy: string | null;
  version: number;
}
export interface SalaryArrangementRow {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  annualCtc?: string | null;
  monthlyGross?: string | null;
  currency: string;
}
export interface ArrangementComponents {
  arrangementId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  annualCtc?: string | null;
  monthlyGross?: string | null;
  currencyCode: string;
  components: { componentCode: string; componentName: string; componentKind: string; amount: string; basis: string }[];
  totals: { basis: string; componentKind: string; total: string }[];
}

export const CONFIG_STATE: Record<string, string> = { DRAFT: 'Draft, not active', ACTIVE: 'Active', SUPERSEDED: 'Superseded by a correction', CANCELLED: 'Cancelled', RETIRED: 'Retired' };
export const COMPONENT_KIND: Record<string, string> = { EARNING: 'Earning', DEDUCTION: 'Deduction' };
export const CALCULATION_BASIS: Record<string, string> = { FIXED: 'Fixed (from the salary components)', INPUT: 'From approved inputs', RULE_PACK: 'Rule pack' };
export const ROUNDING: Record<string, string> = { HALF_UP_MINOR_UNIT: 'Half up to the nearest paisa' };
export const HEAD_USE: Record<string, string> = { IN_USE: 'In use from this date', DISCONTINUED: 'Discontinued from this date' };
export const AMOUNT_BASIS: Record<string, string> = { MONTHLY: 'Monthly', ANNUAL: 'Annual' };
export const ATTENDANCE_BASIS: Record<string, string> = { APPROVED_LEAVE_ONLY: 'Approved unpaid leave only', REVIEWED_ATTENDANCE: 'Approved unpaid leave and reviewed attendance' };
export const MINOR_UNITS: Record<string, string> = { '0': '0 decimals', '1': '1 decimal', '2': '2 decimals', '3': '3 decimals', '4': '4 decimals' };
/** The PAYROLL_TAX_TREATMENT values the module registers; a company may add its own (no payroll route lists them). */
export const TAX_TREATMENTS = ['TAXABLE', 'NON_TAXABLE', 'PER_TAX_RULE_PACK'];
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const UNITS = /^\d(\.\d{1,2})?$/;
export const RULE_PACK_BLOCKS = 'Blocks calculation until a rule pack exists: no rule pack is configured, so every employee this head applies to is blocked until the head is left out through a new revision.';
export const NOT_CONFIG = 'The selected role cannot see the payroll configuration.';

/** A choice the user must make: it starts empty, because no default exists. */
export function Choice({ label: text, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Record<string, string> }) {
  return (
    <FormField>
      {text}
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {Object.entries(options).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
}

/**
 * Independent activation of a draft: never offered to its author (the server refuses that too). It is a row action in the lists of
 * drafts, and the calendar's own page uses the same small button.
 */
export function ActivateControl({ state, createdBy, name, busy, onActivate }: { state: string; createdBy: string | null; name: string; busy: boolean; onActivate: () => void }) {
  const { me } = useSession();
  if (state !== 'DRAFT') return <>—</>;
  if (createdBy !== null && createdBy === me?.userId) return <>You wrote it: someone else activates it</>;
  return (
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onActivate} aria-label={`Activate ${name}`}>
      Activate
    </Button>
  );
}

export function useCalendars() {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({ queryKey: keys.calendars, queryFn: () => api<{ items: CalendarDetail[] }>('/v1/payroll/calendars'), enabled: can(CONFIG_READ), retry: retryTransient });
}

export function usePayComponents() {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({ queryKey: keys.payComponents, queryFn: () => api<{ items: PayComponent[] }>('/v1/payroll/components'), enabled: can(CONFIG_READ), retry: retryTransient });
}

export function useCalendarActivation(onDone: (text: string) => void) {
  const keys = useKeys();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (k: { id: string; version: number }) => api<CalendarDetail>(`/v1/payroll/calendars/${encodeURIComponent(k.id)}/activate`, { body: { expectedVersion: k.version } }),
    onSuccess: (k) => onDone(`Calendar ${k.code} is active: payroll runs and inputs can now use its periods.`),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.calendars }),
  });
}
