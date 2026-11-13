// One employee (jsdom; FR-006, FR-008; BR-002; DF04; DF08; I-55; I-82): a field group the server leaves out is not shown, a form is offered
// only with the duty its route checks, changes name the version on screen where the route takes one and send only what changed,
// activation names what is missing, refusals read in plain words beside what was typed, and the client adds no rule of its own.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPLOYEE_SCREENS, type EmployeeRecord } from './employee';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

const READ = 'employee.read.operational';
const LIST = 'employee.list.operational';
const CREATE = 'employee.create.operational';
const UPDATE = 'employee.update.operational';
const ACTIVATE = 'employee.activate.operational';
// Synthetic PANs, assembled at run time so no shared file holds a PAN-shaped string (ZT21; db/registers/privacy.ts).
const PAN_F = ['ABCDE', '1234', 'F'].join('');
const PAN_G = ['ABCDE', '1234', 'G'].join('');

type Reply = [number, unknown];
type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
type Routes_ = Record<string, Reply | ((c: Call) => Reply)>;
function mockApi(routes: Routes_) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const key = Object.keys(routes)
        .filter((k) => `${call.method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const route = key === undefined ? undefined : routes[key];
      const [status, body]: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: 'Resource not found' }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

/** The real route table of the module, so the static path has to win over the record's. */
const openAt = (entry: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {EMPLOYEE_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
          <Route path="/employees" element={<p>The employee list</p>} />
          <Route path="/employee-history/:id" element={<p>The timeline</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const click = (el: HTMLElement) => fireEvent.click(el);
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const valueOf = (el: HTMLElement) => (el as HTMLInputElement).value;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const asked = (calls: Call[], prefix: string) => calls.filter((c) => c.method === 'GET' && c.url.startsWith(prefix));
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const refusal = async (scope?: HTMLElement) => (scope ? (await within(scope).findByRole('alert')).textContent : (await screen.findByRole('alert')).textContent);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

const RECORD: EmployeeRecord = {
  id: 'e-1',
  employeeCode: 'SYN-1',
  displayName: 'Synthetic Person',
  workEmail: 'person@synthetic.test',
  joiningDate: '2026-02-01',
  confirmationDate: null,
  employmentType: 'FIXED_TERM',
  status: 'ACTIVE_PROBATION',
  assignment: { departmentId: 'd-1', departmentName: 'Engineering', locationId: 'l-1', locationName: 'Head office', designationId: 'g-1', designationName: 'Developer', gradeId: 'gr-1' },
  manager: { id: 'e-2', employeeCode: 'SYN-2', displayName: 'Synthetic Lead' },
  version: 7,
};
const DRAFT: EmployeeRecord = { ...RECORD, status: 'DRAFT' };
const ITEM = 'GET /v1/employees/e-1';
const MASTERS = {
  'GET /v1/org/departments': [200, { items: [{ id: 'd-1', code: 'ENG', name: 'Engineering' }, { id: 'd-2', code: 'OPS', name: 'Operations' }] }],
  'GET /v1/org/locations': [200, { items: [{ id: 'l-1', code: 'HQ', name: 'Head office' }] }],
  'GET /v1/org/designations': [200, { items: [{ id: 'g-1', code: 'DEV', name: 'Developer' }] }],
  'GET /v1/org/grades': [200, { items: [{ id: 'gr-1', code: 'G1', name: 'Grade one' }] }],
} as Routes_;

/** Opens the record with these duties and these answers; resolves once it is on screen. */
const openRecord = async (permissions: string[], routes: Routes_, record: EmployeeRecord = RECORD) => {
  session.permissions = permissions;
  const calls = mockApi({ [ITEM]: [200, record], ...routes });
  openAt('/employees/e-1');
  await screen.findByRole('heading', { name: `${record.displayName} (${record.employeeCode})` });
  return calls;
};
const openForm = (name: string) => {
  click(button(name));
  return screen.getByRole('form', { name });
};
const factOf = (label: string) => {
  const term = screen.queryByText(label, { selector: 'dt' });
  return term ? term.parentElement!.querySelector('dd')!.textContent : null;
};

describe('screens', () => {
  it('a menu entry under the create duty; the record under the read duty, reached by links', () => {
    expect(EMPLOYEE_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/employees/new', CREATE, true],
      ['/employees/:id', READ, false],
    ]);
  });

  it('/employees/new opens the form, never a record named "new"', async () => {
    session.permissions = [CREATE];
    const calls = mockApi(MASTERS);
    openAt('/employees/new');
    expect(screen.getByRole('form', { name: 'New employee' })).toBeTruthy();
    await waitFor(() => expect(asked(calls, '/v1/org/').length).toBeGreaterThan(0));
    expect(asked(calls, '/v1/employees')).toEqual([]);
  });
});

describe('the record (FR-006, FR-008)', () => {
  it('shows the operational fields in words; a role that only reads is offered no change and asks for nothing else', async () => {
    const calls = await openRecord([READ], {});
    expect(factOf('Employee code')).toBe('SYN-1');
    expect(factOf('Employment type')).toBe('Fixed term');
    expect(factOf('Status')).toBe('on probation');
    expect(factOf('Joining date')).toBe('1 Feb 2026');
    expect(factOf('Confirmation date')).toBe('—');
    expect(factOf('Department')).toBe('Engineering');
    expect(factOf('Location')).toBe('Head office');
    expect(factOf('Designation')).toBe('Developer');
    expect(screen.getByRole('link', { name: 'Synthetic Lead (SYN-2)' }).getAttribute('href')).toBe('/employees/e-2');
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Change this record' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Activation' })).toBeNull();
    expect(screen.queryByRole('link', { name: '← Employees' })).toBeNull();
    expect(calls.map((c) => c.url)).toEqual(['/v1/employees/e-1']);
    expect(document.body.textContent).not.toContain('gr-1');
  });

  it('a personal field the server left out is not shown, even with the duty to update it; one it sent is, even when blank', async () => {
    await openRecord([READ, 'employee.update.personal'], {});
    expect(factOf('Date of birth')).toBeNull();
    expect(factOf('Service anniversary base date')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
    cleanup();

    await openRecord([READ], {}, { ...RECORD, dateOfBirth: '1990-05-04', serviceAnniversaryDate: null });
    expect(factOf('Date of birth')).toBe('4 May 1990');
    expect(factOf('Service anniversary base date')).toBe('—');
  });

  it('no assignment, shift or manager on the business date reads so', async () => {
    await openRecord([READ], {}, { ...RECORD, assignment: null, manager: null, shift: null });
    expect(factOf('Job assignment')).toBe('None in force today');
    expect(factOf('Shift')).toBe('None in force today');
    expect(factOf('Manager')).toBe('None in force today');
    expect(factOf('Department')).toBeNull();
    expect(factOf('Grade')).toBeNull();
  });

  it('the shift and the grade read from the record, asking for nothing else; no id is shown', async () => {
    const calls = await openRecord([READ], {}, { ...RECORD, shift: { id: 's-1', code: 'DAY', name: 'Day shift' }, assignment: { ...RECORD.assignment!, gradeCode: 'G1', gradeName: 'Grade one' } });
    expect(factOf('Shift')).toBe('DAY Day shift');
    expect(factOf('Grade')).toBe('G1 Grade one');
    expect(calls.map((c) => c.url)).toEqual(['/v1/employees/e-1']);
    expect(document.body.textContent).not.toContain('gr-1');
    expect(document.body.textContent).not.toContain('s-1');
  });

  it('a grade the server gave no words for is not shown, even with the master’s duty and an id', async () => {
    const calls = await openRecord([READ, 'org_master.read.operational'], {});
    expect(factOf('Grade')).toBeNull();
    expect(asked(calls, '/v1/org/grades')).toEqual([]);
    expect(document.body.textContent).not.toContain('gr-1');
  });

  it('the reason for having no manager shows when the server sent one; left out or blank, it does not', async () => {
    await openRecord([READ], {}, { ...RECORD, manager: null, noManagerReason: 'Top of the company' });
    expect(factOf('Reason for having no manager')).toBe('Top of the company');
    cleanup();

    await openRecord([READ], {}, { ...RECORD, manager: null });
    expect(factOf('Reason for having no manager')).toBeNull();
    cleanup();

    await openRecord([READ], {}, { ...RECORD, noManagerReason: null });
    expect(factOf('Reason for having no manager')).toBeNull();
  });

  it('out of scope and nonexistent read the same, and an ill-formed address reads as not found', async () => {
    session.permissions = [READ];
    mockApi({ [ITEM]: [404, { error: 'NOT_FOUND', message: 'Resource not found' }] });
    openAt('/employees/e-1');
    expect(await screen.findByText('This employee was not found, or is outside the scope of your role.')).toBeTruthy();
    cleanup();
    mockApi({ 'GET /v1/employees/abc': [400, { error: 'INVALID_REQUEST', message: 'params/id must match format "uuid"' }] });
    openAt('/employees/abc');
    expect(await screen.findByText('This employee was not found, or is outside the scope of your role.')).toBeTruthy();
  });

  it('links back to the list and to documents only with their duties', async () => {
    await openRecord([READ], {});
    expect(screen.queryByRole('link', { name: 'Documents' })).toBeNull();
    cleanup();
    await openRecord([READ, LIST, 'document.read.document'], {});
    expect(screen.getByRole('link', { name: '← Employees' }).getAttribute('href')).toBe('/employees');
    expect(screen.getByRole('link', { name: 'Documents' }).getAttribute('href')).toBe('/employees/e-1/documents');
  });

});

describe('private details (FR-008, under the role’s own grant)', () => {
  const PRIVATE = 'GET /v1/employees/e-1/private-profile';

  it('without either grant nothing is offered and nothing is read', async () => {
    const calls = await openRecord([READ], {});
    expect(screen.queryByRole('heading', { name: 'Private details' })).toBeNull();
    expect(asked(calls, '/v1/employees/e-1/private-profile')).toEqual([]);
  });

  it('is read only when asked for; shows the categories the server sent, and marks masked bank values', async () => {
    const calls = await openRecord(['employee.read.bank', READ], {
      [PRIVATE]: [200, { employeeId: 'e-1', bank: { revision: 2, effectiveFrom: '2026-01-01', masked: true, values: { holderName: 'Synthetic Person', accountIdentifier: '****1234', routingReference: null, countryCode: 'IN' } } }],
    });
    expect(asked(calls, '/v1/employees/e-1/private-profile')).toEqual([]);
    click(button('Show private details'));
    expect(await screen.findByRole('heading', { name: /Bank details/ })).toBeTruthy();
    expect(screen.getByText('masked')).toBeTruthy();
    expect(factOf('Account identifier')).toBe('****1234');
    expect(factOf('Holder name')).toBe('Synthetic Person');
    expect(factOf('Routing reference')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Personal details' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Address' })).toBeNull();
    click(button('Hide private details'));
    expect(screen.queryByText('****1234')).toBeNull();
  });

  it('full values carry no mark; a category with no values says so; a refusal reads in plain words', async () => {
    await openRecord(['employee.read.private', READ], {
      [PRIVATE]: [200, { personal: { revision: 1, effectiveFrom: null, values: { personalEmail: 'home@synthetic.test' } }, address: { revision: 0, effectiveFrom: null, values: null } }],
    });
    click(button('Show private details'));
    await screen.findByRole('heading', { name: 'Personal details' });
    expect(factOf('Personal email')).toBe('home@synthetic.test');
    expect(screen.queryByText('masked')).toBeNull();
    expect(screen.getByText('Nothing recorded yet.')).toBeTruthy();
    cleanup();

    await openRecord(['employee.read.private', READ], { [PRIVATE]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    click(button('Show private details'));
    expect(await screen.findByText('Your role is not permitted to read this.')).toBeTruthy();
  });
});

describe('record sections (FR-008, I-82 item 2: family, qualifications, prior employment, payroll identifiers)', () => {
  const SECTIONS = 'GET /v1/employees/e-1/record-sections';
  const SECTIONS_PATH = '/v1/employees/e-1/record-sections';
  const READ_PRIVATE = 'employee.read.private';
  const READ_PAYROLL = 'employee.read.payroll_id';
  const MANAGE_PRIVATE = 'employee.manage.private';
  const MANAGE_PAYROLL = 'employee.manage.payroll_id';
  const SHOW = 'Show family, qualifications and prior employment';
  const META = { createdAt: '2026-03-01T06:00:00Z', updatedAt: '2026-03-01T06:00:00Z', removedAt: null, removalReason: null };
  const FAMILY = { id: 'f-1', version: 1, ...META, relationship: 'SPOUSE', relationshipLabel: 'Spouse', fullName: 'Synthetic Partner', dateOfBirth: '1991-07-09', dependant: true };
  const QUALIFICATION = { id: 'q-1', version: 2, ...META, level: 'GRADUATE', levelLabel: 'Graduate', qualification: 'Synthetic Degree', specialisation: null, institution: 'Synthetic University', completionYear: 2012 };
  const PRIOR = { id: 'p-1', version: 1, ...META, employerName: 'Synthetic Earlier Co', designation: 'Analyst', fromDate: '2015-01-01', toDate: '2025-12-31' };
  const MASKED = { values: { pan: '••••234F', uan: null, esicIpNumber: '••••7890' }, masked: true, version: 3 };
  const ALL = { employeeId: 'e-1', 'family-members': [FAMILY], qualifications: [QUALIFICATION], 'prior-employments': [PRIOR], 'payroll-identifiers': MASKED };
  const RELATIONSHIPS = { category: 'FAMILY_RELATIONSHIP', items: [{ code: 'CHILD', label: 'Child' }, { code: 'SPOUSE', label: 'Spouse' }] };
  const LEVELS = { category: 'QUALIFICATION_LEVEL', items: [{ code: 'GRADUATE', label: 'Graduate' }, { code: 'POSTGRADUATE', label: 'Postgraduate' }] };
  const ADD_PRIOR = 'POST /v1/employees/e-1/record-sections/prior-employments';
  const rowsOf = (name: string) =>
    within(screen.getByRole('table', { name }))
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
  const sectionReads = (calls: Call[]) => asked(calls, SECTIONS_PATH);
  /** Opens the add form of a prior employment and saves what it is given. */
  const addPrior = async () => {
    click(button(SHOW));
    await screen.findByRole('table', { name: 'Prior employment' });
    const form = openForm('Add a prior employment');
    type(within(form).getByLabelText('Employer'), ' Synthetic Later Co ');
    type(within(form).getByLabelText('From'), '2025-06-01');
    type(within(form).getByLabelText('To (inclusive)'), '2026-03-31');
    click(within(form).getByRole('button', { name: 'Save prior employment' }));
    return form;
  };

  it('FR-008 shows only the sections the grant reads (absent keys hidden) and masks identifiers', async () => {
    // Neither read grant: nothing is offered and nothing is read, whatever the change duties.
    let calls = await openRecord([READ, MANAGE_PRIVATE, MANAGE_PAYROLL], {});
    expect(screen.queryByRole('heading', { name: 'Family, qualifications and prior employment' })).toBeNull();
    expect(screen.queryByText(/open owner question/)).toBeNull();
    expect(sectionReads(calls)).toEqual([]);
    cleanup();

    // The private group: the list sections, and the identifiers masked; read only when asked for.
    calls = await openRecord([READ, READ_PRIVATE], { [SECTIONS]: [200, ALL] });
    expect(sectionReads(calls)).toEqual([]);
    click(button(SHOW));
    await screen.findByRole('table', { name: 'Family and dependants' });
    expect(sectionReads(calls).map((c) => c.url)).toEqual([SECTIONS_PATH]);
    expect(rowsOf('Family and dependants')).toEqual([['Spouse', 'Synthetic Partner', '9 Jul 1991', 'Yes']]);
    expect(rowsOf('Qualifications')).toEqual([['Graduate', 'Synthetic Degree', '—', 'Synthetic University', '2012']]);
    expect(rowsOf('Prior employment')).toEqual([['Synthetic Earlier Co', 'Analyst', '1 Jan 2015', '31 Dec 2025']]);
    expect(within(screen.getByRole('heading', { name: /^Payroll identifiers/ })).getByText('masked')).toBeTruthy();
    expect(factOf('PAN')).toBe('••••234F');
    expect(factOf('UAN (EPF)')).toBe('—');
    expect(factOf('ESIC IP number')).toBe('••••7890');
    for (const text of ['SPOUSE', 'GRADUATE', 'f-1', 'q-1']) expect(document.body.textContent).not.toContain(text);
    click(button('Hide family, qualifications and prior employment'));
    expect(screen.queryByText('Synthetic Partner')).toBeNull();
    cleanup();

    // The payroll-identifier group alone: the parts the server left out are not shown, not even as blanks; values come in full.
    await openRecord([READ, READ_PAYROLL], { [SECTIONS]: [200, { employeeId: 'e-1', 'payroll-identifiers': { values: { pan: PAN_F, uan: null, esicIpNumber: null }, masked: false, version: 3 } }] });
    click(button(SHOW));
    await screen.findByRole('heading', { name: 'Payroll identifiers' });
    expect(factOf('PAN')).toBe(PAN_F);
    expect(screen.queryByText('masked')).toBeNull();
    for (const name of ['Family and dependants', 'Qualifications', 'Prior employment']) expect(screen.queryByRole('heading', { name })).toBeNull();
    expect(screen.queryByText('Nothing recorded yet.')).toBeNull();
    expect(screen.queryByLabelText('Show removed entries')).toBeNull();
    cleanup();

    // A refusal to read reads in plain words.
    await openRecord([READ, READ_PRIVATE], { [SECTIONS]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    click(button(SHOW));
    expect(await screen.findByText('Your role is not permitted to read this.')).toBeTruthy();
  });

  it('FR-008 offers the section forms only with the manage duty and says a refusal in plain words', async () => {
    await openRecord([READ, READ_PRIVATE, MANAGE_PAYROLL], { [SECTIONS]: [200, ALL] });
    click(button(SHOW));
    await screen.findByRole('table', { name: 'Family and dependants' });
    for (const name of ['Add a family member', 'Add a qualification', 'Add a prior employment', 'Edit', 'Remove']) expect(screen.queryByRole('button', { name })).toBeNull();
    // The identifiers' own duty offers their form, beside the part that was read.
    expect(button('Change payroll identifiers')).toBeTruthy();
    cleanup();

    const calls = await openRecord([READ, READ_PRIVATE, MANAGE_PRIVATE], {
      [SECTIONS]: [200, ALL],
      [ADD_PRIOR]: [422, { error: 'CHRONOLOGY_CONFLICT', message: 'A prior employment ends before this employment’s joining date', details: { field: 'toDate', joiningDate: '2026-02-01' } }],
    });
    const form = await addPrior();
    expect(await refusal(form)).toBe('A prior employment must end before the joining date of this employment, 2026-02-01.');
    expect(writes(calls)).toEqual([{ method: 'POST', url: '/v1/employees/e-1/record-sections/prior-employments', body: { employerName: 'Synthetic Later Co', fromDate: '2025-06-01', toDate: '2026-03-31' } }]);
    expect(valueOf(within(form).getByLabelText('Employer'))).toBe(' Synthetic Later Co ');
    expect(valueOf(within(form).getByLabelText('To (inclusive)'))).toBe('2026-03-31');
    for (const name of ['Add a family member', 'Add a qualification']) expect(button(name)).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Qualifications' })).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change payroll identifiers' })).toBeNull();
  });

  it.each([
    [422, { error: 'INVALID_PERIOD', message: 'x', details: { field: 'toDate' } }, 'The prior employment ends before it starts. Check the start and end dates.'],
    [422, { error: 'INVALID_DATE', message: 'x', details: { field: 'fromDate' } }, 'The start date must be a calendar date, and not in the future.'],
    [422, { error: 'FIELD_REQUIRED', message: 'x', details: { field: 'employerName' } }, 'The employer is required. Fill it in and try again.'],
    [422, { error: 'INVALID_FIELD', message: 'x', details: { field: 'designation' } }, 'The designation is not valid. Check it and try again.'],
    [422, { error: 'UNKNOWN_FIELD', message: 'x', details: { field: 'salary' } }, 'The server does not keep one of the fields sent, so nothing was saved. Reload the page and try again.'],
    [403, { error: 'SELF_ACTION_NOT_ALLOWED', message: 'x' }, 'This change involves your own record, so another administrator must make it.'],
  ])('FR-008 a refused entry reads in plain words and keeps what was typed (%i %#)', async (status, body, words) => {
    await openRecord([READ, READ_PRIVATE, MANAGE_PRIVATE], { [SECTIONS]: [200, ALL], [ADD_PRIOR]: [status, body] });
    const form = await addPrior();
    expect(await refusal(form)).toBe(words);
    expect(valueOf(within(form).getByLabelText('From'))).toBe('2025-06-01');
  });

  it('FR-008 a family member is added with a relationship from the company list, and the sections are read again', async () => {
    const calls = await openRecord([READ, READ_PRIVATE, MANAGE_PRIVATE], {
      [SECTIONS]: [200, ALL],
      'GET /v1/reference-values?category=FAMILY_RELATIONSHIP': [200, RELATIONSHIPS],
      'POST /v1/employees/e-1/record-sections/family-members': [201, { id: 'f-2', section: 'family-members' }],
    });
    click(button(SHOW));
    await screen.findByRole('table', { name: 'Family and dependants' });
    const form = openForm('Add a family member');
    await within(form).findByRole('option', { name: 'Child' });
    type(within(form).getByLabelText('Relationship'), 'CHILD');
    type(within(form).getByLabelText('Full name'), ' Synthetic Child ');
    click(within(form).getByLabelText('Dependant'));
    click(within(form).getByRole('button', { name: 'Save family member' }));
    expect(await screen.findByText('Family member added.')).toBeTruthy();
    // A blank optional field is not sent; the dependant answer always is.
    expect(writes(calls)).toEqual([{ method: 'POST', url: '/v1/employees/e-1/record-sections/family-members', body: { relationship: 'CHILD', fullName: 'Synthetic Child', dependant: true } }]);
    expect(screen.queryByRole('form', { name: 'Add a family member' })).toBeNull();
    await waitFor(() => expect(sectionReads(calls)).toHaveLength(2));
  });

  it('FR-008 an entry is changed with all its fields and its version, and removed with a reason; removed entries show only when asked for', async () => {
    const REMOVED = { ...FAMILY, id: 'f-0', fullName: 'Synthetic Former', removedAt: '2026-04-01T06:00:00Z', removalReason: 'Recorded in error' };
    const calls = await openRecord([READ, READ_PRIVATE, MANAGE_PRIVATE], {
      [SECTIONS]: (c) => [200, c.url.endsWith('?includeRemoved=true') ? { ...ALL, 'family-members': [REMOVED, FAMILY] } : ALL],
      'GET /v1/reference-values?category=QUALIFICATION_LEVEL': [200, LEVELS],
      'PUT /v1/employees/e-1/record-sections/qualifications/q-1': [200, { id: 'q-1', section: 'qualifications', version: 3 }],
      'POST /v1/employees/e-1/record-sections/family-members/f-1/remove': [200, { id: 'f-1', section: 'family-members', removed: true }],
    });
    click(button(SHOW));
    click(within(await screen.findByRole('table', { name: 'Qualifications' })).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit qualification' });
    await within(form).findByRole('option', { name: 'Postgraduate' });
    expect(valueOf(within(form).getByLabelText('Level'))).toBe('GRADUATE');
    expect(valueOf(within(form).getByLabelText('Year of completion'))).toBe('2012');
    type(within(form).getByLabelText('Level'), 'POSTGRADUATE');
    type(within(form).getByLabelText('Institution or board'), ' ');
    type(within(form).getByLabelText('Year of completion'), '2014');
    click(within(form).getByRole('button', { name: 'Save qualification' }));
    expect(await screen.findByText('Qualification saved.')).toBeTruthy();
    // Every field is named; a blank optional one as null, which clears it.
    expect(writes(calls)).toEqual([
      { method: 'PUT', url: '/v1/employees/e-1/record-sections/qualifications/q-1', body: { level: 'POSTGRADUATE', qualification: 'Synthetic Degree', specialisation: null, institution: null, completionYear: 2014, expectedVersion: 2 } },
    ]);

    click(within(screen.getByRole('table', { name: 'Family and dependants' })).getByRole('button', { name: 'Remove' }));
    const remove = screen.getByRole('form', { name: 'Remove family member' });
    expect((within(remove).getByLabelText('Reason') as HTMLInputElement).required).toBe(true);
    type(within(remove).getByLabelText('Reason'), ' Recorded in error ');
    click(within(remove).getByRole('button', { name: 'Confirm removal' }));
    expect(await screen.findByText(/^Family member removed\./)).toBeTruthy();
    expect(writes(calls)[1]).toEqual({ method: 'POST', url: '/v1/employees/e-1/record-sections/family-members/f-1/remove', body: { reason: 'Recorded in error', expectedVersion: 1 } });

    expect(sectionReads(calls).filter((c) => c.url.includes('includeRemoved'))).toEqual([]);
    expect(screen.queryByText('Synthetic Former')).toBeNull();
    click(screen.getByLabelText('Show removed entries'));
    const row = (await screen.findByText('Synthetic Former')).closest('tr')!;
    expect(sectionReads(calls).at(-1)!.url).toBe('/v1/employees/e-1/record-sections?includeRemoved=true');
    expect(within(row).getByText('removed')).toBeTruthy();
    expect(row.textContent).toContain('Recorded in error');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('CL-007 the qualification is offered from the qualification master as suggestions, and any other text may still be typed', async () => {
    const calls = await openRecord([READ, READ_PRIVATE, MANAGE_PRIVATE], {
      [SECTIONS]: [200, ALL],
      'GET /v1/reference-values?category=QUALIFICATION_LEVEL': [200, LEVELS],
      'GET /v1/reference-values?category=QUALIFICATION': [200, { category: 'QUALIFICATION', items: [{ code: 'BTECH', label: 'B.Tech' }, { code: 'MBA', label: 'MBA' }] }],
      'PUT /v1/employees/e-1/record-sections/qualifications/q-1': [200, { id: 'q-1', section: 'qualifications', version: 3 }],
    });
    click(button(SHOW));
    click(within(await screen.findByRole('table', { name: 'Qualifications' })).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit qualification' });
    const field = within(form).getByLabelText('Qualification') as HTMLInputElement;
    await waitFor(() => expect([...(document.getElementById(field.getAttribute('list')!)?.querySelectorAll('option') ?? [])].map((o) => o.getAttribute('value'))).toEqual(['B.Tech', 'MBA']));
    type(field, 'Synthetic Diploma not in the list');
    click(within(form).getByRole('button', { name: 'Save qualification' }));
    expect(await screen.findByText('Qualification saved.')).toBeTruthy();
    expect(writes(calls)[0]!.body).toMatchObject({ qualification: 'Synthetic Diploma not in the list' });
  });

  it('FR-008 a stale entry reloads the sections and keeps what was typed; the next save names the version now read', async () => {
    let current = ALL;
    const calls = await openRecord([READ, READ_PRIVATE, MANAGE_PRIVATE], {
      [SECTIONS]: () => [200, current],
      'PUT /v1/employees/e-1/record-sections/prior-employments/p-1': (c) => {
        if (c.body!.expectedVersion === 2) return [200, { id: 'p-1', section: 'prior-employments', version: 3 }];
        current = { ...ALL, 'prior-employments': [{ ...PRIOR, designation: 'Senior Analyst', version: 2 }] };
        return [409, { error: 'STALE_VERSION', message: 'The entry changed; reload and retry' }];
      },
    });
    click(button(SHOW));
    click(within(await screen.findByRole('table', { name: 'Prior employment' })).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit prior employment' });
    type(within(form).getByLabelText('Employer'), 'Synthetic Renamed Co');
    click(within(form).getByRole('button', { name: 'Save prior employment' }));
    expect(await refusal(form)).toContain('What you typed is still here');
    await waitFor(() => expect(rowsOf('Prior employment')[0]![1]).toBe('Senior Analyst'));
    expect(valueOf(within(form).getByLabelText('Employer'))).toBe('Synthetic Renamed Co');
    click(within(form).getByRole('button', { name: 'Save prior employment' }));
    expect(await screen.findByText('Prior employment saved.')).toBeTruthy();
    expect(writes(calls).at(-1)!.body).toEqual({ employerName: 'Synthetic Renamed Co', designation: 'Analyst', fromDate: '2015-01-01', toDate: '2025-12-31', expectedVersion: 2 });
  });

  it('FR-008 payroll identifiers form sends only changed identifiers with the read version', async () => {
    let current = { values: { pan: PAN_F, uan: null as string | null, esicIpNumber: '1234567890' as string | null }, masked: false, version: 3 };
    const PUT = 'PUT /v1/employees/e-1/payroll-identifiers';
    const calls = await openRecord([READ, READ_PAYROLL, MANAGE_PAYROLL], {
      [SECTIONS]: () => [200, { employeeId: 'e-1', 'payroll-identifiers': current }],
      [PUT]: () => {
        current = { values: { pan: PAN_F, uan: '100120023003', esicIpNumber: null }, masked: false, version: current.version + 1 };
        return [200, { employeeId: 'e-1', recorded: ['PAN', 'UAN'], changed: ['ESIC_IP', 'UAN'], version: current.version }];
      },
    });
    click(button(SHOW));
    await screen.findByRole('heading', { name: 'Payroll identifiers' });
    let form = openForm('Change payroll identifiers');
    // Nothing is filled in from the record, and only an identifier on record can be cleared.
    for (const label of ['PAN', 'UAN (EPF)', 'ESIC IP number']) expect(valueOf(within(form).getByLabelText(label))).toBe('');
    expect(within(form).queryByLabelText('Clear the UAN (EPF)')).toBeNull();
    type(within(form).getByLabelText('UAN (EPF)'), ' 100120023003 ');
    click(within(form).getByLabelText('Clear the ESIC IP number'));
    click(within(form).getByRole('button', { name: 'Save payroll identifiers' }));
    expect(await screen.findByText('Payroll identifiers saved: ESIC IP number, UAN (EPF) changed.')).toBeTruthy();
    expect(writes(calls)).toEqual([{ method: 'PUT', url: '/v1/employees/e-1/payroll-identifiers', body: { uan: '100120023003', esicIpNumber: null, expectedVersion: 3 } }]);
    // What was typed is cleared, and the next change names the version read again.
    expect(screen.queryByRole('form', { name: 'Change payroll identifiers' })).toBeNull();
    await waitFor(() => expect(factOf('ESIC IP number')).toBe('—'));
    form = openForm('Change payroll identifiers');
    expect(valueOf(within(form).getByLabelText('UAN (EPF)'))).toBe('');
    type(within(form).getByLabelText('PAN'), PAN_G);
    click(within(form).getByRole('button', { name: 'Save payroll identifiers' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.body).toEqual({ pan: PAN_G, expectedVersion: 4 });
    cleanup();

    // Nothing recorded yet: no version to name and nothing to clear; nothing typed asks nothing of the server.
    const first = await openRecord([READ, READ_PRIVATE, MANAGE_PAYROLL], {
      [SECTIONS]: [200, { employeeId: 'e-1', 'family-members': [], qualifications: [], 'prior-employments': [], 'payroll-identifiers': { values: { pan: null, uan: null, esicIpNumber: null }, masked: true, version: null } }],
      [PUT]: [422, { error: 'INVALID_IDENTIFIER', message: 'x', details: { field: 'pan' } }],
    });
    click(button(SHOW));
    await screen.findByRole('heading', { name: /^Payroll identifiers/ });
    form = openForm('Change payroll identifiers');
    expect(within(form).queryByLabelText(/^Clear the/)).toBeNull();
    click(within(form).getByRole('button', { name: 'Save payroll identifiers' }));
    expect(await within(form).findByText('Nothing changed.')).toBeTruthy();
    expect(writes(first)).toEqual([]);
    type(within(form).getByLabelText('PAN'), 'abcde1234');
    click(within(form).getByRole('button', { name: 'Save payroll identifiers' }));
    expect(await refusal(form)).toBe('The PAN is five letters, four digits and a letter. Check it and try again.');
    expect(writes(first)).toEqual([{ method: 'PUT', url: '/v1/employees/e-1/payroll-identifiers', body: { pan: 'abcde1234' } }]);
    expect(valueOf(within(form).getByLabelText('PAN'))).toBe('abcde1234');
    cleanup();

    // The duty to change them without any part read offers no form: there is no version to name.
    const none = await openRecord([READ, MANAGE_PAYROLL], {});
    expect(screen.queryByRole('button', { name: 'Change payroll identifiers' })).toBeNull();
    expect(sectionReads(none)).toEqual([]);
  });

  it.each([
    [422, { error: 'NO_CHANGE', message: 'x' }, 'Nothing differs from the identifiers on record, so nothing was saved.'],
    [409, { error: 'STALE_VERSION', message: 'x' }, 'The payroll identifiers changed since you opened this. They have been reloaded; check them and try again. What you typed is still here.'],
    [422, { error: 'INVALID_IDENTIFIER', message: 'x', details: { field: 'esicIpNumber' } }, 'The ESIC IP number is ten digits. Check it and try again.'],
  ])('FR-008 a refused identifier change reads in plain words and never repeats the value (%i %#)', async (status, body, words) => {
    const calls = await openRecord([READ, READ_PAYROLL, MANAGE_PAYROLL], {
      [SECTIONS]: [200, { employeeId: 'e-1', 'payroll-identifiers': { values: { pan: null, uan: null, esicIpNumber: '1234567890' }, masked: false, version: 1 } }],
      'PUT /v1/employees/e-1/payroll-identifiers': [status, body],
    });
    click(button(SHOW));
    await screen.findByRole('heading', { name: 'Payroll identifiers' });
    const form = openForm('Change payroll identifiers');
    type(within(form).getByLabelText('ESIC IP number'), '98765');
    click(within(form).getByRole('button', { name: 'Save payroll identifiers' }));
    const text = await refusal(form);
    expect(text).toBe(words);
    expect(text).not.toContain('98765');
    if (body.error === 'STALE_VERSION') await waitFor(() => expect(sectionReads(calls)).toHaveLength(2));
  });
});

/** GET /v1/employees/:id/history in full: the page reads only what the employee history screen does not carry. */
const HISTORY = {
  employeeId: 'e-1',
  joiningDate: '2026-02-01',
  confirmationDate: '2026-08-01',
  leavingDate: null,
  priorEmployment: { employeeId: 'e-0', employeeCode: 'SYN-0' },
  nextEmployment: null,
  statuses: [
    { status: 'DRAFT', priorStatus: null, effectiveDate: '2026-01-20', sourceKind: 'CREATE', actorAccountKey: 'hr.admin', recordedAt: '2026-01-20T06:00:00Z' },
    { status: 'ACTIVE_PROBATION', priorStatus: 'DRAFT', effectiveDate: '2026-02-01', sourceKind: 'ACTIVATION', actorAccountKey: null, recordedAt: '2026-01-25T06:00:00Z' },
    { status: 'NOTICE', priorStatus: 'ACTIVE_PROBATION', effectiveDate: '2026-09-01', sourceKind: 'SOME_NEW_SOURCE', actorAccountKey: 'hr.admin', recordedAt: '2026-08-25T06:00:00Z' },
  ],
  joiningDateChanges: [{ priorDate: '2026-01-15', newDate: '2026-02-01', actorAccountKey: 'hr.admin', recordedAt: '2026-01-21T06:00:00Z' }],
  assignments: [
    { effectiveFrom: '2026-02-01', effectiveTo: '2026-06-01', departmentName: 'Engineering', locationName: 'Head office', designationName: 'Developer', gradeCode: 'G1' },
    { effectiveFrom: '2026-06-01', effectiveTo: null, departmentName: 'Operations', locationName: 'Head office', designationName: 'Developer', gradeCode: null },
  ],
  managers: [{ effectiveFrom: '2026-02-01', effectiveTo: null, managerId: 'e-2', managerCode: 'SYN-2', managerName: 'Synthetic Lead' }],
  shifts: [{ effectiveFrom: '2026-02-01', effectiveTo: null, shiftCode: 'DAY', shiftName: 'Day shift' }],
};

describe('employment history (FR-006)', () => {
  const HISTORY_DUTY = 'employee.read_history.operational';
  const rowsOf = (name: string) =>
    within(screen.getByRole('table', { name }))
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));

  const LINK = 'Status and employment history';

  it('without its own duty there is no link to the employee history and nothing is asked for', async () => {
    const calls = await openRecord([READ], {});
    expect(screen.queryByRole('link', { name: LINK })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Employment history' })).toBeNull();
    expect(asked(calls, '/v1/employees/e-1/history')).toEqual([]);
  });

  it('status history is one link to the employee history; what that screen already shows is not repeated here', async () => {
    await openRecord([READ, HISTORY_DUTY], { 'GET /v1/employees/e-1/history': [200, HISTORY] });
    expect(screen.getByRole('link', { name: LINK }).getAttribute('href')).toBe('/employee-history/e-1');
    await screen.findByRole('table', { name: 'Shifts' });
    for (const name of ['Status history', 'Job assignments', 'Managers', 'Joining date corrections']) expect(screen.queryByRole('table', { name })).toBeNull();
    // Sent by the API, shown only on the employee history.
    for (const text of ['hr.admin', 'Operations', 'notice']) expect(screen.queryByText(text)).toBeNull();
    click(screen.getByRole('link', { name: LINK }));
    expect(await screen.findByText('The timeline')).toBeTruthy();
  });

  it('keeps what the employee history does not carry: shift periods, the last working date and linked employments; no record ids', async () => {
    await openRecord([READ, HISTORY_DUTY], { 'GET /v1/employees/e-1/history': [200, { ...HISTORY, leavingDate: '2026-12-31', nextEmployment: { employeeId: 'e-5', employeeCode: 'SYN-5' } }] });
    await screen.findByRole('table', { name: 'Shifts' });
    expect(rowsOf('Shifts')).toEqual([['1 Feb 2026', 'Open', 'DAY Day shift']]);
    expect(factOf('Last working date')).toBe('31 Dec 2026');
    expect(screen.getByRole('link', { name: 'SYN-0' }).getAttribute('href')).toBe('/employees/e-0');
    expect(screen.getByRole('link', { name: 'SYN-5' }).getAttribute('href')).toBe('/employees/e-5');
    expect(document.body.textContent).not.toContain('e-5');
    cleanup();

    await openRecord([READ, HISTORY_DUTY], { 'GET /v1/employees/e-1/history': [200, { ...HISTORY, priorEmployment: null }] });
    await screen.findByRole('table', { name: 'Shifts' });
    expect(factOf('Last working date')).toBe('—');
    expect(factOf('Follows the employment')).toBeNull();
    expect(factOf('Followed by the employment')).toBeNull();
  });

  it('no shift yet says so; a refusal reads in plain words and the link stays', async () => {
    await openRecord([READ, HISTORY_DUTY], { 'GET /v1/employees/e-1/history': [200, { ...HISTORY, shifts: [] }] });
    await screen.findByRole('heading', { name: 'Shifts' });
    expect(screen.getByText('Nothing recorded yet.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Shifts' })).toBeNull();
    cleanup();
    await openRecord([READ, HISTORY_DUTY], { 'GET /v1/employees/e-1/history': [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    expect(await screen.findByText('Your role is not permitted to read this.')).toBeTruthy();
    expect(screen.getByRole('link', { name: LINK })).toBeTruthy();
  });
});

describe('editing (FR-006, FR-008)', () => {
  const PATCHED = 'PATCH /v1/employees/e-1';

  it('sends the version and only what changed; a blank email clears it', async () => {
    const calls = await openRecord([READ, UPDATE], { [PATCHED]: [200, RECORD] });
    const form = openForm('Edit details');
    type(within(form).getByLabelText('Name'), ' New Name ');
    type(within(form).getByLabelText('Work email'), ' ');
    click(within(form).getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText('Details saved.')).toBeTruthy();
    expect(writes(calls)).toEqual([{ method: 'PATCH', url: '/v1/employees/e-1', body: { expectedVersion: 7, displayName: 'New Name', workEmail: null } }]);
    expect(screen.queryByRole('form', { name: 'Edit details' })).toBeNull();
    await waitFor(() => expect(asked(calls, '/v1/employees/e-1').length).toBeGreaterThan(1));
  });

  it('personal fields are offered with the duty and the server’s answer; other fields then need no operational duty', async () => {
    const withPersonal = { ...RECORD, dateOfBirth: '1990-05-04', serviceAnniversaryDate: null };
    const calls = await openRecord([READ, 'employee.update.personal'], { [PATCHED]: [200, withPersonal] }, withPersonal);
    const form = openForm('Edit details');
    expect(within(form).queryByLabelText('Name')).toBeNull();
    expect(within(form).queryByLabelText('Work email')).toBeNull();
    type(within(form).getByLabelText('Date of birth'), '');
    type(within(form).getByLabelText('Service anniversary base date'), '2026-02-01');
    click(within(form).getByRole('button', { name: 'Save details' }));
    await screen.findByText('Details saved.');
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 7, dateOfBirth: null, serviceAnniversaryDate: '2026-02-01' });
    cleanup();

    await openRecord([READ, UPDATE], {}, withPersonal);
    expect(within(openForm('Edit details')).queryByLabelText('Date of birth')).toBeNull();
  });

  it('saving nothing asks nothing of the server', async () => {
    const calls = await openRecord([READ, UPDATE], {});
    const form = openForm('Edit details');
    click(within(form).getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText('Nothing changed.')).toBeTruthy();
    expect(writes(calls)).toEqual([]);
  });

  it('a stale version reloads the record and keeps what was typed; the next save goes against the version now shown', async () => {
    let current = RECORD;
    const calls = await openRecord([READ, UPDATE], {
      [ITEM]: () => [200, current],
      [PATCHED]: (c) => {
        if (c.body!.expectedVersion !== 7) return [200, current];
        current = { ...RECORD, workEmail: 'changed@synthetic.test', version: 9 };
        return [409, { error: 'STALE_VERSION', message: 'The record changed; reload and retry' }];
      },
    });
    const form = openForm('Edit details');
    type(within(form).getByLabelText('Name'), 'Typed Here');
    click(within(form).getByRole('button', { name: 'Save details' }));
    expect(await refusal(form)).toContain('What you typed is still here');
    await waitFor(() => expect(factOf('Work email')).toBe('changed@synthetic.test'));
    expect(valueOf(within(form).getByLabelText('Name'))).toBe('Typed Here');
    click(within(form).getByRole('button', { name: 'Save details' }));
    await screen.findByText('Details saved.');
    expect(writes(calls).at(-1)!.body).toMatchObject({ expectedVersion: 9, displayName: 'Typed Here' });
  });

  // DF16 work phone extension (I-89 item 5): shown with the work email, changed under the same duty, a blank one clears it.
  it('shows the work phone extension the server sent and sends only a changed one, a blank one as null', async () => {
    const withExtension = { ...RECORD, workPhoneExtension: '4321' };
    const calls = await openRecord([READ, UPDATE], { [PATCHED]: [200, withExtension] }, withExtension);
    expect(factOf('Work phone extension')).toBe('4321');
    let form = openForm('Edit details');
    expect(valueOf(within(form).getByLabelText('Work phone extension'))).toBe('4321');
    type(within(form).getByLabelText('Work phone extension'), ' 87654321 ');
    click(within(form).getByRole('button', { name: 'Save details' }));
    await screen.findByText('Details saved.');
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 7, workPhoneExtension: '87654321' });
    form = openForm('Edit details');
    type(within(form).getByLabelText('Work phone extension'), ' ');
    click(within(form).getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.body).toEqual({ expectedVersion: 7, workPhoneExtension: null });
    cleanup();

    // An answer without the field (another server) offers nothing to change, so nothing is sent unseen.
    await openRecord([READ, UPDATE], {});
    expect(factOf('Work phone extension')).toBeNull();
    expect(within(openForm('Edit details')).queryByLabelText('Work phone extension')).toBeNull();
  });

  it.each([
    [409, { error: 'DUPLICATE', message: 'A record with the same unique value already exists' }, 'Another employee already has this employee code or work email.'],
    [400, { error: 'INVALID_REQUEST', message: 'body/workEmail must match format "email"' }, 'The server did not accept the work email. Check and try again.'],
    [422, { error: 'INVALID_WORK_PHONE_EXTENSION', message: 'A work phone extension is 1 to 8 digits' }, 'A work phone extension is 1 to 8 digits, with nothing else. Check it and try again.'],
  ])('a refusal reads in plain words and keeps what was typed (%i)', async (status, body, words) => {
    await openRecord([READ, UPDATE], { [PATCHED]: [status, body] });
    const form = openForm('Edit details');
    type(within(form).getByLabelText('Work email'), 'taken@synthetic.test');
    click(within(form).getByRole('button', { name: 'Save details' }));
    expect(await refusal(form)).toBe(words);
    expect(valueOf(within(form).getByLabelText('Work email'))).toBe('taken@synthetic.test');
  });
});

describe('activation (DF04)', () => {
  const POST = 'POST /v1/employees/e-1/activate';
  const panel = () => screen.getByRole('form', { name: 'Activate' });

  it('is offered for a draft with the duty, and for nothing else', async () => {
    await openRecord([READ], {}, DRAFT);
    expect(screen.queryByRole('form', { name: 'Activate' })).toBeNull();
    cleanup();
    await openRecord([READ, ACTIVATE], {}, RECORD);
    expect(screen.queryByRole('form', { name: 'Activate' })).toBeNull();
    cleanup();
    await openRecord([READ, ACTIVATE], {}, DRAFT);
    expect(panel()).toBeTruthy();
  });

  it('names every missing requirement with the check date, and keeps the typed reason', async () => {
    await openRecord([READ, ACTIVATE], {
      [POST]: [422, { error: 'ACTIVATION_REQUIREMENTS_MISSING', message: 'The employee cannot be activated yet', details: { missing: ['WORK_EMAIL', 'JOB_ASSIGNMENT', 'SHIFT_ASSIGNMENT', 'MANAGER_OR_NO_MANAGER_REASON', 'SOME_NEW_REQUIREMENT'], checkDate: '2026-02-01' } }],
    }, DRAFT);
    type(within(panel()).getByLabelText(/Reason for having no manager/), 'Top of the company');
    click(within(panel()).getByRole('button', { name: 'Activate' }));
    const alert = await within(panel()).findByRole('alert');
    expect(alert.textContent).toContain('The check date is 2026-02-01');
    expect(within(alert).getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      'A work email. Add one under Edit details.',
      'A job assignment in force on that date. Add one under Transfer.',
      'An active shift in force on that date. Add one under Change shift.',
      'A manager in force on that date, or a reason for having none. Use Change manager, or type the reason here.',
      'some new requirement',
    ]);
    expect(alert.textContent).not.toContain('WORK_EMAIL');
    expect(valueOf(within(panel()).getByLabelText(/Reason for having no manager/))).toBe('Top of the company');
  });

  it('sends the version, and the reason only when typed; on success the record is read again and the offer goes', async () => {
    let current = DRAFT;
    const calls = await openRecord([READ, ACTIVATE], {
      [ITEM]: () => [200, current],
      [POST]: () => {
        current = { ...RECORD, version: 8 };
        return [200, current];
      },
    }, DRAFT);
    click(within(panel()).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/^Activated\./)).toBeTruthy();
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 7 });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Activate' })).toBeNull());
    expect(factOf('Status')).toBe('on probation');
  });

  it('a typed reason is sent trimmed', async () => {
    const calls = await openRecord([READ, ACTIVATE], { [POST]: [200, RECORD] }, DRAFT);
    type(within(panel()).getByLabelText(/Reason for having no manager/), ' Top of the company ');
    click(within(panel()).getByRole('button', { name: 'Activate' }));
    await screen.findByText(/^Activated\./);
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 7, noManagerReason: 'Top of the company' });
  });

  it('activated elsewhere in the meantime: says so and reloads', async () => {
    const calls = await openRecord([READ, ACTIVATE], { [POST]: [409, { error: 'INVALID_STATE', message: 'Only draft employees can be activated' }] }, DRAFT);
    click(within(panel()).getByRole('button', { name: 'Activate' }));
    expect(await refusal(panel())).toContain('no longer a draft');
    await waitFor(() => expect(asked(calls, '/v1/employees/e-1').length).toBeGreaterThan(1));
  });
});

describe('manager change (FR-003, effective-dated)', () => {
  const POST = 'POST /v1/employees/e-1/manager';
  const SEARCH = 'GET /v1/employees?';
  const HITS = { items: [{ id: 'e-3', employeeCode: 'SYN-3', displayName: 'Synthetic Manager', status: 'ACTIVE_CONFIRMED' }] };

  const chooseManager = async (form: HTMLElement) => {
    type(within(form).getByLabelText(/Find by name/), 'manager');
    click(await within(form).findByRole('button', { name: 'Synthetic Manager (SYN-3)' }));
  };

  it('offers active employees found by search, sends the choice with its date and the reason typed, and says when it applies', async () => {
    const calls = await openRecord([READ, LIST, UPDATE], { [SEARCH]: [200, HITS], [POST]: [200, RECORD] });
    const form = openForm('Change manager');
    expect((within(form).getByRole('button', { name: 'Save manager change' }) as HTMLButtonElement).disabled).toBe(true);
    await chooseManager(form);
    const search = new URL(asked(calls, '/v1/employees?')[0]!.url, 'http://test').searchParams;
    expect(search.get('statusGroup')).toBe('ACTIVE');
    expect(search.get('search')).toBe('manager');
    expect(within(form).getByText('Synthetic Manager (SYN-3)', { selector: 'strong' })).toBeTruthy();
    type(within(form).getByLabelText('Effective from'), '2026-03-01');
    type(within(form).getByLabelText('Reason'), ' Reorganisation ');
    click(within(form).getByRole('button', { name: 'Save manager change' }));
    expect(await screen.findByText(/Manager change saved, effective 2026-03-01/)).toBeTruthy();
    expect(writes(calls)).toEqual([{ method: 'POST', url: '/v1/employees/e-1/manager', body: { managerEmployeeId: 'e-3', effectiveFrom: '2026-03-01', reason: 'Reorganisation' } }]);
  });

  it('removing the manager sends null, even without a reason: the server asks for one, in plain words, and the date stays', async () => {
    const calls = await openRecord([READ, LIST, UPDATE], { [POST]: [422, { error: 'REASON_REQUIRED', message: 'Removing a manager requires a recorded reason' }] });
    const form = openForm('Change manager');
    click(within(form).getByLabelText(/No manager from this date/));
    expect(within(form).queryByLabelText(/Find by name/)).toBeNull();
    type(within(form).getByLabelText('Effective from'), '2026-03-01');
    click(within(form).getByRole('button', { name: 'Save manager change' }));
    expect(await refusal(form)).toBe('Removing a manager needs a reason. Type one and try again.');
    expect(writes(calls)[0]!.body).toEqual({ managerEmployeeId: null, effectiveFrom: '2026-03-01' });
    expect(valueOf(within(form).getByLabelText('Effective from'))).toBe('2026-03-01');
  });

  it.each([
    [409, { error: 'CHANGE_NOT_LATEST', message: 'A change on or after this date already exists; use a history correction instead' }, 'A change on or after this date is already recorded. A new change must start after the latest one, so use a later date.'],
    [422, { error: 'RULE_VIOLATION', message: 'The change violates a business rule' }, 'This would break a rule: the new manager may already report to this employee, directly or through others.'],
    [422, { error: 'RULE_VIOLATION', message: 'The manager must be an active employee' }, 'The manager must be an active employee.'],
    [403, { error: 'SELF_ACTION_NOT_ALLOWED', message: 'You cannot make this change on your own record; another administrator must do it' }, 'This change involves your own record, so another administrator must make it.'],
    [422, { error: 'INVALID_REFERENCE', message: 'Manager not found' }, 'That choice cannot be used. Manager not found.'],
  ])('a refusal reads in plain words, and the choice and date stay (%i)', async (status, body, words) => {
    await openRecord([READ, LIST, UPDATE], { [SEARCH]: [200, HITS], [POST]: [status, body] });
    const form = openForm('Change manager');
    await chooseManager(form);
    type(within(form).getByLabelText('Effective from'), '2026-03-01');
    click(within(form).getByRole('button', { name: 'Save manager change' }));
    expect(await refusal(form)).toBe(words);
    expect(within(form).getByText('Synthetic Manager (SYN-3)', { selector: 'strong' })).toBeTruthy();
    expect(valueOf(within(form).getByLabelText('Effective from'))).toBe('2026-03-01');
  });

  it('a role that cannot search says so and can still remove', async () => {
    await openRecord([READ, UPDATE], {});
    const form = openForm('Change manager');
    expect(within(form).getByText(/cannot search employees/)).toBeTruthy();
    expect(within(form).getByLabelText(/No manager from this date/)).toBeTruthy();
  });
});

describe('transfer (FR-006, effective-dated)', () => {
  const POST = 'POST /v1/employees/e-1/assignment';
  const option = (select: HTMLElement) => (select as HTMLSelectElement).selectedOptions[0]!.textContent;

  it('starts from the current assignment and asks for what is valid on the date typed; sends the change with its date', async () => {
    const calls = await openRecord([READ, UPDATE], { ...MASTERS, [POST]: [200, RECORD] });
    const form = openForm('Transfer');
    await within(form).findByRole('option', { name: 'OPS Operations' });
    expect(valueOf(within(form).getByLabelText('Department'))).toBe('d-1');
    expect(valueOf(within(form).getByLabelText('Grade'))).toBe('gr-1');
    expect(asked(calls, '/v1/org/departments')[0]!.url).toBe('/v1/org/departments');
    type(within(form).getByLabelText('Effective from'), '2026-06-01');
    await waitFor(() => expect(asked(calls, '/v1/org/departments').at(-1)!.url).toBe('/v1/org/departments?validOn=2026-06-01'));
    await within(form).findByRole('option', { name: 'OPS Operations' });
    type(within(form).getByLabelText('Department'), 'd-2');
    type(within(form).getByLabelText('Reason'), ' Team move ');
    click(within(form).getByRole('button', { name: 'Save transfer' }));
    expect(await screen.findByText(/Transfer saved, effective 2026-06-01/)).toBeTruthy();
    expect(writes(calls)[0]!.body).toEqual({ departmentId: 'd-2', locationId: 'l-1', designationId: 'g-1', gradeId: 'gr-1', effectiveFrom: '2026-06-01', reason: 'Team move' });
  });

  it('with no grade chosen and no reason typed, sends neither', async () => {
    const calls = await openRecord([READ, UPDATE], { ...MASTERS, [POST]: [200, RECORD] });
    const form = openForm('Transfer');
    await within(form).findByRole('option', { name: 'G1 Grade one' });
    type(within(form).getByLabelText('Grade'), '');
    type(within(form).getByLabelText('Effective from'), '2026-06-01');
    click(within(form).getByRole('button', { name: 'Save transfer' }));
    await screen.findByText(/Transfer saved/);
    expect(writes(calls)[0]!.body).toEqual({ departmentId: 'd-1', locationId: 'l-1', designationId: 'g-1', effectiveFrom: '2026-06-01' });
  });

  it('a choice a new date no longer offers stays chosen and marked; the server’s refusal gives the period and everything typed stays', async () => {
    const calls = await openRecord([READ, UPDATE], {
      ...MASTERS,
      'GET /v1/org/departments?validOn=2027-01-01': [200, { items: [{ id: 'd-2', code: 'OPS', name: 'Operations' }] }],
      [POST]: [422, { error: 'DEPARTMENT_OUTSIDE_VALID_PERIOD', message: 'This department is not valid on 2027-01-01', details: { validFrom: '2026-01-01', validTo: '2026-12-01', date: '2027-01-01' } }],
    });
    const form = openForm('Transfer');
    await within(form).findByRole('option', { name: 'ENG Engineering' });
    type(within(form).getByLabelText('Effective from'), '2027-01-01');
    await within(form).findByRole('option', { name: 'ENG Engineering (not offered on this date)' });
    const department = within(form).getByLabelText('Department');
    expect(valueOf(department)).toBe('d-1');
    expect(option(department)).toBe('ENG Engineering (not offered on this date)');
    click(within(form).getByRole('button', { name: 'Save transfer' }));
    expect(await refusal(form)).toBe('This department is not valid on 2027-01-01. It applies from 2026-01-01 until 2026-12-01, not included. Choose another department or another date.');
    // Sent anyway: the page does not decide validity.
    expect(writes(calls)[0]!.body).toMatchObject({ departmentId: 'd-1', effectiveFrom: '2027-01-01' });
    expect(valueOf(within(form).getByLabelText('Department'))).toBe('d-1');
    expect(valueOf(within(form).getByLabelText('Effective from'))).toBe('2027-01-01');
  });

  it('says when nothing is valid on the date, and when the role cannot read a master list', async () => {
    await openRecord([READ, UPDATE], {
      ...MASTERS,
      'GET /v1/org/departments': [200, { items: [] }],
      'GET /v1/org/locations': [403, { error: 'FORBIDDEN', message: 'Not permitted' }],
    });
    const form = openForm('Transfer');
    expect(await within(form).findByText('None is valid on this date.')).toBeTruthy();
    expect(await within(form).findByText('Your role cannot read this list, so it cannot be chosen here.')).toBeTruthy();
  });
});

describe('shift change (FR-023, effective-dated)', () => {
  const POST = 'POST /v1/employees/e-1/shift';
  const SHIFTS = {
    items: [
      { id: 's-1', code: 'DAY', name: 'Day shift', inTime: '09:00', outTime: '18:00', active: true },
      { id: 's-2', code: 'OLD', name: 'Retired shift', inTime: '10:00', outTime: '19:00', active: false },
    ],
  };
  const DUTIES = [READ, 'shift.assign.operational', 'shift.read.operational'];

  it('needs its own duty, not the employee update duty', async () => {
    await openRecord([READ, UPDATE], {});
    expect(screen.queryByRole('button', { name: 'Change shift' })).toBeNull();
    cleanup();
    await openRecord(DUTIES, { 'GET /v1/shifts': [200, SHIFTS] });
    expect(button('Change shift')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change manager' })).toBeNull();
  });

  it('offers active shifts only and sends the choice with its date', async () => {
    const calls = await openRecord(DUTIES, { 'GET /v1/shifts': [200, SHIFTS], [POST]: [200, RECORD] });
    const form = openForm('Change shift');
    await within(form).findByRole('option', { name: 'DAY Day shift (09:00-18:00)' });
    expect(within(form).queryByRole('option', { name: /Retired/ })).toBeNull();
    type(within(form).getByLabelText('Shift'), 's-1');
    type(within(form).getByLabelText('Effective from'), '2026-07-01');
    click(within(form).getByRole('button', { name: 'Save shift change' }));
    expect(await screen.findByText(/Shift change saved, effective 2026-07-01/)).toBeTruthy();
    expect(writes(calls)).toEqual([{ method: 'POST', url: '/v1/employees/e-1/shift', body: { shiftId: 's-1', effectiveFrom: '2026-07-01' } }]);
  });

  it.each([
    [422, { error: 'EMPLOYMENT_ENDED', message: 'The employment has ended, so no shift can be assigned' }, 'The employment has ended, so no shift can be assigned.'],
    [422, { error: 'AFTER_LAST_WORKING_DATE', message: 'A shift cannot start after the approved last working date', details: { lastWorkingDate: '2026-06-30' } }, 'A shift cannot start after the approved last working date, 2026-06-30.'],
    [422, { error: 'RULE_VIOLATION', message: 'Change cannot take effect before the joining date' }, 'Change cannot take effect before the joining date.'],
  ])('a refusal reads in plain words and keeps what was typed (%i)', async (status, body, words) => {
    await openRecord(DUTIES, { 'GET /v1/shifts': [200, SHIFTS], [POST]: [status, body] });
    const form = openForm('Change shift');
    await within(form).findByRole('option', { name: 'DAY Day shift (09:00-18:00)' });
    type(within(form).getByLabelText('Shift'), 's-1');
    type(within(form).getByLabelText('Effective from'), '2026-07-01');
    click(within(form).getByRole('button', { name: 'Save shift change' }));
    expect(await refusal(form)).toBe(words);
    expect(valueOf(within(form).getByLabelText('Shift'))).toBe('s-1');
    expect(valueOf(within(form).getByLabelText('Effective from'))).toBe('2026-07-01');
  });

  it('a role that cannot read the shift master says so and reads nothing', async () => {
    const calls = await openRecord([READ, 'shift.assign.operational'], {});
    click(button('Change shift'));
    expect(screen.getByText(/cannot read the shift master/)).toBeTruthy();
    expect(asked(calls, '/v1/shifts')).toEqual([]);
  });
});

describe('a draft’s joining date and closure (BR-002, DF08)', () => {
  it('are offered for a draft only, each with its own duty', async () => {
    await openRecord([READ, UPDATE, 'employee.deactivate.operational'], {}, RECORD);
    expect(screen.queryByRole('button', { name: 'Correct joining date' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close draft' })).toBeNull();
    cleanup();
    await openRecord([READ, UPDATE], {}, DRAFT);
    expect(button('Correct joining date')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close draft' })).toBeNull();
    cleanup();
    await openRecord([READ, 'employee.deactivate.operational'], {}, DRAFT);
    expect(button('Close draft')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Correct joining date' })).toBeNull();
  });

  it('a joining date correction sends the version, the date and the reason', async () => {
    const calls = await openRecord([READ, UPDATE], { 'POST /v1/employees/e-1/joining-date': [200, DRAFT] }, DRAFT);
    const form = openForm('Correct joining date');
    expect(valueOf(within(form).getByLabelText('Joining date'))).toBe('2026-02-01');
    expect((within(form).getByLabelText('Reason') as HTMLInputElement).required).toBe(true);
    type(within(form).getByLabelText('Joining date'), '2026-03-01');
    type(within(form).getByLabelText('Reason'), ' Offer moved ');
    click(within(form).getByRole('button', { name: 'Save joining date' }));
    expect(await screen.findByText(/Joining date corrected to 2026-03-01/)).toBeTruthy();
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 7, joiningDate: '2026-03-01', reason: 'Offer moved' });
  });

  it.each([
    [{ conflict: 'SHIFT', effectiveFrom: '2026-02-15' }, 'A shift period starts on 2026-02-15, so the joining date cannot be after it.'],
    [{ conflict: 'MANAGER', effectiveFrom: '2026-02-15' }, 'A manager period starts on 2026-02-15, so the joining date cannot be after it.'],
    [{ conflict: 'ASSIGNMENT', effectiveFrom: '2026-02-15' }, 'A later job assignment starts on 2026-02-15, so the joining date must be before it.'],
    [{ conflict: 'BIRTH_DATE' }, 'The joining date must be after the date of birth.'],
  ])('a date conflict names what it conflicts with and keeps what was typed %#', async (details, words) => {
    await openRecord([READ, UPDATE], { 'POST /v1/employees/e-1/joining-date': [422, { error: 'CHRONOLOGY_CONFLICT', message: 'x', details }] }, DRAFT);
    const form = openForm('Correct joining date');
    type(within(form).getByLabelText('Joining date'), '2026-03-01');
    type(within(form).getByLabelText('Reason'), 'Offer moved');
    click(within(form).getByRole('button', { name: 'Save joining date' }));
    expect(await refusal(form)).toBe(words);
    expect(valueOf(within(form).getByLabelText('Reason'))).toBe('Offer moved');
  });

  it('closing a draft sends the version and the reason; an account still linked reads in plain words', async () => {
    const calls = await openRecord([READ, 'employee.deactivate.operational'], { 'POST /v1/employees/e-1/close-draft': [200, { ...DRAFT, status: 'ARCHIVED' }] }, DRAFT);
    let form = openForm('Close draft');
    expect((within(form).getByLabelText('Reason') as HTMLInputElement).required).toBe(true);
    type(within(form).getByLabelText('Reason'), ' Never joined ');
    click(within(form).getByRole('button', { name: 'Confirm closing the draft' }));
    expect(await screen.findByText(/Draft closed/)).toBeTruthy();
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 7, reason: 'Never joined' });
    cleanup();

    await openRecord([READ, 'employee.deactivate.operational'], { 'POST /v1/employees/e-1/close-draft': [409, { error: 'USER_LINK_OPEN', message: 'End the user link of this employee first' }] }, DRAFT);
    form = openForm('Close draft');
    type(within(form).getByLabelText('Reason'), 'Never joined');
    click(within(form).getByRole('button', { name: 'Confirm closing the draft' }));
    expect(await refusal(form)).toContain('End that link under User accounts first');
    expect(valueOf(within(form).getByLabelText('Reason'))).toBe('Never joined');
  });
});

describe('a new employee (FR-006)', () => {
  const POST = 'POST /v1/employees';
  const openNew = async (permissions: string[], routes: Routes_ = {}) => {
    session.permissions = [CREATE, ...permissions];
    const calls = mockApi({ ...MASTERS, ...routes });
    openAt('/employees/new');
    const form = screen.getByRole('form', { name: 'New employee' });
    await within(form).findByRole('option', { name: 'OPS Operations' });
    return { calls, form };
  };
  const fill = async (form: HTMLElement) => {
    type(within(form).getByLabelText('Employee code'), ' syn-9 ');
    type(within(form).getByLabelText('Name'), ' Synthetic Joiner ');
    type(within(form).getByLabelText('Joining date'), '2026-04-01');
    type(within(form).getByLabelText('Employment type'), 'INTERN');
    await within(form).findAllByRole('option', { name: 'OPS Operations' });
    type(within(form).getByLabelText('Department'), 'd-2');
    await within(form).findByRole('option', { name: 'HQ Head office' });
    type(within(form).getByLabelText('Location'), 'l-1');
    await within(form).findByRole('option', { name: 'DEV Developer' });
    type(within(form).getByLabelText('Designation'), 'g-1');
  };

  it('offers exactly the employment types the route accepts', async () => {
    const { form } = await openNew([]);
    const types = [...(within(form).getByLabelText('Employment type') as HTMLSelectElement).options].map((o) => o.value);
    expect(types).toEqual(['', 'PERMANENT', 'FIXED_TERM', 'INTERN', 'CONTRACTOR']);
  });

  it('sends what was typed, trimmed, without blank optional fields, then opens the new record', async () => {
    const { calls, form } = await openNew([], { [POST]: [201, { ...DRAFT, id: 'e-9', employeeCode: 'SYN-9', displayName: 'Synthetic Joiner' }], 'GET /v1/employees/e-9': [200, { ...DRAFT, id: 'e-9', employeeCode: 'SYN-9', displayName: 'Synthetic Joiner' }] });
    await fill(form);
    click(within(form).getByRole('button', { name: 'Create employee' }));
    expect(await screen.findByRole('heading', { name: 'Synthetic Joiner (SYN-9)' })).toBeTruthy();
    expect(writes(calls)).toEqual([
      { method: 'POST', url: '/v1/employees', body: { employeeCode: 'syn-9', displayName: 'Synthetic Joiner', joiningDate: '2026-04-01', employmentType: 'INTERN', departmentId: 'd-2', locationId: 'l-1', designationId: 'g-1' } },
    ]);
  });

  it('asks for the masters valid on the joining date once it is typed', async () => {
    const { calls, form } = await openNew([]);
    expect(asked(calls, '/v1/org/designations')[0]!.url).toBe('/v1/org/designations');
    type(within(form).getByLabelText('Joining date'), '2026-04-01');
    await waitFor(() => expect(asked(calls, '/v1/org/').filter((c) => c.url.endsWith('?validOn=2026-04-01')).map((c) => c.url).sort()).toEqual(['/v1/org/departments?validOn=2026-04-01', '/v1/org/designations?validOn=2026-04-01', '/v1/org/grades?validOn=2026-04-01', '/v1/org/locations?validOn=2026-04-01']));
  });

  it('offers and sends personal fields only with their own duty, the work email and grade when given', async () => {
    const { form } = await openNew([]);
    expect(within(form).queryByLabelText('Date of birth')).toBeNull();
    expect(within(form).queryByLabelText('Service anniversary base date')).toBeNull();
    cleanup();

    const opened = await openNew(['employee.create.personal'], { [POST]: [201, { ...DRAFT, id: 'e-9' }], 'GET /v1/employees/e-9': [200, { ...DRAFT, id: 'e-9' }] });
    await fill(opened.form);
    type(within(opened.form).getByLabelText('Date of birth'), '1995-01-02');
    type(within(opened.form).getByLabelText('Service anniversary base date'), '2026-04-01');
    type(within(opened.form).getByLabelText('Work email'), ' joiner@synthetic.test ');
    type(within(opened.form).getByLabelText('Work phone extension'), ' 2468 ');
    await within(opened.form).findByRole('option', { name: 'G1 Grade one' });
    type(within(opened.form).getByLabelText('Grade'), 'gr-1');
    click(within(opened.form).getByRole('button', { name: 'Create employee' }));
    await waitFor(() => expect(writes(opened.calls)).toHaveLength(1));
    expect(writes(opened.calls)[0]!.body).toMatchObject({ dateOfBirth: '1995-01-02', serviceAnniversaryDate: '2026-04-01', workEmail: 'joiner@synthetic.test', workPhoneExtension: '2468', gradeId: 'gr-1' });
  });

  it('a rehire names the ended employment, found among separated employees', async () => {
    const { calls, form } = await openNew([LIST], {
      'GET /v1/employees?': [200, { items: [{ id: 'e-0', employeeCode: 'SYN-0', displayName: 'Synthetic Leaver', status: 'INACTIVE_SEPARATED' }] }],
      [POST]: [422, { error: 'CHRONOLOGY_CONFLICT', message: 'x', details: { conflict: 'PRIOR_EMPLOYMENT', lastWorkingDate: '2026-04-30' } }],
    });
    await fill(form);
    type(within(form).getByLabelText(/Find by name/), 'leaver');
    click(await within(form).findByRole('button', { name: 'Synthetic Leaver (SYN-0)' }));
    expect(new URL(asked(calls, '/v1/employees?')[0]!.url, 'http://test').searchParams.get('status')).toBe('INACTIVE_SEPARATED');
    click(within(form).getByRole('button', { name: 'Create employee' }));
    expect(await refusal(form)).toBe('The new employment must start after the last working date of the prior one, 2026-04-30.');
    expect(writes(calls)[0]!.body).toMatchObject({ priorEmployeeId: 'e-0' });
    expect(within(form).getByText('Synthetic Leaver (SYN-0)', { selector: 'strong' })).toBeTruthy();
  });

  it.each([
    [409, { error: 'DUPLICATE', message: 'A record with the same unique value already exists' }, 'Another employee already has this employee code or work email.'],
    [400, { error: 'INVALID_REQUEST', message: 'body/employeeCode must match pattern "^x$"' }, 'The server did not accept the employee code: it starts with a letter or digit and uses only letters, digits, hyphens and underscores, up to 40 characters. Check and try again.'],
    [422, { error: 'LOCATION_OUTSIDE_VALID_PERIOD', message: 'x', details: { validFrom: '2026-05-01', validTo: null, date: '2026-04-01' } }, 'This location is not valid on 2026-04-01. It applies from 2026-05-01. Choose another location or another date.'],
    [422, { error: 'GRADE_OUTSIDE_VALID_PERIOD', message: 'x', details: { validFrom: null, validTo: '2026-03-01', date: '2026-04-01' } }, 'This grade is not valid on 2026-04-01. It applies until 2026-03-01, not included. Choose another grade or another date.'],
    [422, { error: 'INVALID_REFERENCE', message: 'department is not an active master in this company' }, 'That choice cannot be used. Department is not an active master in this company.'],
    [422, { error: 'PRIOR_EMPLOYMENT_NOT_ENDED', message: 'x' }, 'The prior employment has not ended, so this one cannot follow it.'],
    [403, { error: 'FORBIDDEN', message: 'Not permitted' }, 'Your role is not permitted to do this for this employee.'],
  ])('a refusal reads in plain words and everything typed stays (%i)', async (status, body, words) => {
    const { form } = await openNew([], { [POST]: [status, body] });
    await fill(form);
    click(within(form).getByRole('button', { name: 'Create employee' }));
    expect(await refusal(form)).toBe(words);
    expect(valueOf(within(form).getByLabelText('Employee code'))).toBe(' syn-9 ');
    expect(valueOf(within(form).getByLabelText('Name'))).toBe(' Synthetic Joiner ');
    expect(valueOf(within(form).getByLabelText('Department'))).toBe('d-2');
    expect(valueOf(within(form).getByLabelText('Employment type'))).toBe('INTERN');
  });

  it('a refusal with no plain words shows the server’s own', async () => {
    const { form } = await openNew([], { [POST]: [422, { error: 'SOME_NEW_RULE', message: 'Readable server text' }] });
    await fill(form);
    click(within(form).getByRole('button', { name: 'Create employee' }));
    expect(await refusal(form)).toContain('Readable server text');
  });
});
