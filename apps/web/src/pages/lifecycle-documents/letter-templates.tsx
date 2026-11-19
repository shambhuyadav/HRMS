// Letter templates (FR-017): the approved placeholders, the template list and a new template.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted, Section } from '../../ui';
import { Refusal, TEMPLATE_WORDS } from './refusals';
import { CODE, enc, GROUP, labelOf, LETTER_GENERATE, LETTER_READ, LETTER_TYPE_CODE, LETTER_TYPES, letterTypeLabel, LoadProblem, MAX_BODY, MAX_NAME, MAX_OPTIONAL, OFFER_LETTER_TYPE, PATHS, SCROLL, SOURCE_LABEL, SR_ONLY, TEMPLATE_MANAGE, TEMPLATE_READ, TEXTAREA, usedPlaceholders, useKeys } from './shared';
import type { Placeholder, TemplateDetail, TemplateSummary } from './types';

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
  return <p className="hint wide">An offer letter is issued from the approved offer in Hiring, not from an employee process.</p>;
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
      <p className="hint">
        Versioned templates that may use only the approved placeholders. A template is used for letters while it is active and has a published revision; letters
        already generated keep the revision they were made from.
        {(can(LETTER_READ) || can(LETTER_GENERATE)) && (
          <>
            {' '}
            Letters for employees are prepared under <Link to={PATHS.letters}>Letters</Link>.
          </>
        )}
      </p>
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
      {list.isPending && <p className="hint loading">Loading the letter templates…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view letter templates." />
      {list.data && items.length === 0 && <Empty>No letter templates yet.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Letter templates">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Letter type</th>
                <th scope="col">Status</th>
                <th scope="col">Published revision</th>
                <th scope="col">Draft revision</th>
                <th scope="col">Usable for letters</th>
                <th scope="col">
                  <span style={SR_ONLY}>Template</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.code}</td>
                  <td>{t.name}</td>
                  <td>{letterTypeLabel(t.letterType)}</td>
                  <td>{t.active ? 'Active' : 'Inactive'}</td>
                  <td>{t.publishedRevision ?? 'None'}</td>
                  <td>{t.draftRevision ?? 'None'}</td>
                  <td>{usableText(t)}</td>
                  <td>
                    <Link to={PATHS.template(t.id)} aria-label={`Open template ${t.code}`}>
                      Open
                    </Link>
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

function PlaceholderReference() {
  const placeholders = usePlaceholders(true);
  const items = placeholders.data?.items ?? [];
  return (
    <Section title="Approved placeholders">
      <p className="hint">
        Write a placeholder as {'{{name}}'}. Every placeholder a template uses is mandatory unless the template marks it optional, and a missing mandatory value blocks
        the final letter. These are the placeholders of employee letters; an offer letter template (letter type OFFER) has its own, which its editor lists.
      </p>
      {placeholders.isPending && <p className="hint loading">Loading the approved placeholders…</p>}
      <LoadProblem error={placeholders.error} forbidden="The selected role cannot view the approved placeholders." />
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Approved placeholders">
            <thead>
              <tr>
                <th scope="col">Placeholder</th>
                <th scope="col">Meaning</th>
                <th scope="col">Taken from</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.key}>
                  <td>
                    <code>{`{{${p.key}}}`}</code>
                  </td>
                  <td>{p.label}</td>
                  <td>{labelOf(SOURCE_LABEL, p.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <label className="wide">
        Letter text (required)
        <textarea ref={area} required rows={10} maxLength={MAX_BODY} value={body} disabled={disabled} onChange={(e) => onBody(e.target.value)} style={TEXTAREA} />
      </label>
      {approved && approved.length > 0 && (
        <div className="wide row">
          <label className="inline">
            Placeholder to insert{' '}
            <select value={toInsert} disabled={disabled} onChange={(e) => setToInsert(e.target.value)}>
              <option value="">Choose…</option>
              {approved.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} ({`{{${p.key}}}`})
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="secondary" disabled={disabled || !toInsert} onClick={insert}>
            Insert placeholder
          </button>
        </div>
      )}
      <div className="wide">
        {used.length === 0 ? (
          <p className="hint">The text uses no placeholders.</p>
        ) : (
          <fieldset style={GROUP}>
            <legend>Placeholders the text uses: mandatory unless marked optional</legend>
            <div className="row">
              {used.map((key) =>
                approvedKeys && !approvedKeys.has(key) ? (
                  <span key={key} className="error">
                    {`{{${key}}}`} is not an approved placeholder
                  </span>
                ) : (
                  <label key={key} className="check">
                    <input type="checkbox" disabled={disabled} checked={optional.includes(key)} onChange={(e) => toggle(key, e.target.checked)} /> {placeholderName(labels, key)}{' '}
                    optional
                  </label>
                ),
              )}
            </div>
          </fieldset>
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
      <form className="grid-form" aria-label="New letter template" onSubmit={submit}>
        <label>
          Template code (required)
          <input value={code} maxLength={40} required placeholder="RELIEVING_STANDARD" onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </label>
        <label>
          Name (required)
          <input value={name} maxLength={MAX_NAME} required onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Letter type (required)
          <input value={letterType} maxLength={60} required list={typeList} onChange={(e) => setLetterType(e.target.value.toUpperCase())} />
        </label>
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
        <p className="hint wide">The template starts as draft revision 1. Publish it on the template’s page before letters can use it.</p>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        {create.error && (
          <div className="wide">
            <Refusal error={create.error} words={TEMPLATE_WORDS} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={create.isPending}>
            Create template
          </button>
        </div>
        {created && (
          <p className="ok wide" role="status">
            Template {created.code} created as draft revision 1. <Link to={PATHS.template(created.id)}>Open template {created.code}</Link> to publish it.
          </p>
        )}
      </form>
    </Section>
  );
}

