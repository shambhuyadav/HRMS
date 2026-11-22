// ---------------------------------------------------------------------------------------------------------
// Employee documents (FR-010): confidential; the list needs the read grant, the form the upload grant.
// ---------------------------------------------------------------------------------------------------------
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { FormField } from '@/components/form-field';
import { Hint, HintLine } from '@/components/hint';
import { RowActions } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, download, fileToBase64, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { DATE_CELL, FIELD_ROW } from './layout';

interface DocumentItem {
  id: string;
  documentType: string;
  fileName: string | null;
  mediaType: string;
  byteSize: number | null;
  expiresOn: string | null;
  expired: boolean;
  uploadedAt: string;
  /** FR-106: only a released (CLEAN) file can be opened. */
  scanState?: 'PENDING_SCAN' | 'CLEAN' | 'QUARANTINED' | null;
  verificationState?: 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';
  verificationNote?: string | null;
}

const SCAN_LABEL: Record<string, string> = { PENDING_SCAN: 'waiting for the malware scan', QUARANTINED: 'quarantined by the malware scan' };

/** A file the malware scan has not released: where it stands, in the bad tone once quarantined. */
function ScanBadge({ scanState }: { scanState: DocumentItem['scanState'] }) {
  return <Badge tone={scanState === 'QUARANTINED' ? 'bad' : 'warn'}>{SCAN_LABEL[scanState!] ?? scanState}</Badge>;
}

/** What an upload's answer says about the file: quarantined, waiting for the scan, or ready. */
function uploadedText(scanState: string | undefined): string {
  if (scanState === 'QUARANTINED') return 'The file failed the malware scan and was quarantined; upload another copy.';
  if (scanState === 'PENDING_SCAN') return 'Document uploaded; it can be opened once the malware scan releases it.';
  return 'Document uploaded.';
}

/**
 * A document's actions: download, and for a verifier the verification with its rejection reason. They wrap onto further lines
 * rather than widening the table, their bottoms lined up with the reason's field.
 */
const DOCUMENT_ACTIONS = 'flex-wrap items-end';

export function EmployeeDocumentsPage() {
  const { id = '' } = useParams();
  const { can, me } = useSession();
  const canRead = can('document.read.document');
  const canUpload = can('document.upload.document');
  // The employee's own record is never verified by the employee (the API refuses it too).
  const canVerify = can('document.verify.document') && me?.employeeId !== id;
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ['documents', id], enabled: canRead, queryFn: () => api<{ items: DocumentItem[] }>(`/v1/employees/${id}/documents`) });
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState('GENERAL');
  const [expiresOn, setExpiresOn] = useState('');
  // Remounting the form after an upload clears the chosen file as well as the type and expiry.
  const [formKey, setFormKey] = useState(0);
  const upload = useMutation({
    mutationFn: async (f: File) =>
      api(`/v1/employees/${id}/documents`, {
        body: { documentType, fileName: f.name, contentBase64: await fileToBase64(f), ...(expiresOn ? { expiresOn } : {}) },
      }),
    onSuccess: () => {
      setFile(null);
      setDocumentType('GENERAL');
      setExpiresOn('');
      setFormKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: ['documents', id] });
    },
  });
  const open = useMutation({ mutationFn: (docId: string) => download(`/v1/documents/${docId}/content`) });
  const [rejectNote, setRejectNote] = useState<Record<string, string>>({});
  const verify = useMutation({
    mutationFn: ({ docId, decision }: { docId: string; decision: 'VERIFIED' | 'REJECTED' }) =>
      api(`/v1/documents/${docId}/verification`, { body: { decision, ...(decision === 'REJECTED' ? { note: (rejectNote[docId] ?? '').trim() } : {}) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['documents', id] }),
  });
  const uploadedScan = (upload.data as { scanState?: string } | undefined)?.scanState;

  return (
    <>
      <BackLink to="/employees">← Employees</BackLink>
      {canRead && (
        <Section title="Documents">
          {docs.data && docs.data.items.length === 0 && <Empty>No documents on record.</Empty>}
          {docs.data && docs.data.items.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Type</TableHead>
                  <TableHead scope="col">File</TableHead>
                  <TableHead scope="col">Expires</TableHead>
                  <TableHead scope="col">Uploaded</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.data.items.map((d) => {
                  const released = d.scanState === undefined || d.scanState === null || d.scanState === 'CLEAN';
                  return (
                    <TableRow key={d.id}>
                      <TableCell>{d.documentType}</TableCell>
                      <TableCell>{d.fileName ?? '—'}</TableCell>
                      <TableCell>
                        {formatDate(d.expiresOn)} {d.expired && <Badge tone="warn">expired</Badge>}
                      </TableCell>
                      <TableCell className={DATE_CELL}>{formatDate(d.uploadedAt)}</TableCell>
                      <TableCell>
                        {released ? <StateBadge state={d.verificationState ?? null} /> : <ScanBadge scanState={d.scanState} />}
                        {d.verificationNote ? <HintLine>{d.verificationNote}</HintLine> : null}
                      </TableCell>
                      <TableCell>
                        <RowActions className={DOCUMENT_ACTIONS}>
                          <Button type="button" variant="outline" size="sm" disabled={!released} onClick={() => open.mutate(d.id)}>
                            Download
                          </Button>
                          {canVerify && released && d.verificationState === 'UNVERIFIED' && (
                            <>
                              <Button type="button" size="sm" disabled={verify.isPending} onClick={() => verify.mutate({ docId: d.id, decision: 'VERIFIED' })}>
                                Verify
                              </Button>
                              <FormField className="w-auto">
                                Rejection reason
                                <Input value={rejectNote[d.id] ?? ''} onChange={(e) => setRejectNote({ ...rejectNote, [d.id]: e.target.value })} />
                              </FormField>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={verify.isPending || !(rejectNote[d.id] ?? '').trim()}
                                onClick={() => verify.mutate({ docId: d.id, decision: 'REJECTED' })}
                              >
                                Reject
                              </Button>
                            </>
                          )}
                        </RowActions>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <ErrorNote error={docs.error ?? open.error ?? verify.error} />
        </Section>
      )}
      {canUpload && (
        <Section title="Add a document">
          <form
            key={formKey}
            className={FIELD_ROW}
            onSubmit={(e) => {
              e.preventDefault();
              if (file) upload.mutate(file);
            }}
          >
            <FormField className="w-auto">
              Type <Input value={documentType} onChange={(e) => setDocumentType(e.target.value.toUpperCase())} />
            </FormField>
            <FormField className="w-auto">
              Expires <Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </FormField>
            <Input type="file" accept="application/pdf,image/jpeg,image/png" aria-label="Document file" className="w-auto" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button disabled={!file || upload.isPending}>Upload</Button>
          </form>
          <Hint>PDF, JPEG or PNG up to 10 MB. Every file is scanned for malware before anyone can open it.</Hint>
          {upload.isSuccess && <StatusNote tone="success">{uploadedText(uploadedScan)}</StatusNote>}
          <ErrorNote error={upload.error} />
        </Section>
      )}
      {!canRead && !canUpload && <Empty>Documents are confidential; this role holds no document grant.</Empty>}
    </>
  );
}
