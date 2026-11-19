// The mobile-app link review screen (FR-023): independent decisions on link requests; revocation with a reason.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatDate } from '../../api';
import { Badge, Empty, ErrorNote, Section } from '../../ui';

// ---------------------------------------------------------------------------------------------------------
// Mobile-app link review (FR-023): independent decisions on link requests; revocation with a reason.
// ---------------------------------------------------------------------------------------------------------

interface MobileLink {
  id: string;
  employeeCode: string;
  employeeName: string;
  appAccountRef: string;
  state: string;
  replacesLinkId: string | null;
  version: number;
  requestedAt: string;
}

export function MobileLinkReviewPage() {
  const qc = useQueryClient();
  const [state, setState] = useState<'PENDING' | 'ACTIVE'>('PENDING');
  const list = useQuery({ queryKey: ['mobile-links', state], queryFn: () => api<{ items: MobileLink[] }>(`/v1/mobile-links?state=${state}`) });
  const [reason, setReason] = useState<Record<string, string>>({});
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) => api(path, { body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['mobile-links'] }),
  });
  return (
    <Section
      title="Mobile-app links"
      actions={
        <div className="row toggle-group">
          <button type="button" aria-pressed={state === 'PENDING'} className={state === 'PENDING' ? '' : 'secondary'} onClick={() => setState('PENDING')}>
            Waiting for review
          </button>
          <button type="button" aria-pressed={state === 'ACTIVE'} className={state === 'ACTIVE' ? '' : 'secondary'} onClick={() => setState('ACTIVE')}>
            Active
          </button>
        </div>
      }
    >
      {list.data?.items.length === 0 && <Empty>Nothing here.</Empty>}
      <ul className="tasks">
        {list.data?.items.map((l) => (
          <li key={l.id}>
            <div>
              <strong>{l.employeeName}</strong> <span className="hint">{l.employeeCode}</span> → <code>{l.appAccountRef}</code>{' '}
              {l.replacesLinkId && <Badge tone="warn">replaces the current link</Badge>} <span className="hint">requested {formatDate(l.requestedAt)}</span>
            </div>
            {l.state === 'PENDING' ? (
              <div className="row">
                <button type="button" onClick={() => act.mutate({ path: `/v1/mobile-links/${l.id}/decision`, body: { expectedVersion: l.version, decision: 'APPROVE' } })}>
                  Approve
                </button>
                <button type="button" className="danger" onClick={() => act.mutate({ path: `/v1/mobile-links/${l.id}/decision`, body: { expectedVersion: l.version, decision: 'REJECT' } })}>
                  Reject
                </button>
              </div>
            ) : (
              <div className="row">
                <input aria-label="Revocation reason" placeholder="Reason" value={reason[l.id] ?? ''} onChange={(e) => setReason({ ...reason, [l.id]: e.target.value })} />
                <button
                  type="button"
                  className="danger"
                  disabled={!reason[l.id]?.trim()}
                  onClick={() => act.mutate({ path: `/v1/mobile-links/${l.id}/revoke`, body: { expectedVersion: l.version, reason: reason[l.id] } })}
                >
                  Revoke
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="hint">You cannot decide a link you requested or one for your own employee record.</p>
      <ErrorNote error={act.error ?? list.error} />
    </Section>
  );
}
