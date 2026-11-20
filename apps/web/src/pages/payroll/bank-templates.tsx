// Bank file templates (DB112; I-32): revisions, independent sample validation, activation and retirement.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { api, formatDate, readable, retryTransient } from '../../api';
import { FormProgress } from '../../form-progress';
import { useSession } from '../../session';
import { Badge, Empty, Section } from '../../ui';
import { Missing, Note } from './pickers';
import { type Act, Problem, ReasonForm, ROW_TEXT } from './problems';
import { Fact, FLUSH, GROUP, H3, label, SCROLL, Status, TEMPLATE_ACTIVATE, TEMPLATE_MANAGE, TEMPLATE_READ, TEMPLATE_VALIDATE, useKeys } from './shared';
import type { BankRowError, BankTemplate } from './types';

// =========================================================================================================
// Bank file templates (DB112; I-32): revisions, independent sample validation, activation, retirement
// =========================================================================================================

interface FieldSpecRow {
  source: string;
  value?: string;
  maxLength?: number;
}
interface FormatDefinition {
  layout: string;
  delimiter: string;
  lineEnding: string;
  amountDecimals: number;
  decimalSeparator: string;
  dateFormat: string;
  fileExtension: string;
  header?: FieldSpecRow[];
  detail: FieldSpecRow[];
  trailer?: FieldSpecRow[];
}
interface TemplateFull extends BankTemplate {
  formatDefinition: FormatDefinition;
  definitionHash: string;
  bankSpecificationReference: string;
  sampleHash: string | null;
  sampleValidationReference: string | null;
  sampleValidatedAt: string | null;
  activatedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}
interface TemplateSample {
  label: string;
  fileName: string;
  content: string;
  sampleHash: string;
  errors: BankRowError[];
}

const TEMPLATE_STATE: Record<string, string> = { DRAFT: 'Draft, not in use', ACTIVE: 'Active', RETIRED: 'Retired', CANCELLED: 'Cancelled' };
const DETAIL_SOURCES = ['LINE_SEQUENCE', 'ALLOCATION_KEY', 'EMPLOYEE_CODE', 'HOLDER_NAME', 'ACCOUNT_IDENTIFIER', 'ROUTING_REFERENCE', 'COUNTRY_CODE', 'AMOUNT', 'CURRENCY_CODE', 'PAYMENT_DATE', 'BATCH_REFERENCE', 'LITERAL'];
const CONTROL_SOURCES = ['BATCH_REFERENCE', 'RECORD_COUNT', 'TOTAL_AMOUNT', 'CURRENCY_CODE', 'PAYMENT_DATE', 'LITERAL'];
const SOURCE_LABEL: Record<string, string> = {
  LINE_SEQUENCE: 'Line number',
  ALLOCATION_KEY: 'Allocation key',
  EMPLOYEE_CODE: 'Employee code',
  HOLDER_NAME: 'Account holder name',
  ACCOUNT_IDENTIFIER: 'Account identifier',
  ROUTING_REFERENCE: 'Routing reference',
  COUNTRY_CODE: 'Country code',
  AMOUNT: 'Amount',
  CURRENCY_CODE: 'Currency code',
  PAYMENT_DATE: 'Payment date',
  BATCH_REFERENCE: 'Batch reference',
  RECORD_COUNT: 'Record count',
  TOTAL_AMOUNT: 'Total amount',
  LITERAL: 'Fixed text',
};
const DELIMITER_LABEL: Record<string, string> = { COMMA: 'Comma (,)', SEMICOLON: 'Semicolon (;)', PIPE: 'Pipe (|)', TAB: 'Tab' };
const DATE_FORMATS = ['YYYY-MM-DD', 'YYYYMMDD', 'DD-MM-YYYY', 'DDMMYYYY', 'DD/MM/YYYY'];

const fieldText = (f: FieldSpecRow) => `${label(SOURCE_LABEL, f.source)}${f.source === 'LITERAL' ? ` “${f.value ?? ''}”` : ''}${f.maxLength ? ` (at most ${f.maxLength} characters)` : ''}`;

