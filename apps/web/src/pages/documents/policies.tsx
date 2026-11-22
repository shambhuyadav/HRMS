// Company policies: the read view every employee of the company has.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate, isForbidden, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Section } from '../../ui';
import { DOWNLOAD_WORDS, Refusal } from './refusals';
import { PATHS, POLICY_MANAGE, POLICY_READ, type PolicyDetail, type PolicyItem, useKeys, UUID } from './shared';
import { ClassificationBadge, Expiry, PolicyFacts, PolicyUnavailable, useOpenVersion, usePolicy, VersionHistory } from './shared-views';

// ---------------------------------------------------------------------------------------------------------
// Company policies: the read view every employee of the company has
// ---------------------------------------------------------------------------------------------------------
export function PoliciesScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const canRead = can(POLICY_READ);
  const list = useQuery({ queryKey: keys.policies, enabled: canRead, queryFn: () => api<{ items: PolicyItem[] }>('/v1/company-policies'), retry: retryTransient });
  const open = useOpenVersion();

  if (!canRead) {
    return (
      <Section title="Company policies">
        <NotPermitted>The selected role cannot read company policies.</NotPermitted>
      </Section>
    );
  }
  const items = list.data?.items ?? [];
  const manageLink = (
    <Button asChild variant="outline" size="sm">
      <Link to={PATHS.manage}>Policy upload</Link>
    </Button>
  );
  return (
    <Section title="Company policies" actions={can(POLICY_MANAGE) ? manageLink : undefined}>
      <Hint>Each policy shows its latest checked version. Download it to read it; an expired version stays on record, marked expired.</Hint>
      {list.isPending && <LoadingLine>Loading policies…</LoadingLine>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot read company policies.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>No company policies are published yet.</Empty>}
      {items.length > 0 && (
        <Table aria-label="Company policies">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Policy</TableHead>
              <TableHead scope="col">Classification</TableHead>
              <TableHead scope="col">Current version</TableHead>
              <TableHead scope="col">Expires</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  {p.title} <Hint as="span">{p.policyCode}</Hint>
                </TableCell>
                <TableCell>
                  <ClassificationBadge classification={p.classification} />
                </TableCell>
                <TableCell>
                  {p.currentVersion ? (
                    <>
                      Version {p.currentVersion.versionNumber} <Hint as="span">published {formatDate(p.currentVersion.publishedAt)}</Hint>
                    </>
                  ) : (
                    'No released version yet'
                  )}
                </TableCell>
                <TableCell>{p.currentVersion ? <Expiry expiresOn={p.currentVersion.expiresOn} expired={p.currentVersion.expired} /> : '—'}</TableCell>
                <RowActionsCell>
                  <RowActions>
                    {p.currentVersion && (
                      <Button type="button" variant="outline" size="sm" disabled={open.isPending} aria-label={`Download ${p.title}`} onClick={() => open.mutate(p.currentVersion!.id)}>
                        Download
                      </Button>
                    )}
                    <Link to={PATHS.policy(p.id)} aria-label={`Versions of ${p.title}`}>
                      Versions
                    </Link>
                  </RowActions>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Refusal error={open.error} words={DOWNLOAD_WORDS} />
    </Section>
  );
}

export function PolicyScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const canRead = can(POLICY_READ);
  const detail = usePolicy(id, canRead);
  return (
    <>
      <BackLink to={PATHS.policies}>← Company policies</BackLink>
      <PolicyBody id={id} canRead={canRead} error={detail.error} policy={detail.data} canManage={can(POLICY_MANAGE)} />
    </>
  );
}

/** The policy's card: refused, unavailable, loading, or its facts and versions. */
function PolicyBody({ id, canRead, error, policy: p, canManage }: { id: string; canRead: boolean; error: unknown; policy: PolicyDetail | undefined; canManage: boolean }) {
  if (!canRead) {
    return (
      <Section title="Company policy">
        <NotPermitted>The selected role cannot read company policies.</NotPermitted>
      </Section>
    );
  }
  if (!UUID.test(id) || error) {
    return (
      <Section title="Company policy">
        <PolicyUnavailable error={error ?? new ApiError(404, 'NOT_FOUND', 'Not found')} />
      </Section>
    );
  }
  if (!p) return <LoadingLine>Loading the policy…</LoadingLine>;
  const manageLink = (
    <Button asChild variant="outline" size="sm">
      <Link to={PATHS.managePolicy(p.id)}>Manage this policy</Link>
    </Button>
  );
  return (
    <Section title={p.title} actions={canManage ? manageLink : undefined}>
      <PolicyFacts policy={p} />
      <h3>Versions</h3>
      <Hint>Every version stays on record. A version can be downloaded once it has passed the safety check.</Hint>
      <VersionHistory versions={p.versions} />
    </Section>
  );
}
