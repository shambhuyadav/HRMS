// Letter templates (FR-017): the approved placeholders, the template list and a new template.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ButtonRow, CheckField, ChoiceRow, FormField, FormGrid, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { api, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, NotPermitted, Section } from '../../ui';
import { Refusal, TEMPLATE_WORDS } from './refusals';
import { CODE, enc, FIELD_ROW, labelOf, LETTER_GENERATE, LETTER_READ, LETTER_TYPE_CODE, LETTER_TYPES, letterTypeLabel, LoadProblem, MAX_BODY, MAX_NAME, MAX_OPTIONAL, OFFER_LETTER_TYPE, PATHS, SOURCE_LABEL, TEMPLATE_MANAGE, TEMPLATE_READ, usedPlaceholders, useKeys } from './shared';
import type { Placeholder, TemplateDetail, TemplateSummary } from './types';

/** A placeholder the text uses that is not approved, beside the checkboxes of the others: in the error colours, not announced (it had no role). */
const NOT_APPROVED = 'inline-flex items-center gap-1.5 rounded-md border border-[var(--bad-edge)] bg-[var(--bad-soft)] px-2.5 py-1 text-[0.83rem] text-destructive';

export const placeholderLabelMap = (items: readonly Placeholder[] | undefined) => new Map((items ?? []).map((p) => [p.key, p.label]));

/** A placeholder by its approved label when the list is at hand, always with its key. */
export function placeholderName(labels: ReadonlyMap<string, string>, key: string): string {
  const label = labels.get(key);
  return label ? `${label} ({{${key}}})` : `{{${key}}}`;
}

/**
 * The approved placeholders of a letter type (GET /v1/letter-placeholders?letterType=; I-82 item 1: an OFFER template has its
 * own). Without a well-formed type, the employee letters' list. Which type takes which list is the server's to say.
 */
export function usePlaceholders(enabled: boolean, letterType?: string) {
  const keys = useKeys();
  const type = letterType !== undefined && LETTER_TYPE_CODE.test(letterType) ? letterType : '';
  return useQuery({
    enabled,
    queryKey: [...keys.placeholders, type],
    queryFn: () => api<{ items: Placeholder[] }>(type ? `/v1/letter-placeholders?letterType=${enc(type)}` : '/v1/letter-placeholders'),
    retry: retryTransient,
    staleTime: 5 * 60_000,
  });
}

/** I-82 item 1: an OFFER template is used from the approved offer in Hiring only. */
export function OfferTemplateNote({ letterType }: { letterType: string }) {
  if (letterType !== OFFER_LETTER_TYPE) return null;
  return <Hint>An offer letter is issued from the approved offer in Hiring, not from an employee process.</Hint>;
}

// =========================================================================================================
// Letter templates (FR-017): list, approved placeholders, a new template
// =========================================================================================================
export function LetterTemplatesScreen() {
  const { can } = useSession();
  const canRead = can(TEMPLATE_READ);
  return (
    <>
      <h1>Letter templates</h1>
      <Hint>
        Versioned templates that may use only the approved placeholders. A template is used for letters while it is active and has a published revision; letters
        already generated keep the revision they were made from.
        {(can(LETTER_READ) || can(LETTER_GENERATE)) && (
          <>
            {' '}
            Letters for employees are prepared under <Link to={PATHS.letters}>Letters</Link>.
          </>
        )}
      </Hint>
      {canRead ? (
        <TemplateList />
      ) : (
        <Section title="Letter templates">
          <NotPermitted>The selected role cannot view letter templates.</NotPermitted>
        </Section>
      )}
      {can(TEMPLATE_MANAGE) && <CreateTemplate />}
      {canRead && <PlaceholderReference />}
    </>
  );
}

export const usableText = (t: { active: boolean; publishedRevision: number | null }) =>
  !t.active ? 'No: inactive' : t.publishedRevision === null ? 'No: nothing published yet' : `Yes, revision ${t.publishedRevision}`;

