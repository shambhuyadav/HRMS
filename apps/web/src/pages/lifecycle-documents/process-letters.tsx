// Letters for one process: the preview (never stored or sent), then the final letter.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Notice, NotPermitted, Section, StateBadge } from '../../ui';
import { placeholderLabelMap, placeholderName, usePlaceholders } from './letter-templates';
import { OutputDownload } from './letters';
import { listOf, Refusal, type Words } from './refusals';
import { CODE, DELIVERY_LABEL, enc, Item, labelOf, LETTER, LETTER_GENERATE, LETTER_READ, LINK_ROW, LoadProblem, PATHS, PROCESS_READ, TEMPLATE_READ, useKeys, UserRef, UUID, when } from './shared';
import type { LetterOutput, LetterPreview, ProcessDetail, TemplateSummary } from './types';

// =========================================================================================================
// Letters for one process: preview (never stored or sent), then the final letter
// =========================================================================================================
export function ProcessLettersScreen() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) {
    return (
      <>
        <h1>Process letters</h1>
        <Empty>This address does not name an employee process.</Empty>
      </>
    );
  }
  return <ProcessLetters key={id} processId={id} />;
}

function ProcessLetters({ processId }: { processId: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const canRead = can(PROCESS_READ);
  const process = useQuery({
    enabled: canRead,
    queryKey: keys.process(processId),
    queryFn: () => api<ProcessDetail>(`/v1/employee-processes/${enc(processId)}`),
    retry: retryTransient,
  });
  const p = process.data;
  const own = p !== undefined && !!me?.employeeId && me.employeeId === p.employeeId;
  return (
    <>
      <h1>{p ? `Letters for ${p.employeeName} (${p.employeeCode})` : 'Process letters'}</h1>
      <Section title="Process">
        {!canRead && <Hint>The selected role cannot open this process, so its details are not shown here; the server checks every letter request.</Hint>}
        {canRead && process.isPending && <LoadingLine>Loading the process…</LoadingLine>}
        <LoadProblem error={process.error} forbidden="The selected role cannot open this process." missing="This process is not available in the selected role’s scope." />
        {p && (
          <>
            <dl className="kv">
              <Item term="Employee">
                {p.employeeName} <Hint as="span">{p.employeeCode}</Hint>
              </Item>
              <Item term="Process">
                {p.processName} <Hint as="span">{p.processCode}</Hint>
              </Item>
              <Item term="State">
                <StateBadge state={p.state} />
              </Item>
              <Item term="Effective date">{formatDate(p.effectiveDate)}</Item>
              <Item term="Linked exit">
                {p.exitCaseId ? 'Yes: exit placeholders use this exit once it is approved' : 'None: exit placeholders use the employee’s approved exit, if there is one'}
              </Item>
            </dl>
            <p className={LINK_ROW}>
              <Link to={PATHS.process(p.id)}>Open the process</Link>
              {can(LETTER_READ) && <Link to={PATHS.employeeLetters(p.employeeId)}>Stored letters of {p.employeeName}</Link>}
            </p>
          </>
        )}
      </Section>
      <PrepareLetter processId={processId} process={p} canRead={canRead} own={own} />
    </>
  );
}

/** The "Prepare a letter" card, or what stands in its place: the role's refusal, one's own record, a cancelled process. */
function PrepareLetter({ processId, process: p, canRead, own }: { processId: string; process: ProcessDetail | undefined; canRead: boolean; own: boolean }) {
  const { can } = useSession();
  if (!can(LETTER_GENERATE)) {
    return (
      <Section title="Prepare a letter">
        <NotPermitted>The selected role cannot prepare letters: previews and final letters need the confidential letter grant.</NotPermitted>
      </Section>
    );
  }
  // The process is loading, or did not load (said above): nothing to prepare yet.
  if (canRead && !p) return null;
  if (own) {
    return (
      <Section title="Prepare a letter">
        <Empty>This process is about your own record, so you cannot prepare letters for it in this role.</Empty>
      </Section>
    );
  }
  if (p?.state === 'CANCELLED') {
    return (
      <Section title="Prepare a letter">
        <Empty>This process was cancelled, so no letter can be generated for it.</Empty>
      </Section>
    );
  }
  return <LetterComposer processId={processId} employeeId={p?.employeeId ?? null} />;
}

/**
 * Choose a template, preview the letter, then generate the final letter. The final letter is offered only for a
 * preview of the chosen template that has every mandatory value; the server checks again and refuses a letter with a
 * missing mandatory value. Each generation stores a new letter (the route takes no idempotency key), so after one the
 * letter is previewed again before another is generated.
 */
function LetterComposer({ processId, employeeId }: { processId: string; employeeId: string | null }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const canTemplates = can(TEMPLATE_READ);
  const templates = useQuery({ enabled: canTemplates, queryKey: keys.templates, queryFn: () => api<{ items: TemplateSummary[] }>('/v1/letter-templates'), retry: retryTransient });
  const approved = usePlaceholders(canTemplates);
  const labels = useMemo(() => placeholderLabelMap(approved.data?.items), [approved.data]);
  const name = (key: string) => placeholderName(labels, key);
  const words = useMemo<Words>(
    () => ({
      INVALID_REFERENCE: 'No letter template has this code.',
      TEMPLATE_INACTIVE: 'This letter template is inactive, so it cannot be used for letters. Choose another template, or ask HR to activate it.',
      TEMPLATE_NOT_PUBLISHED: 'This letter template has no published revision yet, so it cannot be used for letters.',
      OFFER_TEMPLATE: 'This is an offer letter template: an offer letter is issued from the approved offer in Hiring, not from an employee process. Choose another template.',
      MISSING_PLACEHOLDER: (e) =>
        `The final letter was not generated: mandatory values are missing: ${listOf(e, 'missing')
          .map((k) => placeholderName(labels, k))
          .join(', ')}. Once they are recorded, preview the letter again.`,
      PROCESS_CANCELLED: 'This process was cancelled, so no letter can be generated for it.',
      EXIT_NOT_APPROVED: 'A relieving or experience letter is issued from an approved exit, and this employee has none for this process.',
      EMPLOYMENT_PERIOD_REQUIRED: 'This relieving or experience template does not show the employment period. Ask HR to publish a revision with the joining date and the last working date as mandatory placeholders.',
      NOT_FOUND: 'This process is not available in the selected role’s scope.',
      FORBIDDEN: 'The selected role cannot prepare letters: that needs the confidential letter grant.',
      SELF_ACTION_NOT_ALLOWED: 'This process is about your own record, so you cannot prepare letters for it in this role.',
      INVALID_REQUEST: 'Enter a template code: a capital letter followed by capital letters, digits or _ (up to 40 characters).',
    }),
    [labels],
  );
  const usable = (templates.data?.items ?? []).filter((t) => t.active && t.publishedRevision !== null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<LetterPreview | null>(null);
  const [generated, setGenerated] = useState<LetterOutput | null>(null);
  const generate = useMutation({
    mutationFn: (templateCode: string) => api<LetterOutput>(`/v1/employee-processes/${enc(processId)}/letters`, { body: { templateCode } }),
    // Stored: the choice starts clean, and another letter needs a new preview first.
    onSuccess: (letter) => {
      setGenerated(letter);
      setShown(null);
      setCode('');
      void qc.invalidateQueries({ queryKey: employeeId ? keys.outputs(employeeId) : keys.allOutputs });
    },
    // The answer was lost: the letter may have been stored; the stored letters show whether it was.
    onError: (error) => {
      if (!(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: keys.allOutputs });
    },
  });
  const preview = useMutation({
    mutationFn: (templateCode: string) => api<LetterPreview>(`/v1/employee-processes/${enc(processId)}/letters/preview`, { body: { templateCode } }),
    onMutate: () => {
      setShown(null);
      setGenerated(null);
      generate.reset();
    },
    onSuccess: setShown,
  });
  const busy = preview.isPending || generate.isPending;
  const chosen = code.trim().toUpperCase();
  const current = shown !== null && shown.templateCode === chosen ? shown : null;
  const canGenerate = current !== null && current.ready && current.missing.length === 0;

  const choose = (next: string) => {
    setCode(next);
    setShown(null);
    setProblem(null);
    preview.reset();
    generate.reset();
  };
  const runPreview = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!CODE.test(chosen)) {
      setProblem(canTemplates ? 'Choose a letter template.' : 'Enter the template code: a capital letter followed by capital letters, digits or _ (up to 40 characters).');
      preview.reset();
      return;
    }
    setProblem(null);
    preview.mutate(chosen);
  };
  const generateFinal = () => {
    if (busy || !canGenerate || current === null) return;
    generate.mutate(current.templateCode);
  };

  const blockedId = `${id}-blocked`;
  return (
    <Section title="Prepare a letter">
      <FormGrid aria-label="Choose a letter template" onSubmit={runPreview}>
        {canTemplates ? (
          <FormField>
            Letter template{' '}
            <NativeSelect value={code} disabled={busy} onChange={(e) => choose(e.target.value)}>
              <option value="">Choose…</option>
              {usable.map((t) => (
                <option key={t.id} value={t.code}>
                  {t.name} ({t.code}, revision {t.publishedRevision})
                </option>
              ))}
            </NativeSelect>
          </FormField>
        ) : (
          <FormField>
            Letter template code{' '}
            <Input value={code} maxLength={40} disabled={busy} onChange={(e) => choose(e.target.value.toUpperCase())} />
          </FormField>
        )}
        <Button type="submit" disabled={busy}>
          Preview letter
        </Button>
      </FormGrid>
      {canTemplates && templates.data && usable.length === 0 && <Hint>No letter template is active with a published revision yet.</Hint>}
      <LoadProblem error={templates.error} forbidden="The selected role cannot list letter templates." />
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <Refusal error={preview.error} words={words} />
      {preview.isPending && <Hint>Preparing the preview…</Hint>}

      {current && (
        <div role="region" aria-label="Letter preview" className="flex flex-col gap-3">
          <CardSubheading>
            Preview of {current.templateCode}, revision {current.templateRevision}
          </CardSubheading>
          <p className="m-0">
            <Badge tone="warn">preview only</Badge> This preview is not stored and nothing is sent to anyone.
          </p>
          {current.missing.length > 0 ? (
            <StatusNote tone="error" role="alert" id={blockedId}>
              The final letter cannot be generated until these mandatory values are recorded: {current.missing.map(name).join(', ')}.
            </StatusNote>
          ) : (
            <StatusNote tone="success">Every mandatory value is present.</StatusNote>
          )}
          <pre className={LETTER}>{current.text}</pre>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <Hint>
          Generating stores the final letter as a confidential file with its template revision and your name as generator. It is not sent; download it for manual
          delivery. Each generation stores a new letter.
        </Hint>
        {current === null && !generated && <Hint>Preview the letter first: the final letter is offered once a preview has every mandatory value.</Hint>}
        <ButtonRow>
          <Button type="button" disabled={busy || !canGenerate} aria-describedby={current && !canGenerate ? blockedId : undefined} onClick={generateFinal}>
            Generate the final letter
          </Button>
        </ButtonRow>
        <Refusal
          error={generate.error}
          words={words}
          noAnswer="No answer came back, so the letter may or may not have been stored. Check the employee’s stored letters before generating it again: each generation stores a new letter."
        />
      </div>

      {generated && (
        <div className="flex flex-col gap-3">
          <Notice
            notice={{ text: `Final letter stored: ${generated.templateCode}, revision ${generated.templateRevision}, letter number ${generated.outputNumber}.`, ok: true }}
          />
          <dl className="kv">
            <Item term="Template">{generated.templateCode}</Item>
            <Item term="Template revision">{generated.templateRevision}</Item>
            <Item term="Letter number">{generated.outputNumber}</Item>
            <Item term="Generated">
              <time dateTime={generated.generatedAt}>{when(generated.generatedAt)}</time>
            </Item>
            <Item term="Generated by">
              <UserRef userId={generated.generatedBy} />
            </Item>
            <Item term="Size">{generated.byteSize} bytes</Item>
            <Item term="Delivery">{labelOf(DELIVERY_LABEL, generated.deliveryState)}: sending letters is not available</Item>
          </dl>
          {can(LETTER_READ) ? (
            <ButtonRow>
              <OutputDownload output={generated} />
            </ButtonRow>
          ) : (
            <Hint>Downloading the stored letter needs the letter read grant.</Hint>
          )}
        </div>
      )}
    </Section>
  );
}

