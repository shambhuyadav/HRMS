// Payslip publishing and the bank manifests of a processed run.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Section } from '../../ui';
import { Problem, ReasonForm } from './problems';
import { BANK_PREPARE, BATCH_STATE, FLUSH, H3, involvement, money, OUTPUT_PUBLISH, OUTPUT_READ, PATHS, SCROLL, Status, TEMPLATE_READ, useKeys } from './shared';
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
      <p className="hint">Payslips are published from the frozen records of this processed run. Publishing a payslip does not mean the salary has been paid.</p>
      {can(OUTPUT_PUBLISH) && (
        <div className="row">
          <button
            type="button"
            disabled={publish.isPending}
            onClick={() => {
              setNote(null);
              publish.mutate();
            }}
          >
            {publish.isPending ? 'Publishing…' : 'Publish payslips'}
          </button>
        </div>
      )}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      <Problem error={publish.error} act="publish" />
      {can(OUTPUT_READ) && (
        <>
          {outputs.isPending && <p className="hint loading">Loading issued payslips…</p>}
          {outputs.error && <Problem error={outputs.error} act="read" />}
          {outputs.data && outputs.data.items.length === 0 && <Empty>No payslip of this run has been issued yet.</Empty>}
          {outputs.data && outputs.data.items.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Issued payslips">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Period</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Issued</th>
                    <th>File</th>
                    {can(OUTPUT_PUBLISH) && <th>Replace</th>}
                  </tr>
                </thead>
                <tbody>
                  {outputs.data.items.map((o) => (
                    <tr key={o.id}>
                      <td>{o.employeeCode}</td>
                      <td>{o.periodCode}</td>
                      <td>{o.version}</td>
                      <td>{o.publicationState === 'SUPERSEDED' ? <Badge tone="warn">Superseded by a later version</Badge> : <Badge>{readable(o.publicationState)}</Badge>}</td>
                      <td>{formatDate(o.issuedAt)}</td>
                      <td>
                        {o.publicationState === 'ISSUED' || o.publicationState === 'SUPERSEDED' ? (
                          <button type="button" className="secondary" disabled={busyId !== null} onClick={() => void fetchFile(o)} aria-label={`Download payslip of ${o.employeeCode} version ${o.version}`}>
                            {busyId === o.id ? 'Downloading…' : 'Download'}
                          </button>
                        ) : (
                          'Not issued'
                        )}
                      </td>
                      {can(OUTPUT_PUBLISH) && (
                        <td>
                          {o.publicationState === 'ISSUED' ? (
                            <button
                              type="button"
                              className="link"
                              disabled={reissue.isPending}
                              onClick={() => {
                                reissue.reset();
                                setNote(null);
                                setReissuing(o);
                              }}
                              aria-label={`Reissue the payslip of ${o.employeeCode} version ${o.version}`}
                            >
                              Reissue
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
      <p className="hint">A manifest or a bank file is not a payment: payment status comes only from outcomes recorded from bank evidence.</p>
      {manifests.isPending && <p className="hint loading">Loading manifests…</p>}
      {manifests.error && <Problem error={manifests.error} act="read" />}
      {manifests.data && manifests.data.items.length === 0 && <Empty>No manifest has been prepared for this run.</Empty>}
      {manifests.data && manifests.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Bank manifests">
            <thead>
              <tr>
                <th>Manifest</th>
                <th>Template</th>
                <th>State</th>
                <th>Lines</th>
                <th>Total</th>
                <th>Prepared</th>
                <th>Authorised</th>
                <th>File issued</th>
              </tr>
            </thead>
            <tbody>
              {manifests.data.items.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link to={PATHS.manifest(m.id)}>{`Manifest ${m.batchRevision}`}</Link>
                  </td>
                  <td>{`${m.templateCode} v${m.templateVersion}`}</td>
                  <td>
                    <Status map={BATCH_STATE} code={m.state} />
                  </td>
                  <td>{m.lineCount}</td>
                  <td>{money(m.totalAmount, m.currencyCode)}</td>
                  <td>{formatDate(m.preparedAt)}</td>
                  <td>{formatDate(m.authorizedAt)}</td>
                  <td>{formatDate(m.issuedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
  if (!can(TEMPLATE_READ)) return <p className="hint">The selected role cannot list bank file templates, so a manifest cannot be prepared here.</p>;
  const usable = (templates.data?.items ?? []).filter((t) => t.state === 'ACTIVE' && t.currencyCode === run.currencyCode);
  const busy = previewing.isPending || prepare.isPending;
  const mine = involvement(run, me?.userId);
  return (
    <div>
      <h3 style={H3}>Prepare a manifest</h3>
      <p className="hint">Only frozen records are used; held, reserved and confirmed amounts are left out. Someone independent of you and of the run’s preparer, reviewer and approver authorises it.</p>
      {mine.length > 0 && <p className="hint">{`You ${mine.join(' and ')} this run, so you cannot authorise this manifest’s release or record its outcomes.`}</p>}
      {templates.error && <Problem error={templates.error} act="read" />}
      {templates.data && usable.length === 0 && <p className="hint">{`No active bank file template pays in ${run.currencyCode}.`}</p>}
      {usable.length > 0 && (
        <form
          aria-label="Prepare a manifest"
          className="grid-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!templateId || busy) return;
            setPrepared(null);
            prepare.mutate(templateId);
          }}
        >
          <label>
            Bank file template
            <select
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
            </select>
          </label>
          <div className="row">
            <button
              type="button"
              className="secondary"
              disabled={!templateId || busy}
              onClick={() => {
                previewing.reset();
                previewing.mutate(templateId);
              }}
            >
              {previewing.isPending ? 'Previewing…' : 'Preview (not payable)'}
            </button>
            <button type="submit" disabled={!templateId || busy}>
              {prepare.isPending ? 'Preparing…' : 'Prepare the manifest'}
            </button>
          </div>
        </form>
      )}
      <Problem error={previewing.error} act="prepare" />
      {preview && (
        <div role="region" aria-label="Manifest preview">
          <p style={FLUSH}>
            <Badge tone="warn">Preview, not payable</Badge> {`${preview.lineCount} lines, total ${money(preview.totalAmount, preview.currencyCode)}.`}
          </p>
          <p className="hint">{`Left out: ${preview.excluded.held} held${preview.excluded.heldBySalaryStop ? ` (${preview.excluded.heldBySalaryStop} by a salary stop)` : ''}, ${preview.excluded.reservedOrPaid} already reserved or paid, ${preview.excluded.nothingPayable} with nothing payable.`}</p>
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
        <p role="status" className="ok">
          {`Manifest ${prepared.batchRevision} prepared: ${prepared.lineCount} lines, waiting for an independent authorisation. Nothing is reserved or paid yet. `}
          <Link to={PATHS.manifest(prepared.id)}>Open the manifest</Link>
        </p>
      )}
    </div>
  );
}
