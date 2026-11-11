// The payroll-extras company-scope rule (company records and company figures; C1 scoped DENY), on constructed grants only: an
// unrestricted company scope is company-wide only while no other assignment of the user DENYs the same permission over part of it.
import { describe, expect, it } from 'vitest';
import type { AccessGrant } from '../access/authorize.js';
import { isCompanyWide, requireCompanyWide } from './common.js';

const grant = (over: Partial<Pick<AccessGrant, 'scopeKind' | 'filters' | 'deniedScopes'>> = {}): AccessGrant => ({
  allowed: true,
  userId: '00000000-0000-4000-8000-000000000001',
  companyId: '00000000-0000-4000-8000-000000000002',
  assignmentId: '00000000-0000-4000-8000-000000000003',
  roleCode: 'HR_ADMINISTRATOR',
  accessClass: 'ADMIN',
  scopeKind: 'COMPANY',
  filters: { departments: [], locations: [], employees: [] },
  deniedScopes: [],
  allowedFieldGroups: ['amount'],
  ownEssFieldGroups: [],
  deniedFieldGroups: [],
  linkedEmployeeId: null,
  at: new Date('2026-11-11T00:00:00Z'),
  businessDate: '2026-11-11',
  ...over,
});

describe('payroll-extras isCompanyWide (company figures; C1)', () => {
  it('an unrestricted company scope is company-wide', () => {
    expect(isCompanyWide(grant())).toBe(true);
    expect(() => requireCompanyWide(grant())).not.toThrow();
  });

  it('a filter or another scope kind is not', () => {
    expect(isCompanyWide(grant({ filters: { departments: ['00000000-0000-4000-8000-0000000000d1'], locations: [], employees: [] } }))).toBe(false);
    expect(isCompanyWide(grant({ scopeKind: 'ASSIGNED' }))).toBe(false);
  });

  it('a scoped DENY of the permission on another assignment of the user takes rows out, so it is not company-wide either', () => {
    const denied = grant({
      deniedScopes: [{ assignmentId: '00000000-0000-4000-8000-0000000000a9', scopeKind: 'COMPANY', filters: { departments: ['00000000-0000-4000-8000-0000000000d1'], locations: [], employees: [] } }],
    });
    expect(isCompanyWide(denied)).toBe(false);
    expect(() => requireCompanyWide(denied)).toThrow(expect.objectContaining({ statusCode: 403, code: 'COMPANY_SCOPE_REQUIRED' }));
  });
});
