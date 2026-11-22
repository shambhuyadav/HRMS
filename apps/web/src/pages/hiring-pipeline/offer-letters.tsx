// Offer letters (FR-014, FR-017, FR-018; DF09): preview, generation, download and the delivery record.
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react';
import { type FormEvent, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, download, formatDate, idempotencyKey, isConflict, localDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Notice, Section } from '../../ui';
import { DELIVERY_WORDS, LETTER_DOWNLOAD_WORDS, LETTER_ISSUE_WORDS, LoadProblem, Refusal, refusalText, type Words } from './refusals';
import {
  COMPENSATION_READ,
  DELIVERY_CATEGORY,
  enc,
  ISSUE_LETTER,
  labelOf,
  LETTER_DELIVERY_LABEL,
  LETTER_ISSUING_STATES,
  LETTER_TEMPLATE_READ,
  OFFER_LETTER_TYPE,
  OFFER_STATE_LABEL,
  PATHS,
  PREFORMATTED,
  Problem,
  TEMPLATE_CODE,
  useKeys,
  useRefresh,
} from './shared';
import type { DeliveryRecorded, LetterTemplateSummary, OfferLetter, OfferLetterListed, OfferLetterPreview, OfferLetters, OfferView, ReferenceValues } from './types';

// ---------------------------------------------------------------------------------------------------------
// FR-014, FR-017, FR-018 offer letters (I-82 item 1; DF09): issued from the approved offer before the candidate is an
// employee, by an eligible HR Administrator; never sent by the system: downloaded, handed over, and the delivery recorded
// ---------------------------------------------------------------------------------------------------------

/** An offer placeholder by its approved label when the list is at hand, always with its key. */
function placeholderName(labels: ReadonlyMap<string, string>, key: string): string {
  const label = labels.get(key);
  return label ? `${label} ({{${key}}})` : `{{${key}}}`;
}

const missingOf = (error: ApiError) => {
  const value = (error.details as { missing?: unknown } | undefined)?.missing;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
};

function deliveryText(l: OfferLetterListed): string {
  if (l.delivery) return `Delivered: ${l.delivery.methodLabel ?? readable(l.delivery.method)} on ${formatDate(l.delivery.deliveredOn)}`;
  if (l.deliveryState === 'DELIVERED') return labelOf(LETTER_DELIVERY_LABEL, l.deliveryState);
  return l.current
    ? labelOf(LETTER_DELIVERY_LABEL, l.deliveryState)
    : 'Not delivered, and no longer deliverable: it carries an earlier revision of the offer, or the offer is no longer approved or accepted';
}

export function OfferLettersSection({ offer: o }: { offer: OfferView }) {
  const { can } = useSession();
  const keys = useKeys();
  const canRead = can(COMPENSATION_READ);
  const canIssue = can(ISSUE_LETTER);
  const issuing = canIssue && LETTER_ISSUING_STATES.includes(o.state);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const letters = useQuery({
    queryKey: keys.offerLetters(o.id),
    enabled: canRead,
    queryFn: () => api<OfferLetters>(`/v1/hiring/offers/${enc(o.id)}/letters`),
    retry: retryTransient,
  });
  const open = useMutation({ mutationFn: (l: OfferLetter) => download(`/v1/hiring/offer-letters/${enc(l.id)}/content`) });
  const items = letters.data?.items ?? [];
  const deliverable = canIssue ? items.filter((l) => l.deliveryState === 'NOT_DELIVERED' && l.current) : [];
  return (
    <Section title="Offer letters (confidential)">
      <Hint>
        The system never e-mails or sends an offer letter. Download the letter here and hand it to the candidate yourself, outside the system; then record how and when it
        was delivered.
      </Hint>
      {canRead ? (
        <>
          {letters.isPending && <LoadingLine>Loading the offer letters…</LoadingLine>}
          <LoadProblem error={letters.error} forbidden="The selected role cannot read this offer’s letters." missing="This offer’s letters are not available in the selected role’s scope." />
          {letters.data && items.length === 0 && <Empty>No offer letter has been generated for this offer.</Empty>}
          {items.length > 0 && <OfferLetterTable items={items} busy={open.isPending} onOpen={(l) => open.mutate(l)} />}
          <Refusal error={open.error} words={LETTER_DOWNLOAD_WORDS} />
        </>
      ) : (
        <Hint>Reading and downloading stored letters, and recording their delivery, needs the grant that reads the offer compensation.</Hint>
      )}
      <Notice notice={message} />
      {deliverable.length > 0 && <DeliveryForms letters={deliverable} offer={o} onFinished={(text, ok) => setMessage({ text, ok })} />}
      {issuing && <OfferLetterComposer offer={o} />}
      {canIssue && !issuing && <Hint>{`Only an approved or accepted offer issues a letter. This offer’s state: ${labelOf(OFFER_STATE_LABEL, o.state)}.`}</Hint>}
    </Section>
  );
}

