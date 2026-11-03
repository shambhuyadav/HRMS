// H4 typed field dictionary for employee-initiated sensitive changes (FR-104, FR-105). These are the only fields a
// request can carry (no arbitrary keys). Field set from the F/H optional private fields: personal email and phone,
// birth date, emergency contact, home address, and bank holder/account/routing details. Validation is generic:
// country-specific address formats and bank-specific length/checksum rules need an activated reference format or
// provider template that does not exist yet (decision I-18), so none is assumed.
import { HttpError } from '../../http/errors.js';

export const CATEGORIES = ['PERSONAL', 'ADDRESS', 'BANK'] as const;
export type Category = (typeof CATEGORIES)[number];

type Kind = 'email' | 'phone' | 'date' | 'text' | 'country' | 'postal' | 'identifier';

interface FieldDef {
  kind: Kind;
  max: number;
  min?: number;
  /** Must hold a value in the resulting approved set. */
  required?: boolean;
  /** Identity-sensitive: a change needs verified evidence (H4). */
  identity?: boolean;
  label: string;
}

export const FIELDS: Readonly<Record<Category, Readonly<Record<string, FieldDef>>>> = {
  PERSONAL: {
    personalEmail: { kind: 'email', max: 254, label: 'personal email' },
    personalPhone: { kind: 'phone', max: 20, label: 'personal phone' },
    dateOfBirth: { kind: 'date', max: 10, identity: true, label: 'date of birth' },
    emergencyContactName: { kind: 'text', max: 200, label: 'emergency contact name' },
    emergencyContactRelationship: { kind: 'text', max: 100, label: 'emergency contact relationship' },
    emergencyContactPhone: { kind: 'phone', max: 20, label: 'emergency contact phone' },
  },
  ADDRESS: {
    line1: { kind: 'text', max: 200, required: true, label: 'address line 1' },
    line2: { kind: 'text', max: 200, label: 'address line 2' },
    city: { kind: 'text', max: 100, required: true, label: 'city' },
    region: { kind: 'text', max: 100, label: 'state or region' },
    postalCode: { kind: 'postal', max: 12, label: 'postal code' },
    countryCode: { kind: 'country', max: 2, required: true, label: 'country' },
  },
  BANK: {
    holderName: { kind: 'text', max: 200, required: true, label: 'account holder name' },
    accountIdentifier: { kind: 'identifier', min: 4, max: 34, required: true, label: 'account identifier' },
    routingReference: { kind: 'identifier', max: 20, label: 'bank routing reference' },
    countryCode: { kind: 'country', max: 2, required: true, label: 'bank country' },
  },
};

export type Values = Record<string, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9 ()-]*$/;
const POSTAL = /^[A-Z0-9][A-Z0-9 -]*$/;
const IDENTIFIER = /^[A-Z0-9]+$/;

function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Normalised value, or a 422 naming the field (never echoing the value). */
function normalise(field: string, def: FieldDef, raw: string): string {
  const fail = (): never => {
    throw new HttpError(422, 'INVALID_FIELD', `The ${def.label} is not valid`, { field });
  };
  let v = raw.trim();
  switch (def.kind) {
    case 'email':
      v = v.toLowerCase();
      if (!EMAIL.test(v)) fail();
      break;
    case 'phone':
      if (!PHONE.test(v) || v.replace(/\D/g, '').length < 6) fail();
      break;
    case 'date':
      if (!isCalendarDate(v)) fail();
      break;
    case 'country':
      v = v.toUpperCase();
      if (!/^[A-Z]{2}$/.test(v)) fail();
      break;
    case 'postal':
      v = v.toUpperCase();
      if (!POSTAL.test(v)) fail();
      break;
    case 'identifier':
      // Text, never a number: leading zeros are kept; spaces are only grouping.
      v = v.replace(/\s+/g, '').toUpperCase();
      if (!IDENTIFIER.test(v)) fail();
      break;
    case 'text':
      if (/[\u0000-\u001f\u007f]/.test(v)) fail();
      break;
  }
  if (v === '' || v.length > def.max || v.length < (def.min ?? 1)) fail();
  return v;
}

export interface Proposal {
  /** Values of the changed fields as proposed (null clears an optional field). */
  proposed: Record<string, string | null>;
  /** The same fields' values when the request was based. */
  before: Record<string, string | null>;
  /** The complete category values after the change. */
  result: Values;
  changedFields: string[];
  evidenceRequired: boolean;
}

/**
 * Validates proposed values against the dictionary and the current approved values of the category. Unknown keys,
 * invalid values, clearing a required field, and proposals that change nothing are refused.
 */
export function buildProposal(category: Category, current: Values, input: Record<string, unknown>): Proposal {
  const defs = FIELDS[category];
  const proposed: Record<string, string | null> = {};
  const before: Record<string, string | null> = {};
  for (const [field, raw] of Object.entries(input)) {
    const def = defs[field];
    if (!def) throw new HttpError(422, 'UNKNOWN_FIELD', 'This field cannot be changed through a request', { field });
    let value: string | null;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (def.required) throw new HttpError(422, 'FIELD_REQUIRED', `The ${def.label} is required`, { field });
      value = null;
    } else if (typeof raw === 'string') {
      value = normalise(field, def, raw);
    } else {
      throw new HttpError(422, 'INVALID_FIELD', `The ${def.label} is not valid`, { field });
    }
    if (value === (current[field] ?? null)) continue;
    proposed[field] = value;
    before[field] = current[field] ?? null;
  }
  const changedFields = Object.keys(proposed).sort();
  if (changedFields.length === 0) throw new HttpError(422, 'NO_CHANGE', 'Nothing differs from your current details');
  const result: Values = { ...current };
  for (const [field, value] of Object.entries(proposed)) {
    if (value === null) delete result[field];
    else result[field] = value;
  }
  for (const [field, def] of Object.entries(defs)) {
    if (def.required && !result[field]) throw new HttpError(422, 'FIELD_REQUIRED', `The ${def.label} is required`, { field });
  }
  const evidenceRequired = category === 'BANK' || changedFields.some((f) => defs[f]!.identity === true);
  return { proposed, before, result, changedFields, evidenceRequired };
}

/** Last four characters only, behind a fixed-width mask (the length is not revealed). */
export function maskTail(value: string | undefined): string | null {
  if (!value) return null;
  return `••••${value.slice(-4)}`;
}

/** H3 TN03 masked bank summary: holder, country and routing reference; the account identifier masked. */
export function maskedBank(values: Values | null): Record<string, string | null> | null {
  if (!values) return null;
  return {
    holderName: values.holderName ?? null,
    accountIdentifier: maskTail(values.accountIdentifier),
    routingReference: values.routingReference ?? null,
    countryCode: values.countryCode ?? null,
  };
}

export const fieldLabels = (category: Category, fields: readonly string[]) => fields.map((f) => FIELDS[category][f]?.label ?? f);
