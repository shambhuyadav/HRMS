// Preparing a settlement draft: the calculation, the lines editor and upload, submission and cancellation.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError, fileToBase64, formatDate, isConflict, readable } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { TemplateDownload } from '../records';
import { plural } from './calculation-basis';
import { CALCULATE_WORDS, LINES_WORDS, PREPARE_WORDS, Refusal, SUBMIT_WORDS, UPLOAD_WORDS } from './refusals';
import { isCalculatedLine } from './settlement-views';
import { AMOUNT, enc, GROUP, MAX_AMOUNT_TEXT, MAX_COMPONENT_CODE, MAX_LINE_REASON, MAX_LINES, MAX_REASON, MAX_UPLOAD_BYTES, SCROLL, SETTLEMENT_LINES, SHOWN_ROWS, TEXTAREA, UPLOAD_HEADER, UPLOAD_ROW_WORDS, UPLOAD_TEMPLATE, useKeys, useSettlementRefresh } from './shared';
import type { ExitCase, LineBody, LineInput, LineKind, SettlementDetail, SettlementLine, UploadResult } from './types';

export function PreparerActions({ s, exit, onNotice }: { s: SettlementDetail; exit: ExitCase | undefined; onNotice: (text: string) => void }) {
  const { me } = useSession();
  // An applied upload replaced every line on the server. Once the settlement has loaded again (a later version), the line
  // editor starts afresh from the lines the server now holds, so saving it never puts the replaced lines back.
  const [replacedAt, setReplacedAt] = useState<number | null>(null);
  const [editorKey, setEditorKey] = useState('lines');
  if (replacedAt !== null && s.version !== replacedAt) {
    setReplacedAt(null);
    setEditorKey(`lines-after-upload-${s.version}`);
  }
  // Submitting freezes the saved lines: while the line editor holds changes not saved yet, the revision is not submitted.
  const [unsavedLines, setUnsavedLines] = useState(false);
  if (me?.userId !== s.preparedBy) {
    return (
      <Section title="Prepare this revision">
        <p className="hint">Only the HR Administrator who prepared this revision can change, submit or cancel it.</p>
      </Section>
    );
  }
  const calculated = s.calculationStatus === 'CALCULATED';
  return (
    <>
      <CalculateDraft s={s} unsavedLines={s.lines !== undefined && unsavedLines} />
      {s.lines !== undefined ? (
        // A new calculation snapshot changes which lines the editor holds: it starts again from the server's lines.
        <LinesEditor key={`${editorKey}-${s.calculation?.id ?? 'not-calculated'}`} s={s} onUnsaved={setUnsavedLines} />
      ) : (
        <Section title="Enter the lines">
          <p className="hint">The selected role does not receive settlement amounts, so the lines cannot be edited here.</p>
        </Section>
      )}
      {calculated ? (
        <Section title="Upload the lines">
          <p className="hint">
            This draft is calculated, so its lines are not uploaded: an upload would replace the calculated lines. Enter the lines for components the calculation does not
            produce in the line editor, each with its reason.
          </p>
        </Section>
      ) : (
        <LinesUpload s={s} exit={exit} onReplaced={setReplacedAt} />
      )}
      <SubmitDraft s={s} onNotice={onNotice} unsavedLines={s.lines !== undefined && unsavedLines} />
      <CancelDraft s={s} onNotice={onNotice} />
    </>
  );
}

/**
 * FR-052 (I-88): the preparer calculates the draft on the server, from a snapshot taken now, against its version; calculating again
 * takes a new snapshot. The calculated lines replace the earlier calculated ones; lines entered for other components stay.
 */
