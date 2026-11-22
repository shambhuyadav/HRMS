// One letter template: revisions, the draft, publishing, renaming and activation.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, isConflict, isNotFound, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, NotPermitted, Section } from '../../ui';
import { OfferTemplateNote, optionalToSend, TemplateTextFields, usableText, usePlaceholders } from './letter-templates';
import { braces, Refusal, TEMPLATE_WORDS } from './refusals';
import { enc, FOLD, FOLD_SUMMARY, Item, labelOf, LETTER, letterTypeLabel, LoadProblem, MAX_NAME, MAX_OPTIONAL, PATHS, REVISION_STATE_LABEL, sameSet, TEMPLATE_MANAGE, TEMPLATE_READ, useKeys, UUID, when, WRAPPING_BUTTON } from './shared';
import type { TemplateDetail, TemplateRevision } from './types';

// =========================================================================================================
// One letter template: revisions, the draft, publishing, renaming and activation
// =========================================================================================================
export function LetterTemplateScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!UUID.test(id)) {
    return (
      <>
        <h1>Letter template</h1>
        <Empty>This address does not name a letter template.</Empty>
      </>
    );
  }
  if (!can(TEMPLATE_READ)) {
    return (
      <>
        <h1>Letter template</h1>
        <Section title="Letter template">
          <NotPermitted>The selected role cannot view letter templates.</NotPermitted>
        </Section>
      </>
    );
  }
  // Keyed by the record: following a link to another one never carries typed text or notices over.
  return <TemplateView key={id} id={id} />;
}

