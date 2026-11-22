// The CITY_MASTER_V1 upload (CL-006; DF09) at /v1/org/city-imports, through the shared import steps of the records screen: stage
// the file, read the preview, add the cities or cancel; all rows or none.
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError, fileToBase64, idempotencyKey } from '../../api';
import { ErrorNote, Section } from '../../ui';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from '../records';
import { MASTER_CREATE } from './shared';

const CITY_TEMPLATE: ImportTemplate = {
  code: 'CITY_MASTER_V1',
  label: 'Cities',
  permissions: [MASTER_CREATE],
  base: '/v1/org/city-imports',
  columns: 'stateCode,cityCode,cityName',
  keyLabel: 'State / city code',
  noun: ['city', 'cities'],
  verb: 'Add',
  note: 'One new city per row: the two-letter code of an Indian state or union territory (for example MH), a city code unique within that state, and the city’s name.',
  problems: {
    UNKNOWN_STATE: 'There is no such state in the state master.',
    STATE_NOT_IN_FORCE: 'The state is inactive or outside its period.',
    INVALID_CITY_CODE: 'The city code is not valid: letters, digits, hyphens and underscores, up to 40.',
    INVALID_CITY_NAME: 'The city name is empty or longer than 200 characters.',
    DUPLICATE_CITY: 'This state already has a city with this code.',
    DUPLICATE_IN_BATCH: 'An earlier row of the file has the same state and city code.',
    COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
  },
};

export function CityUpload({ onCommitted }: { onCommitted: () => void }) {
  const t = CITY_TEMPLATE;
  const [file, setFile] = useState<File | null>(null);
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file: uploading the same file again returns the same batch.
  const uploadKey = useRef<string | null>(null);
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
    mutationFn: ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => api<ImportJob>(`${t.base}/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      if (view.state === 'COMMITTED') onCommitted();
    },
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey('cities'));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      act.reset();
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
  return (
    <>
      <Section title="Upload cities">
        <FormGrid
          aria-label="Upload cities"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (file && !busy) upload.mutate(file);
          }}
        >
          <Hint>
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}). {t.note} Nothing is added until you add the previewed rows, and a file is applied all or nothing: one row
            with a problem rejects the whole file.
          </Hint>
          <div className="col-span-full">
            <TemplateDownload base={t.base} code={t.code} />
          </div>
          <FormField>
            Cities file (CSV)
            <Input
              key={fileInput}
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                uploadKey.current = null;
              }}
            />
          </FormField>
          <Button type="submit" disabled={!file || busy}>
            Upload and preview
          </Button>
        </FormGrid>
        <ErrorNote error={upload.error ?? resume.error} />
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title="Your city uploads" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}
