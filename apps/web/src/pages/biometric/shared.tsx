// Shared by the biometric screens: permission keys, the API's shapes, time helpers, and the profile list and picker.
import { useQuery } from '@tanstack/react-query';
import { FormField } from '@/components/form-field';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '../../api';
import { ErrorNote } from '../../ui';

export const PROFILE_MANAGE = 'biometric.profile_manage.operational';
export const MAPPING_MANAGE = 'biometric.mapping_manage.operational';
export const LINK_MANAGE = 'biometric.employee_link_manage.operational';
export const SYNC_RUN = 'biometric.sync_run.operational';
export const REPROCESS = 'biometric.sync_exception_reprocess.operational';
export const READ = 'biometric.read.operational';
export const EMPLOYEE_LIST = 'employee.list.operational';

export interface Profile {
  id: string;
  code: string;
  name: string;
  providerTimezone: string;
  paginationMode: string;
  lookbackMinutes: number;
  active: boolean;
  syncedUntil: string | null;
  version: number;
}

export interface MappingField {
  sourcePath: string;
  targetField: string;
  transformCode: string;
  enumConfig: Record<string, string> | null;
  required: boolean;
  defaultCode: string | null;
}

export interface MappingRevision {
  id: string;
  revision: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  dedupeStrategy: string;
  timestampRule: string;
  approved: boolean;
  ownRevision: boolean;
  fields: MappingField[];
}

export interface EmployeeLink {
  id: string;
  externalEmployeeKey: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  current: boolean;
  version: number;
}

export interface SyncRun {
  id: string;
  profileCode: string;
  mappingRevision: number;
  state: string;
  failureCode: string | null;
  windowStart: string;
  windowEnd: string;
  startedAt: string;
  finishedAt: string | null;
  pagesCommitted: number;
  observations: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  quarantined: number;
}

export interface SyncException {
  id: string;
  runId: string;
  profileCode: string;
  outcome: string;
  failureCode: string;
  sourceEventKey: string | null;
  observedAt: string;
  eventId: string | null;
  nextStep: 'REPROCESS' | 'CORRECT_TIME' | 'RESOLVED' | 'NONE';
  evidence: { employeeKey: string; instant: string | null; localTime: string | null; direction: string; deviceId: string | null } | null;
  kept: { employeeKey: string; instant: string; direction: string } | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const formatInstant = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');
/** A date-and-time box reads in the browser's time zone; the server takes the instant. */
export const instantOf = (local: string) => new Date(local).toISOString();

export const useProfiles = () => useQuery({ queryKey: ['biometric', 'profiles'], queryFn: () => api<{ items: Profile[] }>('/v1/biometric/profiles') });

export function ProfilePicker({ value, onChange, anyLabel }: { value: string; onChange: (id: string) => void; anyLabel: string }) {
  const profiles = useProfiles();
  // The list's failure stays inside the field's label, under the choice it would have filled, as it always was.
  return (
    <FormField>
      Profile
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{anyLabel}</option>
        {profiles.data?.items.map((p) => (
          <option key={p.id} value={p.id}>
            {p.code} · {p.name}
          </option>
        ))}
      </NativeSelect>
      <ErrorNote error={profiles.error} />
    </FormField>
  );
}
