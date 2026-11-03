// Provider-independent field mapping (FR-086; BR-035; BR-036; DF09; DF13). Typed paths and allowlisted
// transforms only; no executable expressions. Pure functions: the same record and mapping always map the same.
import { createHash } from 'node:crypto';

export type TargetField = 'EMPLOYEE_KEY' | 'PUNCH_INSTANT' | 'DIRECTION' | 'EVENT_KEY' | 'DEVICE_ID';
export type Transform = 'IDENTITY' | 'TRIM' | 'UPPER' | 'ENUM_MAP' | 'PARSE_INSTANT';

export interface FieldMapping {
  sourcePath: string;
  targetField: TargetField;
  transformCode: Transform;
  enumConfig?: Record<string, string> | null | undefined;
  required: boolean;
  defaultCode?: 'IN' | 'OUT' | null | undefined;
}

export type DedupeStrategy = 'PROVIDER_EVENT_KEY' | 'FINGERPRINT';
export type TimestampRule = 'ISO_WITH_OFFSET' | 'LOCAL_IN_PROVIDER_ZONE';

export const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]{1,4}\])*$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?([zZ]|[+-]\d{2}:\d{2})$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

/** Activation-time validation (FR-086): required targets present, transforms consistent, strategy satisfiable. */
export function validateMappingSet(fields: FieldMapping[], dedupe: DedupeStrategy): string[] {
  const errors: string[] = [];
  const by = new Map(fields.map((f) => [f.targetField, f]));
  if (by.size !== fields.length) errors.push('DUPLICATE_TARGET');
  for (const f of fields) if (!PATH_PATTERN.test(f.sourcePath)) errors.push(`INVALID_PATH:${f.targetField}`);
  if (!by.get('EMPLOYEE_KEY')?.required) errors.push('EMPLOYEE_KEY_REQUIRED');
  const instant = by.get('PUNCH_INSTANT');
  if (!instant?.required || instant.transformCode !== 'PARSE_INSTANT') errors.push('PUNCH_INSTANT_REQUIRED');
  const direction = by.get('DIRECTION');
  if (!direction || (!direction.required && !direction.defaultCode)) errors.push('DIRECTION_OR_APPROVED_DEFAULT_REQUIRED');
  if (direction?.transformCode === 'ENUM_MAP' && !Object.values(direction.enumConfig ?? {}).every((v) => v === 'IN' || v === 'OUT')) {
    errors.push('DIRECTION_ENUM_INVALID');
  }
  if (dedupe === 'PROVIDER_EVENT_KEY' && !by.get('EVENT_KEY')?.required) errors.push('EVENT_KEY_REQUIRED_FOR_STRATEGY');
  return errors;
}

/** Reads a typed path such as `data.items[0].emp.code`. Never evaluates code. */
export function readPath(record: unknown, path: string): unknown {
  let current: unknown = record;
  for (const token of path.match(/[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g) ?? []) {
    if (current === null || current === undefined) return undefined;
    if (token.startsWith('[')) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(token.slice(1, -1))];
    } else {
      if (typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = Object.prototype.hasOwnProperty.call(current, token) ? (current as Record<string, unknown>)[token] : undefined;
    }
  }
  return current;
}

export interface MappedRecord {
  employeeKey: string;
  instant: { kind: 'ISO'; value: string } | { kind: 'LOCAL'; value: string };
  direction: 'IN' | 'OUT';
  eventKey: string | null;
  deviceId: string | null;
}

export type MapResult = { ok: true; value: MappedRecord } | { ok: false; code: string };

function transform(f: FieldMapping, raw: unknown): { ok: true; value: string | null } | { ok: false; code: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, code: `UNSUPPORTED_VALUE:${f.targetField}` };
  const text = String(raw);
  switch (f.transformCode) {
    case 'IDENTITY':
    case 'PARSE_INSTANT':
      return { ok: true, value: text };
    case 'TRIM':
      return { ok: true, value: text.trim() };
    case 'UPPER':
      return { ok: true, value: text.trim().toUpperCase() };
    case 'ENUM_MAP': {
      const mapped = f.enumConfig?.[text];
      return mapped === undefined ? { ok: false, code: `UNMAPPED_ENUM:${f.targetField}` } : { ok: true, value: mapped };
    }
  }
}

export function mapRecord(record: unknown, fields: FieldMapping[], rule: TimestampRule): MapResult {
  const values: Partial<Record<TargetField, string | null>> = {};
  for (const f of fields) {
    const t = transform(f, readPath(record, f.sourcePath));
    if (!t.ok) return t;
    let value = t.value;
    if (value === null && f.targetField === 'DIRECTION' && f.defaultCode) value = f.defaultCode;
    if (value === null && f.required) return { ok: false, code: `MISSING_REQUIRED:${f.targetField}` };
    values[f.targetField] = value;
  }
  const direction = values.DIRECTION;
  if (direction !== 'IN' && direction !== 'OUT') return { ok: false, code: 'INVALID_DIRECTION' };
  const instant = values.PUNCH_INSTANT!;
  if (rule === 'ISO_WITH_OFFSET') {
    if (!ISO_WITH_OFFSET.test(instant) || Number.isNaN(new Date(instant).getTime())) return { ok: false, code: 'INVALID_TIMESTAMP' };
  } else if (!LOCAL_DATETIME.test(instant)) {
    return { ok: false, code: 'INVALID_TIMESTAMP' };
  }
  return {
    ok: true,
    value: {
      employeeKey: values.EMPLOYEE_KEY!,
      instant: rule === 'ISO_WITH_OFFSET' ? { kind: 'ISO', value: new Date(instant).toISOString() } : { kind: 'LOCAL', value: instant.replace('T', ' ') },
      direction,
      eventKey: values.EVENT_KEY ?? null,
      deviceId: values.DEVICE_ID ?? null,
    },
  };
}

/** Stable digest of the normalised content; same key with a different digest is a conflicting payload. */
export function contentFingerprint(namespace: string, m: MappedRecord, instantIso: string | null): string {
  return createHash('sha256')
    .update([namespace, m.employeeKey, instantIso ?? m.instant.value, m.direction, m.deviceId ?? ''].join('|'))
    .digest('hex');
}

export function rawFingerprint(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record) ?? 'null').digest('hex');
}
