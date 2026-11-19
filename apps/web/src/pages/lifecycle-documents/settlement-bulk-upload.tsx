// The settlement bulk upload: the lines of several drafts in one file (shared import lifecycle).
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { api, ApiError, fileToBase64, idempotencyKey, isForbidden, pinSession } from '../../api';
import { ErrorNote, NotPermitted, Section } from '../../ui';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, TemplateDownload, useBatchFollowUp } from '../records';
import { BULK_UPLOAD } from './refusals';
import { enc, useSettlementRefresh } from './shared';

/**
 * FR-054 bulk upload (CL-244): the lines of several drafts in one SETTLEMENT_LINES_V1 file, through the shared import
 * lifecycle: validate (a preview changes nothing), then apply or cancel; all or nothing; the file is scanned for
 * malware before any row is read; the user's own batches are listed below.
 */
export function SettlementBulkUpload() {
  const t = BULK_UPLOAD;
  const refreshSettlements = useSettlementRefresh();
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file: validating the same file again returns the same batch.
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };
  const { resume, open, refresh, watch } = useBatchFollowUp(
    t.base,
    {
      show: setJob,
      closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)),
      onStart: () => {
        upload.reset();
        act.reset();
      },
    },
    job,
  );
  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => {
      // The decision and any look at the batch after it go out under the role it was made in (BR-046).
      const send = pinSession();
      try {
        return await send<ImportJob>(`${t.base}/${enc(id)}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on (this very decision went through but its answer was lost): its view says where it stands.
        const current = await send<ImportJob>(`${t.base}/${enc(id)}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      // Applied lines change the drafts: every settlement list, queue and revision table loads again.
      if (view.state === 'COMMITTED') refreshSettlements();
    },
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey('settlement-lines'));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      act.reset();
      // The preview is on screen, so the form starts clean: the next file is a new upload with its own key.
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
    onSettled: refresh,
  });
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (file && !busy) upload.mutate(file);
  };
  return (
    <>
      <Section title="Bulk upload of settlement lines">
        <form onSubmit={submit} className="stack" aria-label="Bulk upload of settlement lines">
          <p className="hint">
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}), for as many draft settlements as you prepared. {t.note} Nothing changes until you
            apply a preview, and a file is applied all or nothing: one row with a problem rejects every settlement in it.
          </p>
          <TemplateDownload base={t.base} code={t.code} />
          <div className="inline">
            <label>
              Settlement lines file for several settlements (CSV)
              <input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={!file || busy}>
              Validate
            </button>
          </div>
        </form>
        {isForbidden(upload.error) ? <NotPermitted>The selected role cannot upload settlement lines.</NotPermitted> : <ErrorNote error={upload.error ?? resume.error} />}
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title="Your settlement lines batches" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

