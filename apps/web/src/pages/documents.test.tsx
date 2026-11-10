// Company policy documents and bulk document mapping screens (FR-010; DF02; DF09; FR-106; I-13; I-38), jsdom with a
// mocked fetch: the read view lists exactly what the API returned (released version, expiry, confidential only when
// listed) and opens only released versions; the version history keeps every version; publishing sends exactly the
// API's bodies with the policy version, refusals are shown in plain words and a stale view reloads; a confidential
// classification is offered only with its grant; staging reports each file's scan outcome and a staged file is
// discarded only on a second click (listed under Discarded, never as deleted); the DOCUMENT_MAPPING_V1 batch previews
// row problems in plain words (an unknown employee code assigns nothing), commits only on request, holds a file the
// scanner has not judged yet (cancel, or check again from the stored file) and refuses a flagged file; the user's own
// batches are listed a page at a time and a held one can be opened again.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENTS_ESS_PANELS, DOCUMENTS_SCREENS, DOCUMENTS_TASK_QUEUES } from './documents';

const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
}));
// The automatic re-check of a waiting batch has its own tests (held-batch.test.tsx): here the manual check is on its own.
vi.mock('../held-batch-timing', () => ({ HELD_BATCH_CHECK_INTERVAL_MS: 3_600_000, HELD_BATCH_MAX_CHECKS: 30 }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: {
      userId: 'b0000000-0000-4000-8000-000000000001',
      accountKey: 'syn.hr',
      companyName: 'Synthetic Co',
      roleCode: 'HR_ADMINISTRATOR',
      roleName: 'HR Administrator',
      scopeKind: 'COMPANY',
      employeeId: null,
      displayName: 'Synthetic HR',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const READ = 'company_policy.read.operational';
const MANAGE = 'company_policy.manage.operational';
const MANAGE_CONFIDENTIAL = 'company_policy.manage.confidential';
const UPLOAD = 'document.upload.document';
const IMPORT = 'employee.import.operational';

const P_LEAVE = '30000000-0000-4000-8000-000000000001';
const P_TRAVEL = '30000000-0000-4000-8000-000000000002';
const P_REMOTE = '30000000-0000-4000-8000-000000000003';
const P_RESTRICTED = '30000000-0000-4000-8000-000000000004';
const V_LEAVE_1 = '40000000-0000-4000-8000-000000000001';
const V_TRAVEL_1 = '40000000-0000-4000-8000-000000000002';
const V_TRAVEL_2 = '40000000-0000-4000-8000-000000000003';
const V_TRAVEL_3 = '40000000-0000-4000-8000-000000000004';
const V_RESTRICTED_1 = '40000000-0000-4000-8000-000000000005';
const AT = '2026-10-01T05:00:00.000Z';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const current = (id: string, versionNumber: number, patch: Obj = {}) => ({
  id,
  versionNumber,
  fileName: `synthetic-v${versionNumber}.pdf`,
  mediaType: 'application/pdf',
  byteSize: 120,
  expiresOn: null,
  expired: false,
  publishedAt: AT,
  ...patch,
});
const LEAVE = {
  id: P_LEAVE,
  policyCode: 'LEAVE_HANDBOOK',
  title: 'Synthetic leave handbook',
  classification: 'OPERATIONAL',
  version: 1,
  latestVersionNumber: 1,
  currentVersion: current(V_LEAVE_1, 1, { expiresOn: '2027-10-31' }),
};
const TRAVEL = {
  id: P_TRAVEL,
  policyCode: 'TRAVEL',
  title: 'Synthetic travel policy',
  classification: 'OPERATIONAL',
  version: 3,
  latestVersionNumber: 3,
  currentVersion: current(V_TRAVEL_2, 2, { expiresOn: '2026-09-30', expired: true }),
};
const REMOTE = { id: P_REMOTE, policyCode: 'REMOTE_WORK', title: 'Synthetic remote work policy', classification: 'OPERATIONAL', version: 1, latestVersionNumber: 1, currentVersion: null };
const RESTRICTED = {
  id: P_RESTRICTED,
  policyCode: 'RESTRICTED_PLAN',
  title: 'Synthetic restricted plan',
  classification: 'CONFIDENTIAL',
  version: 1,
  latestVersionNumber: 1,
  currentVersion: current(V_RESTRICTED_1, 1),
};

const version = (id: string, versionNumber: number, patch: Obj = {}) => ({
  id,
  versionNumber,
  fileName: `travel-v${versionNumber}.pdf`,
  mediaType: 'application/pdf',
  byteSize: 120,
  expiresOn: null,
  expired: false,
  scanState: 'CLEAN',
  changeNote: null,
  publishedAt: AT,
  ...patch,
});
const travelDetail = (patch: Obj = {}): Obj => ({
  id: P_TRAVEL,
  policyCode: 'TRAVEL',
  title: 'Synthetic travel policy',
  classification: 'OPERATIONAL',
  version: 3,
  createdAt: AT,
  updatedAt: '2026-10-20T05:00:00.000Z',
  versions: [
    version(V_TRAVEL_3, 3, { scanState: 'QUARANTINED', changeNote: 'Synthetic third edition' }),
    version(V_TRAVEL_2, 2, { expiresOn: '2026-09-30', expired: true, changeNote: 'Synthetic revision' }),
    version(V_TRAVEL_1, 1),
  ],
  ...patch,
});
const restrictedDetail = (): Obj => ({
  id: P_RESTRICTED,
  policyCode: 'RESTRICTED_PLAN',
  title: 'Synthetic restricted plan',
  classification: 'CONFIDENTIAL',
  version: 1,
  createdAt: AT,
  updatedAt: AT,
  versions: [version(V_RESTRICTED_1, 1)],
});

interface Call {
  method: string;
  path: string;
  search: string;
  body: Obj | undefined;
}
type Reply = [status: number, body: unknown];
type Handler = Reply | ((call: Call) => Reply | Promise<Reply>);

let calls: Call[] = [];
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

/** Routes are "METHOD /path" or "METHOD /path?query"; a string body is served as a PDF download. */
function serve(routes: Record<string, Handler>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, search: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}${call.search}`] ?? routes[`${call.method} ${call.path}`];
      const [status, body]: Reply =
        route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${call.method} ${call.path}` }] : typeof route === 'function' ? await route(call) : route;
      if (typeof body === 'string') {
        return new Response(body, { status, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="synthetic-policy.pdf"' } });
      }
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

/** jsdom has no object URLs: a downloaded file is "saved" through a click on a link to one, counted here. */
function stubDownloads() {
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-policy');
  URL.revokeObjectURL = vi.fn();
  const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return {
    saved,
    restore: () => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
      saved.mockRestore();
    },
  };
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
function renderAt(entry: string, permissions: string[]) {
  session.permissions = permissions;
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {DOCUMENTS_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const PDF_TEXT = '%PDF-1.4 synthetic';
const pdf = (name: string) => new File([PDF_TEXT], name, { type: 'application/pdf' });
const csvFile = (text: string, name = 'mapping.csv') => new File([text], name, { type: 'text/csv' });
const rowOf = (scope: HTMLElement, text: string) => within(scope).getByText(text).closest('tr') as HTMLElement;
const valueOf = (el: HTMLElement) => (el as HTMLInputElement).value;
const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
const options = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map((o) => o.value);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  session.permissions = [];
});

describe('company policies: the employee read view (FR-010, DF02)', () => {
  it('lists the released version and expiry of each policy and downloads it through the content route', async () => {
    const downloads = stubDownloads();
    try {
      serve({ 'GET /v1/company-policies': [200, { items: [LEAVE, TRAVEL, REMOTE] }], [`GET /v1/company-policy-versions/${V_LEAVE_1}/content`]: [200, 'synthetic pdf bytes'] });
      renderAt('/policies', [READ]);
      const table = await screen.findByRole('table', { name: 'Company policies' });
      expect(within(rowOf(table, 'Synthetic leave handbook')).getByText(/Version 1/)).toBeTruthy();
      expect(rowOf(table, 'Synthetic leave handbook').textContent).toContain('2027-10-31');
      // An expired version stays listed and says so in words.
      expect(within(rowOf(table, 'Synthetic travel policy')).getByText('expired')).toBeTruthy();
      expect(rowOf(table, 'Synthetic travel policy').textContent).toContain('Version 2');
      // No released version: nothing to open.
      const remote = rowOf(table, 'Synthetic remote work policy');
      expect(remote.textContent).toContain('No released version yet');
      expect(within(remote).queryByRole('button', { name: /Download/ })).toBeNull();
      expect(within(remote).getByRole('link', { name: 'Versions of Synthetic remote work policy' }).getAttribute('href')).toBe(`/policies/${P_REMOTE}`);
      // Nothing confidential was listed, so nothing hints at it; the manage link needs the manage duty.
      expect(screen.queryByText('confidential')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Policy upload' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Download Synthetic leave handbook' }));
      await waitFor(() => expect(downloads.saved).toHaveBeenCalledTimes(1));
      expect(callsTo('GET', `/v1/company-policy-versions/${V_LEAVE_1}/content`)).toHaveLength(1);
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      downloads.restore();
    }
  });

  it('marks a confidential policy only when the API lists it', async () => {
    serve({ 'GET /v1/company-policies': [200, { items: [LEAVE, RESTRICTED] }] });
    renderAt('/policies', [READ, MANAGE]);
    const table = await screen.findByRole('table', { name: 'Company policies' });
    expect(within(rowOf(table, 'Synthetic restricted plan')).getByText('confidential')).toBeTruthy();
    expect(within(rowOf(table, 'Synthetic leave handbook')).getByText('operational')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Policy upload' }).getAttribute('href')).toBe('/documents/policies');
  });

  it('says in plain words why a version cannot be opened, and when the role may not read policies', async () => {
    serve({
      'GET /v1/company-policies': [200, { items: [LEAVE] }],
      [`GET /v1/company-policy-versions/${V_LEAVE_1}/content`]: [409, { error: 'FILE_NOT_RELEASED', message: 'Not released', details: { scanState: 'PENDING_SCAN' } }],
    });
    renderAt('/policies', [READ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Synthetic leave handbook' }));
    expect((await screen.findByRole('alert')).textContent).toContain('has not been released by the malware scan yet');
    cleanup();

    serve({ 'GET /v1/company-policies': [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    renderAt('/policies', [READ]);
    expect(await screen.findByText(/cannot read company policies/)).toBeTruthy();
    cleanup();

    serve({});
    renderAt('/policies', []);
    expect(screen.getByText(/cannot read company policies/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('keeps every version in the history; only released versions can be opened', async () => {
    const downloads = stubDownloads();
    try {
      serve({ [`GET /v1/company-policies/${P_TRAVEL}`]: [200, travelDetail()], [`GET /v1/company-policy-versions/${V_TRAVEL_1}/content`]: [200, 'synthetic pdf bytes'] });
      renderAt(`/policies/${P_TRAVEL}`, [READ]);
      const table = await screen.findByRole('table', { name: 'Versions' });
      expect(within(table).getAllByRole('row')).toHaveLength(4);
      const third = rowOf(table, 'travel-v3.pdf');
      expect(within(third).getByText('quarantined by the malware scan')).toBeTruthy();
      expect(within(third).getByText('cannot be opened')).toBeTruthy();
      expect(within(third).queryByRole('button')).toBeNull();
      const second = rowOf(table, 'travel-v2.pdf');
      expect(within(second).getByText('expired')).toBeTruthy();
      expect(within(second).getByText('Synthetic revision')).toBeTruthy();
      fireEvent.click(within(rowOf(table, 'travel-v1.pdf')).getByRole('button', { name: 'Download version 1' }));
      await waitFor(() => expect(downloads.saved).toHaveBeenCalledTimes(1));
      expect(callsTo('GET', `/v1/company-policy-versions/${V_TRAVEL_1}/content`)).toHaveLength(1);
      expect(screen.queryByRole('link', { name: 'Manage this policy' })).toBeNull();
    } finally {
      downloads.restore();
    }
  });

  it('a policy the API does not return reads as not available, with no hint why', async () => {
    serve({ [`GET /v1/company-policies/${P_RESTRICTED}`]: [404, { error: 'NOT_FOUND', message: 'Resource not found' }] });
    renderAt(`/policies/${P_RESTRICTED}`, [READ]);
    expect(await screen.findByText('This policy is not available in the selected role’s company.')).toBeTruthy();
    expect(screen.queryByText(/confidential/i)).toBeNull();
  });
});

describe('policy upload (FR-010, DF02, FR-106)', () => {
  it('publishes a policy with exactly the API’s body, then starts a clean form and reads the list again', async () => {
    let lists = 0;
    serve({
      'GET /v1/company-policies': () => {
        lists += 1;
        return [200, { items: lists === 1 ? [LEAVE] : [LEAVE, REMOTE] }];
      },
      'POST /v1/company-policies': () => [
        201,
        { id: P_REMOTE, policyCode: 'REMOTE_WORK', title: 'Synthetic remote work policy', classification: 'OPERATIONAL', version: 1, versionId: 'v-new', versionNumber: 1, scanState: 'PENDING_SCAN' },
      ],
    });
    renderAt('/documents/policies', [READ, MANAGE]);
    const form = await screen.findByRole('form', { name: 'Publish a new policy' });
    // Without the confidential grant only an operational policy can be published.
    expect(options(within(form).getByLabelText('Classification'))).toEqual(['OPERATIONAL']);
    const publish = within(form).getByRole('button', { name: 'Publish' });
    expect(disabled(publish)).toBe(true);
    fireEvent.change(within(form).getByLabelText('Policy code'), { target: { value: 'remote_work' } });
    expect(valueOf(within(form).getByLabelText('Policy code'))).toBe('REMOTE_WORK');
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: ' Synthetic remote work policy ' } });
    fireEvent.change(within(form).getByLabelText('Expires on (optional)'), { target: { value: '2027-12-31' } });
    fireEvent.change(within(form).getByLabelText('Change note (optional)'), { target: { value: 'First synthetic edition' } });
    fireEvent.change(within(form).getByLabelText('Policy file'), { target: { files: [pdf('remote.pdf')] } });
    expect(disabled(publish)).toBe(false);
    fireEvent.click(publish);

    await waitFor(() => expect(callsTo('POST', '/v1/company-policies')).toHaveLength(1));
    expect(callsTo('POST', '/v1/company-policies')[0]!.body).toEqual({
      policyCode: 'REMOTE_WORK',
      title: 'Synthetic remote work policy',
      classification: 'OPERATIONAL',
      fileName: 'remote.pdf',
      contentBase64: btoa(PDF_TEXT),
      expiresOn: '2027-12-31',
      changeNote: 'First synthetic edition',
    });
    const done = await screen.findByText(/Published Synthetic remote work policy \(REMOTE_WORK\), version 1/);
    expect(done.textContent).toContain('waiting for the malware scan; nobody can open it until the scan releases it');
    expect(within(done).getByRole('link', { name: 'Manage this policy' }).getAttribute('href')).toBe(`/documents/policies/${P_REMOTE}`);
    const fresh = screen.getByRole('form', { name: 'Publish a new policy' });
    expect(valueOf(within(fresh).getByLabelText('Policy code'))).toBe('');
    expect(valueOf(within(fresh).getByLabelText('Expires on (optional)'))).toBe('');
    expect(disabled(within(fresh).getByRole('button', { name: 'Publish' }))).toBe(true);
    expect(await screen.findByRole('link', { name: 'Manage Synthetic remote work policy' })).toBeTruthy();
    // A version not released yet is named on the list, without guessing why.
    expect(rowOf(screen.getByRole('table', { name: 'Published policies' }), 'Synthetic remote work policy').textContent).toContain('Version 1 is not released');
  });

  it('offers a confidential classification only with the confidential grant, and sends it as chosen', async () => {
    serve({
      'GET /v1/company-policies': [200, { items: [] }],
      'POST /v1/company-policies': () => [201, { id: P_RESTRICTED, version: 1, versionId: 'v-new', versionNumber: 1, scanState: 'CLEAN' }],
    });
    renderAt('/documents/policies', [READ, MANAGE, MANAGE_CONFIDENTIAL]);
    const form = await screen.findByRole('form', { name: 'Publish a new policy' });
    expect(options(within(form).getByLabelText('Classification'))).toEqual(['OPERATIONAL', 'CONFIDENTIAL']);
    fireEvent.change(within(form).getByLabelText('Policy code'), { target: { value: 'RESTRICTED_PLAN' } });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Synthetic restricted plan' } });
    fireEvent.change(within(form).getByLabelText('Classification'), { target: { value: 'CONFIDENTIAL' } });
    fireEvent.change(within(form).getByLabelText('Policy file'), { target: { files: [pdf('plan.pdf')] } });
    fireEvent.click(within(form).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(callsTo('POST', '/v1/company-policies')).toHaveLength(1));
    const body = callsTo('POST', '/v1/company-policies')[0]!.body!;
    expect(body).toMatchObject({ policyCode: 'RESTRICTED_PLAN', classification: 'CONFIDENTIAL', fileName: 'plan.pdf' });
    expect(body.expiresOn).toBeUndefined();
    expect(body.changeNote).toBeUndefined();
    expect((await screen.findByRole('status')).textContent).toContain('The malware scan released it');
    expect(await screen.findByText('No company policies are published yet.')).toBeTruthy();
  });

  it('shows the API’s refusals in plain words and keeps what was typed', async () => {
    const refusals: Reply[] = [
      [409, { error: 'POLICY_EXISTS', message: 'A policy with this code exists' }],
      [422, { error: 'EXPIRY_IN_PAST', message: 'A new policy version cannot already be expired' }],
      [403, { error: 'FORBIDDEN', message: 'Company policies are published from an unrestricted company-scope assignment' }],
      [422, { error: 'UNSUPPORTED_FILE', message: 'Only PDF, JPEG and PNG files are accepted' }],
    ];
    serve({ 'GET /v1/company-policies': [200, { items: [LEAVE] }], 'POST /v1/company-policies': () => refusals.shift()! });
    renderAt('/documents/policies', [READ, MANAGE]);
    const form = await screen.findByRole('form', { name: 'Publish a new policy' });
    fireEvent.change(within(form).getByLabelText('Policy code'), { target: { value: 'LEAVE_HANDBOOK' } });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Synthetic leave handbook' } });
    fireEvent.change(within(form).getByLabelText('Policy file'), { target: { files: [pdf('leave.pdf')] } });
    for (const words of ['A policy with this code already exists', 'This expiry date has already passed', 'unrestricted company-scope assignment', 'Only PDF, JPEG and PNG files']) {
      fireEvent.click(within(form).getByRole('button', { name: 'Publish' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(words));
    }
    expect(valueOf(within(form).getByLabelText('Policy code'))).toBe('LEAVE_HANDBOOK');
    expect(callsTo('POST', '/v1/company-policies')).toHaveLength(4);
  });

  it('is not offered without the manage duty', () => {
    serve({});
    renderAt('/documents/policies', [READ]);
    expect(screen.getByText(/cannot publish company policies/)).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('managing one policy (FR-010, DF02)', () => {
  it('publishes a new version against the policy version it was loaded at; a stale view is reloaded and kept for the retry', async () => {
    let detail = travelDetail();
    let posts = 0;
    serve({
      [`GET /v1/company-policies/${P_TRAVEL}`]: () => [200, detail],
      [`POST /v1/company-policies/${P_TRAVEL}/versions`]: () => {
        posts += 1;
        if (posts === 1) {
          // Someone else changed the policy meanwhile.
          detail = travelDetail({ version: 4, title: 'Synthetic travel rules' });
          return [409, { error: 'STALE_VERSION', message: 'The policy changed; reload and retry' }];
        }
        detail = travelDetail({ version: 5, title: 'Synthetic travel rules', versions: [version('v-4', 4, { changeNote: 'Synthetic fourth edition' }), ...travelDetail().versions] });
        return [201, { id: P_TRAVEL, version: 5, versionId: 'v-4', versionNumber: 4, scanState: 'CLEAN' }];
      },
    });
    renderAt(`/documents/policies/${P_TRAVEL}`, [READ, MANAGE]);
    const form = await screen.findByRole('form', { name: 'Publish a new version' });
    expect(disabled(within(form).getByRole('button', { name: 'Publish version' }))).toBe(true);
    fireEvent.change(within(form).getByLabelText('Change note (optional)'), { target: { value: 'Synthetic fourth edition' } });
    fireEvent.change(within(form).getByLabelText('Version file'), { target: { files: [pdf('travel-v4.pdf')] } });
    fireEvent.click(within(form).getByRole('button', { name: 'Publish version' }));

    expect((await screen.findByRole('alert')).textContent).toContain('The policy changed since this page loaded it, so nothing was published');
    expect(callsTo('POST', `/v1/company-policies/${P_TRAVEL}/versions`)[0]!.body).toEqual({
      fileName: 'travel-v4.pdf',
      contentBase64: btoa(PDF_TEXT),
      expectedVersion: 3,
      changeNote: 'Synthetic fourth edition',
    });
    expect(await screen.findByRole('heading', { name: 'Synthetic travel rules (TRAVEL)' })).toBeTruthy();
    expect(valueOf(within(form).getByLabelText('Change note (optional)'))).toBe('Synthetic fourth edition');

    fireEvent.click(within(form).getByRole('button', { name: 'Publish version' }));
    expect((await screen.findByText(/Published version 4\./)).textContent).toContain('The malware scan released it');
    expect(callsTo('POST', `/v1/company-policies/${P_TRAVEL}/versions`)[1]!.body!.expectedVersion).toBe(4);
    const versions = await screen.findByRole('table', { name: 'Versions' });
    await waitFor(() => expect(within(versions).getAllByRole('row')).toHaveLength(5));
    const fresh = screen.getByRole('form', { name: 'Publish a new version' });
    expect(valueOf(within(fresh).getByLabelText('Change note (optional)'))).toBe('');
  });

  it('changes the title with only the changed field and the policy version; a confidential classification needs its grant', async () => {
    let detail = travelDetail();
    serve({
      [`GET /v1/company-policies/${P_TRAVEL}`]: () => [200, detail],
      [`PATCH /v1/company-policies/${P_TRAVEL}`]: () => {
        detail = travelDetail({ version: 4, title: 'Synthetic travel rules' });
        return [200, detail];
      },
    });
    renderAt(`/documents/policies/${P_TRAVEL}`, [READ, MANAGE]);
    const form = await screen.findByRole('form', { name: 'Title and classification' });
    expect(options(within(form).getByLabelText('Classification'))).toEqual(['OPERATIONAL']);
    const save = within(form).getByRole('button', { name: 'Save' });
    expect(disabled(save)).toBe(true);
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Synthetic travel rules ' } });
    fireEvent.click(save);
    await waitFor(() => expect(callsTo('PATCH', `/v1/company-policies/${P_TRAVEL}`)).toHaveLength(1));
    expect(callsTo('PATCH', `/v1/company-policies/${P_TRAVEL}`)[0]!.body).toEqual({ expectedVersion: 3, title: 'Synthetic travel rules' });
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Synthetic travel rules (TRAVEL)' })).toBeTruthy();
    cleanup();

    // A confidential policy cannot be changed without the confidential grant.
    serve({ [`GET /v1/company-policies/${P_RESTRICTED}`]: [200, restrictedDetail()] });
    renderAt(`/documents/policies/${P_RESTRICTED}`, [READ, MANAGE]);
    expect(await screen.findByText('Changing a confidential policy also needs the confidential policy grant.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Title and classification' })).toBeNull();
    cleanup();

    // With it, releasing the policy to every employee says so before it is sent.
    serve({
      [`GET /v1/company-policies/${P_RESTRICTED}`]: [200, restrictedDetail()],
      [`PATCH /v1/company-policies/${P_RESTRICTED}`]: () => [200, { ...restrictedDetail(), classification: 'OPERATIONAL', version: 2 }],
    });
    renderAt(`/documents/policies/${P_RESTRICTED}`, [READ, MANAGE, MANAGE_CONFIDENTIAL]);
    const confidential = await screen.findByRole('form', { name: 'Title and classification' });
    fireEvent.change(within(confidential).getByLabelText('Classification'), { target: { value: 'OPERATIONAL' } });
    expect(screen.getByText(/readable by every employee of the company/)).toBeTruthy();
    fireEvent.click(within(confidential).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('PATCH', `/v1/company-policies/${P_RESTRICTED}`)).toHaveLength(1));
    expect(callsTo('PATCH', `/v1/company-policies/${P_RESTRICTED}`)[0]!.body).toEqual({ expectedVersion: 1, classification: 'OPERATIONAL' });
  });

  it('a stale classification change is refused in plain words and the policy reloaded', async () => {
    let reads = 0;
    serve({
      [`GET /v1/company-policies/${P_TRAVEL}`]: () => {
        reads += 1;
        return [200, reads === 1 ? travelDetail() : travelDetail({ version: 4 })];
      },
      [`PATCH /v1/company-policies/${P_TRAVEL}`]: [409, { error: 'STALE_VERSION', message: 'The policy changed; reload and retry' }],
    });
    renderAt(`/documents/policies/${P_TRAVEL}`, [READ, MANAGE]);
    const form = await screen.findByRole('form', { name: 'Title and classification' });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Synthetic travel rules' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('so nothing was saved. It has been reloaded');
    await waitFor(() => expect(reads).toBe(2));
  });
});

describe('bulk document mapping (FR-010, DF09, I-13, FR-106)', () => {
  const MAPPING_HEADER = 'fileName,employeeCode,documentType,expiresOn';
  const job = (patch: Obj = {}): Obj => ({
    id: 'job-1',
    state: 'PREVIEWED',
    template: 'DOCUMENT_MAPPING_V1',
    fileName: 'mapping.csv',
    rowCount: 2,
    acceptedCount: 0,
    rejectedCount: 0,
    scanState: 'CLEAN',
    createdAt: AT,
    rows: [
      { rowNumber: 1, businessKey: 'SYN-1', state: 'VALID', errorCode: null, proposedChanges: null },
      { rowNumber: 2, businessKey: 'SYN-2', state: 'VALID', errorCode: null, proposedChanges: null },
    ],
    ...patch,
  });
  const staged = (fileName: string, scanState: string, state = 'UNMAPPED') => ({
    id: `s-${fileName}`,
    fileName,
    mediaType: 'application/pdf',
    byteSize: 18,
    scanState,
    state,
    mappedDocumentId: state === 'MAPPED' ? 'd-1' : null,
    mappedAt: state === 'MAPPED' ? '2026-10-28T06:00:00.000Z' : null,
    discardedAt: state === 'DISCARDED' ? '2026-10-29T06:00:00.000Z' : null,
    uploadedAt: '2026-10-27T06:00:00.000Z',
  });
  /** GET /v1/documents/bulk-uploads for one state and page, 25 a page, as the screen asks for it. */
  const STAGED = (state: string, page = 1) => `GET /v1/documents/bulk-uploads?state=${state}&page=${page}&pageSize=25`;
  const stagedPage = (items: Obj[], total = items.length, page = 1): Reply => [200, { items, total, page, pageSize: 25 }];
  const NO_STAGED = stagedPage([]);
  /** GET /v1/documents/mapping-imports: the user's own batches, job facts only. */
  const batch = (patch: Obj = {}): Obj => {
    const facts: Obj = { ...job(patch), updatedAt: AT };
    delete facts.rows;
    return facts;
  };
  const batches = (items: Obj[], total = items.length, page = 1): Reply => [200, { items, total, page, pageSize: 25 }];
  const NO_BATCHES = batches([]);
  const held = (patch: Obj = {}) => job({ state: 'UPLOADED', rowCount: null, rows: [], scanState: 'PENDING_SCAN', ...patch });
  const uploadMapping = async (text = `${MAPPING_HEADER}\r\na.pdf,SYN-1,GENERAL,\r\nb.pdf,SYN-2,GENERAL,`) => {
    fireEvent.change(await screen.findByLabelText('Mapping CSV file'), { target: { files: [csvFile(text)] } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
  };
  const mappingPosts = () => callsTo('POST', '/v1/documents/mapping-imports');
  /** The button waits for the request that showed the held batch to settle. */
  const checkAgain = async () => {
    const button = await screen.findByRole('button', { name: 'Check the scan again' });
    await waitFor(() => expect(disabled(button)).toBe(false));
    fireEvent.click(button);
  };

  it('stages each chosen file in turn, reports each scan outcome or refusal, and reads the staged list again', async () => {
    let stagedReads = 0;
    serve({
      [STAGED('UNMAPPED')]: () => {
        stagedReads += 1;
        return stagedPage(stagedReads === 1 ? [] : [staged('a.pdf', 'CLEAN'), staged('b.pdf', 'QUARANTINED')]);
      },
      [STAGED('MAPPED')]: stagedPage([staged('old.pdf', 'CLEAN', 'MAPPED')]),
      'POST /v1/documents/bulk-uploads': (call) => {
        const name = call.body!.fileName as string;
        if (name === 'c.pdf') return [409, { error: 'FILE_NAME_IN_USE', message: 'You already staged an unmapped file with this name' }];
        return [201, { id: `s-${name}`, fileName: name, mediaType: 'application/pdf', byteSize: 18, scanState: name === 'a.pdf' ? 'CLEAN' : 'QUARANTINED', state: 'UNMAPPED' }];
      },
    });
    renderAt('/documents/bulk-mapping', [UPLOAD]);
    expect(await screen.findByText('You have no staged files waiting to be mapped.')).toBeTruthy();
    // The mapping file needs the import duty as well.
    expect(screen.getByText(/also needs the import duty/)).toBeTruthy();
    expect(screen.queryByLabelText('Mapping CSV file')).toBeNull();

    fireEvent.change(screen.getByLabelText('Documents to stage'), { target: { files: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Stage 3 files' }));
    const results = await screen.findByRole('list', { name: 'Staging results' });
    const lines = within(results).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines[0]).toBe('a.pdf: Staged and released by the malware scan; it can be mapped.');
    expect(lines[1]).toBe('b.pdf: Staged, but quarantined by the malware scan: it can never be mapped.');
    expect(lines[2]).toContain('c.pdf: You already staged a file with this name that is waiting to be mapped.');
    expect(screen.getByText('2 files staged, 1 file not staged.')).toBeTruthy();
    expect(callsTo('POST', '/v1/documents/bulk-uploads').map((c) => c.body!.fileName)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(callsTo('POST', '/v1/documents/bulk-uploads')[0]!.body).toEqual({ fileName: 'a.pdf', contentBase64: btoa(PDF_TEXT) });

    const waiting = await screen.findByRole('table', { name: 'Files waiting to be mapped' });
    expect(within(rowOf(waiting, 'a.pdf')).getByText('released')).toBeTruthy();
    expect(within(rowOf(waiting, 'b.pdf')).getByText('quarantined by the malware scan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mapped' }));
    const mapped = await screen.findByRole('table', { name: 'Mapped files' });
    expect(rowOf(mapped, 'old.pdf').textContent).toContain('2026-10-28');
  });

  it('downloads the published DOCUMENT_MAPPING_V1 template (DF09) beside the column list', async () => {
    const downloads = stubDownloads();
    try {
      serve({
        [STAGED('UNMAPPED')]: NO_STAGED,
        'GET /v1/documents/mapping-imports': NO_BATCHES,
        'GET /v1/documents/mapping-imports/template': [200, MAPPING_HEADER],
      });
      renderAt('/documents/bulk-mapping', [UPLOAD, IMPORT]);
      expect(await screen.findByText(MAPPING_HEADER, { selector: 'code' })).toBeTruthy();
      expect(screen.getByText('DOCUMENT_MAPPING_V1.csv: the header line only, ready to fill in.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Download the template' }));
      await waitFor(() => expect(downloads.saved).toHaveBeenCalledTimes(1));
      expect(callsTo('GET', '/v1/documents/mapping-imports/template')).toHaveLength(1);
      expect(mappingPosts()).toHaveLength(0);
    } finally {
      downloads.restore();
    }
  });

  it('is not offered without the document upload grant', () => {
    serve({});
    renderAt('/documents/bulk-mapping', [IMPORT]);
    expect(screen.getByText(/holds no document upload grant/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('discards a file waiting to be mapped only after a second click; it is then listed under Discarded, never as deleted', async () => {
    let waitingReads = 0;
    serve({
      [STAGED('UNMAPPED')]: () => {
        waitingReads += 1;
        return stagedPage(waitingReads === 1 ? [staged('flagged.pdf', 'QUARANTINED'), staged('keep.pdf', 'CLEAN')] : [staged('keep.pdf', 'CLEAN')]);
      },
      [STAGED('DISCARDED')]: stagedPage([staged('flagged.pdf', 'QUARANTINED', 'DISCARDED')]),
      'POST /v1/documents/bulk-uploads/s-flagged.pdf/discard': [200, staged('flagged.pdf', 'QUARANTINED', 'DISCARDED')],
      'POST /v1/documents/bulk-uploads/s-keep.pdf/discard': [409, { error: 'FILE_MAPPED', message: 'This file is mapped to an employee record and cannot be discarded' }],
    });
    renderAt('/documents/bulk-mapping', [UPLOAD]);
    const waiting = await screen.findByRole('table', { name: 'Files waiting to be mapped' });
    // The first click only asks; Keep backs out with nothing sent.
    fireEvent.click(within(rowOf(waiting, 'flagged.pdf')).getByRole('button', { name: 'Discard flagged.pdf' }));
    fireEvent.click(within(rowOf(waiting, 'flagged.pdf')).getByRole('button', { name: 'Keep' }));
    expect(within(rowOf(waiting, 'flagged.pdf')).queryByRole('button', { name: 'Confirm discarding flagged.pdf' })).toBeNull();
    fireEvent.click(within(rowOf(waiting, 'flagged.pdf')).getByRole('button', { name: 'Discard flagged.pdf' }));
    fireEvent.click(within(rowOf(waiting, 'flagged.pdf')).getByRole('button', { name: 'Confirm discarding flagged.pdf' }));
    expect((await screen.findByText(/flagged.pdf was discarded/)).textContent).toBe('flagged.pdf was discarded. It stays on record under Discarded and can never be mapped.');
    expect(callsTo('POST', '/v1/documents/bulk-uploads/s-flagged.pdf/discard')).toHaveLength(1);
    expect(callsTo('POST', '/v1/documents/bulk-uploads/s-flagged.pdf/discard')[0]!.body).toBeUndefined();
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Files waiting to be mapped' })).queryByText('flagged.pdf')).toBeNull());

    // A file mapped meanwhile is refused in plain words.
    fireEvent.click(within(rowOf(screen.getByRole('table', { name: 'Files waiting to be mapped' }), 'keep.pdf')).getByRole('button', { name: 'Discard keep.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discarding keep.pdf' }));
    expect((await screen.findByRole('alert')).textContent).toContain('mapped to an employee meanwhile: it is an employee document now and cannot be discarded');

    fireEvent.click(screen.getByRole('button', { name: 'Discarded' }));
    const discarded = await screen.findByRole('table', { name: 'Discarded files' });
    expect(rowOf(discarded, 'flagged.pdf').textContent).toContain('2026-10-29');
    expect(within(discarded).queryByRole('button', { name: /Discard/ })).toBeNull();
  });

  it('pages through the user’s staged files, newest first, with the shared pager; another tab starts at its first page', async () => {
    serve({
      [STAGED('UNMAPPED')]: stagedPage([staged('newest.pdf', 'CLEAN')], 30),
      [STAGED('UNMAPPED', 2)]: stagedPage([staged('oldest.pdf', 'CLEAN')], 30, 2),
      [STAGED('MAPPED')]: stagedPage([staged('mapped.pdf', 'CLEAN', 'MAPPED')]),
    });
    renderAt('/documents/bulk-mapping', [UPLOAD]);
    expect(await screen.findByText('newest.pdf')).toBeTruthy();
    const pager = screen.getByRole('navigation', { name: 'Staged file pages' });
    expect(within(pager).getByText('Page 1 of 2 · 30 staged files')).toBeTruthy();
    expect(disabled(within(pager).getByRole('button', { name: 'Previous page' }))).toBe(true);
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('oldest.pdf')).toBeTruthy();
    expect(screen.queryByText('newest.pdf')).toBeNull();
    expect(screen.getByText('Page 2 of 2 · 30 staged files')).toBeTruthy();
    expect(disabled(screen.getByRole('button', { name: 'Next page' }))).toBe(true);
    expect(callsTo('GET', '/v1/documents/bulk-uploads').map((c) => c.search)).toEqual(['?state=UNMAPPED&page=1&pageSize=25', '?state=UNMAPPED&page=2&pageSize=25']);

    // Another tab starts at its own first page; a list that fits on one page shows no pager.
    fireEvent.click(screen.getByRole('button', { name: 'Mapped' }));
    expect(await screen.findByText('mapped.pdf')).toBeTruthy();
    expect(callsTo('GET', '/v1/documents/bulk-uploads').at(-1)!.search).toBe('?state=MAPPED&page=1&pageSize=25');
    expect(screen.queryByRole('navigation', { name: 'Staged file pages' })).toBeNull();
  });

  it('lists the user’s own mapping batches; a held batch is opened again, checked again and committed', async () => {
    const heldBatch = batch({ id: 'job-1', state: 'UPLOADED', rowCount: null, scanState: 'PENDING_SCAN', fileName: 'held.csv' });
    const doneBatch = batch({ id: 'job-2', state: 'COMMITTED', acceptedCount: 3, rowCount: 3, fileName: 'done.csv' });
    let resumes = 0;
    serve({
      [STAGED('UNMAPPED')]: NO_STAGED,
      'GET /v1/documents/mapping-imports': batches([heldBatch, doneBatch]),
      'GET /v1/documents/mapping-imports/job-1': [200, held({ fileName: 'held.csv' })],
      'POST /v1/documents/mapping-imports/job-1/resume': () => {
        resumes += 1;
        return resumes === 1 ? [202, held({ fileName: 'held.csv' })] : [200, job({ fileName: 'held.csv' })];
      },
      'POST /v1/documents/mapping-imports/job-1/commit': [200, job({ fileName: 'held.csv', state: 'COMMITTED', acceptedCount: 2 })],
    });
    renderAt('/documents/bulk-mapping', [UPLOAD, IMPORT]);
    const list = await screen.findByRole('table', { name: 'Your mapping batches' });
    expect(callsTo('GET', '/v1/documents/mapping-imports')[0]!.search).toBe('?page=1&pageSize=25');
    expect(rowOf(list, 'held.csv').textContent).toContain('waiting for the scan');
    expect(rowOf(list, 'held.csv').textContent).toContain('waiting for the malware scan');
    expect(rowOf(list, 'done.csv').textContent).toContain('committed');
    expect(rowOf(list, 'done.csv').textContent).toContain('3 mapped');
    expect(screen.queryByText(/Page 1 of/)).toBeNull();

    fireEvent.click(within(rowOf(list, 'held.csv')).getByRole('button', { name: /^Open held.csv/ }));
    expect(await screen.findByText(/This is usually a short wait/)).toBeTruthy();
    expect(within(rowOf(screen.getByRole('table', { name: 'Your mapping batches' }), 'held.csv')).getByText('open above')).toBeTruthy();
    await checkAgain();
    expect(await screen.findByText('Still waiting for the malware scan.')).toBeTruthy();
    await checkAgain();
    fireEvent.click(await screen.findByRole('button', { name: 'Map 2 documents' }));
    expect(await screen.findByText('All 2 rows were applied.')).toBeTruthy();
    expect(callsTo('POST', '/v1/documents/mapping-imports/job-1/commit')).toHaveLength(1);
    expect(mappingPosts()).toHaveLength(0);
    // Each step read the list of batches again.
    await waitFor(() => expect(callsTo('GET', '/v1/documents/mapping-imports').length).toBeGreaterThanOrEqual(4));
  });

  it('pages through the user’s mapping batches, newest first', async () => {
    serve({
      [STAGED('UNMAPPED')]: NO_STAGED,
      'GET /v1/documents/mapping-imports?page=1&pageSize=25': batches([batch({ id: 'job-new', fileName: 'newest.csv' })], 30),
      'GET /v1/documents/mapping-imports?page=2&pageSize=25': batches([batch({ id: 'job-old', fileName: 'oldest.csv', state: 'CANCELLED' })], 30, 2),
    });
    renderAt('/documents/bulk-mapping', [UPLOAD, IMPORT]);
    expect(await screen.findByText('newest.csv')).toBeTruthy();
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    expect(disabled(screen.getByRole('button', { name: 'Newer batches' }))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Older batches' }));
    expect(await screen.findByText('oldest.csv')).toBeTruthy();
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    expect(rowOf(screen.getByRole('table', { name: 'Your mapping batches' }), 'oldest.csv').textContent).toContain('cancelled, nothing mapped');
    expect(disabled(screen.getByRole('button', { name: 'Older batches' }))).toBe(true);
  });

  it('a mapping file naming an unknown employee code is rejected: each row’s problem in plain words, nothing mapped, no commit', async () => {
    serve({
      [STAGED('UNMAPPED')]: NO_STAGED,
      'GET /v1/documents/mapping-imports': NO_BATCHES,
      'POST /v1/documents/mapping-imports': () => [
        201,
        job({
          state: 'REJECTED',
          rowCount: 3,
          rejectedCount: 3,
          rows: [
            { rowNumber: 1, businessKey: 'SYN-1', state: 'REJECTED', errorCode: 'BATCH_REJECTED', proposedChanges: null },
            { rowNumber: 2, businessKey: 'NOSUCH9', state: 'REJECTED', errorCode: 'UNKNOWN_EMPLOYEE', proposedChanges: null },
            { rowNumber: 3, businessKey: 'SYN-2', state: 'REJECTED', errorCode: 'FILE_QUARANTINED', proposedChanges: null },
          ],
        }),
      ],
    });
    renderAt('/documents/bulk-mapping', [UPLOAD, IMPORT]);
    const text = `${MAPPING_HEADER}\r\na.pdf,SYN-1,GENERAL,\r\nb.pdf,NOSUCH9,GENERAL,\r\nq.pdf,SYN-2,GENERAL,`;
    await uploadMapping(text);
    expect(await screen.findByText(/This batch was rejected, so nothing was applied/)).toBeTruthy();
    const post = mappingPosts()[0]!;
    expect(post.body).toMatchObject({ fileName: 'mapping.csv', contentBase64: btoa(text) });
    expect(post.body!.idempotencyKey).toMatch(/^mapping-/);
    const unknown = screen.getByText('NOSUCH9').closest('tr') as HTMLElement;
    expect(unknown.textContent).toContain('No employee in this company has this employee code. Nothing is assigned to a guessed employee');
    expect(unknown.textContent).toContain('UNKNOWN_EMPLOYEE');
    expect((screen.getByText('SYN-2').closest('tr') as HTMLElement).textContent).toContain('failed the malware scan and is quarantined, so it can never be mapped');
    expect(within(screen.getByText('SYN-1').closest('tr') as HTMLElement).getByText('not applied (another row failed)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Map / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel import' })).toBeNull();
  });

  it('a previewed mapping is committed only on request, after which the staged files are read again', async () => {
    let stagedReads = 0;
    serve({
      [STAGED('UNMAPPED')]: () => {
        stagedReads += 1;
        return stagedPage(stagedReads === 1 ? [staged('a.pdf', 'CLEAN'), staged('b.pdf', 'CLEAN')] : []);
      },
      'GET /v1/documents/mapping-imports': NO_BATCHES,
      'POST /v1/documents/mapping-imports': () => [201, job()],
      'POST /v1/documents/mapping-imports/job-1/commit': () => [
        200,
        job({
          state: 'COMMITTED',
          acceptedCount: 2,
          rows: [
            { rowNumber: 1, businessKey: 'SYN-1', state: 'ACCEPTED', errorCode: null, proposedChanges: null },
            { rowNumber: 2, businessKey: 'SYN-2', state: 'ACCEPTED', errorCode: null, proposedChanges: null },
          ],
        }),
      ],
    });
    renderAt('/documents/bulk-mapping', [UPLOAD, IMPORT]);
    expect(await screen.findByRole('table', { name: 'Files waiting to be mapped' })).toBeTruthy();
    await uploadMapping();
    expect(await screen.findByText(/All 2 rows are valid/)).toBeTruthy();
    expect(callsTo('POST', '/v1/documents/mapping-imports/job-1/commit')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Map 2 documents' }));
    expect(await screen.findByText('All 2 rows were applied.')).toBeTruthy();
    expect(callsTo('POST', '/v1/documents/mapping-imports/job-1/commit')).toHaveLength(1);
    expect(await screen.findByText('You have no staged files waiting to be mapped.')).toBeTruthy();
    // The form started clean once the preview was on screen.
    expect(disabled(screen.getByRole('button', { name: 'Validate' }))).toBe(true);
  });

  it('a mapping file still waiting for the malware scan is held: nothing read, no commit; checked again from its stored file it is previewed', async () => {
    let resumes = 0;
    serve({
      [STAGED('UNMAPPED')]: NO_STAGED,
      'GET /v1/documents/mapping-imports': NO_BATCHES,
      'POST /v1/documents/mapping-imports': [202, held()],
      'POST /v1/documents/mapping-imports/job-1/resume': () => {
        resumes += 1;
        return resumes === 1 ? [202, held()] : [200, job()];
      },
    });
    renderAt('/documents/bulk-mapping', [UPLOAD, IMPORT]);
    await uploadMapping();
    expect(await screen.findByText(/waiting for the malware scan, so nothing in it has been read yet. This is usually a short wait/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Map / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel import' })).toBeTruthy();
    await checkAgain();
    expect(await screen.findByText('Still waiting for the malware scan.')).toBeTruthy();
    await checkAgain();
    expect(await screen.findByText(/All 2 rows are valid/)).toBeTruthy();
    // The file was uploaded once; checking again sends nothing but the batch.
    expect(mappingPosts()).toHaveLength(1);
    expect(callsTo('POST', '/v1/documents/mapping-imports/job-1/resume').map((c) => c.body)).toEqual([undefined, undefined]);
    expect(screen.queryByRole('button', { name: 'Check the scan again' })).toBeNull();
    expect(callsTo('POST', '/v1/documents/mapping-imports/job-1/commit')).toHaveLength(0);
  });

  it('a held mapping file can be cancelled; nothing is applied', async () => {
    serve({
      [STAGED('UNMAPPED')]: NO_STAGED,
      'GET /v1/documents/mapping-imports': NO_BATCHES,
      'POST /v1/documents/mapping-imports': [202, held()],
      'POST /v1/documents/mapping-imports/job-1/cancel': [200, job({ state: 'CANCELLED', rowCount: null, rows: [] })],
    });
    renderAt('/documents/bulk-mapping', [UPLOAD, IMPORT]);
    await uploadMapping();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel import' }));
    expect(await screen.findByText('Import cancelled; nothing was applied.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check the scan again' })).toBeNull();
    expect(callsTo('POST', '/v1/documents/mapping-imports/job-1/commit')).toHaveLength(0);
  });

  it('a mapping file the malware scan flags is refused in plain words, also when a held batch is checked again', async () => {
    const flagged: Reply = [422, { error: 'FILE_QUARANTINED', message: 'The malware scan flagged the file; nothing was read or imported' }];
    serve({ [STAGED('UNMAPPED')]: NO_STAGED, 'GET /v1/documents/mapping-imports': NO_BATCHES, 'POST /v1/documents/mapping-imports': flagged });
    renderAt('/documents/bulk-mapping', [UPLOAD, IMPORT]);
    await uploadMapping();
    expect((await screen.findByRole('alert')).textContent).toContain('The malware scan flagged this mapping file, so nothing in it was read and nothing was mapped.');
    expect(screen.queryByRole('heading', { name: /Preview/ })).toBeNull();
    cleanup();

    serve({
      [STAGED('UNMAPPED')]: NO_STAGED,
      'GET /v1/documents/mapping-imports': NO_BATCHES,
      'POST /v1/documents/mapping-imports': [202, held()],
      'POST /v1/documents/mapping-imports/job-1/resume': flagged,
    });
    renderAt('/documents/bulk-mapping', [UPLOAD, IMPORT]);
    await uploadMapping();
    await checkAgain();
    expect((await screen.findByRole('alert')).textContent).toContain('The malware scan flagged this mapping file');
    // The server closed the held batch: it is no longer offered for a cancel or a commit.
    expect(screen.queryByRole('button', { name: 'Cancel import' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check the scan again' })).toBeNull();
  });
});

describe('registry exports', () => {
  it('offers the policy, policy upload and bulk mapping screens with their permission keys, and no ESS panel or decision queue', () => {
    expect(DOCUMENTS_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/policies', READ, true],
      ['/policies/:id', READ, false],
      ['/documents/policies', MANAGE, true],
      ['/documents/policies/:id', MANAGE, false],
      ['/documents/bulk-mapping', UPLOAD, true],
      // CL-150 (0261): the mandatory document types and the compliance report (document-compliance.test.tsx).
      ['/documents/mandatory-types', 'document_requirement.read.operational', true],
    ]);
    expect(DOCUMENTS_ESS_PANELS).toEqual([]);
    expect(DOCUMENTS_TASK_QUEUES).toEqual([]);
  });
});