function TemplateList() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.templates, queryFn: () => api<{ items: TemplateSummary[] }>('/v1/letter-templates'), retry: retryTransient });
  const items = list.data?.items ?? [];
  return (
    <Section title="Letter templates">
      {list.isPending && <LoadingLine>Loading the letter templates…</LoadingLine>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view letter templates." />
      {list.data && items.length === 0 && <Empty>No letter templates yet.</Empty>}
      {items.length > 0 && (
        <Table aria-label="Letter templates">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Letter type</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Published revision</TableHead>
              <TableHead scope="col">Draft revision</TableHead>
              <TableHead scope="col">Usable for letters</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Template</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.code}</TableCell>
                <TableCell>{t.name}</TableCell>
                <TableCell>{letterTypeLabel(t.letterType)}</TableCell>
                <TableCell>{t.active ? 'Active' : 'Inactive'}</TableCell>
                <TableCell>{t.publishedRevision ?? 'None'}</TableCell>
                <TableCell>{t.draftRevision ?? 'None'}</TableCell>
                <TableCell>{usableText(t)}</TableCell>
                <RowActionsCell>
                  <Link to={PATHS.template(t.id)} aria-label={`Open template ${t.code}`}>
                    Open
                  </Link>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function PlaceholderReference() {
  const placeholders = usePlaceholders(true);
  const items = placeholders.data?.items ?? [];
  return (
    <Section title="Approved placeholders">
      <Hint>
        Write a placeholder as {'{{name}}'}. Every placeholder a template uses is mandatory unless the template marks it optional, and a missing mandatory value blocks
        the final letter. These are the placeholders of employee letters; an offer letter template (letter type OFFER) has its own, which its editor lists.
      </Hint>
      {placeholders.isPending && <LoadingLine>Loading the approved placeholders…</LoadingLine>}
      <LoadProblem error={placeholders.error} forbidden="The selected role cannot view the approved placeholders." />
      {items.length > 0 && (
        <Table aria-label="Approved placeholders">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Placeholder</TableHead>
              <TableHead scope="col">Meaning</TableHead>
              <TableHead scope="col">Taken from</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((p) => (
              <TableRow key={p.key}>
                <TableCell>
                  <code>{`{{${p.key}}}`}</code>
                </TableCell>
                <TableCell>{p.label}</TableCell>
                <TableCell>{labelOf(SOURCE_LABEL, p.source)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

/**
 * The letter text with placeholder insertion, the placeholders it uses and which of them are optional. `approved` is
 * the approved placeholder list when the role may read it (the server checks the text either way).
 */
export function TemplateTextFields({
  body,
  onBody,
  optional,
  onOptional,
  approved,
  disabled,
}: {
  body: string;
  onBody: (next: string) => void;
  optional: readonly string[];
  onOptional: (next: string[]) => void;
  approved: readonly Placeholder[] | undefined;
  disabled: boolean;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [toInsert, setToInsert] = useState('');
  const used = usedPlaceholders(body);
  const approvedKeys = approved ? new Set(approved.map((p) => p.key)) : null;
  const labels = placeholderLabelMap(approved);
  const insert = () => {
    if (!toInsert) return;
    const token = `{{${toInsert}}}`;
    const el = area.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${token}${body.slice(end)}`;
    if (next.length > MAX_BODY) return;
    onBody(next);
  };
  const toggle = (key: string, on: boolean) => onOptional(on ? [...optional.filter((k) => k !== key), key] : optional.filter((k) => k !== key));
  return (
    <>
      <FormField className="col-span-full">
        Letter text (required)
        <Textarea ref={area} required rows={10} maxLength={MAX_BODY} value={body} disabled={disabled} onChange={(e) => onBody(e.target.value)} className="resize-y" />
      </FormField>
      {approved && approved.length > 0 && (
        <div className={cn(FIELD_ROW, 'col-span-full')}>
          <FormField className="w-auto">
            Placeholder to insert{' '}
            <NativeSelect value={toInsert} disabled={disabled} onChange={(e) => setToInsert(e.target.value)}>
              <option value="">Choose…</option>
              {approved.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} ({`{{${p.key}}}`})
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <Button type="button" variant="outline" disabled={disabled || !toInsert} onClick={insert}>
            Insert placeholder
          </Button>
        </div>
      )}
      <div className="col-span-full">
        {used.length === 0 ? (
          <Hint>The text uses no placeholders.</Hint>
        ) : (
          <FramedFieldset legend="Placeholders the text uses: mandatory unless marked optional">
            <ChoiceRow>
              {used.map((key) =>
                approvedKeys && !approvedKeys.has(key) ? (
                  <span key={key} className={NOT_APPROVED}>
                    <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
                    {`{{${key}}}`} is not an approved placeholder
                  </span>
                ) : (
                  <CheckField key={key}>
                    <input type="checkbox" disabled={disabled} checked={optional.includes(key)} onChange={(e) => toggle(key, e.target.checked)} /> {placeholderName(labels, key)}{' '}
                    optional
                  </CheckField>
                ),
              )}
            </ChoiceRow>
          </FramedFieldset>
        )}
      </div>
    </>
  );
}

/** The optional placeholders to send: those the text still uses, sorted. */
export const optionalToSend = (body: string, optional: readonly string[]) => {
  const used = usedPlaceholders(body);
  return optional.filter((k) => used.includes(k)).sort();
};

function CreateTemplate() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [letterType, setLetterType] = useState('');
  // The placeholders of the chosen letter type (an OFFER template has the offer's own).
  const approved = usePlaceholders(can(TEMPLATE_READ), letterType.trim());
  const [body, setBody] = useState('');
  const [optional, setOptional] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<TemplateDetail | null>(null);
  const create = useMutation({
    mutationFn: (input: { code: string; name: string; letterType: string; body: string; optionalPlaceholders: string[] }) =>
      api<TemplateDetail>('/v1/letter-templates', { body: input }),
    onMutate: () => setCreated(null),
    // A template created starts the form clean; a refused one keeps what was typed.
    onSuccess: (t) => {
      setCreated(t);
      setCode('');
      setName('');
      setLetterType('');
      setBody('');
      setOptional([]);
      void qc.invalidateQueries({ queryKey: keys.templates });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const c = code.trim();
    const n = name.trim();
    const type = letterType.trim();
    const sendOptional = optionalToSend(body, optional);
    const missing = !CODE.test(c)
      ? 'Enter a template code: a capital letter followed by capital letters, digits or _ (up to 40 characters).'
      : !n
        ? 'Enter the template name.'
        : !LETTER_TYPE_CODE.test(type)
          ? 'Enter the letter type code, for example RELIEVING.'
          : !body.trim()
            ? 'Enter the letter text.'
            : sendOptional.length > MAX_OPTIONAL
              ? `At most ${MAX_OPTIONAL} placeholders can be optional.`
              : null;
    setProblem(missing);
    if (missing !== null) {
      create.reset();
      return;
    }
    create.mutate({ code: c, name: n, letterType: type, body, optionalPlaceholders: sendOptional });
  };

  const typeList = `${id}-types`;
  return (
    <Section title="New letter template">
      <FormGrid aria-label="New letter template" onSubmit={submit}>
        <FormField>
          Template code (required)
          <Input value={code} maxLength={40} required placeholder="RELIEVING_STANDARD" onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </FormField>
        <FormField>
          Name (required)
          <Input value={name} maxLength={MAX_NAME} required onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField>
          Letter type (required)
          <Input value={letterType} maxLength={60} required list={typeList} onChange={(e) => setLetterType(e.target.value.toUpperCase())} />
        </FormField>
        {/* Suggestions only (the seeded letter types); a company may have added others, and the server checks the code. */}
        <datalist id={typeList}>
          {LETTER_TYPES.map(([c, label]) => (
            <option key={c} value={c}>
              {label}
            </option>
          ))}
        </datalist>
        <OfferTemplateNote letterType={letterType.trim()} />
        <TemplateTextFields body={body} onBody={setBody} optional={optional} onOptional={setOptional} approved={approved.data?.items} disabled={create.isPending} />
        <Hint>The template starts as draft revision 1. Publish it on the template’s page before letters can use it.</Hint>
        {problem && <Notice notice={{ text: problem, ok: false }} />}
        {create.error && (
          <div className="col-span-full">
            <Refusal error={create.error} words={TEMPLATE_WORDS} />
          </div>
        )}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={create.isPending}>
            Create template
          </Button>
        </ButtonRow>
        {created && (
          <StatusNote tone="success" role="status">
            Template {created.code} created as draft revision 1. <Link to={PATHS.template(created.id)}>Open template {created.code}</Link> to publish it.
          </StatusNote>
        )}
      </FormGrid>
    </Section>
  );
}

