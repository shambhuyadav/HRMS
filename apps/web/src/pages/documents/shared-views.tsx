// Pieces several document screens show: classification, scan state, expiry and version history.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, download, formatDate, isForbidden, retryTransient } from '../../api';
import { Badge, Empty, ErrorNote, Item, NotPermitted } from '../../ui';
import { DOWNLOAD_WORDS, Refusal } from './refusals';
import { isNotFound, type PolicyDetail, type PolicyVersion, useKeys, UUID } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Shared pieces: classification, scan state, expiry, version history
// ---------------------------------------------------------------------------------------------------------
export function ClassificationBadge({ classification }: { classification: string }) {
  return <Badge tone={classification === 'CONFIDENTIAL' ? 'warn' : 'neutral'}>{classification === 'CONFIDENTIAL' ? 'confidential' : 'operational'}</Badge>;
}

/** FR-106: only a released (CLEAN) file is ever served. Said as a safety check: these screens are read by employees too. */
export function ScanBadge({ state }: { state: string | null | undefined }) {
  if (state === 'CLEAN') return <Badge tone="good">passed</Badge>;
  if (state === 'QUARANTINED') return <Badge tone="bad">failed the safety check</Badge>;
  return <Badge tone="warn">being checked</Badge>;
}

export function Expiry({ expiresOn, expired }: { expiresOn: string | null; expired: boolean }) {
  return (
    <>
      {expiresOn ? formatDate(expiresOn) : 'No expiry date'}
      {expired && (
        <>
          {' '}
          <Badge tone="warn">expired</Badge>
        </>
      )}
    </>
  );
}

export function useOpenVersion() {
  return useMutation({ mutationFn: (versionId: string) => download(`/v1/company-policy-versions/${encodeURIComponent(versionId)}/content`) });
}

/** A version's file in plain words after an upload: released, waiting for the scan, or quarantined for good. */
export function scanOutcome(scanState: string | null): string {
  if (scanState === 'CLEAN') return 'The malware scan released it, so everyone who may read this policy can open it now.';
  if (scanState === 'QUARANTINED') return 'The file failed the malware scan and is quarantined: it will never be served. Publish a new version with a clean copy.';
  return 'It is waiting for the malware scan; nobody can open it until the scan releases it.';
}

export function VersionHistory({ versions }: { versions: PolicyVersion[] }) {
  const open = useOpenVersion();
  if (versions.length === 0) return <Empty>No versions on record.</Empty>;
  return (
    <>
      <Table aria-label="Versions">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Version</TableHead>
            <TableHead scope="col">File</TableHead>
            <TableHead scope="col">Published</TableHead>
            <TableHead scope="col">Expires</TableHead>
            <TableHead scope="col">Safety check</TableHead>
            <TableHead scope="col">Change note</TableHead>
            <TableHead scope="col">
              <span className="sr-only">Open</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((v) => (
            <TableRow key={v.id}>
              <TableCell>{v.versionNumber}</TableCell>
              <TableCell>{v.fileName ?? '—'}</TableCell>
              <TableCell>{formatDate(v.publishedAt)}</TableCell>
              <TableCell>
                <Expiry expiresOn={v.expiresOn} expired={v.expired} />
              </TableCell>
              <TableCell>
                <ScanBadge state={v.scanState} />
              </TableCell>
              <TableCell>{v.changeNote ?? '—'}</TableCell>
              <RowActionsCell>
                {v.scanState === 'CLEAN' ? (
                  <RowActions>
                    <Button type="button" variant="outline" size="sm" disabled={open.isPending} aria-label={`Download version ${v.versionNumber}`} onClick={() => open.mutate(v.id)}>
                      Download
                    </Button>
                  </RowActions>
                ) : (
                  <Hint as="span">cannot be opened</Hint>
                )}
              </RowActionsCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Refusal error={open.error} words={DOWNLOAD_WORDS} />
    </>
  );
}

export function PolicyFacts({ policy }: { policy: PolicyDetail }) {
  return (
    <dl className="kv">
      <Item term="Code">{policy.policyCode}</Item>
      <Item term="Classification">
        <ClassificationBadge classification={policy.classification} />
      </Item>
      <Item term="Versions">{policy.versions.length}</Item>
      <Item term="Last changed">{formatDate(policy.updatedAt)}</Item>
    </dl>
  );
}

/** The policy named in the address, for the read and the manage detail screens (the same API answer and cache). */
export function usePolicy(id: string, enabled: boolean) {
  const keys = useKeys();
  return useQuery({
    queryKey: keys.policy(id),
    enabled: enabled && UUID.test(id),
    queryFn: () => api<PolicyDetail>(`/v1/company-policies/${encodeURIComponent(id)}`),
    retry: retryTransient,
  });
}

export function PolicyUnavailable({ error }: { error: unknown }) {
  if (isForbidden(error)) return <NotPermitted>The selected role cannot read company policies.</NotPermitted>;
  if (isNotFound(error)) return <Empty>This policy is not available in the selected role’s company.</Empty>;
  return <ErrorNote error={error} />;
}
