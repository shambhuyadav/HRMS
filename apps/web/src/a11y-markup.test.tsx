// Markup that assistive technology relies on: the shell's skip link and named role chip, and the refusal variant of an empty
// state. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Empty } from './ui';

const session = vi.hoisted(() => ({
  value: {
    stored: { token: 'tkn', companies: [], companyId: 'company-1', assignmentId: 'assignment-1' },
    me: null as null | Record<string, unknown>,
    granted: new Set<string>(),
  },
}));

vi.mock('./session', () => ({
  useSession: () => ({
    stored: session.value.stored,
    me: session.value.me,
    can: (p: string) => session.value.granted.has(p),
    switchRole: () => undefined,
    signOut: async () => undefined,
  }),
}));

function renderShell(path = '/') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
  session.value.me = { displayName: 'Asha Synthetic', accountKey: 'asha', companyName: 'Synthetic Co', roleName: 'Employee', scopeKind: 'OWN', employeeId: 'employee-1' };
  session.value.granted = new Set(['dashboard.read.operational', 'employee.read.operational', 'leave.read.operational']);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the skip link', () => {
  it('comes first in the signed-in shell and leads to the main content', () => {
    const { container } = renderShell('/bulk-jobs');
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip.getAttribute('href')).toBe('#main');
    expect(skip.classList.contains('skip-link')).toBe(true);
    expect(container.querySelector('.shell')?.firstElementChild).toBe(skip);
    const main = screen.getByRole('main');
    expect(main.id).toBe('main');
    // Focusable from the link, but not a stop of its own in the tab order.
    expect(main.getAttribute('tabindex')).toBe('-1');
  });
});

describe('the role chip', () => {
  it('is a group named "Current role" holding the role and its scope', () => {
    renderShell('/bulk-jobs');
    const chip = screen.getByRole('group', { name: 'Current role' });
    expect(chip.classList.contains('role-chip')).toBe(true);
    expect(within(chip).getByText('Employee')).toBeTruthy();
  });
});

describe('an empty state', () => {
  it('marks a refusal apart from an empty list, with the same text', () => {
    render(<Empty refusal>The selected role cannot see payroll runs.</Empty>);
    const refusal = screen.getByText('The selected role cannot see payroll runs.');
    expect(refusal.className).toBe('empty empty-refusal');
  });

  it('stays a plain empty state without it', () => {
    render(<Empty>No payroll runs yet.</Empty>);
    expect(screen.getByText('No payroll runs yet.').className).toBe('empty');
  });
});