function CalculateDraft({ s, unsavedLines }: { s: SettlementDetail; unsavedLines: boolean }) {
  const qc = useQueryClient();
  const keys = useKeys();
  const refresh = useSettlementRefresh();
  const blockedId = `${useId()}-unsaved`;
  const [done, setDone] = useState<string | null>(null);
  const again = s.calculationStatus === 'CALCULATED';
  const calculate = useMutation({
    mutationFn: (version: number) => api<SettlementDetail>(`/v1/settlements/${enc(s.id)}/calculate`, { body: { expectedVersion: version } }),
    onMutate: () => setDone(null),
    onSuccess: (saved) => {
      // The answer is the settlement as calculated: shown at once, then every list and queue that shows it loads again.
      qc.setQueryData(keys.settlement(saved.id), saved);
      const k = saved.calculation;
      setDone(
        k
          ? `Calculated: snapshot ${k.sequence}, ${plural(String(k.itemCount), 'item', 'items')}${k.blockingCount > 0 ? `, ${k.blockingCount} blocking approval` : ', nothing blocking approval'}.`
          : 'Calculated.',
      );
      refresh(saved);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  return (
    <Section title="Calculate">
      <p className="hint">
        The server calculates this draft from a snapshot taken now, under the settlement policy and the statutory rule packs in force on the last working date. Its items
        become the calculated lines; lines entered for components it does not produce stay. An item whose policy, rule pack or record is missing is shown as such and
        blocks approval. {again ? 'Calculating again takes a new snapshot and replaces the calculated lines.' : ''}
      </p>
      {unsavedLines && (
        <p className="hint" id={blockedId}>
          Save the lines first: the calculation keeps the saved entered lines, not changes still in the line editor.
        </p>
      )}
      <div className="row">
        <button type="button" disabled={calculate.isPending || unsavedLines} aria-describedby={unsavedLines ? blockedId : undefined} onClick={() => calculate.mutate(s.version)}>
          {again ? 'Calculate again' : 'Calculate'}
        </button>
      </div>
      {done && (
        <p className="ok" role="status">
          {done}
        </p>
      )}
      <Refusal
        error={calculate.error}
        words={CALCULATE_WORDS}
        noAnswer="No answer came back, so the draft may or may not have been calculated. The settlement has been reloaded: check its calculation before trying again."
      />
    </Section>
  );
}

interface LineRow extends LineInput {
  key: number;
}

const kindOf = (l: SettlementLine): LineKind => (l.lineKind === 'NOTICE_ADJUSTMENT' ? 'NOTICE_ADJUSTMENT' : 'STANDARD');

/** Whether the editor's rows are exactly the lines the server returned (compared as text, never as numbers). */
const sameLines = (rows: readonly LineInput[], lines: readonly SettlementLine[]) =>
  rows.length === lines.length &&
  rows.every((r, i) => {
    const l = lines[i]!;
    return r.componentCode.trim() === l.componentCode && r.amount.trim() === l.amount && r.lineKind === kindOf(l) && r.reason.trim() === (l.reason ?? '');
  });

/**
 * The draft's lines, replaced as a whole against the settlement's version (PUT /v1/settlements/:id/lines). On a calculated draft
 * (I-88) the editor holds only the entered lines: the server keeps the calculated ones and replaces the entered ones, each of which
 * states its reason.
 */
function LinesEditor({ s, onUnsaved }: { s: SettlementDetail; onUnsaved: (unsaved: boolean) => void }) {
  const refresh = useSettlementRefresh();
  const next = useRef(0);
  const calculated = s.calculationStatus === 'CALCULATED';
  /** The lines this editor replaces: every line, or on a calculated draft the entered ones only. */
  const editable = (lines: readonly SettlementLine[] | undefined) => (lines ?? []).filter((l) => !calculated || !isCalculatedLine(l));
  const toRows = (lines: readonly SettlementLine[]): LineRow[] =>
    lines.map((l) => ({ key: next.current++, componentCode: l.componentCode, amount: l.amount, lineKind: kindOf(l), reason: l.reason ?? '' }));
  const [rows, setRows] = useState<LineRow[]>(() => toRows(editable(s.lines)));
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { lines: LineBody[]; expectedVersion: number }) => api<SettlementDetail>(`/v1/settlements/${enc(s.id)}/lines`, { method: 'PUT', body }),
    onMutate: () => setNotice(null),
    // Saved: the editor shows the lines as the server holds them now. Refused: what was typed stays.
    onSuccess: (saved, body) => {
      setRows(toRows(editable(saved.lines)));
      setNotice(body.lines.length === 1 ? 'Saved 1 line.' : `Saved ${body.lines.length} lines.`);
      refresh(saved);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  // Rows that differ from the server's lines are not saved yet (submitting would freeze the saved ones instead).
  const unsaved = !sameLines(rows, editable(s.lines));
  useEffect(() => onUnsaved(unsaved), [unsaved, onUnsaved]);
  useEffect(() => () => onUnsaved(false), [onUnsaved]);
  const change = (key: number, patch: Partial<LineInput>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => setRows((prev) => (prev.length >= MAX_LINES ? prev : [...prev, { key: next.current++, componentCode: '', amount: '', lineKind: 'STANDARD', reason: '' }]));
  const remove = (key: number) => setRows((prev) => prev.filter((r) => r.key !== key));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    // Format checks only: components, signs, duplicates and the notice period are the server's to check.
    let missing: string | null = null;
    rows.forEach((r, i) => {
      if (missing !== null) return;
      if (!r.componentCode.trim()) missing = `Line ${i + 1}: enter the pay component code.`;
      else if (!AMOUNT.test(r.amount.trim())) missing = `Line ${i + 1}: enter the amount as a decimal number with up to 15 digits and 4 decimal places (a minus sign for a deduction).`;
      else if (calculated && !r.reason.trim()) missing = `Line ${i + 1}: enter why this line is entered: this draft is calculated, so each entered line states its reason.`;
      else if (r.reason.trim().length > MAX_LINE_REASON) missing = `Line ${i + 1}: a line’s reason has at most ${MAX_LINE_REASON} characters.`;
    });
    setProblem(missing);
    if (missing !== null) {
      save.reset();
      return;
    }
    save.mutate({
      lines: rows.map((r) => {
        const reason = r.reason.trim();
        return { componentCode: r.componentCode.trim(), amount: r.amount.trim(), lineKind: r.lineKind, ...(reason ? { reason } : {}) };
      }),
      expectedVersion: s.version,
    });
  };
  return (
    <Section title={calculated ? 'Enter lines for other components' : 'Enter the lines'}>
      {calculated ? (
        <p className="hint">
          This draft is calculated: its calculated lines stay as the calculation made them. Entered lines are for components the calculation does not produce, one line per
          pay component, each with the reason it is entered. Saving replaces the entered lines only, and the server records the net amount.
        </p>
      ) : (
        <p className="hint">
          One line per pay component. Earnings are zero or positive and deductions zero or negative; a notice adjustment needs the exit’s contractual notice period.
          Saving replaces every line of this draft, and the server records the net amount.
        </p>
      )}
      <form className="stack" aria-label="Settlement lines" onSubmit={submit}>
        {rows.length === 0 && <Empty>{calculated ? 'No entered lines. Add one for a component the calculation does not produce.' : 'No lines. Add one to start.'}</Empty>}
        {rows.map((r, i) => (
          <fieldset key={r.key} style={GROUP}>
            <legend>Line {i + 1}</legend>
            <div className="row">
              <label>
                Pay component code
                <input value={r.componentCode} maxLength={MAX_COMPONENT_CODE} disabled={save.isPending} onChange={(e) => change(r.key, { componentCode: e.target.value.toUpperCase() })} />
              </label>
              <label>
                Amount
                <input value={r.amount} maxLength={MAX_AMOUNT_TEXT} inputMode="decimal" disabled={save.isPending} onChange={(e) => change(r.key, { amount: e.target.value })} />
              </label>
              <label>
                Line kind
                <select value={r.lineKind} disabled={save.isPending} onChange={(e) => change(r.key, { lineKind: e.target.value === 'NOTICE_ADJUSTMENT' ? 'NOTICE_ADJUSTMENT' : 'STANDARD' })}>
                  <option value="STANDARD">Standard</option>
                  <option value="NOTICE_ADJUSTMENT">Notice adjustment</option>
                </select>
              </label>
              <label>
                {calculated ? 'Reason (required)' : 'Reason (optional)'}
                <input value={r.reason} maxLength={MAX_LINE_REASON} disabled={save.isPending} onChange={(e) => change(r.key, { reason: e.target.value })} />
              </label>
              <button type="button" className="secondary" disabled={save.isPending} aria-label={`Remove line ${i + 1}`} onClick={() => remove(r.key)}>
                Remove
              </button>
            </div>
          </fieldset>
        ))}
        <div className="row">
          <button type="button" className="secondary" disabled={save.isPending || rows.length >= MAX_LINES} onClick={add}>
            Add a line
          </button>
          <button type="submit" disabled={save.isPending}>
            Save lines
          </button>
        </div>
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <Refusal
          error={save.error}
          words={LINES_WORDS}
          noAnswer="No answer came back, so the lines may or may not have been saved. The settlement has been reloaded: check it before saving again."
        />
        {notice && (
          <p className="ok" role="status">
            {notice}
          </p>
        )}
      </form>
    </Section>
  );
}

/**
 * FR-054 upload (template SETTLEMENT_LINES_V1): checked as a whole, all or nothing; a check changes nothing. The file is
 * read at once and not stored, so it is not held for a malware scan.
 */
function LinesUpload({ s, exit, onReplaced }: { s: SettlementDetail; exit: ExitCase | undefined; onReplaced: (version: number) => void }) {
  const refresh = useSettlementRefresh();
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its lines are applied.
  const [inputKey, setInputKey] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const upload = useMutation({
    mutationFn: async (input: { file: File; dryRun: boolean; version: number }) =>
      api<UploadResult>(`/v1/settlements/${enc(s.id)}/upload`, { body: { contentBase64: await fileToBase64(input.file), dryRun: input.dryRun, expectedVersion: input.version } }),
    onMutate: () => setResult(null),
    onSuccess: (r, input) => {
      setResult(r);
      if (r.applied) {
        setFile(null);
        setInputKey((n) => n + 1);
        // The lines were replaced at this version; the editor starts again from the server's lines once they load.
        onReplaced(input.version);
        refresh(s);
      }
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  const send = (dryRun: boolean) => {
    if (upload.isPending) return;
    const missing = !file
      ? 'Choose the CSV file to upload.'
      : file.size === 0
        ? 'The chosen file is empty.'
        : file.size > MAX_UPLOAD_BYTES
          ? `The file is larger than one upload takes (${MAX_UPLOAD_BYTES.toLocaleString('en-IN')} bytes).`
          : null;
    setProblem(missing);
    if (missing !== null || !file) {
      upload.reset();
      return;
    }
    upload.mutate({ file, dryRun, version: s.version });
  };
  const problems = result ? result.errors.filter((e) => e.code !== 'BATCH_REJECTED') : [];
  const ordered = result ? [...problems, ...result.errors.filter((e) => e.code === 'BATCH_REJECTED')] : [];
  return (
    <Section title="Upload the lines">
      <p className="hint">
        CSV with exactly the header <code>{UPLOAD_HEADER}</code> (template {UPLOAD_TEMPLATE}). Every row names this employee’s code ({s.employeeCode}) and the
        approved last working date{exit?.approvedLastWorkingDate ? ` (${formatDate(exit.approvedLastWorkingDate)})` : ' of the exit'}; one row per pay component; the
        line kind is STANDARD, NOTICE_ADJUSTMENT or blank. The file replaces every line of this draft, all or nothing. It is read at once and not kept.
      </p>
      {/* DF09 published template: GET /v1/settlements/lines/template, under the preparation grant the upload needs. */}
      <TemplateDownload base={SETTLEMENT_LINES} code={UPLOAD_TEMPLATE} />
      <div className="row">
        <label>
          Settlement lines file (CSV)
          <input
            key={inputKey}
            type="file"
            accept=".csv,text/csv"
            disabled={upload.isPending}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
            }}
          />
        </label>
      </div>
      <div className="row">
        <button type="button" className="secondary" disabled={upload.isPending} onClick={() => send(true)}>
          Check the file
        </button>
        <button type="button" disabled={upload.isPending} onClick={() => send(false)}>
          Upload and replace the lines
        </button>
      </div>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Refusal
        error={upload.error}
        words={UPLOAD_WORDS}
        noAnswer="No answer came back, so the lines may or may not have been replaced. The settlement has been reloaded: check it before uploading again."
      />
      {result && (
        <div className="stack" role="status">
          {result.applied ? (
            <p className="ok">
              Uploaded: {result.accepted} of {result.total} rows replaced the lines of this draft.
            </p>
          ) : result.dryRun && result.rejected === 0 ? (
            <p className="ok">
              The file is valid: its {result.total} rows would replace the lines of this draft. Nothing was changed (check only).
            </p>
          ) : (
            <p className="error">
              The file was rejected, so nothing was changed: {problems.length} of {result.total} rows have a problem.
            </p>
          )}
          {ordered.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Upload problems">
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {ordered.slice(0, SHOWN_ROWS).map((e) => (
                    <tr key={e.row}>
                      <td>{e.row}</td>
                      <td>
                        {UPLOAD_ROW_WORDS[e.code] ?? readable(e.code)} <span className="hint">{e.code}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ordered.length > SHOWN_ROWS && <p className="hint">Showing the first {SHOWN_ROWS} of {ordered.length} rows.</p>}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function SubmitDraft({ s, onNotice, unsavedLines }: { s: SettlementDetail; onNotice: (text: string) => void; unsavedLines: boolean }) {
  const refresh = useSettlementRefresh();
  const blockedId = `${useId()}-unsaved`;
  const submit = useMutation({
    mutationFn: (version: number) => api<SettlementDetail>(`/v1/settlements/${enc(s.id)}/submit`, { body: { expectedVersion: version } }),
    onSuccess: (saved) => {
      onNotice(`Revision ${saved.revision} submitted: it is frozen and waits for an independent review.`);
      refresh(saved);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  return (
    <Section title="Submit for review">
      <p className="hint">
        Submitting freezes revision {s.revision}: its lines can no longer change. An independent reviewer and then an independent approver decide it; neither can be you.
      </p>
      {unsavedLines && (
        <p className="hint" id={blockedId}>
          Save the lines first: submitting freezes the saved lines, not changes still in the line editor.
        </p>
      )}
      <div className="row">
        <button type="button" disabled={submit.isPending || unsavedLines} aria-describedby={unsavedLines ? blockedId : undefined} onClick={() => submit.mutate(s.version)}>
          Submit revision {s.revision} for review
        </button>
      </div>
      <Refusal
        error={submit.error}
        words={SUBMIT_WORDS}
        noAnswer="No answer came back, so the revision may or may not have been submitted. It has been reloaded: check its state before trying again."
      />
    </Section>
  );
}

function CancelDraft({ s, onNotice }: { s: SettlementDetail; onNotice: (text: string) => void }) {
  const refresh = useSettlementRefresh();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (body: { expectedVersion: number; reason: string }) => api<SettlementDetail>(`/v1/settlements/${enc(s.id)}/cancel`, { body }),
    onSuccess: (saved) => {
      setReason('');
      onNotice(`Revision ${saved.revision} cancelled. A new revision can be prepared from the exit’s settlements.`);
      refresh(saved);
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh(s);
    },
  });
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (cancel.isPending) return;
    const text = reason.trim();
    setProblem(text ? null : 'Enter why the draft is cancelled.');
    if (!text) {
      cancel.reset();
      return;
    }
    cancel.mutate({ expectedVersion: s.version, reason: text });
  };
  return (
    <Section title="Cancel this draft">
      <form className="stack" aria-label="Cancel this draft" onSubmit={send}>
        <label>
          Reason for cancelling (required)
          <textarea rows={2} maxLength={MAX_REASON} value={reason} disabled={cancel.isPending} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <div className="row">
          <button type="submit" className="danger" disabled={cancel.isPending}>
            Cancel the draft
          </button>
        </div>
        <Refusal error={cancel.error} words={PREPARE_WORDS} />
      </form>
    </Section>
  );
}

