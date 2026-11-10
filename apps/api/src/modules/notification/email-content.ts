// What an email notice may say (FR-085; DF12 "Email may be enabled for non-confidential event templates"; BR-044 "notification
// content"; H7 "email contains no bank values/salary/private documents"). Pure functions, shared by the rule configuration, the
// dispatcher that renders an email when it queues it, and the worker that checks it again just before sending.
//
// An email leaves the system: it is kept on mail servers and can be forwarded, so it says only that something happened and what
// state it is in, and points to the application, where the recipient's current access decides what they see. Hence:
//   placeholders   only those carrying a state or a step (EMAIL_SAFE_PLACEHOLDERS); never a name, code, date, period, title,
//                  amount, percentage or reason. Migration 0247 refuses any other placeholder on an EMAIL template.
//   wording        no figures that could be an amount, percentage or account number, no currency, and no links: the only link is
//                  the application's own address, added by the sender (emailBodyText).
//   values         placeholder values are neutralised: control, invisible and direction-changing characters and line breaks removed
//                  (no header injection), spaces collapsed, length capped, and anything a mail client would turn into a link broken.
// The body is plain text only (no HTML), so no markup from a value or the wording can ever be interpreted.

/** Placeholders an email template may use (the same list as migration 0247's trigger). */
export const EMAIL_SAFE_PLACEHOLDERS: readonly string[] = ['outcome', 'step', 'stepLabel', 'runState', 'paymentEvent', 'paymentStatus', 'requestKind'];

/** The neutral wording an email rule starts with when its proposer gives none and the in-app subject is not email-safe. */
export const DEFAULT_EMAIL_SUBJECT = 'New HRMS notice';
export const DEFAULT_EMAIL_BODY = 'There is a new notice for you in HRMS.';

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

/** A character class of code point ranges, built from numbers so no invisible character ever sits in this source file. */
const charClass = (ranges: readonly (readonly [number, number])[]): RegExp =>
  new RegExp(`[${ranges.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');
/** Control characters, zero-width and direction marks, line and paragraph separators, bidirectional embeddings, isolates and BOM. */
const INVISIBLE_RANGES = [
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
] as const;
/** In a value: every control character, line breaks included. */
const NOT_IN_VALUE = charClass([[0x00, 0x1f], ...INVISIBLE_RANGES]);
/** In a body: the same, except tab and line feed. */
const NOT_IN_BODY = charClass([[0x00, 0x08], [0x0b, 0x1f], ...INVISIBLE_RANGES]);

/**
 * Text an email must not carry, with the reason code. Five or more digits in a row (an amount, an account or identifier number), a
 * number with a thousands or decimal separator (1,000 or 12.50), a percentage, a currency sign or code, an IBAN-like value, or a link.
 * Short numbers stay possible in the wording, but no placeholder carries a number.
 */
const NOT_IN_EMAIL: readonly { pattern: RegExp; code: string }[] = [
  { pattern: /\d{5,}/, code: 'LONG_NUMBER' },
  { pattern: /\d[.,]\d/, code: 'FORMATTED_NUMBER' },
  { pattern: /%|\bper\s?cent\b/i, code: 'PERCENTAGE' },
  { pattern: new RegExp(`[${String.fromCharCode(0x20b9, 0x24, 0x20ac, 0xa3, 0xa5)}]|\\b(?:INR|USD|EUR|GBP|Rs)\\b`, 'i'), code: 'CURRENCY' },
  { pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/, code: 'ACCOUNT_IDENTIFIER' },
  { pattern: /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bmailto:/i, code: 'LINK' },
];

/** The first reason an email text is refused, or null when it may be sent. */
export function emailContentRefusal(text: string): string | null {
  for (const rule of NOT_IN_EMAIL) if (rule.pattern.test(text)) return rule.code;
  return null;
}

/** The first placeholder of the wording that is not approved for this email template, or null. */
export function unapprovedEmailPlaceholder(text: string, approved: readonly string[]): string | null {
  for (const m of text.matchAll(PLACEHOLDER)) if (!approved.includes(m[1]!) || !EMAIL_SAFE_PLACEHOLDERS.includes(m[1]!)) return m[1]!;
  return null;
}

/** The approved placeholders an email template derived from an in-app template keeps: those that carry a state only. */
export const emailPlaceholdersOf = (inAppApproved: readonly string[]): string[] => inAppApproved.filter((p) => EMAIL_SAFE_PLACEHOLDERS.includes(p));

/**
 * A placeholder value as an email may carry it: control and formatting characters (line breaks, bidirectional overrides) removed,
 * spaces collapsed, at most 80 characters, and link forms broken so no mail client offers them as a link.
 */
export function neutraliseEmailValue(value: string): string {
  return value
    .normalize('NFC')
    .replace(NOT_IN_VALUE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/:\/\//g, ' : // ')
    .replace(/\bwww\./gi, 'www ')
    .replace(/@/g, ' at ');
}

/** The event data as an email template may use it: email-safe placeholders only, each value neutralised. */
export function emailData(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of EMAIL_SAFE_PLACEHOLDERS) {
    const v = data[key];
    if (typeof v === 'string' && v !== '') out[key] = neutraliseEmailValue(v);
  }
  return out;
}

/** A subject line: one line, never empty, at most 150 characters. */
export const emailSubjectLine = (subject: string | null): string =>
  (subject ?? '').replace(NOT_IN_VALUE, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || DEFAULT_EMAIL_SUBJECT;

/** The plain-text body as sent: the rendered notice, the application's address and a fixed footer. */
export function emailBodyText(body: string, appUrl: string): string {
  const notice = body.replace(/\r\n?/g, '\n').replace(NOT_IN_BODY, ' ').trim();
  return [notice, '', `Sign in to HRMS to see the details: ${appUrl}`, '', 'This is an automatic message from HRMS; replies are not read. It never contains confidential details.'].join('\n');
}
