// The menu as a sheet over the page at 920px wide or less (components/ui/sidebar), and on a wider screen the menu beside the page
// that nothing hides. The shell keeps one menu state for the top bar's menu button, the phone bar's "More" and its own classes.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

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

const TABLET = '(max-width: 920px)';
const PHONE = '(max-width: 560px)';

/** A window whose media queries match exactly the given ones. */
const mediaMatching = (...matching: string[]) =>
  vi.fn((query: string) => ({ matches: matching.includes(query), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

function renderShell(path = '/bulk-jobs') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** React's warnings (a ref given to a component that does not forward it, and the like), which the shell must not cause. */
const reactWarnings = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter((call) => /^Warning:/.test(String(call[0])));

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
  session.value.me = { displayName: 'Asha Synthetic', accountKey: 'asha', companyName: 'Synthetic Co', roleName: 'Employee', scopeKind: 'OWN', employeeId: 'employee-1' };
  session.value.granted = new Set(['dashboard.read.operational', 'employee.read.operational', 'leave.read.operational']);
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  expect(reactWarnings(consoleError)).toEqual([]);
  consoleError.mockRestore();
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the menu on a wide screen', () => {
  it('is always shown beside the page, with no button or keyboard shortcut that hides it', () => {
    const { container } = renderShell();
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Leave' }).getAttribute('href')).toBe('/leave');
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The registry's Ctrl/Cmd+B shortcut is gone, and nothing is remembered in a cookie.
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(container.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state')).toBe('expanded');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(document.cookie).toBe('');
  });
});

describe('the menu sheet at 920px or less', () => {
  it('opens from the top bar as a dialog named "Menu" holding the menu, and Escape closes it and gives the focus back', async () => {
    vi.stubGlobal('matchMedia', mediaMatching(TABLET));
    const { container } = renderShell();
    const shell = container.querySelector('.shell')!;
    // Closed, the menu is not on the page at all.
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Menu' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(shell.classList.contains('menu-open')).toBe(false);

    toggle.focus();
    fireEvent.click(toggle);
    const sheet = screen.getByRole('dialog', { name: 'Menu' });
    const nav = within(sheet).getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(expect.arrayContaining(['Home', 'My ESS', 'Leave']));
    // The brand block comes with it.
    expect(within(sheet).getByText('HRMS')).toBeTruthy();
    expect(within(sheet).getByText('Synthetic Co')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(shell.classList.contains('menu-open')).toBe(true);
    // Modal: the focus is in the sheet.
    expect(sheet.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(shell.classList.contains('menu-open')).toBe(false);
    // Radix gives the focus back just after the sheet has gone.
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it('closes when a page is chosen in it', () => {
    vi.stubGlobal('matchMedia', mediaMatching(TABLET));
    const { container } = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Menu' })).getByRole('link', { name: 'My ESS' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.shell')?.classList.contains('menu-open')).toBe(false);
    expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('on a phone, opens from "More" in the bottom bar (the top bar has no menu button there) and gives the focus back to it', async () => {
    vi.stubGlobal('matchMedia', mediaMatching(TABLET, PHONE));
    const { container } = renderShell();
    expect(container.querySelector('.shell')?.classList.contains('has-phone-bar')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
    const more = within(screen.getByRole('navigation', { name: 'Shortcuts' })).getByRole('button', { name: 'More' });
    more.focus();
    fireEvent.click(more);
    expect(within(screen.getByRole('dialog', { name: 'Menu' })).getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.shell')?.classList.contains('menu-open')).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(more));
  });
});
