// The shell's theme switch, the phone's bottom bar and the sticky list headings. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { markFittingCards } from './sticky-heads';

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

/** A window whose media queries match exactly the given ones. */
const mediaMatching = (...matching: string[]) =>
  vi.fn((query: string) => ({ matches: matching.includes(query), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

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
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

describe('the theme switch', () => {
  it('turns the dark theme on and off, and keeps the choice on this device', () => {
    renderShell('/bulk-jobs');
    const toggle = screen.getByRole('button', { name: 'Dark theme' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('hrms.theme')).toBe('dark');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('hrms.theme')).toBe('light');
  });

  it("follows the device's dark setting until a theme is chosen", () => {
    vi.stubGlobal('matchMedia', mediaMatching('(prefers-color-scheme: dark)'));
    renderShell('/bulk-jobs');
    expect(screen.getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe('true');
    // No choice yet: nothing is stamped on the page, so the stylesheet's device rule applies.
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('starts from the choice made earlier on this device', () => {
    localStorage.setItem('hrms.theme', 'dark');
    renderShell('/bulk-jobs');
    expect(screen.getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe("the phone's bottom bar", () => {
  it('is not drawn on a larger screen', () => {
    renderShell('/bulk-jobs');
    expect(screen.queryByRole('navigation', { name: 'Shortcuts' })).toBeNull();
  });

  it('offers the first four pages the role may open, in order, and "More" opens the full menu', () => {
    vi.stubGlobal('matchMedia', mediaMatching('(max-width: 560px)'));
    session.value.granted = new Set(['dashboard.read.operational', 'employee.read.operational', 'leave.read.operational', 'leave.approve.operational']);
    const { container } = renderShell('/bulk-jobs');
    const bar = screen.getByRole('navigation', { name: 'Shortcuts' });
    expect(within(bar).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'My ESS', 'Leave', 'Decisions']);
    const more = within(bar).getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.shell')?.classList.contains('menu-open')).toBe(true);
    // Choosing a page closes the menu again.
    fireEvent.click(within(bar).getByRole('link', { name: 'Leave' }));
    expect(container.querySelector('.shell')?.classList.contains('menu-open')).toBe(false);
  });

  it('leaves out the pages the role cannot open', () => {
    vi.stubGlobal('matchMedia', mediaMatching('(max-width: 560px)'));
    session.value.me = { ...session.value.me, scopeKind: 'COMPANY', employeeId: null };
    session.value.granted = new Set(['dashboard.read.operational']);
    renderShell('/bulk-jobs');
    const bar = screen.getByRole('navigation', { name: 'Shortcuts' });
    expect(within(bar).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'Notifications']);
  });
});

describe('sticky list headings', () => {
  const card = (scrollWidth: number, clientWidth: number, withHeadings = true) => {
    const el = document.createElement('section');
    el.className = 'card';
    el.innerHTML = withHeadings ? '<table><thead><tr><th>Name</th></tr></thead><tbody></tbody></table>' : '<p>Text</p>';
    Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
    return el;
  };

  it('marks a card whose table fits its width, and not one that scrolls sideways or has no heading row', () => {
    const root = document.createElement('main');
    const fits = card(600, 600);
    const wide = card(900, 600);
    const plain = card(600, 600, false);
    root.append(fits, wide, plain);
    markFittingCards(root);
    expect(fits.hasAttribute('data-fit')).toBe(true);
    expect(wide.hasAttribute('data-fit')).toBe(false);
    expect(plain.hasAttribute('data-fit')).toBe(false);
  });

  it('takes the mark away when the content grows past the width', () => {
    const root = document.createElement('main');
    const el = card(600, 600);
    root.append(el);
    markFittingCards(root);
    expect(el.hasAttribute('data-fit')).toBe(true);
    Object.defineProperty(el, 'scrollWidth', { value: 640 });
    markFittingCards(root);
    expect(el.hasAttribute('data-fit')).toBe(false);
  });
});