export function TemplatesScreen() {
  const { can } = useSession();
  const [openId, setOpenId] = useState<string | null>(null);
  const [basis, setBasis] = useState<TemplateFull | null>(null);
  if (!can(TEMPLATE_READ)) {
    return (
      <Section title="Bank file templates">
        <Empty>The selected role cannot see bank file templates.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <TemplateList openId={openId} onOpen={setOpenId} />
      {openId && <TemplateView key={openId} id={openId} {...(can(TEMPLATE_MANAGE) ? { onRevise: setBasis } : {})} />}
      {can(TEMPLATE_MANAGE) && <TemplateForm key={basis?.id ?? 'new'} basis={basis} onClearBasis={() => setBasis(null)} />}
    </div>
  );
}

function TemplateList({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const keys = useKeys();
  const templates = useQuery({ queryKey: keys.templates, queryFn: () => api<{ items: TemplateFull[] }>('/v1/payroll-outputs/bank-templates'), retry: retryTransient });
  return (
    <Section title="Bank file templates">
      <p className="hint">
        A template is the company’s transcription of the bank’s accepted file specification as a delimited field mapping; no bank format is presumed. Its system-generated sample is validated, and the template activated, by people other than its author.
      </p>
      {templates.isPending && <p className="hint loading">Loading templates…</p>}
      {templates.error && <Problem error={templates.error} act="read" />}
      {templates.data && templates.data.items.length === 0 && <Empty>No bank file template yet.</Empty>}
      {templates.data && templates.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Bank file templates">
            <thead>
              <tr>
                <th>Template</th>
                <th>Name</th>
                <th>Currency</th>
                <th>Use</th>
                <th>State</th>
                <th>Sample validated</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {templates.data.items.map((t) => (
                <tr key={t.id}>
                  <td>{`${t.templateCode} version ${t.templateVersion}`}</td>
                  <td>{t.name}</td>
                  <td>{t.currencyCode}</td>
                  <td>{t.testOnly ? <Badge tone="warn">Test only: never for real payments</Badge> : 'Production'}</td>
                  <td>
                    <Status map={TEMPLATE_STATE} code={t.state} />
                  </td>
                  <td>{t.sampleHash ? formatDate(t.sampleValidatedAt) : 'Not yet'}</td>
                  <td>
                    <button type="button" className="link" onClick={() => onOpen(openId === t.id ? null : t.id)} aria-label={`Details of template ${t.templateCode} version ${t.templateVersion}`}>
                      {openId === t.id ? 'Hide' : 'Details'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function FieldList({ part, fields }: { part: string; fields: FieldSpecRow[] | undefined }) {
  if (!fields || fields.length === 0) return null;
  return (
    <>
      <h3 style={H3}>{`${part} record`}</h3>
      <ol aria-label={`${part} record fields`}>
        {fields.map((f, i) => (
          <li key={i}>{fieldText(f)}</li>
        ))}
      </ol>
    </>
  );
}

type TemplateAction = 'sample-validation' | 'activate' | 'retire';

function TemplateView({ id, onRevise }: { id: string; onRevise?: (t: TemplateFull) => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [showSample, setShowSample] = useState(false);
  const [validationReference, setValidationReference] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const template = useQuery({ queryKey: keys.template(id), queryFn: () => api<TemplateFull>(`/v1/payroll-outputs/bank-templates/${encodeURIComponent(id)}`), retry: retryTransient });
  const sample = useQuery({
    queryKey: keys.templateSample(id),
    queryFn: () => api<TemplateSample>(`/v1/payroll-outputs/bank-templates/${encodeURIComponent(id)}/sample`),
    enabled: showSample,
    retry: retryTransient,
  });
  const act = useMutation({
    mutationFn: ({ action, body }: { action: TemplateAction; body: Record<string, unknown> }) => api<TemplateFull>(`/v1/payroll-outputs/bank-templates/${encodeURIComponent(id)}/${action}`, { body }),
    onSuccess: (r, { action }) => {
      if (action === 'sample-validation') {
        setValidationReference('');
        setNote('The sample is recorded as validated against the bank’s specification. Someone other than the author can now activate the template.');
      } else if (action === 'activate') setNote(`Activated: ${r.templateCode} version ${r.templateVersion} is used for new manifests; an earlier active version of the same code is retired.`);
      else setNote(r.state === 'CANCELLED' ? 'The draft was cancelled.' : 'The template was retired: it is no longer used for new manifests.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.templates }),
  });
  const t = template.data;
  if (template.isPending) return <p className="hint loading">Loading the template…</p>;
  if (!t) return <Problem error={template.error} act="read" />;
  const author = t.createdBy === me?.userId;
  const def = t.formatDefinition;
  const s = sample.data;
  const failedAct: Act = act.variables?.action === 'sample-validation' ? 'template-validate' : act.variables?.action === 'activate' ? 'template-activate' : 'template';
  const validate = (e: FormEvent) => {
    e.preventDefault();
    if (act.isPending || !s || author) return;
    if (!validationReference.trim()) return setProblem('Give the validation reference (where the sample was checked against the bank’s specification).');
    setProblem(null);
    setNote(null);
    act.reset();
    act.mutate({ action: 'sample-validation', body: { sampleHash: s.sampleHash, validationReference: validationReference.trim(), expectedVersion: t.version } });
  };
  return (
    <Section title={`Template ${t.templateCode} version ${t.templateVersion}`}>
      <dl className="kv">
        <Fact term="Name">{t.name}</Fact>
        <Fact term="State">
          <Status map={TEMPLATE_STATE} code={t.state} />
        </Fact>
        <Fact term="Currency">{t.currencyCode}</Fact>
        <Fact term="Bank specification">{t.bankSpecificationReference}</Fact>
        <Fact term="Definition fingerprint">{t.definitionHash}</Fact>
        <Fact term="Sample validated">{t.sampleHash ? `${formatDate(t.sampleValidatedAt)} (${t.sampleValidationReference ?? ''})` : 'Not yet'}</Fact>
        <Fact term="Activated">{formatDate(t.activatedAt)}</Fact>
        {t.closeReason && <Fact term="Closed">{`${formatDate(t.closedAt)}: ${t.closeReason}`}</Fact>}
      </dl>
      {t.testOnly && (
        <p role="note" className="hint">
          This is a test-only template: it is refused in production, so it is never used for real payments.
        </p>
      )}
      <dl className="kv" aria-label="Layout">
        <Fact term="Layout">Delimited</Fact>
        <Fact term="Delimiter">{label(DELIMITER_LABEL, def.delimiter)}</Fact>
        <Fact term="Line ending">{def.lineEnding}</Fact>
        <Fact term="Amount decimals">{def.amountDecimals}</Fact>
        <Fact term="Decimal separator">{def.decimalSeparator}</Fact>
        <Fact term="Date format">{def.dateFormat}</Fact>
        <Fact term="File extension">{def.fileExtension}</Fact>
      </dl>
      <FieldList part="Header" fields={def.header} />
      <FieldList part="Detail" fields={def.detail} />
      <FieldList part="Trailer" fields={def.trailer} />
      <div className="row">
        <button type="button" className="secondary" onClick={() => setShowSample(!showSample)}>
          {showSample ? 'Hide the sample file' : 'Show the sample file'}
        </button>
        {onRevise && (
          <button type="button" className="secondary" onClick={() => onRevise(t)}>
            Start a new version from this one
          </button>
        )}
      </div>
      {showSample && sample.isPending && <p className="hint">Generating the sample…</p>}
      {showSample && sample.error && <Problem error={sample.error} act="read" />}
      {showSample && s && (
        <div role="region" aria-label="Sample file">
          <p style={FLUSH}>
            <Badge tone="warn">{s.label === 'SAMPLE_NOT_PAYABLE' ? 'Sample: not payable' : readable(s.label)}</Badge> {s.fileName}
          </p>
          <pre style={SCROLL}>{s.content}</pre>
          <p className="hint">{`Sample fingerprint (SHA-256): ${s.sampleHash}`}</p>
          {s.errors.length > 0 && (
            <ul aria-label="Sample problems">
              {s.errors.map((x, i) => (
                <li key={i}>{`${label(ROW_TEXT, x.code)}${x.source ? ` (${label(SOURCE_LABEL, x.source)})` : ''}`}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {can(TEMPLATE_VALIDATE) && t.state === 'DRAFT' && !t.sampleHash && (
        <form onSubmit={validate} aria-label="Validate the sample" className="grid-form" style={{ marginTop: '0.5rem' }}>
          {author ? (
            <p className="hint wide">You wrote this template, so someone else validates its sample.</p>
          ) : !s ? (
            <p className="hint wide">Show the sample file first and compare it with the bank’s specification.</p>
          ) : null}
          <label>
            Validation reference
            <input value={validationReference} onChange={(e) => setValidationReference(e.target.value)} maxLength={500} autoComplete="off" />
          </label>
          <div className="row">
            <button type="submit" disabled={act.isPending || author || !s || s.errors.length > 0}>
              Record the sample as validated
            </button>
          </div>
          <Missing text={problem} />
        </form>
      )}
      {can(TEMPLATE_ACTIVATE) && t.state === 'DRAFT' && (
        <div style={{ marginTop: '0.5rem' }}>
          <button
            type="button"
            disabled={act.isPending || author || !t.sampleHash}
            onClick={() => {
              setNote(null);
              act.reset();
              act.mutate({ action: 'activate', body: { expectedVersion: t.version } });
            }}
          >
            Activate this template
          </button>
          {!t.sampleHash && <p className="hint">A template is activated only after an independent sample validation.</p>}
          {author && <p className="hint">You wrote this template, so someone else activates it.</p>}
        </div>
      )}
      {can(TEMPLATE_MANAGE) && (t.state === 'ACTIVE' || t.state === 'DRAFT') && (
        <ReasonForm
          name={t.state === 'ACTIVE' ? 'Retire this template' : 'Cancel this draft template'}
          field={t.state === 'ACTIVE' ? 'Why the template is retired' : 'Why the draft is cancelled'}
          button={t.state === 'ACTIVE' ? 'Retire this template' : 'Cancel this draft'}
          busy={act.isPending}
          danger
          onSend={(reason) => {
            setNote(null);
            return act.mutateAsync({ action: 'retire', body: { reason, expectedVersion: t.version } });
          }}
        />
      )}
      <Note text={note} />
      <Problem error={act.error} act={failedAct} />
    </Section>
  );
}

interface FieldDraft {
  key: number;
  source: string;
  value: string;
  maxLength: string;
}

function FieldListEditor({ part, sources, fields, onChange, newKey }: { part: string; sources: string[]; fields: FieldDraft[]; onChange: (f: FieldDraft[]) => void; newKey: () => number }) {
  const set = (i: number, patch: Partial<FieldDraft>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) => {
    const next = [...fields];
    const [f] = next.splice(i, 1);
    if (f) next.splice(i + by, 0, f);
    onChange(next);
  };
  return (
    <fieldset style={GROUP} className="wide">
      <legend>{`${part} record: fields in file order`}</legend>
      {fields.length === 0 && <p className="hint">No fields yet.</p>}
      {fields.map((f, i) => (
        <div key={f.key} className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label>
            {`${part} field ${i + 1}`}
            <select value={f.source} onChange={(e) => set(i, { source: e.target.value })}>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {label(SOURCE_LABEL, s)}
                </option>
              ))}
            </select>
          </label>
          {f.source === 'LITERAL' && (
            <label>
              {`${part} field ${i + 1} text`}
              <input value={f.value} onChange={(e) => set(i, { value: e.target.value })} maxLength={100} autoComplete="off" />
            </label>
          )}
          <label>
            {`${part} field ${i + 1} maximum length`}
            <input value={f.maxLength} onChange={(e) => set(i, { maxLength: e.target.value })} inputMode="numeric" maxLength={3} />
          </label>
          <button type="button" className="secondary" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${part.toLowerCase()} field ${i + 1} up`}>
            Up
          </button>
          <button type="button" className="secondary" disabled={i === fields.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${part.toLowerCase()} field ${i + 1} down`}>
            Down
          </button>
          <button type="button" className="secondary" onClick={() => onChange(fields.filter((_, j) => j !== i))} aria-label={`Remove ${part.toLowerCase()} field ${i + 1}`}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="secondary" onClick={() => onChange([...fields, { key: newKey(), source: sources[0] ?? 'LITERAL', value: '', maxLength: '' }])}>
        {`Add a ${part.toLowerCase()} field`}
      </button>
    </fieldset>
  );
}

/**
 * The template form's required fields, by their labels, for its steps (form-progress.tsx): the form's own check (submit below)
 * refuses a template without its code, name, currency or bank specification reference, and the format is always sent.
 */
const TEMPLATE_REQUIRED = ['Template code', 'Template name', 'Currency', 'Bank specification reference', 'Delimiter', 'Line ending', 'Amount decimals', 'Decimal separator', 'Date format', 'File extension'];

function TemplateForm({ basis, onClearBasis }: { basis: TemplateFull | null; onClearBasis: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const seq = useRef(0);
  const newKey = () => ++seq.current;
  const drafts = (list: FieldSpecRow[] | undefined) => (list ?? []).map((f) => ({ key: newKey(), source: f.source, value: f.value ?? '', maxLength: f.maxLength ? String(f.maxLength) : '' }));
  const initial = () => {
    const d = basis?.formatDefinition;
    return {
      templateCode: basis?.templateCode ?? '',
      name: basis?.name ?? '',
      currencyCode: basis?.currencyCode ?? '',
      spec: basis?.bankSpecificationReference ?? '',
      testOnly: basis?.testOnly ?? false,
      delimiter: d?.delimiter ?? 'COMMA',
      lineEnding: d?.lineEnding ?? 'CRLF',
      decimals: String(d?.amountDecimals ?? 2),
      separator: d?.decimalSeparator ?? '.',
      dateFormat: d?.dateFormat ?? 'YYYY-MM-DD',
      extension: d?.fileExtension ?? 'csv',
      header: d?.header ? drafts(d.header) : null,
      detail: drafts(d?.detail),
      trailer: d?.trailer ? drafts(d.trailer) : null,
    };
  };
  const [f, setF] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = (patch: Partial<ReturnType<typeof initial>>) => setF((prev) => ({ ...prev, ...patch }));
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<TemplateFull>('/v1/payroll-outputs/bank-templates', { body }),
    onSuccess: (t) => {
      setF({ ...initial(), templateCode: '', name: '', currencyCode: '', spec: '', testOnly: false, header: null, detail: [], trailer: null });
      setNote(`Template ${t.templateCode} version ${t.templateVersion} saved as a draft. Someone other than you validates its sample against the bank’s specification; then someone other than you activates it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.templates }),
  });
  const out = (list: FieldDraft[]) =>
    list.map((x) => ({ source: x.source, ...(x.source === 'LITERAL' ? { value: x.value } : {}), ...(x.maxLength.trim() ? { maxLength: Number(x.maxLength.trim()) } : {}) }));
  const lengthOk = (list: FieldDraft[]) => list.every((x) => !x.maxLength.trim() || (/^\d{1,3}$/.test(x.maxLength.trim()) && Number(x.maxLength) >= 1 && Number(x.maxLength) <= 500));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const code = f.templateCode.trim().toUpperCase();
    const currency = f.currencyCode.trim().toUpperCase();
    if (!code || !f.name.trim() || !f.spec.trim()) return setProblem('Give the template code, the name and the bank specification reference.');
    if (!/^[A-Z]{3}$/.test(currency)) return setProblem('The currency is a three-letter ISO code.');
    const sources = f.detail.map((x) => x.source);
    if (!sources.includes('AMOUNT') || !sources.includes('ACCOUNT_IDENTIFIER')) return setProblem('The detail record must carry the amount and the account identifier.');
    const all = [...f.detail, ...(f.header ?? []), ...(f.trailer ?? [])];
    if (all.some((x) => x.source === 'LITERAL' && !x.value)) return setProblem('Every fixed-text field needs its text.');
    if (!lengthOk(all)) return setProblem('A maximum length is 1 to 500 characters.');
    if ((f.header && f.header.length === 0) || (f.trailer && f.trailer.length === 0)) return setProblem('A header or trailer record needs at least one field (or untick it).');
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({
      templateCode: code,
      name: f.name.trim(),
      currencyCode: currency,
      bankSpecificationReference: f.spec.trim(),
      testOnly: f.testOnly,
      formatDefinition: {
        layout: 'DELIMITED',
        delimiter: f.delimiter,
        lineEnding: f.lineEnding,
        amountDecimals: Number(f.decimals),
        decimalSeparator: f.separator,
        dateFormat: f.dateFormat,
        fileExtension: f.extension,
        ...(f.header ? { header: out(f.header) } : {}),
        detail: out(f.detail),
        ...(f.trailer ? { trailer: out(f.trailer) } : {}),
      },
    });
  };
  // The fields keep their order, labels and checks; they are only grouped, and the steps above the form follow the groups. This form
  // checks its required fields in code (submit above), so the steps are told which they are.
  return (
    <>
      <FormProgress form={formRef} label="Bank file template" required={TEMPLATE_REQUIRED} />
      <Section title={basis ? `New version of ${basis.templateCode}` : 'New bank file template'}>
        <p className="hint">Saving the same template code again creates its next version. Transcribe the bank’s accepted specification exactly: values are never shortened or changed to fit, and a row that does not fit stops the whole file.</p>
        {basis && (
          <button type="button" className="secondary" onClick={onClearBasis}>
            Start from an empty template instead
          </button>
        )}
        <form ref={formRef} onSubmit={submit} aria-label="Bank file template" className="grid-form">
          <fieldset className="form-step">
            <legend>The template</legend>
            <label>
              Template code
              <input value={f.templateCode} onChange={(e) => set({ templateCode: e.target.value })} maxLength={40} autoComplete="off" />
            </label>
            <label>
              Template name
              <input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} autoComplete="off" />
            </label>
            <label>
              Currency
              <input value={f.currencyCode} onChange={(e) => set({ currencyCode: e.target.value })} maxLength={3} autoComplete="off" />
            </label>
            <label>
              Bank specification reference
              <input value={f.spec} onChange={(e) => set({ spec: e.target.value })} maxLength={500} autoComplete="off" />
            </label>
            <label className="check wide">
              <input type="checkbox" checked={f.testOnly} onChange={(e) => set({ testOnly: e.target.checked })} /> Test only (synthetic; refused in production)
            </label>
          </fieldset>
          <fieldset className="form-step">
            <legend>File format</legend>
            <label>
              Delimiter
              <select value={f.delimiter} onChange={(e) => set({ delimiter: e.target.value })}>
                {Object.entries(DELIMITER_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Line ending
              <select value={f.lineEnding} onChange={(e) => set({ lineEnding: e.target.value })}>
                <option value="CRLF">CRLF</option>
                <option value="LF">LF</option>
              </select>
            </label>
            <label>
              Amount decimals
              <select value={f.decimals} onChange={(e) => set({ decimals: e.target.value })}>
                {['0', '1', '2', '3', '4'].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Decimal separator
              <select value={f.separator} onChange={(e) => set({ separator: e.target.value })}>
                <option value=".">Point (.)</option>
                <option value=",">Comma (,)</option>
              </select>
            </label>
            <label>
              Date format
              <select value={f.dateFormat} onChange={(e) => set({ dateFormat: e.target.value })}>
                {DATE_FORMATS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label>
              File extension
              <select value={f.extension} onChange={(e) => set({ extension: e.target.value })}>
                <option value="csv">csv</option>
                <option value="txt">txt</option>
              </select>
            </label>
          </fieldset>
          <fieldset className="form-step">
            <legend>Records and their fields</legend>
            <label className="check wide">
              <input type="checkbox" checked={f.header !== null} onChange={(e) => set({ header: e.target.checked ? (f.header ?? []) : null })} /> Header record
            </label>
            {f.header !== null && <FieldListEditor part="Header" sources={CONTROL_SOURCES} fields={f.header} onChange={(header) => set({ header })} newKey={newKey} />}
            <FieldListEditor part="Detail" sources={DETAIL_SOURCES} fields={f.detail} onChange={(detail) => set({ detail })} newKey={newKey} />
            <label className="check wide">
              <input type="checkbox" checked={f.trailer !== null} onChange={(e) => set({ trailer: e.target.checked ? (f.trailer ?? []) : null })} /> Trailer record
            </label>
            {f.trailer !== null && <FieldListEditor part="Trailer" sources={CONTROL_SOURCES} fields={f.trailer} onChange={(trailer) => set({ trailer })} newKey={newKey} />}
          </fieldset>
          <div className="row">
            <button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Save as a draft version'}
            </button>
          </div>
          <Missing text={problem} />
          <div className="wide">
            <Note text={note} />
            <Problem error={create.error} act="template" />
          </div>
        </form>
      </Section>
    </>
  );
}
