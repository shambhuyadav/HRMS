// Company policies: the read view every employee of the company has.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, formatDate, isForbidden, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, Section } from '../../ui';
import { DOWNLOAD_WORDS, Refusal } from './refusals';
import { PATHS, POLICY_MANAGE, POLICY_READ, type PolicyItem, SCROLL, SR_ONLY, useKeys, UUID } from './shared';
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
  return (
    <Section title="Company policies" actions={can(POLICY_MANAGE) ? <Link to={PATHS.manage}>Policy upload</Link> : undefined}>
      <p className="hint">Each policy shows its latest checked version. Download it to read it; an expired version stays on record, marked expired.</p>
      {list.isPending && <p className="hint loading">Loading policies…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot read company policies.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>No company policies are published yet.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Company policies">
            <thead>
              <tr>
                <th scope="col">Policy</th>
                <th scope="col">Classification</th>
                <th scope="col">Current version</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span style={SR_ONLY}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.title} <span className="hint">{p.policyCode}</span>
                  </td>
                  <td>
                    <ClassificationBadge classification={p.classification} />
                  </td>
                  <td>
                    {p.currentVersion ? (
                      <>
                        Version {p.currentVersion.versionNumber} <span className="hint">published {formatDate(p.currentVersion.publishedAt)}</span>
                      </>
                    ) : (
                      'No released version yet'
                    )}
                  </td>
                  <td>{p.currentVersion ? <Expiry expiresOn={p.currentVersion.expiresOn} expired={p.currentVersion.expired} /> : '—'}</td>
                  <td>
                    <div className="row">
                      {p.currentVersion && (
                        <button type="button" className="secondary" disabled={open.isPending} aria-label={`Download ${p.title}`} onClick={() => open.mutate(p.currentVersion!.id)}>
                          Download
                        </button>
                      )}
                      <Link to={PATHS.policy(p.id)} aria-label={`Versions of ${p.title}`}>
                        Versions
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
  const p = detail.data;
  return (
    <>
      <p>
        <Link className="back-link" to={PATHS.policies}>← Company policies</Link>
      </p>
      {!canRead ? (
        <Section title="Company policy">
          <NotPermitted>The selected role cannot read company policies.</NotPermitted>
        </Section>
      ) : !UUID.test(id) || detail.error ? (
        <Section title="Company policy">
          <PolicyUnavailable error={detail.error ?? new ApiError(404, 'NOT_FOUND', 'Not found')} />
        </Section>
      ) : !p ? (
        <p className="hint loading">Loading the policy…</p>
      ) : (
        <Section title={p.title} actions={can(POLICY_MANAGE) ? <Link to={PATHS.managePolicy(p.id)}>Manage this policy</Link> : undefined}>
          <PolicyFacts policy={p} />
          <h3>Versions</h3>
          <p className="hint">Every version stays on record. A version can be downloaded once it has passed the safety check.</p>
          <VersionHistory versions={p.versions} />
        </Section>
      )}
    </>
  );
}

