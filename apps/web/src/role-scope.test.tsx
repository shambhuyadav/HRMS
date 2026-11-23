// FR-096: the acting role and its scope are always visible. On narrower screens the role chip drops only the company name (styles.css
// hides .role-company below 1180px); the scope words must never sit inside that part. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

// The stylesheet as written (stylesheets are blanked in tests, so it is read from disk, next to this file).
const stylesCss = readFileSync(join(__dirname, 'styles.css'), 'utf8');

const session = vi.hoisted(() => ({
  value: { me: null as null | Record<string, unknown> },
}));

vi.mock('./session', () => ({
  useSession: () => ({
    stored: { token: 'tkn', companies: [], companyId: 'company-1', assignmentId: 'assignment-1' },
    me: session.value.me,
    can: () => true,
    switchRole: () => undefined,
    signOut: async () => undefined,
  }),
}));

function renderShell() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/bulk-jobs']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the role chip keeps the scope visible (FR-096)', () => {
  for (const [scopeKind, words] of [['COMPANY', 'Company-wide'], ['TEAM', 'My team'], ['OWN', 'My own record']] as const) {
    it(`shows "${words}" outside the part that narrow screens hide`, () => {
      session.value.me = { displayName: 'Asha Synthetic', accountKey: 'asha', companyName: 'Synthetic Co', roleName: 'Some role', scopeKind, employeeId: 'employee-1' };
      renderShell();
      const chip = screen.getByRole('group', { name: 'Current role' });
      // The whole line still reads as before: company, a dot, the scope.
      expect(chip.querySelector('.role-meta')?.textContent).toBe(`Synthetic Co · ${words}`);
      // Only the company name is in the part that gives way on narrower screens.
      expect(chip.querySelector('.role-company')?.textContent).toBe('Synthetic Co · ');
    });
  }

  it('hides only the company part on narrower screens, never the whole scope line', () => {
    expect(stylesCss).toMatch(/@media \(max-width: 1180px\) \{\s*\.role-company \{ display: none; \}/);
    expect(stylesCss).not.toMatch(/\.role-meta \{ display: none/);
  });
});
