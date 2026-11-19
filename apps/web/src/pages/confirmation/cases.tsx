// The confirmations page (FR-080 to FR-082): its views with counts, and the cases in the chosen view.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatDate, isForbidden, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Section, StateBadge } from '../../ui';
import { AttentionPanel, OpenCasePanel } from './attention';
import { CasePanel } from './case-panel';
import { PendingExceptions } from './pending-exceptions';
import { APPROVE_EXCEPTION, asTabView, type ConfirmationCase, countByView, DECIDE, EXPORT, fetchCases, MANAGE, MANAGE_POLICIES, MIXED_TIMING, outcomeLabel, PANEL, POLICIES_PATH, READ, SCROLL, SR_ONLY, TABS, type TabView, TimingBadge, useKeys, UUID, viewButtonId } from './shared';

export function ConfirmationsPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const view = asTabView(params.get('view'));
  const caseParam = params.get('case');
  const selectedId = caseParam && UUID.test(caseParam) ? caseParam : null;
  // Focus moves to the case panel only when the user picks a case (also the one already shown), never on a deep-linked
  // page load: each pick is a new request.
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const canRead = can(READ);

  const setParam = (key: 'view' | 'case', value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  const selectCase = (id: string, focus: boolean) => {
    setFocusRequest((prev) => (focus ? { id, n: (prev?.n ?? 0) + 1 } : null));
    setParam('case', id);
  };
  const closeCase = () => {
    setParam('case', null);
    // Back to the case's row; when the chosen view does not list the case (a deep link, a case just opened), to the
    // page heading, so focus does not fall to the document when the panel goes away.
    const row = selectedId ? document.getElementById(viewButtonId(selectedId)) : null;
    (row ?? heading.current)?.focus();
  };

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Confirmations
      </h1>
      {canRead ? (
        <CaseRegister view={view} onView={(v) => setParam('view', v === 'ALL' ? null : v)} selectedId={selectedId} onSelect={(id) => selectCase(id, true)} />
      ) : (
        <Section title="Confirmation cases">
          <NotPermitted>The selected role cannot view confirmation cases.</NotPermitted>
        </Section>
      )}
      {canRead && selectedId && <CasePanel key={selectedId} id={selectedId} focusRequest={focusRequest?.id === selectedId ? focusRequest.n : null} onClose={closeCase} />}
      {can(APPROVE_EXCEPTION) && <PendingExceptions onOpenCase={canRead ? (id) => selectCase(id, true) : null} />}
      {can(MANAGE_POLICIES) && (
        <p className="hint">
          The duration each employee’s review takes comes from the <Link to={POLICIES_PATH}>confirmation policies</Link>.
        </p>
      )}
      {can(MANAGE) && <AttentionPanel onOpenCase={canRead ? (id) => selectCase(id, true) : null} />}
      {can(MANAGE) && (
        <OpenCasePanel
          onOpened={(id) => {
            if (canRead) selectCase(id, false);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-082 views: tabs with counts, and the cases in the chosen view.
// ---------------------------------------------------------------------------------------------------------

function CaseRegister({
  view,
  onView,
  selectedId,
  onSelect,
}: {
  view: TabView;
  onView: (view: TabView) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { can } = useSession();
  const keys = useKeys();
  const baseId = useId();
  const tabRefs = useRef(new Map<TabView, HTMLButtonElement>());
  // On the All tab both share one query (and one request).
  const all = useQuery({ queryKey: keys.cases('ALL'), queryFn: () => fetchCases('ALL'), retry: retryTransient });
  const list = useQuery({ queryKey: keys.cases(view), queryFn: () => fetchCases(view), retry: retryTransient });
  const counts = all.data ? countByView(all.data) : null;
  const tab = TABS.find((t) => t.view === view) ?? TABS[TABS.length - 1]!;
  // FR-093: the export holds this view's cases, with their planned and actual dates and decisions.
  const exportView = useMutation({ mutationFn: (chosen: TabView) => api<{ id: string }>('/v1/reports', { body: { reportCode: 'CONFIRMATION_DUE', filters: { view: chosen } } }) });

  const moveTab =(event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TABS.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1) : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[next]!.view;
    onView(target);
    tabRefs.current.get(target)?.focus();
  };

  return (
    <Section title="Confirmation cases">
      <p className="hint">
        Upcoming, due and overdue are worked out from the company business date. A passed due date never confirms anyone on its own. Extended lists the cases still open
        or under review whose probation was extended at least once; they also appear under their date view.
      </p>
      {can(DECIDE) && (
        <p className="hint">
          Recommendations waiting for your decision are in the <Link to="/tasks">Decision inbox</Link>.
        </p>
      )}
      <div role="tablist" aria-label="Confirmation views" className="row">
        {TABS.map((t, index) => {
          const selected = t.view === view;
          const count = counts?.[t.view];
          return (
            <button
              key={t.view}
              ref={(el) => {
                if (el) tabRefs.current.set(t.view, el);
                else tabRefs.current.delete(t.view);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.view}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              className={selected ? undefined : 'secondary'}
              onClick={() => onView(t.view)}
              onKeyDown={(event) => moveTab(event, index)}
            >
              {t.label}
              {count === undefined ? '' : ` (${count})`}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${view}`} style={PANEL}>
        {list.isPending && <p className="hint loading">Loading cases…</p>}
        {isForbidden(list.error) ? <NotPermitted>The selected role cannot view confirmation cases.</NotPermitted> : <ErrorNote error={list.error} />}
        {list.data && list.data.items.length === 0 && <Empty>{tab.empty}</Empty>}
        {list.data && list.data.items.length > 0 && <CaseTable items={list.data.items} showTiming={MIXED_TIMING.has(view)} selectedId={selectedId} onSelect={onSelect} />}
      </div>
      {can(EXPORT) && (
        <div className="row">
          <button type="button" className="secondary" disabled={exportView.isPending} onClick={() => exportView.mutate(view)}>
            Export this view
          </button>
          {exportView.isSuccess && exportView.variables === view && <p className="ok">Export requested. Download it from Reports when it is ready.</p>}
          <ErrorNote error={exportView.error} />
        </div>
      )}
    </Section>
  );
}

function CaseTable({
  items,
  showTiming,
  selectedId,
  onSelect,
}: {
  items: ConfirmationCase[];
  showTiming: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={SCROLL}>
      <table>
        <thead>
          <tr>
            <th scope="col">Employee</th>
            <th scope="col">Start</th>
            <th scope="col">Initial due</th>
            <th scope="col">Current due</th>
            <th scope="col">Extensions</th>
            <th scope="col">State</th>
            <th scope="col">Last outcome</th>
            <th scope="col">
              <span style={SR_ONLY}>Case</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => {
            const selected = c.id === selectedId;
            return (
              <tr key={c.id} aria-current={selected ? 'true' : undefined}>
                <td>
                  {c.employeeName} <span className="hint">{c.employeeCode}</span>
                </td>
                <td>{formatDate(c.startDate)}</td>
                <td>{formatDate(c.initialDueDate)}</td>
                <td>
                  {formatDate(c.dueDate)}
                  {showTiming && (
                    <>
                      {' '}
                      <TimingBadge view={c.view} />
                    </>
                  )}
                </td>
                <td>{c.extensionCount}</td>
                <td>
                  <StateBadge state={c.state} />
                </td>
                <td>{c.lastOutcome ? outcomeLabel(c.lastOutcome) : '—'}</td>
                <td>
                  <button type="button" className="link" id={viewButtonId(c.id)} aria-label={`View case of ${c.employeeName} (${c.employeeCode})`} onClick={() => onSelect(c.id)}>
                    View case
                  </button>
                  {selected && <span className="hint"> · shown below</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
