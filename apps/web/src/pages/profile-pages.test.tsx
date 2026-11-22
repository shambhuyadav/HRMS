// The header card and section bar on the three record pages, and the steps of the long forms (owner's request of 20 Nov 2026),
// jsdom: the card shows only what the page already read, each value with its words so the record's own facts stay the one exact
// match; the bar names exactly the sections the role is shown; the steps follow the form's groups and change nothing it sends.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPLOYEE_SCREENS, type EmployeeRecord } from './employee';
import { NewRequisitionScreen } from './hiring-requisitions/requisitions';
import { TeamMemberPage } from './home';
import { MyProfilePage } from './me';
import { TemplatesScreen } from './payroll/bank-templates';

declare module 'vitest' {
  // jest-axe's matcher, registered with vitest's expect below (as in a11y.test.tsx).
  interface Assertion<T = any> {
    toHaveNoViolations(): T;
  }
}
expect.extend(toHaveNoViolations);

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { companyId: 'c-1', assignmentId: 'a-1' },
    me: { employeeId: 'emp-1', scopeKind: 'COMPANY', displayName: 'Synthetic Viewer' },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

type Reply = [number, unknown];
function mockApi(routes: Record<string, Reply>) {
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      const key = Object.keys(routes)
        .filter((k) => `${method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const [status, body] = key === undefined ? [404, { error: 'NOT_FOUND', message: 'Resource not found' }] : routes[key]!;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

const show = (entry: string, element: JSX.Element, path = entry) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path={path} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const openEmployee = (entry: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {EMPLOYEE_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const barLinks = () => within(screen.getByRole('navigation', { name: 'Sections of this record' })).getAllByRole('link').map((a) => a.textContent);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

const READ = 'employee.read.operational';
const RECORD: EmployeeRecord = {
  id: 'e-1',
  employeeCode: 'SYN-1',
  displayName: 'Synthetic Person',
  workEmail: 'person@synthetic.test',
  joiningDate: '2026-02-01',
  confirmationDate: null,
  employmentType: 'FIXED_TERM',
  status: 'ACTIVE_PROBATION',
  assignment: { departmentId: 'd-1', departmentName: 'Engineering', locationId: 'l-1', locationName: 'Head office', designationId: 'g-1', designationName: 'Developer', gradeId: null },
  manager: { id: 'e-2', employeeCode: 'SYN-2', displayName: 'Synthetic Lead' },
  version: 3,
};

describe('the employee record', () => {
  it('opens with the header card from the record already read, and the record’s facts stay the one exact match', async () => {
    session.permissions = [READ];
    const calls = mockApi({ 'GET /v1/employees/e-1': [200, RECORD] });
    openEmployee('/employees/e-1');
    await screen.findByRole('heading', { name: 'Synthetic Person (SYN-1)' });
    expect(screen.getByText('SYN-1 · Developer')).toBeTruthy();
    expect(screen.getByText('Engineering · Head office')).toBeTruthy();
    expect(screen.getByText('Joined 1 Feb 2026')).toBeTruthy();
    expect(screen.getByText('Reports to Synthetic Lead')).toBeTruthy();
    expect(screen.getByText('SP')).toBeTruthy();
    expect(screen.getByText('SYN-1').tagName).toBe('DD');
    expect(screen.getByText('Engineering').tagName).toBe('DD');
    expect(screen.getByRole('link', { name: 'Synthetic Lead (SYN-2)' }).getAttribute('href')).toBe('/employees/e-2');
    // One section: no bar. Nothing more is asked for.
    expect(screen.queryByRole('navigation', { name: 'Sections of this record' })).toBeNull();
    expect(calls.map((c) => c.url)).toEqual(['/v1/employees/e-1']);
  });

  it('the section bar names exactly the sections the role is shown, in their order', async () => {
    session.permissions = [READ, 'employee.activate.operational', 'employee.update.operational', 'employee.read.private', 'employee.read_history.operational'];
    mockApi({
      'GET /v1/employees/e-1/history': [200, { leavingDate: null, priorEmployment: null, nextEmployment: null, shifts: [] }],
      'GET /v1/employees/e-1': [200, { ...RECORD, status: 'DRAFT', manager: null }],
    });
    openEmployee('/employees/e-1');
    await screen.findByRole('heading', { name: 'Synthetic Person (SYN-1)' });
    expect(barLinks()).toEqual(['Overview', 'Activation', 'Changes', 'Private details', 'Family and qualifications', 'History']);
    for (const heading of ['Activation', 'Change this record', 'Private details', 'Family, qualifications and prior employment', 'Employment history']) {
      expect(screen.getByRole('heading', { name: heading }).closest('section')!.id).not.toBe('');
    }
    expect(screen.queryByText(/^Reports to/)).toBeNull();
  });

  it('a role that may only change the shift has the changes on its bar, and no private sections', async () => {
    session.permissions = [READ, 'shift.assign.operational'];
    mockApi({ 'GET /v1/employees/e-1': [200, RECORD] });
    openEmployee('/employees/e-1');
    await screen.findByRole('heading', { name: 'Synthetic Person (SYN-1)' });
    expect(barLinks()).toEqual(['Overview', 'Changes']);
  });
});

describe('the new employee form in steps', () => {
  it('shows the form’s groups as steps that follow what is typed, and sends exactly what it sent before', async () => {
    session.permissions = ['employee.create.operational'];
    const calls = mockApi({
      'GET /v1/org/departments': [200, { items: [{ id: 'd-1', code: 'ENG', name: 'Engineering' }] }],
      'GET /v1/org/locations': [200, { items: [{ id: 'l-1', code: 'HQ', name: 'Head office' }] }],
      'GET /v1/org/designations': [200, { items: [{ id: 'g-1', code: 'DEV', name: 'Developer' }] }],
      'GET /v1/org/grades': [200, { items: [] }],
      'POST /v1/employees': [422, { error: 'SOME_RULE', message: 'Synthetic refusal' }],
    });
    openEmployee('/employees/new');
    const form = screen.getByRole('form', { name: 'New employee' });
    const steps = () => within(screen.getByRole('navigation', { name: 'Steps of New employee' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(steps()).toEqual(['Step 1: Identity and contact, 0 of 2 required', 'Step 2: Employment terms, 0 of 2 required', 'Step 3: Job assignment, 0 of 3 required']);
    expect(Array.from(form.querySelectorAll(':scope > fieldset > legend')).map((l) => l.textContent)).toEqual(['Identity and contact', 'Employment terms', 'Job assignment']);
    fireEvent.change(within(form).getByLabelText('Employee code'), { target: { value: 'syn-9' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Synthetic Joiner' } });
    expect(steps()[0]).toBe('Step 1: Identity and contact, complete');
    fireEvent.change(within(form).getByLabelText('Joining date'), { target: { value: '2026-04-01' } });
    fireEvent.change(within(form).getByLabelText('Employment type'), { target: { value: 'INTERN' } });
    await within(form).findByRole('option', { name: 'ENG Engineering' });
    fireEvent.change(within(form).getByLabelText('Department'), { target: { value: 'd-1' } });
    await within(form).findByRole('option', { name: 'HQ Head office' });
    fireEvent.change(within(form).getByLabelText('Location'), { target: { value: 'l-1' } });
    await within(form).findByRole('option', { name: 'DEV Developer' });
    fireEvent.change(within(form).getByLabelText('Designation'), { target: { value: 'g-1' } });
    await waitFor(() => expect(screen.getByRole('progressbar', { name: 'Required fields filled' }).getAttribute('aria-valuetext')).toBe('All 7 required fields filled'));
    fireEvent.click(within(form).getByRole('button', { name: 'Create employee' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(await within(form).findByRole('alert')).toBeTruthy();
  });

  it('the personal details are a step only with their own duty', () => {
    session.permissions = ['employee.create.operational', 'employee.create.personal'];
    mockApi({});
    openEmployee('/employees/new');
    const steps = within(screen.getByRole('navigation', { name: 'Steps of New employee' })).getAllByRole('button');
    expect(steps.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Step 1: Identity and contact, 0 of 2 required',
      'Step 2: Employment terms, 0 of 2 required',
      'Step 3: Job assignment, 0 of 3 required',
      'Step 4: Personal details, no required fields',
    ]);
  });
});

describe('accessibility', () => {
  // As in a11y.test.tsx: a page on its own, so no colour contrast (no layout in jsdom) and no landmark "region" rule.
  const check = async (container: Element) => expect(await axe(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).toHaveNoViolations();

  it('the record with its header card and section bar, and the new employee form with its steps, give axe no violations', async () => {
    session.permissions = [READ, 'employee.update.operational', 'employee.read.private', 'employee.read_history.operational'];
    mockApi({
      'GET /v1/employees/e-1/history': [200, { leavingDate: null, priorEmployment: null, nextEmployment: null, shifts: [] }],
      'GET /v1/employees/e-1': [200, RECORD],
    });
    const record = openEmployee('/employees/e-1');
    await screen.findByRole('navigation', { name: 'Sections of this record' });
    await check(record.container);
    cleanup();

    session.permissions = ['employee.create.operational', 'employee.create.personal'];
    mockApi({ 'GET /v1/org/': [200, { items: [] }] });
    const form = openEmployee('/employees/new');
    await screen.findByRole('navigation', { name: 'Steps of New employee' });
    await check(form.container);
  });
});

describe('the other long forms in steps', () => {
  const stepsOf = (label: string) => within(screen.getByRole('navigation', { name: `Steps of ${label}` })).getAllByRole('button').map((b) => b.getAttribute('aria-label'));

  it('a new requisition: the position, why it is needed, and the hiring manager and budget', async () => {
    session.permissions = ['requisition.create.operational', 'org_master.read.operational'];
    mockApi({ 'GET /v1/org/': [200, { items: [] }] });
    show('/hiring/requisitions/new', <NewRequisitionScreen />);
    const form = await screen.findByRole('form', { name: 'New requisition' });
    await waitFor(() =>
      expect(stepsOf('New requisition')).toEqual(['Step 1: The position, 0 of 7 required', 'Step 2: Why it is needed, 0 of 2 required', 'Step 3: Hiring manager and budget, 0 of 1 required']),
    );
    fireEvent.click(within(form).getByLabelText('Replacement'));
    fireEvent.change(within(form).getByLabelText('Reason for the requisition'), { target: { value: 'Synthetic: replaces a leaver' } });
    expect(stepsOf('New requisition')[1]).toBe('Step 2: Why it is needed, complete');
    // The form's own check is unchanged: nothing is sent while a field is missing.
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('Enter the position title.');
  });

  it('a bank file template: its required fields are the ones its own check refuses without', async () => {
    session.permissions = ['payroll_bank_template.read.operational', 'payroll_bank_template.manage.operational'];
    const calls = mockApi({ 'GET /v1/payroll-outputs/bank-templates': [200, { items: [] }] });
    show('/payroll/bank-templates', <TemplatesScreen />);
    const form = await screen.findByRole('form', { name: 'Bank file template' });
    await waitFor(() =>
      expect(stepsOf('Bank file template')).toEqual(['Step 1: The template, 0 of 4 required', 'Step 2: File format, complete', 'Step 3: Records and their fields, no required fields']),
    );
    expect(screen.getByRole('progressbar', { name: 'Required fields filled' }).getAttribute('aria-valuetext')).toBe('6 of 10 required fields filled');
    for (const [label, value] of [
      ['Template code', 'syn_bank'],
      ['Template name', 'Synthetic bank'],
      ['Currency', 'inr'],
      ['Bank specification reference', 'SYN-SPEC-1'],
    ]) {
      fireEvent.change(within(form).getByLabelText(label!), { target: { value } });
    }
    expect(stepsOf('Bank file template')[0]).toBe('Step 1: The template, complete');
    fireEvent.click(within(form).getByRole('button', { name: 'Save as a draft version' }));
    expect(within(form).getByText('The detail record must carry the amount and the account identifier.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});

describe('my profile', () => {
  it('opens with the header card from the record already read, and a bar of the sections shown', async () => {
    session.permissions = ['profile_change.submit.operational', 'profile_change.read.operational'];
    const calls = mockApi({
      'GET /v1/employees/emp-1/profile-changes': [200, { items: [] }],
      'GET /v1/employees/emp-1': [
        200,
        {
          employeeCode: 'SYN-5',
          displayName: 'Synthetic Self',
          workEmail: null,
          joiningDate: '2026-01-05',
          status: 'ACTIVE_CONFIRMED',
          employmentType: 'PERMANENT',
          assignment: { departmentName: 'Engineering', locationName: 'Head office', designationName: 'Analyst' },
          manager: { id: 'e-2', employeeCode: 'SYN-2', displayName: 'Synthetic Lead' },
        },
      ],
    });
    show('/me/profile', <MyProfilePage />);
    expect(await screen.findByText('SYN-5 · Analyst')).toBeTruthy();
    expect(document.querySelector('[data-slot=profile-name]')!.textContent).toBe('Synthetic Self');
    expect(screen.getByText('Engineering · Head office')).toBeTruthy();
    expect(screen.getByText('Joined 5 Jan 2026')).toBeTruthy();
    expect(screen.getByText('Reports to Synthetic Lead')).toBeTruthy();
    expect(screen.getByText('SYN-5').tagName).toBe('DD');
    await waitFor(() => expect(barLinks()).toEqual(['My record', 'Ask for a change', 'Change requests']));
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set(['/v1/employees/emp-1', '/v1/employees/emp-1/profile-changes']));
  });
});

describe('a team member', () => {
  it('opens with the header card from the work profile and today’s reporting, and a bar of the tabs returned', async () => {
    mockApi({
      'GET /v1/my-team/e-7': [
        200,
        {
          employeeId: 'e-7',
          tabs: {
            workProfile: { available: true, data: { employeeCode: 'SYN-7', displayName: 'Synthetic Member', joiningDate: '2026-03-02', status: 'NOTICE', employmentType: 'FIXED_TERM' } },
            employmentAndReporting: {
              available: true,
              items: [
                { kind: 'ASSIGNMENT', effectiveFrom: '2026-03-02', effectiveTo: null, detail: 'Engineering' },
                { kind: 'MANAGER', effectiveFrom: '2026-03-02', effectiveTo: '2026-06-01', detail: 'Synthetic Former Lead' },
                { kind: 'MANAGER', effectiveFrom: '2026-06-01', effectiveTo: null, detail: 'Synthetic Lead' },
              ],
            },
            attendance: { available: true, items: [] },
          },
        },
      ],
    });
    show('/team/e-7', <TeamMemberPage />, '/team/:id');
    expect(await screen.findByText('SYN-7 · Fixed term')).toBeTruthy();
    expect(document.querySelector('[data-slot=profile-name]')!.textContent).toBe('Synthetic Member');
    expect(screen.getByText('serving notice')).toBeTruthy();
    expect(screen.getByText('Works in Engineering')).toBeTruthy();
    expect(screen.getByText('Joined 2 Mar 2026')).toBeTruthy();
    expect(screen.getByText('Reports to Synthetic Lead')).toBeTruthy();
    expect(barLinks()).toEqual(['Profile', 'Reporting', 'Attendance']);
    expect(screen.getByRole('heading', { name: 'Employment and reporting' }).closest('section')!.id).toBe('section-employmentAndReporting');
  });
});
