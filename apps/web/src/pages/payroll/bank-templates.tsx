// Bank file templates (DB112; I-32): revisions, independent sample validation, activation and retirement.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, FormField, FormGrid, FormStep } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, readable, retryTransient } from '../../api';
import { FormProgress } from '../../form-progress';
import { useSession } from '../../session';
import { Badge, Empty, Section } from '../../ui';
import { Missing, Note } from './pickers';
import { type Act, Problem, ReasonForm, ROW_TEXT } from './problems';
import { Fact, label, Status, TEMPLATE_ACTIVATE, TEMPLATE_MANAGE, TEMPLATE_READ, TEMPLATE_VALIDATE, useKeys } from './shared';
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

/** The sample file exactly as generated: its lines kept whole in a quiet box that scrolls sideways when a line is long. */
const SAMPLE_FILE = 'overflow-x-auto rounded-md border border-border bg-muted p-3 text-[0.8rem]';
/** One field of a record being edited: its choices side by side with its move and remove buttons, their bottoms lined up. */
const FIELD_ROW = 'flex flex-wrap items-end gap-2';

const fieldText = (f: FieldSpecRow) => `${label(SOURCE_LABEL, f.source)}${f.source === 'LITERAL' ? ` “${f.value ?? ''}”` : ''}${f.maxLength ? ` (at most ${f.maxLength} characters)` : ''}`;

