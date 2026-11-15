// The startup check of numeric settings (improvement plan C5): unset or whole numbers pass; anything else is refused, every bad
// setting named at once.
import { describe, expect, it } from 'vitest';
import { assertNumericSettings, numericSettingProblems } from './config.js';

describe('numeric settings', () => {
  it('accepts unset, blank and whole-number values', () => {
    expect(numericSettingProblems({})).toEqual([]);
    expect(numericSettingProblems({ PORT: '3000', DB_POOL_MAX: ' 12 ', SLOW_QUERY_MS: '0', SMTP_PORT: '' })).toEqual([]);
  });

  it('refuses the rest, naming each one', () => {
    expect(numericSettingProblems({ DB_POOL_MAX: 'abc', PORT: '30O0', SCAN_TIMEOUT_MS: '-5', OUTBOX_RELAY_BATCH: '1.5' })).toEqual([
      'PORT must be a whole number of 0 or more, but is "30O0"',
      'DB_POOL_MAX must be a whole number of 0 or more, but is "abc"',
      'OUTBOX_RELAY_BATCH must be a whole number of 0 or more, but is "1.5"',
      'SCAN_TIMEOUT_MS must be a whole number of 0 or more, but is "-5"',
    ]);
    expect(() => assertNumericSettings({ DB_POOL_MAX: 'abc' })).toThrow(/Invalid settings:\n {2}- DB_POOL_MAX must be a whole number/);
    expect(() => assertNumericSettings({ DB_POOL_MAX: '20' })).not.toThrow();
  });
});
