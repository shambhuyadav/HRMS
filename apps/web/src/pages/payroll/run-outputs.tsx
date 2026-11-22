// Payslip publishing and the bank manifests of a processed run.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, download, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Notice, Section } from '../../ui';
import { Problem, ReasonForm } from './problems';
import { BANK_PREPARE, BATCH_STATE, involvement, money, OUTPUT_PUBLISH, OUTPUT_READ, PATHS, Status, TEMPLATE_READ, useKeys } from './shared';
import type { BankPreview, BankTemplate, IssuedOutput, Manifest, ManifestRow, PublishResult, RunDetail } from './types';

// =========================================================================================================
// Payslip publishing (processed runs)
// =========================================================================================================

export function RunPayslips({ run }: { run: RunDetail }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [reissuing, setReissuing] = useState<IssuedOutput | null>(null);
  const reissue = useMutation({
    mutationFn: ({ o, reason }: { o: IssuedOutput; reason: string }) =>
      api<IssuedOutput>(`/v1/payroll-outputs/payslips/${encodeURIComponent(o.id)}/reissue`, { body: { reason, expectedVersion: o.rowVersion } }),
    onSuccess: (n, { o }) => {
      setReissuing(null);
      setNote(`A new version of the payslip of ${o.employeeCode} was issued${n.version ? ` (version ${n.version})` : ''}; the earlier one is marked superseded. Reissuing does not mean the salary has been paid.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.runPayslips(run.id) }),
  });
  const outputs = useQuery({
    queryKey: keys.runPayslips(run.id),
    queryFn: () => api<{ items: IssuedOutput[] }>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/payslips`),
    enabled: can(OUTPUT_READ),
    retry: retryTransient,
  });
  const publish = useMutation({
    mutationFn: () => api<PublishResult>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/payslips/publish`, { method: 'POST' }),
    onSuccess: (r) => {
      const parts = [`Published ${r.published} ${r.published === 1 ? 'payslip' : 'payslips'}.`];
      if (r.remaining > 0) parts.push(`${r.remaining} still to publish: publish again to continue.`);
      if (r.ownRecordLeftForAnotherPublisher > 0) parts.push('Your own payslip is left for another publisher.');
      parts.push('Publication does not mean the salary has been paid.');
      setNote(parts.join(' '));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.runPayslips(run.id) }),
  });
  const fetchFile = async (o: IssuedOutput) => {
    if (busyId) return;
    setBusyId(o.id);
    setFailure(null);
    try {
      await download(`/v1/payroll-outputs/payslips/${encodeURIComponent(o.id)}/file`);
    } catch (e) {
      setFailure(e);
    } finally {
      setBusyId(null);
    }
  };
  return (
    <Section title="Payslips">
      <Hint>Payslips are published from the frozen records of this processed run. Publishing a payslip does not mean the salary has been paid.</Hint>
      {can(OUTPUT_PUBLISH) && (
        <ButtonRow>
          <Button
            type="button"
            disabled={publish.isPending}
            onClick={() => {
              setNote(null);
              publish.mutate();
            }}
          >
            {publish.isPending ? 'Publishing…' : 'Publish payslips'}
          </Button>
        </ButtonRow>
      )}
      <Notice notice={note ? { text: note, ok: true } : null} />
      <Problem error={publish.error} act="publish" />
      {can(OUTPUT_READ) && (
        <>
          {outputs.isPending && <LoadingLine>Loading issued payslips…</LoadingLine>}
          {outputs.error && <Problem error={outputs.error} act="read" />}
          {outputs.data && outputs.data.items.length === 0 && <Empty>No payslip of this run has been issued yet.</Empty>}
          {outputs.data && outputs.data.items.length > 0 && (
            <Table aria-label="Issued payslips">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Employee</TableHead>
                  <TableHead scope="col">Period</TableHead>
                  <TableHead scope="col">Version</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Issued</TableHead>
                  <TableHead scope="col">File</TableHead>
                  {can(OUTPUT_PUBLISH) && <TableHead scope="col">Replace</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {outputs.data.items.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>{o.employeeCode}</TableCell>
                    <TableCell>{o.periodCode}</TableCell>
                    <TableCell>{o.version}</TableCell>
                    <TableCell>{o.publicationState === 'SUPERSEDED' ? <Badge tone="warn">Superseded by a later version</Badge> : <Badge>{readable(o.publicationState)}</Badge>}</TableCell>
                    <TableCell>{formatDate(o.issuedAt)}</TableCell>
                    <TableCell>
                      {o.publicationState === 'ISSUED' || o.publicationState === 'SUPERSEDED' ? (
                        <Button type="button" variant="outline" size="sm" disabled={busyId !== null} onClick={() => void fetchFile(o)} aria-label={`Download payslip of ${o.employeeCode} version ${o.version}`}>
                          {busyId === o.id ? 'Downloading…' : 'Download'}
                        </Button>
                      ) : (
                        'Not issued'
                      )}
                    </TableCell>
                    {can(OUTPUT_PUBLISH) && (
                      <RowActionsCell>
                        {o.publicationState === 'ISSUED' ? (
                          <RowActions>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={reissue.isPending}
                              onClick={() => {
                                reissue.reset();
                                setNote(null);
                                setReissuing(o);
                              }}
                              aria-label={`Reissue the payslip of ${o.employeeCode} version ${o.version}`}
                            >
                              Reissue
                            </Button>
                          </RowActions>
                        ) : (
                          '—'
                        )}
                      </RowActionsCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {failure !== null && <Problem error={failure} act="download" />}
          {reissuing && (
            <ReasonForm
              key={reissuing.id}
              name={`Reissue the payslip of ${reissuing.employeeCode}`}
              field={`Why the payslip of ${reissuing.employeeCode} (version ${reissuing.version}) is replaced`}
              button={reissue.isPending ? 'Reissuing…' : 'Issue a new version'}
              busy={reissue.isPending}
              onSend={(reason) => reissue.mutateAsync({ o: reissuing, reason })}
            />
          )}
          <Problem error={reissue.error} act="reissue" />
        </>
      )}
    </Section>
  );
}

// =========================================================================================================
// Bank manifests of a processed run
// =========================================================================================================

export function RunBank({ run }: { run: RunDetail }) {
  const { can } = useSession();
  const keys = useKeys();
  const manifests = useQuery({
    queryKey: keys.manifests(run.id),
    queryFn: () => api<{ items: ManifestRow[] }>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/bank-manifests`),
    retry: retryTransient,
  });
  return (
    <Section title="Bank manifests">
      <Hint>A manifest or a bank file is not a payment: payment status comes only from outcomes recorded from bank evidence.</Hint>
      {manifests.isPending && <LoadingLine>Loading manifests…</LoadingLine>}
      {manifests.error && <Problem error={manifests.error} act="read" />}
      {manifests.data && manifests.data.items.length === 0 && <Empty>No manifest has been prepared for this run.</Empty>}
      {manifests.data && manifests.data.items.length > 0 && (
        <Table aria-label="Bank manifests">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Manifest</TableHead>
              <TableHead scope="col">Template</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Lines</TableHead>
              <TableHead scope="col">Total</TableHead>
              <TableHead scope="col">Prepared</TableHead>
              <TableHead scope="col">Authorised</TableHead>
              <TableHead scope="col">File issued</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {manifests.data.items.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <Link to={PATHS.manifest(m.id)}>{`Manifest ${m.batchRevision}`}</Link>
                </TableCell>
                <TableCell>{`${m.templateCode} v${m.templateVersion}`}</TableCell>
                <TableCell>
                  <Status map={BATCH_STATE} code={m.state} />
                </TableCell>
                <TableCell>{m.lineCount}</TableCell>
                <TableCell>{money(m.totalAmount, m.currencyCode)}</TableCell>
                <TableCell>{formatDate(m.preparedAt)}</TableCell>
                <TableCell>{formatDate(m.authorizedAt)}</TableCell>
                <TableCell>{formatDate(m.issuedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {can(BANK_PREPARE) && <PrepareManifest run={run} />}
    </Section>
  );
}

function PrepareManifest({ run }: { run: RunDetail }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [templateId, setTemplateId] = useState('');
  const [preview, setPreview] = useState<BankPreview | null>(null);
  const [prepared, setPrepared] = useState<Manifest | null>(null);
  const templates = useQuery({
    queryKey: keys.templates,
    queryFn: () => api<{ items: BankTemplate[] }>('/v1/payroll-outputs/bank-templates'),
    enabled: can(TEMPLATE_READ),
    retry: retryTransient,
  });
  const previewing = useMutation({
    mutationFn: (tid: string) => api<BankPreview>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/bank-preview?templateId=${encodeURIComponent(tid)}`),
    onSuccess: (p) => setPreview(p),
  });
  const prepare = useMutation({
    mutationFn: (tid: string) => api<Manifest>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/bank-manifests`, { body: { templateId: tid } }),
    onSuccess: (m) => {
      setPrepared(m);
      setPreview(null);
      setTemplateId('');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.manifests(run.id) }),
  });
  if (!can(TEMPLATE_READ)) return <Hint>The selected role cannot list bank file templates, so a manifest cannot be prepared here.</Hint>;
  const usable = (templates.data?.items ?? []).filter((t) => t.state === 'ACTIVE' && t.currencyCode === run.currencyCode);
  const busy = previewing.isPending || prepare.isPending;
  const mine = involvement(run, me?.userId);
  return (
    <div>
      <CardSubheading>Prepare a manifest</CardSubheading>
      <Hint>Only frozen records are used; held, reserved and confirmed amounts are left out. Someone independent of you and of the run’s preparer, reviewer and approver authorises it.</Hint>
      {mine.length > 0 && <Hint>{`You ${mine.join(' and ')} this run, so you cannot authorise this manifest’s release or record its outcomes.`}</Hint>}
      {templates.error && <Problem error={templates.error} act="read" />}
      {templates.data && usable.length === 0 && <Hint>{`No active bank file template pays in ${run.currencyCode}.`}</Hint>}
      {usable.length > 0 && (
        <FormGrid
          aria-label="Prepare a manifest"
          onSubmit={(e) => {
            e.preventDefault();
            if (!templateId || busy) return;
            setPrepared(null);
            prepare.mutate(templateId);
          }}
        >
          <FormField>
            Bank file template
            <NativeSelect
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">Choose a template</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {`${t.templateCode} v${t.templateVersion} · ${t.name}${t.testOnly ? ' (test only)' : ''}`}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <ButtonRow>
            <Button
              type="button"
              variant="outline"
              disabled={!templateId || busy}
              onClick={() => {
                previewing.reset();
                previewing.mutate(templateId);
              }}
            >
              {previewing.isPending ? 'Previewing…' : 'Preview (not payable)'}
            </Button>
            <Button type="submit" disabled={!templateId || busy}>
              {prepare.isPending ? 'Preparing…' : 'Prepare the manifest'}
            </Button>
          </ButtonRow>
        </FormGrid>
      )}
      <Problem error={previewing.error} act="prepare" />
      {preview && (
        <div role="region" aria-label="Manifest preview">
          <p className="my-1">
            <Badge tone="warn">Preview, not payable</Badge> {`${preview.lineCount} lines, total ${money(preview.totalAmount, preview.currencyCode)}.`}
          </p>
          <Hint>{`Left out: ${preview.excluded.held} held${preview.excluded.heldBySalaryStop ? ` (${preview.excluded.heldBySalaryStop} by a salary stop)` : ''}, ${preview.excluded.reservedOrPaid} already reserved or paid, ${preview.excluded.nothingPayable} with nothing payable.`}</Hint>
          {preview.errors.length > 0 && (
            <ul>
              {preview.errors.map((x, i) => (
                <li key={i}>{`${x.employeeCode ? `${x.employeeCode}: ` : ''}${readable(x.code)}${x.lineSequence ? ` (row ${x.lineSequence})` : ''}`}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Problem error={prepare.error} act="prepare" />
      {prepared && (
        <StatusNote tone="success" role="status">
          {`Manifest ${prepared.batchRevision} prepared: ${prepared.lineCount} lines, waiting for an independent authorisation. Nothing is reserved or paid yet. `}
          <Link to={PATHS.manifest(prepared.id)}>Open the manifest</Link>
        </StatusNote>
      )}
    </div>
  );
}