export function TemplatesScreen() {
  const { can } = useSession();
  const [openId, setOpenId] = useState<string | null>(null);
  const [basis, setBasis] = useState<TemplateFull | null>(null);
  if (!can(TEMPLATE_READ)) {
    return (
      <Section title="Bank file templates">
        <Empty refusal>The selected role cannot see bank file templates.</Empty>
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
      <Hint>
        A template is the company’s transcription of the bank’s accepted file specification as a delimited field mapping; no bank format is presumed. Its system-generated sample is validated, and the template activated, by people other than its author.
      </Hint>
      {templates.isPending && <LoadingLine>Loading templates…</LoadingLine>}
      {templates.error && <Problem error={templates.error} act="read" />}
      {templates.data && templates.data.items.length === 0 && <Empty>No bank file template yet.</Empty>}
      {templates.data && templates.data.items.length > 0 && (
        <Table aria-label="Bank file templates">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Template</TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Currency</TableHead>
              <TableHead scope="col">Use</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Sample validated</TableHead>
              <TableHead scope="col">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.data.items.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{`${t.templateCode} version ${t.templateVersion}`}</TableCell>
                <TableCell>{t.name}</TableCell>
                <TableCell>{t.currencyCode}</TableCell>
                <TableCell>{t.testOnly ? <Badge tone="warn">Test only: never for real payments</Badge> : 'Production'}</TableCell>
                <TableCell>
                  <Status map={TEMPLATE_STATE} code={t.state} />
                </TableCell>
                <TableCell>{t.sampleHash ? formatDate(t.sampleValidatedAt) : 'Not yet'}</TableCell>
                <RowActionsCell>
                  <RowActions>
                    <Button type="button" variant="outline" size="sm" onClick={() => onOpen(openId === t.id ? null : t.id)} aria-label={`Details of template ${t.templateCode} version ${t.templateVersion}`}>
                      {openId === t.id ? 'Hide' : 'Details'}
                    </Button>
                  </RowActions>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function FieldList({ part, fields }: { part: string; fields: FieldSpecRow[] | undefined }) {
  if (!fields || fields.length === 0) return null;
  return (
    <>
      <CardSubheading>{`${part} record`}</CardSubheading>
      <ol aria-label={`${part} record fields`}>
        {fields.map((f, i) => (
          <li key={i}>{fieldText(f)}</li>
        ))}
      </ol>
    </>
  );
}

type TemplateAction = 'sample-validation' | 'activate' | 'retire';

/** Which refusals explain a failed template action: the sample validation and the activation have their own. */
function failedAct(action: TemplateAction | undefined): Act {
  if (action === 'sample-validation') return 'template-validate';
  return action === 'activate' ? 'template-activate' : 'template';
}

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
  if (template.isPending) return <LoadingLine>Loading the template…</LoadingLine>;
  if (!t) return <Problem error={template.error} act="read" />;
  const author = t.createdBy === me?.userId;
  const def = t.formatDefinition;
  const s = sample.data;
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
      {t.testOnly && <Hint role="note">This is a test-only template: it is refused in production, so it is never used for real payments.</Hint>}
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
      <ButtonRow>
        <Button type="button" variant="outline" onClick={() => setShowSample(!showSample)}>
          {showSample ? 'Hide the sample file' : 'Show the sample file'}
        </Button>
        {onRevise && (
          <Button type="button" variant="outline" onClick={() => onRevise(t)}>
            Start a new version from this one
          </Button>
        )}
      </ButtonRow>
      {showSample && sample.isPending && <Hint>Generating the sample…</Hint>}
      {showSample && sample.error && <Problem error={sample.error} act="read" />}
      {showSample && s && (
        <div role="region" aria-label="Sample file">
          <p className="my-1">
            <Badge tone="warn">{s.label === 'SAMPLE_NOT_PAYABLE' ? 'Sample: not payable' : readable(s.label)}</Badge> {s.fileName}
          </p>
          <pre className={SAMPLE_FILE}>{s.content}</pre>
          <Hint>{`Sample fingerprint (SHA-256): ${s.sampleHash}`}</Hint>
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
        <FormGrid onSubmit={validate} aria-label="Validate the sample">
          {author && <Hint>You wrote this template, so someone else validates its sample.</Hint>}
          {!author && !s && <Hint>Show the sample file first and compare it with the bank’s specification.</Hint>}
          <FormField>
            Validation reference
            <Input value={validationReference} onChange={(e) => setValidationReference(e.target.value)} maxLength={500} autoComplete="off" />
          </FormField>
          <ButtonRow>
            <Button type="submit" disabled={act.isPending || author || !s || s.errors.length > 0}>
              Record the sample as validated
            </Button>
          </ButtonRow>
          <Missing text={problem} />
        </FormGrid>
      )}
      {can(TEMPLATE_ACTIVATE) && t.state === 'DRAFT' && (
        <div className="mt-2">
          <Button
            type="button"
            disabled={act.isPending || author || !t.sampleHash}
            onClick={() => {
              setNote(null);
              act.reset();
              act.mutate({ action: 'activate', body: { expectedVersion: t.version } });
            }}
          >
            Activate this template
          </Button>
          {!t.sampleHash && <Hint>A template is activated only after an independent sample validation.</Hint>}
          {author && <Hint>You wrote this template, so someone else activates it.</Hint>}
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
      <Problem error={act.error} act={failedAct(act.variables?.action)} />
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
    <FieldSet className="gap-[0.55rem]">
      <legend>{`${part} record: fields in file order`}</legend>
      {fields.length === 0 && <Hint>No fields yet.</Hint>}
      {fields.map((f, i) => (
        <div key={f.key} className={FIELD_ROW}>
          <FormField className="w-auto">
            {`${part} field ${i + 1}`}
            <NativeSelect value={f.source} onChange={(e) => set(i, { source: e.target.value })}>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {label(SOURCE_LABEL, s)}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          {f.source === 'LITERAL' && (
            <FormField className="w-auto">
              {`${part} field ${i + 1} text`}
              <Input value={f.value} onChange={(e) => set(i, { value: e.target.value })} maxLength={100} autoComplete="off" />
            </FormField>
          )}
          <FormField className="w-auto">
            {`${part} field ${i + 1} maximum length`}
            <Input value={f.maxLength} onChange={(e) => set(i, { maxLength: e.target.value })} inputMode="numeric" maxLength={3} />
          </FormField>
          <Button type="button" variant="outline" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${part.toLowerCase()} field ${i + 1} up`}>
            Up
          </Button>
          <Button type="button" variant="outline" disabled={i === fields.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${part.toLowerCase()} field ${i + 1} down`}>
            Down
          </Button>
          <Button type="button" variant="outline" onClick={() => onChange(fields.filter((_, j) => j !== i))} aria-label={`Remove ${part.toLowerCase()} field ${i + 1}`}>
            Remove
          </Button>
        </div>
      ))}
      {/* The group stacks its rows full width: the add button keeps its own width at the start. */}
      <Button type="button" variant="outline" className="self-start" onClick={() => onChange([...fields, { key: newKey(), source: sources[0] ?? 'LITERAL', value: '', maxLength: '' }])}>
        {`Add a ${part.toLowerCase()} field`}
      </Button>
    </FieldSet>
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
        <Hint>Saving the same template code again creates its next version. Transcribe the bank’s accepted specification exactly: values are never shortened or changed to fit, and a row that does not fit stops the whole file.</Hint>
        {basis && (
          <Button type="button" variant="outline" onClick={onClearBasis}>
            Start from an empty template instead
          </Button>
        )}
        <FormGrid ref={formRef} onSubmit={submit} aria-label="Bank file template">
          <FormStep legend="The template">
            <FormField>
              Template code
              <Input value={f.templateCode} onChange={(e) => set({ templateCode: e.target.value })} maxLength={40} autoComplete="off" />
            </FormField>
            <FormField>
              Template name
              <Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} autoComplete="off" />
            </FormField>
            <FormField>
              Currency
              <Input value={f.currencyCode} onChange={(e) => set({ currencyCode: e.target.value })} maxLength={3} autoComplete="off" />
            </FormField>
            <FormField>
              Bank specification reference
              <Input value={f.spec} onChange={(e) => set({ spec: e.target.value })} maxLength={500} autoComplete="off" />
            </FormField>
            <CheckField className="col-span-full">
              <input type="checkbox" checked={f.testOnly} onChange={(e) => set({ testOnly: e.target.checked })} /> Test only (synthetic; refused in production)
            </CheckField>
          </FormStep>
          <FormStep legend="File format">
            <FormField>
              Delimiter
              <NativeSelect value={f.delimiter} onChange={(e) => set({ delimiter: e.target.value })}>
                {Object.entries(DELIMITER_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              Line ending
              <NativeSelect value={f.lineEnding} onChange={(e) => set({ lineEnding: e.target.value })}>
                <option value="CRLF">CRLF</option>
                <option value="LF">LF</option>
              </NativeSelect>
            </FormField>
            <FormField>
              Amount decimals
              <NativeSelect value={f.decimals} onChange={(e) => set({ decimals: e.target.value })}>
                {['0', '1', '2', '3', '4'].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              Decimal separator
              <NativeSelect value={f.separator} onChange={(e) => set({ separator: e.target.value })}>
                <option value=".">Point (.)</option>
                <option value=",">Comma (,)</option>
              </NativeSelect>
            </FormField>
            <FormField>
              Date format
              <NativeSelect value={f.dateFormat} onChange={(e) => set({ dateFormat: e.target.value })}>
                {DATE_FORMATS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              File extension
              <NativeSelect value={f.extension} onChange={(e) => set({ extension: e.target.value })}>
                <option value="csv">csv</option>
                <option value="txt">txt</option>
              </NativeSelect>
            </FormField>
          </FormStep>
          <FormStep legend="Records and their fields">
            <CheckField className="col-span-full">
              <input type="checkbox" checked={f.header !== null} onChange={(e) => set({ header: e.target.checked ? (f.header ?? []) : null })} /> Header record
            </CheckField>
            {f.header !== null && <FieldListEditor part="Header" sources={CONTROL_SOURCES} fields={f.header} onChange={(header) => set({ header })} newKey={newKey} />}
            <FieldListEditor part="Detail" sources={DETAIL_SOURCES} fields={f.detail} onChange={(detail) => set({ detail })} newKey={newKey} />
            <CheckField className="col-span-full">
              <input type="checkbox" checked={f.trailer !== null} onChange={(e) => set({ trailer: e.target.checked ? (f.trailer ?? []) : null })} /> Trailer record
            </CheckField>
            {f.trailer !== null && <FieldListEditor part="Trailer" sources={CONTROL_SOURCES} fields={f.trailer} onChange={(trailer) => set({ trailer })} newKey={newKey} />}
          </FormStep>
          <ButtonRow>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Save as a draft version'}
            </Button>
          </ButtonRow>
          <Missing text={problem} />
          <div className="col-span-full">
            <Note text={note} />
            <Problem error={create.error} act="template" />
          </div>
        </FormGrid>
      </Section>
    </>
  );
}
