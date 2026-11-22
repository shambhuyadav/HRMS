// The mobile-app link review screen (FR-023): independent decisions on link requests; revocation with a reason.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ButtonRow } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { SegmentedChoice, SegmentedOption } from '@/components/tab-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
        <SegmentedChoice>
          <SegmentedOption pressed={state === 'PENDING'} onClick={() => setState('PENDING')}>
            Waiting for review
          </SegmentedOption>
          <SegmentedOption pressed={state === 'ACTIVE'} onClick={() => setState('ACTIVE')}>
            Active
          </SegmentedOption>
        </SegmentedChoice>
      }
    >
      {list.data?.items.length === 0 && <Empty>Nothing here.</Empty>}
      {/* `tasks`: the list's marker class, which styles.css draws each link request by, as in the decision lists. */}
      <ul className="tasks">
        {list.data?.items.map((l) => (
          <li key={l.id}>
            <div>
              <strong>{l.employeeName}</strong> <Hint as="span">{l.employeeCode}</Hint> → <code>{l.appAccountRef}</code>{' '}
              {l.replacesLinkId && <Badge tone="warn">replaces the current link</Badge>} <Hint as="span">requested {formatDate(l.requestedAt)}</Hint>
            </div>
            {l.state === 'PENDING' ? (
              <ButtonRow>
                <Button type="button" onClick={() => act.mutate({ path: `/v1/mobile-links/${l.id}/decision`, body: { expectedVersion: l.version, decision: 'APPROVE' } })}>
                  Approve
                </Button>
                <Button type="button" variant="danger" onClick={() => act.mutate({ path: `/v1/mobile-links/${l.id}/decision`, body: { expectedVersion: l.version, decision: 'REJECT' } })}>
                  Reject
                </Button>
              </ButtonRow>
            ) : (
              <ButtonRow>
                <Input aria-label="Revocation reason" placeholder="Reason" className="w-auto" value={reason[l.id] ?? ''} onChange={(e) => setReason({ ...reason, [l.id]: e.target.value })} />
                <Button
                  type="button"
                  variant="danger"
                  disabled={!reason[l.id]?.trim()}
                  onClick={() => act.mutate({ path: `/v1/mobile-links/${l.id}/revoke`, body: { expectedVersion: l.version, reason: reason[l.id] } })}
                >
                  Revoke
                </Button>
              </ButtonRow>
            )}
          </li>
        ))}
      </ul>
      <Hint>You cannot decide a link you requested or one for your own employee record.</Hint>
      <ErrorNote error={act.error ?? list.error} />
    </Section>
  );
}
