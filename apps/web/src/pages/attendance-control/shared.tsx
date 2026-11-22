// Shared by the attendance control, dashboard and report screens: the master choices their filters offer and the attendance statuses
// in words.

import { FormField } from '@/components/form-field';
import { NativeSelect } from '@/components/ui/native-select';

/** A department, location or shift a filter offers: chosen by its name ("Mumbai Office"), the code only when it has none. */
export interface MasterOption {
  id: string;
  code: string;
  name?: string | null;
}
export const optionName = (o: MasterOption) => o.name || o.code;

/** A department, location or shift filter: every choice by its name, and "All" for no filter. */
export function MasterFilter({ label, value, items, onChange }: { label: string; value: string; items: MasterOption[]; onChange: (value: string) => void }) {
  return (
    <FormField>
      {label}
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {items.map((o) => (
          <option key={o.id} value={o.id}>
            {optionName(o)}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
}

export const STATUSES = ['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE', 'HALF_DAY_LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'ON_DUTY', 'EXCEPTION'] as const;
const STATUS_TEXT: Record<string, string> = {
  PRESENT: 'Present',
  HALF_DAY: 'Half day',
  ABSENT: 'Absent',
  LEAVE: 'Leave',
  HALF_DAY_LEAVE: 'Half-day leave',
  HOLIDAY: 'Holiday',
  WEEKLY_OFF: 'Weekly off',
  ON_DUTY: 'On duty',
  EXCEPTION: 'Exception',
};
export const statusText = (code: string) => STATUS_TEXT[code] ?? code;