function TemplateView({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const detail = useQuery({ queryKey: keys.template(id), queryFn: () => api<TemplateDetail>(`/v1/letter-templates/${enc(id)}`), retry: retryTransient });
  const t = detail.data;
  const published = t?.revisions.find((r) => r.state === 'PUBLISHED') ?? null;
  const draft = t?.revisions.find((r) => r.state === 'DRAFT') ?? null;
  return (
    <>
      <h1>{t ? `Letter template ${t.code}` : 'Letter template'}</h1>
      <p>
        <Link to={PATHS.templates}>All letter templates</Link>
      </p>
      <Section title="Template">
        {detail.isPending && <LoadingLine>Loading the template…</LoadingLine>}
        <LoadProblem error={detail.error} forbidden="The selected role cannot view letter templates." missing="This letter template is not available." />
        {t && (
          <dl className="kv">
            <Item term="Code">{t.code}</Item>
            <Item term="Name">{t.name}</Item>
            <Item term="Letter type">{letterTypeLabel(t.letterType)}</Item>
            <Item term="Status">{t.active ? 'Active' : 'Inactive'}</Item>
            <Item term="Published revision">{published ? published.revision : 'None'}</Item>
            <Item term="Draft revision">{draft ? draft.revision : 'None'}</Item>
            <Item term="Usable for letters">{usableText({ active: t.active, publishedRevision: published?.revision ?? null })}</Item>
          </dl>
        )}
        {t && <OfferTemplateNote letterType={t.letterType} />}
      </Section>
      {t && <RevisionTable template={t} />}
      {t && can(TEMPLATE_MANAGE) && <TemplateSettings template={t} />}
      {t && can(TEMPLATE_MANAGE) && <DraftEditor template={t} />}
    </>
  );
}

function RevisionTable({ template: t }: { template: TemplateDetail }) {
  return (
    <Section title="Revisions">
      {t.revisions.length === 0 ? (
        <Empty>No revisions.</Empty>
      ) : (
        <Table aria-label="Revisions">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Revision</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Mandatory placeholders</TableHead>
              <TableHead scope="col">Optional placeholders</TableHead>
              <TableHead scope="col">Published</TableHead>
              <TableHead scope="col">Text</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.revisions.map((r) => {
              const mandatory = r.placeholders.filter((p) => !r.optionalPlaceholders.includes(p));
              return (
                <TableRow key={r.revision}>
                  <TableCell>{r.revision}</TableCell>
                  <TableCell>{labelOf(REVISION_STATE_LABEL, r.state)}</TableCell>
                  <TableCell>{mandatory.length > 0 ? braces(mandatory) : 'None'}</TableCell>
                  <TableCell>{r.optionalPlaceholders.length > 0 ? braces(r.optionalPlaceholders) : 'None'}</TableCell>
                  <TableCell>{when(r.publishedAt)}</TableCell>
                  <TableCell>
                    <details className={FOLD}>
                      <summary className={FOLD_SUMMARY}>Text of revision {r.revision}</summary>
                      <pre className={LETTER}>{r.body}</pre>
                    </details>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function useTemplateRefresh(id: string) {
  const qc = useQueryClient();
  const keys = useKeys();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.template(id) });
    void qc.invalidateQueries({ queryKey: keys.templates });
  };
}

/** Renaming and activation, against the template's version (PATCH /v1/letter-templates/:id). */
function TemplateSettings({ template: t }: { template: TemplateDetail }) {
  const refresh = useTemplateRefresh(t.id);
  const [name, setName] = useState(t.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (body: { name?: string; active?: boolean; expectedVersion: number }) => api<TemplateDetail>(`/v1/letter-templates/${enc(t.id)}`, { method: 'PATCH', body }),
    onMutate: () => setNotice(null),
    onSuccess: (saved, body) => {
      if (body.name !== undefined) setName(saved.name);
      setNotice(
        body.active === undefined
          ? `The template is now named “${saved.name}”.`
          : saved.active
            ? 'The template is active again: letters can use its published revision.'
            : 'The template is inactive: no letter can be previewed or generated from it until it is activated again.',
      );
      refresh();
    },
    // A stale version: reload, so the next attempt uses the current one (what was typed is kept).
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (update.isPending) return;
    const n = name.trim();
    setProblem(n ? null : 'Enter the template name.');
    if (!n) {
      update.reset();
      return;
    }
    update.mutate({ name: n, expectedVersion: t.version });
  };
  return (
    <Section title="Name and status">
      <FormGrid aria-label="Rename the template" onSubmit={rename}>
        <FormField>
          Template name{' '}
          <Input value={name} maxLength={MAX_NAME} required disabled={update.isPending} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <Button type="submit" disabled={update.isPending}>
          Save name
        </Button>
      </FormGrid>
      <p>
        This template is {t.active ? 'active' : 'inactive'}.{' '}
        {t.active ? 'Deactivating it stops new previews and letters from it; letters already generated stay as they are.' : 'Activating it lets letters use its published revision again.'}
      </p>
      <ButtonRow>
        <Button type="button" variant={t.active ? 'danger' : 'default'} disabled={update.isPending} onClick={() => update.mutate({ active: !t.active, expectedVersion: t.version })}>
          {t.active ? 'Deactivate template' : 'Activate template'}
        </Button>
      </ButtonRow>
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <Refusal error={update.error} words={TEMPLATE_WORDS} />
      <Notice notice={notice ? { text: notice, ok: true } : null} />
    </Section>
  );
}

/**
 * The draft revision: saved as a whole against its version (PUT .../draft); without a draft, saving opens the next
 * revision. Publishing freezes the saved draft and retires the revision published before (POST .../publish).
 */
function DraftEditor({ template: t }: { template: TemplateDetail }) {
  const { can } = useSession();
  const refresh = useTemplateRefresh(t.id);
  // The placeholders of this template's letter type (an OFFER template has the offer's own).
  const approved = usePlaceholders(can(TEMPLATE_READ), t.letterType);
  const draft = t.revisions.find((r) => r.state === 'DRAFT') ?? null;
  const published = t.revisions.find((r) => r.state === 'PUBLISHED') ?? null;
  const start = draft ?? published;
  const [body, setBody] = useState(start?.body ?? '');
  const [optional, setOptional] = useState<string[]>(start?.optionalPlaceholders ?? []);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: { body: string; optionalPlaceholders: string[]; expectedVersion?: number }) =>
      api<TemplateDetail>(`/v1/letter-templates/${enc(t.id)}/draft`, { method: 'PUT', body: input }),
    onMutate: () => setNotice(null),
    onSuccess: (saved) => {
      const d = saved.revisions.find((r) => r.state === 'DRAFT');
      if (d) {
        setBody(d.body);
        setOptional(d.optionalPlaceholders);
      }
      setNotice(`${d ? `Draft revision ${d.revision}` : 'The draft'} is saved. Publish it for new letters to use it.`);
      refresh();
    },
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const publish = useMutation({
    mutationFn: (d: TemplateRevision) => api<TemplateDetail>(`/v1/letter-templates/${enc(t.id)}/publish`, { body: { revision: d.revision, expectedVersion: d.version } }),
    onMutate: () => setNotice(null),
    onSuccess: (saved, d) => {
      const p = saved.revisions.find((r) => r.state === 'PUBLISHED');
      if (p) {
        setBody(p.body);
        setOptional(p.optionalPlaceholders);
      }
      setNotice(`Revision ${d.revision} is published: new letters use it, and letters already generated keep the revision they were made from.`);
      refresh();
    },
    onError: (error) => {
      if (isConflict(error) || isNotFound(error)) refresh();
    },
  });
  const busy = save.isPending || publish.isPending;
  // The saved text this editor started from (the draft, else the published revision), as the server holds it now.
  const base = draft ?? published;
  const changed = base !== null && (body !== base.body || !sameSet(optionalToSend(body, optional), base.optionalPlaceholders));
  // Publishing publishes the saved draft: changes not saved yet would not be in it.
  const unsaved = draft !== null && changed;
  const discard = () => {
    if (!base) return;
    setBody(base.body);
    setOptional(base.optionalPlaceholders);
    setProblem(null);
    save.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const sendOptional = optionalToSend(body, optional);
    const missing = !body.trim() ? 'Enter the letter text.' : sendOptional.length > MAX_OPTIONAL ? `At most ${MAX_OPTIONAL} placeholders can be optional.` : null;
    setProblem(missing);
    if (missing !== null) {
      save.reset();
      return;
    }
    save.mutate({ body, optionalPlaceholders: sendOptional, ...(draft ? { expectedVersion: draft.version } : {}) });
  };

  return (
    <Section title={draft ? `Draft revision ${draft.revision}` : 'Next revision'}>
      <Hint>{editorIntro(draft, published)}</Hint>
      <FormGrid aria-label={draft ? `Draft revision ${draft.revision}` : 'Next revision'} onSubmit={submit}>
        <TemplateTextFields body={body} onBody={setBody} optional={optional} onOptional={setOptional} approved={approved.data?.items} disabled={busy} />
        {problem && <Notice notice={{ text: problem, ok: false }} />}
        {save.error && (
          <div className="col-span-full">
            <Refusal error={save.error} words={TEMPLATE_WORDS} />
          </div>
        )}
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={busy}>
            {draft ? 'Save draft' : 'Save as a new draft'}
          </Button>
          {changed && base && (
            <Button type="button" variant="outline" className={WRAPPING_BUTTON} disabled={busy} onClick={discard}>
              Discard changes (back to the saved text of revision {base.revision})
            </Button>
          )}
        </ButtonRow>
      </FormGrid>
      {draft && (
        <div className="flex flex-col gap-3">
          <p>
            Publishing revision {draft.revision} freezes it{published ? ` and retires revision ${published.revision}` : ''}. New letters then use revision {draft.revision}.
          </p>
          {unsaved && <Hint>Save the draft first: publishing publishes the saved text, not unsaved changes.</Hint>}
          <ButtonRow>
            <Button type="button" disabled={busy || unsaved} onClick={() => publish.mutate(draft)}>
              Publish revision {draft.revision}
            </Button>
          </ButtonRow>
          <Refusal error={publish.error} words={TEMPLATE_WORDS} />
        </div>
      )}
      <Notice notice={notice ? { text: notice, ok: true } : null} />
    </Section>
  );
}

/** What the editor is for: the draft being edited, the next revision started from the published text, or a first text. */
function editorIntro(draft: TemplateRevision | null, published: TemplateRevision | null): string {
  if (draft) return 'Edit the draft and save it, then publish it. A published revision is frozen.';
  if (published) {
    return `Start the next revision from the published text (revision ${published.revision}). Saving opens a new draft; revision ${published.revision} stays in use until the draft is published.`;
  }
  return 'Write the text and save it as a draft.';
}

