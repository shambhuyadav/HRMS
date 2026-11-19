// Settlements (FR-052 to FR-054, BR-016): the register, selection and archive download, and preparation from an approved exit.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, fileToBase64, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, LIST_PAGE_SIZE, nextSort, NotPermitted, Pager, Section, SortHeader, sortParams, type SortState } from '../../ui';
import { TemplateDownload } from '../records';
import { archiveWords, Refusal } from './refusals';
import { SettlementBulkUpload } from './settlement-bulk-upload';
import { SettlementApprovalQueue, SettlementReviewQueue } from './settlement-queues';
import { CalculationNote, EXIT_READ, EXIT_STATE_LABEL, EXPORT_FORMATS, EXPORTABLE_STATES, type ExportFormat, labelOf, LoadProblem, MAX_ARCHIVE, MAX_EMPLOYEE_CODE, Money, MONTH, type Paged, pagedUrl, PATHS, SCROLL, SETTLEMENT_APPROVE, SETTLEMENT_EXPORT, SETTLEMENT_PREPARE, SETTLEMENT_READ, SETTLEMENT_REVIEW, SETTLEMENT_STATES, settlementLabel, SettlementState, SR_ONLY, totalOf, useKeys } from './shared';
import type { Calculation, ExitCase, SettlementSummary } from './types';

// =========================================================================================================
// Settlements (FR-052 to FR-054, BR-016): the register, the decision queues and preparation from an approved exit
// =========================================================================================================
export function SettlementsScreen() {
  const { can, stored } = useSession();
  // A selection made under one role assignment is never carried to another.
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return (
    <>
      <h1>Full and final settlements</h1>
      {can(SETTLEMENT_READ) ? (
        <SettlementRegister key={`register:${context}`} />
      ) : (
        <Section title="Settlements">
          <NotPermitted>The selected role cannot view settlements.</NotPermitted>
        </Section>
      )}
      {can(SETTLEMENT_REVIEW) && <SettlementReviewQueue />}
      {can(SETTLEMENT_APPROVE) && <SettlementApprovalQueue />}
      {can(SETTLEMENT_PREPARE) && <PrepareFromExit />}
      {can(SETTLEMENT_PREPARE) && <SettlementBulkUpload key={`upload:${context}`} />}
    </>
  );
}

interface SettlementList extends Paged<SettlementSummary> {
  calculation: Calculation;
}

/** The columns GET /v1/settlements sorts by that the list shows (settlement.ts); never the net amount (DF02). */
type SettlementSort = 'employeeName' | 'revision' | 'state';

/** A settlement chosen for the ZIP download, with the words that name it if the server refuses it. */
interface Selected {
  id: string;
  name: string;
}

