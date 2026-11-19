// Payroll runs: the run list and starting a run from a previewed scope.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, LIST_PAGE_SIZE, Pager, pageParams, Section } from '../../ui';
import { Problem } from './problems';
import { canReadRuns, CONFIG_READ, FLUSH, H3, label, PATHS, RUN_PREPARE, RUN_STATE, SCROLL, Status, useKeys } from './shared';
import type { Calendar, RunDetail, RunRow, ScopePreview } from './types';

// =========================================================================================================
// Payroll runs: list and start
// =========================================================================================================

const RUN_FILTERS = ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED', 'RETURNED', 'CANCELLED'];
/** A calendar's financial year label (payroll/config.ts), in any case: what GET /v1/payroll/runs takes as `financialYear`. */
const FINANCIAL_YEAR = /^[A-Za-z0-9][A-Za-z0-9_/-]{0,19}$/;

export function RunsScreen() {
  const { can } = useSession();
  if (!canReadRuns(can)) {
    return (
      <Section title="Payroll runs">
        <Empty>The selected role cannot see payroll runs.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <RunList />
      {can(RUN_PREPARE) && <NewRun />}
    </div>
  );
}

function RunList() {
  const keys = useKeys();
  const [state, setState] = useState('');
  // BR-012: the financial year label the calendar gives its periods; sent only once it can be one.
  const [year, setYear] = useState('');
  const yearFilter = FINANCIAL_YEAR.test(year.trim()) ? year.trim().toUpperCase() : '';
  const [page, setPage] = useState(1);
  // FR-056: one page at a time; `total` counts every run revision the selected role may see.
  const runs = useQuery({
    queryKey: [...keys.runs(state), yearFilter, page],
    queryFn: () =>
      api<{ items: RunRow[]; total?: number }>(
        `/v1/payroll/runs?${state ? `state=${encodeURIComponent(state)}&` : ''}${yearFilter ? `financialYear=${encodeURIComponent(yearFilter)}&` : ''}${pageParams(page)}`,
      ),
    retry: retryTransient,
  });
  return (
    <Section
      title="Payroll runs"
      actions={
        <>
          <label className="inline">
            State
            <select
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {RUN_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {label(RUN_STATE, s)}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            Financial year
            <input
              value={year}
              placeholder="All"
              maxLength={20}
              autoComplete="off"
              onChange={(e) => {
                setYear(e.target.value);
                setPage(1);
              }}
            />
          </label>
        </>
      }
    >
      <p className="hint">
        Each revision of a run is listed separately. Payment is not tracked on a run: it comes only from the outcomes recorded on its bank manifests. <Link to={PATHS.decisions}>Run decisions</Link>
      </p>
      {year.trim() !== '' && !yearFilter && <p className="hint">A financial year is the label its calendar gives it, for example FY2026: letters, digits, _, / or -.</p>}
      {runs.isPending && <p className="hint loading">Loading payroll runs…</p>}
      {runs.error && <Problem error={runs.error} act="read" />}
      {runs.data && runs.data.items.length === 0 && <Empty>{state || yearFilter ? 'No payroll runs match these filters.' : 'No payroll runs yet.'}</Empty>}
      {runs.data && runs.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Payroll runs">
            <thead>
              <tr>
                <th>Period</th>
                <th>Financial year</th>
                <th>Calendar</th>
                <th>Revision</th>
                <th>State</th>
                <th>Members</th>
                <th>Unresolved blocking exceptions</th>
                <th>Created</th>
                <th>Processed</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={PATHS.run(r.id)}>{`${r.periodCode} revision ${r.revision}`}</Link>
                  </td>
                  <td>{r.financialYear}</td>
                  <td>{r.calendarCode}</td>
                  <td>{r.revision}</td>
                  <td>
                    <Status map={RUN_STATE} code={r.state} />
                  </td>
                  <td>{r.memberCount}</td>
                  <td>{r.unresolvedExceptions}</td>
                  <td>{formatDate(r.createdAt)}</td>
                  <td>{formatDate(r.processedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={runs.data.total ?? runs.data.items.length} onPage={setPage} label="Payroll run pages" noun="run revision" />}
    </Section>
  );
}

function NewRun() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const calendars = useQuery({
    queryKey: keys.calendars,
    queryFn: () => api<{ items: Calendar[] }>('/v1/payroll/calendars'),
    enabled: can(CONFIG_READ),
    retry: retryTransient,
  });
  const [calendarId, setCalendarId] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [preview, setPreview] = useState<ScopePreview | null>(null);
  const previewing = useMutation({
    mutationFn: (pid: string) => api<ScopePreview>('/v1/payroll/runs/preview', { body: { periodId: pid } }),
    onSuccess: (p) => setPreview(p),
  });
  const create = useMutation({
    mutationFn: (p: ScopePreview) => api<RunDetail>('/v1/payroll/runs', { body: { periodId: p.periodId, scopeToken: p.scopeToken } }),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: keys.runsAll });
      navigate(PATHS.run(run.id));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'SCOPE_CHANGED') setPreview(null);
    },
  });
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Start a payroll run">
        <p className="hint">The selected role cannot list payroll calendars, so a run cannot be started here.</p>
      </Section>
    );
  }
  const active = (calendars.data?.items ?? []).filter((c) => c.state === 'ACTIVE');
  const calendar = active.find((c) => c.id === calendarId);
  const busy = previewing.isPending || create.isPending;
  return (
    <Section title="Start a payroll run">
      <p className="hint">Preview who the period’s run includes, then confirm exactly that scope. The run covers the whole company scope of the selected role.</p>
      {calendars.error && <Problem error={calendars.error} act="read" />}
      <form
        aria-label="Preview a payroll run"
        className="grid-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!periodId || busy) return;
          setPreview(null);
          create.reset();
          previewing.mutate(periodId);
        }}
      >
        <label>
          Payroll calendar
          <select
            value={calendarId}
            onChange={(e) => {
              setCalendarId(e.target.value);
              setPeriodId('');
              setPreview(null);
            }}
          >
            <option value="">Choose a calendar</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.code} · ${c.name} (${c.currencyCode})`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Period
          <select
            value={periodId}
            onChange={(e) => {
              setPeriodId(e.target.value);
              setPreview(null);
            }}
            disabled={!calendar}
          >
            <option value="">Choose a period</option>
            {(calendar?.periods ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {`${p.periodCode} (${formatDate(p.serviceStart)} to ${formatDate(p.serviceEnd)})`}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button type="submit" className="secondary" disabled={!periodId || busy}>
            {previewing.isPending ? 'Previewing…' : 'Preview the members'}
          </button>
        </div>
      </form>
      {calendars.data && active.length === 0 && <p className="hint">No payroll calendar is active yet.</p>}
      <Problem error={previewing.error} act="run-start" />
      {preview && (
        <div aria-label="Run scope preview" role="region">
          <h3 style={H3}>{`Scope of ${preview.periodCode}`}</h3>
          <p style={FLUSH}>
            {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'} included; {preview.notIncludedCount} not included.
          </p>
          {Object.keys(preview.notIncludedByReason).length > 0 && (
            <ul>
              {Object.entries(preview.notIncludedByReason).map(([reason, n]) => (
                <li key={reason}>{`${readable(reason)}: ${n}`}</li>
              ))}
            </ul>
          )}
          {preview.members.length > 0 && (
            <p className="hint">
              {preview.members.map((m) => `${m.employeeCode} ${m.displayName}`).join(', ')}
              {preview.membersTruncated ? ' and more' : ''}
            </p>
          )}
          <button type="button" disabled={busy || preview.memberCount === 0} onClick={() => create.mutate(preview)}>
            {create.isPending ? 'Creating…' : 'Create the run for this scope'}
          </button>
        </div>
      )}
      <Problem error={create.error} act="run-start" />
    </Section>
  );
}
