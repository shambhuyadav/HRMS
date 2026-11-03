// Field envelope sealing (H4/DB115/DB116 protected payloads). Synthetic values only.
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFieldKeysConfigured, openJson, sealJson } from './field-crypto.js';

const binding = { purpose: 'test.payload', companyId: 'c-1', ownerId: 'e-1', recordId: 'r-1' };
const original = process.env.HRMS_FIELD_KEYS;
const originalEnv = process.env.NODE_ENV;

afterEach(() => {
  if (original === undefined) delete process.env.HRMS_FIELD_KEYS;
  else process.env.HRMS_FIELD_KEYS = original;
  process.env.NODE_ENV = originalEnv;
});

describe('field envelopes', () => {
  it('round-trips a value and never shows it in the envelope', () => {
    const sealed = sealJson({ accountIdentifier: '000123456789' }, binding);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('000123456789');
    expect(openJson(sealed, binding)).toEqual({ accountIdentifier: '000123456789' });
    // A fresh nonce every time: the same value seals differently.
    expect(sealJson({ accountIdentifier: '000123456789' }, binding)).not.toBe(sealed);
  });

  it('refuses an envelope moved to another row, owner, company or purpose', () => {
    const sealed = sealJson({ v: 'synthetic' }, binding);
    for (const moved of [{ recordId: 'r-2' }, { ownerId: 'e-2' }, { companyId: 'c-2' }, { purpose: 'other' }]) {
      expect(() => openJson(sealed, { ...binding, ...moved })).toThrow('Protected payload cannot be opened');
    }
  });

  it('refuses tampered, truncated or malformed envelopes without echoing them', () => {
    const sealed = sealJson({ v: 'synthetic' }, binding);
    const parts = sealed.split('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const variants = [
      [parts[0], parts[1], parts[2], parts[3], flip(parts[4]!)].join('.'),
      [parts[0], parts[1], parts[2], flip(parts[3]!), parts[4]].join('.'),
      [parts[0], parts[1], parts[2], parts[3]!.slice(0, 8), parts[4]].join('.'),
      ['v2', ...parts.slice(1)].join('.'),
      `${sealed}.extra`,
      'not an envelope',
    ];
    for (const v of variants) expect(() => openJson(v, binding)).toThrow('Protected payload cannot be opened');
  });

  it('rotates keys: the first configured key seals, older keys still open', () => {
    const k1 = randomBytes(32).toString('base64');
    const k2 = randomBytes(32).toString('base64');
    process.env.HRMS_FIELD_KEYS = `old:${k1}`;
    const before = sealJson({ v: 'synthetic' }, binding);
    process.env.HRMS_FIELD_KEYS = `new:${k2},old:${k1}`;
    expect(openJson(before, binding)).toEqual({ v: 'synthetic' });
    expect(sealJson({ v: 'x' }, binding).split('.')[1]).toBe('new');
    process.env.HRMS_FIELD_KEYS = `new:${k2}`;
    expect(() => openJson(before, binding)).toThrow('Protected payload cannot be opened');
  });

  it('requires well-formed keys, and keys in production', () => {
    for (const bad of ['k1', 'k1:short', `k1:${randomBytes(32).toString('base64')},k1:${randomBytes(32).toString('base64')}`, 'bad id!:x']) {
      process.env.HRMS_FIELD_KEYS = bad;
      expect(() => assertFieldKeysConfigured()).toThrow();
    }
    delete process.env.HRMS_FIELD_KEYS;
    process.env.NODE_ENV = 'production';
    expect(() => assertFieldKeysConfigured()).toThrow('HRMS_FIELD_KEYS must be configured in production');
  });
});