function SettlementRegister() {
  const keys = useKeys();
  const { can } = useSession();
  // FR-054 "uploaded-list selection": the outputs carry amounts, so only a role holding the export grant selects.
  const selectable = can(SETTLEMENT_EXPORT);
  const [state, setState] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  const [month, setMonth] = useState('');
  // FR-054 disbursement month (CL-241; I-81 item 2): the month of the recorded payment date.
  const [disbursement, setDisbursement] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  // Kept while paging (in the order chosen); new filters start a new selection.
  const [selected, setSelected] = useState<Selected[]>([]);
  const [sort, setSort] = useState<SortState<SettlementSort>>(null);
  const onSort = (column: SettlementSort) => {
    setSort((current) => nextSort(current, column));
    setPage(1);
  };
  const ordered = [query, new URLSearchParams(sortParams(sort)).toString()].filter(Boolean).join('&');
  const list = useQuery({
    queryKey: keys.settlementList(`${ordered}#${page}`),
    queryFn: () => api<SettlementList>(pagedUrl('/v1/settlements', page, ordered)),
    retry: retryTransient,
  });
  const apply = (event: FormEvent) => {
    event.preventDefault();
    const codeText = employeeCode.trim();
    const missing = (month !== '' && !MONTH.test(month)) || (disbursement !== '' && !MONTH.test(disbursement)) ? 'Enter the month as YYYY-MM.' : null;
    setProblem(missing);
    if (missing !== null) return;
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (codeText) params.set('employeeCode', codeText);
    if (month) params.set('lastWorkingMonth', month);
    if (disbursement) params.set('disbursementMonth', disbursement);
    setQuery(params.toString());
    setPage(1);
    setSelected([]);
  };
  const clear = () => {
    setState('');
    setEmployeeCode('');
    setMonth('');
    setDisbursement('');
    setProblem(null);
    setQuery('');
    setPage(1);
    setSelected([]);
  };
  const items = list.data?.items ?? [];
  const withAmounts = items.some((s) => typeof s.netAmount === 'string');
  const nameOf = (s: SettlementSummary) => `${s.employeeName} (${s.employeeCode}), revision ${s.revision}`;
  const isSelected = (id: string) => selected.some((x) => x.id === id);
  const toggle = (s: SettlementSummary, on: boolean) =>
    setSelected((now) => (on ? (now.some((x) => x.id === s.id) || now.length >= MAX_ARCHIVE ? now : [...now, { id: s.id, name: nameOf(s) }]) : now.filter((x) => x.id !== s.id)));
  const exportable = selectable ? items.filter((s) => EXPORTABLE_STATES.has(s.state)) : [];
  const selectPage = () =>
    setSelected((now) => {
      const next = [...now];
      for (const s of exportable) if (next.length < MAX_ARCHIVE && !next.some((x) => x.id === s.id)) next.push({ id: s.id, name: nameOf(s) });
      return next;
    });
  return (
    <Section title="Settlements">
      <CalculationNote calculation={list.data?.calculation} />
      <form className="grid-form" aria-label="Filter settlements" onSubmit={apply}>
        <label>
          State
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All states</option>
            {SETTLEMENT_STATES.map((s) => (
              <option key={s} value={s}>
                {settlementLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Employee code contains
          <input value={employeeCode} maxLength={MAX_EMPLOYEE_CODE} onChange={(e) => setEmployeeCode(e.target.value)} />
        </label>
        <label title="The month of the approved last working date">
          Last working month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <label title="The month of the recorded payment date">
          Paid in month
          <input type="month" value={disbursement} onChange={(e) => setDisbursement(e.target.value)} />
        </label>
        <div className="row filter-actions">
          <button type="submit">Show settlements</button>
          <button type="button" className="secondary" onClick={clear}>
            Clear filters
          </button>
        </div>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
      </form>
      {list.isPending && <p className="hint loading">Loading the settlements…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view settlements." />
      {list.data && items.length === 0 && <Empty>{query ? 'No settlements match these filters.' : 'No settlements in the selected role’s scope yet.'}</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Settlements">
            <thead>
              <tr>
                {selectable && <th scope="col">Select</th>}
                <SortHeader column="employeeName" label="Employee" sort={sort} onSort={onSort} />
                <SortHeader column="revision" label="Revision" sort={sort} onSort={onSort} />
                <SortHeader column="state" label="State" sort={sort} onSort={onSort} />
                <th scope="col">Currency</th>
                {withAmounts && <th scope="col">Net amount</th>}
                <th scope="col">
                  <span style={SR_ONLY}>Settlement</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  {selectable && (
                    <td>
                      {EXPORTABLE_STATES.has(s.state) ? (
                        <input
                          type="checkbox"
                          aria-label={`Select revision ${s.revision} of ${s.employeeName} (${s.employeeCode}) for the ZIP download`}
                          checked={isSelected(s.id)}
                          disabled={!isSelected(s.id) && selected.length >= MAX_ARCHIVE}
                          onChange={(e) => toggle(s, e.target.checked)}
                        />
                      ) : (
                        <span className="hint" title="Only an approved settlement, or one eligible for release, is exported">
                          —
                        </span>
                      )}
                    </td>
                  )}
                  <td>
                    {s.employeeName} <span className="hint">{s.employeeCode}</span>
                  </td>
                  <td>{s.revision}</td>
                  <td>
                    <SettlementState state={s.state} />
                  </td>
                  <td>{s.currencyCode}</td>
                  {withAmounts && (
                    <td>
                      <Money value={s.netAmount} currency={s.currencyCode} />
                    </td>
                  )}
                  <td>
                    <Link to={PATHS.settlement(s.id)} aria-label={`Open revision ${s.revision} of ${s.employeeName} (${s.employeeCode})`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(list.data)} onPage={setPage} label="Settlement pages" noun="settlement" />}
      {selectable && <ArchiveDownload selected={selected} canSelectPage={exportable.some((s) => !isSelected(s.id))} onSelectPage={selectPage} onClear={() => setSelected([])} />}
      {selectable && (
        <UploadedListSelection
          filters={{ state, lastWorkingMonth: month, disbursementMonth: disbursement }}
          onMatched={(found) =>
            setSelected((now) => {
              const next = [...now];
              for (const s of found) if (EXPORTABLE_STATES.has(s.state) && next.length < MAX_ARCHIVE && !next.some((x) => x.id === s.id)) next.push({ id: s.id, name: nameOf(s) });
              return next;
            })
          }
        />
      )}
    </Section>
  );
}

const SELECTION_OUTCOME_LABEL: Record<string, string> = {
  MATCHED: 'Matched',
  NO_SETTLEMENT: 'No settlement passes the filters',
  NOT_FOUND: 'No employee with this code in the selected role’s scope',
  DUPLICATE: 'Repeated: counted once',
  INVALID_CODE: 'Not one employee code',
};

interface SelectionRow {
  row: number;
  employeeCode: string | null;
  outcome: string;
  settlements: number;
}

/**
 * FR-054 "optional uploaded-list selection" (CL-243; I-81 item 7): a CSV with the single column employee_code selects the
 * settlements of those employees, matched exactly (case and spaces ignored), with the list's filters; each row's outcome is shown
 * and the exportable matches join the ZIP selection. The file is scanned and never stored.
 */
function UploadedListSelection({ filters, onMatched }: { filters: Record<string, string>; onMatched: (found: SettlementSummary[]) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const select = useMutation({
    mutationFn: async (f: File) => {
      const body: Record<string, string> = { contentBase64: await fileToBase64(f) };
      for (const [k, v] of Object.entries(filters)) if (v) body[k] = v;
      return api<{ rows: SelectionRow[]; total: number; matched: number; items: SettlementSummary[] }>('/v1/settlements/selection', { body });
    },
    onSuccess: (result) => onMatched(result.items),
  });
  return (
    <div className="stack" role="group" aria-label="Select settlements from an uploaded list">
      <p className="hint">
        Or select from a list: a CSV file with the single column <code>employee_code</code> (template SETTLEMENT_SELECTION_V1). Codes match exactly; the settlements
        of the matched employees that can be exported join the ZIP selection.
      </p>
      <TemplateDownload base="/v1/settlements/selection" code="SETTLEMENT_SELECTION_V1" />
      <div className="row">
        <label>
          Employee list file
          <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button type="button" disabled={!file || select.isPending} onClick={() => file && select.mutate(file)}>
          Select from the list
        </button>
      </div>
      <ErrorNote error={select.error} />
      {select.data && (
        <>
          <p role="status">{`${select.data.matched} of ${select.data.total} rows matched; ${select.data.items.length} settlements found.`}</p>
          <table aria-label="Uploaded list rows">
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Employee code</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {select.data.rows.map((r) => (
                <tr key={r.row}>
                  <td>{r.row}</td>
                  <td>{r.employeeCode ?? '—'}</td>
                  <td>{`${labelOf(SELECTION_OUTCOME_LABEL, r.outcome)}${r.outcome === 'MATCHED' ? ` (${r.settlements})` : ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/**
 * FR-054 ZIP output (CL-247): one archive holding each selected settlement's file in the chosen format, built when it
 * is downloaded (the server checks every one again and refuses the whole archive if one is not available); nothing is
 * stored or sent.
 */
function ArchiveDownload({ selected, canSelectPage, onSelectPage, onClear }: { selected: Selected[]; canSelectPage: boolean; onSelectPage: () => void; onClear: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('CSV');
  const zip = useMutation({
    mutationFn: (input: { ids: string[]; format: ExportFormat }) => download(`/v1/settlements/export-archive?${new URLSearchParams({ ids: input.ids.join(','), format: input.format })}`),
  });
  const names = new Map(selected.map((s) => [s.id, s.name]));
  return (
    <div className="stack" role="group" aria-label="ZIP download of the selected settlements">
      <p className="hint">
        Select approved settlements, or ones eligible for release, on any page of the list (at most {MAX_ARCHIVE}) and download one ZIP holding each one’s export in
        the chosen format. It is built when you download it; it is not stored and nothing is sent.
      </p>
      <div className="row">
        <span role="status">{selected.length === 0 ? 'No settlement selected.' : `${selected.length} of at most ${MAX_ARCHIVE} selected.`}</span>
        <button type="button" className="secondary" disabled={!canSelectPage || selected.length >= MAX_ARCHIVE} onClick={onSelectPage}>
          Select the exportable settlements on this page
        </button>
        <button type="button" className="secondary" disabled={selected.length === 0} onClick={onClear}>
          Clear the selection
        </button>
      </div>
      <div className="row">
        <label>
          File format in the ZIP
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            {EXPORT_FORMATS.map(([f, label]) => (
              <option key={f} value={f}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={selected.length === 0 || zip.isPending} onClick={() => zip.mutate({ ids: selected.map((s) => s.id), format })}>
          Download the ZIP of the selected settlements
        </button>
      </div>
      <Refusal error={zip.error} words={archiveWords(names)} />
    </div>
  );
}

/** A settlement is prepared for an approved (or separated) exit: pick it here, or open its settlements from the exit. */
function PrepareFromExit() {
  const { can } = useSession();
  if (!can(EXIT_READ)) {
    return (
      <Section title="Prepare a settlement">
        <p className="hint">A settlement is prepared for an approved exit. The selected role cannot list exits; open the exit’s settlements from the exit case.</p>
      </Section>
    );
  }
  return <ApprovedExits />;
}

function ApprovedExits() {
  const keys = useKeys();
  const [state, setState] = useState<'APPROVED' | 'SEPARATED'>('APPROVED');
  const [page, setPage] = useState(1);
  const exits = useQuery({
    queryKey: keys.exits(`${state}#${page}`),
    queryFn: () => api<Paged<ExitCase>>(pagedUrl('/v1/exit-cases', page, new URLSearchParams({ state }).toString())),
    retry: retryTransient,
  });
  const items = exits.data?.items ?? [];
  return (
    <Section title="Prepare a settlement">
      <p className="hint">A settlement is prepared for an approved exit. Open the exit’s settlements to prepare a revision or to see the revisions so far.</p>
      <label className="inline">
        Exit state{' '}
        <select
          value={state}
          onChange={(e) => {
            setState(e.target.value === 'SEPARATED' ? 'SEPARATED' : 'APPROVED');
            setPage(1);
          }}
        >
          <option value="APPROVED">Approved</option>
          <option value="SEPARATED">Separated</option>
        </select>
      </label>
      {exits.isPending && <p className="hint loading">Loading the exits…</p>}
      <LoadProblem error={exits.error} forbidden="The selected role cannot list exits." />
      {exits.data && items.length === 0 && <Empty>{state === 'APPROVED' ? 'No approved exits in the selected role’s scope.' : 'No separated exits in the selected role’s scope.'}</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Exits">
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Exit</th>
                <th scope="col">Approved last working date</th>
                <th scope="col">Notice period</th>
                <th scope="col">
                  <span style={SR_ONLY}>Settlements</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.id}>
                  <td>
                    {x.employeeName} <span className="hint">{x.employeeCode}</span>
                  </td>
                  <td>{labelOf(EXIT_STATE_LABEL, x.state)}</td>
                  <td>{formatDate(x.approvedLastWorkingDate)}</td>
                  <td>
                    <NoticePeriod notice={x.noticePeriod} />
                  </td>
                  <td>
                    <Link to={PATHS.exitSettlements(x.id)} aria-label={`Settlements of ${x.employeeName} (${x.employeeCode})`}>
                      Settlements
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {exits.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(exits.data)} onPage={setPage} label="Exit pages" noun="exit" />}
    </Section>
  );
}

/** F1: the recorded contractual notice period; a notice adjustment line needs it. */
export function NoticePeriod({ notice }: { notice: ExitCase['noticePeriod'] | undefined }) {
  if (!notice) return <>—</>;
  if (notice.status === 'RECORDED' && typeof notice.contractualNoticeDays === 'number') return <>{notice.contractualNoticeDays} days (recorded)</>;
  return <>Not recorded: no notice adjustment line until it is</>;
}