function OfferLetterTable({ items, busy, onOpen }: { items: OfferLetterListed[]; busy: boolean; onOpen: (l: OfferLetter) => void }) {
  return (
    <Table aria-label="Offer letters">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Letter number</TableHead>
          <TableHead scope="col">Template</TableHead>
          <TableHead scope="col">Offer revision</TableHead>
          <TableHead scope="col">Generated</TableHead>
          <TableHead scope="col">Delivery</TableHead>
          <TableHead scope="col">
            <span className="sr-only">Download</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((l) => (
          <TableRow key={l.id}>
            <TableCell>{l.outputNumber}</TableCell>
            <TableCell>{`${l.templateCode}, revision ${l.templateRevision}`}</TableCell>
            <TableCell>{l.offerRevision}</TableCell>
            <TableCell>{formatDate(l.generatedAt)}</TableCell>
            <TableCell>{deliveryText(l)}</TableCell>
            <RowActionsCell>
              <RowActions>
                <Button type="button" variant="outline" size="sm" disabled={busy} aria-label={`Download offer letter ${l.outputNumber}`} onClick={() => onOpen(l)}>
                  Download
                </Button>
              </RowActions>
            </RowActionsCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Preview, then the final letter from a preview with every mandatory value (FR-017, FR-018). A preview stores and sends
 * nothing. Each generation is a new user action with a new idempotency key (ZT07); only sending it again after an
 * attempt whose answer never came back reuses that key, so the server answers with what it stored instead of a second letter.
 */
function OfferLetterComposer({ offer: o }: { offer: OfferView }) {
  const { can } = useSession();
  const keys = useKeys();
  const refresh = useRefresh();
  const id = useId();
  const canTemplates = can(LETTER_TEMPLATE_READ);
  const templates = useQuery({
    enabled: canTemplates,
    queryKey: keys.letterTemplates,
    queryFn: () => api<{ items: LetterTemplateSummary[] }>('/v1/letter-templates'),
    retry: retryTransient,
  });
  const placeholders = useQuery({
    enabled: canTemplates,
    queryKey: keys.offerPlaceholders,
    queryFn: () => api<{ items: { key: string; label: string }[] }>(`/v1/letter-placeholders?letterType=${enc(OFFER_LETTER_TYPE)}`),
    retry: retryTransient,
    staleTime: 5 * 60_000,
  });
  const labels = useMemo(() => new Map((placeholders.data?.items ?? []).map((p) => [p.key, p.label])), [placeholders.data]);
  const words = useMemo<Words>(
    () => ({
      ...LETTER_ISSUE_WORDS,
      MISSING_PLACEHOLDER: (e) =>
        `The final letter was not generated: mandatory values are missing from the approved offer: ${missingOf(e)
          .map((k) => placeholderName(labels, k))
          .join(', ')}.`,
    }),
    [labels],
  );
  const usable = (templates.data?.items ?? []).filter((t) => t.letterType === OFFER_LETTER_TYPE && t.active && t.publishedRevision !== null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<OfferLetterPreview | null>(null);
  const [generated, setGenerated] = useState<(OfferLetter & { replayed?: boolean }) | null>(null);
  /** The generation whose answer never came back: sending the same template again carries its key. */
  const unanswered = useRef<{ templateCode: string; key: string } | null>(null);
  const generate = useMutation({
    mutationFn: (body: { templateCode: string; idempotencyKey: string }) => api<OfferLetter & { replayed?: boolean }>(`/v1/hiring/offers/${enc(o.id)}/letters`, { body }),
    onSuccess: (letter) => {
      unanswered.current = null;
      setGenerated(letter);
      setShown(null);
      setCode('');
      refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        // Answered: nothing was stored under this key, so the next attempt is a new one.
        unanswered.current = null;
        if (isConflict(error)) refresh();
      } else {
        // No answer: the letter may have been stored; the list shows whether it was.
        refresh();
      }
    },
  });
  const preview = useMutation({
    mutationFn: (templateCode: string) => api<OfferLetterPreview>(`/v1/hiring/offers/${enc(o.id)}/letter-preview`, { body: { templateCode } }),
    onMutate: () => {
      setShown(null);
      setGenerated(null);
      generate.reset();
    },
    onSuccess: setShown,
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
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
    if (!TEMPLATE_CODE.test(chosen)) {
      setProblem(canTemplates ? 'Choose an offer letter template.' : 'Enter the template code: a capital letter followed by capital letters, digits or _ (up to 40 characters).');
      preview.reset();
      return;
    }
    setProblem(null);
    preview.mutate(chosen);
  };
  const generateFinal = () => {
    if (busy || !canGenerate || current === null) return;
    const last = unanswered.current;
    const key = last !== null && last.templateCode === current.templateCode ? last.key : idempotencyKey('offer-letter');
    unanswered.current = { templateCode: current.templateCode, key };
    generate.mutate({ templateCode: current.templateCode, idempotencyKey: key });
  };

  const blockedId = `${id}-blocked`;
  return (
    <div className="flex flex-col gap-3">
      <CardSubheading>Issue an offer letter</CardSubheading>
      <Hint>
        The letter takes its values from the offer’s approved revision {o.currentRevision}: the candidate, the requisition’s post, the proposed joining date and the
        compensation. Nothing is typed into a letter, and a missing mandatory value blocks the final letter.
      </Hint>
      <FormGrid aria-label="Choose an offer letter template" onSubmit={runPreview} noValidate>
        {canTemplates ? (
          <FormField>
            Offer letter template{' '}
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
            Offer letter template code{' '}
            <Input value={code} maxLength={40} disabled={busy} onChange={(e) => choose(e.target.value.toUpperCase())} />
          </FormField>
        )}
        <Button type="submit" disabled={busy}>
          Preview
        </Button>
      </FormGrid>
      {canTemplates && templates.data && usable.length === 0 && (
        <Hint>
          No offer letter template is active with a published revision. HR writes and publishes one of the offer letter type under{' '}
          <Link to={PATHS.letterTemplates}>Letter templates</Link>.
        </Hint>
      )}
      <LoadProblem error={templates.error} forbidden="The selected role cannot list letter templates." />
      <Problem text={problem} />
      <Refusal error={preview.error} words={words} />
      {preview.isPending && <Hint>Preparing the preview…</Hint>}
      {current && <LetterPreview preview={current} labels={labels} blockedId={blockedId} />}
      <Hint>
        Generating stores the final letter as a confidential file with its template revision, the offer revision and you as its generator. It is not sent: download it
        from the list of offer letters and hand it to the candidate.
      </Hint>
      {current === null && !generated && <Hint>Preview the letter first: the final letter is offered once a preview has every mandatory value.</Hint>}
      <ButtonRow>
        <Button type="button" disabled={busy || !canGenerate} aria-describedby={current && !canGenerate ? blockedId : undefined} onClick={generateFinal}>
          Generate final letter
        </Button>
      </ButtonRow>
      {generate.error instanceof ApiError ? (
        <Refusal error={generate.error} words={words} />
      ) : (
        generate.error && (
          <Problem text="No answer came back, so the letter may or may not have been stored; the offer letters have been read again. Generating it again from the same template stores it at most once." />
        )
      )}
      {generated && (
        <Notice
          notice={{
            text: `${generated.replayed ? 'The letter was already stored by the earlier attempt: ' : 'Final letter stored: '}letter number ${generated.outputNumber} (${generated.templateCode}, revision ${generated.templateRevision}; offer revision ${generated.offerRevision}). It was not sent: download it, hand it to the candidate and record the delivery.`,
            ok: true,
          }}
        />
      )}
    </div>
  );
}

/**
 * A preview of the letter, which stores and sends nothing: whether the final letter can be generated, then the text. The line
 * saying every mandatory value is present has the success look but no role: it describes the preview, it is not an action's outcome.
 */
function LetterPreview({ preview, labels, blockedId }: { preview: OfferLetterPreview; labels: ReadonlyMap<string, string>; blockedId: string }) {
  return (
    <div role="region" aria-label="Offer letter preview">
      <CardSubheading level={4}>
        Preview of {preview.templateCode}, revision {preview.templateRevision}, for offer revision {preview.offerRevision}
      </CardSubheading>
      <p>
        <Badge tone="warn">preview only</Badge> Nothing was stored or sent.
      </p>
      {preview.missing.length > 0 ? (
        <Alert asChild variant="destructive">
          <p id={blockedId} role="alert" className="error">
            <CircleAlertIcon aria-hidden="true" />
            The final letter cannot be generated while the approved offer lacks these mandatory values: {preview.missing.map((k) => placeholderName(labels, k)).join(', ')}.
          </p>
        </Alert>
      ) : (
        // An Alert says role="alert" unless told otherwise; this line has none.
        <Alert asChild variant="success" role={undefined}>
          <p className="ok">
            <CircleCheckIcon aria-hidden="true" />
            Every mandatory value is present.
          </p>
        </Alert>
      )}
      <pre className={PREFORMATTED}>{preview.text}</pre>
    </div>
  );
}

/** The delivery methods of the company list, then one form per letter whose delivery can still be recorded. */
function DeliveryForms({ letters, offer: o, onFinished }: { letters: OfferLetterListed[]; offer: OfferView; onFinished: (text: string, ok: boolean) => void }) {
  const keys = useKeys();
  const methods = useQuery({
    queryKey: keys.referenceValues(DELIVERY_CATEGORY),
    queryFn: () => api<ReferenceValues>(`/v1/hiring/reference-values?category=${enc(DELIVERY_CATEGORY)}`),
    retry: retryTransient,
  });
  const choices = methods.data?.items ?? [];
  return (
    <>
      {methods.isPending && <LoadingLine>Loading the delivery methods…</LoadingLine>}
      <LoadProblem error={methods.error} forbidden="The selected role cannot list the delivery methods of offer letters." />
      {methods.data && choices.length === 0 && <Hint>No delivery method of offer letters is active in this company. Ask HR to set one up.</Hint>}
      {choices.length > 0 && letters.map((l) => <DeliveryForm key={l.id} letter={l} offer={o} methods={choices} onFinished={onFinished} />)}
    </>
  );
}

/** The delivery's required answers, checked before sending; whether the date is acceptable is the server's call. */
function deliveryProblem(method: string, deliveredOn: string, confirmed: boolean, recipient: string): string | null {
  if (!method) return 'Choose how the letter was delivered.';
  if (!deliveredOn) return 'Enter the date the letter was delivered.';
  if (!confirmed) return `Confirm that the letter went to the offer’s candidate, ${recipient}.`;
  return null;
}

function DeliveryForm({
  letter: l,
  offer: o,
  methods,
  onFinished,
}: {
  letter: OfferLetterListed;
  offer: OfferView;
  methods: ReferenceValues['items'];
  onFinished: (text: string, ok: boolean) => void;
}) {
  const refresh = useRefresh();
  const id = useId();
  const [method, setMethod] = useState('');
  const [deliveredOn, setDeliveredOn] = useState(() => localDate());
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const recipient = `${o.candidate.fullName} (${o.candidate.candidateCode})`;
  const record = useMutation({
    mutationFn: (body: { deliveryMethod: string; deliveredOn: string; recipientConfirmed: true }) => api<DeliveryRecorded>(`/v1/hiring/offer-letters/${enc(l.id)}/delivery`, { body }),
    onSuccess: (result) => {
      const label = methods.find((m) => m.code === result.deliveryMethod)?.label ?? readable(result.deliveryMethod);
      onFinished(`Recorded the delivery of offer letter ${l.outputNumber} to ${recipient}: ${label} on ${formatDate(result.deliveredOn)}.`, true);
      refresh();
    },
    onError: (error) => {
      // Delivered, superseded or no longer approved meanwhile: the letters are read again and this form may go.
      if (isConflict(error)) {
        onFinished(`Offer letter ${l.outputNumber}: ${refusalText(error, DELIVERY_WORDS) ?? error.message}`, false);
        refresh();
      }
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (record.isPending) return;
    const missing = deliveryProblem(method, deliveredOn, confirmed, recipient);
    setProblem(missing);
    if (missing) {
      record.reset();
      return;
    }
    record.mutate({ deliveryMethod: method, deliveredOn, recipientConfirmed: true });
  };
  return (
    <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
      <CardSubheading id={`${id}-title`}>Record the delivery of offer letter {l.outputNumber}</CardSubheading>
      <FormField>
        Delivery method (required)
        <NativeSelect value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">Choose…</option>
          {methods.map((m) => (
            <option key={m.code} value={m.code}>
              {m.label}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField>
        Delivered on (required)
        <Input type="date" required value={deliveredOn} onChange={(e) => setDeliveredOn(e.target.value)} />
      </FormField>
      <CheckField className="col-span-full">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> The letter went to the offer’s candidate, {recipient}
      </CheckField>
      <Hint>Record the delivery once the letter is in the candidate’s hands. A recorded delivery is final.</Hint>
      <Problem text={problem} />
      {record.error && !isConflict(record.error) && (
        <div className="col-span-full">
          <Refusal error={record.error} words={DELIVERY_WORDS} />
        </div>
      )}
      <ButtonRow className="col-span-full">
        <Button type="submit" disabled={record.isPending}>
          Record delivery
        </Button>
      </ButtonRow>
    </FormGrid>
  );
}
